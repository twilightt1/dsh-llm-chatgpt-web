import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  assessNativeResultEvidence,
  correlateNativeToolResults,
  decideNativeContinuation,
  hasExactNativeToolResults,
  nativeExecutionKey,
  nativeReplayState,
  parseNativeReplayState,
} from '../src/native/continuation.ts'
import type { ParkedContinuationClaim } from '../src/native/continuation.ts'
import type { BrokerToolRequest } from '../src/native/types.ts'
import { testCallId } from './call-id.ts'

const tool: ToolSchema = {
  name: 'write',
  description: 'write a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

const user: Message = {
  id: MessageId('user-1'),
  role: 'user',
  content: [{ type: 'text', text: 'do the work' }],
  source: { kind: 'user' },
}

const call: BrokerToolRequest = {
  callId: testCallId('call_00000000000000000000000000000001'),
  name: 'write',
  arguments: { path: 'x' },
}

const assistant: Message = {
  id: MessageId('assistant-1'),
  role: 'assistant',
  content: [
    { type: 'text', text: 'I will do that.' },
    { type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) },
  ],
  source: { kind: 'model', provider: 'chatgpt-web', model: 'chatgpt-web/high' },
}

function resultMessage(text = 'done', isError = false): Message {
  return {
    id: MessageId(`result-${text}-${isError ? 'error' : 'ok'}`),
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: call.callId,
      content: [{ type: 'text', text }],
      isError,
    }],
    source: { kind: 'tool', callId: call.callId },
  }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'chatgpt-web',
    model: 'chatgpt-web/high',
    system: 'system prompt',
    messages: [user],
    tools: [tool],
    temperature: 0.2,
    maxTokens: 512,
    stop: ['<done>'],
    sessionId: 'session-1' as never,
    ...overrides,
  }
}

function claim(overrides: Partial<ParkedContinuationClaim> = {}): ParkedContinuationClaim {
  const base = request()
  return {
    sessionId: 'session-1',
    executionKey: nativeExecutionKey(base),
    request: base,
    assistantMessage: assistant,
    pendingCalls: [call],
    physicalAvailable: true,
    durableResults: true,
    uncertainOutcome: false,
    ...overrides,
  }
}

describe('native execution identity', () => {
  it('creates a stable non-secret execution key while ignoring message ids and replay metadata', () => {
    const first = nativeExecutionKey(request())
    const second = nativeExecutionKey(request({
      messages: [{ ...user, id: MessageId('different-message-id') }],
    }))
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('request_')
    expect(first).not.toContain('conversation')

    expect(nativeExecutionKey(request({ model: 'chatgpt-web/light' }))).not.toBe(first)
    expect(nativeExecutionKey(request({ system: 'different system' }))).not.toBe(first)
    expect(nativeExecutionKey(request({ tools: [{ ...tool, description: 'changed' }] }))).not.toBe(first)
    expect(nativeExecutionKey(request({ temperature: 0.8 }))).not.toBe(first)
    expect(nativeExecutionKey(request({ maxTokens: 513 }))).not.toBe(first)
    expect(nativeExecutionKey(request({ stop: ['different'] }))).not.toBe(first)
  })

  it('binds provider and canonical continuation views to policy identity', () => {
    const identity = { policyHash: 'a'.repeat(64), inventoryHash: 'b'.repeat(64), approvalHash: 'c'.repeat(64) }
    const canonicalCall: BrokerToolRequest = { ...call, arguments: { path: '/workspace/x' } }
    const canonicalAssistant: Message = {
      ...assistant,
      content: [{ type: 'tool-call', id: canonicalCall.callId, name: canonicalCall.name, arguments: JSON.stringify(canonicalCall.arguments) }],
    }
    const providerAssistant: Message = {
      ...canonicalAssistant,
      content: [{ type: 'tool-call', id: canonicalCall.callId, name: canonicalCall.name, arguments: JSON.stringify({ path: 'x' }) }],
    }
    const canonical = request({ messages: [user] })
    const provider = request({ messages: [user] })
    const parked: ParkedContinuationClaim = {
      sessionId: 'session-1',
      executionKey: nativeExecutionKey(provider, identity),
      requestKey: nativeExecutionKey(provider, identity),
      policyHash: identity.policyHash,
      inventoryHash: identity.inventoryHash,
      approvalHash: identity.approvalHash,
      request: provider,
      canonicalRequest: canonical,
      assistantMessage: providerAssistant,
      canonicalAssistantMessage: canonicalAssistant,
      providerPendingCalls: [{ ...canonicalCall, arguments: { path: 'x' } }],
      pendingCalls: [canonicalCall],
      physicalAvailable: true,
      durableResults: false,
      uncertainOutcome: false,
    }
    const providerResult = resultMessage()
    const canonicalResult = resultMessage()
    expect(decideNativeContinuation(parked, provider, identity)).toMatchObject({ kind: 'fail' })
    expect(decideNativeContinuation(parked, { ...provider, messages: [user, providerAssistant, providerResult] }, identity))
      .toEqual({ kind: 'continue', results: [{ content: [{ type: 'text', text: 'done' }], isError: false }] })
    expect(hasExactNativeToolResults(parked, { ...canonical, messages: [user, canonicalAssistant, canonicalResult] })).toBe(true)
    expect(decideNativeContinuation(parked, { ...provider, messages: [user, providerAssistant, providerResult] }, { ...identity, approvalHash: 'd'.repeat(64) }))
      .toMatchObject({ kind: 'fail', code: 'POLICY_MISMATCH' })
  })

  it('round-trips only the versioned replay envelope', () => {
    const envelope = nativeReplayState(
      'a'.repeat(64),
      1,
      [testCallId('call_00000000000000000000000000000001')],
    )
    expect(parseNativeReplayState(envelope)).toEqual({
      kind: 'chatgpt-web-native',
      version: 1,
      executionKey: 'a'.repeat(64),
      boundary: 1,
      callIds: [testCallId('call_00000000000000000000000000000001')],
    })
    expect(JSON.stringify(envelope)).not.toContain('capability')
    expect(JSON.stringify(envelope)).not.toContain('cookie')
    expect(JSON.stringify(envelope)).not.toContain('conversation-id')
  })

  it('rejects malformed, foreign, duplicate, and unsafe replay state', () => {
    expect(parseNativeReplayState(undefined)).toBeUndefined()
    expect(parseNativeReplayState({ response: { kind: 'other', version: 1 } })).toBeUndefined()
    expect(parseNativeReplayState({ response: { kind: 'chatgpt-web-native', version: 2 } })).toBeUndefined()
    expect(parseNativeReplayState({
      response: {
        kind: 'chatgpt-web-native', version: 1, executionKey: 'bad', boundary: 1, callIds: [],
      },
    })).toBeUndefined()
    expect(parseNativeReplayState({
      response: {
        kind: 'chatgpt-web-native',
        version: 1,
        executionKey: 'a'.repeat(64),
        boundary: 1,
        callIds: [call.callId, call.callId],
      },
    })).toBeUndefined()
    expect(parseNativeReplayState({
      response: {
        kind: 'chatgpt-web-native',
        version: 1,
        executionKey: 'a'.repeat(64),
        boundary: -1,
        callIds: [],
      },
    })).toBeUndefined()
  })
})

describe('native result correlation', () => {
  it('correlates exact text-only results in pending-call order', () => {
    expect(correlateNativeToolResults([resultMessage()], [call])).toEqual([
      { content: [{ type: 'text', text: 'done' }], isError: false },
    ])
  })
})

describe('native durable result evidence', () => {
  it('returns proven evidence with provider-facing cloned results', () => {
    const evidence = assessNativeResultEvidence({
      canonical: {
        messages: [user, assistant, resultMessage()],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
      provider: {
        messages: [user, assistant, resultMessage()],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
    })

    expect(evidence).toEqual({
      kind: 'proven',
      results: [{ content: [{ type: 'text', text: 'done' }], isError: false }],
    })
    if (evidence.kind !== 'proven') throw new Error('expected proven evidence')
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence.results)).toBe(true)
    expect(Object.isFrozen(evidence.results[0])).toBe(true)
  })

  it('returns ambiguous evidence when two boundaries match', () => {
    const evidence = assessNativeResultEvidence({
      canonical: {
        messages: [assistant, resultMessage(), assistant, resultMessage()],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
    })

    expect(evidence).toMatchObject({ kind: 'ambiguous' })
  })

  it('returns conflicting evidence for an extra tool-result tail', () => {
    const evidence = assessNativeResultEvidence({
      canonical: {
        messages: [assistant, resultMessage(), resultMessage('duplicate')],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
    })

    expect(evidence).toMatchObject({ kind: 'conflicting' })
  })

  it('returns provider-facing results when canonical content is projected', () => {
    const evidence = assessNativeResultEvidence({
      canonical: {
        messages: [assistant, resultMessage('raw output')],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
      provider: {
        messages: [assistant, resultMessage('sanitized output')],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
    })

    expect(evidence).toEqual({
      kind: 'proven',
      results: [{ content: [{ type: 'text', text: 'sanitized output' }], isError: false }],
    })
  })

  it('returns conflicting evidence when canonical and provider error flags differ', () => {
    const evidence = assessNativeResultEvidence({
      canonical: {
        messages: [assistant, resultMessage('raw output')],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
      provider: {
        messages: [assistant, resultMessage('sanitized output', true)],
        calls: [call],
        matchesAssistant: message => message === assistant,
      },
    })

    expect(evidence).toMatchObject({ kind: 'conflicting', reason: 'result-evidence-conflicting' })
  })
})

describe('decideNativeContinuation', () => {
  it('continues with exact tool results from the appended history tail', () => {
    const decision = decideNativeContinuation(claim(), request({ messages: [user, assistant, resultMessage()] }))
    expect(decision).toEqual({
      kind: 'continue',
      results: [{ content: [{ type: 'text', text: 'done' }], isError: false }],
    })
  })

  it('preserves tool errors as model-facing error results', () => {
    const decision = decideNativeContinuation(
      claim(),
      request({ messages: [user, assistant, resultMessage('failed', true)] }),
    )
    expect(decision).toEqual({
      kind: 'continue',
      results: [{ content: [{ type: 'text', text: 'failed' }], isError: true }],
    })
  })

  it('rejects missing, duplicate, conflicting, and malformed results without guessing', () => {
    const base = [user, assistant]
    expect(decideNativeContinuation(claim(), request({ messages: base }))).toMatchObject({ kind: 'fail' })
    expect(decideNativeContinuation(
      claim(), request({ messages: [...base, resultMessage('one'), resultMessage('two')] }),
    )).toMatchObject({ kind: 'fail' })
    expect(decideNativeContinuation(
      claim(), request({ messages: [...base, { ...resultMessage(), source: { kind: 'user' } }] }),
    )).toMatchObject({ kind: 'fail' })
    expect(decideNativeContinuation(
      claim(), request({ messages: [...base, {
        ...resultMessage(),
        content: [{
          type: 'tool-result',
          toolCallId: testCallId('call_00000000000000000000000000000002'),
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        }],
      }] }),
    )).toMatchObject({ kind: 'fail' })
  })

  it('treats exact current results as durable when older tool history was pruned', () => {
    const priorCall: BrokerToolRequest = {
      callId: testCallId('call_00000000000000000000000000000002'),
      name: 'write',
      arguments: { path: 'older' },
    }
    const priorAssistant: Message = {
      ...assistant,
      id: MessageId('prior-assistant'),
      content: [{
        type: 'tool-call',
        id: priorCall.callId,
        name: priorCall.name,
        arguments: JSON.stringify(priorCall.arguments),
      }],
    }
    const priorResult: Message = {
      id: MessageId('prior-result'),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: priorCall.callId,
        content: [{ type: 'text', text: 'large original output' }],
        isError: false,
      }],
      source: { kind: 'tool', callId: priorCall.callId },
    }
    const prunedPriorResult: Message = {
      ...priorResult,
      content: [{
        type: 'tool-result',
        toolCallId: priorCall.callId,
        content: [{ type: 'text', text: '[older tool output pruned]' }],
        isError: false,
      }],
    }
    const base = request({ messages: [user, priorAssistant, priorResult] })
    const parked = claim({
      executionKey: nativeExecutionKey(base),
      request: base,
      canonicalRequest: base,
      canonicalAssistantMessage: assistant,
      durableResults: false,
    })
    const incoming = request({
      messages: [user, priorAssistant, prunedPriorResult, assistant, resultMessage()],
    })

    const durableResults = hasExactNativeToolResults(parked, incoming)

    expect(durableResults).toBe(true)
    expect(decideNativeContinuation({ ...parked, durableResults }, incoming))
      .toEqual({ kind: 'fresh-replay', reason: 'context-added' })
  })

  it('treats exact current results as durable when compaction replaces older history with a summary', () => {
    const priorCall: BrokerToolRequest = {
      callId: testCallId('call_00000000000000000000000000000003'),
      name: 'write',
      arguments: { path: 'older' },
    }
    const priorAssistant: Message = {
      ...assistant,
      id: MessageId('compacted-prior-assistant'),
      content: [{
        type: 'tool-call',
        id: priorCall.callId,
        name: priorCall.name,
        arguments: JSON.stringify(priorCall.arguments),
      }],
    }
    const priorResult: Message = {
      id: MessageId('compacted-prior-result'),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: priorCall.callId,
        content: [{ type: 'text', text: 'large original output' }],
        isError: false,
      }],
      source: { kind: 'tool', callId: priorCall.callId },
    }
    const retainedContext: Message = {
      id: MessageId('retained-context'),
      role: 'user',
      content: [{ type: 'text', text: 'recent context retained verbatim' }],
      source: { kind: 'plugin', plugin: 'test-context' },
    }
    const summary: Message = {
      id: MessageId('compaction-summary'),
      role: 'user',
      content: [{ type: 'text', text: 'summary of the replaced older span' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }
    const base = request({ messages: [user, priorAssistant, priorResult, retainedContext] })
    const parked = claim({
      executionKey: nativeExecutionKey(base),
      request: base,
      canonicalRequest: base,
      canonicalAssistantMessage: assistant,
      durableResults: false,
    })
    const incoming = request({
      messages: [summary, retainedContext, assistant, resultMessage()],
    })

    const durableResults = hasExactNativeToolResults(parked, incoming)

    expect(durableResults).toBe(true)
    expect(decideNativeContinuation({ ...parked, durableResults }, incoming))
      .toEqual({ kind: 'fresh-replay', reason: 'context-added' })
  })

  it('refuses durability proof when compaction leaves duplicate matching boundaries', () => {
    const base = request()
    const parked = claim({
      executionKey: nativeExecutionKey(base),
      request: base,
      canonicalRequest: base,
      canonicalAssistantMessage: assistant,
      durableResults: false,
    })
    const incoming = request({
      messages: [assistant, resultMessage(), assistant, resultMessage()],
    })

    expect(hasExactNativeToolResults(parked, incoming)).toBe(false)
    expect(decideNativeContinuation(parked, incoming))
      .toMatchObject({ kind: 'fail', code: 'UNCERTAIN_OUTCOME' })
  })

  it('selects typed fresh replay for model, schema, generation, and context changes', () => {
    expect(decideNativeContinuation(claim(), request({ model: 'chatgpt-web/light', messages: [user, assistant, resultMessage()] })))
      .toEqual({ kind: 'fresh-replay', reason: 'model-changed' })
    expect(decideNativeContinuation(claim(), request({ tools: [{ ...tool, description: 'new' }], messages: [user, assistant, resultMessage()] })))
      .toEqual({ kind: 'fresh-replay', reason: 'schema-changed' })
    expect(decideNativeContinuation(claim(), request({ temperature: 0.9, messages: [user, assistant, resultMessage()] })))
      .toEqual({ kind: 'fresh-replay', reason: 'generation-options-changed' })
    expect(decideNativeContinuation(claim(), request({ system: 'new context', messages: [user, assistant, resultMessage()] })))
      .toEqual({ kind: 'fresh-replay', reason: 'context-added' })
    expect(decideNativeContinuation(claim(), request({ messages: [user, assistant, resultMessage(), {
      ...user,
      id: MessageId('steering'),
      content: [{ type: 'text', text: 'steer' }],
    }] }))).toEqual({ kind: 'fresh-replay', reason: 'steering' })
  })

  it('refuses fresh replay when a parked side effect has no exact durable results', () => {
    expect(decideNativeContinuation(
      claim({ durableResults: false }),
      request({ model: 'chatgpt-web/light' }),
    )).toMatchObject({ kind: 'fail', code: 'UNCERTAIN_OUTCOME' })
    expect(decideNativeContinuation(
      claim({ durableResults: false }),
      request({ messages: [user, assistant] }),
    )).toMatchObject({ kind: 'fail' })
  })

  it('allows page-loss replay only after durable results and rejects uncertain outcomes', () => {
    expect(decideNativeContinuation(
      claim({ physicalAvailable: false }),
      request({ messages: [user, assistant, resultMessage()] }),
    )).toEqual({ kind: 'fresh-replay', reason: 'page-lost' })
    expect(decideNativeContinuation(
      claim({ physicalAvailable: false, durableResults: false }),
      request({ messages: [user, assistant, resultMessage()] }),
    )).toMatchObject({ kind: 'fail' })
    expect(decideNativeContinuation(
      claim({ uncertainOutcome: true }),
      request({ messages: [user, assistant, resultMessage()] }),
    )).toMatchObject({ kind: 'fail' })
  })

  it('rejects a continuation with an invalid physical execution identity', () => {
    expect(decideNativeContinuation(
      claim({ executionKey: 'not-a-key' }),
      request({ messages: [user, assistant, resultMessage()] }),
    )).toMatchObject({ kind: 'fail', code: 'INVALID_REPLAY_STATE' })
  })

  it('rejects a continuation from another session', () => {
    expect(decideNativeContinuation(
      claim(),
      request({ sessionId: 'session-2' as never, messages: [user, assistant, resultMessage()] }),
    )).toMatchObject({ kind: 'fail', code: expect.stringMatching(/session/i) })
  })
})
