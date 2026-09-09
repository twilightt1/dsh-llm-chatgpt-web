import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveAdapterOptions } from '../src/index.ts'
import { NativeToolBroker } from '../src/native/broker.ts'
import type { NativeBrokerSocketServer } from '../src/native/broker-socket.ts'
import type { NativeRoundCoordinator } from '../src/native/coordinator.ts'
import type { ManagedNativeRuntimeConfig } from '../src/native/runtime-config.ts'
import {
  createNativePluginRuntime,
} from '../src/native/plugin-runtime.ts'
import type { NativePluginRuntimeDependencies } from '../src/native/plugin-runtime.ts'

function runtimeConfig(): ManagedNativeRuntimeConfig {
  return {
    version: 1,
    connectorName: 'DSH Native',
    tunnelClient: {
      path: '/tmp/dsh-native/bin/tunnel-client',
      version: '0.0.12',
      sha256: 'a'.repeat(64),
    },
    tunnel: {
      id: `tunnel_${'0'.repeat(32)}`,
      runtimeKeyFile: '/tmp/dsh-native/secrets/tunnel-runtime.key',
      profileDir: '/tmp/dsh-native/tunnel/profiles',
      profileName: 'dsh-chatgpt-web',
      alias: 'dsh-chatgpt-web',
    },
  }
}

function fakes(log: string[], options: {
  managed?: boolean
  failStart?: boolean
} = {}): {
  dependencies: NativePluginRuntimeDependencies
  broker: NativeToolBroker
} {
  const broker = new NativeToolBroker()
  const brokerClose = vi.spyOn(broker, 'close').mockImplementation(() => {
    log.push('broker.close')
  })
  void brokerClose
  const socket = {
    listen: vi.fn(async () => { log.push('socket.listen') }),
    close: vi.fn(async () => { log.push('socket.close') }),
  } as unknown as NativeBrokerSocketServer
  const coordinator = {
    dispose: vi.fn(async () => { log.push('coordinator.dispose') }),
  } as unknown as NativeRoundCoordinator
  const dependencies: NativePluginRuntimeDependencies = {
    createBroker: () => broker,
    createSocket: () => socket,
    createCoordinator: () => coordinator,
    loadConfig: vi.fn(() => runtimeConfig()),
    createTunnel: vi.fn(() => ({
      start: async () => {
        log.push('tunnel.start')
        if (options.failStart) throw new Error('tunnel start failed')
      },
      stop: async () => { log.push('tunnel.stop') },
    })),
    mcpEntrypoint: '/tmp/package/lib/mcp-main.js',
    nodeExecutable: '/usr/local/bin/node',
  }
  return { dependencies, broker }
}

async function connection(root: string, managed = true) {
  return resolveAdapterOptions({
    profileDir: root,
    connectorTransport: 'mcp',
    ...(managed ? { connectorRuntime: 'managed' as const } : {}),
    brokerSocketPath: join(root, 'broker.sock'),
  })
}

describe('native plugin runtime composition', () => {
  it('starts socket before managed tunnel and tears down in the safe order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-plugin-'))
    const log: string[] = []
    const { dependencies, broker } = fakes(log, { managed: true })
    const stack = createNativePluginRuntime(await connection(root), dependencies)

    await stack.ready
    await stack.quiesce()
    await stack.close()
    expect(log).toEqual([
      'socket.listen',
      'tunnel.start',
      'coordinator.dispose',
      'tunnel.stop',
      'socket.close',
      'broker.close',
    ])
    expect(dependencies.loadConfig).toHaveBeenCalledTimes(1)
    expect(dependencies.createTunnel).toHaveBeenCalledTimes(1)
    void broker
  })

  it('does not create a tunnel for externally owned MCP mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-plugin-'))
    const log: string[] = []
    const { dependencies } = fakes(log)
    const stack = createNativePluginRuntime(await connection(root, false), dependencies)
    await stack.ready
    expect(dependencies.loadConfig).not.toHaveBeenCalled()
    expect(dependencies.createTunnel).not.toHaveBeenCalled()
    await stack.quiesce()
    await stack.close()
  })

  it('does not start a tunnel after teardown begins before socket readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-plugin-'))
    const log: string[] = []
    let releaseListen!: () => void
    const listening = new Promise<void>(resolve => { releaseListen = resolve })
    const { dependencies: baseDependencies } = fakes(log, { managed: true })
    const socket = {
      listen: vi.fn(async () => {
        await listening
        log.push('socket.listen')
      }),
      close: vi.fn(async () => { log.push('socket.close') }),
    } as unknown as NativeBrokerSocketServer
    const dependencies: NativePluginRuntimeDependencies = {
      ...baseDependencies,
      createSocket: () => socket,
    }
    const stack = createNativePluginRuntime(await connection(root), dependencies)
    const quiescing = stack.quiesce()
    await new Promise(resolve => setImmediate(resolve))
    releaseListen()
    await Promise.all([stack.ready.catch(() => {}), quiescing])
    await stack.close()
    expect(log).not.toContain('tunnel.start')
    expect(log.filter(entry => entry === 'tunnel.stop')).toHaveLength(1)
  })

  it('retains readiness failure and keeps teardown idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-plugin-'))
    const log: string[] = []
    const { dependencies } = fakes(log, { managed: true, failStart: true })
    const stack = createNativePluginRuntime(await connection(root), dependencies)
    await expect(stack.ready).rejects.toThrow(/tunnel start failed/)
    await stack.quiesce()
    await stack.quiesce()
    await stack.close()
    await stack.close()
    expect(log.filter(entry => entry === 'tunnel.start')).toHaveLength(1)
    expect(log.filter(entry => entry === 'tunnel.stop')).toHaveLength(1)
  })

  it('rejects connection identity changes after the stack is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-plugin-'))
    const log: string[] = []
    const { dependencies } = fakes(log, { managed: true })
    const initial = await connection(root)
    const stack = createNativePluginRuntime(initial, dependencies)
    expect(() => stack.assertConnection({ ...initial, connectorName: 'Other Connector' }))
      .toThrow(/connector name/i)
    expect(() => stack.assertConnection({ ...initial, brokerSocketPath: join(root, 'other.sock') }))
      .toThrow(/broker/i)
    await stack.close()
  })
})
