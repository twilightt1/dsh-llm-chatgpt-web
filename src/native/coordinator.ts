import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { canonicalJson } from './canonical.ts'
import { correlateNativeToolResults } from './continuation.ts'
import { NativeToolBroker } from './broker.ts'
import type {
  BrokerAuthorizedToolRequest,
  BrokerToolRequest,
  NativeCheckpoint,
  NativeCoordinatorSnapshot,
  NativePolicyRound,
} from './types.ts'

/** Cleanup owned by one browser turn; stop preserves the page until close follows. */
export type NativeRoundCleanup = (mode: 'stop' | 'close') => Promise<void>

/** The adapter-facing lease for one registered provider round. */
export interface NativeStepLease {
  readonly requestId: string
  bindCleanup(cleanup: NativeRoundCleanup): void
  takeToolBatch(now?: number): readonly BrokerToolRequest[] | undefined
  progressRevision(): number
  beginCompletionFence(): number | undefined
  commitCompletionFence(revision: number): boolean
  park(cleanup: NativeRoundCleanup): Promise<void>
  complete(cleanup: NativeRoundCleanup): Promise<void>
  fail(cleanup: NativeRoundCleanup, cause: Error): Promise<void>
}

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

interface BeginStepInput {
  readonly snapshot?: NativeCoordinatorSnapshot
  readonly openPolicyRound?: () => NativePolicyRound
  readonly sessionId?: string
  readonly messages?: readonly Message[]
  readonly tools?: readonly ToolSchema[]
  readonly ttlMs: number
  readonly invocationTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly continuation?: { readonly kind: 'continue' | 'fresh-replay' }
  readonly checkpoint?: NativeCheckpoint
}

interface NormalizedBeginStepInput {
  readonly snapshot: NativeCoordinatorSnapshot
  readonly openPolicyRound?: () => NativePolicyRound
  readonly ttlMs: number
  readonly signal?: AbortSignal
  readonly continuation?: { readonly kind: 'continue' | 'fresh-replay' }
  readonly checkpoint?: NativeCheckpoint
}

interface BeginWaiter {
  readonly input: NormalizedBeginStepInput
  readonly deferred: Deferred<NativeStepLease>
  onAbort?: () => void
}

type LeaseState = 'open' | 'parked' | 'transitioning' | 'terminal'

interface NativeLeaseHooks {
  readonly broker: NativeToolBroker
  readonly isCurrent: () => boolean
  readonly park: () => Promise<void>
  readonly complete: (cleanup: NativeRoundCleanup) => Promise<void>
  readonly fail: (cleanup: NativeRoundCleanup, cause: Error) => Promise<void>
}

class RoundRecord {
  readonly lease: NativeLease
  state: LeaseState = 'open'
  cleanup: NativeRoundCleanup | undefined
  cleanupCalled = false
  released = false
  retired = false
  resumeWaiter: BeginWaiter | undefined

  constructor(
    readonly sessionId: string,
    readonly requestId: string,
    readonly snapshot: NativeCoordinatorSnapshot,
    readonly checkpoint: NativeCheckpoint | undefined,
    hooks: NativeLeaseHooks,
  ) {
    this.lease = new NativeLease(this, hooks)
  }
}

/** @deprecated Use the continuation-owned native result evidence seam. */
export const correlateToolResults = correlateNativeToolResults

function normalizeBeginStepInput(input: BeginStepInput): NormalizedBeginStepInput {
  if (input.snapshot !== undefined) {
    if (input.snapshot.sessionId.length === 0 || input.snapshot.broker.sessionId !== input.snapshot.sessionId) {
      throw new Error('native coordinator snapshot session identity is invalid')
    }
    if (input.openPolicyRound !== undefined && typeof input.openPolicyRound !== 'function') {
      throw new Error('native coordinator policy-round factory is invalid')
    }
    return {
      snapshot: input.snapshot,
      ...(input.openPolicyRound === undefined ? {} : { openPolicyRound: input.openPolicyRound }),
      ttlMs: input.ttlMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
    }
  }
  if (input.sessionId === undefined || input.messages === undefined || input.tools === undefined
    || input.invocationTimeoutMs === undefined) {
    throw new Error('native coordinator requires a prepared snapshot')
  }
  if (input.sessionId.length === 0) throw new Error('native coordinator sessionId must be non-empty')
  const sessionId = input.sessionId
  const snapshot: NativeCoordinatorSnapshot = Object.freeze({
    sessionId,
    canonicalMessages: Object.freeze(structuredClone(input.messages)),
    broker: Object.freeze({
      sessionId,
      tools: Object.freeze(structuredClone(input.tools)),
      invocationTimeoutMs: input.invocationTimeoutMs,
    }),
    policyHash: '',
    inventoryHash: '',
    approvalHash: '',
  })
  return {
    snapshot,
    ttlMs: input.ttlMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
  }
}

function sameRoundSnapshot(left: NativeCoordinatorSnapshot, right: NativeCoordinatorSnapshot): boolean {
  return left.sessionId === right.sessionId
    && left.broker.sessionId === right.broker.sessionId
    && left.broker.invocationTimeoutMs === right.broker.invocationTimeoutMs
    && left.policyHash === right.policyHash
    && left.inventoryHash === right.inventoryHash
    && left.approvalHash === right.approvalHash
    && canonicalJson(left.broker.tools) === canonicalJson(right.broker.tools)
}

class NativeLease implements NativeStepLease {
  readonly requestId: string

  constructor(
    private readonly record: RoundRecord,
    private readonly hooks: NativeLeaseHooks,
  ) {
    this.requestId = record.requestId
  }

  bindCleanup(cleanup: NativeRoundCleanup): void {
    this.assertOpen()
    this.setCleanup(cleanup)
  }

  takeToolBatch(now?: number): readonly BrokerToolRequest[] | undefined {
    this.assertOpen()
    this.hooks.broker.touch(this.requestId)
    return this.hooks.broker.takeToolBatch(this.requestId, now)
  }

  progressRevision(): number {
    this.assertOpen()
    return this.hooks.broker.progressRevision(this.requestId)
  }

  beginCompletionFence(): number | undefined {
    this.assertOpen()
    return this.hooks.broker.beginCompletionFence(this.requestId)
  }

  commitCompletionFence(revision: number): boolean {
    this.assertOpen()
    return this.hooks.broker.commitCompletionFence(this.requestId, revision)
  }

  async park(cleanup: NativeRoundCleanup): Promise<void> {
    this.assertOpen()
    if (this.record.state !== 'open') throw new Error('native step lease is already parked or terminal')
    this.setCleanup(cleanup)
    this.record.state = 'parked'
    await this.hooks.park()
  }

  async complete(cleanup: NativeRoundCleanup): Promise<void> {
    this.assertOpen()
    if (this.record.state !== 'open') throw new Error('native step lease cannot complete after park or termination')
    this.setCleanup(cleanup)
    await this.hooks.complete(cleanup)
  }

  async fail(cleanup: NativeRoundCleanup, cause: Error): Promise<void> {
    this.assertOpen()
    this.setCleanup(cleanup)
    await this.hooks.fail(cleanup, cause)
  }

  private setCleanup(cleanup: NativeRoundCleanup): void {
    if (this.record.cleanup !== undefined && this.record.cleanup !== cleanup) {
      throw new Error('native step lease already owns a different cleanup callback')
    }
    this.record.cleanup = cleanup
  }

  private assertOpen(): void {
    if (this.record.state === 'terminal' || this.record.released || this.record.retired) {
      throw new Error('native step lease is already terminal')
    }
    if (!this.hooks.isCurrent()) {
      throw new Error('native step lease is no longer owned by the coordinator')
    }
  }
}

/** Serialize one browser reservation while giving its parked owner priority. */
export class NativeRoundCoordinator {
  private reservation: RoundRecord | undefined
  private readonly waiters: BeginWaiter[] = []
  private draining = false
  private disposed = false

  constructor(private readonly broker: NativeToolBroker) {}

  beginStep(input: BeginStepInput): Promise<NativeStepLease> {
    if (this.disposed) return Promise.reject(new Error('native round coordinator is disposed'))
    let normalized: NormalizedBeginStepInput
    try {
      normalized = normalizeBeginStepInput(input)
    } catch (error) {
      return Promise.reject(error)
    }
    if (normalized.signal?.aborted) return Promise.reject(new DOMException('native step wait aborted', 'AbortError'))
    const deferred = makeDeferred<NativeStepLease>()
    const waiter: BeginWaiter = { input: normalized, deferred }
    if (input.signal !== undefined) {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        deferred.reject(new DOMException('native step wait aborted', 'AbortError'))
      }
      waiter.onAbort = onAbort
      input.signal.addEventListener('abort', onAbort, { once: true })
    }
    this.waiters.push(waiter)
    this.scheduleDrain()
    return deferred.promise
  }

  async stopAtTurnBoundary(sessionId: string, preserveCheckpoint = false): Promise<void> {
    const record = this.reservation
    if (record?.sessionId === sessionId) {
      await this.finish(
        record,
        'stop',
        record.cleanup,
        new Error('native round stopped at turn boundary'),
        !preserveCheckpoint,
      )
    }
    this.rejectQueuedSession(sessionId, new Error('native step stopped at turn boundary'))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const error = new Error('native round coordinator disposed')
    for (const waiter of this.waiters.splice(0)) this.rejectWaiter(waiter, error)
    const record = this.reservation
    if (record !== undefined) {
      await this.finish(record, 'stop', record.cleanup, error).catch(() => {})
    }
  }

  private scheduleDrain(): void {
    if (this.draining || this.disposed) return
    this.draining = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed) {
        const current = this.reservation
        if (current === undefined) {
          const waiter = this.takeNextWaiter()
          if (waiter === undefined) return
          await this.grant(waiter)
          continue
        }
        if (current.state === 'parked') {
          const index = this.waiters.findIndex(waiter => waiter.input.snapshot.sessionId === current.sessionId)
          if (index < 0) return
          const [waiter] = this.waiters.splice(index, 1)
          if (waiter === undefined) return
          this.removeAbortListener(waiter)
          await this.resume(current, waiter)
          continue
        }
        return
      }
    } finally {
      this.draining = false
      if (!this.disposed && this.reservation === undefined && this.waiters.length > 0) this.scheduleDrain()
    }
  }

  private takeNextWaiter(): BeginWaiter | undefined {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) this.removeAbortListener(waiter)
    return waiter
  }

  private createRecord(
    sessionId: string,
    requestId: string,
    snapshot: NativeCoordinatorSnapshot,
    checkpoint?: NativeCheckpoint,
  ): RoundRecord {
    let record!: RoundRecord
    const hooks: NativeLeaseHooks = {
      broker: this.broker,
      isCurrent: () => this.reservation === record,
      park: async () => {
        if (this.reservation !== record || record.state !== 'parked') {
          throw new Error('native parked round is no longer owned by the coordinator')
        }
        // Retirement observation starts at registration; scheduling here lets
        // an owner waiter resume immediately if it was queued in the same tick.
        this.scheduleDrain()
      },
      complete: cleanup => this.finish(record, 'close', cleanup),
      fail: (cleanup, cause) => this.finish(record, 'stop', cleanup, cause),
    }
    record = new RoundRecord(sessionId, requestId, snapshot, checkpoint, hooks)
    return record
  }

  private async grant(waiter: BeginWaiter): Promise<void> {
    try {
      const requestId = this.broker.register({
        ...waiter.input.snapshot.broker,
        ttlMs: waiter.input.ttlMs,
        ...(waiter.input.openPolicyRound === undefined ? {} : { policyRound: waiter.input.openPolicyRound() }),
        ...(waiter.input.checkpoint === undefined ? {} : { checkpoint: waiter.input.checkpoint }),
      })
      const record = this.createRecord(waiter.input.snapshot.sessionId, requestId, waiter.input.snapshot, waiter.input.checkpoint)
      this.reservation = record
      this.watchRetirement(record)
      this.resolveWaiter(waiter, record.lease)
    } catch (error) {
      this.rejectWaiter(waiter, error)
    }
  }

  private async resume(record: RoundRecord, waiter: BeginWaiter): Promise<void> {
    record.state = 'transitioning'
    record.resumeWaiter = waiter
    try {
      if (!sameRoundSnapshot(record.snapshot, waiter.input.snapshot)) {
        throw new Error('native parked round policy snapshot changed before continuation')
      }
      const calls = record.lease.takeToolBatch()
      if (calls === undefined || calls.length === 0) {
        throw new Error('native parked round has no pending tool batch to resume')
      }
      const results = correlateToolResults(waiter.input.snapshot.canonicalMessages, calls)
      record.checkpoint?.confirmResults(
        calls as readonly BrokerAuthorizedToolRequest[],
        results,
      )
      if (waiter.input.continuation?.kind === 'continue') {
        this.broker.completeBatch(record.requestId, calls.map((call, index) => ({
          callId: call.callId,
          result: results[index]!,
        })))
        record.state = 'open'
        this.resolveWaiter(waiter, record.lease)
        return
      }
      // Fresh replay is terminal for the old physical response. Change state
      // before resolving any broker invocation promises so a late MCP call
      // observes settlement rather than opening another batch.
      this.broker.beginSettlement(record.requestId)
      for (const [index, call] of calls.entries()) {
        this.broker.completeTool(record.requestId, call.callId, results[index]!)
      }
      await this.broker.waitForQuiescence(record.requestId, waiter.input.signal)
      await this.releaseRecord(record, 'stop', new Error('native predecessor resumed'), false)
      const checkpoint = record.checkpoint
      checkpoint?.consumeReplayAndPrepareNextGeneration()
      const lease = await this.registerFresh(
        checkpoint === undefined ? waiter.input : { ...waiter.input, checkpoint },
      )
      this.resolveWaiter(waiter, lease)
    } catch (error) {
      await this.releaseRecord(record, 'stop', error instanceof Error ? error : new Error(String(error))).catch(() => {})
      this.rejectWaiter(waiter, error)
    } finally {
      record.resumeWaiter = undefined
    }
  }

  private async registerFresh(input: NormalizedBeginStepInput): Promise<NativeStepLease> {
    if (this.disposed) throw new Error('native round coordinator is disposed')
    const requestId = this.broker.register({
      ...input.snapshot.broker,
      ttlMs: input.ttlMs,
      ...(input.openPolicyRound === undefined ? {} : { policyRound: input.openPolicyRound() }),
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
    })
    const record = this.createRecord(input.snapshot.sessionId, requestId, input.snapshot, input.checkpoint)
    this.reservation = record
    this.watchRetirement(record)
    return record.lease
  }

  private async finish(
    record: RoundRecord,
    mode: 'stop' | 'close',
    cleanup: NativeRoundCleanup | undefined,
    cause?: Error,
    terminalCheckpoint = true,
  ): Promise<void> {
    if (record.released || record.state === 'terminal') throw new Error('native step lease is already terminal')
    if (cleanup !== undefined && record.cleanup === undefined) record.cleanup = cleanup
    record.state = 'transitioning'
    if (mode === 'close') {
      try {
        this.broker.beginSettlement(record.requestId)
        await this.broker.waitForQuiescence(record.requestId)
      } catch (error) {
        await this.releaseRecord(
          record,
          'stop',
          cause ?? (error instanceof Error ? error : new Error(String(error))),
          terminalCheckpoint,
        )
        throw error
      }
    }
    await this.releaseRecord(record, mode, cause, terminalCheckpoint)
  }

  private async releaseRecord(
    record: RoundRecord,
    mode: 'stop' | 'close',
    cause?: Error,
    terminalCheckpoint = true,
  ): Promise<void> {
    if (record.released) return
    record.released = true
    record.retired = true
    record.state = 'terminal'
    let cleanupError: unknown
    if (!record.cleanupCalled) {
      record.cleanupCalled = true
      if (record.cleanup !== undefined) {
        try {
          await record.cleanup(mode)
        } catch (error) {
          cleanupError = error
        }
      }
    }
    this.broker.revoke(record.requestId, cause ?? new Error(`native round ${mode}d`))
    let checkpointError: unknown
    if (terminalCheckpoint && record.checkpoint !== undefined && cleanupError === undefined) {
      try {
        record.checkpoint.markTerminal(mode === 'close' ? 'completed' : 'failed')
      } catch (error) {
        checkpointError = error
      }
    }
    if (this.reservation === record) this.reservation = undefined
    this.scheduleDrain()
    if (cleanupError !== undefined) throw cleanupError
    if (checkpointError !== undefined) throw checkpointError
  }

  private watchRetirement(record: RoundRecord): void {
    void this.broker.waitForRetirement(record.requestId).then(() => this.onRetired(record)).catch(() => {})
  }

  private async onRetired(record: RoundRecord): Promise<void> {
    if (record.released) return
    record.released = true
    record.retired = true
    record.state = 'terminal'
    if (!record.cleanupCalled) {
      record.cleanupCalled = true
      if (record.cleanup !== undefined) await record.cleanup('stop').catch(() => {})
    }
    if (record.resumeWaiter !== undefined) {
      this.rejectWaiter(record.resumeWaiter, new Error('native parked round retired before resume'))
      record.resumeWaiter = undefined
    }
    if (this.reservation === record) this.reservation = undefined
    this.scheduleDrain()
  }

  private rejectQueuedSession(sessionId: string, error: Error): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]
      if (waiter?.input.snapshot.sessionId !== sessionId) continue
      this.waiters.splice(index, 1)
      this.rejectWaiter(waiter, error)
    }
  }

  private resolveWaiter(waiter: BeginWaiter, value: NativeStepLease): void {
    this.removeAbortListener(waiter)
    waiter.deferred.resolve(value)
  }

  private rejectWaiter(waiter: BeginWaiter, error: unknown): void {
    this.removeAbortListener(waiter)
    waiter.deferred.reject(error)
  }

  private removeAbortListener(waiter: BeginWaiter): void {
    if (waiter.input.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.input.signal.removeEventListener('abort', waiter.onAbort)
    }
  }
}
