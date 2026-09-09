import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { NativeToolBroker } from '../src/native/broker.ts'
import {
  NativeRoundCoordinator,
  correlateToolResults,
} from '../src/native/coordinator.ts'
import type { BrokerCallId, BrokerToolRequest } from '../src/native/types.ts'
import { testCallId } from './call-id.ts'

const tool: ToolSchema = {
  name: 'write',
  description: 'write a file',
  parameters: { type: 'object' },
}
function brokerCall(id: string, name: string): BrokerToolRequest {
  return { callId: testCallId(id), name, arguments: {} }
}

function toolResultMessage(callId: BrokerCallId, text: string, isError = false): Message {
  return {
    id: MessageId(`result-${String(callId)}-${text}`),
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
    source: { kind: 'tool', callId },
  }
}

function toolImageResultMessage(callId: BrokerCallId): Message {
  return {
    id: MessageId(`image-${String(callId)}`),
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'reasoning', text: 'non-text result' }],
    }],
    source: { kind: 'tool', callId },
  }
}

function stepInput(sessionId: string, ttlMs = 1_000) {
  return {
    sessionId,
    messages: [] as Message[],
    tools: [tool],
    ttlMs,
    invocationTimeoutMs: 1_000,
  }
}

interface ParkedHarness {
  broker: NativeToolBroker
  coordinator: NativeRoundCoordinator
  parkedRequestId: string
  call: BrokerToolRequest
  cleanup: (mode: 'stop' | 'close') => Promise<void>
  cleanupModes: Array<'stop' | 'close'>
  finishMcpActivity(): void
}

async function parkedCoordinatorHarness(sessionId: string, options: { ttlMs?: number } = {}): Promise<ParkedHarness> {
  const broker = new NativeToolBroker()
  const coordinator = new NativeRoundCoordinator(broker)
  const cleanupModes: Array<'stop' | 'close'> = []
  const cleanup = async (mode: 'stop' | 'close'): Promise<void> => {
    cleanupModes.push(mode)
  }
  const first = await coordinator.beginStep(stepInput(sessionId, options.ttlMs ?? 1_000))
  broker.start(first.requestId)
  const activity = `activity_${sessionId.padEnd(16, 'x')}`
  broker.claimActivity(first.requestId, activity)
  const invocation = broker.invoke(first.requestId, activity, 'write', { path: 'x' })
  void invocation.catch(() => {})
  const call = first.takeToolBatch(Date.now() + 20)?.[0]
  if (call === undefined) throw new Error('test harness did not receive a broker call')
  await first.park(cleanup)
  return {
    broker,
    coordinator,
    parkedRequestId: first.requestId,
    call,
    cleanup,
    cleanupModes,
    finishMcpActivity(): void {
      broker.completeActivity(first.requestId, activity)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('correlateToolResults', () => {
  it('correlates only pending results in broker order', () => {
    const first = brokerCall('call_1', 'read')
    const second = brokerCall('call_2', 'write')
    const messages = [
      toolResultMessage(testCallId('old_call'), 'old'),
      toolResultMessage(second.callId, 'second', true),
      toolResultMessage(first.callId, 'first'),
    ]
    expect(correlateToolResults(messages, [first, second])).toEqual([
      { content: [{ type: 'text', text: 'first' }], isError: false },
      { content: [{ type: 'text', text: 'second' }], isError: true },
    ])
  })

  it('rejects missing, duplicate, and non-text pending results', () => {
    const call = brokerCall('call_1', 'read')
    expect(() => correlateToolResults([], [call])).toThrow(/missing.*call_1/i)
    expect(() => correlateToolResults([
      toolResultMessage(call.callId, 'one'),
      toolResultMessage(call.callId, 'two'),
    ], [call])).toThrow(/duplicate.*call_1/i)
    const nonText = toolImageResultMessage(call.callId)
    expect(() => correlateToolResults([nonText], [call])).toThrow(/non-text|unsupported/i)
  })
})

describe('NativeRoundCoordinator', () => {
  it('settles and stops the predecessor before registering a fresh round', async () => {
    vi.useFakeTimers()
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const calls: string[] = []
    const first = await coordinator.beginStep(stepInput('s1'))
    broker.start(first.requestId)
    const activity = 'activity_abcdefghijklmnop'
    broker.claimActivity(first.requestId, activity)
    const invocation = broker.invoke(first.requestId, activity, 'write', { path: 'x' })
    await vi.advanceTimersByTimeAsync(15)
    const batch = first.takeToolBatch()!
    await first.park(async mode => { calls.push(mode) })

    const resumed = coordinator.beginStep({
      ...stepInput('s1'),
      messages: [toolResultMessage(batch[0]!.callId, 'written')],
    })
    expect(calls).toEqual([])
    expect(await invocation).toEqual({
      content: [{ type: 'text', text: 'written' }], isError: false,
    })
    broker.completeActivity(first.requestId, activity)
    const second = await resumed
    expect(calls).toEqual(['stop'])
    expect(second.requestId).not.toBe(first.requestId)
    await second.complete(async mode => { calls.push(mode) })
    expect(calls).toEqual(['stop', 'close'])
  })

  it('runs bound cleanup when a turn stops before page allocation', async () => {
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const modes: Array<'stop' | 'close'> = []
    const lease = await coordinator.beginStep(stepInput('s1'))
    lease.bindCleanup(async mode => { modes.push(mode) })
    await coordinator.stopAtTurnBoundary('s1')
    expect(modes).toEqual(['stop'])
    await coordinator.dispose()
  })

  it('revokes a parked round at the turn boundary and releases another session', async () => {
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const cleanup: Array<'stop' | 'close'> = []
    const first = await coordinator.beginStep(stepInput('s1'))
    broker.start(first.requestId)
    const activity = 'activity_abcdefghijklmnop'
    broker.claimActivity(first.requestId, activity)
    const abandoned = broker.invoke(first.requestId, activity, 'write', { path: 'x' })
    expect(first.takeToolBatch(Date.now() + 15)).toHaveLength(1)
    await first.park(async mode => { cleanup.push(mode) })
    const other = coordinator.beginStep(stepInput('s2'))
    const abandonedRejection = expect(abandoned).rejects.toThrow(/turn boundary|revoked/i)
    await coordinator.stopAtTurnBoundary('s1')
    await abandonedRejection
    expect(cleanup).toEqual(['stop'])
    const second = await other
    expect(second.requestId).not.toBe(first.requestId)
    await second.complete(async mode => { cleanup.push(mode) })
    expect(cleanup).toEqual(['stop', 'close'])
  })

  it('owner resume bypasses a queued unrelated session', async () => {
    const harness = await parkedCoordinatorHarness('s1')
    const unrelated = harness.coordinator.beginStep(stepInput('s2'))
    const owner = harness.coordinator.beginStep({
      ...stepInput('s1'),
      messages: [toolResultMessage(harness.call.callId, 'done')],
    })
    harness.finishMcpActivity()
    const resumed = await owner
    expect(resumed.requestId).not.toBe(harness.parkedRequestId)
    let unrelatedResolved = false
    void unrelated.then(() => { unrelatedResolved = true })
    await Promise.resolve()
    expect(unrelatedResolved).toBe(false)
    await resumed.complete(harness.cleanup)
    const next = await unrelated
    await next.complete(harness.cleanup)
    await harness.coordinator.dispose()
  })

  it('TTL retirement and dispose call transferred cleanup exactly once', async () => {
    vi.useFakeTimers()
    const harness = await parkedCoordinatorHarness('s1', { ttlMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    expect(harness.cleanupModes).toEqual(['stop'])
    await harness.coordinator.dispose()
    expect(harness.cleanupModes).toEqual(['stop'])
  })

  it('removes an aborted unrelated waiter', async () => {
    const harness = await parkedCoordinatorHarness('s1')
    const controller = new AbortController()
    const waiting = expect(harness.coordinator.beginStep({
      ...stepInput('s2'), signal: controller.signal,
    })).rejects.toThrow(/abort/i)
    controller.abort()
    await waiting
    await harness.coordinator.stopAtTurnBoundary('s1')
    const next = await harness.coordinator.beginStep(stepInput('s3'))
    await next.complete(harness.cleanup)
    await harness.coordinator.dispose()
  })
})
