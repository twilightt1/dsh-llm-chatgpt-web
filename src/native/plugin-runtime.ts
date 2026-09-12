import { fileURLToPath } from 'node:url'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ChatGptWebConnectionOptions } from '../adapter.ts'
import { createOwnedConversationLedger } from '../chatgpt/conversation-cleanup.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { NativeBrokerSocketServer } from './broker-socket.ts'
import { NativeToolBroker } from './broker.ts'
import { NativeRoundCoordinator } from './coordinator.ts'
import {
  loadManagedNativeRuntimeConfig,
} from './runtime-config.ts'
import type { ManagedNativeRuntimeConfig } from './runtime-config.ts'
import {
  ManagedRuntimeConfigurationError,
  ManagedRuntimeTransportError,
  ManagedTunnelRuntime,
} from './tunnel-runtime.ts'
import type { CommandRunner } from './process.ts'
import { compileNativeSecurityPolicy } from './policy.ts'
import { writeNativeSecurityState } from './security-state.ts'
import { currentProcessStartedAt } from './private-files.ts'
import { createNativeCheckpointStore } from './checkpoint.ts'
import type {
  NativeCheckpointStore,
  PreparedNativeRequest,
  NativePolicyRuntimeIdentity,
  PrivateWriterLease,
} from './types.ts'

export interface NativeRuntimeIdentity {
  readonly connectorTransport: ChatGptWebConnectionOptions['connectorTransport']
  readonly connectorRuntime: ChatGptWebConnectionOptions['connectorRuntime']
  readonly connectorName: string
  readonly brokerSocketPath: string
  readonly nativeRuntimeConfigPath: string
  readonly mcpInvocationTimeoutMs: number
}

const NATIVE_POLICY_ADAPTER_VERSION = '0.7.0'

export interface NativePluginRuntime {
  readonly broker: NativeToolBroker
  readonly socket: NativeBrokerSocketServer
  readonly coordinator: NativeRoundCoordinator
  readonly checkpointStore: NativeCheckpointStore
  readonly ready: Promise<void>
  assertConnection(connection: ChatGptWebConnectionOptions): void
  prepareRequest(options: GenerateOptions, connection: ChatGptWebConnectionOptions): PreparedNativeRequest
  quiesce(): Promise<void>
  close(): Promise<void>
}

type TunnelRuntimeLike = Pick<ManagedTunnelRuntime, 'start' | 'stop'>
type TunnelRuntimeOptions = ConstructorParameters<typeof ManagedTunnelRuntime>[0]

export interface NativePluginRuntimeDependencies {
  readonly createBroker?: () => NativeToolBroker
  readonly createSocket?: (path: string, broker: NativeToolBroker) => NativeBrokerSocketServer
  readonly createCoordinator?: (broker: NativeToolBroker) => NativeRoundCoordinator
  readonly createCheckpointStore?: (profileDir: string) => NativeCheckpointStore
  readonly loadConfig?: typeof loadManagedNativeRuntimeConfig
  readonly createTunnel?: (options: TunnelRuntimeOptions) => TunnelRuntimeLike
  readonly nodeExecutable?: string
  readonly mcpEntrypoint?: string
  readonly run?: CommandRunner
  readonly warn?: (message: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function identity(connection: ChatGptWebConnectionOptions): NativeRuntimeIdentity {
  return {
    connectorTransport: connection.connectorTransport,
    connectorRuntime: connection.connectorRuntime,
    connectorName: connection.connectorName,
    brokerSocketPath: connection.brokerSocketPath,
    nativeRuntimeConfigPath: connection.nativeRuntimeConfigPath,
    mcpInvocationTimeoutMs: connection.mcpInvocationTimeoutMs,
  }
}

function resolveMcpEntrypoint(explicit: string | undefined): string {
  if (explicit !== undefined && (!isAbsolute(explicit) || /[\r\n\u0000]/.test(explicit))) {
    throw new ManagedRuntimeConfigurationError('MCP entrypoint must be an absolute path without newlines')
  }
  const current = dirname(fileURLToPath(import.meta.url))
  const packageRoot = current.endsWith('/lib')
    ? resolve(current, '..')
    : resolve(current, '../..')
  const candidates = explicit === undefined
    ? [join(current, 'mcp-main.js'), join(current, '../../lib/mcp-main.js')]
    : [explicit]
  const candidate = candidates.find(path => {
    try { return statSync(path).isFile() } catch { return false }
  })
  if (candidate === undefined) throw new ManagedRuntimeConfigurationError('built lib/mcp-main.js is missing; run pnpm build first')
  let realCandidate: string
  let realRoot: string
  try {
    realCandidate = realpathSync(candidate)
    realRoot = realpathSync(packageRoot)
  } catch {
    throw new ManagedRuntimeConfigurationError('built lib/mcp-main.js could not be resolved')
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}/`)) {
    throw new ManagedRuntimeConfigurationError('MCP entrypoint resolves outside the package root')
  }
  return realCandidate
}

function makeRuntime(
  dependencies: NativePluginRuntimeDependencies,
  config: ManagedNativeRuntimeConfig,
  connection: ChatGptWebConnectionOptions,
): TunnelRuntimeLike {
  const factory = dependencies.createTunnel ?? (options => new ManagedTunnelRuntime(options))
  return factory({
    config,
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    mcpEntrypoint: resolveMcpEntrypoint(dependencies.mcpEntrypoint),
    brokerSocketPath: connection.brokerSocketPath,
    ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
  })
}

function configurationFailure(error: unknown): ManagedRuntimeConfigurationError {
  return error instanceof ManagedRuntimeConfigurationError
    ? error
    : new ManagedRuntimeConfigurationError(`managed native runtime configuration failed: ${errorMessage(error)}`)
}

export function createNativePluginRuntime(
  connection: ChatGptWebConnectionOptions,
  dependencies: NativePluginRuntimeDependencies = {},
): NativePluginRuntime {
  if (connection.connectorTransport !== 'mcp') {
    throw new ManagedRuntimeConfigurationError('native plugin runtime requires MCP connectorTransport')
  }
  const broker = dependencies.createBroker?.() ?? new NativeToolBroker()
  const socket = dependencies.createSocket?.(connection.brokerSocketPath, broker)
    ?? new NativeBrokerSocketServer(connection.brokerSocketPath, broker)
  const coordinator = dependencies.createCoordinator?.(broker) ?? new NativeRoundCoordinator(broker)
  const checkpointStore = dependencies.createCheckpointStore?.(connection.profileDir)
    ?? createNativeCheckpointStore(connection.profileDir)
  let checkpointWriter: PrivateWriterLease | undefined
  let checkpointError: ManagedRuntimeConfigurationError | undefined
  try {
    checkpointWriter = checkpointStore.acquire()
    // Parse existing journals and ownership state before exposing the runtime.
    // With the lease held, a single crash-incomplete tail may be truncated;
    // malformed interior state still fails closed.
    checkpointStore.inspect()
    createOwnedConversationLedger(connection.profileDir).pending()
  } catch (error) {
    checkpointError = configurationFailure(error)
  }
  const runtimeIdentity = identity(connection)
  const loadConfig = dependencies.loadConfig ?? loadManagedNativeRuntimeConfig
  let managed: TunnelRuntimeLike | undefined
  let managedConfig: ManagedNativeRuntimeConfig | undefined
  let configurationError: ManagedRuntimeConfigurationError | undefined
  if (connection.connectorRuntime === 'managed') {
    try {
      const config = loadConfig(connection.nativeRuntimeConfigPath, { connectorName: connection.connectorName })
      managedConfig = config
      managed = makeRuntime(dependencies, config, connection)
    } catch (error) {
      configurationError = configurationFailure(error)
    }
  }

  const warn = dependencies.warn ?? ((message: string): void => { console.warn(message) })
  let secureFallbackRequestWarningIssued = false
  if (connection.nativeSecurity.toolPolicy !== 'full' && connection.nativeSecurity.workspaceRootSource === 'process.cwd') {
    warn('dsh-chatgpt-web native secure policy is using process.cwd as its workspace root; configure nativeSecurity.workspaceRoot explicitly')
  }
  let quiescing = false
  const heartbeat = checkpointWriter === undefined
    ? undefined
    : setInterval(() => {
        try { checkpointWriter?.heartbeat() } catch { /* the next request fails closed */ }
      }, 30_000)
  heartbeat?.unref?.()
  const ready = (async (): Promise<void> => {
    // Do not expose the broker endpoint until private state and managed
    // configuration have passed their fail-closed startup gates.
    if (checkpointError !== undefined) throw checkpointError
    if (configurationError !== undefined) throw configurationError
    if (quiescing) return
    await socket.listen()
    if (quiescing) return
    if (managed !== undefined) await managed.start()
  })()
  void ready.catch(() => {})

  let quiescePromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  const assertConnection = (current: ChatGptWebConnectionOptions): void => {
    const next = identity(current)
    const changes: string[] = []
    if (next.connectorTransport !== runtimeIdentity.connectorTransport) changes.push('connector transport')
    if (next.connectorRuntime !== runtimeIdentity.connectorRuntime) changes.push('connector runtime')
    if (next.connectorName !== runtimeIdentity.connectorName) changes.push('connector name')
    if (next.brokerSocketPath !== runtimeIdentity.brokerSocketPath) changes.push('broker socket')
    if (next.nativeRuntimeConfigPath !== runtimeIdentity.nativeRuntimeConfigPath) changes.push('runtime config path')
    if (next.mcpInvocationTimeoutMs !== runtimeIdentity.mcpInvocationTimeoutMs) changes.push('invocation timeout')
    if (changes.length > 0) {
      throw new ManagedRuntimeConfigurationError(`native runtime identity changed: ${changes.join(', ')}`)
    }
  }
  const prepareRequest = (options: GenerateOptions, current: ChatGptWebConnectionOptions): PreparedNativeRequest => {
    assertConnection(current)
    if (!secureFallbackRequestWarningIssued
      && current.nativeSecurity.toolPolicy !== 'full'
      && current.nativeSecurity.workspaceRootSource === 'process.cwd') {
      secureFallbackRequestWarningIssued = true
      warn('dsh-chatgpt-web native secure policy request is using process.cwd as its workspace root; configure nativeSecurity.workspaceRoot explicitly')
    }
    const policyRuntime: NativePolicyRuntimeIdentity = {
      adapterVersion: NATIVE_POLICY_ADAPTER_VERSION,
      connectorTransport: current.connectorTransport,
      connectorRuntime: current.connectorRuntime,
      connectorName: current.connectorName,
      brokerSocketPath: current.brokerSocketPath,
      nativeRuntimeConfigPath: current.nativeRuntimeConfigPath,
      mcpInvocationTimeoutMs: current.mcpInvocationTimeoutMs,
      ...(managedConfig === undefined ? {} : {
        managedTunnelClient: {
          version: managedConfig.tunnelClient.version,
          sha256: managedConfig.tunnelClient.sha256,
        },
      }),
    }
    const privatePaths = [
      current.profileDir,
      current.nativeRuntimeConfigPath,
      current.brokerSocketPath,
      ...(managedConfig === undefined ? [] : [
        managedConfig.tunnelClient.path,
        managedConfig.tunnel.runtimeKeyFile,
        managedConfig.tunnel.profileDir,
      ]),
    ]
    const prepared = compileNativeSecurityPolicy(current.nativeSecurity, privatePaths).prepareRequest(options, policyRuntime)
    writeNativeSecurityState(current.profileDir, prepared, {
      pid: process.pid,
      startedAt: currentProcessStartedAt(),
    })
    return prepared
  }
  const quiesce = (): Promise<void> => {
    if (quiescePromise !== undefined) return quiescePromise
    quiescePromise = (async () => {
      const errors: unknown[] = []
      quiescing = true
      try { await coordinator.dispose() } catch (error) { errors.push(error) }
      await ready.catch(() => {})
      try { await managed?.stop() } catch (error) { errors.push(error) }
      if (errors.length > 0) throw new AggregateError(errors, 'native plugin runtime quiesce failed')
    })()
    return quiescePromise
  }
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closePromise = (async () => {
      const errors: unknown[] = []
      try { await quiesce() } catch (error) { errors.push(error) }
      try { await socket.close() } catch (error) { errors.push(error) }
      try { broker.close() } catch (error) { errors.push(error) }
      heartbeat?.unref?.()
      if (heartbeat !== undefined) clearInterval(heartbeat)
      try { checkpointWriter?.release() } catch (error) { errors.push(error) }
      if (errors.length > 0) throw new AggregateError(errors, 'native plugin runtime close failed')
    })()
    return closePromise
  }
  return {
    broker,
    socket,
    coordinator,
    checkpointStore,
    ready,
    assertConnection,
    prepareRequest,
    quiesce,
    close,
  }
}

export { ManagedRuntimeTransportError }
