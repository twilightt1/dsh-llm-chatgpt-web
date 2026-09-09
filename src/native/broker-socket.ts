import { randomBytes } from 'node:crypto'
import { existsSync, chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import type {
  BrokerRoundSnapshot,
  BrokerRpcResponse,
  BrokerToolResult,
} from './types.ts'
import { NativeToolBroker } from './broker.ts'

const MAX_UNIX_SOCKET_PATH_BYTES = 103
const MAX_LINE_BYTES = 64 * 1024 * 1024
const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_RPC_TIMEOUT_MS = 30_000

type BrokerRpcMethod = 'start' | 'claim' | 'activity_complete' | 'invoke' | 'release'

interface BrokerRpcRequest {
  readonly id: string
  readonly method: BrokerRpcMethod
  readonly request_id?: string
  readonly activity_id?: string
  readonly name?: string
  readonly arguments?: Record<string, unknown>
}

function rpcId(): string {
  return `rpc_${randomBytes(12).toString('base64url')}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

function timeoutError(message: string): Error {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Public RPC methods consumed by the stdio MCP façade. */
export interface BrokerRpcClient {
  start(requestId: string, signal?: AbortSignal): Promise<{ started: true; duplicate: boolean }>
  claim(requestId: string, activityId: string, signal?: AbortSignal): Promise<BrokerRoundSnapshot>
  completeActivity(requestId: string, activityId: string): Promise<void>
  invoke(
    requestId: string,
    activityId: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrokerToolResult>
  release(requestId: string): Promise<void>
}

/** A private one-request-per-connection Unix socket server around the broker. */
export class NativeBrokerSocketServer {
  private server: Server | undefined
  private listenPromise: Promise<void> | undefined
  private ownsEndpoint = false
  private readonly sockets = new Set<Socket>()
  private readonly maxLineBytes: number

  constructor(
    private readonly socketPath: string,
    private readonly broker: NativeToolBroker,
    options: { maxLineBytes?: number } = {},
  ) {
    const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > MAX_LINE_BYTES) {
      throw new Error(`native broker maxLineBytes must be a positive integer no greater than ${MAX_LINE_BYTES}`)
    }
    this.maxLineBytes = maxLineBytes
  }

  listen(): Promise<void> {
    if (this.listenPromise !== undefined) return this.listenPromise
    this.listenPromise = this.startListening()
    return this.listenPromise
  }

  async close(): Promise<void> {
    const pendingListen = this.listenPromise
    if (pendingListen !== undefined) await pendingListen.catch(() => {})
    const server = this.server
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error)
          } else {
            resolve()
          }
        })
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error
      })
    }
    if (this.ownsEndpoint) {
      this.ownsEndpoint = false
      try {
        const stat = lstatSync(this.socketPath)
        if (stat.isSocket()) {
          // Do not unlink a replacement process's endpoint if it won the
          // bind race after this server stopped listening.
          let stale = true
          try {
            await this.probeExistingEndpoint()
          } catch {
            stale = false
          }
          if (stale) {
            const current = lstatSync(this.socketPath)
            if (current.isSocket()) unlinkSync(this.socketPath)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.listenPromise = undefined
  }

  private async startListening(): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('native broker socket transport requires Unix sockets and is unsupported on win32')
    }
    if (!isAbsolute(this.socketPath)) throw new Error('native broker socket path must be absolute')
    const pathBytes = Buffer.byteLength(this.socketPath)
    if (pathBytes > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new Error(`native broker socket path is ${pathBytes} bytes, over the ${MAX_UNIX_SOCKET_PATH_BYTES}-byte Unix limit`)
    }
    const parentPath = dirname(this.socketPath)
    mkdirSync(parentPath, { recursive: true, mode: 0o700 })
    const parent = lstatSync(parentPath)
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
      throw new Error('unsafe broker directory permissions: expected a private directory')
    }
    let existing: ReturnType<typeof lstatSync> | undefined
    try {
      existing = lstatSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== undefined) {
      if (!existing.isSocket()) throw new Error('broker endpoint exists and is not a socket')
      if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
        throw new Error('broker endpoint is not owned by the current user')
      }
      if ((Number(existing.mode) & 0o077) !== 0) {
        throw new Error('broker endpoint has unsafe permissions')
      }
      await this.probeExistingEndpoint()
      let afterProbe: ReturnType<typeof lstatSync> | undefined
      try {
        afterProbe = lstatSync(this.socketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (afterProbe !== undefined) {
        if (!afterProbe.isSocket()) throw new Error('broker endpoint exists and is not a socket')
        if (typeof process.getuid === 'function' && afterProbe.uid !== process.getuid()) {
          throw new Error('broker endpoint is not owned by the current user')
        }
        if ((Number(afterProbe.mode) & 0o077) !== 0) {
          throw new Error('broker endpoint has unsafe permissions')
        }
        unlinkSync(this.socketPath)
      }
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer(socket => this.handleSocket(socket))
      this.server = server
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        this.ownsEndpoint = true
        try {
          chmodSync(this.socketPath, 0o600)
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.socketPath)
    }).catch((error: unknown) => {
      this.server = undefined
      if (this.ownsEndpoint) {
        try {
          if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath)
        } catch {
          // Preserve the listen error; cleanup is best effort.
        } finally {
          this.ownsEndpoint = false
        }
      }
      throw error
    })
  }

  private async probeExistingEndpoint(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(this.socketPath)
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        probe.destroy()
        action()
      }
      probe.setTimeout(2_000, () => finish(() => reject(new Error('timed out while probing existing broker endpoint'))))
      probe.once('connect', () => finish(() => reject(new Error('broker endpoint is already owned by another process'))))
      probe.once('error', error => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ECONNREFUSED' || code === 'ENOENT') {
          finish(resolve)
        } else {
          finish(() => reject(new Error(`could not probe existing broker endpoint: ${error.message}`)))
        }
      })
    })
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket)
    const disconnected = new AbortController()
    let settled = false
    let buffered = Buffer.alloc(0)
    const cleanup = (): void => {
      this.sockets.delete(socket)
      disconnected.abort()
    }
    socket.once('close', cleanup)
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffered = Buffer.concat([buffered, bytes])
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) {
        if (buffered.length > this.maxLineBytes) {
          settled = true
          this.writeResponse(socket, { id: 'unknown', error: 'native broker request line is too large' })
        }
        return
      }
      settled = true
      const line = buffered.subarray(0, newline)
      if (line.length > this.maxLineBytes) {
        this.writeResponse(socket, { id: 'unknown', error: 'native broker request line is too large' })
        return
      }
      let request: BrokerRpcRequest
      try {
        const parsed: unknown = JSON.parse(line.toString('utf8'))
        this.validateRequest(parsed)
        request = parsed
      } catch (error) {
        this.writeResponse(socket, { id: 'unknown', error: errorMessage(error) })
        return
      }
      void this.dispatch(request, disconnected.signal).then(
        result => this.writeResponse(socket, { id: request.id, result }),
        error => this.writeResponse(socket, { id: request.id, error: errorMessage(error) }),
      )
    })
  }

  private writeResponse(socket: Socket, response: BrokerRpcResponse<unknown>): void {
    if (socket.destroyed) return
    const line = `${JSON.stringify(response)}\n`
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      socket.end(`${JSON.stringify({ id: response.id, error: 'native broker response is too large' })}\n`)
      return
    }
    socket.end(line)
  }

  private validateRequest(value: unknown): asserts value is BrokerRpcRequest {
    if (!isRecord(value)
      || typeof value.id !== 'string'
      || value.id.length < 1
      || value.id.length > 256
      || typeof value.method !== 'string'
      || !['start', 'claim', 'activity_complete', 'invoke', 'release'].includes(value.method)) {
      throw new Error('native broker request is invalid')
    }
  }

  private async dispatch(request: BrokerRpcRequest, socketSignal: AbortSignal): Promise<unknown> {
    switch (request.method) {
      case 'start':
        return this.broker.start(this.requiredString(request.request_id, 'request_id'))
      case 'claim':
        return this.broker.claimActivity(
          this.requiredString(request.request_id, 'request_id'),
          this.requiredString(request.activity_id, 'activity_id'),
        )
      case 'activity_complete':
        this.broker.completeActivity(
          this.requiredString(request.request_id, 'request_id'),
          this.requiredString(request.activity_id, 'activity_id'),
        )
        return { completed: true }
      case 'release':
        this.broker.revoke(
          this.requiredString(request.request_id, 'request_id'),
          new Error('native broker round released by MCP consumer'),
        )
        return { released: true }
      case 'invoke': {
        const requestId = this.requiredString(request.request_id, 'request_id')
        const activityId = this.requiredString(request.activity_id, 'activity_id')
        const name = this.requiredString(request.name, 'name')
        if (!isRecord(request.arguments)) throw new Error('native broker invoke arguments must be an object')
        const pending = this.broker.invoke(requestId, activityId, name, request.arguments)
        return await this.awaitConsumer(pending, requestId, socketSignal)
      }
    }
  }

  private async awaitConsumer(
    pending: Promise<BrokerToolResult>,
    requestId: string,
    signal: AbortSignal,
  ): Promise<BrokerToolResult> {
    if (signal.aborted) {
      this.broker.revoke(requestId, new Error('native broker invocation consumer aborted'))
      throw abortError('native broker invocation consumer aborted')
    }
    return await new Promise<BrokerToolResult>((resolve, reject) => {
      let done = false
      const finish = (action: () => void): void => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        action()
      }
      const onAbort = (): void => {
        this.broker.revoke(requestId, new Error('native broker invocation consumer aborted'))
        finish(() => reject(abortError('native broker invocation consumer aborted')))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        result => finish(() => resolve(result)),
        error => finish(() => reject(error)),
      )
    })
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000) {
      throw new Error(`native broker ${field} is required`)
    }
    return value
  }
}

/** Create an RPC client with one isolated connection per operation. */
export function createBrokerRpcClient(socketPath: string): BrokerRpcClient {
  const call = async <T>(
    method: BrokerRpcMethod,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
      throw new Error(`native broker RPC timeout must be a positive safe integer no greater than ${MAX_TIMER_MS}`)
    }
    if (signal?.aborted) throw abortError('native broker RPC aborted')
    const id = rpcId()
    return await new Promise<T>((resolve, reject) => {
      const socket = createConnection(socketPath)
      let settled = false
      let sent = false
      let buffered = ''
      const timer = setTimeout(() => {
        finishReject(timeoutError(`native broker RPC timed out after ${timeoutMs}ms`))
        socket.destroy()
      }, timeoutMs)
      timer.unref?.()
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.removeAllListeners()
      }
      const finishResolve = (value: T): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        finishReject(abortError('native broker RPC aborted'))
        socket.destroy()
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        sent = true
        socket.write(`${JSON.stringify({ id, method, ...fields })}\n`)
      })
      socket.on('data', (chunk: string) => {
        if (settled) return
        buffered += chunk
        if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
          finishReject(new Error('native broker response line is too large'))
          socket.destroy()
          return
        }
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        const line = buffered.slice(0, newline)
        let response: BrokerRpcResponse<T>
        try {
          const parsed: unknown = JSON.parse(line)
          if (!isRecord(parsed) || parsed.id !== id) throw new Error('native broker RPC response id mismatch')
          const hasResult = Object.hasOwn(parsed, 'result')
          const hasError = Object.hasOwn(parsed, 'error')
          if (hasResult === hasError) throw new Error('native broker RPC response must contain exactly one result or error')
          response = parsed as unknown as BrokerRpcResponse<T>
        } catch (error) {
          finishReject(new Error(errorMessage(error)))
          socket.destroy()
          return
        }
        if (response.error !== undefined) finishReject(new Error(response.error))
        else finishResolve(response.result as T)
        socket.destroy()
      })
      socket.once('error', error => {
        finishReject(error instanceof Error ? error : new Error(String(error)))
      })
      socket.once('close', () => {
        if (!settled && sent) finishReject(new Error('native broker socket closed before its response'))
      })
    })
  }

  const release = async (requestId: string): Promise<void> => {
    await call<{ released: boolean }>('release', { request_id: requestId }, undefined, 5_000)
      .then(() => undefined)
  }

  return {
    async start(requestId, signal) {
      const result = await call<{ started: boolean; duplicate: boolean }>('start', { request_id: requestId }, signal)
      if (result.started !== true || typeof result.duplicate !== 'boolean') throw new Error('native broker start response is invalid')
      return { started: true, duplicate: result.duplicate }
    },
    async claim(requestId, activityId, signal) {
      const result = await call<BrokerRoundSnapshot>('claim', {
        request_id: requestId,
        activity_id: activityId,
      }, signal)
      if (!isRecord(result) || typeof result.sessionId !== 'string' || !Array.isArray(result.tools)
        || !Number.isSafeInteger(result.invocationTimeoutMs)) {
        throw new Error('native broker claim response is invalid')
      }
      return result as unknown as BrokerRoundSnapshot
    },
    async completeActivity(requestId, activityId) {
      await call<{ completed: boolean }>('activity_complete', {
        request_id: requestId,
        activity_id: activityId,
      })
    },
    async invoke(requestId, activityId, name, args, timeoutMs, signal) {
      try {
        const result = await call<BrokerToolResult>('invoke', {
          request_id: requestId,
          activity_id: activityId,
          name,
          arguments: args,
        }, signal, timeoutMs)
        if (!isRecord(result) || !Array.isArray(result.content) || typeof result.isError !== 'boolean') {
          throw new Error('native broker invoke response is invalid')
        }
        return result as unknown as BrokerToolResult
      } catch (error) {
        await release(requestId).catch(() => {})
        throw error
      }
    },
    release,
  }
}
