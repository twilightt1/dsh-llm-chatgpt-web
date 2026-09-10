import { createHash, randomBytes } from 'node:crypto'
import type {
  BrokerCallId,
  BrokerCompletedTool,
  BrokerRoundSnapshot,
  BrokerToolRequest,
  BrokerToolResult,
} from './types.ts'

const BATCH_WINDOW_MS = 15
const MAX_TIMER_MS = 2_147_483_647
const MAX_RETIRED_REQUESTS = 64

/** A deferred value with its settlement functions kept private to the broker. */
interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type RoundState = 'awaiting_start' | 'running' | 'settling'

interface PendingInvocation {
  readonly request: BrokerToolRequest
  readonly resolve: (result: BrokerToolResult) => void
  readonly reject: (error: Error) => void
}

interface Waiter<T> {
  readonly deferred: Deferred<T>
  readonly signal?: AbortSignal
  onAbort?: () => void
}

interface RoundChannel {
  state: RoundState
  readonly snapshot: BrokerRoundSnapshot
  readonly queued: BrokerCallId[]
  readonly delivered: BrokerCallId[]
  readonly invocations: Map<BrokerCallId, PendingInvocation>
  readonly completed: Map<BrokerCallId, string>
  readonly activities: Set<string>
  readonly completedActivities: Set<string>
  activityRevision: number
  completionRevision: number | undefined
  readonly retirement: Set<Waiter<void>>
  readonly quiescence: Set<Waiter<void>>
  expires: ReturnType<typeof setTimeout>
  readonly ttlMs: number
  batchReadyAt: number | undefined
}

function opaqueId(prefix: 'request' | 'call'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function cloneResult(result: BrokerToolResult): BrokerToolResult {
  return structuredClone(result)
}

function canonicalResult(result: BrokerToolResult): string {
  const canonical = JSON.stringify(cloneResult(result))
  if (canonical === undefined) throw new Error('broker tool result is not JSON serializable')
  return canonical
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function immutableSnapshot(input: BrokerRoundSnapshot): BrokerRoundSnapshot {
  return deepFreeze(structuredClone(input))
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

/**
 * In-memory owner-side broker for one native ChatGPT provider round.
 *
 * The MCP subprocess sees only the socket façade. The adapter/coordinator keep
 * this object in-process so tool calls retain ordinary DSH loop ownership.
 */
export class NativeToolBroker {
  private readonly rounds = new Map<string, RoundChannel>()
  private readonly retired = new Map<string, true>()
  private closed = false

  register(input: BrokerRoundSnapshot & { readonly ttlMs: number }): string {
    if (this.closed) throw new Error('native tool broker is closed')
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_TIMER_MS) {
      throw new Error(`native broker TTL must be a positive safe integer no greater than ${MAX_TIMER_MS}`)
    }
    if (!Number.isSafeInteger(input.invocationTimeoutMs) || input.invocationTimeoutMs <= 0 || input.invocationTimeoutMs > MAX_TIMER_MS) {
      throw new Error(`native broker invocation timeout must be a positive safe integer no greater than ${MAX_TIMER_MS}`)
    }
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
      throw new Error('native broker sessionId must be non-empty')
    }
    const requestId = opaqueId('request')
    const snapshot = immutableSnapshot({
      sessionId: input.sessionId,
      tools: input.tools,
      invocationTimeoutMs: input.invocationTimeoutMs,
    })
    const expires = setTimeout(() => {
      this.revoke(requestId, new Error('native broker round expired'))
    }, input.ttlMs)
    expires.unref?.()
    const channel: RoundChannel = {
      state: 'awaiting_start',
      snapshot,
      queued: [],
      delivered: [],
      invocations: new Map(),
      completed: new Map(),
      activities: new Set(),
      completedActivities: new Set(),
      activityRevision: 0,
      completionRevision: undefined,
      retirement: new Set(),
      quiescence: new Set(),
      expires,
      ttlMs: input.ttlMs,
      batchReadyAt: undefined,
    }
    this.rounds.set(requestId, channel)
    return requestId
  }

  /** Renew the inactivity lease while the owning browser round is polling. */
  touch(requestId: string): void {
    const channel = this.requireRound(requestId)
    if (channel.state === 'settling') return
    clearTimeout(channel.expires)
    channel.expires = setTimeout(() => {
      this.revoke(requestId, new Error('native broker round expired'))
    }, channel.ttlMs)
    channel.expires.unref?.()
  }

  start(requestId: string): { started: true; duplicate: boolean } {
    const channel = this.requireRound(requestId)
    if (channel.state === 'settling') throw new Error('native broker round is settling')
    if (channel.completionRevision !== undefined) throw new Error('native broker round is already complete')
    if (channel.state === 'running') return { started: true, duplicate: true }
    channel.state = 'running'
    channel.activityRevision += 1
    return { started: true, duplicate: false }
  }

  /** Return the monotonic semantic activity revision for browser liveness. */
  progressRevision(requestId: string): number {
    return this.requireRound(requestId).activityRevision
  }

  claimActivity(requestId: string, activityId: string): BrokerRoundSnapshot {
    const channel = this.requireRound(requestId)
    this.assertActivityId(activityId)
    if (channel.state !== 'running') {
      throw new Error(`native broker round cannot claim activity while ${channel.state}`)
    }
    if (channel.completionRevision !== undefined) throw new Error('native broker round is already complete')
    if (channel.completedActivities.has(activityId)) {
      throw new Error('native broker activity was already completed')
    }
    if (!channel.activities.has(activityId)) {
      channel.activities.add(activityId)
      channel.activityRevision += 1
    }
    return channel.snapshot
  }

  completeActivity(requestId: string, activityId: string): void {
    const channel = this.requireRound(requestId)
    this.assertActivityId(activityId)
    if (channel.completedActivities.has(activityId)) return
    channel.activities.delete(activityId)
    channel.completedActivities.add(activityId)
    channel.activityRevision += 1
    this.settleQuiescence(channel)
  }

  invoke(
    requestId: string,
    activityId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<BrokerToolResult> {
    const channel = this.requireRound(requestId)
    this.assertActivityId(activityId)
    if (channel.state !== 'running') return Promise.reject(new Error(`native broker round is ${channel.state}`))
    if (channel.completionRevision !== undefined) return Promise.reject(new Error('native broker round is complete'))
    if (!channel.activities.has(activityId)) return Promise.reject(new Error('native broker activity is not claimed'))
    if (!channel.snapshot.tools.some(tool => tool.name === name)) {
      return Promise.reject(new Error(`native broker tool is not advertised: ${name}`))
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return Promise.reject(new Error('native broker tool arguments must be an object'))
    }
    const callId = opaqueId('call') as BrokerCallId
    const request: BrokerToolRequest = deepFreeze({
      callId,
      name,
      arguments: structuredClone(args),
    })
    return new Promise<BrokerToolResult>((resolve, reject) => {
      channel.invocations.set(callId, { request, resolve, reject })
      channel.queued.push(callId)
      channel.activityRevision += 1
      channel.batchReadyAt ??= Date.now() + BATCH_WINDOW_MS
    })
  }

  takeToolBatch(requestId: string, now = Date.now()): readonly BrokerToolRequest[] | undefined {
    const channel = this.requireRound(requestId)
    if (channel.delivered.length > 0) return this.requestsFor(channel, channel.delivered)
    if (channel.queued.length === 0) return undefined
    if (channel.batchReadyAt !== undefined && now < channel.batchReadyAt) return undefined
    channel.batchReadyAt = undefined
    channel.delivered.push(...channel.queued.splice(0))
    channel.activityRevision += 1
    return this.requestsFor(channel, channel.delivered)
  }

  beginSettlement(requestId: string): void {
    const channel = this.requireRound(requestId)
    if (channel.state === 'settling') return
    channel.state = 'settling'
    channel.activityRevision += 1
    channel.batchReadyAt = undefined
    const queued = channel.queued.splice(0)
    const error = new Error('native broker round is settling')
    for (const callId of queued) {
      const invocation = channel.invocations.get(callId)
      if (invocation === undefined) continue
      channel.invocations.delete(callId)
      invocation.reject(error)
    }
    this.settleQuiescence(channel)
  }

  completeTool(requestId: string, callId: BrokerCallId, result: BrokerToolResult): void {
    const channel = this.requireRound(requestId)
    const canonical = canonicalResult(result)
    const previous = channel.completed.get(callId)
    if (previous !== undefined) {
      if (previous !== canonical) throw new Error(`native broker result conflict for ${String(callId)}`)
      return
    }
    const invocation = channel.invocations.get(callId)
    if (invocation === undefined) throw new Error(`native broker tool call is not pending: ${String(callId)}`)
    channel.invocations.delete(callId)
    const deliveredIndex = channel.delivered.indexOf(callId)
    if (deliveredIndex >= 0) channel.delivered.splice(deliveredIndex, 1)
    const queuedIndex = channel.queued.indexOf(callId)
    if (queuedIndex >= 0) channel.queued.splice(queuedIndex, 1)
    channel.completed.set(callId, canonical)
    channel.activityRevision += 1
    invocation.resolve(cloneResult(result))
    this.settleQuiescence(channel)
  }

  /**
   * Deliver exactly one visible batch while keeping the broker round running.
   * Every ID is validated before the first invocation is resolved, so a bad
   * multi-result handoff cannot leave a partially resumed MCP response.
   */
  completeBatch(requestId: string, completed: readonly BrokerCompletedTool[]): void {
    const channel = this.requireRound(requestId)
    if (channel.state !== 'running') throw new Error(`native broker round is ${channel.state}`)
    if (channel.completionRevision !== undefined) throw new Error('native broker round is already complete')
    const expected = new Set(channel.delivered)
    if (completed.length !== expected.size) {
      throw new Error('native broker result batch is missing or contains extra tool calls')
    }
    const seen = new Set<BrokerCallId>()
    const validated: Array<{ item: BrokerCompletedTool; canonical: string; invocation: PendingInvocation }> = []
    for (const item of completed) {
      if (seen.has(item.callId)) throw new Error(`duplicate native broker result for ${String(item.callId)}`)
      seen.add(item.callId)
      if (!expected.has(item.callId)) throw new Error(`native broker result is not in the delivered batch: ${String(item.callId)}`)
      const canonical = canonicalResult(item.result)
      const previous = channel.completed.get(item.callId)
      if (previous !== undefined) {
        if (previous !== canonical) throw new Error(`native broker result conflict for ${String(item.callId)}`)
        throw new Error(`native broker result was already completed: ${String(item.callId)}`)
      }
      const invocation = channel.invocations.get(item.callId)
      if (invocation === undefined) throw new Error(`native broker tool call is not pending: ${String(item.callId)}`)
      validated.push({ item, canonical, invocation })
    }
    for (const callId of expected) {
      if (!seen.has(callId)) throw new Error(`missing native broker result for ${String(callId)}`)
    }
    for (const { item, canonical, invocation } of validated) {
      channel.invocations.delete(item.callId)
      const deliveredIndex = channel.delivered.indexOf(item.callId)
      if (deliveredIndex >= 0) channel.delivered.splice(deliveredIndex, 1)
      const queuedIndex = channel.queued.indexOf(item.callId)
      if (queuedIndex >= 0) channel.queued.splice(queuedIndex, 1)
      channel.completed.set(item.callId, canonical)
      channel.activityRevision += 1
      invocation.resolve(cloneResult(item.result))
    }
    this.settleQuiescence(channel)
  }

  waitForQuiescence(requestId: string, signal?: AbortSignal): Promise<void> {
    const channel = this.requireRound(requestId)
    if (channel.invocations.size === 0 && channel.activities.size === 0) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(abortError('native broker quiescence wait aborted'))
    return this.wait(channel.quiescence, signal, 'native broker quiescence wait aborted')
  }

  beginCompletionFence(requestId: string): number | undefined {
    const channel = this.requireRound(requestId)
    if (channel.completionRevision !== undefined) return channel.completionRevision
    if (channel.state !== 'running') return undefined
    if (channel.activities.size > 0 || channel.invocations.size > 0) return undefined
    return channel.activityRevision
  }

  commitCompletionFence(requestId: string, revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('native broker completion fence revision is invalid')
    }
    const channel = this.requireRound(requestId)
    if (channel.completionRevision !== undefined) return channel.completionRevision === revision
    if (channel.state !== 'running'
      || channel.activityRevision !== revision
      || channel.activities.size > 0
      || channel.invocations.size > 0) return false
    channel.completionRevision = revision
    channel.activityRevision += 1
    return true
  }

  revoke(requestId: string, reason = new Error('native broker round was revoked')): void {
    const channel = this.rounds.get(requestId)
    if (channel === undefined) return
    clearTimeout(channel.expires)
    this.rounds.delete(requestId)
    this.rememberRetired(requestId)
    channel.state = 'settling'
    channel.batchReadyAt = undefined
    for (const waiter of channel.retirement) this.resolveWaiter(waiter, undefined)
    channel.retirement.clear()
    for (const waiter of channel.quiescence) this.rejectWaiter(waiter, reason)
    channel.quiescence.clear()
    for (const invocation of channel.invocations.values()) invocation.reject(reason)
    channel.invocations.clear()
    channel.queued.splice(0)
    channel.delivered.splice(0)
    channel.activities.clear()
  }

  waitForRetirement(requestId: string, signal?: AbortSignal): Promise<void> {
    const channel = this.rounds.get(requestId)
    if (channel === undefined) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(abortError('native broker retirement wait aborted'))
    return this.wait(channel.retirement, signal, 'native broker retirement wait aborted')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const requestId of [...this.rounds.keys()]) this.revoke(requestId, new Error('native broker closed'))
  }

  private requireRound(requestId: string): RoundChannel {
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('native broker request_id is required')
    const channel = this.rounds.get(requestId)
    if (channel !== undefined) return channel
    const suffix = this.retired.has(fingerprint(requestId)) ? ' expired or revoked' : ' is invalid'
    throw new Error(`native broker request_id ${fingerprint(requestId)}${suffix}`)
  }

  private requestsFor(channel: RoundChannel, ids: readonly BrokerCallId[]): readonly BrokerToolRequest[] {
    return ids
      .map(id => channel.invocations.get(id)?.request)
      .filter((request): request is BrokerToolRequest => request !== undefined)
  }

  private wait<T>(waiters: Set<Waiter<T>>, signal: AbortSignal | undefined, message: string): Promise<T> {
    const deferred = makeDeferred<T>()
    const waiter: Waiter<T> = {
      deferred,
      ...(signal === undefined ? {} : { signal }),
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        waiters.delete(waiter)
        deferred.reject(abortError(message))
      }
      waiter.onAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
    waiters.add(waiter)
    return deferred.promise
  }

  private resolveWaiter<T>(waiter: Waiter<T>, value: T): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    waiter.deferred.resolve(value)
  }

  private rejectWaiter<T>(waiter: Waiter<T>, error: Error): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    waiter.deferred.reject(error)
  }

  private settleQuiescence(channel: RoundChannel): void {
    if (channel.invocations.size > 0 || channel.activities.size > 0) return
    for (const waiter of channel.quiescence) this.resolveWaiter(waiter, undefined)
    channel.quiescence.clear()
  }

  private assertActivityId(activityId: string): void {
    if (typeof activityId !== 'string' || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(activityId)) {
      throw new Error('native broker activity id is invalid')
    }
  }

  private rememberRetired(requestId: string): void {
    const id = fingerprint(requestId)
    this.retired.delete(id)
    this.retired.set(id, true)
    while (this.retired.size > MAX_RETIRED_REQUESTS) {
      const oldest = this.retired.keys().next()
      if (oldest.done) break
      this.retired.delete(oldest.value)
    }
  }
}
