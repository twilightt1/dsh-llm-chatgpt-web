import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TextTurnEvent, TextTurnResult } from '../src/chatgpt/turn.ts'
import {
  createNativePhysicalResponse,
  type NativePhysicalResponseDriver,
} from '../src/native/physical-response.ts'
import type { BrokerToolRequest, BrokerToolResult } from '../src/native/types.ts'
import { testCallId } from './call-id.ts'

const call = {
  callId: testCallId('call_00000000000000000000000000000001'),
  name: 'bash',
  arguments: { command: 'pwd' },
} satisfies BrokerToolRequest

const result: BrokerToolResult = {
  content: [{ type: 'text', text: '/repo' }],
  isError: false,
}

function boundary(
  events: readonly TextTurnEvent[],
  value: TextTurnResult,
): { events: readonly TextTurnEvent[]; value: TextTurnResult } {
  return { events, value }
}

function fakeDriver(boundaries: readonly ReturnType<typeof boundary>[]): NativePhysicalResponseDriver & {
  readonly nextBoundaryCount: () => number
  readonly delivered: BrokerToolResult[][]
} {
  let index = 0
  let nextBoundaryCount = 0
  const delivered: BrokerToolResult[][] = []
  return {
    async *nextBoundary(): AsyncGenerator<TextTurnEvent, TextTurnResult> {
      const next = boundaries[index++]
      if (next === undefined) throw new Error('fake driver has no more boundaries')
      nextBoundaryCount += 1
      for (const event of next.events) yield event
      return next.value
    },
    async deliverResults(results): Promise<void> {
      delivered.push(structuredClone([...results]))
    },
    markToolResultDelivered: vi.fn(),
    stop: vi.fn(async () => {}),
    nextBoundaryCount: () => nextBoundaryCount,
    delivered,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function fixture(driver: NativePhysicalResponseDriver) {
  return {
    sessionId: 'session-1',
    executionKey: 'a'.repeat(64),
    requestId: 'request_test',
    promptChars: 10,
    driver,
  }
}

describe('NativePhysicalResponse', () => {
  it('continues two logical boundaries on one driver and journals replay exactly', async () => {
    const driver = fakeDriver([
      boundary(
        [{ type: 'delta', delta: '/repo' }],
        { kind: 'tool-batch', text: '/repo', promptChars: 10, calls: [call] },
      ),
      boundary(
        [{ type: 'delta', delta: ' is ready' }],
        { kind: 'completed', text: ' is ready', promptChars: 10 },
      ),
    ])
    const cleanup = vi.fn(async () => {})
    const response = createNativePhysicalResponse({ ...fixture(driver), cleanup })

    const first = await collect(response.streamBoundary())
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'finish', reason: { kind: 'tool-calls' } }),
    ]))
    expect(response.state).toBe('parked')
    expect(first.at(-1)).toMatchObject({ type: 'finish', replayState: { response: {
      kind: 'chatgpt-web-native', version: 1, executionKey: 'a'.repeat(64), boundary: 1,
    } } })

    await response.deliverResults([result])
    expect(driver.delivered).toEqual([[result]])
    const second = await collect(response.streamBoundary())
    expect(second).toEqual(expect.arrayContaining([
      { type: 'text-delta', index: 0, text: ' is ready' },
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(response.state).toBe('completed')
    expect(driver.nextBoundaryCount()).toBe(2)
    expect(cleanup).toHaveBeenCalledOnce()

    const replay = await collect(response.streamBoundary(1))
    expect(replay).toEqual(first)
    expect(driver.nextBoundaryCount()).toBe(2)
  })

  it('supports a second serial tool boundary without duplicating prior text', async () => {
    const secondCall = {
      ...call,
      callId: testCallId('call_00000000000000000000000000000002'),
      arguments: { command: 'git status --short' },
    }
    const driver = fakeDriver([
      boundary([{ type: 'delta', delta: 'first ' }], {
        kind: 'tool-batch', text: 'first ', promptChars: 10, calls: [call],
      }),
      boundary([{ type: 'delta', delta: 'second ' }], {
        kind: 'tool-batch', text: 'second ', promptChars: 20, calls: [secondCall],
      }),
      boundary([{ type: 'delta', delta: 'done' }], {
        kind: 'completed', text: 'done', promptChars: 30,
      }),
    ])
    const response = createNativePhysicalResponse(fixture(driver))

    const first = await collect(response.streamBoundary())
    await response.deliverResults([result])
    const second = await collect(response.streamBoundary())
    await response.deliverResults([result])
    const final = await collect(response.streamBoundary())

    expect(first.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'first ' }])
    expect(second.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'second ' }])
    expect(final.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'done' }])
    expect(driver.nextBoundaryCount()).toBe(3)
    expect(response.state).toBe('completed')
  })

  it('refuses result handoff after an uncertain side-effect stage', async () => {
    const driver = fakeDriver([boundary([], {
      kind: 'tool-batch', text: '', promptChars: 10, calls: [call],
    })])
    const response = createNativePhysicalResponse(fixture(driver))
    await collect(response.streamBoundary())
    response.markUncertain('tool-dispatch', new Error('socket lost after dispatch'))
    expect(response.hasUncertainOutcome()).toBe(true)
    await expect(response.deliverResults([result])).rejects.toThrow(/uncertain/i)
    await response.stop(new Error('cleanup'))
    expect(driver.stop).toHaveBeenCalledOnce()
  })

  it('marks a result-handoff transport failure as uncertain', async () => {
    const driver = fakeDriver([boundary([], {
      kind: 'tool-batch', text: '', promptChars: 10, calls: [call],
    })])
    vi.spyOn(driver, 'deliverResults').mockRejectedValueOnce(new Error('result socket closed'))
    const response = createNativePhysicalResponse(fixture(driver))
    await collect(response.streamBoundary())
    await expect(response.deliverResults([result])).rejects.toThrow(/socket closed/i)
    expect(response.hasUncertainOutcome()).toBe(true)
    expect(driver.stop).toHaveBeenCalledOnce()
  })

  it('stops a parked response once and refuses a second boundary', async () => {
    const driver = fakeDriver([boundary([], {
      kind: 'tool-batch', text: '', promptChars: 10, calls: [call],
    })])
    const cleanup = vi.fn(async () => {})
    const response = createNativePhysicalResponse({ ...fixture(driver), cleanup })
    await collect(response.streamBoundary())
    await response.stop(new Error('cancelled'))
    await response.stop(new Error('cancelled again'))
    expect(driver.stop).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(response.state).toBe('revoked')
    await expect(collect(response.streamBoundary())).rejects.toThrow(/revoked|terminal/i)
  })
})
