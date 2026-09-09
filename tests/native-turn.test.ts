import { describe, expect, it, vi } from 'vitest'

const guardFixtures = vi.hoisted(() => ({
  throwIfRateLimitDialog: vi.fn(async () => {}),
}))
const effortFixtures = vi.hoisted(() => ({
  selectModelEffort: vi.fn(async () => 'High'),
}))

vi.mock('../src/chatgpt/guards.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/chatgpt/guards.ts')>(),
  throwIfRateLimitDialog: guardFixtures.throwIfRateLimitDialog,
}))
vi.mock('../src/chatgpt/effort.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/chatgpt/effort.ts')>(),
  selectModelEffort: effortFixtures.selectModelEffort,
}))

import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  arbitrateNativeObservation,
  exactConnectorRowIndex,
  selectChatGptConnector,
} from '../src/chatgpt/connector.ts'
import { nativeToolBatchChunks } from '../src/adapter.ts'
import { streamTextTurn } from '../src/chatgpt/turn.ts'
import type { NativeBrowserControl } from '../src/chatgpt/connector.ts'
import type { BrokerToolRequest } from '../src/native/types.ts'
import { testCallId } from './call-id.ts'

const call: BrokerToolRequest = {
  callId: testCallId('call_1'),
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

  it('surfaces an existing rate limit before touching connector UI', async () => {
    const rateLimit = new LlmError('wait before retrying', 'RATE_LIMIT')
    guardFixtures.throwIfRateLimitDialog.mockReset()
    guardFixtures.throwIfRateLimitDialog.mockRejectedValueOnce(rateLimit)
    const page = { locator: vi.fn(() => { throw new Error('connector UI was touched') }) }

    await expect(selectChatGptConnector(page as never, 'DSH Native')).rejects.toBe(rateLimit)
    expect(page.locator).not.toHaveBeenCalled()
  })

  it('preserves a rate limit that appears during connector selection', async () => {
    const rateLimit = new LlmError('wait before retrying', 'RATE_LIMIT')
    guardFixtures.throwIfRateLimitDialog.mockReset()
    guardFixtures.throwIfRateLimitDialog
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rateLimit)
    const target = {
      click: vi.fn(async () => { throw new Error('selection blocked') }),
      press: vi.fn(async () => {}),
      pressSequentially: vi.fn(async () => {}),
    }
    const composers = {
      filter: vi.fn().mockReturnThis(),
      count: vi.fn(async () => 1),
      first: vi.fn(() => target),
      nth: vi.fn(() => target),
      evaluateAll: vi.fn(async () => ['DSH Native']),
    }
    const page = { locator: vi.fn(() => composers) }

    await expect(selectChatGptConnector(page as never, 'DSH Native')).rejects.toBe(rateLimit)
    expect(guardFixtures.throwIfRateLimitDialog).toHaveBeenCalledTimes(2)
  })
})

describe('turn preflight', () => {
  it('checks rate limits before model-effort selection', async () => {
    const rateLimit = new LlmError('wait before retrying', 'RATE_LIMIT')
    guardFixtures.throwIfRateLimitDialog.mockReset()
    guardFixtures.throwIfRateLimitDialog.mockRejectedValueOnce(rateLimit)
    effortFixtures.selectModelEffort.mockClear()
    const composer = {
      count: vi.fn(async () => 1),
      nth: vi.fn(() => ({ isVisible: vi.fn(async () => true) })),
    }
    const page = {
      url: vi.fn(() => 'https://chatgpt.com/'),
      locator: vi.fn(() => composer),
    }
    const turn = streamTextTurn(page as never, {
      model: 'chatgpt-web/high',
      prompt: 'hello',
      capabilities: { solAvailable: true, proAvailable: false },
      surface: 'connector',
      turnTimeoutMs: 30_000,
      stallTimeoutMs: 30_000,
    })

    await expect(turn.next()).rejects.toBe(rateLimit)
    expect(effortFixtures.selectModelEffort).not.toHaveBeenCalled()
  })
})

describe('native tool chunks', () => {
  it('starts a tool-only broker batch at index zero without an empty text block', () => {
    expect([...nativeToolBatchChunks(12, '', undefined, [call])]).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: testCallId('call_1'),
        name: 'write',
        argumentsDelta: '{"path":"x"}',
      },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: testCallId('call_1'), name: 'write', arguments: '{"path":"x"}' },
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
        id: testCallId('call_1'),
        name: 'write',
        argumentsDelta: '{"path":"x"}',
      },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: testCallId('call_1'), name: 'write', arguments: '{"path":"x"}' },
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
