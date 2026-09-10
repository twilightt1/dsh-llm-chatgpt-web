/**
 * One text turn on a fresh ChatGPT page: prepare → attach → send →
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
  assertAuthenticatedChatGptPage,
  assertChatGptSurfaceUrl,
  chatGptSurfaceUrl,
  type ChatGptSurface,
} from './session.ts'
import {
  dismissTemporaryChatOnboarding,
  throwIfRateLimitDialog,
  throwIfSessionFailureAlert,
  throwIfTerminalError,
} from './guards.ts'
import type { ChatGptWebAccountCapabilities } from './session.ts'
import { conversationIdFromUrl } from './conversation-cleanup.ts'
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from './markdown.ts'
import { selectModelEffort } from './effort.ts'
import {
  arbitrateNativeObservation,
  selectChatGptConnector,
  type NativeBrowserControl,
} from './connector.ts'
import type { BrokerToolRequest } from '../native/types.ts'
import { ChatGptProgressTracker } from './progress.ts'
import type { ChatGptProgressSample, ChatGptProgressStage } from './progress.ts'

/** Composer budget in chars (measured upstream envelope, fail-closed). */
export const COMPOSER_CHAR_BUDGET = 200_000

/** Completion must hold this long before the turn is accepted (upstream settle). */
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000
/** Grace for a completed response shell to gain visible text. */
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000
/** Grace for the copy action to appear after generation stops (upstream). */
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000

export interface ChatGptCompletionState {
  responsePresent: boolean
  running: boolean
  currentText: string
  currentHtml?: string
  completionActionVisible: boolean
}

/** Require positive completion evidence to remain unchanged before accepting a turn. */
export class ChatGptCompletionTracker {
  private candidate: { signature: string; since: number } | undefined

  constructor(private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS) {}

  update(state: ChatGptCompletionState, now = Date.now()): boolean {
    const complete = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && state.completionActionVisible
    if (!complete) {
      this.candidate = undefined
      return false
    }
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now }
      return false
    }
    return now - this.candidate.since >= this.stableMs
  }
}

/** Fail closed when response DOM or completed-turn evidence stays unhealthy. */
export class ChatGptObservationFaultTracker {
  private consecutive = 0

  constructor(private readonly maximum = 8) {}

  recordSuccess(): void {
    this.consecutive = 0
  }

  recordFailure(error: unknown): number {
    this.consecutive += 1
    if (this.consecutive > this.maximum) {
      throw new LlmError(
        `ChatGPT browser observation failed ${this.consecutive} times in a row: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }
    return this.consecutive
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false
  private missingResponseSince: number | undefined
  private emptyCompletionSince: number | undefined
  private missingCompletionAction: { text: string; since: number } | undefined

  constructor(
    private readonly missingResponseMs: number,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  update(state: Omit<ChatGptCompletionState, 'currentHtml'>, now = Date.now()): string | undefined {
    if (state.responsePresent) {
      this.sawResponse = true
      this.missingResponseSince = undefined
    } else {
      this.missingResponseSince ??= now
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? 'ChatGPT response DOM disappeared while the browser turn was active'
          : 'ChatGPT did not create a response DOM after the message was sent'
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionVisible
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined
    } else {
      this.emptyCompletionSince ??= now
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return 'ChatGPT browser turn completed without a final answer'
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now }
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return 'ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed'
    }
    return undefined
  }
}

/** Identify exactly one assistant turn created after the submission baseline. */
export function resolveNewAssistantTurnIdentity(
  initial: readonly string[],
  current: readonly string[],
): string | undefined {
  const previous = new Set(initial)
  const added = current.filter(identity => !previous.has(identity))
  if (added.length > 1) {
    throw new LlmError(
      `ChatGPT exposed ${added.length} new assistant turns for one submitted message.`,
      'PROVIDER_ERROR',
    )
  }
  return added[0]
}

/** Keep a live binding, or bind the one replacement added since submission. */
export function resolveReboundAssistantTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity
  return resolveNewAssistantTurnIdentity(initial, current)
}

export interface TextTurnOptions {
  model: string
  prompt: string
  capabilities: ChatGptWebAccountCapabilities
  /** Temporary Chat for text; connector-enabled normal chat for native MCP. */
  surface?: ChatGptSurface
  /** Called after ChatGPT accepts the prompt and creates a normal conversation. */
  onPromptSubmitted?: () => void
  /** Called with the exact newly-created normal conversation ID. */
  onConversationCreated?: (conversationId: string) => void
  turnTimeoutMs: number
  stallTimeoutMs: number
  signal?: AbortSignal
  native?: NativeBrowserControl
}

export type TextTurnResult =
  | { readonly kind: 'completed'; readonly text: string; readonly promptChars: number }
  | {
      readonly kind: 'tool-batch'
      readonly text: string
      readonly promptChars: number
      readonly calls: readonly BrokerToolRequest[]
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
 * passed to a non-function expression, hence the bound response identity is
 * embedded as JSON. A real module function would break under dev transpilers (tsx/esbuild
 * inject `__name(...)` helpers into the serialized source, which do not
 * exist in the page) — the IIFE string is the only form that survives every
 * pipeline (tsx dev, tsdown lib build) unchanged.
 *
 * The snapshot selects only the assistant turn identity bound after submit;
 * it never falls back to an older turn or to the whole document,
 * classifies answer roots vs commentary (streaming-status / cot containers),
 * flattens answer roots into semantic block segments with `data-start/
 * data-end` source ranges, and reports completion evidence.
 */
function buildResponseSnapshotExpression(responseIdentity: string): string {
  return `(() => {
  const RESPONSE_ID = ${JSON.stringify(responseIdentity)};
  const renderedInDom = (candidate) => {
    const style = getComputedStyle(candidate);
    return candidate.isConnected
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  };
  const running = [...document.querySelectorAll('[data-testid="stop-button"]')].some(renderedInDom);
  const rateLimited = [...document.querySelectorAll('[role="dialog"]')]
    .some(dialog => dialog.textContent && /Too many requests/i.test(dialog.textContent)
      && /making requests too quickly/i.test(dialog.textContent));
  const sessionExpired = [...document.querySelectorAll('[role="alert"], [role="dialog"]')]
    .some(alert => alert.textContent && /Your session has expired/i.test(alert.textContent));
  const target = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
    .find(section => section.getAttribute('data-testid') === RESPONSE_ID);
  if (!target) {
    return {
      responsePresent: false,
      segments: [],
      completionActionVisible: false,
      visibleText: '',
      running,
      rateLimited,
      sessionExpired,
    };
  }
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
  const flattened = [];
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
    const sourceStart = Number(s), sourceEnd = Number(e);
    return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
      ? { sourceStart, sourceEnd } : undefined;
  };
  const appendBlock = (child) => {
    const tag = child.tagName.toLowerCase();
    const range = sourceRange(child);
    const listItems = tag === 'ol' || tag === 'ul'
      ? [...child.children].filter(candidate => candidate.tagName === 'LI')
      : [];
    if (listItems.length === 0) {
      flattened.push({ tag, html: child.outerHTML, text: child.innerText.trim(), ...(range ?? {}) });
      return;
    }
    const group = range
      ? 'list:' + range.sourceStart + ':' + tag
      : 'list:' + (listGroupIndex++) + ':' + tag;
    const orderedStart = tag === 'ol' ? Number(child.getAttribute('start') ?? '1') : undefined;
    listItems.forEach((item, itemIndex) => {
      const shell = child.cloneNode(false);
      shell.removeAttribute('data-is-last-node');
      if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
        shell.setAttribute('start', String(orderedStart + itemIndex));
      }
      shell.append(item.cloneNode(true));
      flattened.push({
        tag: tag + ':item',
        html: shell.outerHTML,
        text: item.innerText.trim(),
        group,
        ...(sourceRange(item) ?? {}),
      });
    });
  };
  for (const answerRoot of answerRoots) {
    const children = [...answerRoot.children];
    const hasBlockChildren = children.some(child => blockTags.has(child.tagName.toLowerCase()));
    if (!hasBlockChildren) {
      if (answerRoot.innerHTML.trim()) flattened.push({
        tag: 'root',
        html: answerRoot.innerHTML,
        text: answerRoot.innerText.trim(),
        ...(sourceRange(answerRoot) ?? {}),
      });
      continue;
    }
    let inlineRun = [];
    const flushInlineRun = () => {
      if (inlineRun.length === 0) return;
      const nodes = inlineRun;
      inlineRun = [];
      const shell = document.createElement('span');
      nodes.forEach(node => shell.append(node.cloneNode(true)));
      const text = (shell.textContent ?? '').trim();
      if (!text) return;
      const ranges = nodes.flatMap(node => node instanceof Element
        ? [node, ...node.querySelectorAll('[data-start][data-end]')]
        : []).map(sourceRange).filter(Boolean);
      flattened.push({
        tag: 'inline',
        html: shell.outerHTML,
        text,
        ...(ranges.length > 0 ? {
          sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
          sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
        } : {}),
      });
    };
    answerRoot.childNodes.forEach(node => {
      if (node instanceof HTMLElement && blockTags.has(node.tagName.toLowerCase())) {
        flushInlineRun();
        appendBlock(node);
      } else {
        inlineRun.push(node);
      }
    });
    flushInlineRun();
  }
  const segments = flattened.map((segment, index, all) => ({
    key: segment.sourceStart !== undefined
      ? segment.sourceStart + ':' + segment.tag
      : index + ':' + segment.tag,
    ...segment,
    streamable: index < all.length - 1,
  }));
  const rendered = answerRoots.at(-1);
  const completionActionVisible = rendered !== undefined && [...target.querySelectorAll('button[data-testid="copy-turn-action-button"]')]
    .filter(renderedInDom)
    .some(candidate => !rendered.contains(candidate)
      && Boolean(rendered.compareDocumentPosition(candidate) & 4));
  const visibleText = answerRoots.map(root => root.innerText.trim()).filter(Boolean).join('\\n\\n');
  return {
    responsePresent: true,
    segments,
    completionActionVisible,
    visibleText,
    running,
    rateLimited,
    sessionExpired,
  };
})()`
}

/**
 * Snapshot one identity-bound assistant response into segments + completion
 * evidence. Page-level IIFE expression: no locator
 * handles, no transpiler-sensitive function serialization.
 */
async function responseSnapshot(page: Page, responseIdentity: string): Promise<ResponseSnapshot> {
  return await page.evaluate(buildResponseSnapshotExpression(responseIdentity))
}

/**
 * Prepare a fresh page: surface navigation, onboarding when applicable, and
 * auth asserts. Exported so the adapter can probe account capabilities on a
 * settled surface before the turn starts streaming. On auth failure, saves a
 * screenshot + URL/title into `diagDir` (when given) for diagnosis.
 */
export async function prepareChatGptSurface(
  page: Page,
  surface: ChatGptSurface = 'temporary',
  diagDir?: string,
  settleTimeoutMs = 45_000,
): Promise<void> {
  // Always navigate: a fresh page prevents transcript and autocomplete state
  // from leaking between turns. Temporary Chat additionally prevents history
  // persistence; connector turns use normal chat because ChatGPT disables
  // connectors in Temporary Chat.
  await page.goto(chatGptSurfaceUrl(surface), { waitUntil: 'domcontentloaded', timeout: 60_000 })
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
  if (surface === 'temporary') await dismissTemporaryChatOnboarding(page)
  // Run this before account capability probing: a throttle page can leave the
  // composer mounted while withholding model controls, otherwise the probe
  // burns its full selector timeout before exposing the real RATE_LIMIT.
  await throwIfRateLimitDialog(page)
  await throwIfSessionFailureAlert(page)
  try {
    await assertAuthenticatedChatGptPage(page)
    assertChatGptSurfaceUrl(page.url(), surface)
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

/** Backward-compatible text-mode helper for callers that explicitly need Temporary Chat. */
export async function prepareTemporaryChatSurface(
  page: Page,
  diagDir?: string,
  settleTimeoutMs = 45_000,
): Promise<void> {
  return prepareChatGptSurface(page, 'temporary', diagDir, settleTimeoutMs)
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
  let progressTracker: ChatGptProgressTracker | undefined
  const nativeRevision = (): number => options.native?.progressRevision() ?? 0
  const assertProgress = (stage: ChatGptProgressStage): void => {
    progressTracker?.assertAlive(stage)
  }
  const observeProgress = (sample: ChatGptProgressSample): void => {
    progressTracker?.observe(sample)
  }
  const noteNativeBatch = (): void => {
    if (progressTracker === undefined || options.native === undefined) return
    progressTracker.mark('tool-batch', nativeRevision())
  }
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

  // The caller prepares this exact page once before capability probing. A
  // second navigation here races a fresh SPA hydration and discards that
  // settled document.
  const surface = options.surface ?? 'temporary'
  await assertAuthenticatedChatGptPage(page)
  assertChatGptSurfaceUrl(page.url(), surface)
  if (options.native !== undefined && surface !== 'connector') {
    throw new LlmError('Native MCP requires the connector-enabled normal ChatGPT surface.', 'PROVIDER_ERROR')
  }
  // Rate limits can be rendered before either selector hydrates. Check the
  // settled page first so a throttle is not misreported as a model or
  // connector UI failure (and is not retried as one).
  await throwIfRateLimitDialog(page)
  await selectModelEffort(page, options.model, options.capabilities)
  if (options.native !== undefined) {
    await throwIfRateLimitDialog(page)
    await selectChatGptConnector(page, options.native.connectorName, signal)
  }

  const assistantTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)
  const assistantTurnIdentities = async (): Promise<string[]> => {
    const identities = await assistantTurns.evaluateAll(elements => (
      elements.map(element => element.getAttribute('data-testid'))
    ))
    if (identities.some(identity => typeof identity !== 'string' || !identity.startsWith('conversation-turn-'))) {
      throw new LlmError('ChatGPT assistant turn has no stable identity.', 'PROVIDER_ERROR')
    }
    const typed = identities as string[]
    if (new Set(typed).size !== typed.length) {
      throw new LlmError('ChatGPT exposed duplicate assistant turn identities.', 'PROVIDER_ERROR')
    }
    return typed
  }
  const initialAssistantTurns = await assistantTurnIdentities()
  let conversationNotified = false
  const notifyConversationCreated = async (): Promise<void> => {
    if (options.onConversationCreated === undefined || conversationNotified) return
    const deadline = Date.now() + 10_000
    for (;;) {
      const conversationId = conversationIdFromUrl(page.url())
      if (conversationId !== undefined) {
        options.onConversationCreated(conversationId)
        conversationNotified = true
        return
      }
      if (Date.now() >= deadline) {
        throw new LlmError(
          'ChatGPT connector turn did not expose a stable conversation ID after submission.',
          'PROVIDER_ERROR',
        )
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
    }
  }

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

  type SubmitResult =
    | { readonly kind: 'assistant'; readonly identity: string }
    | { readonly kind: 'tool-batch'; readonly calls: readonly BrokerToolRequest[] }

  /** Submit and wait for either the model turn identity or an early MCP batch. */
  async function submit(initialIdentities: readonly string[]): Promise<SubmitResult> {
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
    progressTracker = new ChatGptProgressTracker({
      startedAt: Date.now(),
      absoluteTimeoutMs: options.turnTimeoutMs,
      inactivityTimeoutMs: options.stallTimeoutMs,
    })
    observeProgress({
      text: '',
      html: '',
      running: true,
      nativeRevision: nativeRevision(),
    })
    options.onPromptSubmitted?.()
    checkDeadline()
    assertProgress('submit')
    const submitDeadline = Date.now() + 60_000
    for (;;) {
      checkDeadline()
      assertProgress('first-progress')
      await throwIfSessionFailureAlert(page)
      await throwIfRateLimitDialog(page)
      if (options.native !== undefined) {
        const decision = arbitrateNativeObservation(options.native, undefined)
        if (decision.kind === 'tool-batch') {
          noteNativeBatch()
          await notifyConversationCreated()
          return decision
        }
      }
      const identity = resolveNewAssistantTurnIdentity(initialIdentities, await assistantTurnIdentities())
      if (identity !== undefined) {
        observeProgress({
          assistantIdentity: identity,
          text: '',
          html: '',
          running: true,
          nativeRevision: nativeRevision(),
        })
        await notifyConversationCreated()
        return { kind: 'assistant', identity }
      }
      if (Date.now() >= submitDeadline) {
        await throwIfTerminalError(page)
        throw new LlmError('ChatGPT did not accept the submitted prompt (no turn appeared).', 'PROVIDER_ERROR')
      }
      await waitForDomMutation(page, 500)
    }
  }

  /** Poll one identity-bound assistant turn to completion or native batch. */
  async function* captureRound(responseIdentity: string): AsyncGenerator<TextTurnEvent, TextTurnResult> {
    let boundResponseIdentity = responseIdentity
    let emittedText = ''
    const markdownBuffer = new ChatGptMarkdownBuffer()
    const completionTracker = new ChatGptCompletionTracker()
    const observationFaults = new ChatGptObservationFaultTracker()
    const domHealthTracker = new ChatGptTurnDomHealthTracker(options.stallTimeoutMs)
    for (;;) {
      checkDeadline()
      assertProgress(options.native === undefined ? 'first-progress' : 'mcp-wait')
      if (options.native !== undefined) {
        const decision = arbitrateNativeObservation(options.native, undefined)
        if (decision.kind === 'tool-batch') {
          noteNativeBatch()
          await notifyConversationCreated()
          return { kind: 'tool-batch', text: emittedText, promptChars: options.prompt.length, calls: decision.calls }
        }
      }
      // ONE evaluate per poll (upstream discipline): the snapshot IIFE
      // carries answer segments, stop-button (running), and the rate-limit /
      // session guards. Per-poll locator round-trips (guard isVisible x4,
      // count, stopVisible) previously throttled ChatGPT's streaming DOM so
      // hard that short answers never finished rendering.
      let snapshot: ResponseSnapshot
      try {
        snapshot = await responseSnapshot(page, boundResponseIdentity)
        observationFaults.recordSuccess()
      } catch (error) {
        if (page.isClosed()) {
          throw new LlmError('ChatGPT Web page was closed mid-turn.', 'TRANSPORT', { cause: error })
        }
        const fault = observationFaults.recordFailure(error)
        console.warn(
          `[dsh-llm-chatgpt-web] tolerated response observation fault ${fault}/8:`
          + ` ${error instanceof Error ? error.message : String(error)}`,
        )
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
        continue
      }
      observeProgress({
        assistantIdentity: boundResponseIdentity,
        text: snapshot.visibleText,
        html: snapshot.segments.map(segment => segment.html).join(''),
        running: snapshot.running,
        nativeRevision: nativeRevision(),
      })
      if (!snapshot.responsePresent) {
        const rebound = resolveReboundAssistantTurnIdentity(
          initialAssistantTurns,
          boundResponseIdentity,
          await assistantTurnIdentities(),
        )
        if (rebound !== undefined && rebound !== boundResponseIdentity) {
          boundResponseIdentity = rebound
          continue
        }
      }
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
      // Segment texts are raw DOM text; commit Markdown via the buffer.
      const segments = snapshot.segments.map(segment => ({
        ...segment,
        text: chatGptHtmlToMarkdown(segment.html) || segment.text,
      }))
      const delta = markdownBuffer.observe(segments)
      if (!markdownBuffer.currentSnapshotIsConsistent()) {
        throw new LlmError(
          'ChatGPT rewrote text that was already streamed; the turn cannot be completed safely.',
          'PROVIDER_ERROR',
        )
      }
      if (delta.length > 0) {
        emittedText += delta
        yield { type: 'delta', delta }
      }
      if (options.native !== undefined) {
        const decision = arbitrateNativeObservation(options.native, undefined)
        if (decision.kind === 'tool-batch') {
          noteNativeBatch()
          await notifyConversationCreated()
          return { kind: 'tool-batch', text: emittedText, promptChars: options.prompt.length, calls: decision.calls }
        }
      }

      // Upstream chrome filters: a bare "Thinking" header or an "Answer now"
      // suffix must never be output.
      const visible = snapshot.visibleText.replace(/^Thinking\s*\n+/, '').replace(/(?:^|\s)Answer now\s*$/, '')
      const responsePresent = snapshot.responsePresent

      const healthError = domHealthTracker.update({
        responsePresent,
        running,
        currentText: visible,
        completionActionVisible: snapshot.completionActionVisible,
      })
      if (healthError !== undefined) {
        const nativeActivityOpen = options.native !== undefined
          && options.native.beginCompletionFence() === undefined
        const suspendableWhileNativeWaits = /completed without a final answer|completed-turn action/.test(healthError)
        if (!nativeActivityOpen || !suspendableWhileNativeWaits) {
          throw new LlmError(healthError, 'PROVIDER_ERROR')
        }
      }
      if (completionTracker.update({
        responsePresent,
        running,
        currentText: visible,
        currentHtml: snapshot.segments.map(segment => segment.html).join(''),
        completionActionVisible: snapshot.completionActionVisible,
      })) {
        const candidate = { text: visible, promptChars: options.prompt.length }
        if (options.native !== undefined) {
          const decision = arbitrateNativeObservation(options.native, candidate)
          if (decision.kind === 'tool-batch') {
            noteNativeBatch()
            return { kind: 'tool-batch', text: emittedText, promptChars: options.prompt.length, calls: decision.calls }
          }
          if (decision.kind !== 'completed') {
            await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
            continue
          }
        }
        try {
          const final = markdownBuffer.finish()
          if (final.delta.length > 0) {
            emittedText += final.delta
            yield { type: 'delta', delta: final.delta }
          }
          return { kind: 'completed', text: final.markdown.length > 0 ? final.markdown : visible, promptChars: options.prompt.length }
        } catch (error) {
          throw new LlmError(
            'ChatGPT rewrote text that was already streamed; the turn cannot be completed safely.',
            'PROVIDER_ERROR',
            { cause: error },
          )
        }
      }
      // Upstream cadence: a plain 250ms sleep between polls; no dense
      // MutationObserver evaluate inside the streaming loop.
      await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
    }
  }

  // Tool availability never implies that every response must call a tool.
  // The model decides from the active request; forcing follow-up nudges here
  // duplicated streamed text and made ordinary final answers impossible.
  await attach(options.prompt)
  const submitted = await submit(initialAssistantTurns)
  if (submitted.kind === 'tool-batch') {
    return { kind: 'tool-batch', text: '', promptChars: options.prompt.length, calls: submitted.calls }
  }
  return yield* captureRound(submitted.identity)
}
