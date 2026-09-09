import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright-core'
import type { BrokerToolRequest } from '../native/types.ts'
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_CONNECTOR_MENU_ITEM_SELECTOR,
  CHATGPT_CONNECTOR_PILL_SELECTOR,
} from './session.ts'
import { throwIfRateLimitDialog } from './guards.ts'

/** Control exposed to the browser turn by one native broker lease. */
export interface NativeBrowserControl {
  readonly connectorName: string
  readonly requestId: string
  takeToolBatch(now?: number): readonly BrokerToolRequest[] | undefined
  beginCompletionFence(): number | undefined
  commitCompletionFence(revision: number): boolean
}

/** Result returned by the native observation arbitration helper. */
export type NativeObservation =
  | { readonly kind: 'wait' }
  | { readonly kind: 'tool-batch'; readonly calls: readonly BrokerToolRequest[] }
  | { readonly kind: 'completed'; readonly text: string; readonly promptChars: number }

/** A final DOM candidate before it is fenced against a broker batch. */
export interface NativeCompletionCandidate {
  readonly text: string
  readonly promptChars: number
}

/**
 * Give a queued native batch priority over a DOM completion candidate, then
 * fence the broker before accepting the candidate. A changed revision means
 * a tool activity raced the candidate and the caller must keep polling.
 */
export function arbitrateNativeObservation(
  control: NativeBrowserControl,
  completionCandidate: NativeCompletionCandidate | undefined,
): NativeObservation {
  const calls = control.takeToolBatch()
  if (calls !== undefined && calls.length > 0) return { kind: 'tool-batch', calls }
  if (completionCandidate === undefined) return { kind: 'wait' }
  const revision = control.beginCompletionFence()
  if (revision === undefined) return { kind: 'wait' }
  if (!control.commitCompletionFence(revision)) return { kind: 'wait' }
  return { kind: 'completed', ...completionCandidate }
}

/** Extract the first visible title line used for exact connector matching. */
function firstTitleLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/** Require one exact visible connector row; substring matches are unsafe. */
export function exactConnectorRowIndex(titles: readonly string[], connectorName: string): number {
  const matches = titles
    .map((title, index) => ({ index, title: firstTitleLine(title) }))
    .filter(entry => entry.title === connectorName)
  if (matches.length === 0) throw new Error(`no row for ChatGPT connector ${JSON.stringify(connectorName)}`)
  if (matches.length > 1) throw new Error(`duplicate rows for ChatGPT connector ${JSON.stringify(connectorName)}`)
  return matches[0]!.index
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('ChatGPT connector selection aborted by caller.', 'ABORTED')
}

async function visibleComposer(page: Page): Promise<Locator> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true })
  const count = await composers.count().catch(() => 0)
  if (count !== 1) {
    throw new LlmError(
      `ChatGPT connector selection requires exactly one visible composer (found ${count}).`,
      'PROVIDER_ERROR',
    )
  }
  return composers.first()
}

async function clearComposer(page: Page, composer?: Locator): Promise<void> {
  const target = composer ?? await visibleComposer(page)
  await target.click({ force: true })
  await target.press('ControlOrMeta+A')
  await target.press('Backspace')
}

async function visibleConnectorRows(page: Page): Promise<Locator> {
  return page.locator(CHATGPT_CONNECTOR_MENU_ITEM_SELECTOR).filter({ visible: true })
}

async function rowTitles(rows: Locator): Promise<string[]> {
  return await rows.evaluateAll(elements => elements.map(element => {
    // Current ChatGPT renders the connector title and description as sibling
    // spans without a newline. Prefer the title span so exact matching does
    // not reject a valid connector because its description was concatenated.
    return element.querySelector('span.text-token-text-primary')?.textContent
      ?? element.getAttribute('aria-label')
      ?? element.textContent
      ?? ''
  }))
}

async function waitForExactConnectorRow(
  page: Page,
  connectorName: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<Locator> {
  let lastError: unknown
  for (;;) {
    throwIfAborted(signal)
    const rows = await visibleConnectorRows(page)
    try {
      const index = exactConnectorRowIndex(await rowTitles(rows), connectorName)
      return rows.nth(index)
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new LlmError(
        `ChatGPT connector ${JSON.stringify(connectorName)} was not uniquely available. `
        + 'Verify Personalized connectors access and the exact connector name.',
        'PROVIDER_ERROR',
        { cause: lastError },
      )
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
}

async function assertConnectorPill(
  page: Page,
  connectorName: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    throwIfAborted(signal)
    const pills = page.locator(CHATGPT_CONNECTOR_PILL_SELECTOR).filter({ visible: true })
    const count = await pills.count().catch(() => 0)
    if (count === 1 && await pills.first().getAttribute('data-keyword').catch(() => null) === connectorName) return
    if (Date.now() >= deadline) {
      throw new LlmError(
        `ChatGPT did not attach exactly one ${JSON.stringify(connectorName)} connector pill. `
        + 'Verify Personalized connectors access and the connector setup.',
        'PROVIDER_ERROR',
      )
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
}

async function clearFailedConnectorSelection(page: Page): Promise<void> {
  try {
    await clearComposer(page)
  } catch (error) {
    throw new LlmError(
      'ChatGPT connector selection could not clear the composer after a failed attempt.',
      'PROVIDER_ERROR',
      { cause: error },
    )
  }
  const pills = page.locator(CHATGPT_CONNECTOR_PILL_SELECTOR).filter({ visible: true })
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await pills.count().catch(() => 0) === 0) return
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
  }
  throw new LlmError('ChatGPT connector selection could not be cleared after a failed attempt.', 'PROVIDER_ERROR')
}

/**
 * Select one exact ChatGPT connector mention and verify the resulting pill.
 * The composer subtree is re-resolved after Enter because React replaces it.
 */
export async function selectChatGptConnector(
  page: Page,
  connectorName: string,
  signal?: AbortSignal,
): Promise<void> {
  if (connectorName.trim().length === 0) throw new LlmError('ChatGPT connectorName must not be empty.', 'INVALID_REQUEST')
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal)
    // ChatGPT can surface its throttle dialog before connector rows render.
    // Fail with RATE_LIMIT instead of spending three UI attempts and masking
    // the provider condition as a connector-selection failure.
    await throwIfRateLimitDialog(page)
    try {
      await clearComposer(page)
      const composer = await visibleComposer(page)
      await composer.pressSequentially(`@${connectorName}`)
      const row = await waitForExactConnectorRow(page, connectorName, Date.now() + 10_000, signal)
      throwIfAborted(signal)
      await row.click({ force: true })
      // Selecting the row replaces the React composer subtree; never retain
      // the stale locator while verifying the attached connector.
      await visibleComposer(page)
      await assertConnectorPill(page, connectorName, Date.now() + 10_000, signal)
      return
    } catch (error) {
      if (signal?.aborted) throw error
      // A throttle can appear after the menu interaction has started. Preserve
      // that stable failure code before resetting the composer for a retry.
      await throwIfRateLimitDialog(page)
      lastError = error
      try {
        await clearFailedConnectorSelection(page)
      } catch (cleanupError) {
        throw new LlmError(
          `ChatGPT connector selection could not reset the composer after attempt ${attempt + 1}.`,
          'PROVIDER_ERROR',
          { cause: cleanupError },
        )
      }
    }
  }
  throw new LlmError(
    `ChatGPT connector selection failed after three attempts for ${JSON.stringify(connectorName)}. `
    + 'Verify Personalized connectors access and the exact connector name before retrying.',
    'PROVIDER_ERROR',
    { cause: lastError },
  )
}
