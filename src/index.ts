/**
 * Cordis plugin: register a {@link ChatGptWebAdapter} for the `chatgpt-web`
 * provider route on `ctx.llm`.
 *
 * The adapter owns its Chromium (system Chrome + a plugin profile directory
 * holding the ChatGPT login session). Connection facts are resolved once per
 * operation, so a changed profile or timeout reaches the next request while
 * an in-flight turn keeps the facts it started with.
 * @module dsh-llm-chatgpt-web
 */

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  ChatGptWebAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DAEMON_IDLE_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
} from './adapter.ts'
import type { ChatGptWebCatalogModel, ChatGptWebConnectionOptions } from './adapter.ts'
import { defaultProfileDir, resolveChromeExecutable } from './chatgpt/launch.ts'
import type { ConnectorRuntime, NativeSecurityConfig } from './native/types.ts'
import { resolveNativeSecurityConfig } from './native/policy.ts'
import { defaultNativeRuntimeConfigPath } from './native/runtime-config.ts'
import {
  createNativePluginRuntime,
} from './native/plugin-runtime.ts'
import type { NativePluginRuntime } from './native/plugin-runtime.ts'

export { ChatGptWebAdapter } from './adapter.ts'
export type {
  ChatGptWebAdapterOptions,
  ChatGptWebCatalogModel,
  ChatGptWebConnectionOptions,
  ConnectorRuntime,
  ConnectorTransport,
} from './adapter.ts'
export { compilePrompt } from './chatgpt/prompt.ts'
export { NativeToolBroker } from './native/broker.ts'
export { NativeRoundCoordinator, correlateToolResults } from './native/coordinator.ts'
export {
  approveNativeChallenge,
  formatNativeApprovalChallenge,
  readNativeApprovalChallenge,
  requireNativeApproval,
  shellQuotePosix,
} from './native/grants.ts'
export {
  NativeApprovalRequiredError,
  NativePolicyDeniedError,
  NativeSafetyError,
} from './native/errors.ts'
export { durableAtomicWritePrivateFile, syncPrivateDirectory } from './native/private-files.ts'
export type { NativeRoundCleanup, NativeStepLease } from './native/coordinator.ts'
export type { WorkspaceBoundary } from './native/workspace-boundary.ts'
export type {
  BrokerRoundSnapshot,
  BrokerRpcError,
  NativeApprovalChallengeV1,
  NativeApprovalGrantV1,
  BrokerRpcResponse,
  BrokerToolRequest,
  BrokerToolResult,
  NativeApprovalMode,
  NativeCapability,
  NativeEffectiveCapability,
  NativeEffectiveResultPolicy,
  NativeEvidenceLimitsConfig,
  NativePolicyRuntimeIdentity,
  NativePolicySummary,
  NativeResultPolicy,
  NativeSecurityConfig,
  NativeToolPolicy,
  NativeToolRuleConfig,
  PreparedNativeRequest,
  ResolvedNativeSecurityConfig,
  ResolvedNativeToolRule,
} from './native/types.ts'

export const name = 'llm-chatgpt-web'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'chatgpt-web'

const DEFAULT_MODELS: ChatGptWebCatalogModel[] = [
  { id: 'chatgpt-web/luna', name: 'ChatGPT Web Luna', contextWindow: 1_050_000 },
  { id: 'chatgpt-web/think', name: 'ChatGPT Web Think', contextWindow: 1_050_000 },
  { id: 'chatgpt-web/light', name: 'ChatGPT Web Instant', contextWindow: 41_000 },
  { id: 'chatgpt-web/medium', name: 'ChatGPT Web Medium', contextWindow: 90_000 },
  { id: 'chatgpt-web/high', name: 'ChatGPT Web High', contextWindow: 90_000 },
  { id: 'chatgpt-web/extra-high', name: 'ChatGPT Web Extra High', contextWindow: 112_001 },
  { id: 'chatgpt-web/pro', name: 'ChatGPT Web Pro', contextWindow: 112_001 },
]

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]
const PATH_CONTROL_BYTES = /[\u0000-\u001f\u007f]/

/** Plugin config. Paths accept `~` (expanded) — never shared between users. */
export interface Config {
  /** Profile home for the ChatGPT login session; defaults to `~/.dsh-chatgpt-web`. */
  profileDir?: string
  /** System Chrome executable; omitted means auto-detect, then bundled Chromium. */
  chromeExecutablePath?: string
  /** Run turns headed (reserved; the daemon is always headed-hidden). */
  headed?: boolean
  /** Headed but placed off-screen (reserved; the daemon is always hidden). */
  offscreen?: boolean
  /** Daemon idle shutdown in ms (default 30 minutes; min 1 minute). */
  daemonIdleMs?: number
  /** Budget for the manual sign-in window (default 10 minutes). */
  loginTimeoutMs?: number
  /** Whole-turn budget (default 5 minutes). */
  turnTimeoutMs?: number
  /** No-output-growth budget while streaming (default 2 minutes). */
  stallTimeoutMs?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers. */
  models?: ChatGptWebCatalogModel[]
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /** Tool transport; text is the safe default, MCP is opt-in and Unix-only. */
  connectorTransport?: 'text' | 'mcp'
  /** Tunnel owner; external preserves the existing MCP deployment contract. */
  connectorRuntime?: ConnectorRuntime
  /** Managed runtime configuration path; defaults beside the profile. */
  nativeRuntimeConfigPath?: string
  /** Exact title of the ChatGPT connector used in native MCP mode. */
  connectorName?: string
  /** Optional private Unix socket path for the native broker. */
  brokerSocketPath?: string
  /** Native MCP call/round timeout in milliseconds. */
  mcpInvocationTimeoutMs?: number
  /** Native tool policy and workspace security controls. */
  nativeSecurity?: NativeSecurityConfig
}

const catalogModel: z<ChatGptWebCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config: z<Config> = z.object({
  profileDir: z.string().default(defaultProfileDir()),
  chromeExecutablePath: z.string(),
  headed: z.boolean().default(false),
  offscreen: z.boolean().default(true),
  daemonIdleMs: z.number().min(60_000).max(2_147_483_647).default(DEFAULT_DAEMON_IDLE_MS),
  loginTimeoutMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_LOGIN_TIMEOUT_MS),
  turnTimeoutMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_TURN_TIMEOUT_MS),
  stallTimeoutMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_STALL_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  retryPolicy: RetryPolicySchema,
  connectorTransport: z.union(['text', 'mcp'] as const).default('text'),
  connectorRuntime: z.union(['external', 'managed'] as const).default('external'),
  nativeRuntimeConfigPath: z.string(),
  connectorName: z.string(),
  brokerSocketPath: z.string(),
  mcpInvocationTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(90_000),
  nativeSecurity: z.object({
    toolPolicy: z.union(['full', 'evidence-only', 'allowlist'] as const),
    workspaceRoot: z.string(),
    approval: z.union(['none', 'workspace-policy'] as const),
    rules: z.array(z.object({
      tool: z.string(),
      capability: z.union([
        'workspace.read',
        'workspace.search',
        'git.read',
        'execution.read',
        'side-effect',
      ] as const),
      pathArguments: z.array(z.string()),
      result: z.union(['text', 'sanitized-evidence'] as const),
    })),
    evidenceLimits: z.object({
      maxBytes: z.number().step(1).min(1),
      maxLines: z.number().step(1).min(1),
    }),
  }),
})

function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.'
    return home + path.slice(1)
  }
  return path
}

function assertSafePathText(path: string, field: string): void {
  if (PATH_CONTROL_BYTES.test(path)) throw new Error(`llm-chatgpt-web: ${field} contains a control byte`)
}

/**
 * Derive a private, profile-specific Unix endpoint without exposing the
 * profile path or any credential-bearing configuration in logs.
 */
export function defaultBrokerSocketPath(profileDir: string): string {
  const profileFingerprint = createHash('sha256')
    .update(resolvePath(profileDir))
    .digest('hex')
    .slice(0, 24)
  const userFingerprint = createHash('sha256')
    .update(String(typeof process.getuid === 'function' ? process.getuid() : process.env['USER'] ?? 'user'))
    .digest('hex')
    .slice(0, 16)
  const relative = join(`dsh-${userFingerprint.slice(0, 8)}`, `b-${profileFingerprint.slice(0, 16)}.sock`)
  const candidate = join(tmpdir(), relative)
  // macOS temporary roots can be long enough to exceed the Unix-domain path
  // limit; /tmp remains a private-directory root and keeps the endpoint valid.
  return Buffer.byteLength(candidate) <= 103 ? candidate : join('/tmp', relative)
}

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly ChatGptWebCatalogModel[] | undefined): ChatGptWebCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-chatgpt-web: catalog model ids must be non-empty')
    if (!model.id.startsWith('chatgpt-web/')) {
      throw new Error(`llm-chatgpt-web: catalog model "${model.id}" must start with "chatgpt-web/"`)
    }
    if (seen.has(model.id)) throw new Error(`llm-chatgpt-web: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...(model.inputModalities ?? ['text'])],
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 */
export function resolveAdapterOptions(
  config: Config,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChatGptWebConnectionOptions {
  const profileDir = expandHome(config.profileDir ?? defaultProfileDir())
  assertSafePathText(profileDir, 'profileDir')
  const connectorTransport = config.connectorTransport ?? 'text'
  const connectorRuntime = config.connectorRuntime ?? 'external'
  if (connectorRuntime !== 'external' && connectorRuntime !== 'managed') {
    throw new Error('llm-chatgpt-web: connectorRuntime must be "external" or "managed"')
  }
  if (connectorRuntime === 'managed' && connectorTransport !== 'mcp') {
    throw new Error('llm-chatgpt-web: managed connectorRuntime requires connectorTransport "mcp"')
  }
  if (connectorRuntime === 'managed' && platform === 'win32') {
    throw new Error('llm-chatgpt-web: managed connectorRuntime is unsupported on win32')
  }
  if (connectorRuntime === 'managed' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error('llm-chatgpt-web: managed connectorRuntime is supported only on darwin or linux')
  }
  if (connectorRuntime === 'managed' && arch !== 'x64' && arch !== 'arm64') {
    throw new Error('llm-chatgpt-web: managed connectorRuntime is unsupported on this architecture')
  }
  if (connectorTransport !== 'text' && connectorTransport !== 'mcp') {
    throw new Error(`llm-chatgpt-web: connectorTransport must be "text" or "mcp"`)
  }
  const suppliedConnectorName = config.connectorName
  const connectorName = suppliedConnectorName === undefined
    ? 'DSH Native'
    : suppliedConnectorName.trim()
  if (connectorTransport === 'mcp' && connectorName.length === 0) {
    throw new Error('llm-chatgpt-web: connectorName must be non-empty in MCP mode')
  }
  if (connectorTransport === 'mcp' && platform === 'win32') {
    throw new Error('llm-chatgpt-web: connectorTransport "mcp" is unsupported on win32; use text transport')
  }
  const mcpInvocationTimeoutMs = config.mcpInvocationTimeoutMs ?? 90_000
  if (!Number.isSafeInteger(mcpInvocationTimeoutMs) || mcpInvocationTimeoutMs < 1 || mcpInvocationTimeoutMs > 2_147_483_647) {
    throw new Error('llm-chatgpt-web: mcpInvocationTimeoutMs must be a positive safe integer no greater than 2147483647')
  }
  const brokerSocketPath = expandHome(config.brokerSocketPath ?? defaultBrokerSocketPath(profileDir))
  assertSafePathText(brokerSocketPath, 'brokerSocketPath')
  const nativeRuntimeConfigPath = expandHome(
    config.nativeRuntimeConfigPath ?? defaultNativeRuntimeConfigPath(profileDir),
  )
  assertSafePathText(nativeRuntimeConfigPath, 'nativeRuntimeConfigPath')
  const nativeSecurity = resolveNativeSecurityConfig(config.nativeSecurity)
  if (connectorTransport === 'mcp' && !isAbsolute(brokerSocketPath)) {
    throw new Error('llm-chatgpt-web: brokerSocketPath must be an absolute Unix socket path in MCP mode')
  }
  if (connectorTransport === 'mcp' && Buffer.byteLength(brokerSocketPath) > 103) {
    throw new Error('llm-chatgpt-web: brokerSocketPath exceeds the 103-byte Unix socket path limit')
  }
  if (connectorRuntime === 'managed' && !isAbsolute(nativeRuntimeConfigPath)) {
    throw new Error('llm-chatgpt-web: nativeRuntimeConfigPath must be absolute in managed mode')
  }
  return {
    profileDir,
    chromeExecutablePath: config.chromeExecutablePath
      ? expandHome(config.chromeExecutablePath)
      : resolveChromeExecutable(),
    headed: config.headed ?? false,
    offscreen: config.offscreen ?? true,
    daemonIdleMs: config.daemonIdleMs ?? DEFAULT_DAEMON_IDLE_MS,
    loginTimeoutMs: config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    stallTimeoutMs: config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-chatgpt-web: retryPolicy'),
    connectorTransport,
    nativeSecurity,
    connectorRuntime,
    connectorName: connectorName || 'DSH Native',
    brokerSocketPath,
    nativeRuntimeConfigPath,
    mcpInvocationTimeoutMs,
  }
}

export function apply(ctx: Context, config: Config): void {
  const options = (): ChatGptWebConnectionOptions => resolveAdapterOptions(config)
  const resolved = options()
  let native: NativePluginRuntime | undefined
  if (resolved.connectorTransport === 'mcp') {
    native = createNativePluginRuntime(resolved)
  }

  const adapter = new ChatGptWebAdapter({
    options,
    ...(native === undefined ? {} : { native }),
  })
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  void registration
  if (native !== undefined) {
    ctx.on('agent/turn-stopping', async ({ agent }: { agent: Agent }) => {
      await adapter.stopNativeRound(String(agent.session.id))
    })
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      void adapter.stopNativeRound(String(session.id)).catch(() => {})
    })
  }
  // Revoke native rounds first: their cleanup callbacks own active pages and
  // iterators, so browser/endpoint disposal must not race them.
  ctx.effect(() => async () => {
    if (native !== undefined) await native.quiesce().catch(() => {})
    await adapter.dispose().catch(() => {})
    if (native === undefined) return
    await native.close().catch(() => {})
  })
}
