import { describe, expect, it } from 'vitest'
import { CallId, LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { compilePrompt } from '../src/chatgpt/prompt.ts'
import { COMPOSER_CHAR_BUDGET } from '../src/chatgpt/turn.ts'

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

describe('compilePrompt', () => {
  it('labels system, history, and tools in transcript order', () => {
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
    expect(prompt).toContain('[System]\nbe brief')
    expect(prompt).toContain('[User]\nhello')
    expect(prompt).toContain('[Assistant]\nreading now')
    expect(prompt).toContain('[User]\nand?')
    expect(prompt).toContain('[Tool use]')
    expect(prompt).toContain('```tool-call')
    expect(prompt).toContain('read')
    // Contract (with seed exchange) precedes history; the trailing reminder
    // contains its own [Reminder] label but history still comes before it.
    const historyAt = prompt.indexOf('[User]\nhello')
    const reminderAt = prompt.indexOf('[Reminder]')
    expect(historyAt).toBeGreaterThan(-1)
    expect(historyAt).toBeLessThan(reminderAt)
  })

  it('renders tool calls and results as labeled transcript', () => {
    const assistant: Message = {
      id: MessageId('a1'),
      role: 'assistant',
      content: [{ type: 'tool-call', id: CallId('call_1'), name: 'read', arguments: '{"path":"x"}' }],
      source: { kind: 'model', provider: 'chatgpt-web', model: 'chatgpt-web/high' },
    }
    const result: Message = {
      id: MessageId('t1'),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call_1'),
        content: [{ type: 'text', text: 'file bytes' }],
      }],
      source: { kind: 'tool', callId: CallId('call_1') },
    }
    const prompt = compilePrompt(baseOptions([assistant, result]), COMPOSER_CHAR_BUDGET)
    expect(prompt).toContain('```tool-call\n{"name": "read", "arguments": {"path":"x"}}\n```')
    expect(prompt).toContain('[Tool result]\nfile bytes')
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
})
