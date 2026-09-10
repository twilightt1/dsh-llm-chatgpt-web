import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  decideNativeContinuation,
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

  it('rejects a continuation from another session', () => {
    expect(decideNativeContinuation(
      claim(),
      request({ sessionId: 'session-2' as never, messages: [user, assistant, resultMessage()] }),
    )).toMatchObject({ kind: 'fail', code: expect.stringMatching(/session/i) })
  })
})
