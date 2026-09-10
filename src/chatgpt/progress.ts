import { LlmError } from '@deepseek-ai/dsh-llm'

/** Semantic browser/native state used to decide whether a turn is progressing. */
export interface ChatGptProgressSample {
  readonly assistantIdentity?: string
  readonly text: string
  readonly html?: string
  readonly running: boolean
  readonly nativeRevision: number
}

/** A named point in the physical response lifecycle. */
export type ChatGptProgressStage =
  | 'preflight'
  | 'submit'
  | 'first-progress'
  | 'mcp-wait'
  | 'tool-handoff'
  | 'post-tool-progress'
  | 'completion'

export interface ChatGptProgressTrackerOptions {
  readonly startedAt: number
  readonly absoluteTimeoutMs: number
  readonly inactivityTimeoutMs: number
}

interface NormalizedProgressSample {
  readonly assistantIdentity: string | undefined
  readonly text: string
  readonly html: string
  readonly running: boolean
  readonly nativeRevision: number
}

function assertPositiveFiniteInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ChatGPT progress ${name} must be a positive safe integer`)
  }
}

function nowValue(now: number | undefined): number {
  const value = now ?? Date.now()
  if (!Number.isFinite(value)) throw new Error('ChatGPT progress clock value must be finite')
  return value
}

function normalize(sample: ChatGptProgressSample): NormalizedProgressSample {
  if (typeof sample.text !== 'string' || typeof sample.running !== 'boolean'
    || typeof sample.nativeRevision !== 'number' || !Number.isSafeInteger(sample.nativeRevision)
    || sample.nativeRevision < 0) {
    throw new Error('ChatGPT progress sample is invalid')
  }
  return {
    assistantIdentity: sample.assistantIdentity,
    text: sample.text,
    html: sample.html ?? '',
    running: sample.running,
    nativeRevision: sample.nativeRevision,
  }
}

function samplesEqual(left: NormalizedProgressSample, right: NormalizedProgressSample): boolean {
  return left.assistantIdentity === right.assistantIdentity
    && left.text === right.text
    && left.html === right.html
    && left.running === right.running
    && left.nativeRevision === right.nativeRevision
}

/**
 * Tracks two independent clocks for one ChatGPT physical response. Polling,
 * arbitrary DOM churn, and repeated native reads do not count as progress.
 */
export class ChatGptProgressTracker {
  private lastSample: NormalizedProgressSample | undefined
  private lastProgressAt: number
  private lastMarker: string | undefined

  constructor(private readonly options: ChatGptProgressTrackerOptions) {
    if (!Number.isFinite(options.startedAt)) throw new Error('ChatGPT progress startedAt must be finite')
    assertPositiveFiniteInteger(options.absoluteTimeoutMs, 'absoluteTimeoutMs')
    assertPositiveFiniteInteger(options.inactivityTimeoutMs, 'inactivityTimeoutMs')
    this.lastProgressAt = options.startedAt
  }

  /** Record a semantic browser snapshot; returns whether it changed meaningfully. */
  observe(sample: ChatGptProgressSample, now?: number): boolean {
    const at = nowValue(now)
    const normalized = normalize(sample)
    const changed = this.lastSample === undefined || !samplesEqual(this.lastSample, normalized)
    this.lastSample = normalized
    if (changed) this.lastProgressAt = at
    return changed
  }

  /** Record a broker boundary/result event once per kind and revision. */
  mark(kind: 'tool-batch' | 'tool-result', revision: number, now?: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('ChatGPT progress revision is invalid')
    const marker = `${kind}:${revision}`
    if (this.lastMarker === marker) return false
    this.lastMarker = marker
    this.lastProgressAt = nowValue(now)
    return true
  }

  /** Throw a stage-labelled timeout when either clock reaches its deadline. */
  assertAlive(stage: ChatGptProgressStage, now?: number): void {
    const at = nowValue(now)
    const absoluteElapsed = Math.max(0, at - this.options.startedAt)
    const inactiveElapsed = Math.max(0, at - this.lastProgressAt)
    if (absoluteElapsed >= this.options.absoluteTimeoutMs) {
      throw new LlmError(
        `ChatGPT Web turn exceeded its absolute timeout during ${stage}: `
        + `elapsed ${absoluteElapsed}ms (budget ${this.options.absoluteTimeoutMs}ms; inactive ${inactiveElapsed}ms).`,
        'TIMEOUT',
      )
    }
    if (inactiveElapsed >= this.options.inactivityTimeoutMs) {
      throw new LlmError(
        `ChatGPT Web turn exceeded its inactivity timeout during ${stage}: `
        + `inactive ${inactiveElapsed}ms (budget ${this.options.inactivityTimeoutMs}ms; absolute ${absoluteElapsed}ms).`,
        'TIMEOUT',
      )
    }
  }

  /** Expose the last semantic progress timestamp for deterministic diagnostics. */
  get lastProgressTime(): number {
    return this.lastProgressAt
  }
}
