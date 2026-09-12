import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { NativeToolBroker } from '../src/native/broker.ts'
import type {
  BrokerToolResult,
  NativeInvocationDecision,
  NativePolicyRound,
} from '../src/native/types.ts'
import { testCallId } from './call-id.ts'

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

  it('allows a native response to complete before the optional handshake', () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    const revision = broker.beginCompletionFence(requestId)
    expect(revision).toBeTypeOf('number')
    expect(broker.commitCompletionFence(requestId, revision!)).toBe(true)
    expect(broker.beginCompletionFence(requestId)).toBe(revision)
    broker.close()
  })

  it('renews an active round while the browser is still polling', async () => {
    vi.useFakeTimers()
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 20,
    })
    await vi.advanceTimersByTimeAsync(15)
    broker.touch(requestId)
    await vi.advanceTimersByTimeAsync(10)
    expect(broker.start(requestId)).toEqual({ started: true, duplicate: false })
    const retired = broker.waitForRetirement(requestId)
    await vi.advanceTimersByTimeAsync(10)
    await expect(retired).resolves.toBeUndefined()
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

  it('authorizes before minting a call id and keeps the round usable after denial', async () => {
    const decisions: Array<{ name: string; args: Record<string, unknown>; ordinal: number }> = []
    const policy: NativePolicyRound = {
      authorizeInvocation(name, args, ordinal): NativeInvocationDecision {
        decisions.push({ name, args, ordinal })
        if (args.path === '../escape') {
          return { allowed: false, code: 'NATIVE_POLICY_DENIED', message: 'native policy denied this invocation' }
        }
        return {
          allowed: true,
          arguments: Object.freeze({ path: '/workspace/ok.txt' }),
          binding: Object.freeze({
            toolName: name,
            capability: 'workspace.read',
            resultPolicy: 'text',
            schemaHash: 'a'.repeat(64),
            argumentsHash: 'b'.repeat(64),
            callOrdinal: ordinal,
            pathArguments: Object.freeze(['/path']),
          }),
        }
      },
      projectResult(_binding, result) {
        return { ...result, content: [{ type: 'text', text: 'projected' }] }
      },
    }
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000, policyRound: policy,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    await expect(broker.invoke(requestId, activityId, 'write', { path: '../escape' }))
      .rejects.toMatchObject({ code: 'NATIVE_POLICY_DENIED', releaseRound: false })
    expect(broker.takeToolBatch(requestId, Date.now() + 100)).toBeUndefined()
    const invocation = broker.invoke(requestId, activityId, 'write', { path: 'ok.txt' })
    const batch = broker.takeToolBatch(requestId, Date.now() + 100)!
    expect(batch).toHaveLength(1)
    expect(batch[0]?.arguments).toEqual({ path: '/workspace/ok.txt' })
    expect(Object.isFrozen(batch[0]?.arguments)).toBe(true)
    expect(Object.isFrozen((batch[0] as { binding?: unknown }).binding)).toBe(true)
    expect((batch[0] as unknown as { binding: { callOrdinal: number } }).binding.callOrdinal).toBe(1)
    expect(decisions).toEqual([
      { name: 'write', args: { path: '../escape' }, ordinal: 1 },
      { name: 'write', args: { path: 'ok.txt' }, ordinal: 1 },
    ])
    broker.completeBatch(requestId, [{ callId: batch[0]!.callId, result: ok }])
    await expect(invocation).resolves.toEqual({ content: [{ type: 'text', text: 'projected' }], isError: false })
    broker.completeActivity(requestId, activityId)
    broker.close()
  })

  it('projects every result before atomically resolving a policy batch', async () => {
    const policy: NativePolicyRound = {
      authorizeInvocation(name, _args, ordinal): NativeInvocationDecision {
        return {
          allowed: true,
          arguments: {},
          binding: Object.freeze({
            toolName: name,
            capability: 'workspace.read',
            resultPolicy: 'text',
            schemaHash: 'a'.repeat(64),
            argumentsHash: 'b'.repeat(64),
            callOrdinal: ordinal,
            pathArguments: Object.freeze([]),
          }),
        }
      },
      projectResult(_binding, result) {
        return { ...result, content: [{ type: 'text', text: 'projected' }] }
      },
    }
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000, policyRound: policy,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    const first = broker.invoke(requestId, activityId, 'write', { path: 'a' })
    const second = broker.invoke(requestId, activityId, 'write', { path: 'b' })
    const batch = broker.takeToolBatch(requestId, Date.now() + 100)!
    broker.completeBatch(requestId, batch.map(call => ({ callId: call.callId, result: ok })))
    await expect(Promise.all([first, second])).resolves.toEqual([
      { content: [{ type: 'text', text: 'projected' }], isError: false },
      { content: [{ type: 'text', text: 'projected' }], isError: false },
    ])
    broker.completeActivity(requestId, activityId)
    broker.close()
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
    broker.completeTool(requestId, testCallId(String(batch?.[0]?.callId)), ok)
    await expect(invocation).resolves.toEqual(ok)
    expect(() => broker.completeTool(requestId, testCallId(String(batch?.[0]?.callId)), ok)).not.toThrow()
    broker.close()
  })

  it('increments progress only for semantic broker activity, not lease touches', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    let previous = broker.progressRevision(requestId)
    broker.touch(requestId)
    expect(broker.progressRevision(requestId)).toBe(previous)
    broker.start(requestId)
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    previous = broker.progressRevision(requestId)
    broker.claimActivity(requestId, activityId)
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    previous = broker.progressRevision(requestId)
    const invocation = broker.invoke(requestId, activityId, 'write', { path: 'x' })
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    previous = broker.progressRevision(requestId)
    const batch = broker.takeToolBatch(requestId, Date.now() + 100)
    expect(batch).toHaveLength(1)
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    previous = broker.progressRevision(requestId)
    broker.completeTool(requestId, batch![0]!.callId, ok)
    await expect(invocation).resolves.toEqual(ok)
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    previous = broker.progressRevision(requestId)
    broker.completeActivity(requestId, activityId)
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    previous = broker.progressRevision(requestId)
    broker.beginSettlement(requestId)
    expect(broker.progressRevision(requestId)).toBeGreaterThan(previous)
    broker.close()
  })

  it('delivers a complete batch without terminally settling the round', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    const invocation = broker.invoke(requestId, activityId, 'write', { path: 'x' })
    const batch = broker.takeToolBatch(requestId, Date.now() + 100)!
    broker.completeBatch(requestId, [{ callId: batch[0]!.callId, result: ok }])
    await expect(invocation).resolves.toEqual(ok)
    expect(broker.start(requestId)).toEqual({ started: true, duplicate: true })

    const nextInvocation = broker.invoke(requestId, activityId, 'write', { path: 'y' })
    const nextBatch = broker.takeToolBatch(requestId, Date.now() + 100)!
    expect(nextBatch[0]?.arguments.path).toBe('y')
    broker.completeBatch(requestId, [{ callId: nextBatch[0]!.callId, result: ok }])
    await expect(nextInvocation).resolves.toEqual(ok)
    broker.completeActivity(requestId, activityId)
    broker.beginSettlement(requestId)
    broker.close()
  })

  it('validates every batch result before resolving any invocation', async () => {
    const broker = new NativeToolBroker()
    const requestId = broker.register({
      sessionId: 's1', tools: [tool], invocationTimeoutMs: 90_000, ttlMs: 1_000,
    })
    broker.start(requestId)
    broker.claimActivity(requestId, activityId)
    const first = broker.invoke(requestId, activityId, 'write', { path: 'a' })
    const second = broker.invoke(requestId, activityId, 'write', { path: 'b' })
    const batch = broker.takeToolBatch(requestId, Date.now() + 100)!
    expect(() => broker.completeBatch(requestId, [
      { callId: batch[0]!.callId, result: ok },
      { callId: batch[0]!.callId, result: ok },
    ])).toThrow(/duplicate/i)
    const firstState = Promise.race([
      first.then(() => 'resolved' as const),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0)),
    ])
    expect(await firstState).toBe('pending')
    broker.revoke(requestId, new Error('test cleanup'))
    await expect(second).rejects.toThrow(/test cleanup/)
    await expect(first).rejects.toThrow(/test cleanup/)
    broker.close()
  })
})
