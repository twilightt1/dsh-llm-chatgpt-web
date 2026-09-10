import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { WorkspaceBoundary } from './workspace-boundary.ts'

export type BrokerCallId = Extract<ContentBlock, { type: 'tool-call' }>['id']

/** A provider-side tool request handed to the DSH agent loop. */
export interface BrokerToolRequest {
  readonly callId: BrokerCallId
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** A broker request authorized by the immutable policy round. */
export interface BrokerAuthorizedToolRequest extends BrokerToolRequest {
  readonly binding: NativeCallPolicyBinding
}

/** A DSH tool result held until the model-facing result is available. */
export interface BrokerToolResult {
  readonly content: ContentBlock[]
  readonly isError: boolean
}

/** One durable result delivered for a non-terminal broker batch. */
export interface BrokerCompletedTool {
  readonly callId: BrokerCallId
  readonly result: BrokerToolResult
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

export type NativeToolPolicy = 'full' | 'evidence-only' | 'allowlist'
export type NativeApprovalMode = 'none' | 'workspace-policy'
export type NativeCapability =
  | 'workspace.read'
  | 'workspace.search'
  | 'git.read'
  | 'execution.read'
  | 'side-effect'
export type NativeResultPolicy = 'text' | 'sanitized-evidence'

export interface NativeToolRuleConfig {
  readonly tool: string
  readonly capability: NativeCapability
  readonly pathArguments?: string[]
  readonly result?: NativeResultPolicy
}

export interface NativeEvidenceLimitsConfig {
  readonly maxBytes?: number
  readonly maxLines?: number
}

export interface NativeSecurityConfig {
  readonly toolPolicy?: NativeToolPolicy
  readonly workspaceRoot?: string
  readonly approval?: NativeApprovalMode
  readonly rules?: NativeToolRuleConfig[]
  readonly evidenceLimits?: NativeEvidenceLimitsConfig
}

export interface ResolvedNativeToolRule {
  readonly tool: string
  readonly capability: NativeCapability
  readonly pathArguments: readonly string[]
  readonly result: NativeResultPolicy
}

export interface ResolvedNativeSecurityConfig {
  readonly toolPolicy: NativeToolPolicy
  readonly workspaceRoot: string
  readonly workspaceRootSource: 'explicit' | 'process.cwd'
  readonly approval: NativeApprovalMode
  readonly rules: readonly ResolvedNativeToolRule[]
  readonly evidenceLimits: { readonly maxBytes: number; readonly maxLines: number }
}

export interface NativePolicyRuntimeIdentity {
  readonly adapterVersion: string
  readonly connectorTransport?: ConnectorTransport
  readonly connectorRuntime: ConnectorRuntime
  readonly connectorName: string
  readonly brokerSocketPath: string
  readonly nativeRuntimeConfigPath: string
  readonly mcpInvocationTimeoutMs?: number
  readonly managedTunnelClient?: { readonly version: string; readonly sha256: string }
}

export type NativeEffectiveCapability = NativeCapability | 'full-unrestricted'
export type NativeEffectiveResultPolicy = NativeResultPolicy | 'raw-unbounded'
export type NativeOutputProvenance = 'operator-declared' | 'unverified-full'

export interface NativePolicySummary {
  readonly toolPolicy: NativeToolPolicy
  readonly workspaceRoot: string
  readonly workspaceRootSource: 'explicit' | 'process.cwd'
  readonly connectorName: string
  readonly connectorRuntime: ConnectorRuntime
  readonly approval: NativeApprovalMode
  readonly tools: readonly {
    readonly tool: string
    readonly capability: NativeEffectiveCapability
    readonly pathArguments: readonly string[]
    readonly result: NativeEffectiveResultPolicy
    readonly outputProvenance: NativeOutputProvenance
    readonly schemaHash?: string
  }[]
  readonly evidenceLimits: { readonly maxBytes: number; readonly maxLines: number }
}

export interface NativeCallPolicyBinding {
  readonly toolName: string
  readonly capability: NativeEffectiveCapability
  readonly resultPolicy: NativeEffectiveResultPolicy
  readonly schemaHash: string
  readonly argumentsHash: string
  readonly callOrdinal: number
  readonly pathArguments: readonly string[]
}

export type NativeInvocationDecision =
  | { readonly allowed: false; readonly code: 'NATIVE_POLICY_DENIED'; readonly message: string }
  | {
      readonly allowed: true
      readonly arguments: Readonly<Record<string, unknown>>
      readonly binding: NativeCallPolicyBinding
    }

export interface NativePolicyRound {
  authorizeInvocation(
    tool: string,
    args: Record<string, unknown>,
    callOrdinal: number,
  ): NativeInvocationDecision
  projectResult(binding: NativeCallPolicyBinding, result: BrokerToolResult): BrokerToolResult
}

export interface NativeCoordinatorSnapshot {
  readonly sessionId: string
  readonly canonicalMessages: readonly Message[]
  readonly broker: BrokerRoundSnapshot
  readonly policyHash: string
  readonly inventoryHash: string
  readonly approvalHash: string
}

export interface PreparedNativeRound {
  readonly coordinatorSnapshot: NativeCoordinatorSnapshot
  openRound(): NativePolicyRound
}

export interface PreparedNativeRequest {
  readonly providerOptions: GenerateOptions
  /** Project newly emitted assistant history into the provider-safe view. */
  readonly projectProviderMessages: (messages: readonly Message[]) => readonly Message[]
  readonly policyHash: string
  readonly inventoryHash: string
  readonly approvalHash: string
  readonly summary: NativePolicySummary
  readonly nativeRound?: PreparedNativeRound
}

export interface CompiledNativeSecurityPolicy {
  readonly config: ResolvedNativeSecurityConfig
  readonly workspaceRoot: string
  readonly policyHash: string
  readonly workspaceBoundary?: WorkspaceBoundary
  prepareRequest(
    options: GenerateOptions,
    runtime: NativePolicyRuntimeIdentity,
  ): PreparedNativeRequest
}

/** JSON-RPC request/response values used by the private broker socket. */
export type BrokerRpcErrorCode = 'NATIVE_POLICY_DENIED' | 'BROKER_FAILURE'

export interface BrokerRpcError {
  readonly code: BrokerRpcErrorCode
  readonly message: string
  readonly releaseRound: boolean
}

export interface BrokerRpcResponse<T = unknown> {
  readonly id: string
  readonly result?: T
  readonly error?: BrokerRpcError
}
