import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/native/process.ts'
import type { ManagedNativeRuntimeConfig } from '../src/native/runtime-config.ts'
import {
  ManagedRuntimeConfigurationError,
  ManagedRuntimeTransportError,
  ManagedTunnelRuntime,
  mcpCommand,
  parseTunnelStatus,
  redactTunnelDetail,
} from '../src/native/tunnel-runtime.ts'

function config(): ManagedNativeRuntimeConfig {
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

function result(stdout = '', status = 0, stderr = ''): CommandResult {
  return { status, stdout, stderr }
}

describe('managed tunnel command and diagnostics', () => {
  it('quotes an MCP command without credentials', () => {
    const command = mcpCommand({
      nodeExecutable: '/Applications/Node Runtime/bin/node',
      mcpEntrypoint: '/tmp/package/lib/mcp-main.js',
      brokerSocketPath: '/tmp/private/native broker.sock',
      platform: 'darwin',
    })
    expect(command).toContain("'/Applications/Node Runtime/bin/node'")
    expect(command).toContain("'/tmp/private/native broker.sock'")
    expect(command).toContain('mcp-main.js')
    expect(command).not.toMatch(/runtime-key|sk-/)
    expect(() => mcpCommand({
      nodeExecutable: '/tmp/node\ninvalid',
      mcpEntrypoint: '/tmp/mcp.js',
      brokerSocketPath: '/tmp/broker.sock',
      platform: 'darwin',
    })).toThrow(/newline/i)
  })

  it('redacts tunnel and key-shaped diagnostics', () => {
    const raw = 'tunnel_0123456789abcdef0123456789abcdef sk-exampleSecretValue123456789'
    expect(redactTunnelDetail(raw)).toBe('[tunnel-id] [redacted-key]')
    expect(redactTunnelDetail('request_abcdefghijklmnopqrstuvwxyz')).toBe('[redacted-request]')
    expect(redactTunnelDetail('x'.repeat(3_000))).toHaveLength(2_000)
  })

  it('parses only a fully healthy and ready runtime as ok', () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: true,
      healthy: true,
      ready: true,
    }), 0)).toMatchObject({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
    })
    expect(parseTunnelStatus(JSON.stringify({
      process_running: true,
      healthy: true,
      ready: false,
      runtime_state: 'starting',
      error: 'not ready',
    }), 0)).toMatchObject({
      ok: false,
      state: 'starting',
      detail: expect.stringContaining('not ready'),
    })
    expect(parseTunnelStatus('not json', 1)).toMatchObject({ ok: false, processRunning: false })
  })
})

describe('ManagedTunnelRuntime', () => {
  it('connects once, waits for readiness, and stops the configured alias idempotently', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    let statusCalls = 0
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args })
      if (args[1] === 'connect') return result(JSON.stringify({ running: true, healthy: true, ready: true }))
      if (args[1] === 'status') {
        statusCalls += 1
        return result(JSON.stringify({ process_running: true, healthy: true, ready: statusCalls > 1 }))
      }
      if (args[1] === 'stop') return result(JSON.stringify({ stopped: true }))
      return result('', 1, 'unexpected command')
    }
    const runtime = new ManagedTunnelRuntime({
      config: config(),
      nodeExecutable: '/usr/local/bin/node',
      mcpEntrypoint: '/tmp/package/lib/mcp-main.js',
      brokerSocketPath: '/tmp/dsh-native/broker.sock',
      run,
      readyTimeoutMs: 100,
      pollIntervalMs: 1,
    })

    await Promise.all([runtime.start(), runtime.start()])
    expect(calls.filter(call => call.args[1] === 'connect')).toHaveLength(1)
    expect(calls.find(call => call.args[1] === 'connect')?.args).toEqual([
      'runtimes', 'connect',
      '--alias', 'dsh-chatgpt-web',
      '--profile', 'dsh-chatgpt-web',
      '--profile-dir', '/tmp/dsh-native/tunnel/profiles',
      '--tunnel-client-bin', '/tmp/dsh-native/bin/tunnel-client',
      '--tunnel-id', `tunnel_${'0'.repeat(32)}`,
      '--runtime-api-key', 'file:/tmp/dsh-native/secrets/tunnel-runtime.key',
      '--mcp-command', expect.stringContaining('--broker-socket'),
      '--json',
    ])
    await Promise.all([runtime.stop(), runtime.stop()])
    expect(calls.filter(call => call.args[1] === 'stop')).toHaveLength(1)
  })

  it('waits for pending startup before issuing stop', async () => {
    const calls: string[] = []
    let statusCalls = 0
    const runtime = new ManagedTunnelRuntime({
      config: config(),
      nodeExecutable: '/tmp/node',
      mcpEntrypoint: '/tmp/mcp.js',
      brokerSocketPath: '/tmp/broker.sock',
      run: (_command, args) => {
        calls.push(args[1] ?? '')
        if (args[1] === 'connect') return result(JSON.stringify({ running: true, healthy: true, ready: true }))
        if (args[1] === 'status') {
          statusCalls += 1
          return result(JSON.stringify({ process_running: true, healthy: true, ready: statusCalls > 1 }))
        }
        return result(JSON.stringify({ stopped: true }))
      },
      readyTimeoutMs: 100,
      pollIntervalMs: 10,
    })

    const starting = runtime.start()
    await new Promise(resolve => setImmediate(resolve))
    const stopping = runtime.stop()
    await Promise.all([starting, stopping])
    expect(calls).toEqual(['connect', 'status', 'status', 'stop'])
  })

  it('surfaces a redacted transport failure when connect or readiness fails', async () => {
    const run: CommandRunner = (_command, args) => (
      args[1] === 'connect'
        ? result(`tunnel_${'0'.repeat(32)} sk-exampleSecretValue123456789`, 1)
        : result('', 0)
    )
    const runtime = new ManagedTunnelRuntime({
      config: config(),
      nodeExecutable: '/tmp/node',
      mcpEntrypoint: '/tmp/mcp.js',
      brokerSocketPath: '/tmp/broker.sock',
      run,
      readyTimeoutMs: 20,
      pollIntervalMs: 1,
    })
    await expect(runtime.start()).rejects.toBeInstanceOf(ManagedRuntimeTransportError)
    await expect(runtime.start()).rejects.toBeInstanceOf(ManagedRuntimeTransportError)
  })

  it('fails readiness after the bounded timeout and attempts cleanup', async () => {
    const calls: Array<readonly string[]> = []
    const runtime = new ManagedTunnelRuntime({
      config: config(),
      nodeExecutable: '/tmp/node',
      mcpEntrypoint: '/tmp/mcp.js',
      brokerSocketPath: '/tmp/broker.sock',
      run: (_command, args) => {
        calls.push(args)
        if (args[1] === 'connect') return result(JSON.stringify({ running: true, healthy: true }))
        if (args[1] === 'status') return result(JSON.stringify({
          process_running: true,
          healthy: false,
          ready: false,
          runtime_state: 'starting',
        }))
        return result(JSON.stringify({ stopped: true }))
      },
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    })
    await expect(runtime.start()).rejects.toThrow(/did not become ready/i)
    expect(calls.some(args => args[1] === 'stop')).toBe(true)
  })

  it('treats an absent alias as a successful stop', async () => {
    const runtime = new ManagedTunnelRuntime({
      config: config(),
      nodeExecutable: '/tmp/node',
      mcpEntrypoint: '/tmp/mcp.js',
      brokerSocketPath: '/tmp/broker.sock',
      run: (_command, args) => args[1] === 'stop'
        ? result('unknown alias dsh-chatgpt-web', 1)
        : result(''),
    })
    await expect(runtime.stop()).resolves.toBeUndefined()
  })

  it('exports distinct configuration and transport error classes', () => {
    expect(new ManagedRuntimeConfigurationError('bad').name).toBe('ManagedRuntimeConfigurationError')
    expect(new ManagedRuntimeTransportError('bad').name).toBe('ManagedRuntimeTransportError')
  })
})
