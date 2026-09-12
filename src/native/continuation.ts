import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import { canonicalJson, hashCanonical } from './canonical.ts'
import type {
  BrokerToolRequest,
  BrokerToolResult,
  NativeReplayStateV1,
} from './types.ts'

/** Reasons for which a complete canonical fresh request is safe to submit. */
export interface NativeContinuationIdentity {
  readonly policyHash: string
  readonly inventoryHash: string
  readonly approvalHash: string
}

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
  /** Fingerprint of the logical request prefix represented by `request`. */
  readonly requestKey?: string
  readonly policyHash?: string
  readonly inventoryHash?: string
  readonly approvalHash?: string
  readonly request: GenerateOptions
  /** Raw canonical DSH request retained only for durable-result equality proof. */
  readonly canonicalRequest?: GenerateOptions
  /** Canonical DSH assistant calls used for durable-result correlation. */
  readonly canonicalAssistantMessage?: Message
  /** Provider-visible assistant calls used for sanitized continuation matching. */
  readonly assistantMessage: Message
  readonly providerPendingCalls?: readonly BrokerToolRequest[]
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

export type NativeDurableResultEvidenceReason =
  | 'assistant-boundary-missing'
  | 'result-missing'
  | 'result-malformed'
  | 'duplicate-tool-result'
  | 'provider-view-missing'
  | 'provider-view-conflicting'
  | 'result-evidence-conflicting'

export type NativeDurableResultEvidence =
  | { readonly kind: 'proven'; readonly results: readonly BrokerToolResult[] }
  | { readonly kind: 'missing'; readonly reason: NativeDurableResultEvidenceReason }
  | { readonly kind: 'ambiguous'; readonly reason: 'assistant-boundary-ambiguous' }
  | { readonly kind: 'conflicting'; readonly reason: NativeDurableResultEvidenceReason }

export interface NativeDurableResultEvidenceView {
  readonly messages: readonly Message[]
  readonly calls: readonly BrokerToolRequest[]
  readonly matchesAssistant: (message: Message) => boolean
  readonly matchesResult?: (result: BrokerToolResult, index: number) => boolean
}

export interface NativeDurableResultEvidenceInput {
  readonly canonical: NativeDurableResultEvidenceView
  readonly provider?: NativeDurableResultEvidenceView
}

interface CanonicalRecord {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/**
 * Hash the provider-visible request identity. Harness message IDs, session
 * IDs, abort signals, and adapter-private replay metadata are deliberately
 * excluded; the hash is safe to carry as opaque routing state.
 */
function assertContinuationIdentity(identity: NativeContinuationIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`native continuation ${name} identity is invalid`)
    }
  }
}

export function nativeExecutionKey(options: GenerateOptions, identity?: NativeContinuationIdentity): string {
  if (identity === undefined) return hashCanonical('native-execution', 1, requestProjection(options))
  assertContinuationIdentity(identity)
  return hashCanonical('native-execution', 1, {
    request: requestProjection(options),
    identity,
  })
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function freezeEvidence(value: NativeDurableResultEvidence): NativeDurableResultEvidence {
  return deepFreeze(value)
}

function evidenceForView(view: NativeDurableResultEvidenceView): NativeDurableResultEvidence {
  let boundaryIndex: number | undefined
  for (const [index, message] of view.messages.entries()) {
    if (!view.matchesAssistant(message)) continue
    if (boundaryIndex !== undefined) {
      return freezeEvidence({ kind: 'ambiguous', reason: 'assistant-boundary-ambiguous' })
    }
    boundaryIndex = index
  }
  if (boundaryIndex === undefined) {
    return freezeEvidence({ kind: 'missing', reason: 'assistant-boundary-missing' })
  }

  const resultMessages = view.messages.slice(boundaryIndex + 1)
  if (resultMessages.length < view.calls.length) {
    return freezeEvidence({ kind: 'missing', reason: 'result-missing' })
  }
  const results: BrokerToolResult[] = []
  for (const [index, call] of view.calls.entries()) {
    const message = resultMessages[index]
    const result = message === undefined ? undefined : onlyTextResult(message, call)
    if (result === undefined) {
      return freezeEvidence({ kind: 'missing', reason: 'result-malformed' })
    }
    if (view.matchesResult !== undefined && !view.matchesResult(result, index)) {
      return freezeEvidence({ kind: 'conflicting', reason: 'result-evidence-conflicting' })
    }
    results.push(result)
  }

  const extra = resultMessages.slice(view.calls.length)
  if (extra.some(message => message.source.kind === 'tool'
    || message.content.some(block => block.type === 'tool-result'))) {
    return freezeEvidence({ kind: 'conflicting', reason: 'duplicate-tool-result' })
  }
  return freezeEvidence({ kind: 'proven', results })
}

function sameEvidenceCalls(left: readonly BrokerToolRequest[], right: readonly BrokerToolRequest[]): boolean {
  if (left.length !== right.length) return false
  return left.every((call, index) => {
    const other = right[index]
    return other !== undefined
      && String(call.callId) === String(other.callId)
      && call.name === other.name
  })
}

/** Prove exact durable results across canonical and optional provider views. */
export function assessNativeResultEvidence(
  input: NativeDurableResultEvidenceInput,
): NativeDurableResultEvidence {
  const canonical = evidenceForView(input.canonical)
  if (canonical.kind !== 'proven') return canonical
  if (input.provider === undefined) return canonical

  const provider = evidenceForView(input.provider)
  if (provider.kind === 'ambiguous') return provider
  if (provider.kind === 'missing') return freezeEvidence({ kind: 'missing', reason: 'provider-view-missing' })
  if (provider.kind === 'conflicting') return freezeEvidence({ kind: 'conflicting', reason: 'provider-view-conflicting' })
  if (!sameEvidenceCalls(input.canonical.calls, input.provider.calls)
    || provider.results.length !== canonical.results.length
    || provider.results.some((result, index) => result.isError !== canonical.results[index]?.isError)) {
    return freezeEvidence({ kind: 'conflicting', reason: 'result-evidence-conflicting' })
  }
  return freezeEvidence({ kind: 'proven', results: provider.results })
}

/** Correlate one broker batch with its exact text-only DSH result messages. */
export function correlateNativeToolResults(
  messages: readonly Message[],
  calls: readonly BrokerToolRequest[],
): readonly BrokerToolResult[] {
  const pending = new Set<string>()
  for (const call of calls) {
    const key = String(call.callId)
    if (pending.has(key)) throw new Error(`duplicate pending broker call ${key}`)
    pending.add(key)
  }
  const found = new Map<string, BrokerToolResult>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const key = String(block.toolCallId)
      const sourceKey = message.source.kind === 'tool' ? String(message.source.callId) : undefined
      if (sourceKey !== undefined && sourceKey !== key && (pending.has(sourceKey) || pending.has(key))) {
        throw new Error(`mismatched tool result identity for ${key}`)
      }
      if (!pending.has(key)) continue
      if (message.source.kind !== 'tool' || sourceKey !== key || message.content.length !== 1) {
        throw new Error(`malformed tool result identity for ${key}`)
      }
      if (found.has(key)) throw new Error(`duplicate tool result for ${key}`)
      if (contentHasImage(block.content) || block.content.some(item => item.type !== 'text')) {
        throw new Error(`unsupported non-text content in tool result for ${key}`)
      }
      found.set(key, {
        content: structuredClone(block.content),
        isError: block.isError === true,
      })
    }
  }
  return calls.map(call => {
    const key = String(call.callId)
    const result = found.get(key)
    if (result === undefined) throw new Error(`missing tool result for ${key}`)
    return result
  })
}

/** Assess one parked native claim against canonical and optional provider history. */
export function assessNativeClaimResultEvidence(
  claim: ParkedContinuationClaim,
  canonicalOptions: GenerateOptions,
  providerOptions?: GenerateOptions,
): NativeDurableResultEvidence {
  const canonicalAssistant = claim.canonicalAssistantMessage ?? claim.assistantMessage
  const canonical: NativeDurableResultEvidenceView = {
    messages: canonicalOptions.messages,
    calls: claim.pendingCalls,
    matchesAssistant: message => sameMessages([message], [canonicalAssistant])
      && assistantCallsMatch(message, claim.pendingCalls),
  }
  const provider = providerOptions === undefined ? undefined : {
    messages: providerOptions.messages,
    calls: claim.providerPendingCalls ?? claim.pendingCalls,
    matchesAssistant: (message: Message): boolean => sameMessages([message], [claim.assistantMessage])
      && assistantCallsMatch(message, claim.providerPendingCalls ?? claim.pendingCalls),
  }
  return assessNativeResultEvidence({ canonical, ...(provider === undefined ? {} : { provider }) })
}

/**
 * @deprecated Use the continuation-owned durable result evidence evaluator.
 */
export function hasExactNativeToolResults(
  claim: ParkedContinuationClaim,
  options: GenerateOptions,
): boolean {
  return assessNativeClaimResultEvidence(claim, options).kind === 'proven'
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
  identity?: NativeContinuationIdentity,
): NativeContinuationDecision {
  if (!/^[a-f0-9]{64}$/.test(claim.executionKey)) {
    return failure('INVALID_REPLAY_STATE', 'native parked response has an invalid execution identity')
  }
  const claimIdentityFields = [claim.policyHash, claim.inventoryHash, claim.approvalHash]
  const claimIdentityCount = claimIdentityFields.filter(value => value !== undefined).length
  if (claimIdentityCount !== 0 && claimIdentityCount !== claimIdentityFields.length) {
    return failure('INVALID_REPLAY_STATE', 'native parked response has an incomplete policy identity')
  }
  const claimIdentity = claimIdentityCount === 0
    ? undefined
    : {
        policyHash: claim.policyHash!,
        inventoryHash: claim.inventoryHash!,
        approvalHash: claim.approvalHash!,
      }
  if (identity !== undefined && claimIdentity === undefined) {
    return failure('POLICY_MISMATCH', 'native parked response has no matching policy identity')
  }
  if (claimIdentity !== undefined && identity === undefined) {
    return failure('POLICY_MISMATCH', 'native parked response has no matching policy identity')
  }
  if (claimIdentity !== undefined && identity !== undefined
    && (claimIdentity.policyHash !== identity.policyHash
      || claimIdentity.inventoryHash !== identity.inventoryHash
      || claimIdentity.approvalHash !== identity.approvalHash)) {
    return failure('POLICY_MISMATCH', 'native parked response belongs to a different native policy round')
  }
  const requestKey = claim.requestKey ?? nativeExecutionKey(claim.request, claimIdentity)
  if (requestKey !== nativeExecutionKey(claim.request, claimIdentity)) {
    return failure('INVALID_REPLAY_STATE', 'native parked response has an invalid logical request identity')
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
      return claim.durableResults
        ? claim.physicalAvailable
          ? { kind: 'fresh-replay', reason: freshReason }
          : { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
        : failure('UNCERTAIN_OUTCOME', 'native response history changed before durable tool results were proven')
    }
    return failure('HISTORY_MISMATCH', 'native continuation history does not contain the emitted assistant tool-call message')
  }
  if (!assistantCallsMatch(incomingAssistant, claim.providerPendingCalls ?? claim.pendingCalls)) {
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
    return claim.durableResults
      ? claim.physicalAvailable
        ? { kind: 'fresh-replay', reason: extraTailReason(extra) ?? 'context-added' }
        : { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
      : failure('UNCERTAIN_OUTCOME', 'native response has extra history and no durable replay boundary')
  }

  if (freshReason !== undefined) {
    return claim.durableResults
      ? claim.physicalAvailable
        ? { kind: 'fresh-replay', reason: freshReason }
        : { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
      : failure('UNCERTAIN_OUTCOME', 'native response cannot safely replay before durable tool results')
  }
  if (!claim.physicalAvailable) {
    return claim.durableResults
      ? { kind: 'fresh-replay', reason: claim.unavailableReason ?? 'page-lost' }
      : failure('UNCERTAIN_OUTCOME', 'native response was lost before its tool results became durable')
  }
  return { kind: 'continue', results: pendingResults }
}
