import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BrokerToolResult, NativeResultPolicy } from './types.ts'

const MARKER_PREFIX = '[native-restricted:v1 '
const MARKER_RE = /^\[native-restricted:v1 bytes=([0-9]+) lines=([0-9]+) reasons=([a-z-]+(?:,[a-z-]+)*)\]$/
const MARKER_REASONS = new Set(['bytes', 'control', 'home', 'lines', 'private-key', 'secret'])
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gi
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|pairing[-_ ]?code)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi,
]

interface MarkerMetadata {
  readonly bytes: number
  readonly lines: number
  readonly reasons: readonly string[]
}

export interface NativeResultProjectionOptions {
  readonly resultPolicy: NativeResultPolicy
  readonly maxBytes: number
  readonly maxLines: number
  readonly homeDirectory: string
}

function error(message: string): never {
  throw new Error(`native result projection rejected: ${message}`)
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeControls(value: string): { readonly value: string; readonly changed: boolean } {
  const normalized = value
    .replace(ANSI_ESCAPE, '�')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(OTHER_CONTROLS, '�')
  return { value: normalized, changed: normalized !== value }
}

function redactSecrets(value: string): { readonly value: string; readonly changed: boolean } {
  let current = value.replace(PRIVATE_KEY_BLOCK, '[native redacted private-key]')
  for (const pattern of SECRET_PATTERNS) current = current.replace(pattern, '[native redacted secret]')
  return { value: current, changed: current !== value }
}

function replaceHome(value: string, homeDirectory: string): { readonly value: string; readonly changed: boolean } {
  if (homeDirectory === '/' || homeDirectory.length === 0) return { value, changed: false }
  const pattern = new RegExp(`${escapeRegExp(homeDirectory.replace(/\/+$/, ''))}(?=/|$)`, 'g')
  const replaced = value.replace(pattern, '~')
  return { value: replaced, changed: replaced !== value }
}

function markerMetadata(value: string): { readonly body: string; readonly marker?: MarkerMetadata } {
  const boundary = value.lastIndexOf('\n')
  const candidate = boundary < 0 ? value : value.slice(boundary + 1)
  const match = MARKER_RE.exec(candidate)
  if (match === null) return { body: value }
  const bytes = Number(match[1])
  const lines = Number(match[2])
  const reasons = match[3]!.split(',')
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(lines) || bytes < 0 || lines < 0
    || reasons.some(reason => !MARKER_REASONS.has(reason))
    || new Set(reasons).size !== reasons.length
    || [...reasons].sort().join(',') !== reasons.join(',')) {
    return { body: value }
  }
  return {
    body: boundary < 0 ? '' : value.slice(0, boundary),
    marker: { bytes, lines, reasons: Object.freeze(reasons) },
  }
}

function marker(metadata: MarkerMetadata): string {
  return `${MARKER_PREFIX}bytes=${metadata.bytes} lines=${metadata.lines} reasons=${metadata.reasons.join(',')}]`
}

function prefixByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let end = 0
  for (const character of value) {
    const next = Buffer.byteLength(character, 'utf8')
    if (bytes + next > maxBytes) break
    bytes += next
    end += character.length
  }
  return value.slice(0, end)
}

function sortedReasons(reasons: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(reasons)].sort())
}

function boundedText(
  value: string,
  metadata: MarkerMetadata,
  maxBytes: number,
  maxLines: number,
): string {
  const markerText = marker(metadata)
  const markerBytes = Buffer.byteLength(markerText, 'utf8')
  if (markerBytes > maxBytes) error('configured byte limit cannot fit its restriction marker')

  const sourceLines = value.length === 0 ? [] : value.split('\n')
  const maxBodyLines = Math.max(0, maxLines - 1)
  let body = sourceLines.slice(0, maxBodyLines).join('\n')
  const separatorBytes = body.length > 0 ? 1 : 0
  body = prefixByBytes(body, Math.max(0, maxBytes - markerBytes - separatorBytes))
  const rendered = body.length > 0 ? `${body}\n${markerText}` : markerText
  if (Buffer.byteLength(rendered, 'utf8') <= maxBytes && lineCount(rendered) <= maxLines) return rendered
  return markerText
}

function assertOptions(options: NativeResultProjectionOptions): void {
  if (options.resultPolicy !== 'text' && options.resultPolicy !== 'sanitized-evidence') {
    error('result policy is invalid')
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) error('maxBytes is invalid')
  if (!Number.isSafeInteger(options.maxLines) || options.maxLines < 1) error('maxLines is invalid')
  if (typeof options.homeDirectory !== 'string' || options.homeDirectory.length === 0) error('homeDirectory is invalid')
}

function resultText(result: BrokerToolResult): { readonly text: string; readonly multiple: boolean } {
  if (!Array.isArray(result.content)) error('result content must be an array')
  for (const block of result.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      error(`non-text result content is unsupported: ${String((block as { type?: unknown }).type)}`)
    }
  }
  return {
    text: result.content.map((block) => (block as Extract<ContentBlock, { type: 'text' }>).text).join('\n'),
    multiple: result.content.length > 1,
  }
}

/** Project one raw text-only broker result without changing its error status. */
export function projectNativeToolResult(
  result: BrokerToolResult,
  options: NativeResultProjectionOptions,
): BrokerToolResult {
  assertOptions(options)
  if (typeof result.isError !== 'boolean') error('result isError must be boolean')
  const source = resultText(result)
  if (source.text.length === 0 && source.multiple === false) {
    return structuredClone(result)
  }

  const initial = options.resultPolicy === 'sanitized-evidence'
    ? (() => {
        const controls = normalizeControls(source.text)
        const secrets = redactSecrets(controls.value)
        const home = replaceHome(secrets.value, options.homeDirectory)
        return {
          value: home.value,
          reasons: [
            ...(controls.changed ? ['control'] : []),
            ...(secrets.changed ? [
              controls.value.includes('PRIVATE KEY') ? 'private-key' : undefined,
              secrets.value !== controls.value ? 'secret' : undefined,
            ].filter((reason): reason is string => reason !== undefined) : []),
            ...(home.changed ? ['home'] : []),
          ],
        }
      })()
    : { value: source.text, reasons: [] as string[] }
  const parsed = markerMetadata(initial.value)
  const body = parsed.body
  const originalBytes = Buffer.byteLength(body, 'utf8')
  const originalLines = lineCount(body)
  const reasons = [...initial.reasons, ...(parsed.marker?.reasons ?? [])]
  const bytes = Math.max(originalBytes, parsed.marker?.bytes ?? 0)
  const lines = Math.max(originalLines, parsed.marker?.lines ?? 0)
  const needsMarker = parsed.marker !== undefined
    || initial.reasons.length > 0
    || originalBytes > options.maxBytes
    || originalLines > options.maxLines
  if (!needsMarker && originalBytes <= options.maxBytes && originalLines <= options.maxLines) {
    return structuredClone(result)
  }
  if (originalBytes > options.maxBytes) reasons.push('bytes')
  if (originalLines > options.maxLines || (needsMarker && originalLines >= options.maxLines && options.maxLines > 1)) reasons.push('lines')
  const metadata: MarkerMetadata = {
    bytes,
    lines,
    reasons: sortedReasons(reasons),
  }
  const projectedText = boundedText(body, metadata, options.maxBytes, options.maxLines)
  return {
    content: [{ type: 'text', text: projectedText }],
    isError: result.isError,
  }
}
