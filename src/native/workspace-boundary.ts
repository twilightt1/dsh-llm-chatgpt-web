import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path'
import { TextDecoder } from 'node:util'
import { hashCanonical } from './canonical.ts'
import type { ResolvedNativeSecurityConfig } from './types.ts'

const IGNORE_FILE = '.dsh-chatgptignore'
const MAX_IGNORE_BYTES = 64 * 1024
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/
const GLOB_BYTES = /[\\*?\[\]{}!]/
const PRIVATE_KEY_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx'])
const PRIVATE_KEY_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'])
const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.cloudflared',
  '.dsh',
  '.dsh-chatgpt-web',
  '.git',
  '.hg',
  '.svn',
])
const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.dsh-chatgptignore',
])

interface IgnoreRule {
  readonly path: string
  readonly subtree: boolean
}

export interface WorkspaceBoundary {
  readonly canonicalRoot: string
  readonly rootSource: 'explicit' | 'process.cwd'
  readonly sensitiveDigest: string
  readonly ignoreDigest: string
  rewriteArguments(
    args: Record<string, unknown>,
    pointers: readonly string[],
  ): { readonly arguments: Readonly<Record<string, unknown>>; readonly argumentsHash: string }
  rebaseProviderArguments(
    args: Record<string, unknown>,
    pointers: readonly string[],
  ): Readonly<Record<string, unknown>>
}

function fail(message: string): never {
  throw new Error(`native workspace boundary denied: ${message}`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return value
}

function assertSafeText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`)
  if (CONTROL_BYTES.test(value)) fail(`${field} contains a control byte`)
  return value
}

function readIgnoreFile(path: string): { readonly bytes: Buffer; readonly rules: readonly IgnoreRule[]; readonly digest: string } {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        bytes: Buffer.alloc(0),
        rules: [],
        digest: hashCanonical('native-ignore', 1, { present: false }),
      }
    }
    throw error
  }
  if (stat.isSymbolicLink()) fail('workspace ignore file must not be a symlink')
  if (!stat.isFile()) fail('workspace ignore file must be a regular file')
  if (stat.size > MAX_IGNORE_BYTES) fail('workspace ignore file exceeds 64 KiB')

  const fd = openSync(path, 'r')
  let bytes: Buffer
  try {
    const buffer = Buffer.alloc(MAX_IGNORE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const finalStat = fstatSync(fd)
    if (!finalStat.isFile() || finalStat.size > MAX_IGNORE_BYTES || length > MAX_IGNORE_BYTES) {
      fail('workspace ignore file exceeds 64 KiB or changed while reading')
    }
    bytes = Buffer.from(buffer.subarray(0, length))
  } finally {
    closeSync(fd)
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    fail(`workspace ignore file is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rules: IgnoreRule[] = []
  const seen = new Set<string>()
  for (const sourceLine of text.split('\n')) {
    const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine
    const first = line.trimStart()
    if (first.length === 0 || first.startsWith('#')) continue
    const raw = line.trim()
    if (CONTROL_BYTES.test(raw)) fail('workspace ignore file contains a control byte')
    const subtree = raw.endsWith('/')
    const candidate = subtree ? raw.slice(0, -1) : raw
    if (
      candidate.length === 0
      || candidate.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(candidate)
      || candidate.includes('//')
      || GLOB_BYTES.test(candidate)
    ) fail(`invalid workspace ignore entry: ${JSON.stringify(raw)}`)
    const segments = candidate.split('/')
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      fail(`workspace ignore entry contains invalid path segments: ${JSON.stringify(raw)}`)
    }
    const normalized = segments.join('/')
    if (seen.has(normalized)) fail(`workspace ignore entry is duplicated: ${normalized}`)
    seen.add(normalized)
    rules.push({ path: normalized, subtree })
  }
  return {
    bytes,
    rules: Object.freeze(rules),
    digest: hashCanonical('native-ignore', 1, { present: true, bytes: bytes.toString('base64') }),
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function within(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function decodePointer(pointer: string): string[] {
  if (typeof pointer !== 'string') fail('path pointer must be a string')
  if (CONTROL_BYTES.test(pointer)) fail('path pointer contains a control byte')
  if (pointer === '') return []
  if (!pointer.startsWith('/')) fail('path pointer must be an RFC 6901 pointer')
  return pointer.slice(1).split('/').map((segment) => {
    let decoded = ''
    for (let index = 0; index < segment.length; index += 1) {
      const character = segment[index]
      if (character !== '~') {
        decoded += character
        continue
      }
      const escape = segment[index + 1]
      if (escape !== '0' && escape !== '1') fail('path pointer contains an invalid RFC 6901 escape')
      decoded += escape === '0' ? '~' : '/'
      index += 1
    }
    return decoded
  })
}

function pointerParts(pointers: readonly string[]): readonly (readonly [string, string[]])[] {
  const seen = new Set<string>()
  return Object.freeze(pointers.map(pointer => {
    if (seen.has(pointer)) fail(`path pointer is duplicated: ${JSON.stringify(pointer)}`)
    seen.add(pointer)
    return [pointer, decodePointer(pointer)] as const
  }))
}

function arrayIndex(value: unknown, length: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('path pointer does not identify an array element')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index >= length) fail('path pointer identifies a missing array element')
  return index
}

function readPointer(root: Record<string, unknown>, parts: readonly string[]): unknown {
  let current: unknown = root
  for (const part of parts) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(part, current.length)]
      continue
    }
    if (!isPlainRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      fail('path pointer identifies a missing value')
    }
    current = current[part]
  }
  return current
}

function writePointer(root: Record<string, unknown>, parts: readonly string[], value: unknown): void {
  if (parts.length === 0) fail('the root argument object cannot be a path value')
  let current: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(part, current.length)]
    } else if (isPlainRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part]
    } else {
      fail('path pointer identifies a missing parent')
    }
  }
  const leaf = parts[parts.length - 1]!
  if (Array.isArray(current)) {
    current[arrayIndex(leaf, current.length)] = value
  } else if (isPlainRecord(current) && Object.prototype.hasOwnProperty.call(current, leaf)) {
    current[leaf] = value
  } else {
    fail('path pointer identifies a missing value')
  }
}

function pathValues(value: unknown): string[] {
  if (typeof value === 'string') {
    if (value.length === 0) fail('declared path value must not be empty')
    return [value]
  }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail('declared path value must be a non-empty string or array of non-empty strings')
  }
  return [...value] as string[]
}

function isDotEnvException(name: string): boolean {
  return name.endsWith('.example') || name.endsWith('.sample') || name.endsWith('.template')
}

function isBuiltInSensitive(relativePath: string): boolean {
  if (relativePath.length === 0) return false
  const segments = relativePath.split('/').filter(Boolean)
  const lowerSegments = segments.map(segment => segment.toLowerCase())
  if (lowerSegments.some(segment => SENSITIVE_SEGMENTS.has(segment))) return true
  if (lowerSegments.some((segment, index) => segment === '.config' && lowerSegments[index + 1] === 'gcloud')) return true
  if (lowerSegments.some(segment => segment === 'keychains')) return true
  const name = lowerSegments[lowerSegments.length - 1] ?? ''
  if (SENSITIVE_BASENAMES.has(name)) return true
  if (name === '.env' || (name.startsWith('.env.') && !isDotEnvException(name))) return true
  if (PRIVATE_KEY_EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) return true
  if (PRIVATE_KEY_NAMES.has(name)) return true
  return false
}

function canonicalizeRoot(config: ResolvedNativeSecurityConfig): string {
  let rootStat
  try {
    rootStat = lstatSync(config.workspaceRoot)
  } catch (error) {
    fail(`workspace root is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (rootStat.isSymbolicLink()) fail('workspace root must not be a symlink')
  if (!rootStat.isDirectory()) fail('workspace root must be a directory')
  try {
    return realpathSync(config.workspaceRoot)
  } catch (error) {
    fail(`workspace root could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function canonicalPrivatePath(path: string): string {
  assertSafeText(path, 'private path')
  const absolute = resolvePath(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}

/** Create one immutable authorization-time workspace boundary. */
export function createWorkspaceBoundary(
  config: ResolvedNativeSecurityConfig,
  privatePaths: readonly string[] = [],
): WorkspaceBoundary {
  const canonicalRoot = canonicalizeRoot(config)
  const ignore = readIgnoreFile(join(canonicalRoot, IGNORE_FILE))
  const canonicalPrivatePaths = Object.freeze([...new Set(privatePaths.map(canonicalPrivatePath))].sort())
  const sensitiveDescriptor = {
    builtInVersion: 1,
    privatePaths: canonicalPrivatePaths,
    ignoreDigest: ignore.digest,
  }
  const sensitiveDigest = hashCanonical('native-sensitive-rules', 1, sensitiveDescriptor)

  const canonicalizePath = (value: string): string => {
    assertSafeText(value, 'declared path')
    const candidate = isAbsolute(value) ? resolvePath(value) : resolvePath(canonicalRoot, value)
    let canonical: string
    if (pathExists(candidate)) {
      try {
        canonical = realpathSync(candidate)
      } catch (error) {
        fail(`declared path could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      const missing: string[] = []
      let ancestor = candidate
      while (!pathExists(ancestor)) {
        const parent = dirname(ancestor)
        if (parent === ancestor) fail('declared path has no existing ancestor')
        missing.unshift(basename(ancestor))
        ancestor = parent
      }
      try {
        canonical = missing.reduce((current, segment) => join(current, segment), realpathSync(ancestor))
      } catch (error) {
        fail(`declared path ancestor could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!within(canonicalRoot, canonical)) fail(`declared path escapes workspace root: ${value}`)
    const relativePath = toPosix(relative(canonicalRoot, canonical))
    if (isBuiltInSensitive(relativePath)) fail(`declared path is sensitive: ${relativePath}`)
    if (ignore.rules.some(rule => relativePath === rule.path || (rule.subtree && relativePath.startsWith(`${rule.path}/`)))) {
      fail(`declared path is ignored: ${relativePath}`)
    }
    if (canonicalPrivatePaths.some(privatePath => within(privatePath, canonical))) {
      fail(`declared path is adapter-private: ${relativePath}`)
    }
    return canonical
  }

  const rewriteArguments = (
    args: Record<string, unknown>,
    pointers: readonly string[],
  ): { readonly arguments: Readonly<Record<string, unknown>>; readonly argumentsHash: string } => {
    if (!isPlainRecord(args)) fail('tool arguments must be a plain object')
    const entries = pointerParts(pointers)
    const rewrites = entries.map(([pointer, parts]) => {
      const values = pathValues(readPointer(args, parts))
      const canonical = values.map(canonicalizePath)
      return { pointer, parts, value: canonical.length === 1 && typeof readPointer(args, parts) === 'string' ? canonical[0]! : canonical }
    })
    const rewritten = structuredClone(args) as Record<string, unknown>
    for (const rewrite of rewrites) writePointer(rewritten, rewrite.parts, rewrite.value)
    deepFreeze(rewritten)
    return {
      arguments: rewritten,
      argumentsHash: hashCanonical('native-tool-arguments', 1, rewritten),
    }
  }

  const rebaseProviderArguments = (
    args: Record<string, unknown>,
    pointers: readonly string[],
  ): Readonly<Record<string, unknown>> => {
    const rewritten = rewriteArguments(args, pointers).arguments
    const rebased = structuredClone(rewritten) as Record<string, unknown>
    for (const [, parts] of pointerParts(pointers)) {
      const value = readPointer(rebased, parts)
      const values = pathValues(value)
      const providerValues = values.map((canonical) => {
        const relativePath = relative(canonicalRoot, canonical)
        if (!within(canonicalRoot, canonical)) fail('provider path is outside workspace root')
        return toPosix(relativePath) || '.'
      })
      writePointer(rebased, parts, providerValues.length === 1 && typeof value === 'string' ? providerValues[0]! : providerValues)
    }
    return deepFreeze(rebased)
  }

  return Object.freeze({
    canonicalRoot,
    rootSource: config.workspaceRootSource,
    sensitiveDigest,
    ignoreDigest: ignore.digest,
    rewriteArguments,
    rebaseProviderArguments,
  })
}
