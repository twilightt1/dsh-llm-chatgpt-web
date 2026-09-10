import { isAbsolute, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { canonicalJson, hashCanonical } from './canonical.ts'
import { NativeSafetyError } from './errors.ts'
import { projectNativeToolResult } from './result-sanitizer.ts'
import { createWorkspaceBoundary } from './workspace-boundary.ts'
import type {
  CompiledNativeSecurityPolicy,
  NativeApprovalMode,
  NativeCapability,
  NativeEffectiveCapability,
  NativeEffectiveResultPolicy,
  NativeCallPolicyBinding,
  NativeCoordinatorSnapshot,
  NativeInvocationDecision,
  NativePolicyRound,
  NativePolicyRuntimeIdentity,
  NativePolicySummary,
  NativeResultPolicy,
  NativeSecurityConfig,
  NativeToolPolicy,
  NativeToolRuleConfig,
  PreparedNativeRequest,
  PreparedNativeRound,
  ResolvedNativeSecurityConfig,
  BrokerToolResult,
  ResolvedNativeToolRule,
} from './types.ts'

export const NATIVE_POLICY_FORMAT_VERSION = 1 as const
export const NATIVE_SANITIZER_FORMAT_VERSION = 1 as const
export const MIN_NATIVE_EVIDENCE_BYTES = 256 as const
export const DEFAULT_NATIVE_EVIDENCE_MAX_BYTES = 65_536 as const
export const MAX_NATIVE_EVIDENCE_BYTES = 1_048_576 as const
export const MIN_NATIVE_EVIDENCE_LINES = 1 as const
export const DEFAULT_NATIVE_EVIDENCE_MAX_LINES = 200 as const
export const MAX_NATIVE_EVIDENCE_LINES = 10_000 as const
export const MAX_NATIVE_TOOL_NAME_BYTES = 256 as const
export const MAX_NATIVE_POINTER_BYTES = 1_024 as const

const CONTROL_BYTES = /[\u0000-\u001f\u007f]/
const TOOL_POLICIES = new Set<NativeToolPolicy>(['full', 'evidence-only', 'allowlist'])
const APPROVAL_MODES = new Set<NativeApprovalMode>(['none', 'workspace-policy'])
const CAPABILITIES = new Set<NativeCapability>([
  'workspace.read',
  'workspace.search',
  'git.read',
  'execution.read',
  'side-effect',
])
const RESULT_POLICIES = new Set<NativeResultPolicy>(['text', 'sanitized-evidence'])
const WORKSPACE_CAPABILITIES = new Set<NativeCapability>([
  'workspace.read',
  'workspace.search',
  'git.read',
])
const BUILT_IN_SENSITIVE_RULE_VERSION = 1 as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function expandHome(value: string): string {
  if (value !== '~' && !value.startsWith('~/')) return value
  return homedir() + value.slice(1)
}

function assertSafePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`native security ${field} must be a non-empty path`)
  }
  if (CONTROL_BYTES.test(value)) throw new Error(`native security ${field} contains a control byte`)
  return value
}

function assertName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('native security tool name must be non-empty and trimmed')
  }
  if (CONTROL_BYTES.test(value)) throw new Error('native security tool name contains a control byte')
  if (Buffer.byteLength(value, 'utf8') > MAX_NATIVE_TOOL_NAME_BYTES) {
    throw new Error(`native security tool name exceeds ${MAX_NATIVE_TOOL_NAME_BYTES} UTF-8 bytes`)
  }
  return value
}

function assertPointer(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_NATIVE_POINTER_BYTES) {
    throw new Error(`native security path pointer exceeds ${MAX_NATIVE_POINTER_BYTES} UTF-8 bytes`)
  }
  if (CONTROL_BYTES.test(value)) throw new Error('native security path pointer contains a control byte')
  if (value !== '' && !value.startsWith('/')) throw new Error('native security path pointer must be an RFC 6901 pointer')
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '~' && value[index + 1] !== '0' && value[index + 1] !== '1') {
      throw new Error('native security path pointer contains an invalid RFC 6901 escape')
    }
  }
  return value
}

function assertBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`native security ${field} must be a safe integer from ${minimum} through ${maximum}`)
  }
  return value
}

function resolveRule(input: unknown, mode: NativeToolPolicy): ResolvedNativeToolRule {
  if (!isRecord(input)) throw new Error('native security rules must contain objects')
  const tool = assertName(input.tool)
  const capability = input.capability
  if (typeof capability !== 'string' || !CAPABILITIES.has(capability as NativeCapability)) {
    throw new Error(`native security capability is invalid for ${JSON.stringify(tool)}`)
  }
  const pathArgumentsValue = input.pathArguments
  if (pathArgumentsValue !== undefined && !Array.isArray(pathArgumentsValue)) {
    throw new Error(`native security pathArguments must be an array for ${JSON.stringify(tool)}`)
  }
  const pathArguments = (pathArgumentsValue ?? []).map(assertPointer)
  if (new Set(pathArguments).size !== pathArguments.length) {
    throw new Error(`native security pathArguments are duplicated for ${JSON.stringify(tool)}`)
  }
  const result = input.result ?? 'text'
  if (typeof result !== 'string' || !RESULT_POLICIES.has(result as NativeResultPolicy)) {
    throw new Error(`native security result policy is invalid for ${JSON.stringify(tool)}`)
  }
  const typedCapability = capability as NativeCapability
  const typedResult = result as NativeResultPolicy
  if (mode !== 'full') {
    if (mode === 'evidence-only' && typedCapability === 'side-effect') {
      throw new Error(`native security side-effect rule is forbidden in evidence-only mode: ${tool}`)
    }
    if (WORKSPACE_CAPABILITIES.has(typedCapability) && pathArguments.length === 0) {
      throw new Error(`native security workspace rule requires pathArguments: ${tool}`)
    }
    if (typedCapability === 'execution.read' && pathArguments.length === 0 && typedResult !== 'sanitized-evidence') {
      throw new Error(`native security execution.read without pathArguments requires sanitized-evidence: ${tool}`)
    }
  }
  return {
    tool,
    capability: typedCapability,
    pathArguments: Object.freeze([...pathArguments]),
    result: typedResult,
  }
}

function resolveRules(input: readonly NativeToolRuleConfig[] | undefined, mode: NativeToolPolicy): readonly ResolvedNativeToolRule[] {
  if (input !== undefined && !Array.isArray(input)) throw new Error('native security rules must be an array')
  const rules = (input ?? []).map(rule => resolveRule(rule, mode))
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.tool)) throw new Error(`native security rule is duplicated: ${rule.tool}`)
    seen.add(rule.tool)
  }
  return Object.freeze([...rules].sort((left, right) => left.tool.localeCompare(right.tool)))
}

/** Resolve and validate the public native security configuration. */
export function resolveNativeSecurityConfig(
  input: NativeSecurityConfig | undefined,
  cwd = process.cwd(),
): ResolvedNativeSecurityConfig {
  if (input !== undefined && !isRecord(input)) throw new Error('native security config must be an object')
  const toolPolicyValue = input?.toolPolicy ?? 'full'
  if (typeof toolPolicyValue !== 'string' || !TOOL_POLICIES.has(toolPolicyValue as NativeToolPolicy)) {
    throw new Error('native security toolPolicy is invalid')
  }
  const approvalValue = input?.approval ?? 'none'
  if (typeof approvalValue !== 'string' || !APPROVAL_MODES.has(approvalValue as NativeApprovalMode)) {
    throw new Error('native security approval is invalid')
  }
  const explicitRoot = input?.workspaceRoot
  const rootInput = explicitRoot === undefined ? cwd : assertSafePath(explicitRoot, 'workspaceRoot')
  const workspaceRoot = resolvePath(expandHome(rootInput))
  const evidenceLimitsInput = input?.evidenceLimits
  if (evidenceLimitsInput !== undefined && !isRecord(evidenceLimitsInput)) {
    throw new Error('native security evidenceLimits must be an object')
  }
  const maxBytes = assertBoundedInteger(
    evidenceLimitsInput?.maxBytes ?? DEFAULT_NATIVE_EVIDENCE_MAX_BYTES,
    'evidenceLimits.maxBytes',
    MIN_NATIVE_EVIDENCE_BYTES,
    MAX_NATIVE_EVIDENCE_BYTES,
  )
  const maxLines = assertBoundedInteger(
    evidenceLimitsInput?.maxLines ?? DEFAULT_NATIVE_EVIDENCE_MAX_LINES,
    'evidenceLimits.maxLines',
    MIN_NATIVE_EVIDENCE_LINES,
    MAX_NATIVE_EVIDENCE_LINES,
  )
  return deepFreeze({
    toolPolicy: toolPolicyValue as NativeToolPolicy,
    workspaceRoot,
    workspaceRootSource: explicitRoot === undefined ? 'process.cwd' : 'explicit',
    approval: approvalValue as NativeApprovalMode,
    rules: resolveRules(
      input === undefined ? undefined : (input as NativeSecurityConfig).rules,
      toolPolicyValue as NativeToolPolicy,
    ),
    evidenceLimits: { maxBytes, maxLines },
  })
}

function assertRuntime(runtime: NativePolicyRuntimeIdentity): void {
  if (!isRecord(runtime)) throw new Error('native security runtime identity must be an object')
  if (typeof runtime.adapterVersion !== 'string' || runtime.adapterVersion.length === 0) {
    throw new Error('native security runtime adapterVersion must be non-empty')
  }
  if (CONTROL_BYTES.test(runtime.adapterVersion)) throw new Error('native security runtime adapterVersion contains a control byte')
  if (runtime.connectorTransport !== undefined
    && runtime.connectorTransport !== 'text' && runtime.connectorTransport !== 'mcp') {
    throw new Error('native security runtime connectorTransport is invalid')
  }
  if (runtime.connectorRuntime !== 'external' && runtime.connectorRuntime !== 'managed') {
    throw new Error('native security runtime connectorRuntime is invalid')
  }
  if (typeof runtime.connectorName !== 'string' || runtime.connectorName.length === 0 || CONTROL_BYTES.test(runtime.connectorName)) {
    throw new Error('native security runtime connectorName is invalid')
  }
  assertSafePath(runtime.brokerSocketPath, 'runtime brokerSocketPath')
  assertSafePath(runtime.nativeRuntimeConfigPath, 'runtime nativeRuntimeConfigPath')
  if (runtime.mcpInvocationTimeoutMs !== undefined) {
    assertBoundedInteger(runtime.mcpInvocationTimeoutMs, 'runtime mcpInvocationTimeoutMs', 1, 2_147_483_647)
  }
  if (!isAbsolute(runtime.brokerSocketPath) || !isAbsolute(runtime.nativeRuntimeConfigPath)) {
    throw new Error('native security runtime paths must be absolute')
  }
  if (runtime.managedTunnelClient !== undefined) {
    if (!isRecord(runtime.managedTunnelClient)
      || typeof runtime.managedTunnelClient.version !== 'string'
      || typeof runtime.managedTunnelClient.sha256 !== 'string') {
      throw new Error('native security managed tunnel identity is invalid')
    }
  }
}

function cloneGenerateOptions(
  options: GenerateOptions,
  tools: readonly ToolSchema[] | undefined,
): GenerateOptions {
  const copy = {
    provider: options.provider,
    model: options.model,
    messages: deepFreeze(structuredClone(options.messages)),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(tools === undefined ? {} : { tools: deepFreeze(structuredClone(tools)) }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: deepFreeze(structuredClone(options.stop)) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  }
  return Object.freeze(copy) as GenerateOptions
}

function effectiveTools(
  config: ResolvedNativeSecurityConfig,
  tools: readonly ToolSchema[],
): readonly ToolSchema[] {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || tool.name.length === 0) throw new Error('native security inventory contains an invalid tool name')
    if (seen.has(tool.name)) throw new Error(`native security inventory contains duplicate tool: ${tool.name}`)
    seen.add(tool.name)
  }
  if (config.toolPolicy === 'full') return tools
  const allowed = new Set(config.rules.map(rule => rule.tool))
  return tools.filter(tool => allowed.has(tool.name))
}

function detachedArguments(args: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (!isRecord(args)) throw new Error('native tool arguments must be an object')
  return deepFreeze(structuredClone(args)) as Readonly<Record<string, unknown>>
}

function policyDenial(message: string): NativeInvocationDecision {
  return { allowed: false, code: 'NATIVE_POLICY_DENIED', message }
}

function policyRoundFor(
  config: ResolvedNativeSecurityConfig,
  boundary: ReturnType<typeof createWorkspaceBoundary> | undefined,
  tools: readonly ToolSchema[],
): NativePolicyRound {
  const toolSnapshot = deepFreeze(structuredClone(tools)) as readonly ToolSchema[]
  const schemas = new Map(toolSnapshot.map(tool => [tool.name, tool]))
  const schemaHashes = new Map(toolSnapshot.map(tool => [
    tool.name,
    hashCanonical('native-tool-schema', NATIVE_POLICY_FORMAT_VERSION, tool),
  ]))
  const rules = new Map(config.rules.map(rule => [rule.tool, rule]))

  const authorizeInvocation = (
    tool: string,
    args: Record<string, unknown>,
    callOrdinal: number,
  ): NativeInvocationDecision => {
    if (typeof tool !== 'string' || schemas.has(tool) === false) {
      return policyDenial('native policy denied this tool invocation')
    }
    if (!Number.isSafeInteger(callOrdinal) || callOrdinal < 1) {
      return policyDenial('native policy denied an invalid call ordinal')
    }
    const schemaHash = schemas.get(tool) === undefined ? undefined : schemaHashes.get(tool)
    if (schemaHash === undefined) return policyDenial('native policy denied this tool invocation')
    try {
      if (config.toolPolicy === 'full') {
        const argumentsValue = detachedArguments(args)
        return {
          allowed: true,
          arguments: argumentsValue,
          binding: deepFreeze({
            toolName: tool,
            capability: 'full-unrestricted' as const,
            resultPolicy: 'raw-unbounded' as const,
            schemaHash,
            argumentsHash: hashCanonical('native-tool-arguments', 1, argumentsValue),
            callOrdinal,
            pathArguments: Object.freeze([]),
          }),
        }
      }
      const rule = rules.get(tool)
      if (rule === undefined || boundary === undefined) {
        return policyDenial('native policy denied this tool invocation')
      }
      const rewritten = rule.pathArguments.length === 0
        ? { arguments: detachedArguments(args), argumentsHash: hashCanonical('native-tool-arguments', 1, args) }
        : boundary.rewriteArguments(args, rule.pathArguments)
      return {
        allowed: true,
        arguments: rewritten.arguments,
        binding: deepFreeze({
          toolName: tool,
          capability: rule.capability,
          resultPolicy: rule.result,
          schemaHash,
          argumentsHash: rewritten.argumentsHash,
          callOrdinal,
          pathArguments: Object.freeze([...rule.pathArguments]),
        }),
      }
    } catch {
      // Do not return a path, argument, or filesystem detail to the provider.
      return policyDenial('native policy denied this tool invocation')
    }
  }

  const projectResult = (binding: NativeCallPolicyBinding, result: BrokerToolResult): BrokerToolResult => {
    const schemaHash = schemaHashes.get(binding.toolName)
    if (schemaHash === undefined || schemaHash !== binding.schemaHash) {
      throw new Error('native policy binding schema is not part of this round')
    }
    if (config.toolPolicy === 'full') {
      if (binding.capability !== 'full-unrestricted' || binding.resultPolicy !== 'raw-unbounded') {
        throw new Error('native policy full binding is invalid')
      }
      return structuredClone(result)
    }
    const rule = rules.get(binding.toolName)
    if (rule === undefined || binding.capability !== rule.capability || binding.resultPolicy !== rule.result) {
      throw new Error('native policy binding is no longer valid')
    }
    return projectNativeToolResult(result, {
      resultPolicy: rule.result,
      maxBytes: config.evidenceLimits.maxBytes,
      maxLines: config.evidenceLimits.maxLines,
      homeDirectory: homedir(),
    })
  }

  return Object.freeze({ authorizeInvocation, projectResult })
}

function projectSecureMessages(
  messages: readonly Message[],
  round: NativePolicyRound,
  boundary: ReturnType<typeof createWorkspaceBoundary>,
): readonly Message[] {
  const projected = structuredClone(messages) as Message[]
  const bindings = new Map<string, NativeCallPolicyBinding>()
  const seenCallIds = new Set<string>()
  let callOrdinal = 1
  try {
    for (const message of projected) {
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          if (message.role !== 'assistant') throw new Error('tool call is not in an assistant message')
          const callId = String(block.id)
          if (seenCallIds.has(callId)) throw new Error('tool call id is duplicated')
          let parsed: unknown
          try { parsed = JSON.parse(block.arguments) } catch { throw new Error('tool call arguments are not JSON') }
          if (!isRecord(parsed)) throw new Error('tool call arguments are not an object')
          const decision = round.authorizeInvocation(block.name, parsed, callOrdinal)
          if (!decision.allowed) throw new Error('historical tool call is not authorized')
          const providerArguments = decision.binding.pathArguments.length === 0
            ? decision.arguments
            : boundary.rebaseProviderArguments(decision.arguments, decision.binding.pathArguments)
          block.arguments = canonicalJson(providerArguments)
          bindings.set(callId, decision.binding)
          seenCallIds.add(callId)
          callOrdinal += 1
        }
      }
      const resultBlocks = message.content.filter(block => block.type === 'tool-result')
      if (resultBlocks.length > 0) {
        if (message.source.kind !== 'tool' || message.content.length !== 1 || resultBlocks.length !== 1) {
          throw new Error('historical tool result identity is malformed')
        }
        const block = resultBlocks[0]!
        if (block.type !== 'tool-result' || String(block.toolCallId) !== String(message.source.callId)) {
          throw new Error('historical tool result identity is malformed')
        }
        const binding = bindings.get(String(block.toolCallId))
        if (binding === undefined) throw new Error('historical tool result is orphaned')
        const projectedResult = round.projectResult(binding, {
          content: structuredClone(block.content),
          isError: block.isError === true,
        })
        block.content = structuredClone(projectedResult.content) as ContentBlock[]
        block.isError = projectedResult.isError
        bindings.delete(String(block.toolCallId))
      }
    }
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw new NativeSafetyError('native provider history could not be safely projected', error, 'NATIVE_HISTORY_PROJECTION')
  }
  return deepFreeze(projected)
}

function summaryFor(
  config: ResolvedNativeSecurityConfig,
  runtime: NativePolicyRuntimeIdentity,
  tools: readonly ToolSchema[],
  workspaceRoot = config.workspaceRoot,
): NativePolicySummary {
  const rules = new Map(config.rules.map(rule => [rule.tool, rule]))
  const summaryTools = tools.map(tool => {
    const schemaHash = hashCanonical('native-tool-schema', NATIVE_POLICY_FORMAT_VERSION, tool)
    const rule = rules.get(tool.name)
    if (rule === undefined) {
      return {
        tool: tool.name,
        capability: 'full-unrestricted' as NativeEffectiveCapability,
        pathArguments: Object.freeze([]),
        result: 'raw-unbounded' as NativeEffectiveResultPolicy,
        outputProvenance: 'unverified-full' as const,
        schemaHash,
      }
    }
    return {
      tool: tool.name,
      capability: rule.capability,
      pathArguments: Object.freeze([...rule.pathArguments]),
      result: rule.result,
      outputProvenance: 'operator-declared' as const,
      schemaHash,
    }
  })
  return deepFreeze({
    policyImplementationVersion: runtime.adapterVersion,
    toolPolicy: config.toolPolicy,
    workspaceRoot,
    workspaceRootSource: config.workspaceRootSource,
    connectorName: runtime.connectorName,
    connectorRuntime: runtime.connectorRuntime,
    approval: config.approval,
    tools: summaryTools,
    evidenceLimits: { ...config.evidenceLimits },
  })
}

/** Compile the immutable policy/config snapshot used by later native tasks. */
export function compileNativeSecurityPolicy(
  config: ResolvedNativeSecurityConfig,
  privatePaths: readonly string[],
): CompiledNativeSecurityPolicy {
  const configSnapshot = deepFreeze(structuredClone(config))
  const privatePathSnapshot = Object.freeze([...new Set(privatePaths.map(path => assertSafePath(path, 'private path')))].sort())
  const workspaceBoundary = configSnapshot.toolPolicy === 'full'
    ? undefined
    : createWorkspaceBoundary(configSnapshot, privatePathSnapshot)
  const policyHash = hashCanonical('native-policy', NATIVE_POLICY_FORMAT_VERSION, {
    config: configSnapshot,
    canonicalWorkspace: workspaceBoundary?.canonicalRoot ?? configSnapshot.workspaceRoot,
    privatePaths: privatePathSnapshot,
    sensitiveRules: workspaceBoundary?.sensitiveDigest ?? hashCanonical(
      'native-sensitive-rules',
      BUILT_IN_SENSITIVE_RULE_VERSION,
      { privatePaths: privatePathSnapshot },
    ),
    ignoreDigest: workspaceBoundary?.ignoreDigest ?? hashCanonical('native-ignore', 1, { present: false }),
    sanitizer: NATIVE_SANITIZER_FORMAT_VERSION,
  })

  const compiled: CompiledNativeSecurityPolicy = {
    config: configSnapshot,
    workspaceRoot: workspaceBoundary?.canonicalRoot ?? configSnapshot.workspaceRoot,
    policyHash,
    ...(workspaceBoundary === undefined ? {} : { workspaceBoundary }),
    prepareRequest(options, runtime): PreparedNativeRequest {
      assertRuntime(runtime)
      const inputTools = options.tools ?? []
      const allTools = effectiveTools(configSnapshot, inputTools)
      const secureAuxiliary = configSnapshot.toolPolicy !== 'full'
        && (options.purpose === 'session-title' || options.purpose === 'compaction')
      const providerTools = configSnapshot.toolPolicy === 'full'
        ? options.tools
        : secureAuxiliary ? [] : allTools
      const inventoryTools = secureAuxiliary ? [] : allTools
      const inventoryHash = hashCanonical('native-tool-inventory', NATIVE_POLICY_FORMAT_VERSION, inventoryTools)
      const approvalHash = hashCanonical('native-approval', NATIVE_POLICY_FORMAT_VERSION, {
        policyHash,
        inventoryHash,
        adapterVersion: runtime.adapterVersion,
        connectorTransport: runtime.connectorTransport,
        connectorRuntime: runtime.connectorRuntime,
        connectorName: runtime.connectorName,
        ...(runtime.managedTunnelClient === undefined ? {
          externalRuntime: {
            brokerSocketPath: runtime.brokerSocketPath,
            nativeRuntimeConfigPath: runtime.nativeRuntimeConfigPath,
            mcpInvocationTimeoutMs: runtime.mcpInvocationTimeoutMs ?? null,
          },
        } : { managedTunnelClient: runtime.managedTunnelClient }),
      })
      const projectProviderMessages = configSnapshot.toolPolicy === 'full'
        ? (messages: readonly Message[]): readonly Message[] => deepFreeze(structuredClone(messages))
        : (messages: readonly Message[]): readonly Message[] => projectSecureMessages(
          messages,
          policyRoundFor(configSnapshot, workspaceBoundary, inventoryTools),
          workspaceBoundary!,
        )
      const projectedMessages = projectProviderMessages(options.messages)
      const providerInput = { ...options, messages: [...projectedMessages] }
      const nativeRound: PreparedNativeRound | undefined = !secureAuxiliary
        && (configSnapshot.toolPolicy === 'full' || inventoryTools.length > 0)
        && options.sessionId !== undefined
        ? (() => {
            const sessionId = String(options.sessionId)
            const coordinatorSnapshot: NativeCoordinatorSnapshot = deepFreeze({
              sessionId,
              canonicalMessages: structuredClone(options.messages),
              broker: {
                sessionId,
                tools: structuredClone(inventoryTools),
                invocationTimeoutMs: runtime.mcpInvocationTimeoutMs ?? 90_000,
              },
              policyHash,
              inventoryHash,
              approvalHash,
            })
            return Object.freeze({
              coordinatorSnapshot,
              openRound: () => policyRoundFor(configSnapshot, workspaceBoundary, inventoryTools),
            })
          })()
        : undefined
      return deepFreeze({
        providerOptions: cloneGenerateOptions(providerInput, providerTools),
        projectProviderMessages,
        policyHash,
        inventoryHash,
        approvalHash,
        summary: summaryFor(configSnapshot, runtime, inventoryTools, workspaceBoundary?.canonicalRoot),
        ...(nativeRound === undefined ? {} : { nativeRound }),
      })
    },
  }
  return Object.freeze(compiled)
}
