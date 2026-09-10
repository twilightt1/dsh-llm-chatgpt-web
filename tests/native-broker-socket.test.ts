import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, statSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { NativeToolBroker } from '../src/native/broker.ts'
import { createBrokerRpcClient, NativeBrokerSocketServer } from '../src/native/broker-socket.ts'
import type {
  BrokerToolResult,
  NativeInvocationDecision,
  NativePolicyRound,
} from '../src/native/types.ts'

const tool: ToolSchema = {
  name: 'write',
  description: 'write a file',
  parameters: { type: 'object' },
}
const ok: BrokerToolResult = {
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
}
const activityId = 'activity_abcdefghijklmnop'

interface SocketHarness {
  readonly root: string
  readonly socketPath: string
  readonly broker: NativeToolBroker
  readonly server: NativeBrokerSocketServer
  readonly client: ReturnType<typeof createBrokerRpcClient>
  readonly requestId: string
  close(): Promise<void>
}

async function createSocketHarness(options: { tool: ToolSchema } = { tool }): Promise<SocketHarness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
  chmodSync(root, 0o700)
  const socketPath = join(root, 'broker.sock')
  const broker = new NativeToolBroker()
  const server = new NativeBrokerSocketServer(socketPath, broker)
  await server.listen()
  const client = createBrokerRpcClient(socketPath)
  const requestId = broker.register({
    sessionId: 's1', tools: [options.tool], invocationTimeoutMs: 1_000, ttlMs: 1_000,
  })
  return {
    root,
    socketPath,
    broker,
    server,
    client,
    requestId,
    async close(): Promise<void> {
      await server.close().catch(() => {})
      broker.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

afterEach(() => {})

describe('NativeBrokerSocketServer', () => {
  it('holds invoke RPC until the owner completes the matching call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const broker = new NativeToolBroker()
    const server = new NativeBrokerSocketServer(socketPath, broker)
    await server.listen()
    try {
      const rpc = createBrokerRpcClient(socketPath)
      const requestId = broker.register({
        sessionId: 's1', tools: [tool], invocationTimeoutMs: 1_000, ttlMs: 1_000,
      })
      await rpc.start(requestId)
      await rpc.claim(requestId, activityId)
      const result = rpc.invoke(
        requestId, activityId, 'write', { path: 'x' }, 1_000,
      )
      await new Promise(resolve => setTimeout(resolve, 20))
      const call = broker.takeToolBatch(requestId, Date.now() + 100)?.[0]
      expect(call?.name).toBe('write')
      broker.beginSettlement(requestId)
      broker.completeTool(requestId, call!.callId, ok)
      await expect(result).resolves.toEqual(ok)
      await rpc.completeActivity(requestId, activityId)
    } finally {
      await server.close()
      broker.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns non-releasing policy denials and keeps the same request usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const broker = new NativeToolBroker()
    let deny = true
    const policy: NativePolicyRound = {
      authorizeInvocation(name, _args, ordinal): NativeInvocationDecision {
        if (deny) return { allowed: false, code: 'NATIVE_POLICY_DENIED', message: 'native policy denied' }
        return {
          allowed: true,
          arguments: {},
          binding: Object.freeze({
            toolName: name,
            capability: 'workspace.read',
            resultPolicy: 'text',
            schemaHash: 'a'.repeat(64),
            argumentsHash: 'b'.repeat(64),
            callOrdinal: ordinal,
            pathArguments: Object.freeze([]),
          }),
        }
      },
      projectResult(_binding, result) { return result },
    }
    const server = new NativeBrokerSocketServer(socketPath, broker)
    await server.listen()
    try {
      const client = createBrokerRpcClient(socketPath)
      const requestId = broker.register({
        sessionId: 's1', tools: [tool], invocationTimeoutMs: 1_000, ttlMs: 1_000, policyRound: policy,
      })
      await client.start(requestId)
      await client.claim(requestId, activityId)
      await expect(client.invoke(requestId, activityId, 'write', { path: '../escape' }, 1_000))
        .rejects.toMatchObject({ code: 'NATIVE_POLICY_DENIED', releaseRound: false })
      expect(broker.takeToolBatch(requestId, Date.now() + 100)).toBeUndefined()
      deny = false
      const pending = client.invoke(requestId, activityId, 'write', { path: 'ok' }, 1_000)
      await new Promise(resolve => setTimeout(resolve, 20))
      const call = broker.takeToolBatch(requestId, Date.now() + 100)?.[0]
      expect(call).toBeDefined()
      broker.completeTool(requestId, call!.callId, ok)
      await expect(pending).resolves.toEqual(ok)
      await client.completeActivity(requestId, activityId)
      await client.release(requestId)
    } finally {
      await server.close()
      broker.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates a private endpoint and refuses a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const broker = new NativeToolBroker()
    const server = new NativeBrokerSocketServer(socketPath, broker)
    await server.listen()
    expect(statSync(root).mode & 0o077).toBe(0)
    expect(statSync(socketPath).mode & 0o077).toBe(0)
    await server.close()
    symlinkSync(join(root, 'target'), socketPath)
    await expect(new NativeBrokerSocketServer(socketPath, broker).listen()).rejects.toThrow(/not a socket/i)
    broker.close()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a private-looking broker directory owned by another user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const broker = new NativeToolBroker()
    const currentUid = process.getuid?.()
    if (currentUid === undefined) {
      broker.close()
      await rm(root, { recursive: true, force: true })
      return
    }
    const originalGetuid = process.getuid
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => currentUid + 1 })
    try {
      await expect(new NativeBrokerSocketServer(socketPath, broker).listen())
        .rejects.toThrow(/owner|ownership|permissions/i)
    } finally {
      Object.defineProperty(process, 'getuid', { configurable: true, value: originalGetuid })
      broker.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not replace or unlink a live endpoint owned by another server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const firstBroker = new NativeToolBroker()
    const secondBroker = new NativeToolBroker()
    const firstServer = new NativeBrokerSocketServer(socketPath, firstBroker)
    const secondServer = new NativeBrokerSocketServer(socketPath, secondBroker)
    await firstServer.listen()
    try {
      await expect(secondServer.listen()).rejects.toThrow(/already owned|another process/i)
      await secondServer.close()
      expect(statSync(socketPath).isSocket()).toBe(true)
    } finally {
      await secondServer.close().catch(() => {})
      await firstServer.close()
      firstBroker.close()
      secondBroker.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims a same-user stale socket after a refused probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const stale = spawn(process.execPath, [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
      socketPath,
    ], { stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await once(stale.stdout!, 'data')
      chmodSync(socketPath, 0o600)
      stale.kill('SIGKILL')
      await once(stale, 'exit')
    } finally {
      stale.kill('SIGKILL')
    }
    expect(statSync(socketPath).isSocket()).toBe(true)

    const broker = new NativeToolBroker()
    const server = new NativeBrokerSocketServer(socketPath, broker)
    try {
      await expect(server.listen()).resolves.toBeUndefined()
      expect(statSync(socketPath).isSocket()).toBe(true)
    } finally {
      await server.close().catch(() => {})
      broker.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds malformed JSON lines and closes an aborted invoke socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-socket-'))
    chmodSync(root, 0o700)
    const socketPath = join(root, 'broker.sock')
    const broker = new NativeToolBroker()
    const server = new NativeBrokerSocketServer(socketPath, broker, { maxLineBytes: 32 })
    await server.listen()
    const socket = createConnection(socketPath)
    socket.write(`${'x'.repeat(33)}\n`)
    const [data] = await once(socket, 'data') as [Buffer]
    expect(JSON.parse(data.toString()).error).toMatchObject({
      code: 'BROKER_FAILURE',
      releaseRound: true,
      message: expect.stringMatching(/too large|json/i),
    })
    socket.destroy()
    await server.close()
    broker.close()
    await rm(root, { recursive: true, force: true })
  })

  it('retires the round when an invoke RPC loses its consumer', async () => {
    const harness = await createSocketHarness({ tool })
    try {
      const { broker, client, requestId } = harness
      await client.start(requestId)
      await client.claim(requestId, activityId)
      const controller = new AbortController()
      const invocation = expect(client.invoke(
        requestId,
        activityId,
        'write',
        { path: 'x' },
        1_000,
        controller.signal,
      )).rejects.toThrow(/abort/i)
      const retired = broker.waitForRetirement(requestId)
      controller.abort()
      await invocation
      await expect(retired).resolves.toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('rejects a socket path that exceeds the portable Unix limit', async () => {
    const broker = new NativeToolBroker()
    const path = join(tmpdir(), 'x'.repeat(120))
    await expect(new NativeBrokerSocketServer(path, broker).listen()).rejects.toThrow(/103-byte/i)
    broker.close()
  })
})
