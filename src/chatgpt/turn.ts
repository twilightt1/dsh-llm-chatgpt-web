/**
 * One text turn on a fresh Temporary Chat page: prepare → attach → send →
 * stream answer deltas until the completion predicate holds.
 *
 * Extraction is the upstream technique (codex-chatgpt-web browser-worker
 * responseDomSnapshot): classify `.markdown` roots into commentary vs
 * answer, flatten the ANSWER roots into semantic block segments carrying
 * `data-start/data-end` source ranges, and stream them through the
 * append-only ChatGptMarkdownBuffer (turndown HTML→Markdown) so fences,
 * tables, and formatting survive and ChatGPT re-renders never retract
 * streamed text. The completion predicate mirrors upstream: response
 * present, not running, non-empty text, copy action visible, signature
 * stable for CHATGPT_COMPLETION_SETTLE_MS.
 * @module dsh-llm-chatgpt-web/chatgpt-turn
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright-core'
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
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
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from './markdown.ts'
import { selectModelEffort } from './effort.ts'

/** Composer budget in chars (measured upstream envelope, fail-closed). */
export const COMPOSER_CHAR_BUDGET = 200_000

/** Completion must hold this long before the turn is accepted (upstream settle). */
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000
/** Grace for the copy action to appear after generation stops (upstream). */
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000

export interface TextTurnOptions {
  model: string
  prompt: string
  capabilities: ChatGptWebAccountCapabilities
  turnTimeoutMs: number
  stallTimeoutMs: number
  signal?: AbortSignal
  /**
   * In-chat self-correction: when set, an answer with NO tool-call block
   * while the prompt advertised tools gets up to two follow-up nudges in
   * the SAME Temporary Chat ("emit the block, do not narrate"), then its
   * new answer is captured. Detects both ```tool-call fences and
   * eaten-backtick forms.
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
 * One full DOM snapshot of the response turn: answer-root classification
 * (commentary/chain-of-thought/status containers are structurally excluded)
 * plus semantic block segments with source ranges — ported from upstream
 * responseDomSnapshot. Runs entirely in the page; returns JSON-serializable
 * segments the ChatGptMarkdownBuffer consumes.
 */
interface ResponseSnapshotSegment {
  key: string
  tag: string
  html: string
  text: string
  group?: string
  sourceStart?: number
  sourceEnd?: number
  streamable: boolean
}

interface ResponseSnapshot {
  responsePresent: boolean
  segments: ResponseSnapshotSegment[]
  completionActionVisible: boolean
  visibleText: string
  /** Stop button visible = generation still running (observed in-page). */
  running: boolean
  /** Rate-limit dialog text present (upstream guard, in-page). */
  rateLimited: boolean
  /** Session-expiry alert present (upstream guard, in-page). */
  sessionExpired: boolean
}

/**
 * Build the page-level response snapshot expression (a self-invoking IIFE
 * string). Playwright treats a string as an *expression* (isFunction is
 * false for strings), so it must be invoked inline; arguments cannot be
 * passed to a non-function expression, hence `baseCount` is embedded via
 * JSON. A real module function would break under dev transpilers (tsx/esbuild
 * inject `__name(...)` helpers into the serialized source, which do not
 * exist in the page) — the IIFE string is the only form that survives every
 * pipeline (tsx dev, tsdown lib build) unchanged.
 *
 * The snapshot selects the response turn INSIDE the page: the (baseCount)-th
 * conversation-turn section that contains an assistant-authored message,
 * classifies answer roots vs commentary (streaming-status / cot containers),
 * flattens answer roots into semantic block segments with `data-start/
 * data-end` source ranges, and reports completion evidence.
 */
function buildResponseSnapshotExpression(baseCount: number): string {
  return `(() => {
  const BASE = ${JSON.stringify(baseCount)};
  const renderedInDom = (candidate) => {
    const style = getComputedStyle(candidate);
    return candidate.isConnected
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  };
  const sections = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
  const responseSections = sections.filter(section => (
    section.querySelector('[data-message-author-role="assistant"]') !== null
    || section.querySelector('[data-turn="assistant"]') !== null
  ));
  const responseSection = responseSections[BASE] ?? responseSections[responseSections.length - 1];
  const target = responseSection ?? document.body;
  const allMarkdownRoots = [...target.querySelectorAll('.markdown')]
    .filter(candidate => !candidate.parentElement || candidate.parentElement.closest('.markdown') === null)
    .filter(renderedInDom);
  const streamingStatusContainers = [...target.querySelectorAll('[data-streaming-response-status]')]
    .filter(renderedInDom);
  const selectAnswerRoots = (markdownRoots, statusContainers) => {
    const firstStatus = statusContainers[0];
    const commentary = markdownRoots.filter(candidate => (
      candidate.closest('[data-streaming-response-status]') !== null
      || candidate.closest('[data-testid^="cot-v5"]') !== null
      || (firstStatus !== undefined && Boolean(
        candidate.compareDocumentPosition(firstStatus) & 4
      ))
    ));
    return { commentary, answer: markdownRoots.filter(c => !commentary.includes(c)) };
  };
  const classified = selectAnswerRoots(allMarkdownRoots, streamingStatusContainers);
  const answerRoots = classified.answer;
  const segments = [];
  const blockTags = new Set([
    'address','article','aside','blockquote','div','dl','fieldset','figcaption',
    'figure','footer','form','h1','h2','h3','h4','h5','h6','header','hr',
    'li','main','nav','ol','p','pre','section','table','ul',
  ]);
  let listGroupIndex = 0;
  const sourceRange = (candidate) => {
    const s = candidate.getAttribute('data-start');
    const e = candidate.getAttribute('data-end');
    if (s === null || e === null || !s.trim() || !e.trim()) return undefined;
    const start = Number(s), end = Number(e);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? { start, end } : undefined;
  };
  const appendSegment = (element, html, text, groupHint) => {
    const range = sourceRange(element);
    const tag = element.tagName.toLowerCase();
    let group;
    if (groupHint !== undefined) group = groupHint;
    else if (range !== undefined) group = 'block:' + range.start;
    segments.push({
      key: (range !== undefined ? 'r:' + range.start + ':' + tag : 'g:' + (group ?? segments.length) + ':' + tag + ':' + segments.length),
      tag,
      html,
      text,
      ...(group !== undefined ? { group } : {}),
      ...(range !== undefined ? { sourceStart: range.start, sourceEnd: range.end } : {}),
      streamable: false,
    });
  };
  for (const answerRoot of answerRoots) {
    const children = [...answerRoot.children].filter(renderedInDom);
    const visibleChildren = children.length > 0 ? children : [answerRoot];
    for (const child of visibleChildren) {
      const tag = child.tagName.toLowerCase();
      if (!blockTags.has(tag)) {
        appendSegment(child, child.outerHTML, child.textContent ?? '', undefined);
        continue;
      }
      if (tag === 'ol' || tag === 'ul') {
        const range = sourceRange(child);
        const group = range !== undefined
          ? 'list:' + range.start + ':' + tag
          : 'list:' + (listGroupIndex++) + ':' + tag;
        const items = [...child.children].filter(li => li.tagName === 'LI');
        for (const item of items) {
          appendSegment(item, item.outerHTML, item.textContent ?? '', group);
        }
        continue;
      }
      appendSegment(child, child.outerHTML, child.textContent ?? '', undefined);
    }
  }
  for (let i = 0; i < segments.length; i++) {
    segments[i].streamable = i < segments.length - 1;
  }
  const completionActionVisible = [...target.querySelectorAll('button[data-testid="copy-turn-action-button"]')]
    .some(renderedInDom);
  const stopButtons = [...document.querySelectorAll('[data-testid="stop-button"]')]
    .filter(renderedInDom);
  const rateDialog = [...document.querySelectorAll('[role="dialog"]')]
    .some(d => d.textContent && /Too many requests/i.test(d.textContent) && /making requests too quickly/i.test(d.textContent));
  const sessionAlert = [...document.querySelectorAll('[role="alert"], [role="dialog"]')]
    .some(d => d.textContent && /Your session has expired/i.test(d.textContent));
  const visibleText = segments.map(s => s.text).join('\\n\\n');
  return {
    responsePresent: segments.length > 0,
    segments,
    completionActionVisible,
    visibleText,
    running: stopButtons.length > 0,
    rateLimited: rateDialog,
    sessionExpired: sessionAlert,
  };
})()`
}

/**
 * Snapshot the response turn (assistant turn #`baseCount` on the page) into
 * segments + completion evidence. Page-level IIFE expression: no locator
 * handles, no transpiler-sensitive function serialization.
 */
async function responseSnapshot(page: Page, baseCount: number): Promise<ResponseSnapshot> {
  const fallback = (): ResponseSnapshot => ({ responsePresent: false, segments: [], completionActionVisible: false, visibleText: '', running: false, rateLimited: false, sessionExpired: false })
  try {
    return await page.evaluate(buildResponseSnapshotExpression(baseCount))
  } catch (error) {
    console.log(
      `[dsh-llm-chatgpt-web] snapshot evaluate failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return fallback()
  }
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
  // Always navigate: a fresh Temporary Chat load guarantees an empty
  // conversation (temp chats never persist, so no history leaks between turns).
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

  /**
   * Code-unit readback (upstream browser-worker): poll the composer text and
   * require exact equality after the one DOM-only relaxation upstream
   * verified — multi-space runs may surface as NBSP, and ProseMirror block
   * edges can drop newlines. Compare with whitespace squashed; every other
   * code unit must match.
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
      // separator entirely. Every other code unit must match, so compare
      // with all whitespace squashed — order and content are verified exactly.
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
    const markdownBuffer = new ChatGptMarkdownBuffer()
    let previousVisible = ''
    let lastGrowth = Date.now()
    let lastSignature = ''
    let stableSince: number | undefined
    let copyMissingSince: number | undefined
    const REQUIRED_STABLE_MS = CHATGPT_COMPLETION_SETTLE_MS
    for (;;) {
      checkDeadline()
      // ONE evaluate per poll (upstream discipline): the snapshot IIFE
      // carries answer segments, stop-button (running), and the rate-limit /
      // session guards. Per-poll locator round-trips (guard isVisible x4,
      // count, stopVisible) previously throttled ChatGPT's streaming DOM so
      // hard that short answers never finished rendering.
      const snapshot = await responseSnapshot(page, baseCount)
      if (snapshot.rateLimited) {
        throw new LlmError('ChatGPT rate limit: too many requests. Try again in a few minutes.', 'RATE_LIMIT')
      }
      if (snapshot.sessionExpired) {
        throw new LlmError(
          'The ChatGPT session has expired. Delete the plugin profile directory and run again to sign in.',
          'AUTH',
        )
      }
      if (page.isClosed()) throw new LlmError('ChatGPT Web page was closed mid-turn.', 'TRANSPORT')
      const running = snapshot.running
      if (process.env['DSH_CHATGPT_DEBUG'] === '1') {
        console.log(
          `[dsh-llm-chatgpt-web] poll base=${baseCount} segs=${snapshot.segments.length}`
          + ` visible=${snapshot.visibleText.length} copy=${snapshot.completionActionVisible}`
          + ` running=${running}`,
        )
      }

      // Segment texts are raw DOM text; commit Markdown via the buffer.
      const segments = snapshot.segments.map(segment => ({
        ...segment,
        text: chatGptHtmlToMarkdown(segment.html) || segment.text,
      }))
      let delta = ''
      try {
        delta = markdownBuffer.observe(segments)
      } catch {
        // Consistency errors are surfaced as PROVIDER_ERROR below.
        throw new LlmError(
          'ChatGPT rewrote text that was already streamed; the turn cannot be completed safely.',
          'PROVIDER_ERROR',
        )
      }
      if (delta.length > 0) {
        yield { type: 'delta', delta }
      }

      // Upstream chrome filters: a bare "Thinking" header or an "Answer now"
      // suffix must never be output.
      const visible = snapshot.visibleText.replace(/^Thinking\s*\n+/, '').replace(/(?:^|\s)Answer now\s*$/, '')
      const responsePresent = snapshot.responsePresent

      // Completion (upstream predicate + signature stability): response
      // present, not running, non-empty text, copy action visible, and the
      // signature unchanged for REQUIRED_STABLE_MS.
      const signature = `${visible}\0${snapshot.segments.map(s => s.key).join(',')}`
      const complete = responsePresent && !running && visible.length > 0 && snapshot.completionActionVisible
      if (complete && signature === lastSignature) {
        stableSince ??= Date.now()
        if (Date.now() - stableSince >= REQUIRED_STABLE_MS) {
          const final = markdownBuffer.finish()
          if (final.delta.length > 0) yield { type: 'delta', delta: final.delta }
          return final.markdown.length > 0 ? final.markdown : visible
        }
      } else {
        stableSince = undefined
      }
      lastSignature = signature
      if (visible.length > previousVisible.length) {
        lastGrowth = Date.now()
      }
      previousVisible = visible

      // Settled without a copy action: upstream grants a grace window, then
      // accepts a quiet finish (some surfaces render no copy button).
      if (responsePresent && !running && visible.length > 0 && !snapshot.completionActionVisible) {
        copyMissingSince ??= Date.now()
        if (Date.now() - copyMissingSince >= CHATGPT_COMPLETION_ACTION_GRACE_MS) {
          const final = markdownBuffer.finish()
          if (final.delta.length > 0) yield { type: 'delta', delta: final.delta }
          return final.markdown.length > 0 ? final.markdown : visible
        }
      } else {
        copyMissingSince = undefined
      }

      // Stall verdict: only when generation is NOT running and nothing has
      // grown. A visible stop button proves ChatGPT is still generating
      // (reasoning models can think for many minutes before first text), so
      // the whole-turn deadline above — not the stall clock — governs it.
      if (!running && Date.now() - lastGrowth >= options.stallTimeoutMs) {
        if (responsePresent && visible.length > 0) {
          // Quiet finish: settled, no copy action, grace already elapsed.
          const final = markdownBuffer.finish()
          if (final.delta.length > 0) yield { type: 'delta', delta: final.delta }
          return final.markdown.length > 0 ? final.markdown : visible
        }
        console.log(
          `[dsh-llm-chatgpt-web] stall diagnosis: baseCount=${baseCount}`
          + ` segments=${snapshot.segments.length} visible=${visible.length} running=${running}`
          + ` copyAction=${snapshot.completionActionVisible} url=${page.url()}`,
        )
        if (process.env['DSH_CHATGPT_DEBUG'] === '1') {
          const stamp = Date.now()
          await page.screenshot({ path: `/tmp/dsh-stall-${stamp}.png` }).catch(() => {})
          console.log(`[dsh-llm-chatgpt-web] stall screenshot: /tmp/dsh-stall-${stamp}.png`)
        }
        throw new LlmError(
          `ChatGPT Web turn stalled with no output growth for ${options.stallTimeoutMs}ms.`,
          'TIMEOUT',
        )
      }
      // Upstream cadence: a plain 250ms sleep between polls; no dense
      // MutationObserver evaluate inside the streaming loop.
      await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
    }
  }

  // Rounds: the prompt, then up to two in-chat nudges when the task needs a
  // tool call but the model narrated instead of emitting a fenced block.
  const NUDGE = ('[System reminder] Your last reply was narration or a refusal — nothing executed, the task is NOT done. '
    + 'The tool interface IS available in this chat (the harness executes fenced blocks and returns results here); claiming otherwise is incorrect. '
    + 'Reply AGAIN with your ENTIRE message being ONLY this shape (real JSON, no prose before or after, use a real tool name and real argument values from the task):\n'
    + '```tool-call\n{"name": "<one of the advertised tools>", "arguments": {…}}\n```')
  // A usable fence needs the tag AND a JSON body start inside the block —
  // a bare "tool-call" word (backticks eaten) with the payload after a
  // stray fence marker still counts; prose mentioning tool-call does not.
  const fenceSeen = (text: string): boolean => /`{0,3}\s*tool-call[ \t]*\r?\n?[^{]*\{/.test(text)
  const maxRounds = options.requiresToolCall ? 3 : 1
  let captured = ''
  const round0Base = await assistantTurns.count().catch(() => initialAssistantTurns)
  for (let round = 0; round < maxRounds; round += 1) {
    const isNudge = round > 0
    const baseCount = isNudge
      ? await assistantTurns.count().catch(() => round0Base)
      : round0Base
    await attach(isNudge ? NUDGE : options.prompt)
    await submit(baseCount)
    const roundText = yield* captureRound(baseCount)
    // Only the FINAL round's text is the answer: nudged rounds are failed
    // attempts (refusals/narration), and including them would duplicate
    // stale text (observed live: "FILE WRITTEN" x3 from 3 rounds).
    captured = roundText
    if (!options.requiresToolCall || fenceSeen(captured)) break
    if (round === 0) {
      console.log('[dsh-llm-chatgpt-web] no tool-call block; nudging in-chat')
    }
  }
  return { text: captured, promptChars: options.prompt.length }
}
