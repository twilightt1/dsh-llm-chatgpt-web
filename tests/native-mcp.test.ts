import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { NativePolicyDeniedError } from '../src/native/errors.ts'
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
  readonly snapshot: BrokerRoundSnapshot
  readonly invocations: Array<{ name: string; args: Record<string, unknown> }> = []
  readonly activities = new Set<string>()
  readonly released: string[] = []
  pending = deferred<BrokerToolResult>()
  rejectInvocations = false
  denyInvocations = false

  constructor(tools: readonly ToolSchema[] = [tool]) {
    this.snapshot = {
      sessionId: 's1',
      tools: [...tools],
      invocationTimeoutMs: 90_000,
    }
  }

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
    if (this.denyInvocations) throw new NativePolicyDeniedError('native policy denied')
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

function resultText(result: unknown): string {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) throw new Error('MCP result has no content array')
  const first = content[0]
  if (typeof first !== 'object' || first === null || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('MCP result has no text content')
  }
  return first.text
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

  it('advertises a bounded complete catalog even when a relevant namespace is past page one', async () => {
    const overloadedTools: ToolSchema[] = [
      ...Array.from({ length: 21 }, (_, index) => ({
        name: `core_${String(index).padStart(2, '0')}`,
        description: `core tool ${index}`,
        parameters: { type: 'object' },
      })),
      {
        name: 'mcp__chrome-devtools__take_screenshot',
        description: 'Take a screenshot of the current browser page',
        parameters: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
      },
      ...Array.from({ length: 96 }, (_, index) => ({
        name: `mcp__misc__tool_${String(index).padStart(2, '0')}`,
        description: `miscellaneous tool ${index}`,
        parameters: { type: 'object' },
      })),
    ]
    const fake = new FakeBrokerRpcClient(overloadedTools)
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      const firstPage = await client.callTool({
        name: 'dsh_tool_inventory',
        arguments: { request_id: requestId },
      })
      const payload = JSON.parse(resultText(firstPage)) as {
        tools: Array<{ wire_name: string }>
        total: number
        next_offset: number | null
        discovery: {
          version: number
          query_matches: string
          namespaces: Array<{ prefix: string; count: number; names: string[] }>
          namespace_count: number
          unnamespaced: string[]
          unnamespaced_count: number
          truncated: boolean
        }
      }
      expect(payload.tools).toHaveLength(20)
      expect(payload.tools.some(entry => entry.wire_name.includes('chrome-devtools'))).toBe(false)
      expect(payload.total).toBe(118)
      expect(payload.next_offset).toBe(20)
      expect(payload.discovery).toMatchObject({
        version: 1,
        query_matches: 'case-insensitive substring of tool name or description',
        namespace_count: 2,
        unnamespaced_count: 21,
        truncated: false,
      })
      expect(payload.discovery.namespaces).toEqual(expect.arrayContaining([
        expect.objectContaining({
          prefix: 'mcp__chrome-devtools__',
          count: 1,
          names: ['mcp__chrome-devtools__take_screenshot'],
        }),
      ]))
      expect(payload.discovery.unnamespaced).toContain('core_20')
      expect(Buffer.byteLength(JSON.stringify(payload.discovery))).toBeLessThanOrEqual(8_192)

      const screenshot = await client.callTool({
        name: 'dsh_tool_inventory',
        arguments: { request_id: requestId, query: 'screenshot', include_schema: true },
      })
      expect(JSON.stringify(screenshot)).toContain('mcp__chrome-devtools__take_screenshot')
      expect(JSON.stringify(screenshot)).toContain('fullPage')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('bounds the discovery catalog without changing the complete match count', async () => {
    const oversizedTools: ToolSchema[] = Array.from({ length: 30 }, (_, index) => ({
      name: `${'tool_'.repeat(180)}${String(index).padStart(2, '0')}`,
      description: 'oversized tool name fixture',
      parameters: { type: 'object' },
    }))
    const fake = new FakeBrokerRpcClient(oversizedTools)
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      const result = await client.callTool({
        name: 'dsh_tool_inventory',
        arguments: { request_id: requestId, include_schema: false },
      })
      const payload = JSON.parse(resultText(result)) as {
        total: number
        discovery: { unnamespaced_count: number; truncated: boolean }
      }
      expect(payload.total).toBe(30)
      expect(payload.discovery.unnamespaced_count).toBe(30)
      expect(payload.discovery.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(payload.discovery))).toBeLessThanOrEqual(8_192)
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

  it('returns policy denials without releasing the handshake or queueing a DSH batch', async () => {
    const fake = new FakeBrokerRpcClient()
    fake.denyInvocations = true
    const { client, server } = await connectedServer(fake)
    try {
      await client.callTool({ name: 'dsh_round_start', arguments: { request_id: requestId } })
      await expect(client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'write', arguments: { path: '../escape' } },
      })).resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining('NATIVE_POLICY_DENIED') }] })
      expect(fake.released).toEqual([])
      expect(fake.activities.size).toBe(0)

      fake.denyInvocations = false
      const pending = client.callTool({
        name: 'dsh_tool_call',
        arguments: { request_id: requestId, wire_name: 'write', arguments: { path: 'ok' } },
      })
      await vi.waitFor(() => expect(fake.invocations).toHaveLength(2))
      fake.pending.resolve({ content: [{ type: 'text', text: 'ok' }], isError: false })
      await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: 'ok' }] })
      expect(fake.released).toEqual([])
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
      expect(fake.released).toEqual([requestId])
    } finally {
      await client.close()
      await server.close()
    }
  })
})
