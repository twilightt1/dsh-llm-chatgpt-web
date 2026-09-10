import { createHash } from 'node:crypto'
import type { GenerateOptions, Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type {
  BrokerToolRequest,
  BrokerToolResult,
  NativeReplayStateV1,
} from './types.ts'

/** Reasons for which a complete canonical fresh request is safe to submit. */
export type NativeFreshReplayReason =
  | 'context-added'
  | 'steering'
  | 'schema-changed'
  | 'model-changed'
  | 'generation-options-changed'
  | 'process-restart'
  | 'page-lost'

/** State held by an adapter while a physical native response is parked. */
export interface ParkedContinuationClaim {
  readonly sessionId: string
  readonly executionKey: string
  readonly request: GenerateOptions
  readonly assistantMessage: Message
  readonly pendingCalls: readonly BrokerToolRequest[]
  readonly physicalAvailable: boolean
  readonly durableResults: boolean
  readonly uncertainOutcome: boolean
  readonly unavailableReason?: 'page-lost' | 'process-restart'
}

/** Result of deciding whether a DSH request can resume a parked response. */
export type NativeContinuationDecision =
  | { readonly kind: 'continue'; readonly results: readonly BrokerToolResult[] }
  | { readonly kind: 'fresh-replay'; readonly reason: NativeFreshReplayReason }
  | { readonly kind: 'fail'; readonly code: string; readonly message: string }

interface CanonicalRecord {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Serialize JSON-shaped values with stable object-key ordering. Undefined
 * object fields are omitted in the same way as JSON.stringify; undefined
 * array entries become null. Native request inputs are JSON-shaped by the LLM
 * contract, but rejecting unsupported values keeps the fingerprint honest.
 */
function canonicalJson(value: unknown): string {
  const normalize = (input: unknown, inArray = false): unknown => {
    if (input === undefined) return inArray ? null : undefined
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('native execution identity cannot contain a non-finite number')
      return input
    }
    if (typeof input !== 'object') throw new TypeError('native execution identity contains a non-JSON value')
    if (Array.isArray(input)) return input.map(item => normalize(item, true))
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) {
      const child = normalize((input as Record<string, unknown>)[key])
      if (child !== undefined) result[key] = child
    }
    return result
  }
  const normalized = normalize(value)
  const serialized = JSON.stringify(normalized)
  if (serialized === undefined) return 'undefined'
  return serialized
}

function messageProjection(message: Message): CanonicalRecord {
  const source = Object.fromEntries(
    Object.entries(message.source).filter(([key]) => key !== 'replayState'),
  )
  return {
    role: message.role,
    content: message.content,
    source,
  }
}

function requestProjection(options: GenerateOptions): CanonicalRecord {
  return {
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    system: options.system,
    messages: options.messages.map(messageProjection),
    tools: options.tools,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    stop: options.stop,
    purpose: options.purpose,
  }
}

function generationProjection(options: GenerateOptions): CanonicalRecord {
  return {
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    stop: options.stop,
    purpose: options.purpose,
  }
}

function toolProjection(options: GenerateOptions): unknown {
  return options.tools
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Hash the provider-visible request identity. Harness message IDs, session
 * IDs, abort signals, and adapter-private replay metadata are deliberately
 * excluded; the hash is safe to carry as opaque routing state.
 */
export function nativeExecutionKey(options: GenerateOptions): string {
  return hash(requestProjection(options))
}

function assertReplayArguments(executionKey: string, boundary: number, callIds: readonly string[]): void {
  if (!/^[a-f0-9]{64}$/.test(executionKey)) throw new Error('native replay execution key is invalid')
  if (!Number.isSafeInteger(boundary) || boundary < 1) throw new Error('native replay boundary is invalid')
  if (callIds.some(callId => typeof callId !== 'string' || callId.length === 0 || callId.length > 256)) {
    throw new Error('native replay call id is invalid')
  }
  if (new Set(callIds).size !== callIds.length) throw new Error('native replay call ids are duplicated')
}

/** Build the opaque replay envelope stored on a native assistant message. */
export function nativeReplayState(
  executionKey: string,
  boundary: number,
  callIds: readonly NativeReplayStateV1['callIds'][number][],
): ReplayEnvelope {
  assertReplayArguments(executionKey, boundary, callIds)
  const response: NativeReplayStateV1 = Object.freeze({
    kind: 'chatgpt-web-native',
    version: 1,
    executionKey,
    boundary,
    callIds: Object.freeze([...callIds]),
  })
  return Object.freeze({ response })
}

/** Parse either a full LLM replay envelope or its adapter response payload. */
export function parseNativeReplayState(value: unknown): NativeReplayStateV1 | undefined {
  if (!isRecord(value)) return undefined
  const candidate = isRecord(value.response) ? value.response : value
  if (candidate.kind !== 'chatgpt-web-native' || candidate.version !== 1) return undefined
  const executionKey = candidate.executionKey
  const boundary = candidate.boundary
  const callIds = candidate.callIds
  if (typeof executionKey !== 'string' || typeof boundary !== 'number' || !Number.isSafeInteger(boundary)
    || boundary < 1 || !Array.isArray(callIds)) return undefined
  if (callIds.some(callId => typeof callId !== 'string' || callId.length === 0 || callId.length > 256)) return undefined
  if (new Set(callIds).size !== callIds.length) return undefined
  if (!/^[a-f0-9]{64}$/.test(executionKey)) return undefined
  return {
    kind: 'chatgpt-web-native',
    version: 1,
    executionKey,
    boundary,
    callIds: [...callIds] as NativeReplayStateV1['callIds'],
  }
}

function sameMessages(left: readonly Message[], right: readonly Message[]): boolean {
  if (left.length !== right.length) return false
  return canonicalJson(left.map(messageProjection)) === canonicalJson(right.map(messageProjection))
}

function sameRequestPart(left: GenerateOptions, right: GenerateOptions, part: 'provider' | 'model' | 'system' | 'tools' | 'generation'): boolean {
  switch (part) {
    case 'provider': return left.provider === right.provider
    case 'model': return left.model === right.model
    case 'system': return canonicalJson(left.system) === canonicalJson(right.system)
    case 'tools': return canonicalJson(toolProjection(left)) === canonicalJson(toolProjection(right))
    case 'generation': return canonicalJson(generationProjection(left)) === canonicalJson(generationProjection(right))
  }
}

function failure(code: string, message: string): NativeContinuationDecision {
  return { kind: 'fail', code, message }
}

function onlyTextResult(message: Message, call: BrokerToolRequest): BrokerToolResult | undefined {
  if (message.role !== 'user' || message.source.kind !== 'tool'
    || String(message.source.callId) !== String(call.callId) || message.content.length !== 1) return undefined
  const block = message.content[0]
  if (block?.type !== 'tool-result' || String(block.toolCallId) !== String(call.callId)) return undefined
  if (block.content.some(content => content.type !== 'text')) return undefined
  return {
    content: structuredClone(block.content),
    isError: block.isError === true,
  }
}

function assistantCallsMatch(message: Message, calls: readonly BrokerToolRequest[]): boolean {
  const blocks = message.content.filter(block => block.type === 'tool-call')
  if (blocks.length !== calls.length) return false
  return blocks.every((block, index) => {
    if (block.type !== 'tool-call') return false
    const call = calls[index]
    return call !== undefined
      && String(block.id) === String(call.callId)
      && block.name === call.name
      && block.arguments === JSON.stringify(call.arguments)
  })
}

function extraTailReason(messages: readonly Message[]): NativeFreshReplayReason | undefined {
  if (messages.some(message => message.source.kind === 'user')) return 'steering'
  return messages.length > 0 ? 'context-added' : undefined
}

/**
 * Decide whether the next DSH request is the exact result-bearing continuation
 * of a parked native response. This function is pure: it never touches the
 * browser, broker, filesystem, or network.
 */
export function decideNativeContinuation(
  claim: ParkedContinuationClaim,
  options: GenerateOptions,
): NativeContinuationDecision {
  if (claim.executionKey !== nativeExecutionKey(claim.request)) {
    return failure('INVALID_REPLAY_STATE', 'native parked response has an invalid execution identity')
  }
  if (String(options.sessionId ?? '') !== claim.sessionId) {
    return failure('SESSION_MISMATCH', 'native parked response belongs to a different DSH session')
  }
  if (!sameRequestPart(claim.request, options, 'provider')) {
    return failure('PROVIDER_MISMATCH', 'native parked response belongs to a different provider route')
  }
  if (claim.uncertainOutcome) {
    return failure('UNCERTAIN_OUTCOME', 'native response outcome is uncertain; refusing to resubmit a possible side effect')
  }

  let freshReason: NativeFreshReplayReason | undefined
  if (!sameRequestPart(claim.request, options, 'model')) freshReason = 'model-changed'
  else if (!sameRequestPart(claim.request, options, 'tools')) freshReason = 'schema-changed'
  else if (!sameRequestPart(claim.request, options, 'generation')) freshReason = 'generation-options-changed'
  else if (!sameRequestPart(claim.request, options, 'system')) freshReason = 'context-added'

  const baseLength = claim.request.messages.length
  const incomingPrefix = options.messages.slice(0, baseLength)
  if (!sameMessages(incomingPrefix, claim.request.messages)) {
    freshReason ??= 'context-added'
  }

  const expectedAssistantIndex = baseLength
  const incomingAssistant = options.messages[expectedAssistantIndex]
  if (incomingAssistant === undefined || !sameMessages([incomingAssistant], [claim.assistantMessage])) {
    if (freshReason !== undefined) {
      return claim.physicalAvailable
        ? { kind: 'fresh-replay', reason: freshReason }
        : claim.durableResults
          ? { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
          : failure('UNCERTAIN_OUTCOME', 'native response history changed before durable tool results were proven')
    }
    return failure('HISTORY_MISMATCH', 'native continuation history does not contain the emitted assistant tool-call message')
  }
  if (!assistantCallsMatch(incomingAssistant, claim.pendingCalls)) {
    return failure('CALL_MISMATCH', 'native continuation assistant tool calls do not match the parked broker calls')
  }

  const resultMessages = options.messages.slice(expectedAssistantIndex + 1)
  if (resultMessages.length < claim.pendingCalls.length) {
    return failure('MISSING_TOOL_RESULT', 'native continuation is missing one or more durable tool results')
  }
  const pendingResults: BrokerToolResult[] = []
  for (const [index, call] of claim.pendingCalls.entries()) {
    const message = resultMessages[index]
    const result = message === undefined ? undefined : onlyTextResult(message, call)
    if (result === undefined) {
      return failure(
        resultMessages[index]?.source.kind === 'tool' ? 'TOOL_RESULT_MISMATCH' : 'MISSING_TOOL_RESULT',
        `native continuation tool result does not exactly correlate with ${String(call.callId)}`,
      )
    }
    pendingResults.push(result)
  }

  const extra = resultMessages.slice(claim.pendingCalls.length)
  if (extra.length > 0) {
    // A second tool-result-shaped message is not new context: it is a
    // duplicate/conflicting delivery and must never trigger a replay.
    if (extra.some(message => message.source.kind === 'tool'
      || message.content.some(block => block.type === 'tool-result'))) {
      return failure('DUPLICATE_TOOL_RESULT', 'native continuation contains an extra tool result for the parked batch')
    }
    return claim.physicalAvailable
      ? { kind: 'fresh-replay', reason: extraTailReason(extra) ?? 'context-added' }
      : claim.durableResults
        ? { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
        : failure('UNCERTAIN_OUTCOME', 'native response has extra history and no durable replay boundary')
  }

  if (freshReason !== undefined) {
    return claim.physicalAvailable
      ? { kind: 'fresh-replay', reason: freshReason }
      : claim.durableResults
        ? { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
        : failure('UNCERTAIN_OUTCOME', 'native response cannot safely replay before durable tool results')
  }
  if (!claim.physicalAvailable) {
    return claim.durableResults
      ? { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
      : failure('UNCERTAIN_OUTCOME', 'native response was lost before its tool results became durable')
  }
  return { kind: 'continue', results: pendingResults }
}
