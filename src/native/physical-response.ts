import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TextTurnEvent, TextTurnResult } from '../chatgpt/turn.ts'
import { estimateUsage } from '../chatgpt/usage.ts'
import type { NativeRoundCleanup } from './coordinator.ts'
import { nativeReplayState } from './continuation.ts'
import type { BrokerToolResult } from './types.ts'

/** Lifecycle of one submitted browser response across logical DSH rounds. */
export type NativePhysicalResponseState =
  | 'submitted'
  | 'running'
  | 'parked'
  | 'settling'
  | 'completed'
  | 'failed'
  | 'revoked'

/** Browser/session seam used by the physical-response owner. */
export interface NativePhysicalResponseDriver {
  nextBoundary(): AsyncGenerator<TextTurnEvent, TextTurnResult>
  deliverResults(results: readonly BrokerToolResult[]): Promise<void>
  markToolResultDelivered(revision: number): void
  stop(): Promise<void>
}

export interface NativePhysicalResponseOptions {
  readonly sessionId: string
  readonly executionKey: string
  readonly requestId: string
  readonly promptChars: number
  readonly driver: NativePhysicalResponseDriver
  readonly cleanup?: NativeRoundCleanup
}

/** Public stateful owner for one physical ChatGPT response. */
export interface NativePhysicalResponse {
  readonly sessionId: string
  readonly executionKey: string
  readonly requestId: string
  readonly state: NativePhysicalResponseState
  streamBoundary(boundary?: number): AsyncIterable<StreamChunk>
  deliverResults(results: readonly BrokerToolResult[], revision?: number): Promise<void>
  stop(cause: Error): Promise<void>
}

function cloneChunks(chunks: readonly StreamChunk[]): StreamChunk[] {
  return structuredClone([...chunks])
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Convert one resumable text-turn result into a journaled DSH logical stream. */
class NativePhysicalResponseImpl implements NativePhysicalResponse {
  readonly sessionId: string
  readonly executionKey: string
  readonly requestId: string
  private currentState: NativePhysicalResponseState = 'submitted'
  private readonly journals: StreamChunk[][] = []
  private activeBoundary = false
  private cleanupDone = false

  constructor(private readonly options: NativePhysicalResponseOptions) {
    this.sessionId = options.sessionId
    this.executionKey = options.executionKey
    this.requestId = options.requestId
  }

  get state(): NativePhysicalResponseState {
    return this.currentState
  }

  streamBoundary(boundary = this.journals.length + 1): AsyncIterable<StreamChunk> {
    return this.streamBoundaryImpl(boundary)
  }

  async deliverResults(results: readonly BrokerToolResult[], revision?: number): Promise<void> {
    if (this.currentState !== 'parked') {
      throw new Error(`native physical response cannot deliver results while ${this.currentState}`)
    }
    this.currentState = 'running'
    try {
      await this.options.driver.deliverResults(structuredClone(results))
      if (revision !== undefined) this.options.driver.markToolResultDelivered(revision)
    } catch (error) {
      await this.fail(errorFrom(error)).catch(() => {})
      throw error
    }
  }

  async stop(cause: Error): Promise<void> {
    if (this.currentState === 'revoked' || this.currentState === 'failed' || this.currentState === 'completed') return
    this.currentState = 'settling'
    let firstError: unknown
    try {
      await this.options.driver.stop()
    } catch (error) {
      firstError = error
    }
    try {
      await this.cleanup('stop')
    } catch (error) {
      firstError ??= error
    }
    this.currentState = 'revoked'
    if (firstError !== undefined) throw firstError
    void cause
  }

  private async *streamBoundaryImpl(boundary: number): AsyncGenerator<StreamChunk> {
    if (!Number.isSafeInteger(boundary) || boundary < 1) {
      throw new Error('native physical response boundary is invalid')
    }
    const journal = this.journals[boundary - 1]
    if (journal !== undefined) {
      if (this.currentState === 'failed' || this.currentState === 'revoked') {
        throw new Error(`native physical response is ${this.currentState}`)
      }
      for (const chunk of cloneChunks(journal)) yield chunk
      return
    }
    if (boundary !== this.journals.length + 1) {
      throw new Error('native physical response boundary is not the next logical round')
    }
    if (this.currentState !== 'submitted' && this.currentState !== 'running') {
      throw new Error(`native physical response cannot start a boundary while ${this.currentState}`)
    }
    if (this.activeBoundary) throw new Error('native physical response already has an active boundary')
    this.activeBoundary = true
    this.currentState = 'running'
    try {
      const chunks = await this.captureBoundary()
      // The journal is committed before the first chunk is observable. A
      // consumer retry therefore replays a complete logical stream rather
      // than re-entering the browser halfway through a boundary.
      this.journals.push(cloneChunks(chunks))
      for (const chunk of cloneChunks(chunks)) yield chunk
    } catch (error) {
      await this.fail(errorFrom(error)).catch(() => {})
      throw error
    } finally {
      this.activeBoundary = false
    }
  }

  private async captureBoundary(): Promise<StreamChunk[]> {
    const iterator = this.options.driver.nextBoundary()
    const deltas: string[] = []
    let result: TextTurnResult | undefined
    for (;;) {
      const step = await iterator.next()
      if (step.done) {
        result = step.value
        break
      }
      const event = step.value
      if (event.type !== 'delta') throw new Error('native physical response driver emitted an unknown event')
      deltas.push(event.delta)
    }
    if (result === undefined) throw new Error('native physical response driver ended without a result')
    const text = deltas.join('')
    if (result.text.length > 0 && text.length === 0) deltas.push(result.text)
    if (result.text.length > 0 && text.length > 0 && result.text !== text) {
      throw new LlmError('native physical response text cursor diverged from its boundary result.', 'PROVIDER_ERROR')
    }
    const emittedText = deltas.join('')
    const chunks: StreamChunk[] = []
    if (emittedText.length > 0) {
      chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
      for (const delta of deltas) chunks.push({ type: 'text-delta', index: 0, text: delta })
      chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text: emittedText } })
    }
    if (result.kind === 'tool-batch') {
      let index = emittedText.length > 0 ? 1 : 0
      for (const call of result.calls) {
        const argumentsText = JSON.stringify(call.arguments)
        if (argumentsText === undefined) {
          throw new LlmError(`Native broker arguments for ${String(call.callId)} are not JSON serializable.`, 'PROVIDER_ERROR')
        }
        chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: call.callId,
          name: call.name,
          argumentsDelta: argumentsText,
        })
        chunks.push({
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: call.callId, name: call.name, arguments: argumentsText },
        })
        index += 1
      }
      chunks.push({
        type: 'usage',
        usage: estimateUsage(result.promptChars || this.options.promptChars, emittedText.length),
      })
      chunks.push({
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: nativeReplayState(
          this.executionKey,
          this.journals.length + 1,
          result.calls.map(call => call.callId),
        ),
      })
      this.currentState = 'parked'
      return chunks
    }

    chunks.push({
      type: 'usage',
      usage: estimateUsage(result.promptChars || this.options.promptChars, emittedText.length),
    })
    if (emittedText.length === 0) {
      chunks.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'model returned a completed response with no content',
            code: EMPTY_RESPONSE_CODE,
          },
        },
      })
      await this.cleanup('close')
      this.currentState = 'failed'
      return chunks
    }
    chunks.push({ type: 'finish', reason: { kind: 'stop' } })
    await this.cleanup('close')
    this.currentState = 'completed'
    return chunks
  }

  private async fail(cause: Error): Promise<void> {
    if (this.currentState === 'failed' || this.currentState === 'revoked' || this.currentState === 'completed') return
    this.currentState = 'settling'
    try {
      await this.options.driver.stop()
    } catch {
      // Preserve the original failure; cleanup below is still attempted.
    }
    await this.cleanup('stop').catch(() => {})
    this.currentState = 'failed'
    void cause
  }

  private async cleanup(mode: 'stop' | 'close'): Promise<void> {
    if (this.cleanupDone) return
    this.cleanupDone = true
    await this.options.cleanup?.(mode)
  }
}

export function createNativePhysicalResponse(
  options: NativePhysicalResponseOptions,
): NativePhysicalResponse {
  return new NativePhysicalResponseImpl(options)
}
