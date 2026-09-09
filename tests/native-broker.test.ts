import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { NativeToolBroker } from '../src/native/broker.ts'
import type { BrokerToolResult } from '../src/native/types.ts'

const tool: ToolSchema = {
  name: 'write',
  description: 'write a file',
  parameters: { type: 'object' },
}
const ok: BrokerToolResult = {
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
}
const activityId = 'activity_abcdefghijklmnop'

afterEach(() => {
  vi.useRealTimers()
})

describe('NativeToolBroker', () => {
  it('requires idempotent start before claims and freezes tools', () => {
    const broker = new NativeToolBroker()
    const tools = [tool]
    const requestId = broker.register({
      sessionId: 's1', tools, invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    tools[0] = { ...tool, name: 'mutated' }
    expect(() => broker.claimActivity(requestId, activityId)).toThrow(/start/i)
    expect(broker.start(requestId)).toEqual({ started: true, duplicate: false })
    expect(broker.start(requestId)).toEqual({ started: true, duplicate: true })
    expect(broker.claimActivity(requestId, activityId).tools[0]?.name).toBe('write')
    broker.close()
  })

  it('batches in order and redelivers stable call ids until settlement', async () => {
    vi.useFakeTimers()
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    const first = broker.invoke(requestId, activityId, 'write', { path: 'a' })
    const second = broker.invoke(requestId, activityId, 'write', { path: 'b' })
    await vi.advanceTimersByTimeAsync(15)
    const batch = broker.takeToolBatch(requestId)
    expect(batch?.map(call => call.arguments.path)).toEqual(['a', 'b'])
    expect(batch?.every(call => /^call_[A-Za-z0-9_-]{32}$/.test(String(call.callId)))).toBe(true)
    expect(broker.takeToolBatch(requestId)).toEqual(batch)
    broker.beginSettlement(requestId)
    broker.completeTool(requestId, batch![0]!.callId, ok)
    broker.completeTool(requestId, batch![1]!.callId, ok)
    expect(await Promise.all([first, second])).toEqual([ok, ok])
    expect(() => broker.completeTool(requestId, batch![0]!.callId, ok)).not.toThrow()
    expect(() => broker.completeTool(requestId, batch![0]!.callId, {
      content: [{ type: 'text', text: 'different' }], isError: false,
    })).toThrow(/conflict/i)
    broker.close()
  })

  it('fences completion and rejects new calls during settlement', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    const cleanRevision = broker.beginCompletionFence(requestId)
    expect(cleanRevision).toBeTypeOf('number')
    broker.claimActivity(requestId, activityId)
    expect(broker.commitCompletionFence(requestId, cleanRevision!)).toBe(false)
    broker.beginSettlement(requestId)
    await expect(broker.invoke(
      requestId, activityId, 'write', { path: 'x' },
    )).rejects.toThrow(/settling/i)
    expect(() => broker.completeActivity(requestId, activityId)).not.toThrow()
    broker.close()
  })

  it('revokes waiters and expires without another operation', async () => {
    vi.useFakeTimers()
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 20,
    })
    const retired = broker.waitForRetirement(requestId)
    await vi.advanceTimersByTimeAsync(20)
    await expect(retired).resolves.toBeUndefined()
    expect(() => broker.start(requestId)).toThrow(/expired|revoked/i)
    broker.close()
  })

  it('rejects pending invocation and quiescence waits on revoke', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    const invocation = expect(broker.invoke(
      requestId, activityId, 'write', { path: 'x' },
    )).rejects.toThrow('cancelled by test')
    const quiescence = expect(broker.waitForQuiescence(requestId)).rejects.toThrow('cancelled by test')
    broker.revoke(requestId, new Error('cancelled by test'))
    await Promise.all([invocation, quiescence])
  })

  it('rejects unknown tools without queueing a request', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    await expect(broker.invoke(requestId, activityId, 'read', {})).rejects.toThrow(/not advertised/i)
    expect(broker.takeToolBatch(requestId, Date.now() + 100)).toBeUndefined()
    broker.close()
  })

  it('makes result completion idempotent after the pending promise settles', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    const invocation = broker.invoke(requestId, activityId, 'write', { path: 'x' })
    const batch = broker.takeToolBatch(requestId, Date.now() + 100)
    broker.completeTool(requestId, ToolCallId(String(batch?.[0]?.callId)), ok)
    await expect(invocation).resolves.toEqual(ok)
    expect(() => broker.completeTool(requestId, ToolCallId(String(batch?.[0]?.callId)), ok)).not.toThrow()
    broker.close()
  })
})
