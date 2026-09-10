import { describe, expect, it } from 'vitest'
import { LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { compilePrompt } from '../src/chatgpt/prompt.ts'
import { COMPOSER_CHAR_BUDGET } from '../src/chatgpt/turn.ts'
import { testCallId } from './call-id.ts'

function userMessage(text: string): Message {
  return {
    id: MessageId('u1'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function baseOptions(messages: Message[]): GenerateOptions {
  return { provider: 'chatgpt-web', model: 'chatgpt-web/high', messages }
}

describe('compilePrompt (JSON envelope transport)', () => {
  it('wraps history in the JSON envelope with role semantics preserved', () => {
    const assistant: Message = {
      id: MessageId('a1'),
      role: 'assistant',
      content: [{ type: 'text', text: 'reading now' }],
      source: { kind: 'model', provider: 'chatgpt-web', model: 'chatgpt-web/high' },
    }
    const prompt = compilePrompt({
      ...baseOptions([userMessage('hello'), assistant, userMessage('and?')]),
      system: 'be brief',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    }, COMPOSER_CHAR_BUDGET)
    // Transport contract present, with the anti-echo rule.
    expect(prompt).toContain('Act as the model backend for the DSH agent task')
    expect(prompt).toContain('NEVER echo or repeat this message')
    // JSON envelope carries the conversation with literal roles.
    const envelopeMatch = /<dsh_context_json>\n([\s\S]*?)\n<\/dsh_context_json>/.exec(prompt)
    expect(envelopeMatch).not.toBeNull()
    const envelope = JSON.parse(envelopeMatch![1]!)
    expect(envelope.system).toBe('be brief')
    expect(envelope.messages).toHaveLength(3)
    expect(envelope.messages[0]).toEqual({ role: 'user', content: 'hello' })
    expect(envelope.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'reading now' }] })
    expect(envelope.messages[2]).toEqual({ role: 'user', content: 'and?' })
    // Tool contract + trailing reminder present.
    expect(prompt).toContain('[Tool use]')
    expect(prompt).toContain('```tool-call')
    const reminderAt = prompt.indexOf('[Reminder]')
    const envelopeAt = prompt.indexOf('<dsh_context_json>')
    expect(reminderAt).toBeGreaterThan(envelopeAt)
  })

  it('renders tool calls and results inside the envelope', () => {
    const assistant: Message = {
      id: MessageId('a1'),
      role: 'assistant',
      content: [{ type: 'tool-call', id: testCallId('call_1'), name: 'read', arguments: '{"path":"x"}' }],
      source: { kind: 'model', provider: 'chatgpt-web', model: 'chatgpt-web/high' },
    }
    const result: Message = {
      id: MessageId('t1'),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: testCallId('call_1'),
        content: [{ type: 'text', text: 'file bytes' }],
      }],
      source: { kind: 'tool', callId: testCallId('call_1') },
    }
    const prompt = compilePrompt(baseOptions([assistant, result]), COMPOSER_CHAR_BUDGET)
    const envelopeMatch = /<dsh_context_json>\n([\s\S]*?)\n<\/dsh_context_json>/.exec(prompt)
    expect(envelopeMatch).not.toBeNull()
    const envelope = JSON.parse(envelopeMatch![1]!)
    expect(envelope.messages[0]).toEqual({
      role: 'assistant',
      content: [{
        type: 'tool_call',
        tool_call_id: 'call_1',
        name: 'read',
        arguments: '{"path":"x"}',
      }],
    })
    expect(envelope.messages[1]).toEqual({
      role: 'tool_result',
      tool_call_id: 'call_1',
      is_error: false,
      content: 'file bytes',
    })
  })

  it('uses the native connector contract without the fenced text protocol', () => {
    const assistant: Message = {
      id: MessageId('a1'),
      role: 'assistant',
      content: [{ type: 'tool-call', id: testCallId('call_1'), name: 'write', arguments: '{"path":"x"}' }],
      source: { kind: 'model', provider: 'chatgpt-web', model: 'chatgpt-web/high' },
    }
    const prompt = compilePrompt({
      ...baseOptions([assistant]),
      tools: [{ name: 'write', description: 'write', parameters: { type: 'object' } }],
    }, COMPOSER_CHAR_BUDGET, undefined, {
      requestId: 'request_abcdefghijklmnopqrstuvwxyz',
      connectorName: 'DSH Native',
    })
    expect(prompt).toContain('dsh_round_start')
    expect(prompt).toContain('request_abcdefghijklmnopqrstuvwxyz')
    expect(prompt).toContain('DSH Native')
    expect(prompt).toContain('If the task asks about a local repository, files, commands, environment, or any other tool-backed fact, you MUST use the connector before answering.')
    expect(prompt).toContain('compact discovery catalog for the complete current inventory')
    expect(prompt).toContain('follow every next_offset page until the match is found')
    expect(prompt).toContain('Request include_schema=true for the exact matched tool before calling it')
    expect(prompt).toContain('Only connector-backed tool results are evidence that an action ran.')
    expect(prompt).toContain('A tool_result in the JSON context means that call already ran; do not repeat the same call.')
    expect(prompt).not.toContain('```tool-call')
    expect(prompt).not.toContain('[Tool use]')

    const textPrompt = compilePrompt({
      ...baseOptions([userMessage('what did I ask?')]),
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    }, COMPOSER_CHAR_BUDGET)
    expect(textPrompt).not.toContain('Only connector-backed tool results are evidence that an action ran.')
    expect(textPrompt).not.toContain('A tool_result in the JSON context means that call already ran; do not repeat the same call.')
    const envelopeMatch = /<dsh_context_json>\n([\s\S]*?)\n<\/dsh_context_json>/.exec(prompt)
    expect(envelopeMatch).not.toBeNull()
    expect(JSON.parse(envelopeMatch![1]!).messages[0]).toEqual({
      role: 'assistant',
      content: [{
        type: 'tool_call',
        tool_call_id: 'call_1',
        name: 'write',
        arguments: '{"path":"x"}',
      }],
    })
    const result: Message = {
      id: MessageId('t1'),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: testCallId('call_1'),
        content: [{ type: 'text', text: 'done' }],
      }],
      source: { kind: 'tool', callId: testCallId('call_1') },
    }
    const continuationPrompt = compilePrompt({
      ...baseOptions([assistant, result]),
      tools: [{ name: 'write', description: 'write', parameters: { type: 'object' } }],
    }, COMPOSER_CHAR_BUDGET, undefined, {
      requestId: 'request_abcdefghijklmnopqrstuvwxyz',
      connectorName: 'DSH Native',
    })
    expect(continuationPrompt).toContain('[Native continuation] The DSH tool call(s) in the JSON context have already been executed.')
    expect(continuationPrompt).not.toContain('If the task asks about a local repository, files, commands, environment, or any other tool-backed fact, you MUST use the connector before answering.')
    expect(continuationPrompt).not.toContain('First call dsh_round_start with request_id request_abcdefghijklmnopqrstuvwxyz.')
    expect(continuationPrompt).toContain('If the original task still needs a tool-backed fact not present in those results')
    expect(continuationPrompt).toContain('compact discovery catalog for the complete current inventory')
    expect(continuationPrompt).toContain('follow every next_offset page until the match is found')
  })

  it('fails loud on unsupported fields instead of dropping them', () => {
    expect(() => compilePrompt(
      { ...baseOptions([userMessage('x')]), reasoningEffort: 'high' as never }, COMPOSER_CHAR_BUDGET,
    )).toThrowError(/reasoning effort/i)
    expect(() => compilePrompt(
      { ...baseOptions([userMessage('x')]), stop: ['END'] }, COMPOSER_CHAR_BUDGET,
    )).toThrowError(/stop/i)
    expect(() => compilePrompt(
      { ...baseOptions([userMessage('x')]), temperature: 0.5 }, COMPOSER_CHAR_BUDGET,
    )).toThrowError(/temperature/i)
  })

  it('rejects image content as unsupported', () => {
    const image = {
      id: MessageId('i1'),
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'a' } }],
      source: { kind: 'user' },
    } as unknown as Message
    expect(() => compilePrompt(baseOptions([image]), COMPOSER_CHAR_BUDGET)).toThrowError(/image/i)
  })

  it('enforces the composer budget with context overflow', () => {
    const big = userMessage('x'.repeat(100))
    try {
      compilePrompt(baseOptions([big]), 10)
      expect.unreachable('expected a context-overflow throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    }
  })

  it('carries the retry notice inside the transport contract', () => {
    const prompt = compilePrompt(baseOptions([userMessage('hi')]), COMPOSER_CHAR_BUDGET, '[System notice] fix the call')
    expect(prompt).toContain('[System notice] fix the call')
    expect(prompt.indexOf('[System notice] fix the call')).toBeLessThan(prompt.indexOf('<dsh_context_json>'))
  })
})
