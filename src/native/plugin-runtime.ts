import { fileURLToPath } from 'node:url'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ChatGptWebConnectionOptions } from '../adapter.ts'
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

export interface NativeRuntimeIdentity {
  readonly connectorTransport: ChatGptWebConnectionOptions['connectorTransport']
  readonly connectorRuntime: ChatGptWebConnectionOptions['connectorRuntime']
  readonly connectorName: string
  readonly brokerSocketPath: string
  readonly nativeRuntimeConfigPath: string
  readonly mcpInvocationTimeoutMs: number
}

export interface NativePluginRuntime {
  readonly broker: NativeToolBroker
  readonly socket: NativeBrokerSocketServer
  readonly coordinator: NativeRoundCoordinator
  readonly ready: Promise<void>
  assertConnection(connection: ChatGptWebConnectionOptions): void
  quiesce(): Promise<void>
  close(): Promise<void>
}

type TunnelRuntimeLike = Pick<ManagedTunnelRuntime, 'start' | 'stop'>
type TunnelRuntimeOptions = ConstructorParameters<typeof ManagedTunnelRuntime>[0]

export interface NativePluginRuntimeDependencies {
  readonly createBroker?: () => NativeToolBroker
  readonly createSocket?: (path: string, broker: NativeToolBroker) => NativeBrokerSocketServer
  readonly createCoordinator?: (broker: NativeToolBroker) => NativeRoundCoordinator
  readonly loadConfig?: typeof loadManagedNativeRuntimeConfig
  readonly createTunnel?: (options: TunnelRuntimeOptions) => TunnelRuntimeLike
  readonly nodeExecutable?: string
  readonly mcpEntrypoint?: string
  readonly run?: CommandRunner
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
  if (explicit !== undefined) {
    if (!isAbsolute(explicit) || /[\r\n\u0000]/.test(explicit)) {
      throw new ManagedRuntimeConfigurationError('MCP entrypoint must be an absolute path without newlines')
    }
    return explicit
  }
  const current = dirname(fileURLToPath(import.meta.url))
  const packageRoot = current.endsWith('/lib')
    ? resolve(current, '..')
    : resolve(current, '../..')
  const candidates = [join(current, 'mcp-main.js'), join(current, '../../lib/mcp-main.js')]
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
    throw new ManagedRuntimeConfigurationError('built lib/mcp-main.js resolves outside the package root')
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
  const runtimeIdentity = identity(connection)
  const loadConfig = dependencies.loadConfig ?? loadManagedNativeRuntimeConfig
  let managed: TunnelRuntimeLike | undefined
  let configurationError: ManagedRuntimeConfigurationError | undefined
  if (connection.connectorRuntime === 'managed') {
    try {
      const config = loadConfig(connection.nativeRuntimeConfigPath, { connectorName: connection.connectorName })
      managed = makeRuntime(dependencies, config, connection)
    } catch (error) {
      configurationError = configurationFailure(error)
    }
  }

  const ready = socket.listen().then(async () => {
    if (configurationError !== undefined) throw configurationError
    if (managed !== undefined) await managed.start()
  })
  void ready.catch(() => {})

  let quiescePromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  return {
    broker,
    socket,
    coordinator,
    ready,
    assertConnection(current: ChatGptWebConnectionOptions): void {
      const next = identity(current)
      const changes: string[] = []
      if (next.connectorRuntime !== runtimeIdentity.connectorRuntime) changes.push('connector runtime')
      if (next.connectorName !== runtimeIdentity.connectorName) changes.push('connector name')
      if (next.brokerSocketPath !== runtimeIdentity.brokerSocketPath) changes.push('broker socket')
      if (next.nativeRuntimeConfigPath !== runtimeIdentity.nativeRuntimeConfigPath) changes.push('runtime config path')
      if (next.mcpInvocationTimeoutMs !== runtimeIdentity.mcpInvocationTimeoutMs) changes.push('invocation timeout')
      if (changes.length > 0) {
        throw new ManagedRuntimeConfigurationError(`native runtime identity changed: ${changes.join(', ')}`)
      }
    },
    quiesce(): Promise<void> {
      if (quiescePromise !== undefined) return quiescePromise
      quiescePromise = (async () => {
        const errors: unknown[] = []
        try { await coordinator.dispose() } catch (error) { errors.push(error) }
        try { await managed?.stop() } catch (error) { errors.push(error) }
        if (errors.length > 0) throw new AggregateError(errors, 'native plugin runtime quiesce failed')
      })()
      return quiescePromise
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      closePromise = (async () => {
        const errors: unknown[] = []
        try { await socket.close() } catch (error) { errors.push(error) }
        try { broker.close() } catch (error) { errors.push(error) }
        if (errors.length > 0) throw new AggregateError(errors, 'native plugin runtime close failed')
      })()
      return closePromise
    },
  }
}

export { ManagedRuntimeTransportError }
