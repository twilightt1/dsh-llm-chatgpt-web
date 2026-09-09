import { describe, expect, it, vi } from 'vitest'
import {
  arbitrateNativeObservation,
  exactConnectorRowIndex,
} from '../src/chatgpt/connector.ts'
import { nativeToolBatchChunks } from '../src/adapter.ts'
import type { NativeBrowserControl } from '../src/chatgpt/connector.ts'
import type { BrokerToolRequest } from '../src/native/types.ts'
import { CallId } from '@deepseek-ai/dsh-llm'

const call: BrokerToolRequest = {
  callId: CallId('call_1'),
  name: 'write',
  arguments: { path: 'x' },
}

function control(overrides: Partial<NativeBrowserControl> = {}): NativeBrowserControl {
  return {
    connectorName: 'DSH Native',
    requestId: 'request_abcdefghijklmnopqrstuvwxyz',
    takeToolBatch: vi.fn(() => undefined),
    beginCompletionFence: vi.fn(() => 1),
    commitCompletionFence: vi.fn(() => true),
    ...overrides,
  }
}

describe('exact ChatGPT connector selection', () => {
  it('requires one exact first-line title', () => {
    expect(exactConnectorRowIndex(['Other', 'DSH Native'], 'DSH Native')).toBe(1)
    expect(() => exactConnectorRowIndex(['DSH Native', 'DSH Native'], 'DSH Native')).toThrow(/duplicate/)
    expect(() => exactConnectorRowIndex(['Other'], 'DSH Native')).toThrow(/no row/)
    expect(exactConnectorRowIndex(['DSH Native\nAdditional details'], 'DSH Native')).toBe(0)
  })
})

describe('native tool chunks', () => {
  it('starts a tool-only broker batch at index zero without an empty text block', () => {
    expect([...nativeToolBatchChunks(12, '', undefined, [call])]).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: CallId('call_1'),
        name: 'write',
        argumentsDelta: '{"path":"x"}',
      },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: CallId('call_1'), name: 'write', arguments: '{"path":"x"}' },
      },
      { type: 'usage', usage: expect.any(Object) },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('closes mixed text before emitting stable broker call ids', () => {
    expect([...nativeToolBatchChunks(12, 'before call', 0, [call])]).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'before call' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 1,
        id: CallId('call_1'),
        name: 'write',
        argumentsDelta: '{"path":"x"}',
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: CallId('call_1'), name: 'write', arguments: '{"path":"x"}' },
      },
      { type: 'usage', usage: expect.any(Object) },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })
})

describe('native observation arbitration', () => {
  it('gives a ready broker batch priority over a DOM completion candidate', () => {
    const native = control({ takeToolBatch: vi.fn(() => [call]) })
    expect(arbitrateNativeObservation(native, { text: 'done', promptChars: 4 })).toEqual({
      kind: 'tool-batch', calls: [call],
    })
    expect(native.beginCompletionFence).not.toHaveBeenCalled()
  })

  it('waits when an activity keeps the broker fence open', () => {
    const native = control({ beginCompletionFence: vi.fn(() => undefined) })
    expect(arbitrateNativeObservation(native, { text: 'done', promptChars: 4 })).toEqual({ kind: 'wait' })
    expect(native.commitCompletionFence).not.toHaveBeenCalled()
  })

  it('refuses a completion whose broker revision changed', () => {
    const native = control({ commitCompletionFence: vi.fn(() => false) })
    expect(arbitrateNativeObservation(native, { text: 'done', promptChars: 4 })).toEqual({ kind: 'wait' })
  })
})
