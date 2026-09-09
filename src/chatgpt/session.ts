/**
 * ChatGPT DOM surface: selectors, effort-slider mechanics, auth asserts.
 *
 * Vendored from codex-chatgpt-web `src/chatgpt-session.ts`
 * (MIT, (c) 2026 codex-chatgpt-web contributors) with one change: the
 * `ChatGptWebAccountCapabilities` type is defined locally instead of imported
 * from the upstream model catalog. No behavioral changes.
 *
 * If ChatGPT changes its UI, turns fail explicitly here (missing selectors)
 * instead of silently switching route or capability.
 * @module dsh-llm-chatgpt-web/chatgpt-session
 */

import type { Locator, Page } from 'playwright-core'

/** What the account exposes, probed from the live composer surface. */
export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean
  proAvailable: boolean
}

export type ChatGptSurface = 'temporary' | 'connector'
export const CHATGPT_TEMPORARY_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true'
export const CHATGPT_CONNECTOR_CHAT_URL = 'https://chatgpt.com/'

export function chatGptSurfaceUrl(surface: ChatGptSurface): string {
  return surface === 'temporary' ? CHATGPT_TEMPORARY_CHAT_URL : CHATGPT_CONNECTOR_CHAT_URL
}

export function assertChatGptSurfaceUrl(value: string, surface: ChatGptSurface): void {
  const url = new URL(value)
  const expected = new URL(chatGptSurfaceUrl(surface))
  const isTemporary = url.searchParams.get('temporary-chat') === 'true'
  const valid = url.origin === expected.origin
    && url.pathname === expected.pathname
    && (surface === 'temporary' ? isTemporary : !isTemporary)
  if (valid) return
  if (surface === 'temporary') {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${value})`)
  }
  throw new Error(`ChatGPT left the normal connector-enabled chat surface (${value})`)
}
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  '[contenteditable="true"][data-lexical-editor="true"]',
  // Local adaptation (Sep 2026): ChatGPT migrated the composer from Lexical
  // to ProseMirror — same id, no data-lexical-editor attribute.
  '[contenteditable="true"].ProseMirror',
  '[role="textbox"][aria-label="Chat with ChatGPT"]',
].join(', ')
/** Visible mention rows used by the Personalized connector picker. */
export const CHATGPT_CONNECTOR_MENU_ITEM_SELECTOR = '.__menu-item[tabindex="0"]'
/** Connector pills are verified by exact keyword after mention selection. */
export const CHATGPT_CONNECTOR_PILL_SELECTOR = '[data-id^="plugin:"][data-keyword]'
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
].join(', ')
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(', ')
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]'
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider]'
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"]'
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]'
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]'
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(', ')
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(', ')

export interface ChatGptEffortSliderState {
  min: number
  max: number
  value: number
}

export interface ChatGptEffortActivation {
  method: 'already-open' | 'click' | 'pointerdown'
  menu: Locator
  sliderContainer: Locator
  slider: Locator
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last()
  // The current picker keeps ARIA values on a zero-width, aria-hidden semantic input.
  // Its visible container proves the active surface; the input proves the effort range.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') }
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute('aria-controls').catch(() => null)
  if (menuId) return page.locator(effortMenuSelectorForId(menuId))
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last()
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<Omit<ChatGptEffortActivation, 'method'> | undefined> {
  const menu = await chatGptEffortMenuForControl(page, control)
  const surface = chatGptEffortSlider(page)
  if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) {
    return { menu, ...surface }
  }
  return undefined
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Omit<ChatGptEffortActivation, 'method'> | undefined> {
  const deadline = Date.now() + timeoutMs
  do {
    const surface = await visibleEffortSurface(page, control)
    if (surface) return surface
    if (Date.now() >= deadline) return undefined
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
  } while (true)
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute('aria-expanded').catch(() => null)
  const state = await control.getAttribute('data-state').catch(() => null)
  if (expanded === 'true' || state === 'open') {
    await page.keyboard.press('Escape').catch(() => {})
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control)
  if (openSurface) return { method: 'already-open', ...openSurface }

  const settleMs = options.settleMs ?? 3_000
  await clearGhostEffortState(page, control)
  await control.click({ force: true, timeout: Math.max(1, settleMs) })
  const clickedSurface = await waitForEffortSurface(page, control, settleMs)
  if (clickedSurface) return { method: 'click', ...clickedSurface }

  await clearGhostEffortState(page, control)
  await control.dispatchEvent('pointerdown', {
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    isPrimary: true,
  })
  const pointerSurface = await waitForEffortSurface(page, control, settleMs)
  if (pointerSurface) return { method: 'pointerdown', ...pointerSurface }
  throw new Error(
    'ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown',
  )
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin)
  const max = safeIntegerAttribute(rawMax)
  const value = safeIntegerAttribute(rawValue)
  if (min === undefined || max === undefined || value === undefined) return undefined
  const optionCount = max - min + 1
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined
  if (value < min || value > max) return undefined
  return { min, max, value }
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true
  }
  return false
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  )
  if (!await anyVisible(composer)) {
    throw new Error('ChatGPT authentication could not be verified: no visible composer is present')
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  assertChatGptSurfaceUrl(page.url(), 'temporary')
}

export async function assertConnectorChatPage(page: Page): Promise<void> {
  assertChatGptSurfaceUrl(page.url(), 'connector')
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true })
  const composer = composers.last()
  const composerForm = composer.locator('xpath=ancestor::form[1]')
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last()
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000)
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000
  let absenceSince: number | undefined
  let presenceObservations = 0
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false)
    if (effortVisible) {
      presenceObservations += 1
      absenceSince = undefined
      if (presenceObservations >= 2) break
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
      continue
    }
    presenceObservations = 0
    const composerReady = await composers.count().then(count => count === 1).catch(() => false)
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false)
    const documentReady = await page.evaluate(() => document.readyState === 'complete').catch(() => false)
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now()
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false }
      }
    } else {
      absenceSince = undefined
    }
    if (Date.now() >= deadline) {
      throw new Error('ChatGPT account capability probe did not reach a stable composer state')
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last()
  const menuVisible = await menu.isVisible().catch(() => false)
  const menuExpanded = await effortButton.getAttribute('aria-expanded').catch(() => null)
  if (!menuVisible && menuExpanded !== 'true') await effortButton.press('Enter')
  try {
    const { sliderContainer, slider } = chatGptEffortSlider(page)
    const timeout = options.selectorTimeoutMs ?? 70_000
    // Model radio rows can hydrate before the effort control. They carry no evidence
    // of the account's reasoning range, so an absent slider must fail, not cache false.
    await sliderContainer.waitFor({ state: 'visible', timeout })
    await slider.waitFor({ state: 'attached', timeout })
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute('aria-valuemin'),
      await slider.getAttribute('aria-valuemax'),
      await slider.getAttribute('aria-valuenow'),
    )
    if (!state) {
      throw new Error(
        'ChatGPT model controls are unavailable. Reload ChatGPT and retry.',
        { cause: new Error('ChatGPT effort slider exposed an invalid ARIA range') },
      )
    }
    return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 }
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
}
