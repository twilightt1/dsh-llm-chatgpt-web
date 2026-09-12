import { randomUUID } from 'node:crypto'
import {
  closeSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { NativeSafetyError } from './errors.ts'
import {
  appendDurablePrivateJsonLine,
  acquirePrivateWriterLease,
  assertPrivateDirectory,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  syncPrivateDirectory,
} from './private-files.ts'
import { canonicalJson, hashCanonical } from './canonical.ts'
import { createOwnedConversationLedger } from '../chatgpt/conversation-cleanup.ts'
import type {
  BrokerAuthorizedToolRequest,
  BrokerCallId,
  BrokerToolResult,
  NativeCheckpoint,
  NativeCheckpointCallBinding,
  NativeCheckpointEventType,
  NativeCheckpointStore,
  NativeCheckpointSummary,
  NativeRecoveryVerdict,
  PreparedNativeRequest,
  PrivateWriterLease,
  PrivateWriterLeaseDependencies,
} from './types.ts'

const CHECKPOINT_VERSION = 1 as const
const JOURNAL_DIRECTORY = 'native-journal'
const JOURNAL_SUFFIX = '.jsonl'
const CHECKPOINT_HASH = /^[a-f0-9]{64}$/
const VALUE_HASH = /^[a-f0-9]{64}$/
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/
const MAX_RECORD_BYTES = 16 * 1024
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 4_096
const MAX_TERMINAL_JOURNALS = 64
const MAX_NON_TERMINAL_JOURNALS = 128
const JOURNAL_PHASES = new Set<NativeCheckpointEventType>([
  'generation-prepared',
  'submission-attempted',
  'generation-submitted',
  'batch-journaled',
  'results-confirmed',
  'handoff-prepared',
  'handoff-confirmed',
  'completion-journaled',
  'cleanup-prepared',
  'cleanup-confirmed',
  'replay-consumed',
  'non-replayable',
  'terminal',
])

interface CheckpointIdentity {
  readonly sessionHash: string
  readonly workspaceHash: string
  readonly providerHash: string
  readonly modelHash: string
  readonly systemHash: string
  readonly projectedToolsHash: string
  readonly projectedOptionsHash: string
  readonly executionHash: string
  readonly policyHash: string
  readonly inventoryHash: string
  readonly approvalHash: string
}

interface CheckpointRecord {
  readonly version: 1
  readonly sequence: number
  readonly checkpointHash: string
  readonly generation: number
  readonly boundary: number
  readonly phase: NativeCheckpointEventType
  readonly timestamp: string
  readonly sessionHash: string
  readonly workspaceHash: string
  readonly providerHash: string
  readonly modelHash: string
  readonly systemHash: string
  readonly projectedToolsHash: string
  readonly projectedOptionsHash: string
  readonly executionHash: string
  readonly policyHash: string
  readonly inventoryHash: string
  readonly approvalHash: string
  readonly calls?: readonly NativeCheckpointCallBinding[]
  readonly ledgerCorrelationHash?: string
  readonly reasonCode?: string
  readonly verdict?: 'completed' | 'failed' | 'abandoned'
  readonly replayConsumed?: true
}

interface ParsedJournal {
  readonly path: string
  readonly checkpointHash: string
  readonly records: readonly CheckpointRecord[]
}

interface JournalState {
  readonly journal: ParsedJournal
  readonly identity: CheckpointIdentity
  readonly latest: CheckpointRecord
  readonly replayConsumed: boolean
  readonly generation: number
  readonly currentGenerationRecords: readonly CheckpointRecord[]
  readonly latestBatch?: CheckpointRecord
  readonly latestResults?: CheckpointRecord
  readonly cleanupConfirmed?: CheckpointRecord
  readonly hasSubmissionAttempt: boolean
  readonly hasCompletion: boolean
  readonly hasNonReplayable: boolean
  readonly hasHandoffAfterLatestBatch: boolean
}

export type NativeCheckpointStoreOptions = Partial<PrivateWriterLeaseDependencies> & {
  readonly writerDependencies?: Partial<PrivateWriterLeaseDependencies>
}

function safety(message: string, cause?: unknown): NativeSafetyError {
  return new NativeSafetyError(message, cause, 'NATIVE_CHECKPOINT_UNAVAILABLE')
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VALUE_HASH.test(value)) throw safety(`native checkpoint ${label} is invalid`)
  return value
}

function assertBoundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw safety(`native checkpoint ${label} is invalid`)
  }
  return value
}

function timestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw safety(`native checkpoint ${label} is invalid`)
  return value.toISOString()
}

function assertTimestamp(value: unknown, label: string): string {
  const text = assertBoundedText(value, label)
  try {
    if (new Date(text).toISOString() !== text) throw safety(`native checkpoint ${label} is invalid`)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw safety(`native checkpoint ${label} is invalid`, error)
  }
  return text
}

function journalPath(directory: string, checkpointHash: string): string {
  return join(directory, `${checkpointHash}${JOURNAL_SUFFIX}`)
}

function callId(value: unknown): BrokerCallId {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw safety('native checkpoint call ID is invalid')
  }
  return value as BrokerCallId
}

function toolName(value: unknown): string {
  return assertBoundedText(value, 'tool name')
}

function parseCall(value: unknown): NativeCheckpointCallBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw safety('native checkpoint call binding is invalid')
  const source = value as Record<string, unknown>
  const keys = ['ordinal', 'callId', 'toolName', 'schemaHash', 'argumentsHash', 'rawResultHash', 'projectionHash', 'isError']
  if (Object.keys(source).some(key => !keys.includes(key))) throw safety('native checkpoint call binding has an invalid key set')
  const ordinal = source.ordinal
  if (!Number.isSafeInteger(ordinal) || (ordinal as number) <= 0) throw safety('native checkpoint call ordinal is invalid')
  const result: NativeCheckpointCallBinding = {
    ordinal: ordinal as number,
    callId: callId(source.callId),
    toolName: toolName(source.toolName),
    schemaHash: assertHash(source.schemaHash, 'schema hash'),
    argumentsHash: assertHash(source.argumentsHash, 'arguments hash'),
    ...(source.rawResultHash === undefined ? {} : { rawResultHash: assertHash(source.rawResultHash, 'raw result hash') }),
    ...(source.projectionHash === undefined ? {} : { projectionHash: assertHash(source.projectionHash, 'projection hash') }),
    ...(source.isError === undefined ? {} : { isError: source.isError === true }),
  }
  if (source.isError !== undefined && typeof source.isError !== 'boolean') throw safety('native checkpoint error flag is invalid')
  return result
}

function parseRecord(value: unknown): CheckpointRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw safety('native checkpoint record is invalid')
  const source = value as Record<string, unknown>
  const keys = [
    'version', 'sequence', 'checkpointHash', 'generation', 'boundary', 'phase', 'timestamp',
    'sessionHash', 'workspaceHash', 'providerHash', 'modelHash', 'systemHash',
    'projectedToolsHash', 'projectedOptionsHash', 'executionHash', 'policyHash',
    'inventoryHash', 'approvalHash', 'calls', 'ledgerCorrelationHash', 'reasonCode',
    'verdict', 'replayConsumed',
  ]
  if (Object.keys(source).some(key => !keys.includes(key))) throw safety('native checkpoint record has an invalid key set')
  const sequence = source.sequence
  const generation = source.generation
  const boundary = source.boundary
  if (source.version !== CHECKPOINT_VERSION
    || !Number.isSafeInteger(sequence) || (sequence as number) <= 0
    || !Number.isSafeInteger(generation) || (generation as number) <= 0
    || !Number.isSafeInteger(boundary) || (boundary as number) < 0
    || typeof source.phase !== 'string' || !JOURNAL_PHASES.has(source.phase as NativeCheckpointEventType)) {
    throw safety('native checkpoint record has invalid sequencing fields')
  }
  const requiredHashes = [
    ['checkpoint hash', source.checkpointHash],
    ['session hash', source.sessionHash],
    ['workspace hash', source.workspaceHash],
    ['provider hash', source.providerHash],
    ['model hash', source.modelHash],
    ['system hash', source.systemHash],
    ['projected tools hash', source.projectedToolsHash],
    ['projected options hash', source.projectedOptionsHash],
    ['execution hash', source.executionHash],
    ['policy hash', source.policyHash],
    ['inventory hash', source.inventoryHash],
    ['approval hash', source.approvalHash],
  ] as const
  for (const [label, value] of requiredHashes) assertHash(value, label)
  const derivedExecutionHash = hashCanonical('native-checkpoint-execution', 1, {
    sessionHash: source.sessionHash,
    workspaceHash: source.workspaceHash,
    providerHash: source.providerHash,
    modelHash: source.modelHash,
    systemHash: source.systemHash,
    projectedToolsHash: source.projectedToolsHash,
    projectedOptionsHash: source.projectedOptionsHash,
    policyHash: source.policyHash,
    inventoryHash: source.inventoryHash,
    approvalHash: source.approvalHash,
  })
  if (source.executionHash !== derivedExecutionHash) throw safety('native checkpoint execution identity is inconsistent')
  const calls = source.calls === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(source.calls) || source.calls.length === 0) throw safety('native checkpoint calls are invalid')
        const parsed = source.calls.map(parseCall)
        if (parsed.some((item, index) => index > 0 && item.ordinal <= parsed[index - 1]!.ordinal)) {
          throw safety('native checkpoint call order is invalid')
        }
        if (new Set(parsed.map(item => String(item.callId))).size !== parsed.length) {
          throw safety('native checkpoint calls contain duplicate IDs')
        }
        return parsed
      })()
  if (source.ledgerCorrelationHash !== undefined) assertHash(source.ledgerCorrelationHash, 'ledger correlation hash')
  if (source.reasonCode !== undefined) {
    const reason = assertBoundedText(source.reasonCode, 'reason code')
    if (!SAFE_TOKEN.test(reason)) throw safety('native checkpoint reason code is invalid')
  }
  if (source.verdict !== undefined && source.verdict !== 'completed'
    && source.verdict !== 'failed' && source.verdict !== 'abandoned') {
    throw safety('native checkpoint verdict is invalid')
  }
  if (source.replayConsumed !== undefined && source.replayConsumed !== true) {
    throw safety('native checkpoint replay marker is invalid')
  }
  return {
    version: 1,
    sequence: sequence as number,
    checkpointHash: source.checkpointHash as string,
    generation: generation as number,
    boundary: boundary as number,
    phase: source.phase as NativeCheckpointEventType,
    timestamp: assertTimestamp(source.timestamp, 'timestamp'),
    sessionHash: source.sessionHash as string,
    workspaceHash: source.workspaceHash as string,
    providerHash: source.providerHash as string,
    modelHash: source.modelHash as string,
    systemHash: source.systemHash as string,
    projectedToolsHash: source.projectedToolsHash as string,
    projectedOptionsHash: source.projectedOptionsHash as string,
    executionHash: source.executionHash as string,
    policyHash: source.policyHash as string,
    inventoryHash: source.inventoryHash as string,
    approvalHash: source.approvalHash as string,
    ...(calls === undefined ? {} : { calls }),
    ...(source.ledgerCorrelationHash === undefined ? {} : { ledgerCorrelationHash: source.ledgerCorrelationHash as string }),
    ...(source.reasonCode === undefined ? {} : { reasonCode: source.reasonCode as string }),
    ...(source.verdict === undefined ? {} : { verdict: source.verdict }),
    ...(source.replayConsumed === undefined ? {} : { replayConsumed: true }),
  }
}

function validNextPhase(previous: NativeCheckpointEventType, next: NativeCheckpointEventType): boolean {
  const allowed: Record<NativeCheckpointEventType, readonly NativeCheckpointEventType[]> = {
    'generation-prepared': ['submission-attempted', 'cleanup-prepared', 'non-replayable'],
    'submission-attempted': ['generation-submitted', 'non-replayable'],
    'generation-submitted': ['batch-journaled', 'completion-journaled', 'non-replayable'],
    'batch-journaled': ['results-confirmed', 'non-replayable'],
    'results-confirmed': ['handoff-prepared', 'cleanup-prepared', 'non-replayable'],
    'handoff-prepared': ['handoff-confirmed', 'non-replayable'],
    'handoff-confirmed': ['batch-journaled', 'completion-journaled', 'cleanup-prepared', 'non-replayable'],
    'completion-journaled': ['cleanup-prepared', 'non-replayable'],
    'cleanup-prepared': ['cleanup-confirmed', 'non-replayable'],
    'cleanup-confirmed': ['terminal', 'generation-prepared'],
    'replay-consumed': ['generation-prepared', 'non-replayable'],
    'non-replayable': ['cleanup-prepared', 'terminal'],
    'terminal': [],
  }
  return allowed[previous].includes(next)
}

function validateJournal(records: readonly CheckpointRecord[], expectedHash: string): void {
  if (records.length === 0) throw safety('native checkpoint journal is empty')
  let previous: CheckpointRecord | undefined
  for (const record of records) {
    if (record.checkpointHash !== expectedHash) throw safety('native checkpoint hash does not match its filename')
    if (previous === undefined && (record.sequence !== 1 || record.generation !== 1
      || record.boundary !== 0 || record.phase !== 'generation-prepared')) {
      throw safety('native checkpoint journal does not start with generation preparation')
    }
    if (previous !== undefined) {
      if (record.sequence !== previous.sequence + 1) throw safety('native checkpoint sequence is not contiguous')
      if (!validNextPhase(previous.phase, record.phase)) throw safety('native checkpoint contains an invalid phase transition')
      if (record.generation < previous.generation) throw safety('native checkpoint generation moved backwards')
      if (record.generation === previous.generation && record.boundary < previous.boundary) {
        throw safety('native checkpoint boundary moved backwards')
      }
      if (!expectedBoundary(record.phase, record.boundary, previous.boundary)) {
        throw safety('native checkpoint boundary transition is invalid')
      }
      if (record.generation > previous.generation) {
        if (record.phase !== 'generation-prepared' || record.generation !== previous.generation + 1
          || record.boundary !== 0 || record.replayConsumed !== true) {
          throw safety('native checkpoint generation transition is invalid')
        }
      }
      if (record.sessionHash !== previous.sessionHash || record.workspaceHash !== previous.workspaceHash
        || record.providerHash !== previous.providerHash || record.modelHash !== previous.modelHash
        || record.systemHash !== previous.systemHash || record.projectedToolsHash !== previous.projectedToolsHash
        || record.projectedOptionsHash !== previous.projectedOptionsHash || record.executionHash !== previous.executionHash
        || record.policyHash !== previous.policyHash || record.inventoryHash !== previous.inventoryHash
        || record.approvalHash !== previous.approvalHash) {
        throw safety('native checkpoint identity changed within a journal')
      }
    }
    if (record.phase === 'generation-prepared' && record.boundary !== 0) {
      throw safety('native checkpoint generation preparation has a non-zero boundary')
    }
    const callPhase = record.phase === 'batch-journaled' || record.phase === 'results-confirmed'
      || record.phase === 'handoff-prepared' || record.phase === 'handoff-confirmed'
    if (callPhase && record.calls === undefined) throw safety('native checkpoint boundary has no call bindings')
    if (!callPhase && record.calls !== undefined) throw safety('native checkpoint event has unexpected call bindings')
    if ((record.phase === 'batch-journaled' || record.phase === 'results-confirmed' || record.phase === 'handoff-prepared')
      && record.calls?.some(call => call.projectionHash !== undefined)) {
      throw safety('native checkpoint pre-handoff call evidence is malformed')
    }
    if (record.phase === 'results-confirmed' || record.phase === 'handoff-prepared' || record.phase === 'handoff-confirmed') {
      if (record.calls?.some(call => call.rawResultHash === undefined || call.isError === undefined)) {
        throw safety('native checkpoint results omit raw result evidence')
      }
    }
    if (record.phase === 'handoff-confirmed' && record.calls?.some(call => call.projectionHash === undefined)) {
      throw safety('native checkpoint handoff omits projection evidence')
    }
    if (record.phase === 'handoff-confirmed' && record.calls?.some(call => call.rawResultHash === undefined || call.isError === undefined)) {
      throw safety('native checkpoint handoff omits raw result evidence')
    }
    if (record.phase !== 'cleanup-confirmed' && record.ledgerCorrelationHash !== undefined) {
      throw safety('native checkpoint event has unexpected cleanup correlation')
    }
    if (record.phase !== 'non-replayable' && record.reasonCode !== undefined) {
      throw safety('native checkpoint event has unexpected reason code')
    }
    if (record.phase !== 'terminal' && record.verdict !== undefined) {
      throw safety('native checkpoint event has unexpected terminal verdict')
    }
    if (record.phase !== 'generation-prepared' && record.replayConsumed !== undefined) {
      throw safety('native checkpoint event has unexpected replay marker')
    }
    if (previous !== undefined) {
      if (previous.phase === 'batch-journaled' && record.phase === 'results-confirmed'
        && !sameCallBase(previous.calls!, record.calls!)) {
        throw safety('native checkpoint result evidence changed its call binding')
      }
      if (previous.phase === 'results-confirmed' && record.phase === 'handoff-prepared'
        && !sameResultEvidence(previous.calls!, record.calls!)) {
        throw safety('native checkpoint handoff preparation changed result evidence')
      }
      const prior = previous
      if (prior.phase === 'handoff-prepared' && record.phase === 'handoff-confirmed'
        && (!sameResultEvidence(prior.calls!, record.calls!)
          || record.calls!.some((call, index) => call.projectionHash === undefined
            || String(call.callId) !== String(prior.calls![index]!.callId)))) {
        throw safety('native checkpoint handoff confirmation changed result evidence')
      }
    }
    if (record.phase === 'cleanup-confirmed' && record.ledgerCorrelationHash === undefined) {
      throw safety('native checkpoint cleanup confirmation omits its correlation')
    }
    if (record.phase === 'non-replayable' && record.reasonCode === undefined) {
      throw safety('native checkpoint non-replayable event omits its reason')
    }
    if (record.phase === 'terminal' && record.verdict === undefined) {
      throw safety('native checkpoint terminal event omits its verdict')
    }
    previous = record
  }
}

function stateFor(journal: ParsedJournal): JournalState {
  const records = journal.records
  const latest = records[records.length - 1]!
  const current = records.filter(record => record.generation === latest.generation)
  const identity: CheckpointIdentity = {
    sessionHash: latest.sessionHash,
    workspaceHash: latest.workspaceHash,
    providerHash: latest.providerHash,
    modelHash: latest.modelHash,
    systemHash: latest.systemHash,
    projectedToolsHash: latest.projectedToolsHash,
    projectedOptionsHash: latest.projectedOptionsHash,
    executionHash: latest.executionHash,
    policyHash: latest.policyHash,
    inventoryHash: latest.inventoryHash,
    approvalHash: latest.approvalHash,
  }
  const batches = current.filter(record => record.phase === 'batch-journaled')
  const latestBatch = batches[batches.length - 1]
  const results = current.filter(record => record.phase === 'results-confirmed')
  const latestResults = results[results.length - 1]
  const cleanups = current.filter(record => record.phase === 'cleanup-confirmed')
  const cleanupConfirmed = cleanups[cleanups.length - 1]
  const latestHandoff = latestBatch === undefined ? undefined : current
    .filter(record => record.phase === 'handoff-confirmed' && record.sequence > latestBatch.sequence)
    .at(-1)
  const hasHandoffAfterLatestBatch = latestHandoff !== undefined
    && !current.some(record => record.phase === 'completion-journaled' && record.sequence > latestHandoff.sequence)
  return {
    journal,
    identity,
    latest,
    replayConsumed: records.some(record => record.replayConsumed === true || record.phase === 'replay-consumed'),
    generation: latest.generation,
    currentGenerationRecords: current,
    ...(latestBatch === undefined ? {} : { latestBatch }),
    ...(latestResults === undefined ? {} : { latestResults }),
    ...(cleanupConfirmed === undefined ? {} : { cleanupConfirmed }),
    hasSubmissionAttempt: current.some(record => record.phase === 'submission-attempted' || record.phase === 'generation-submitted'
      || record.phase === 'batch-journaled' || record.phase === 'results-confirmed'
      || record.phase === 'handoff-prepared' || record.phase === 'handoff-confirmed'
      || record.phase === 'completion-journaled'),
    hasCompletion: current.some(record => record.phase === 'completion-journaled'),
    hasNonReplayable: current.some(record => record.phase === 'non-replayable'),
    hasHandoffAfterLatestBatch,
  }
}

function readJournal(path: string, allowTailTruncate: boolean): ParsedJournal {
  const fileName = path.split('/').pop() ?? ''
  const match = /^([a-f0-9]{64})\.jsonl$/.exec(fileName)
  if (match === null) throw safety('native checkpoint filename is invalid')
  const checkpointHash = match[1]!
  try {
    assertPrivateRegularFile(path, 'native checkpoint journal')
    if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error('native checkpoint journal must have 0600 permissions')
  } catch (error) {
    throw safety('native checkpoint journal is not a safe private file', error)
  }
  let bytes = readFileSync(path)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_JOURNAL_BYTES) throw safety('native checkpoint journal size is invalid')
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    if (!allowTailTruncate) throw safety('native checkpoint journal has an incomplete final line')
    const lastNewline = bytes.lastIndexOf(0x0a)
    if (lastNewline < 0) throw safety('native checkpoint journal has no complete record')
    const fd = openSync(path, 'r+')
    try {
      ftruncateSync(fd, lastNewline + 1)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syncPrivateDirectory(dirname(path))
    bytes = bytes.subarray(0, lastNewline + 1)
  }
  const lines = bytes.toString('utf8').slice(0, -1).split('\n')
  if (lines.length > MAX_RECORDS) throw safety('native checkpoint journal exceeds its record limit')
  const records = lines.map(line => {
    if (Buffer.byteLength(line, 'utf8') + 1 > MAX_RECORD_BYTES) throw safety('native checkpoint record exceeds its size limit')
    try {
      return parseRecord(JSON.parse(line) as unknown)
    } catch (error) {
      if (error instanceof NativeSafetyError) throw error
      throw safety('native checkpoint journal contains malformed JSON', error)
    }
  })
  validateJournal(records, checkpointHash)
  return { path, checkpointHash, records }
}

function identityFor(prepared: PreparedNativeRequest): CheckpointIdentity {
  const snapshot = prepared.nativeRound?.coordinatorSnapshot
  if (snapshot === undefined) throw safety('native checkpoint requires a prepared coordinator round')
  const options = prepared.providerOptions
  const systemHash = hashCanonical('native-checkpoint-system', 1, options.system)
  const projectedToolsHash = hashCanonical('native-checkpoint-tools', 1, options.tools)
  const projectedOptions = {
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    stop: options.stop,
    purpose: options.purpose,
  }
  const projectedOptionsHash = hashCanonical('native-checkpoint-options', 1, projectedOptions)
  const sessionHash = hashCanonical('native-checkpoint-session', 1, snapshot.sessionId)
  const workspaceHash = hashCanonical('native-checkpoint-workspace', 1, prepared.summary.workspaceRoot)
  const providerHash = hashCanonical('native-checkpoint-provider', 1, options.provider)
  const modelHash = hashCanonical('native-checkpoint-model', 1, options.model)
  const executionHash = hashCanonical('native-checkpoint-execution', 1, {
    sessionHash,
    workspaceHash,
    providerHash,
    modelHash,
    systemHash,
    projectedToolsHash,
    projectedOptionsHash,
    policyHash: prepared.policyHash,
    inventoryHash: prepared.inventoryHash,
    approvalHash: prepared.approvalHash,
  })
  return {
    sessionHash,
    workspaceHash,
    providerHash,
    modelHash,
    systemHash,
    projectedToolsHash,
    projectedOptionsHash,
    executionHash,
    policyHash: assertHash(prepared.policyHash, 'policy hash'),
    inventoryHash: assertHash(prepared.inventoryHash, 'inventory hash'),
    approvalHash: assertHash(prepared.approvalHash, 'approval hash'),
  }
}

function rawResultHash(result: BrokerToolResult): string {
  return hashCanonical('native-tool-result', 1, { content: result.content, isError: result.isError === true })
}

function projectionHash(result: BrokerToolResult): string {
  return hashCanonical('native-tool-projection', 1, { content: result.content, isError: result.isError === true })
}

/**
 * @deprecated Checkpoint result hashes are implementation-owned evidence.
 */
export function nativeCheckpointRawResultHash(result: BrokerToolResult): string {
  return rawResultHash(result)
}

/**
 * @deprecated Checkpoint result hashes are implementation-owned evidence.
 */
export function nativeCheckpointProjectionHash(result: BrokerToolResult): string {
  return projectionHash(result)
}

function sameIdentity(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
  return left.sessionHash === right.sessionHash
    && left.workspaceHash === right.workspaceHash
    && left.providerHash === right.providerHash
    && left.modelHash === right.modelHash
    && left.systemHash === right.systemHash
    && left.projectedToolsHash === right.projectedToolsHash
    && left.projectedOptionsHash === right.projectedOptionsHash
    && left.executionHash === right.executionHash
    && left.policyHash === right.policyHash
    && left.inventoryHash === right.inventoryHash
    && left.approvalHash === right.approvalHash
}

function sameCallBindings(left: readonly NativeCheckpointCallBinding[], right: readonly NativeCheckpointCallBinding[]): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function sameCallBase(left: readonly NativeCheckpointCallBinding[], right: readonly NativeCheckpointCallBinding[]): boolean {
  if (left.length !== right.length) return false
  return left.every((call, index) => {
    const other = right[index]
    return other !== undefined
      && call.ordinal === other.ordinal
      && String(call.callId) === String(other.callId)
      && call.toolName === other.toolName
      && call.schemaHash === other.schemaHash
      && call.argumentsHash === other.argumentsHash
  })
}

function sameResultEvidence(left: readonly NativeCheckpointCallBinding[], right: readonly NativeCheckpointCallBinding[]): boolean {
  if (left.length !== right.length) return false
  return left.every((call, index) => {
    const other = right[index]
    return other !== undefined
      && sameCallBase([call], [other])
      && call.rawResultHash === other.rawResultHash
      && call.isError === other.isError
  })
}

function expectedBoundary(next: NativeCheckpointEventType, boundary: number, previousBoundary: number): boolean {
  if (next === 'generation-prepared') return boundary === 0
  if (next === 'batch-journaled') return boundary === previousBoundary + 1
  return boundary === previousBoundary
}

function callBindings(calls: readonly BrokerAuthorizedToolRequest[]): NativeCheckpointCallBinding[] {
  if (calls.length === 0) throw safety('native checkpoint cannot journal an empty tool batch')
  const bindings = calls.map(call => {
    const binding = call.binding
    if (binding === undefined) throw safety('native checkpoint requires an immutable policy call binding')
    const id = callId(call.callId)
    const name = toolName(call.name)
    if (binding.toolName !== name) throw safety('native checkpoint call binding tool name does not match its call')
    if (!Number.isSafeInteger(binding.callOrdinal) || binding.callOrdinal <= 0) {
      throw safety('native checkpoint call ordinal is invalid')
    }
    if (!CHECKPOINT_HASH.test(binding.schemaHash) || !CHECKPOINT_HASH.test(binding.argumentsHash)) {
      throw safety('native checkpoint call binding hash is invalid')
    }
    let argumentsHash: string
    try {
      argumentsHash = hashCanonical('native-tool-arguments', 1, call.arguments)
    } catch (error) {
      throw safety('native checkpoint call arguments are not canonical JSON', error)
    }
    if (argumentsHash !== binding.argumentsHash) {
      throw safety('native checkpoint call arguments do not match their binding hash')
    }
    return {
      ordinal: binding.callOrdinal,
      callId: id,
      toolName: name,
      schemaHash: binding.schemaHash,
      argumentsHash: binding.argumentsHash,
    }
  })
  if (bindings.some((item, index) => index > 0 && item.ordinal <= bindings[index - 1]!.ordinal)) {
    throw safety('native checkpoint call ordinals are not increasing')
  }
  if (new Set(bindings.map(item => String(item.callId))).size !== bindings.length) {
    throw safety('native checkpoint batch contains duplicate call IDs')
  }
  return bindings
}

function exactCallBindings(calls: readonly BrokerAuthorizedToolRequest[], expected: readonly NativeCheckpointCallBinding[]): NativeCheckpointCallBinding[] {
  const actual = callBindings(calls)
  if (!sameCallBindings(actual, expected)) throw safety('native checkpoint call evidence does not match the journal')
  return actual
}

function resultBindings(
  calls: readonly BrokerAuthorizedToolRequest[],
  results: readonly BrokerToolResult[],
  expected: readonly NativeCheckpointCallBinding[],
): NativeCheckpointCallBinding[] {
  if (calls.length !== results.length) throw safety('native checkpoint result count does not match its calls')
  const actual = exactCallBindings(calls, expected)
  return actual.map((call, index) => ({
    ...call,
    rawResultHash: rawResultHash(results[index]!),
    isError: results[index]!.isError === true,
  }))
}

function projectionBindings(
  expected: readonly NativeCheckpointCallBinding[],
  projections: readonly BrokerToolResult[],
): NativeCheckpointCallBinding[] {
  if (expected.length !== projections.length) throw safety('native checkpoint projection count does not match its calls')
  return expected.map((call, index) => {
    if (call.rawResultHash === undefined || call.isError === undefined) throw safety('native checkpoint raw result evidence is missing')
    const result = projections[index]!
    if ((result.isError === true) !== call.isError) throw safety('native checkpoint projection changed the error flag')
    return { ...call, projectionHash: projectionHash(result) }
  })
}

function incomingToolResult(value: unknown, expectedCallId: string): BrokerToolResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const message = value as { readonly role?: unknown; readonly source?: { readonly kind?: unknown; readonly callId?: unknown }; readonly content?: unknown }
  if (message.role !== 'user' || message.source?.kind !== 'tool' || String(message.source.callId) !== expectedCallId
    || !Array.isArray(message.content) || message.content.length !== 1) return undefined
  const block = message.content[0] as { readonly type?: unknown; readonly toolCallId?: unknown; readonly content?: unknown; readonly isError?: unknown }
  if (block?.type !== 'tool-result' || String(block.toolCallId) !== expectedCallId
    || !Array.isArray(block.content) || block.content.some(item => item?.type !== 'text')
    || (block.isError !== undefined && typeof block.isError !== 'boolean')) return undefined
  return { content: structuredClone(block.content), isError: block.isError === true }
}

function exactIncomingResults(prepared: PreparedNativeRequest, bindings: readonly NativeCheckpointCallBinding[]): boolean {
  if (bindings.some(binding => prepared.summary.tools.find(tool => tool.tool === binding.toolName)?.schemaHash !== binding.schemaHash)) {
    return false
  }
  const canonicalMessages = prepared.nativeRound?.coordinatorSnapshot.canonicalMessages
  if (canonicalMessages === undefined) return false
  const providerMessages = prepared.providerOptions.messages
  const find = (
    messages: readonly unknown[],
    expectedArguments?: readonly string[],
  ): { readonly index: number; readonly results: readonly BrokerToolResult[] } | undefined => {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index] as { readonly role?: unknown; readonly content?: unknown } | undefined
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      const blocks = message.content.filter(item => item?.type === 'tool-call') as Array<{ readonly id?: unknown; readonly name?: unknown; readonly arguments?: unknown }>
      if (blocks.length !== bindings.length) continue
      const callsMatch = bindings.every((binding, callIndex) => {
        const block = blocks[callIndex]
        if (block === undefined || String(block.id) !== String(binding.callId) || block.name !== binding.toolName
          || typeof block.arguments !== 'string') return false
        if (expectedArguments !== undefined) return block.arguments === expectedArguments[callIndex]
        let args: unknown
        try { args = JSON.parse(block.arguments) } catch { return false }
        return hashCanonical('native-tool-arguments', 1, args) === binding.argumentsHash
      })
      if (!callsMatch) continue
      const results: BrokerToolResult[] = []
      let complete = true
      for (let resultIndex = 0; resultIndex < bindings.length; resultIndex += 1) {
        const result = incomingToolResult(messages[index + 1 + resultIndex], String(bindings[resultIndex]!.callId))
        if (result === undefined || rawResultHash(result) !== bindings[resultIndex]!.rawResultHash) {
          complete = false
          break
        }
        results.push(result)
      }
      if (complete) return { index, results }
    }
    return undefined
  }
  const canonical = find(canonicalMessages)
  if (canonical === undefined) return false
  const canonicalAssistant = canonicalMessages[canonical.index]
  if (canonicalAssistant === undefined) return false
  const projectedAssistant = prepared.projectProviderMessages([canonicalAssistant])[0]
  if (projectedAssistant === undefined || !Array.isArray(projectedAssistant.content)) return false
  const projectedArguments = projectedAssistant.content
    .filter((block): block is Extract<typeof block, { type: 'tool-call' }> => block.type === 'tool-call')
    .map(block => block.arguments)
  if (projectedArguments.length !== bindings.length) return false
  const provider = find(providerMessages, projectedArguments)
  if (provider === undefined) return false
  return bindings.every((binding, index) => (binding.projectionHash === undefined
    || projectionHash(provider.results[index]!) === binding.projectionHash)
    && provider.results[index]!.isError === binding.isError)
}

class NativeCheckpointImpl implements NativeCheckpoint {
  private current: JournalState
  private closed = false

  constructor(
    private readonly store: NativeCheckpointStoreImpl,
    state: JournalState,
  ) {
    this.current = state
  }

  get checkpointHash(): string { return this.current.journal.checkpointHash }
  get generation(): number { return this.current.generation }

  recordSubmissionAttempted(): void {
    this.append('submission-attempted', 0)
  }

  recordSubmitted(): void {
    this.append('generation-submitted', 0)
  }

  recordBatch(calls: readonly BrokerAuthorizedToolRequest[]): void {
    const previousBoundary = this.current.latest.boundary
    const bindings = callBindings(calls)
    this.append('batch-journaled', previousBoundary + 1, { calls: bindings })
  }

  confirmResults(calls: readonly BrokerAuthorizedToolRequest[], results: readonly BrokerToolResult[]): void {
    const latest = this.requirePhase('batch-journaled')
    const bindings = resultBindings(calls, results, latest.calls ?? [])
    this.append('results-confirmed', latest.boundary, { calls: bindings })
  }

  prepareHandoff(): void {
    const latest = this.requirePhase('results-confirmed')
    this.append('handoff-prepared', latest.boundary, { calls: latest.calls! })
  }

  confirmHandoff(projections: readonly BrokerToolResult[]): void {
    const latest = this.requirePhase('handoff-prepared')
    const bindings = projectionBindings(latest.calls ?? [], projections)
    this.append('handoff-confirmed', latest.boundary, { calls: bindings })
  }

  recordCompletion(): void {
    if (this.current.latest.phase !== 'generation-submitted' && this.current.latest.phase !== 'handoff-confirmed') {
      throw safety(`native checkpoint cannot journal completion after ${this.current.latest.phase}`)
    }
    this.append('completion-journaled', this.current.latest.boundary)
  }

  prepareCleanup(): void {
    const allowed = new Set<NativeCheckpointEventType>([
      'generation-prepared', 'results-confirmed', 'handoff-confirmed', 'completion-journaled', 'non-replayable',
    ])
    if (!allowed.has(this.current.latest.phase)) throw safety(`native checkpoint cannot prepare cleanup after ${this.current.latest.phase}`)
    this.append('cleanup-prepared', this.current.latest.boundary)
  }

  confirmCleanup(ledgerCorrelationHash: string): void {
    assertHash(ledgerCorrelationHash, 'ledger correlation hash')
    this.requirePhase('cleanup-prepared')
    this.store.assertCleanupLedgerEmpty()
    this.append('cleanup-confirmed', this.current.latest.boundary, { ledgerCorrelationHash })
  }

  consumeReplayAndPrepareNextGeneration(): number {
    const latest = this.requirePhase('cleanup-confirmed')
    if (this.current.latestBatch === undefined || this.current.latestResults === undefined) {
      throw safety('native checkpoint has no exact result boundary to replay')
    }
    const nextGeneration = latest.generation + 1
    this.append('generation-prepared', 0, { replayConsumed: true }, nextGeneration)
    return nextGeneration
  }

  markNonReplayable(reasonCode: string): void {
    const reason = assertBoundedText(reasonCode, 'reason code')
    if (!SAFE_TOKEN.test(reason)) throw safety('native checkpoint reason code is invalid')
    if (this.current.latest.phase === 'terminal') return
    if (this.current.latest.phase === 'non-replayable') return
    this.append('non-replayable', this.current.latest.boundary, { reasonCode: reason })
  }

  markTerminal(verdict: 'completed' | 'failed' | 'abandoned'): void {
    if (this.current.latest.phase === 'terminal') return
    this.requirePhase('cleanup-confirmed')
    this.append('terminal', this.current.latest.boundary, { verdict })
    this.store.onTerminal(this.current.journal.checkpointHash)
  }

  private requirePhase(phase: NativeCheckpointEventType): CheckpointRecord {
    if (this.current.latest.phase !== phase) throw safety(`native checkpoint expected ${phase}, found ${this.current.latest.phase}`)
    return this.current.latest
  }

  private append(
    phase: NativeCheckpointEventType,
    boundary: number,
    extras: Partial<Pick<CheckpointRecord, 'calls' | 'ledgerCorrelationHash' | 'reasonCode' | 'verdict' | 'replayConsumed'>> = {},
    generation = this.current.generation,
  ): void {
    this.store.assertCheckpointWriter()
    if (this.closed) throw safety('native checkpoint is closed')
    const previous = this.current.latest
    if (generation === previous.generation && boundary < previous.boundary) throw safety('native checkpoint boundary moved backwards')
    if (!validNextPhase(previous.phase, phase) && !(generation > previous.generation && phase === 'generation-prepared')) {
      throw safety(`native checkpoint cannot append ${phase} after ${previous.phase}`)
    }
    const record: CheckpointRecord = {
      version: 1,
      sequence: previous.sequence + 1,
      checkpointHash: this.current.journal.checkpointHash,
      generation,
      boundary,
      phase,
      timestamp: this.store.nowTimestamp(),
      ...this.current.identity,
      ...extras,
    }
    appendDurableJsonRecord(this.current.journal.path, record)
    const records = [...this.current.journal.records, record]
    validateJournal(records, this.current.journal.checkpointHash)
    this.current = stateFor({ ...this.current.journal, records })
  }

  close(): void { this.closed = true }
}

function appendDurableJsonRecord(path: string, record: CheckpointRecord): void {
  const lineBytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
  if (lineBytes > MAX_RECORD_BYTES) throw safety('native checkpoint record exceeds its size limit')
  appendDurablePrivateJsonLine(path, record)
}

function summary(state: JournalState): NativeCheckpointSummary {
  const blockedReason = state.latest.phase === 'terminal'
    ? undefined
    : state.latest.phase === 'generation-prepared' && state.latest.replayConsumed === true
      ? 'replay-consumed-before-submission'
      : state.latest.phase === 'submission-attempted' || state.latest.phase === 'generation-submitted'
        ? 'provider-outcome-unknown'
        : state.latest.phase === 'batch-journaled'
          ? 'potentially-executed-tool-boundary'
          : state.latest.phase === 'handoff-prepared'
            ? 'result-handoff-unknown'
            : undefined
  return {
    checkpointHash: state.journal.checkpointHash,
    executionHash: state.identity.executionHash,
    latestEvent: state.latest.phase,
    terminal: state.latest.phase === 'terminal',
    replayConsumed: state.replayConsumed,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  }
}

export class NativeCheckpointStoreImpl implements NativeCheckpointStore {
  private readonly directory: string
  private readonly now: () => Date
  private readonly makeUUID: () => string
  private writer: PrivateWriterLease | undefined
  private readonly active = new Map<string, NativeCheckpointImpl>()
  private readonly recoveryCleanupCorrelations = new Map<string, string>()

  constructor(private readonly profileDir: string, private readonly options: NativeCheckpointStoreOptions = {}) {
    this.directory = join(profileDir, JOURNAL_DIRECTORY)
    this.now = options.now ?? (() => new Date())
    this.makeUUID = options.randomUUID ?? randomUUID
  }

  acquire(): PrivateWriterLease {
    if (this.writer !== undefined) return this.writer
    ensurePrivateDirectory(this.profileDir)
    ensurePrivateDirectory(this.directory)
    const acquired = acquirePrivateWriterLease(
      this.profileDir,
      this.options.writerDependencies ?? this.options,
    )
    let released = false
    const wrapped: PrivateWriterLease = {
      ownerToken: acquired.ownerToken,
      heartbeat: (): void => {
        if (released) throw safety('native checkpoint writer lease is released')
        acquired.heartbeat()
      },
      release: (): void => {
        if (released) return
        acquired.release()
        for (const checkpoint of this.active.values()) checkpoint.close()
        this.active.clear()
        released = true
        if (this.writer === wrapped) this.writer = undefined
      },
    }
    this.writer = wrapped
    return wrapped
  }

  inspect(): readonly NativeCheckpointSummary[] {
    if (this.writer !== undefined) this.assertCheckpointWriter()
    return this.load(this.writer !== undefined).map(summary)
  }

  recoverForRequest(prepared: PreparedNativeRequest): NativeRecoveryVerdict {
    this.assertCheckpointWriter()
    const states = this.load(true)
    const identity = identityFor(prepared)
    const nonTerminal = states.filter(state => state.latest.phase !== 'terminal')
    for (const state of nonTerminal) {
      const active = this.active.get(state.journal.checkpointHash)
      if (active !== undefined) {
        if (state.identity.executionHash === identity.executionHash) continue
        return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'another native checkpoint is active' }
      }
      if (state.latest.phase === 'generation-prepared' && state.latest.replayConsumed !== true
        && !state.hasSubmissionAttempt) {
        if (!this.ledgerIsEmpty()) {
          return { kind: 'cleanup-required', checkpointHash: state.journal.checkpointHash }
        }
        this.autoClosePrepared(state)
        continue
      }
      if (state.latest.phase === 'generation-prepared' && state.latest.replayConsumed === true) {
        return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'replay was consumed before submission was proven' }
      }
      if (state.latest.phase === 'replay-consumed') {
        return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'replay was already consumed' }
      }
      if (state.latest.phase === 'submission-attempted' || state.latest.phase === 'generation-submitted') {
        return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'provider outcome is uncertain; refusing resubmission' }
      }
      if (state.latest.phase === 'batch-journaled') {
        return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'tool boundary may have executed; exact results are not durable' }
      }
      if (state.latest.phase === 'handoff-prepared' || state.latest.phase === 'handoff-confirmed') {
        return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'provider continuation outcome is unknown' }
      }
      if (state.latest.phase === 'non-replayable' || state.latest.phase === 'completion-journaled'
        || state.latest.phase === 'cleanup-prepared' || state.latest.phase === 'results-confirmed') {
        return { kind: 'cleanup-required', checkpointHash: state.journal.checkpointHash }
      }
      if (state.latest.phase === 'cleanup-confirmed') {
        if (state.hasHandoffAfterLatestBatch) {
          return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'provider continuation outcome is unknown' }
        }
        if (state.hasNonReplayable) {
          const checkpoint = this.materialize(state)
          checkpoint.markTerminal('failed')
          continue
        }
        if (!this.ledgerIsEmpty()) {
          return { kind: 'cleanup-required', checkpointHash: state.journal.checkpointHash }
        }
        if (state.hasCompletion || state.latestBatch === undefined || state.latestResults === undefined) {
          const checkpoint = this.materialize(state)
          checkpoint.markTerminal(state.hasCompletion ? 'completed' : 'failed')
          continue
        }
        if (!sameIdentity(state.identity, identity)) {
          return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'native checkpoint identity does not match the request' }
        }
        if (!exactIncomingResults(prepared, state.latestResults.calls ?? [])) {
          return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'canonical tool calls or results do not exactly match the journal' }
        }
        return {
          kind: 'fresh-replay',
          checkpointHash: state.journal.checkpointHash,
          generation: state.generation + 1,
        }
      }
      if (state.latest.phase === 'terminal') continue
      return { kind: 'blocked', checkpointHash: state.journal.checkpointHash, reason: 'native checkpoint state is not recoverable' }
    }
    return { kind: 'normal' }
  }

  begin(prepared: PreparedNativeRequest): NativeCheckpoint {
    this.assertCheckpointWriter()
    const identity = identityFor(prepared)
    this.pruneAndCheckCaps()
    ensurePrivateDirectory(this.directory)
    let checkpointHash = ''
    let path = ''
    for (let attempt = 0; attempt < 8; attempt += 1) {
      checkpointHash = hashCanonical('native-checkpoint-id', 1, {
        nonce: this.makeUUID(),
        attempt,
      })
      path = journalPath(this.directory, checkpointHash)
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || !stat.isFile()) throw safety('native checkpoint identifier collides with an unsafe target')
        continue
      } catch (error) {
        if (errorCode(error) === 'ENOENT') break
        if (error instanceof NativeSafetyError) throw error
        throw safety('native checkpoint identifier could not be checked safely', error)
      }
    }
    if (path.length === 0) throw safety('native checkpoint identifier could not be allocated')
    try {
      lstatSync(path)
      throw safety('native checkpoint identifier collision could not be resolved')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const record: CheckpointRecord = {
      version: 1,
      sequence: 1,
      checkpointHash,
      generation: 1,
      boundary: 0,
      phase: 'generation-prepared',
      timestamp: this.nowTimestamp(),
      ...identity,
    }
    appendDurableJsonRecord(path, record)
    const state = stateFor({ path, checkpointHash, records: [record] })
    const checkpoint = new NativeCheckpointImpl(this, state)
    this.active.set(checkpointHash, checkpoint)
    return checkpoint
  }

  prepareRecoveryCleanup(checkpointHash: string): void {
    this.assertCheckpointWriter()
    const state = this.load(true).find(item => item.journal.checkpointHash === checkpointHash)
    if (state === undefined) throw safety('native checkpoint was not found')
    if (this.active.has(checkpointHash)) throw safety('native checkpoint cleanup is owned by the active runtime')
    const pending = createOwnedConversationLedger(this.profileDir).pending()
    if (state.latest.phase === 'cleanup-confirmed') {
      if (pending.length !== 0) throw safety('native checkpoint cleanup confirmation conflicts with the ownership ledger')
      this.recoveryCleanupCorrelations.delete(checkpointHash)
      return
    }
    if (pending.length !== 1) throw safety('native checkpoint cleanup cannot be correlated to exactly one owned conversation')
    this.recoveryCleanupCorrelations.set(
      checkpointHash,
      hashCanonical('native-ledger-correlation', 1, pending[0]),
    )
    if (state.latest.phase !== 'cleanup-prepared') this.materialize(state).prepareCleanup()
  }

  confirmRecoveryCleanup(checkpointHash: string, ledgerCorrelationHash: string): void {
    this.assertCheckpointWriter()
    const state = this.load(true).find(item => item.journal.checkpointHash === checkpointHash)
    if (state === undefined) throw safety('native checkpoint was not found')
    if (this.active.has(checkpointHash)) throw safety('native checkpoint cleanup is owned by the active runtime')
    if (state.latest.phase === 'cleanup-confirmed') {
      if (createOwnedConversationLedger(this.profileDir).pending().length !== 0) {
        throw safety('native checkpoint cleanup confirmation conflicts with the ownership ledger')
      }
      this.recoveryCleanupCorrelations.delete(checkpointHash)
      return
    }
    const expected = this.recoveryCleanupCorrelations.get(checkpointHash)
    if (expected === undefined || expected !== ledgerCorrelationHash) {
      throw safety('native checkpoint cleanup correlation is not the prepared ownership proof')
    }
    if (createOwnedConversationLedger(this.profileDir).pending().length !== 0) {
      throw safety('native checkpoint cleanup cannot be confirmed while ownership remains pending')
    }
    const checkpoint = this.materialize(state)
    checkpoint.confirmCleanup(ledgerCorrelationHash)
    this.recoveryCleanupCorrelations.delete(checkpointHash)
  }

  prepareFreshReplay(prepared: PreparedNativeRequest, checkpointHash: string): NativeCheckpoint {
    this.assertCheckpointWriter()
    if (!CHECKPOINT_HASH.test(checkpointHash)) throw safety('native checkpoint hash is invalid')
    const state = this.load(true).find(item => item.journal.checkpointHash === checkpointHash)
    if (state === undefined) throw safety('native checkpoint was not found')
    const identity = identityFor(prepared)
    if (!sameIdentity(state.identity, identity)) throw safety('native checkpoint identity does not match the replay request')
    if (state.latest.phase !== 'cleanup-confirmed' || state.latestBatch === undefined || state.latestResults === undefined) {
      throw safety('native checkpoint is not ready for a fresh replay')
    }
    if (!exactIncomingResults(prepared, state.latestResults.calls ?? [])) throw safety('native checkpoint replay evidence does not match the request')
    const checkpoint = this.materialize(state)
    checkpoint.consumeReplayAndPrepareNextGeneration()
    this.active.set(checkpointHash, checkpoint)
    return checkpoint
  }

  abandon(checkpointHash: string): void {
    this.assertCheckpointWriter()
    if (!CHECKPOINT_HASH.test(checkpointHash)) throw safety('native checkpoint hash is invalid')
    const state = this.load(true).find(item => item.journal.checkpointHash === checkpointHash)
    if (state === undefined) throw safety('native checkpoint was not found')
    if (this.active.has(checkpointHash)) throw safety('native checkpoint is owned by the active runtime')
    if (state.latest.phase === 'terminal') return
    if (state.latest.phase === 'cleanup-confirmed') {
      if (!this.ledgerIsEmpty()) throw safety('native checkpoint abandonment requires confirmed ownership cleanup')
      if (state.hasHandoffAfterLatestBatch) {
        throw safety('native checkpoint abandonment cannot close an unknown provider continuation')
      }
      this.materialize(state).markTerminal('abandoned')
      return
    }
    const checkpoint = this.materialize(state)
    if (state.latest.phase !== 'non-replayable') {
      checkpoint.markNonReplayable('operator-abandon')
    }
    if (state.hasSubmissionAttempt) {
      // Leave the durable non-replayable fence in place. The recovery command
      // performs exact ledger-correlated cleanup while retaining this writer.
      return
    }
    checkpoint.prepareCleanup()
    checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
    checkpoint.markTerminal('abandoned')
  }

  nowTimestamp(): string { return timestamp(this.now(), 'timestamp') }

  onTerminal(checkpointHash: string): void {
    const checkpoint = this.active.get(checkpointHash)
    checkpoint?.close()
    this.active.delete(checkpointHash)
  }

  private materialize(state: JournalState): NativeCheckpointImpl {
    const active = this.active.get(state.journal.checkpointHash)
    if (active !== undefined) return active
    const checkpoint = new NativeCheckpointImpl(this, state)
    return checkpoint
  }

  private autoClosePrepared(state: JournalState): void {
    const checkpoint = this.materialize(state)
    checkpoint.prepareCleanup()
    checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
    checkpoint.markTerminal('abandoned')
  }

  assertCheckpointWriter(): void {
    this.requireWriter()
    try {
      this.writer!.heartbeat()
    } catch (error) {
      throw safety('native checkpoint writer ownership could not be verified', error)
    }
  }

  assertCleanupLedgerEmpty(): void {
    if (!this.ledgerIsEmpty()) throw safety('native checkpoint ownership ledger is not empty')
  }

  private requireWriter(): void {
    if (this.writer === undefined) throw safety('native checkpoint writer lease is required')
  }

  private ledgerIsEmpty(): boolean {
    return createOwnedConversationLedger(this.profileDir).pending().length === 0
  }

  private pruneAndCheckCaps(): void {
    const states = this.load(true)
    const terminals = states.filter(state => state.latest.phase === 'terminal')
      .sort((left, right) => left.latest.timestamp.localeCompare(right.latest.timestamp))
    for (const state of terminals.slice(0, Math.max(0, terminals.length - MAX_TERMINAL_JOURNALS))) {
      assertPrivateRegularFile(state.journal.path, 'native checkpoint journal')
      rmSync(state.journal.path, { force: false })
      syncPrivateDirectory(this.directory)
    }
    const remaining = states.filter(state => !terminals.some(item => item.journal.checkpointHash === state.journal.checkpointHash
      && terminals.indexOf(item) < Math.max(0, terminals.length - MAX_TERMINAL_JOURNALS)))
    if (remaining.filter(state => state.latest.phase !== 'terminal').length > MAX_NON_TERMINAL_JOURNALS) {
      throw safety('native checkpoint non-terminal journal cap has been reached')
    }
  }

  private load(allowTailTruncate: boolean): JournalState[] {
    // Inspection is deliberately read-only. Mutating callers already hold the
    // writer lease and acquire() has created both directories.
    try {
      lstatSync(this.profileDir)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw safety('native checkpoint profile directory could not be inspected safely', error)
    }
    assertPrivateDirectory(this.profileDir, 'native checkpoint profile directory')
    try {
      lstatSync(this.directory)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw safety('native checkpoint journal directory could not be inspected safely', error)
    }
    assertPrivateDirectory(this.directory, 'native checkpoint journal directory')
    const entries = readdirSync(this.directory, { withFileTypes: true })
    const states: JournalState[] = []
    for (const entry of entries) {
      if (!entry.name.endsWith(JOURNAL_SUFFIX)) {
        throw safety('native checkpoint directory contains an unexpected entry')
      }
      const path = join(this.directory, entry.name)
      if (entry.isSymbolicLink() || !entry.isFile()) throw safety('native checkpoint journal is not a regular file')
      states.push(stateFor(readJournal(path, allowTailTruncate)))
    }
    return states
  }
}

export function createNativeCheckpointStore(
  profileDir: string,
  dependencies: Partial<PrivateWriterLeaseDependencies> = {},
): NativeCheckpointStore {
  return new NativeCheckpointStoreImpl(profileDir, dependencies)
}
