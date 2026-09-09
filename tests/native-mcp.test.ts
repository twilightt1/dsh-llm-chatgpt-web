import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { createDshNativeMcpServer } from '../src/native/mcp-server.ts'
import type { BrokerRpcClient } from '../src/native/broker-socket.ts'
import type { BrokerRoundSnapshot, BrokerToolResult } from '../src/native/types.ts'

const requestId = 'request_abcdefghijklmnopqrstuvwxyz'
const tool: ToolSchema = {
  name: 'write',
  description: 'write a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeBrokerRpcClient implements BrokerRpcClient {
  started = false
  readonly snapshot: BrokerRoundSnapshot = {
    sessionId: 's1',
    tools: [tool],
    invocationTimeoutMs: 90_000,
  }
  readonly invocations: Array<{ name: string; args: Record<string, unknown> }> = []
  readonly activities = new Set<string>()
  readonly released: string[] = []
  pending = deferred<BrokerToolResult>()
  rejectInvocations = false

  async start(): Promise<{ started: true; duplicate: boolean }> {
    const duplicate = this.started
    this.started = true
    return { started: true, duplicate }
  }

  async claim(_requestId: string, activityId: string): Promise<BrokerRoundSnapshot> {
    if (!this.started) throw new Error('round must start first')
    this.activities.add(activityId)
    return this.snapshot
  }

  async completeActivity(_requestId: string, activityId: string): Promise<void> {
    this.activities.delete(activityId)
  }

  async invoke(_requestId: string, _activityId: string, name: string, args: Record<string, unknown>): Promise<BrokerToolResult> {
    this.invocations.push({ name, args })
    if (this.rejectInvocations) throw new Error('timeout')
    return await this.pending.promise
  }

  async release(requestId: string): Promise<void> {
    this.released.push(requestId)
  }
}

async function connectedServer(fake: FakeBrokerRpcClient) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createDshNativeMcpServer(fake)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DSH native MCP façade', () => {
  it('exposes only the fixed native broker protocol', async () => {
    const fake = new FakeBrokerRpcClient()
    const { client, server } = await connectedServer(fake)
    try {
      expect((await client.listTools()).tools.map(toolEntry => toolEntry.name)).toEqual([
        'dsh_round_start',
        'dsh_tool_inventory',
        'dsh_tool_call',
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requires the explicit round handshake and inventories an immutable snapshot', async () => {
    const fake = new FakeBrokerRpcClient()
    const { client, server } = await connectedServer(fake)
    try {
      await expect(client.callTool({
        name: 'dsh_tool_inventory',
        arguments: { request_id: requestId },
      })).resolves.toMatchObject({ isError: true })

      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      const inventory = await client.callTool({
        name: 'dsh_tool_inventory',
        arguments: { request_id: requestId, query: 'wri', offset: 0, limit: 1, include_schema: true },
      })
      expect(JSON.stringify(inventory)).toContain('write')
      expect(JSON.stringify(inventory)).toContain('path')
      expect(fake.activities.size).toBe(0)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('invokes an exact advertised tool and settles its activity', async () => {
    const fake = new FakeBrokerRpcClient()
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      const pending = client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'write', arguments: { path: 'x' } },
      })
      await vi.waitFor(() => expect(fake.invocations).toHaveLength(1))
      fake.pending.resolve({ content: [{ type: 'text', text: 'written' }], isError: false })
      await expect(pending).resolves.toMatchObject({
        content: [{ type: 'text', text: 'written' }],
      })
      expect(fake.activities.size).toBe(0)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns structured errors without queueing unknown or malformed calls', async () => {
    const fake = new FakeBrokerRpcClient()
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      await expect(client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'read', arguments: {} },
      })).resolves.toMatchObject({ isError: true })
      await expect(client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'write', arguments: 'not an object' },
      })).resolves.toMatchObject({ isError: true })
      expect(fake.invocations).toHaveLength(0)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('releases the request and redacts request ids from diagnostics on invocation failure', async () => {
    const fake = new FakeBrokerRpcClient()
    fake.rejectInvocations = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      await expect(client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'write', arguments: { path: 'x' } },
      })).resolves.toMatchObject({ isError: true })
      expect(fake.released).toEqual([requestId])
      const diagnostics = errorSpy.mock.calls.flat().join(' ')
      expect(diagnostics).not.toContain(requestId)
      expect(diagnostics).toMatch(/[0-9a-f]{12}/)
      expect(diagnostics).toMatch(/chars/i)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rejects non-text broker content explicitly', async () => {
    const fake = new FakeBrokerRpcClient()
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      const pending = client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'write', arguments: { path: 'x' } },
      })
      await vi.waitFor(() => expect(fake.invocations).toHaveLength(1))
      fake.pending.resolve({ content: [{ type: 'reasoning', text: 'hidden' }], isError: false })
      await expect(pending).resolves.toMatchObject({ isError: true })
      expect(fake.released).toHaveLength(0)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
