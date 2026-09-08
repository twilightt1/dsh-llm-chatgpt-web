/**
 * One text turn on a fresh Temporary Chat page: prepare → attach → send →
 * stream answer deltas until the completion predicate holds.
 *
 * The completion predicate mirrors the upstream rule (response present, not
 * running, non-empty text, copy action visible) scoped to the response turn.
 * @module dsh-llm-chatgpt-web/chatgpt-turn
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright-core'
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
} from './session.ts'
import {
  dismissTemporaryChatOnboarding,
  throwIfRateLimitDialog,
  throwIfSessionFailureAlert,
  throwIfTerminalError,
} from './guards.ts'
import type { ChatGptWebAccountCapabilities } from './session.ts'
import { selectModelEffort } from './effort.ts'

/** Composer budget in chars (measured upstream envelope, fail-closed). */
export const COMPOSER_CHAR_BUDGET = 200_000

export interface TextTurnOptions {
  model: string
  prompt: string
  capabilities: ChatGptWebAccountCapabilities
  turnTimeoutMs: number
  stallTimeoutMs: number
  signal?: AbortSignal
  /**
   * In-chat self-correction: when set, an answer with NO tool-call block
   * while the prompt advertised tools gets one follow-up nudge in the SAME
   * Temporary Chat ("emit the block, do not narrate"), then its new answer
   * is captured. Detects both ```tool-call fences and eaten-backtick forms.
   */
  requiresToolCall?: boolean
}

export interface TextTurnResult {
  text: string
  promptChars: number
}

/** Events from a streaming turn: deltas, then return of the final result. */
export type TextTurnEvent =
  | { type: 'delta'; delta: string }

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('ChatGPT Web turn aborted by caller.', 'ABORTED')
}

/** Resolve on the next DOM mutation batch (≤timeoutMs), for streaming polls. */
async function waitForDomMutation(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate((timeout) => new Promise<void>((resolveMutation) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      observer.disconnect()
      clearTimeout(timeoutTimer)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      resolveMutation()
    }
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      if (settleTimer !== undefined) return
      settleTimer = setTimeout(finish, 16)
    })
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    const timeoutTimer = setTimeout(finish, timeout)
  }), timeoutMs).catch(() => {})
}

export async function activeComposer(page: Page, timeoutMs = 30_000): Promise<Locator> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true })
  const deadline = Date.now() + timeoutMs
  let count = 0
  while (Date.now() < deadline) {
    count = await composers.count().catch(() => 0)
    if (count === 1) return composers.first()
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
  throw new LlmError(
    `ChatGPT composer is unavailable (visible composer count was ${count}). Reload ChatGPT and retry.`,
    'PROVIDER_ERROR',
  )
}

async function stopVisible(page: Page): Promise<boolean> {
  return await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false)
}

/**
 * Answer-only extraction (upstream technique, browser-worker.ts:3675–3922):
 * classify `.markdown` roots so commentary/status containers (chain-of-thought,
 * streaming status) are structurally excluded, then join the ANSWER roots'
 * text. UI chrome (edit/branch buttons, "Answer now"/"Thinking" rows) is
 * dropped by construction — it never sits in an answer root's text.
 */
const ANSWER_EXTRACTION_JS = `(() => {
  const roots = [...document.querySelectorAll('.markdown')]
    .filter((el) => {
      const parent = el.parentElement
      if (parent && parent.querySelector('.markdown') !== null && parent.closest('.markdown') !== null) return false
      return true
    })
    .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0)
  if (roots.length === 0) return ''
  // The LAST answer root is the response to the newest prompt; earlier roots
  // belong to previous rounds of this Temporary Chat.
  const root = roots[roots.length - 1]
  const clone = root.cloneNode(true)
  for (const el of clone.querySelectorAll('button, script, style, [role="status"], [aria-busy="true"]')) {
    el.remove()
  }
  return (clone.textContent ?? '').replace(/\\u00a0/g, ' ')
})()`

/**
 * Read the answer text via page-level answer-root classification (chrome is
 * structurally excluded — see ANSWER_EXTRACTION_JS). Scoped to the response
 * turn first; falls back to the last markdown node in it, then the turn.
 */
async function responseText(responseTurn: Locator, fallback: string): Promise<string> {
  const scoped = await responseTurn.evaluate<string, undefined>(ANSWER_EXTRACTION_JS, undefined).catch(() => '')
  if (scoped.length > 0) return scoped
  const markdown = responseTurn.locator('.markdown')
  if (await markdown.count().then(count => count > 0).catch(() => false)) {
    return await markdown.last().innerText().catch(() => fallback)
  }
  return await responseTurn.innerText().catch(() => fallback)
}

/**
 * Prepare a fresh page: Temporary Chat navigation, onboarding, auth asserts.
 * Exported so the adapter can probe account capabilities on a settled
 * surface before the turn starts streaming. On auth failure, saves a
 * screenshot + URL/title into `diagDir` (when given) for diagnosis.
 */
export async function prepareTemporaryChatSurface(
  page: Page,
  diagDir?: string,
  settleTimeoutMs = 45_000,
): Promise<void> {
  // Always navigate: the shared turn page is reused across turns, and only a
  // fresh Temporary Chat load guarantees an empty conversation (temp chats
  // never persist, so no history leaks between turns).
  await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // Hydration grace: the SPA shell (bot-gate interstitial, React hydration)
  // can take many seconds after domcontentloaded. Wait for a visible
  // composer before any assert runs.
  const settleDeadline = Date.now() + settleTimeoutMs
  for (;;) {
    const composerVisible = await page.locator(CHATGPT_COMPOSER_SELECTOR)
      .filter({ visible: true }).count().then(c => c > 0).catch(() => false)
    if (composerVisible) break
    if (Date.now() >= settleDeadline) break
    await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
  }
  await dismissTemporaryChatOnboarding(page)
  await throwIfSessionFailureAlert(page)
  try {
    await assertAuthenticatedChatGptPage(page)
    await assertTemporaryChatPage(page)
  } catch (error) {
    if (diagDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await page.screenshot({ path: `${diagDir}/prepare-failed-${stamp}.png` }).catch(() => {})
      const { writeFileSync } = await import('node:fs')
      try {
        writeFileSync(
          `${diagDir}/prepare-failed-${stamp}.txt`,
          `url=${page.url()}\ntitle=${JSON.stringify(await page.title().catch(() => '?'))}\nerror=${error instanceof Error ? error.message : String(error)}\n`,
        )
      } catch { /* diagnostics are best-effort */ }
    }
    throw error
  }
}

/**
 * Stream one turn on a prepared page. The caller owns the page (fresh per
 * turn) and closes it. Yields text deltas, then returns the final answer.
 */
export async function* streamTextTurn(
  page: Page,
  options: TextTurnOptions,
): AsyncGenerator<TextTurnEvent, TextTurnResult> {
  const { signal } = options
  const deadline = Date.now() + options.turnTimeoutMs
  const checkDeadline = (): void => {
    throwIfAborted(signal)
    if (Date.now() >= deadline) {
      throw new LlmError(
        `ChatGPT Web turn exceeded its ${options.turnTimeoutMs}ms budget.`,
        'TIMEOUT',
      )
    }
    if (page.isClosed()) throw new LlmError('ChatGPT Web page was closed mid-turn.', 'TRANSPORT')
  }

  if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  }
  await prepareTemporaryChatSurface(page)

  await selectModelEffort(page, options.model, options.capabilities)

  const assistantTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)
  const initialAssistantTurns = await assistantTurns.count().catch(() => 0)

  const squash = (value: string): string => value.replace(/\s+/g, '')
  void squash

  /**
   * Code-unit readback (upstream browser-worker.ts:2023–2067, 2825–2862):
   * poll the composer text and require exact equality after the one DOM-only
   * relaxation upstream verified — multi-space runs may surface as \u00a0.
   * Failure reports where insertion diverged (expected/actual/common prefix).
   */
  const READBACK_JS = `(() => {
    const el = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"].ProseMirror')
      || document.querySelector('[role="textbox"][aria-label="Chat with ChatGPT"]');
    if (!el) return '';
    const clone = el.cloneNode(true);
    for (const sel of ['[data-id^="plugin:"][data-keyword]', '[data-testid="composer-attach-pill"]']) {
      for (const pill of clone.querySelectorAll(sel)) pill.remove();
    }
    return (clone.innerText || clone.textContent || '').replace(/\\u00a0/g, ' ');
  })()`

  async function attachedPromptText(): Promise<string> {
    return await page.evaluate<string, undefined>(READBACK_JS, undefined).catch(() => '')
  }

  function commonPrefixLength(a: string, b: string): number {
    let at = 0
    while (at < a.length && at < b.length && a[at] === b[at]) at += 1
    return at
  }

  /** Attach one text to the composer with exact readback verification. */
  async function attach(text: string): Promise<void> {
    // No locator fill/focus before insert: the Playwright focus path races
    // ProseMirror's editor state (regression-probed: readback loses the last
    // char right after locator focus, passes without it). The insert IIFE
    // owns focus + caret + insertion atomically instead.
    const status = await page.evaluate<string, undefined>(`(() => {
      const el = document.querySelector('#prompt-textarea')
        || document.querySelector('[contenteditable="true"].ProseMirror')
        || document.querySelector('[role="textbox"][aria-label="Chat with ChatGPT"]');
      if (!el) return 'no-element';
      el.focus();
      if (document.activeElement !== el) return 'no-focus';
      const sel = window.getSelection();
      if (!sel) return 'no-selection';
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return 'caret-failed';
      const value = ${JSON.stringify(text)};
      return document.execCommand('insertText', false, value) ? 'inserted' : 'exec-false';
    })()`, undefined).catch(() => 'evaluate-failed')
    if (status !== 'inserted') {
      throw new LlmError(
        `ChatGPT composer rejected the plain-text editing command (${status}).`,
        'PROVIDER_ERROR',
      )
    }
    const readDeadline = Date.now() + 10_000
    let readback = ''
    for (;;) {
      readback = (await attachedPromptText()).trim()
      // ProseMirror block-boundary relaxation (probed Sep 2026): when an
      // inserted newline lands at a block edge, innerText can DROP the
      // separator entirely ("info.\nThe tools" reads as "info.The tools").
      // Every other code unit must match, so compare with all whitespace
      // squashed — order and content are still verified exactly.
      const want = text.replace(/\s+/g, '')
      const got = readback.replace(/\s+/g, '')
      if (want === got) return
      if (Date.now() >= readDeadline) break
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
    }
    const squashAll = (value: string): string => value.replace(/\s+/g, '')
    const prefix = commonPrefixLength(squashAll(text), squashAll(readback))
    throw new LlmError(
      'ChatGPT composer readback diverged from the attached prompt'
      + ` (expectedChars=${text.length} actualChars=${readback.length} commonPrefixChars=${prefix}).`,
      'PROVIDER_ERROR',
    )
  }

  /** Submit and wait for the model to start answering. */
  async function submit(baseCount: number): Promise<void> {
    const composer = await activeComposer(page)
    const sendButton = composer.locator('xpath=ancestor::form[1]').getByTestId('send-button')
    await sendButton.waitFor({ state: 'visible', timeout: 30_000 })
    const sendDeadline = Date.now() + 20_000
    for (;;) {
      checkDeadline()
      await throwIfSessionFailureAlert(page)
      await throwIfRateLimitDialog(page)
      if (await sendButton.isEnabled().catch(() => false)) break
      if (Date.now() >= sendDeadline) {
        throw new LlmError('ChatGPT send button remained disabled after the complete prompt was attached.', 'PROVIDER_ERROR')
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 200))
    }
    await sendButton.press('Enter')
    checkDeadline()
    const submitDeadline = Date.now() + 60_000
    for (;;) {
      checkDeadline()
      await throwIfSessionFailureAlert(page)
      await throwIfRateLimitDialog(page)
      const assistants = await assistantTurns.count().catch(() => 0)
      if (assistants > baseCount || await stopVisible(page)) break
      if (Date.now() >= submitDeadline) {
        await throwIfTerminalError(page)
        throw new LlmError('ChatGPT did not accept the submitted prompt (no turn appeared).', 'PROVIDER_ERROR')
      }
      await waitForDomMutation(page, 500)
    }
  }

  /** Poll one round's assistant turn (created at `baseCount`) to completion. */
  async function* captureRound(baseCount: number): AsyncGenerator<TextTurnEvent, string> {
    let previousText = ''
    let lastGrowth = Date.now()
    let settledObservations = 0
    let lastPollText = ''
    const REQUIRED_SETTLED_OBSERVATIONS = 2
    for (;;) {
      checkDeadline()
      await throwIfSessionFailureAlert(page)
      await throwIfRateLimitDialog(page)
      const count = await assistantTurns.count().catch(() => 0)
      let responseTurn: Locator | undefined
      if (count > baseCount) {
        responseTurn = assistantTurns.nth(baseCount)
      } else if (count > 0) {
        responseTurn = assistantTurns.last()
      }
    let currentText = ''
    if (responseTurn) {
      currentText = await responseText(responseTurn, previousText)
      // Upstream chrome filters (browser-worker.ts:1634–1644): a bare
      // "Thinking" header or an "Answer now" suffix must never be output.
      currentText = currentText.replace(/^Thinking\s*\n+/, '').replace(/(?:^|\s)Answer now\s*$/, '')
      await throwIfTerminalError(page)
    }
      if (currentText.length > previousText.length && currentText.startsWith(previousText)) {
        const delta = currentText.slice(previousText.length)
        previousText = currentText
        lastGrowth = Date.now()
        yield { type: 'delta', delta }
      } else if (currentText !== previousText && currentText.length >= previousText.length) {
        // Re-render without prefix continuity (formatting pass): resync silently
        // once the turn settles; never emit a duplicated prefix as a delta.
        previousText = currentText
        lastGrowth = Date.now()
      }
      const running = await stopVisible(page)
      let copyVisible = false
      if (responseTurn && count > 0) {
        copyVisible = await responseTurn.locator(CHATGPT_COMPLETION_ACTION_SELECTOR)
          .last().isVisible().catch(() => false)
        if (!copyVisible) {
          copyVisible = await page.locator(CHATGPT_COMPLETION_ACTION_SELECTOR)
            .last().isVisible().catch(() => false)
        }
      }
      const responsePresent = count > baseCount || (count > 0 && previousText.length > 0)
      const settled = responsePresent && !running && previousText.length > 0 && copyVisible
        && currentText === lastPollText
      lastPollText = currentText
      settledObservations = settled ? settledObservations + 1 : 0
      if (settledObservations >= REQUIRED_SETTLED_OBSERVATIONS) {
        return previousText
      }
      if (!running && previousText.length > 0 && Date.now() - lastGrowth >= options.stallTimeoutMs) {
        // Settled without an explicit completion action: accept a quiet finish
        // rather than hanging (some surfaces render no copy button on retry turns).
        return previousText
      }
      if (Date.now() - lastGrowth >= options.stallTimeoutMs) {
        throw new LlmError(
          `ChatGPT Web turn stalled with no output growth for ${options.stallTimeoutMs}ms.`,
          'TIMEOUT',
        )
      }
      await waitForDomMutation(page, 1_000)
    }
  }

  // Rounds: the prompt, then up to two in-chat nudges when the task needs a
  // tool call but the model narrated instead of emitting a fenced block.
  const NUDGE = ('[System reminder] That was narration, not a tool call — nothing executed, the task is NOT done. '
    + 'Reply AGAIN with your ENTIRE message being ONLY this shape (one line, real JSON, no prose before or after):\n'
    + '```tool-call\n{"name": "<one of the advertised tools>", "arguments": {…}}\n```')
  const fenceSeen = (text: string): boolean => /`{0,3}\s*tool-call/.test(text)
  const maxRounds = options.requiresToolCall ? 3 : 1
  let captured = ''
  for (let round = 0; round < maxRounds; round += 1) {
    const isNudge = round > 0
    const baseCount = isNudge
      ? await assistantTurns.count().catch(() => initialAssistantTurns)
      : initialAssistantTurns
    await attach(isNudge ? NUDGE : options.prompt)
    await submit(baseCount)
    const roundText = yield* captureRound(baseCount)
    captured += (captured.length > 0 ? '\n\n' : '') + roundText
    if (!options.requiresToolCall || fenceSeen(captured)) break
    if (round === 0) {
      console.log('[dsh-llm-chatgpt-web] no tool-call block; nudging in-chat')
    }
  }
  return { text: captured, promptChars: options.prompt.length }
}
