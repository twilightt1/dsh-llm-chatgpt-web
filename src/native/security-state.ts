import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { hashCanonical } from './canonical.ts'
import { NativeSafetyError } from './errors.ts'
import {
  assertPrivateDirectory,
  assertPrivateRegularFile,
  durableAtomicWritePrivateFile,
} from './private-files.ts'
import type {
  NativePolicySummary,
  NativeSecurityStateV1,
  PreparedNativeRequest,
} from './types.ts'

export const NATIVE_SECURITY_STATE_VERSION = 1 as const
export const NATIVE_SECURITY_STATE_FILE = 'native-security-state.json'
export const NATIVE_SECURITY_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_STATE_BYTES = 1_048_576
const HASH = /^[a-f0-9]{64}$/
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/
const MAX_SUMMARY_TOOLS = 4_096
const MAX_SUMMARY_PATH_ARGUMENTS = 256

function safety(message: string, cause?: unknown): NativeSafetyError {
  return new NativeSafetyError(message, cause, 'NATIVE_SECURITY_STATE')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (keys.some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw safety('native security state contains an invalid key set')
  }
}

function text(value: unknown, field: string, maximum = 4_096, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || CONTROL_BYTES.test(value)) {
    throw safety(`native security state ${field} is invalid`)
  }
  return value
}

function hash(value: unknown, field: string): string {
  const candidate = text(value, field, 64)
  if (!HASH.test(candidate)) throw safety(`native security state ${field} is invalid`)
  return candidate
}

function instant(value: unknown, field: string): string {
  const candidate = text(value, field, 32)
  const milliseconds = Date.parse(candidate)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== candidate) {
    throw safety(`native security state ${field} is invalid`)
  }
  return candidate
}

function profilePath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || CONTROL_BYTES.test(value)) {
    throw safety('native security state profile directory must be an absolute control-free path')
  }
  return resolve(value)
}

function parseSummary(value: unknown): NativePolicySummary {
  if (!isRecord(value)) throw safety('native security state summary is invalid')
  exactKeys(value, [
    'toolPolicy', 'workspaceRoot', 'workspaceRootSource', 'connectorName', 'connectorRuntime',
    'approval', 'tools', 'evidenceLimits',
  ], ['policyImplementationVersion'])
  if (value.toolPolicy !== 'full' && value.toolPolicy !== 'evidence-only' && value.toolPolicy !== 'allowlist') {
    throw safety('native security state summary tool policy is invalid')
  }
  if (value.workspaceRootSource !== 'explicit' && value.workspaceRootSource !== 'process.cwd') {
    throw safety('native security state summary workspace root source is invalid')
  }
  if (value.connectorRuntime !== 'external' && value.connectorRuntime !== 'managed') {
    throw safety('native security state summary connector runtime is invalid')
  }
  if (value.approval !== 'none' && value.approval !== 'workspace-policy') {
    throw safety('native security state summary approval mode is invalid')
  }
  const policyImplementationVersion = value.policyImplementationVersion === undefined
    ? undefined
    : text(value.policyImplementationVersion, 'policy implementation version', 128)
  const workspaceRoot = text(value.workspaceRoot, 'workspace root')
  if (!isAbsolute(workspaceRoot)) throw safety('native security state workspace root is not absolute')
  const connectorName = text(value.connectorName, 'connector name', 256)
  if (!Array.isArray(value.tools) || value.tools.length > MAX_SUMMARY_TOOLS) {
    throw safety('native security state summary tools are invalid')
  }
  const seenTools = new Set<string>()
  const tools = value.tools.map(toolValue => {
    if (!isRecord(toolValue)) throw safety('native security state summary tool is invalid')
    exactKeys(toolValue, ['tool', 'capability', 'pathArguments', 'result', 'outputProvenance'], ['schemaHash'])
    const tool = text(toolValue.tool, 'tool name', 256)
    if (seenTools.has(tool)) throw safety('native security state summary contains duplicate tools')
    seenTools.add(tool)
    const capabilities = new Set([
      'workspace.read', 'workspace.search', 'git.read', 'execution.read', 'side-effect', 'full-unrestricted',
    ])
    if (typeof toolValue.capability !== 'string' || !capabilities.has(toolValue.capability)) {
      throw safety('native security state summary capability is invalid')
    }
    if (!Array.isArray(toolValue.pathArguments) || toolValue.pathArguments.length > MAX_SUMMARY_PATH_ARGUMENTS
      || toolValue.pathArguments.some(path => typeof path !== 'string' || CONTROL_BYTES.test(path))) {
      throw safety('native security state summary path arguments are invalid')
    }
    if (toolValue.result !== 'text' && toolValue.result !== 'sanitized-evidence' && toolValue.result !== 'raw-unbounded') {
      throw safety('native security state summary result policy is invalid')
    }
    if (toolValue.outputProvenance !== 'operator-declared' && toolValue.outputProvenance !== 'unverified-full') {
      throw safety('native security state summary output provenance is invalid')
    }
    const schemaHash = toolValue.schemaHash === undefined ? undefined : hash(toolValue.schemaHash, 'schema hash')
    return {
      tool,
      capability: toolValue.capability as NativePolicySummary['tools'][number]['capability'],
      pathArguments: Object.freeze([...toolValue.pathArguments] as string[]),
      result: toolValue.result as NativePolicySummary['tools'][number]['result'],
      outputProvenance: toolValue.outputProvenance as NativePolicySummary['tools'][number]['outputProvenance'],
      ...(schemaHash === undefined ? {} : { schemaHash }),
    }
  })
  if (!isRecord(value.evidenceLimits)) throw safety('native security state evidence limits are invalid')
  exactKeys(value.evidenceLimits, ['maxBytes', 'maxLines'])
  const maxBytes = value.evidenceLimits.maxBytes
  const maxLines = value.evidenceLimits.maxLines
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576
    || typeof maxLines !== 'number' || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 10_000) {
    throw safety('native security state evidence limits are invalid')
  }
  return Object.freeze({
    ...(policyImplementationVersion === undefined ? {} : { policyImplementationVersion }),
    toolPolicy: value.toolPolicy,
    workspaceRoot,
    workspaceRootSource: value.workspaceRootSource,
    connectorName,
    connectorRuntime: value.connectorRuntime,
    approval: value.approval,
    tools: Object.freeze(tools),
    evidenceLimits: Object.freeze({ maxBytes, maxLines }),
  }) as NativePolicySummary
}

function parseState(value: unknown): NativeSecurityStateV1 {
  if (!isRecord(value)) throw safety('native security state is invalid')
  exactKeys(value, [
    'version', 'generatedAt', 'runtimeProcess', 'policyHash', 'inventoryHash', 'approvalHash',
    'workspaceRootSource', 'summary',
  ])
  if (value.version !== NATIVE_SECURITY_STATE_VERSION) throw safety('native security state version is invalid')
  const generatedAt = instant(value.generatedAt, 'generatedAt')
  if (!isRecord(value.runtimeProcess)) throw safety('native security state runtime process is invalid')
  exactKeys(value.runtimeProcess, ['pid', 'startedAt'])
  const pid = value.runtimeProcess.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw safety('native security state runtime PID is invalid')
  }
  const startedAt = instant(value.runtimeProcess.startedAt, 'runtime process start')
  const workspaceRootSource = value.workspaceRootSource
  if (workspaceRootSource !== 'explicit' && workspaceRootSource !== 'process.cwd') {
    throw safety('native security state workspace root source is invalid')
  }
  const summary = parseSummary(value.summary)
  if (summary.workspaceRootSource !== workspaceRootSource) {
    throw safety('native security state workspace root source does not match its summary')
  }
  return Object.freeze({
    version: NATIVE_SECURITY_STATE_VERSION,
    generatedAt,
    runtimeProcess: Object.freeze({ pid, startedAt }),
    policyHash: hash(value.policyHash, 'policy hash'),
    inventoryHash: hash(value.inventoryHash, 'inventory hash'),
    approvalHash: hash(value.approvalHash, 'approval hash'),
    workspaceRootSource,
    summary,
  })
}

function clock(now?: Date): Date {
  const value = now ?? new Date()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw safety('native security state clock value is invalid')
  }
  return value
}

function redactedSummary(summary: NativePolicySummary): NativePolicySummary {
  return parseSummary({
    ...(summary.policyImplementationVersion === undefined ? {} : {
      policyImplementationVersion: summary.policyImplementationVersion,
    }),
    toolPolicy: summary.toolPolicy,
    workspaceRoot: summary.workspaceRoot,
    workspaceRootSource: summary.workspaceRootSource,
    connectorName: summary.connectorName,
    connectorRuntime: summary.connectorRuntime,
    approval: summary.approval,
    tools: summary.tools.map(tool => ({
      tool: tool.tool,
      capability: tool.capability,
      pathArguments: [...tool.pathArguments],
      result: tool.result,
      outputProvenance: tool.outputProvenance,
      ...(tool.schemaHash === undefined ? {} : { schemaHash: tool.schemaHash }),
    })),
    evidenceLimits: { ...summary.evidenceLimits },
  })
}

export function nativeSecurityStatePath(profileDir: string): string {
  return join(profilePath(profileDir), NATIVE_SECURITY_STATE_FILE)
}

/** Persist only the prepared request's redacted policy facts; never use this for authorization. */
export function writeNativeSecurityState(
  profileDir: string,
  prepared: Pick<PreparedNativeRequest, 'policyHash' | 'inventoryHash' | 'approvalHash' | 'summary'>,
  runtimeProcess: { readonly pid: number; readonly startedAt: string },
  now?: Date,
): void {
  const current = clock(now)
  const pid = runtimeProcess.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) throw safety('native security state runtime PID is invalid')
  const summary = redactedSummary(prepared.summary)
  const state = parseState({
    version: NATIVE_SECURITY_STATE_VERSION,
    generatedAt: current.toISOString(),
    runtimeProcess: { pid, startedAt: runtimeProcess.startedAt },
    policyHash: prepared.policyHash,
    inventoryHash: prepared.inventoryHash,
    approvalHash: prepared.approvalHash,
    workspaceRootSource: summary.workspaceRootSource,
    summary,
  })
  try {
    durableAtomicWritePrivateFile(
      nativeSecurityStatePath(profileDir),
      `${JSON.stringify(state)}\n`,
      0o600,
    )
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw safety('native security state could not be written safely', error)
  }
}

/** Read the advisory snapshot without creating or repairing any profile state. */
export function readNativeSecurityState(profileDir: string): NativeSecurityStateV1 | undefined {
  const resolvedProfile = profilePath(profileDir)
  try {
    lstatSync(resolvedProfile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw safety('native security state profile directory could not be inspected safely', error)
  }
  try {
    assertPrivateDirectory(resolvedProfile, 'native security state profile directory')
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw safety('native security state profile directory is not private', error)
  }
  const path = join(resolvedProfile, NATIVE_SECURITY_STATE_FILE)
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw safety('native security state file could not be inspected safely', error)
  }
  try {
    assertPrivateRegularFile(path, 'native security state')
    const stat = lstatSync(path)
    if (stat.size > MAX_STATE_BYTES) throw new Error('native security state exceeds its private size limit')
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error('native security state exceeds its private size limit')
    return parseState(JSON.parse(raw) as unknown)
  } catch (error) {
    if (error instanceof NativeSafetyError && error.nativeCode === 'NATIVE_SECURITY_STATE') throw error
    throw safety('native security state is not valid private JSON', error)
  }
}

export function nativeSecuritySummaryHash(summary: NativePolicySummary): string {
  return hashCanonical('native-approval-summary', 1, redactedSummary(summary))
}
