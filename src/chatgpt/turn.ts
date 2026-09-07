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
  CHATGPT_USER_TURN_SELECTOR,
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
}

export interface TextTurnResult {
  text: string
  promptChars: number
}

/** Events from a streaming turn: deltas, then return of the final result. */
export type TextTurnEvent =
  | { type: 'delta'; delta: string }

/**
 * Plain-text insertion through the browser editing command (upstream lesson:
 * CDP typing can trigger Lexical Markdown shortcuts and corrupt backticks).
 * Runs in page context — must stay self-contained.
 */
function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus()
  if (document.activeElement !== element) return false
  const selection = window.getSelection()
  if (!selection) return false
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode)
  if (!alreadyPlaced) {
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) {
    return false
  }
  return document.execCommand('insertText', false, value)
}

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

async function activeComposer(page: Page, timeoutMs = 30_000): Promise<Locator> {
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
 * Read the answer text, preferring the markdown content node: the turn
 * container can also hold UI chrome (e.g. personality nudges) that must not
 * leak into model output.
 */
async function responseText(responseTurn: Locator, fallback: string): Promise<string> {
  const markdown = responseTurn.locator('.markdown')
  const hasMarkdown = await markdown.count().then(count => count > 0).catch(() => false)
  if (hasMarkdown) {
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
  settleTimeoutMs = 90_000,
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

  const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR)
  const assistantTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)
  const initialUserTurns = await userTurns.count().catch(() => 0)
  const initialAssistantTurns = await assistantTurns.count().catch(() => 0)

  // Attach: clear, then transport the whole prompt through one editing command.
  const composer = await activeComposer(page)
  await composer.fill('')
  await composer.focus()
  const inserted = await composer.evaluate(insertPlainTextIntoComposer, options.prompt, { timeout: 20_000 })
  if (!inserted) {
    throw new LlmError('ChatGPT composer rejected the plain-text editing command.', 'PROVIDER_ERROR')
  }
  const readback = await composer.innerText().catch(() => '')
  // ProseMirror splits each newline into its own <p>, so innerText renders
  // block boundaries as double newlines. Compare whitespace-insensitively
  // (order + completeness of non-whitespace content is what matters).
  const squash = (value: string): string => value.replace(/\s+/g, '')
  const tail = squash(options.prompt.slice(-240))
  if (tail.length > 0 && (!squash(readback).includes(tail)
    || squash(readback).length < squash(options.prompt).length * 0.95)) {
    throw new LlmError('ChatGPT composer readback does not contain the attached prompt.', 'PROVIDER_ERROR')
  }

  // Send: the enabled send button is the authority, then Enter.
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

  // Wait for submission evidence: new user turn, new assistant turn, or running.
  const submitDeadline = Date.now() + 60_000
  for (;;) {
    checkDeadline()
    await throwIfSessionFailureAlert(page)
    await throwIfRateLimitDialog(page)
    const users = await userTurns.count().catch(() => initialUserTurns)
    const assistants = await assistantTurns.count().catch(() => initialAssistantTurns)
    if (users > initialUserTurns || assistants > initialAssistantTurns || await stopVisible(page)) break
    if (Date.now() >= submitDeadline) {
      await throwIfTerminalError(page)
      throw new LlmError('ChatGPT did not accept the submitted prompt (no turn appeared).', 'PROVIDER_ERROR')
    }
    await waitForDomMutation(page, 500)
  }

  // Stream: poll the response turn's text, emit deltas, stop on completion.
  let previousText = ''
  let lastGrowth = Date.now()
  // Completion must HOLD across polls: the stop button can flicker and the
  // copy action can render a beat before the final tokens land. Accept only
  // after consecutive settled observations with zero text growth.
  let settledObservations = 0
  let lastPollText = ''
  const REQUIRED_SETTLED_OBSERVATIONS = 3
  for (;;) {
    checkDeadline()
    await throwIfSessionFailureAlert(page)
    await throwIfRateLimitDialog(page)
    const count = await assistantTurns.count().catch(() => 0)
    let responseTurn: Locator | undefined
    if (count > initialAssistantTurns) {
      responseTurn = assistantTurns.nth(initialAssistantTurns)
    } else if (count > 0) {
      responseTurn = assistantTurns.last()
    }
    let currentText = ''
    if (responseTurn) {
      currentText = await responseText(responseTurn, previousText)
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
    const responsePresent = count > initialAssistantTurns || (count > 0 && previousText.length > 0)
    const settled = responsePresent && !running && previousText.length > 0 && copyVisible
      && currentText === lastPollText
    lastPollText = currentText
    settledObservations = settled ? settledObservations + 1 : 0
    if (settledObservations >= REQUIRED_SETTLED_OBSERVATIONS) {
      return { text: previousText, promptChars: options.prompt.length }
    }
    if (!running && previousText.length > 0 && Date.now() - lastGrowth >= options.stallTimeoutMs) {
      // Settled without an explicit completion action: accept a quiet finish
      // rather than hanging (some surfaces render no copy button on retry turns).
      return { text: previousText, promptChars: options.prompt.length }
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
