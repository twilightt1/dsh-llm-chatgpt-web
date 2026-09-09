import { createHash, randomUUID } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { unzipSync } from 'fflate'
import {
  atomicWritePrivateFile,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  snapshotPrivateFile,
} from './private-files.ts'
import {
  MANAGED_TUNNEL_CLIENT_VERSION,
} from './runtime-config.ts'
import { runCommand } from './process.ts'
import type { CommandResult, CommandRunner } from './process.ts'

export { MANAGED_TUNNEL_CLIENT_VERSION }

const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${MANAGED_TUNNEL_CLIENT_VERSION}`
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/

const RELEASE_ASSETS: Readonly<Record<string, TunnelReleaseAsset>> = {
  'darwin/amd64': {
    name: 'tunnel-client-v0.0.12-darwin-amd64.zip',
    archiveSha256: '33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009',
  },
  'darwin/arm64': {
    name: 'tunnel-client-v0.0.12-darwin-arm64.zip',
    archiveSha256: '42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02',
  },
  'linux/amd64': {
    name: 'tunnel-client-v0.0.12-linux-amd64.zip',
    archiveSha256: '2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81',
  },
  'linux/arm64': {
    name: 'tunnel-client-v0.0.12-linux-arm64.zip',
    archiveSha256: '6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6',
  },
}

export interface TunnelReleaseAsset {
  readonly name: string
  readonly archiveSha256: string
}

export interface TunnelInstallManifest {
  readonly version: 1
  readonly tunnelClientVersion: typeof MANAGED_TUNNEL_CLIENT_VERSION
  readonly asset: string
  readonly archiveSha256: string
  readonly binarySha256: string
}

export interface TunnelInstallTransaction {
  readonly candidatePath: string
  readonly manifest: TunnelInstallManifest
  commit(): string
  rollback(): void
  finalize(): void
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeArch(arch: string): 'amd64' | 'arm64' {
  if (arch === 'x64' || arch === 'amd64') return 'amd64'
  if (arch === 'arm64') return 'arm64'
  throw new Error(`unsupported tunnel-client architecture: ${arch}`)
}

export function tunnelReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TunnelReleaseAsset {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`unsupported tunnel-client platform: ${platform}`)
  }
  const asset = RELEASE_ASSETS[`${platform}/${normalizeArch(arch)}`]
  if (asset === undefined) throw new Error(`unsupported tunnel-client platform/architecture: ${platform}/${arch}`)
  return asset
}

export function parseReleaseChecksum(text: string, asset: string): string {
  const line = text.split(/\r?\n/).find(candidate => {
    const parts = candidate.trim().split(/\s+/)
    return parts.length >= 2 && parts.at(-1) === asset
  })
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase()
  if (checksum === undefined || !SHA256.test(checksum)) {
    throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`)
  }
  return checksum
}

async function fetchBytes(url: string, maximumBytes: number): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`download failed (${response.status})`)
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      throw new Error(`download exceeds ${maximumBytes} bytes`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumBytes) throw new Error(`download exceeds ${maximumBytes} bytes`)
    return bytes
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`download timed out after 120000ms: ${url}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function pathExistsOrSymlink(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

function parseManifest(value: unknown): TunnelInstallManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('existing tunnel-client manifest is not an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.tunnelClientVersion !== MANAGED_TUNNEL_CLIENT_VERSION) {
    throw new Error('existing tunnel-client manifest has an unsupported version')
  }
  if (typeof record.asset !== 'string' || record.asset.length === 0) {
    throw new Error('existing tunnel-client manifest has no asset')
  }
  if (typeof record.archiveSha256 !== 'string' || !SHA256.test(record.archiveSha256)) {
    throw new Error('existing tunnel-client manifest has an invalid archive SHA-256')
  }
  if (typeof record.binarySha256 !== 'string' || !SHA256.test(record.binarySha256)) {
    throw new Error('existing tunnel-client manifest has an invalid binary SHA-256')
  }
  return {
    version: 1,
    tunnelClientVersion: MANAGED_TUNNEL_CLIENT_VERSION,
    asset: record.asset,
    archiveSha256: record.archiveSha256,
    binarySha256: record.binarySha256,
  }
}

function validateExistingInstallation(
  binaryPath: string,
  manifestPath: string,
  run: CommandRunner,
  expectedAsset: TunnelReleaseAsset,
): TunnelInstallManifest | undefined {
  const binaryExists = pathExistsOrSymlink(binaryPath)
  const manifestExists = pathExistsOrSymlink(manifestPath)
  if (!binaryExists && !manifestExists) return undefined
  assertPrivateRegularFile(binaryPath, 'existing tunnel-client', true)
  assertPrivateRegularFile(manifestPath, 'existing tunnel-client manifest')
  let manifest: TunnelInstallManifest
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
  } catch (error) {
    throw new Error(`existing tunnel-client manifest failed integrity validation: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest.asset !== expectedAsset.name || manifest.archiveSha256 !== expectedAsset.archiveSha256) {
    throw new Error('existing tunnel-client manifest does not match the pinned release asset')
  }
  const binary = new Uint8Array(readFileSync(binaryPath))
  if (digest(binary) !== manifest.binarySha256) {
    throw new Error('existing tunnel-client binary hash does not match its manifest')
  }
  const version = run(binaryPath, ['--version'], { timeoutMs: 10_000 })
  if (version.status !== 0 || !`${version.stdout}\n${version.stderr}`.includes(MANAGED_TUNNEL_CLIENT_VERSION)) {
    throw new Error(`existing tunnel-client did not report version ${MANAGED_TUNNEL_CLIENT_VERSION}`)
  }
  return manifest
}

function noOpTransaction(binaryPath: string, manifest: TunnelInstallManifest): TunnelInstallTransaction {
  return {
    candidatePath: binaryPath,
    manifest,
    commit: () => binaryPath,
    rollback: () => {},
    finalize: () => {},
  }
}

function removeCandidate(path: string): void {
  rmSync(path, { force: true })
}

function stagedTransaction(
  candidatePath: string,
  binaryPath: string,
  manifestPath: string,
  manifest: TunnelInstallManifest,
): TunnelInstallTransaction {
  let state: 'staged' | 'committed' | 'rolled-back' | 'finalized' = 'staged'
  let binarySnapshot: ReturnType<typeof snapshotPrivateFile> | undefined
  let manifestSnapshot: ReturnType<typeof snapshotPrivateFile> | undefined
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`

  const restoreSnapshots = (): void => {
    const errors: unknown[] = []
    try { manifestSnapshot?.restore() } catch (error) { errors.push(error) }
    try { binarySnapshot?.restore() } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'failed to restore tunnel-client installation')
  }

  return {
    candidatePath,
    manifest,
    commit(): string {
      if (state === 'committed' || state === 'finalized') return binaryPath
      if (state === 'rolled-back') throw new Error('tunnel-client installation transaction was rolled back')
      try {
        binarySnapshot = snapshotPrivateFile(binaryPath)
        manifestSnapshot = snapshotPrivateFile(manifestPath)
        atomicWritePrivateFile(binaryPath, new Uint8Array(readFileSync(candidatePath)), 0o700)
        atomicWritePrivateFile(manifestPath, manifestText)
        state = 'committed'
        return binaryPath
      } catch (error) {
        try { restoreSnapshots() } catch (restoreError) {
          state = 'rolled-back'
          removeCandidate(candidatePath)
          throw new AggregateError([error, restoreError], 'tunnel-client installation commit and rollback failed')
        }
        state = 'rolled-back'
        removeCandidate(candidatePath)
        throw error
      }
    },
    rollback(): void {
      if (state === 'rolled-back' || state === 'finalized') return
      if (state === 'committed') restoreSnapshots()
      removeCandidate(candidatePath)
      state = 'rolled-back'
    },
    finalize(): void {
      if (state === 'finalized' || state === 'rolled-back') return
      binarySnapshot?.discard()
      manifestSnapshot?.discard()
      removeCandidate(candidatePath)
      state = 'finalized'
    },
  }
}

export async function stageTunnelClient(options: {
  readonly binaryPath: string
  readonly manifestPath: string
  readonly fetchBytes?: (url: string, maximumBytes: number) => Promise<Uint8Array>
  readonly run?: CommandRunner
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  /** Test-only fixture override; production setup never passes this. */
  readonly releaseAsset?: TunnelReleaseAsset
}): Promise<TunnelInstallTransaction> {
  const run = options.run ?? runCommand
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const supportedAsset = tunnelReleaseAsset(platform, arch)
  const asset = options.releaseAsset ?? supportedAsset
  const existing = validateExistingInstallation(options.binaryPath, options.manifestPath, run, asset)
  if (existing !== undefined) return noOpTransaction(options.binaryPath, existing)

  ensurePrivateDirectory(dirname(options.binaryPath))
  ensurePrivateDirectory(dirname(options.manifestPath))
  if (!asset.name.endsWith('.zip') || asset.name.includes('\n') || !SHA256.test(asset.archiveSha256)) {
    throw new Error('tunnel-client release asset is invalid')
  }
  const getBytes = options.fetchBytes ?? fetchBytes
  const [archive, sums] = await Promise.all([
    getBytes(`${RELEASE_BASE}/${asset.name}`, MAX_DOWNLOAD_BYTES),
    getBytes(`${RELEASE_BASE}/SHA256SUMS.txt`, MAX_DOWNLOAD_BYTES),
  ])
  if (archive.byteLength > MAX_DOWNLOAD_BYTES || sums.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`tunnel-client download exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
  }
  const archiveHash = digest(archive)
  if (archiveHash !== asset.archiveSha256) throw new Error(`tunnel-client archive checksum mismatch for ${asset.name}`)
  const releaseHash = parseReleaseChecksum(new TextDecoder().decode(sums), asset.name)
  if (releaseHash !== asset.archiveSha256) throw new Error(`release checksum mismatch for ${asset.name}`)

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(archive)
  } catch (error) {
    throw new Error(`tunnel-client archive is not a valid ZIP: ${error instanceof Error ? error.message : String(error)}`)
  }
  const matches = Object.entries(files).filter(([name]) => basename(name.replaceAll('\\', '/')) === 'tunnel-client')
  if (matches.length !== 1 || matches[0]?.[1].byteLength === 0) {
    throw new Error('tunnel-client archive must contain exactly one non-empty tunnel-client binary')
  }
  const binaryEntry = matches[0]
  if (binaryEntry === undefined) throw new Error('tunnel-client archive did not contain a binary')
  const binary = binaryEntry[1]
  const candidatePath = `${options.binaryPath}.install-${process.pid}-${randomUUID()}`
  let manifest: TunnelInstallManifest
  try {
    atomicWritePrivateFile(candidatePath, binary, 0o700)
    const version = run(candidatePath, ['--version'], { timeoutMs: 10_000 })
    if (version.status !== 0 || !`${version.stdout}\n${version.stderr}`.includes(MANAGED_TUNNEL_CLIENT_VERSION)) {
      throw new Error(`installed tunnel-client did not report version ${MANAGED_TUNNEL_CLIENT_VERSION}`)
    }
    manifest = {
      version: 1,
      tunnelClientVersion: MANAGED_TUNNEL_CLIENT_VERSION,
      asset: asset.name,
      archiveSha256: archiveHash,
      binarySha256: digest(binary),
    }
  } catch (error) {
    removeCandidate(candidatePath)
    throw error
  }
  return stagedTransaction(candidatePath, options.binaryPath, options.manifestPath, manifest)
}

export type { CommandResult, CommandRunner }
