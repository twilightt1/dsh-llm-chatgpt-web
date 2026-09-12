import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { NativeApprovalRequiredError, NativeSafetyError } from './errors.ts'
import {
  assertPrivateDirectory,
  assertPrivateRegularFile,
  durableAtomicWritePrivateFile,
  ensurePrivateDirectory,
  syncPrivateDirectory,
} from './private-files.ts'
import { hashCanonical } from './canonical.ts'
import type {
  NativeApprovalMode,
  NativeApprovalChallengeV1,
  NativeApprovalGrantV1,
  NativePolicySummary,
  PreparedNativeRequest,
} from './types.ts'

const APPROVAL_VERSION = 1 as const
const APPROVAL_TTL_MS = 10 * 60 * 1_000
const APPROVAL_DIRECTORY = 'native-approval'
const PENDING_FILE = 'pending.json'
const GRANT_FILE = 'grant.json'
const CHALLENGE_ID = /^challenge_[0-9a-f-]{36}$/
const HASH = /^[a-f0-9]{64}$/
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/
const MAX_APPROVAL_FILE_BYTES = 1_048_576
const MAX_CLAIM_FILES = 8
const CLAIM_FILE = /^\.pending-claim-([0-9]+)-([0-9a-f-]{36})$/

interface PendingApproval extends NativeApprovalChallengeV1 {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (keys.some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error('native approval record has an invalid key set')
  }
}

function text(value: unknown, field: string, max = 1_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL_BYTES.test(value)) {
    throw new Error(`native approval ${field} is invalid`)
  }
  return value
}

function hash(value: unknown, field: string): string {
  const candidate = text(value, field, 64)
  if (!HASH.test(candidate)) throw new Error(`native approval ${field} is invalid`)
  return candidate
}

function instant(value: unknown, field: string): string {
  const candidate = text(value, field, 32)
  const milliseconds = Date.parse(candidate)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== candidate) {
    throw new Error(`native approval ${field} is invalid`)
  }
  return candidate
}

function summary(value: unknown): NativePolicySummary {
  if (!isRecord(value)) throw new Error('native approval summary is invalid')
  exactKeys(value, [
    'toolPolicy', 'workspaceRoot', 'workspaceRootSource', 'connectorName', 'connectorRuntime',
    'approval', 'tools', 'evidenceLimits',
  ], ['policyImplementationVersion'])
  if (value.toolPolicy !== 'full' && value.toolPolicy !== 'evidence-only' && value.toolPolicy !== 'allowlist') {
    throw new Error('native approval summary tool policy is invalid')
  }
  if (value.workspaceRootSource !== 'explicit' && value.workspaceRootSource !== 'process.cwd') {
    throw new Error('native approval summary workspace root source is invalid')
  }
  if (value.connectorRuntime !== 'external' && value.connectorRuntime !== 'managed') {
    throw new Error('native approval summary connector runtime is invalid')
  }
  if (value.approval !== 'none' && value.approval !== 'workspace-policy') {
    throw new Error('native approval summary approval mode is invalid')
  }
  const policyImplementationVersion = value.policyImplementationVersion === undefined
    ? undefined
    : text(value.policyImplementationVersion, 'policy implementation version', 128)
  const workspaceRoot = text(value.workspaceRoot, 'workspace root', 4_096)
  const connectorName = text(value.connectorName, 'connector name', 256)
  if (!Array.isArray(value.tools)) throw new Error('native approval summary tools are invalid')
  const tools = value.tools.map(toolValue => {
    if (!isRecord(toolValue)) throw new Error('native approval summary tool is invalid')
    exactKeys(toolValue, ['tool', 'capability', 'pathArguments', 'result', 'outputProvenance'], ['schemaHash'])
    const tool = text(toolValue.tool, 'tool name', 256)
    const capabilities = new Set([
      'workspace.read', 'workspace.search', 'git.read', 'execution.read', 'side-effect', 'full-unrestricted',
    ])
    if (typeof toolValue.capability !== 'string' || !capabilities.has(toolValue.capability)) {
      throw new Error('native approval summary capability is invalid')
    }
    if (!Array.isArray(toolValue.pathArguments) || toolValue.pathArguments.some(path => typeof path !== 'string')) {
      throw new Error('native approval summary path arguments are invalid')
    }
    if (toolValue.result !== 'text' && toolValue.result !== 'sanitized-evidence' && toolValue.result !== 'raw-unbounded') {
      throw new Error('native approval summary result policy is invalid')
    }
    if (toolValue.outputProvenance !== 'operator-declared' && toolValue.outputProvenance !== 'unverified-full') {
      throw new Error('native approval summary provenance is invalid')
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
  if (!isRecord(value.evidenceLimits)) throw new Error('native approval summary evidence limits are invalid')
  exactKeys(value.evidenceLimits, ['maxBytes', 'maxLines'])
  const maxBytes = value.evidenceLimits.maxBytes
  const maxLines = value.evidenceLimits.maxLines
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || typeof maxLines !== 'number' || !Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new Error('native approval summary evidence limits are invalid')
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
    evidenceLimits: Object.freeze({
      maxBytes,
      maxLines,
    }),
  }) as NativePolicySummary
}

function parsePending(value: unknown): PendingApproval {
  if (!isRecord(value)) throw new Error('native approval pending record is invalid')
  exactKeys(value, ['version', 'challengeId', 'approvalHash', 'createdAt', 'expiresAt', 'summary'])
  if (value.version !== APPROVAL_VERSION) throw new Error('native approval pending version is invalid')
  const challengeId = text(value.challengeId, 'challenge id', 128)
  if (!CHALLENGE_ID.test(challengeId)) throw new Error('native approval challenge id is invalid')
  const createdAt = instant(value.createdAt, 'createdAt')
  const expiresAt = instant(value.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== APPROVAL_TTL_MS) {
    throw new Error('native approval challenge lifetime is invalid')
  }
  return Object.freeze({
    version: APPROVAL_VERSION,
    challengeId,
    approvalHash: hash(value.approvalHash, 'approval hash'),
    createdAt,
    expiresAt,
    summary: summary(value.summary),
  })
}

function parseGrant(value: unknown): NativeApprovalGrantV1 {
  if (!isRecord(value)) throw new Error('native approval grant record is invalid')
  exactKeys(value, ['version', 'approvalHash', 'approvedAt', 'summaryHash'])
  if (value.version !== APPROVAL_VERSION) throw new Error('native approval grant version is invalid')
  return Object.freeze({
    version: APPROVAL_VERSION,
    approvalHash: hash(value.approvalHash, 'approval hash'),
    approvedAt: instant(value.approvedAt, 'approvedAt'),
    summaryHash: hash(value.summaryHash, 'summary hash'),
  })
}

function readJson<T>(path: string, label: string, parse: (value: unknown) => T): T | undefined {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    assertPrivateRegularFile(path, label)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError(`native approval ${label} is not a safe private file`, error, 'NATIVE_APPROVAL_STATE')
  }
  let value: unknown
  try {
    const stat = lstatSync(path)
    if (stat.size > MAX_APPROVAL_FILE_BYTES) {
      throw new Error('native approval state file exceeds the private size limit')
    }
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_APPROVAL_FILE_BYTES) {
      throw new Error('native approval state file exceeds the private size limit')
    }
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new NativeSafetyError(`native approval ${label} is not valid private JSON`, error, 'NATIVE_APPROVAL_STATE')
  }
  try {
    return parse(value)
  } catch (error) {
    throw new NativeSafetyError(`native approval ${label} has an invalid schema`, error, 'NATIVE_APPROVAL_STATE')
  }
}

function profile(value: string): string {
  if (typeof value !== 'string' || CONTROL_BYTES.test(value) || !isAbsolute(value)) {
    throw new NativeSafetyError('native approval profile directory must be an absolute control-free path', undefined, 'NATIVE_APPROVAL_STATE')
  }
  const resolved = resolve(value)
  try {
    ensurePrivateDirectory(resolved)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval profile directory is not private', error, 'NATIVE_APPROVAL_STATE')
  }
  return resolved
}

function inspectApprovalDirectory(directory: string): void {
  let claimCount = 0
  for (const entry of readdirSync(directory)) {
    if (entry === PENDING_FILE || entry === GRANT_FILE) continue
    if (!CLAIM_FILE.test(entry)) {
      throw new NativeSafetyError('native approval directory contains an unexpected state file', undefined, 'NATIVE_APPROVAL_STATE')
    }
    claimCount += 1
    if (claimCount > MAX_CLAIM_FILES) {
      throw new NativeSafetyError('native approval directory contains too many abandoned claims', undefined, 'NATIVE_APPROVAL_STATE')
    }
    assertPrivateRegularFile(join(directory, entry), 'native approval claim')
  }
}

function approvalDirectory(profileDir: string): string {
  const directory = join(profileDir, APPROVAL_DIRECTORY)
  let created = false
  try {
    lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    created = true
  }
  try {
    ensurePrivateDirectory(directory)
    if (created) syncPrivateDirectory(profileDir)
    inspectApprovalDirectory(directory)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval directory is not private', error, 'NATIVE_APPROVAL_STATE')
  }
  return directory
}

function readOnlyProfile(value: string): string {
  if (typeof value !== 'string' || CONTROL_BYTES.test(value) || !isAbsolute(value)) {
    throw new NativeSafetyError('native approval profile directory must be an absolute control-free path', undefined, 'NATIVE_APPROVAL_STATE')
  }
  const resolved = resolve(value)
  try {
    lstatSync(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw new NativeSafetyError('native approval profile directory could not be inspected safely', error, 'NATIVE_APPROVAL_STATE')
  }
  try {
    assertPrivateDirectory(resolved, 'native approval profile directory')
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval profile directory is not private', error, 'NATIVE_APPROVAL_STATE')
  }
  return resolved
}

function readOnlyApprovalDirectory(profileDir: string): string | undefined {
  const resolved = readOnlyProfile(profileDir)
  try {
    lstatSync(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NativeSafetyError('native approval profile directory could not be inspected safely', error, 'NATIVE_APPROVAL_STATE')
  }
  try {
    const directory = join(resolved, APPROVAL_DIRECTORY)
    try {
      lstatSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    assertPrivateDirectory(directory, 'native approval directory')
    inspectApprovalDirectory(directory)
    return directory
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval directory is not private', error, 'NATIVE_APPROVAL_STATE')
  }
}

export interface NativeApprovalStateInspection {
  readonly directory: 'missing' | 'ok'
  readonly challenge?: NativeApprovalChallengeV1
  readonly grant?: NativeApprovalGrantV1
  readonly claimCount: number
}

/** Read approval files without creating, claiming, replacing, or repairing them. */
export function readNativeApprovalState(profileDir: string): NativeApprovalStateInspection {
  const directory = readOnlyApprovalDirectory(profileDir)
  if (directory === undefined) return { directory: 'missing', claimCount: 0 }
  const entries = readdirSync(directory)
  const claimCount = entries.filter(entry => CLAIM_FILE.test(entry)).length
  const challenge = readJson(join(directory, PENDING_FILE), 'pending challenge', parsePending)
  const grant = readJson(join(directory, GRANT_FILE), 'grant', parseGrant)
  return {
    directory: 'ok',
    ...(challenge === undefined ? {} : { challenge }),
    ...(grant === undefined ? {} : { grant }),
    claimCount,
  }
}

function clock(now?: Date): Date {
  const value = now ?? new Date()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new NativeSafetyError('native approval clock value is invalid', undefined, 'NATIVE_APPROVAL_STATE')
  }
  return value
}

function summaryHash(value: NativePolicySummary): string {
  return hashCanonical('native-approval-summary', APPROVAL_VERSION, value)
}

function approvalCommand(profileDir: string, challengeId: string): string {
  return `dsh-chatgpt-web-native approve --profile-dir ${shellQuotePosix(profileDir)} --challenge ${shellQuotePosix(challengeId)}`
}

function throwRequired(profileDir: string, challengeId: string): never {
  throw new NativeApprovalRequiredError(
    `Native MCP policy approval is required. Run exactly:\n${approvalCommand(profileDir, challengeId)}`,
  )
}

function pendingMatches(
  pending: PendingApproval,
  prepared: PreparedNativeRequest,
  expectedSummaryHash: string,
  now: Date,
): boolean {
  return pending.approvalHash === prepared.approvalHash
    && summaryHash(pending.summary) === expectedSummaryHash
    && Date.parse(pending.expiresAt) > now.getTime()
    && Date.parse(pending.createdAt) <= now.getTime()
}

function removeClaim(path: string, directory: string): void {
  assertPrivateRegularFile(path, 'native approval claim')
  unlinkSync(path)
  syncPrivateDirectory(directory)
}

function replaceUnclaimedPending(
  directory: string,
  observed: PendingApproval,
  desired: PendingApproval,
): boolean {
  const pendingPath = join(directory, PENDING_FILE)
  const claimedPath = join(directory, `.pending-claim-${process.pid}-${randomUUID()}`)
  try {
    renameSync(pendingPath, claimedPath)
    syncPrivateDirectory(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const claimed = readJson(claimedPath, 'pending claim', parsePending)
    if (claimed === undefined || JSON.stringify(claimed) !== JSON.stringify(observed)) {
      throw new NativeSafetyError('native approval pending state changed during replacement', undefined, 'NATIVE_APPROVAL_STATE')
    }
    writePending(pendingPath, desired)
    removeClaim(claimedPath, directory)
    return true
  } catch (error) {
    try {
      lstatSync(claimedPath)
      removeClaim(claimedPath, directory)
    } catch { /* preserve the original failure */ }
    throw error
  }
}

function writePending(path: string, pending: PendingApproval): void {
  try {
    durableAtomicWritePrivateFile(path, `${JSON.stringify(pending)}\n`, 0o600)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval pending state could not be written safely', error, 'NATIVE_APPROVAL_STATE')
  }
}

function createPending(prepared: PreparedNativeRequest, now: Date): PendingApproval {
  return Object.freeze({
    version: APPROVAL_VERSION,
    challengeId: `challenge_${randomUUID()}`,
    approvalHash: prepared.approvalHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    summary: prepared.summary,
  })
}

/** Require an exact local grant before any effective native capability opens. */
export function requireNativeApproval(
  profileDir: string,
  approval: NativeApprovalMode,
  prepared: PreparedNativeRequest,
  now?: Date,
): void {
  if (approval !== 'none' && approval !== 'workspace-policy') {
    throw new NativeSafetyError('native approval mode is invalid', undefined, 'NATIVE_APPROVAL_STATE')
  }
  if (approval === 'none' || prepared.summary.tools.length === 0) return
  try {
    const current = clock(now)
    const resolvedProfile = profile(profileDir)
    const directory = approvalDirectory(resolvedProfile)
    const grantPath = join(directory, GRANT_FILE)
    const pendingPath = join(directory, PENDING_FILE)
    const expectedSummaryHash = summaryHash(prepared.summary)
    const grant = readJson(grantPath, 'grant', parseGrant)
    if (grant !== undefined) {
      const approvedAt = Date.parse(grant.approvedAt)
      if (!Number.isFinite(approvedAt) || approvedAt > current.getTime()) {
        throw new NativeSafetyError('native approval grant timestamp is invalid', undefined, 'NATIVE_APPROVAL_STATE')
      }
      if (grant.approvalHash === prepared.approvalHash && grant.summaryHash === expectedSummaryHash) return
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = readJson(pendingPath, 'pending challenge', parsePending)
      if (pending !== undefined && Date.parse(pending.createdAt) > current.getTime()) {
        throw new NativeSafetyError('native approval challenge was created in the future; refusing a clock rollback', undefined, 'NATIVE_APPROVAL_CLOCK')
      }
      if (pending !== undefined && pendingMatches(pending, prepared, expectedSummaryHash, current)) {
        throwRequired(resolvedProfile, pending.challengeId)
      }
      const desired = createPending(prepared, current)
      if (pending === undefined) {
        writePending(pendingPath, desired)
      } else {
        replaceUnclaimedPending(directory, pending, desired)
      }
      const persisted = readJson(pendingPath, 'pending challenge', parsePending)
      if (persisted !== undefined && pendingMatches(persisted, prepared, expectedSummaryHash, current)) {
        throwRequired(resolvedProfile, persisted.challengeId)
      }
    }
    throw new NativeSafetyError('native approval state changed concurrently; retry after inspecting the profile', undefined, 'NATIVE_APPROVAL_STATE')
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval state could not be accessed safely', error, 'NATIVE_APPROVAL_STATE')
  }
}

/** Approve one exact pending challenge through the interactive local CLI. */
export function approveNativeChallenge(input: {
  readonly profileDir: string
  readonly challengeId: string
  readonly confirmation: string
  readonly now?: Date
}): NativeApprovalGrantV1 {
  if (input.confirmation !== 'approve') {
    throw new NativeSafetyError('native approval confirmation must be exactly approve', undefined, 'NATIVE_APPROVAL_CONFIRMATION')
  }
  const current = clock(input.now)
  const resolvedProfile = profile(input.profileDir)
  const directory = approvalDirectory(resolvedProfile)
  const pendingPath = join(directory, PENDING_FILE)
  const claimedPath = join(directory, `.pending-claim-${process.pid}-${randomUUID()}`)
  try {
    renameSync(pendingPath, claimedPath)
    syncPrivateDirectory(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NativeSafetyError('native approval challenge is missing or already claimed', error, 'NATIVE_APPROVAL_STATE')
    }
    throw new NativeSafetyError('native approval challenge could not be claimed safely', error, 'NATIVE_APPROVAL_STATE')
  }
  let grantWritten = false
  try {
    const pending = readJson(claimedPath, 'pending claim', parsePending)
    if (pending === undefined || pending.challengeId !== input.challengeId) {
      throw new NativeSafetyError('native approval challenge does not match the pending record', undefined, 'NATIVE_APPROVAL_STATE')
    }
    const createdAt = Date.parse(pending.createdAt)
    const expiresAt = Date.parse(pending.expiresAt)
    if (createdAt > current.getTime() || expiresAt <= current.getTime()) {
      throw new NativeSafetyError('native approval challenge is expired or from the future', undefined, 'NATIVE_APPROVAL_EXPIRED')
    }
    const grant: NativeApprovalGrantV1 = Object.freeze({
      version: APPROVAL_VERSION,
      approvalHash: pending.approvalHash,
      approvedAt: current.toISOString(),
      summaryHash: summaryHash(pending.summary),
    })
    durableAtomicWritePrivateFile(join(directory, GRANT_FILE), `${JSON.stringify(grant)}\n`, 0o600)
    grantWritten = true
    removeClaim(claimedPath, directory)
    return grant
  } catch (error) {
    if (!grantWritten) {
      try {
        lstatSync(claimedPath)
        removeClaim(claimedPath, directory)
      } catch { /* preserve the original failure */ }
    }
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native approval could not be completed safely', error, 'NATIVE_APPROVAL_STATE')
  }
}

/** Quote one value for a POSIX shell without allowing expansion or control bytes. */
export function shellQuotePosix(value: string): string {
  if (typeof value !== 'string' || CONTROL_BYTES.test(value)) {
    throw new NativeSafetyError('native approval command value contains a control byte', undefined, 'NATIVE_APPROVAL_STATE')
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function displayValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return 'null'
  return serialized.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
  ))
}

/** Render a terminal-safe, human-readable challenge summary. */
export function formatNativeApprovalChallenge(challenge: NativeApprovalChallengeV1): string {
  return [
    `Native MCP approval challenge ${displayValue(challenge.challengeId)}`,
    `Created: ${displayValue(challenge.createdAt)}`,
    `Expires: ${displayValue(challenge.expiresAt)}`,
    `Effective approval hash: ${displayValue(challenge.approvalHash)}`,
    `Policy implementation: ${displayValue(challenge.summary.policyImplementationVersion ?? 'unknown')}`,
    `Policy summary: ${displayValue(challenge.summary)}`,
    'Type approve exactly to authorize this effective native tool inventory.',
  ].join('\n') + '\n'
}

export function readNativeApprovalChallenge(profileDir: string): NativeApprovalChallengeV1 | undefined {
  const resolvedProfile = profile(profileDir)
  const directory = approvalDirectory(resolvedProfile)
  return readJson(join(directory, PENDING_FILE), 'pending challenge', parsePending)
}

export const NATIVE_APPROVAL_TTL_MS = APPROVAL_TTL_MS
export const NATIVE_APPROVAL_DIRECTORY = APPROVAL_DIRECTORY
