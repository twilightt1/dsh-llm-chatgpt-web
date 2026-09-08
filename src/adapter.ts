/**
 * `ChatGptWebAdapter`: drive ChatGPT Temporary Chat in an owned Chromium and
 * emit harness StreamChunks. Transport-only: connection facts arrive through
 * a thunk resolved once per operation; turns are serialized on one browser.
 *
 * No bridge daemon, no Codex task, no MCP: each turn owns a fresh Temporary
 * Chat page and the full DSH history is compiled into its prompt.
 * @module dsh-llm-chatgpt-web/adapter
 */

import { CallId, contentHasImage, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ChatGptBrowser } from './chatgpt/browser.ts'
import { compilePrompt } from './chatgpt/prompt.ts'
import { CHATGPT_COMPOSER_SELECTOR, detectChatGptAccountCapabilities } from './chatgpt/session.ts'
import type { ChatGptWebAccountCapabilities } from './chatgpt/session.ts'
import { COMPOSER_CHAR_BUDGET, prepareTemporaryChatSurface, streamTextTurn } from './chatgpt/turn.ts'
import { estimateUsage } from './chatgpt/usage.ts'
import { buildSchemaIndex, parseToolCallsWithSchemas, renderRejectionNotice } from './chatgpt/toolcalls.ts'

/** Monotonic suffix for provider-issued call ids (unique per process). */
let toolCallSequence = 0

function mintCallId(): CallId {
  toolCallSequence += 1
  return CallId(`call-${toolCallSequence}`)
}

/** One advisory model entry (the id is the DSH-facing slug). */
export interface ChatGptWebCatalogModel {
  /** DSH model id, e.g. `chatgpt-web/high`. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
}

/** Validated connection facts for one operation (re-read per operation). */
export interface ChatGptWebConnectionOptions {
  /** Profile home for the login session. */
  profileDir: string
  /** System Chrome executable; `undefined` means Playwright's bundled Chromium. */
  chromeExecutablePath: string | undefined
  /** Run turns headed (default false; first login is always headed). */
  headed: boolean
  /** Headed but placed off-screen (default true; login stays on-screen). */
  offscreen: boolean
  /** Daemon idle shutdown (default 30 minutes without turns). */
  daemonIdleMs: number
  /** Budget for the manual sign-in window. */
  loginTimeoutMs: number
  /** Whole-turn budget. */
  turnTimeoutMs: number
  /** No-output-growth budget while a turn is expected to stream. */
  stallTimeoutMs: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly ChatGptWebCatalogModel[]
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface ChatGptWebAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => ChatGptWebConnectionOptions
}

/** Default whole-turn budget. */
export const DEFAULT_TURN_TIMEOUT_MS = 300_000/** Default no-growth stall budget. */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000
/** Default manual login window. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 600_000
/** Default daemon idle shutdown. */
export const DEFAULT_DAEMON_IDLE_MS = 30 * 60 * 1_000
/** Default combined request/response context capacity (Plus High window). */
export const DEFAULT_CONTEXT_WINDOW = 90_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 16_384
function modelInfo(provider: string, model: ChatGptWebCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

/** One-line page snapshot for probe/setup failures (no content, just shape). */
async function describeProbePage(page: import('playwright-core').Page): Promise<string> {
  const url = page.url()
  const title = await page.title().catch(() => '?')
  const composers = await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).count().catch(() => -1)
  return `url=${url} title=${JSON.stringify(title)} visibleComposers=${composers}`
}

/**
 * ChatGPT Web adapter. One instance owns one browser; concurrent `stream()`
 * calls are serialized so at most one Temporary Chat page is ever active.
 */
export class ChatGptWebAdapter extends LlmAdapter {
  private browser: ChatGptBrowser | undefined
  private browserKey: string | undefined
  private capabilities: ChatGptWebAccountCapabilities | undefined
  private queue: Promise<void> = Promise.resolve()
  /** One-shot retry notices keyed by session (consumed on next turn). */
  private pendingNotices = new Map<string, string>()

  constructor(private readonly config: ChatGptWebAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ChatGPT Web' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    // No selectable reasoning efforts: the effort is fixed per model slug.
    // An explicit per-request effort fails in compilePrompt() instead of
    // being silently dropped.
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.enqueue(() => this.runTurn(options))
  }

  /** Release the owned browser. Hosts should call this on plugin unload. */
  async dispose(): Promise<void> {
    // Drain queued turns first so dispose never strands an in-flight page.
    const pending = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await pending
    try {
      await this.browser?.close().catch(() => {})
    } finally {
      this.browser = undefined
      this.browserKey = undefined
      this.capabilities = undefined
      release()
    }
  }

  /** Serialize turns: one page at a time, in call order. */
  private async * enqueue(run: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const previous = this.queue
    let release: () => void = () => {}
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      yield* run()
    } finally {
      release()
    }
  }

  private browserFor(connection: ChatGptWebConnectionOptions): ChatGptBrowser {
    const key = `${connection.profileDir}\0${connection.chromeExecutablePath ?? ''}\0${connection.headed}\0${connection.offscreen}`
    if (!this.browser || this.browserKey !== key) {
      void this.browser?.close().catch(() => {})
      this.browser = new ChatGptBrowser({
        profileDir: connection.profileDir,
        chromeExecutablePath: connection.chromeExecutablePath,
        headed: connection.headed,
        offscreen: connection.offscreen,
        loginTimeoutMs: connection.loginTimeoutMs,
        daemonIdleMs: connection.daemonIdleMs,
      })
      this.browserKey = key
      this.capabilities = undefined
    }
    return this.browser
  }

  /** Consume (get + delete) the pending retry notice for this session, if any. */
  private takeNotice(options: GenerateOptions): string | undefined {
    const key = options.sessionId !== undefined ? String(options.sessionId) : 'standalone'
    const notice = this.pendingNotices.get(key)
    if (notice !== undefined) this.pendingNotices.delete(key)
    return notice
  }

  /** Remember a retry notice for the session's next turn. */
  private stashNotice(options: GenerateOptions, notice: string): void {
    const key = options.sessionId !== undefined ? String(options.sessionId) : 'standalone'
    this.pendingNotices.set(key, notice)
  }

  /**
   * Detect the echo failure mode (observed live: a 130k-char reply that was
   * the compiled prompt rendered back, marker structure and all, instead of
   * an answer). Echo ⇒ the whole reply is wasted tokens; fail fast with a
   * non-retryable diagnostic and a retry notice for the next turn.
   */
  private isEcho(fullText: string, prompt: string): boolean {
    if (fullText.length < 400 || fullText.length < prompt.length * 0.3) return false
    const head = prompt.replace(/\s+/g, '').slice(0, 150)
    return head.length > 0 && fullText.replace(/\s+/g, '').includes(head)
  }

  /**
   * Close the turn: text block-end, parsed tool calls, usage, terminal
   * finish. Live text deltas already streamed as block 0; calls follow in
   * source order with fresh indexes (assembler joins them deterministically).
   */
  private async * emitTurnResult(
    options: GenerateOptions,
    prompt: string,
    fullText: string,
    textIndex: number,
  ): AsyncIterable<StreamChunk> {
    const known = new Set((options.tools ?? []).map(tool => tool.name))
    const textBlock: ContentBlock = { type: 'text', text: fullText }
    yield { type: 'block-end', index: textIndex, block: textBlock }
    if (this.isEcho(fullText, prompt)) {
      console.log(
        `[dsh-llm-chatgpt-web] echo detected (${fullText.length}ch reply vs ${prompt.length}ch prompt); failing turn`,
      )
      this.stashNotice(
        options,
        '[System notice] Your previous reply repeated these instructions verbatim instead of answering. NEVER echo this message. Answer the user\'s actual request directly.',
      )
      yield { type: 'usage', usage: estimateUsage(prompt.length, fullText.length) }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'ChatGPT Web replied with the prompt itself (echo) instead of an answer. Retry the turn.',
            code: 'PROMPT_ECHO',
          },
        },
      }
      return
    }
    let callCount = 0
    if (known.size > 0) {
      const parsed = parseToolCallsWithSchemas(fullText, buildSchemaIndex(options.tools ?? []))
      let nextIndex = textIndex + 1
      for (const segment of parsed.segments) {
        if (segment.type !== 'call') continue
        const id = mintCallId()
        yield { type: 'block-start', index: nextIndex, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: nextIndex,
          id,
          name: segment.call.name,
          argumentsDelta: segment.call.arguments,
        }
        yield {
          type: 'block-end',
          index: nextIndex,
          block: { type: 'tool-call', id, name: segment.call.name, arguments: segment.call.arguments },
        }
        nextIndex += 1
      }
      callCount = parsed.callCount
      if (parsed.rejected.length > 0) {
        for (const entry of parsed.rejected) {
          console.log(`[dsh-llm-chatgpt-web] rejected tool-call: ${entry.reason} :: ${JSON.stringify(entry.raw)}`)
        }
        this.stashNotice(options, renderRejectionNotice(parsed.rejected, buildSchemaIndex(options.tools ?? [])))
      }
    }
    yield { type: 'usage', usage: estimateUsage(prompt.length, fullText.length) }
    if (fullText.length === 0 && callCount === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      }
      return
    }
    yield { type: 'finish', reason: callCount > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }

  private async * runTurn(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    for (const message of options.messages) {
      if (contentHasImage(message.content)) {
        throw new LlmError(
          'ChatGPT Web adapter cannot represent image content (V1 is text-only).',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const prompt = compilePrompt(options, COMPOSER_CHAR_BUDGET, this.takeNotice(options))
    const browser = this.browserFor(connection)
    await browser.ensureReady(options.signal)
    const page = await browser.newTurnPage()
    let iterator: AsyncIterator<{ type: 'delta'; delta: string }, { text: string; promptChars: number }> | undefined
    try {
      await prepareTemporaryChatSurface(page, connection.profileDir)
      if (!this.capabilities || !browser.probed) {
        try {
          this.capabilities = await detectChatGptAccountCapabilities(page)
        } catch (error) {
          throw new LlmError(
            `ChatGPT account capability probe failed (${error instanceof Error ? error.message : String(error)}).`
            + ` page=${await describeProbePage(page)}`,
            'PROVIDER_ERROR',
            { cause: error },
          )
        }
        browser.markProbed()
      }
      const capabilities = this.capabilities
      const hasTools = (options.tools?.length ?? 0) > 0
      const turn = streamTextTurn(page, {
        model: options.model,
        prompt,
        capabilities,
        turnTimeoutMs: connection.turnTimeoutMs,
        stallTimeoutMs: connection.stallTimeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(hasTools ? { requiresToolCall: true } : {}),
      })
      iterator = turn[Symbol.asyncIterator]()
      let blockIndex = -1
      let fullText = ''
      for (;;) {
        const step = await iterator.next()
        if (step.done) {
          fullText = step.value.text
          break
        }
        if (blockIndex < 0) {
          blockIndex = 0
          yield { type: 'block-start', index: blockIndex, blockType: 'text' }
        }
        fullText += step.value.delta
        yield { type: 'text-delta', index: blockIndex, text: step.value.delta }
      }
      if (blockIndex < 0) {
        // Completed with no deltas: still close the protocol shape, then fail
        // as an empty response (mirrors the reference adapters).
        blockIndex = 0
        yield { type: 'block-start', index: blockIndex, blockType: 'text' }
      }
      yield* this.emitTurnResult(options, prompt, fullText, blockIndex)
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        // Stop server-side generation; the shared page stays for next turns.
        await page.locator('[data-testid="stop-button"]').last().press('Enter').catch(() => {})
        try {
          await iterator?.return?.()
        } catch {
          // Termination already owned by the abort path.
        }
        throw new LlmError('ChatGPT Web request aborted by caller.', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('ChatGPT Web turn failed.', 'TRANSPORT', { cause: error })
    }
  }
}
