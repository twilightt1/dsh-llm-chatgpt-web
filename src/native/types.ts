import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'

export type BrokerCallId = Extract<ContentBlock, { type: 'tool-call' }>['id']

/** A provider-side tool request handed to the DSH agent loop. */
export interface BrokerToolRequest {
  readonly callId: BrokerCallId
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** A DSH tool result held until the model-facing result is available. */
export interface BrokerToolResult {
  readonly content: ContentBlock[]
  readonly isError: boolean
}

/** Versioned, opaque adapter state carried by a native assistant finish. */
export interface NativeReplayStateV1 {
  readonly kind: 'chatgpt-web-native'
  readonly version: 1
  readonly executionKey: string
  readonly boundary: number
  readonly callIds: readonly BrokerCallId[]
}

/** Immutable facts captured when one provider round is registered. */
export interface BrokerRoundSnapshot {
  readonly sessionId: string
  readonly tools: readonly ToolSchema[]
  readonly invocationTimeoutMs: number
}

/** The two supported adapter-level connector transports. */
export type ConnectorTransport = 'text' | 'mcp'

/** Owner of the native MCP tunnel process. */
export type ConnectorRuntime = 'external' | 'managed'

/** JSON-RPC request/response values used by the private broker socket. */
export interface BrokerRpcError {
  readonly message: string
}

export interface BrokerRpcResponse<T = unknown> {
  readonly id: string
  readonly result?: T
  readonly error?: string
}
