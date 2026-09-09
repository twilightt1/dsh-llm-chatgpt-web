import { createHash, randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { BrokerRpcClient } from './broker-socket.ts'
import type { BrokerRoundSnapshot, BrokerToolResult } from './types.ts'
import { createBrokerRpcClient } from './broker-socket.ts'

const REQUEST_ID_MAX = 256
const INVENTORY_QUERY_MAX = 500
const INVENTORY_LIMIT_MAX = 50
const TOOL_NAME_MAX = 1_000
const INVOCATION_ACTIVITY_PREFIX = 'activity_'

function requestIdSchema() {
  return z.string().min(1).max(REQUEST_ID_MAX)
}

function activityId(): string {
  return `${INVOCATION_ACTIVITY_PREFIX}${randomBytes(18).toString('base64url')}`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function logRequest(operation: string, requestId: string, extra = ''): void {
  console.error(
    `[dsh-native-mcp] ${operation} request_hash=${hash(requestId)} request_chars=${requestId.length}`
      + (extra.length > 0 ? ` ${extra}` : ''),
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorResult(error: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  return {
    content: [{ type: 'text', text: errorText(error) }],
    isError: true,
  }
}

function jsonText(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : jsonText(value) }],
    ...(isError ? { isError: true as const } : {}),
  }
}

function toolMatches(tool: ToolSchema, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase()
  if (!needle) return true
  return `${tool.name}\n${tool.description}`.toLowerCase().includes(needle)
}

function inventory(
  snapshot: BrokerRoundSnapshot,
  query: string | undefined,
  offset: number,
  limit: number,
  includeSchema: boolean,
): Record<string, unknown> {
  const matches = snapshot.tools.filter(tool => toolMatches(tool, query))
  const page = matches.slice(offset, offset + limit).map(tool => ({
    wire_name: tool.name,
    name: tool.name,
    description: tool.description,
    ...(includeSchema ? { parameters: tool.parameters } : {}),
  }))
  return {
    tools: page,
    total: matches.length,
    next_offset: offset + page.length < matches.length ? offset + page.length : null,
  }
}

function mcpContent(result: BrokerToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: true } {
  const content: Array<{ type: 'text'; text: string }> = []
  for (const block of result.content) {
    if (block.type !== 'text') {
      throw new Error(`unsupported_content: native MCP result contains ${block.type} content`)
    }
    content.push({ type: 'text', text: block.text })
  }
  return {
    content,
    ...(result.isError ? { isError: true as const } : {}),
  }
}

/**
 * Construct the fixed MCP surface. The façade deliberately has no dynamic
 * registration path: the only tools ChatGPT can call are the three broker
 * protocol operations below.
 */
export function createDshNativeMcpServer(client: BrokerRpcClient): McpServer {
  const server = new McpServer({ name: 'dsh-native-chatgpt-web', version: '1.0.0' })

  server.registerTool(
    'dsh_round_start',
    {
      title: 'Start a DSH native tool round',
      description: 'Start the DSH provider round before inspecting or calling its tools.',
      inputSchema: { request_id: requestIdSchema() },
    },
    async ({ request_id }) => {
      logRequest('dsh_round_start', request_id)
      try {
        return textResult(await client.start(request_id))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'dsh_tool_inventory',
    {
      title: 'List DSH tools for this round',
      description: 'List the exact DSH tools advertised for the current native provider round.',
      inputSchema: {
        request_id: requestIdSchema(),
        query: z.string().max(INVENTORY_QUERY_MAX).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(INVENTORY_LIMIT_MAX).default(20),
        include_schema: z.boolean().default(true),
      },
    },
    async ({ request_id, query, offset, limit, include_schema }, extra) => {
      logRequest('dsh_tool_inventory', request_id, `query_chars=${query?.length ?? 0}`)
      return await withActivity(client, request_id, extra.signal, async snapshot => (
        textResult(inventory(snapshot, query, offset, limit, include_schema))
      ))
    },
  )

  server.registerTool(
    'dsh_tool_call',
    {
      title: 'Call one DSH tool',
      description: 'Call an exact wire_name returned by dsh_tool_inventory for this native round.',
      inputSchema: {
        request_id: requestIdSchema(),
        wire_name: z.string().min(1).max(TOOL_NAME_MAX),
        arguments: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ request_id, wire_name, arguments: args }, extra) => {
      logRequest('dsh_tool_call', request_id, `name_chars=${wire_name.length} args_chars=${jsonText(args ?? {}).length}`)
      return await withActivity(client, request_id, extra.signal, async (snapshot, id, signal) => {
        const tool = snapshot.tools.find(candidate => candidate.name === wire_name)
        if (tool === undefined) throw new Error(`native MCP tool is not advertised: ${wire_name}`)
        let result: BrokerToolResult
        try {
          result = await client.invoke(
            request_id,
            id,
            tool.name,
            args ?? {},
            snapshot.invocationTimeoutMs,
            signal,
          )
        } catch (error) {
          await client.release(request_id).catch(() => {})
          throw error
        }
        return mcpContent(result)
      })
    },
  )

  return server
}

async function withActivity(
  client: BrokerRpcClient,
  requestId: string,
  signal: AbortSignal | undefined,
  action: (
    snapshot: BrokerRoundSnapshot,
    activityId: string,
    signal: AbortSignal | undefined,
  ) => Promise<ReturnType<typeof textResult> | ReturnType<typeof mcpContent>>,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof mcpContent> | ReturnType<typeof errorResult>> {
  const id = activityId()
  let result: ReturnType<typeof textResult> | ReturnType<typeof mcpContent> | ReturnType<typeof errorResult> = errorResult(
    new Error('native MCP activity did not produce a result'),
  )
  try {
    const snapshot = await client.claim(requestId, id, signal)
    result = await action(snapshot, id, signal)
  } catch (error) {
    result = errorResult(error)
  } finally {
    try {
      // Cleanup intentionally does not reuse the request signal: an aborted
      // consumer must not strand the broker activity behind its own abort.
      await client.completeActivity(requestId, id)
    } catch (error) {
      if (result.isError !== true) result = errorResult(error)
    }
  }
  return result
}

/** Start the façade on stdio; stdout is reserved for MCP protocol frames. */
export async function runDshNativeMcpServer(socketPath: string): Promise<void> {
  if (!isAbsolute(socketPath)) throw new Error('native MCP broker socket path must be absolute')
  const server = createDshNativeMcpServer(createBrokerRpcClient(socketPath))
  await server.connect(new StdioServerTransport())
}
