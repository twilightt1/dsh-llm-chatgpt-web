/**
 * Model/effort selection on a fresh ChatGPT page.
 *
 * Mechanics derive from codex-chatgpt-web (MIT): the effort menu owns an ARIA
 * slider, moved one step per arrow key to `min + uiEffortIndex`; Luna-only
 * accounts use the Think toggle instead. The mapping from DSH model slug to
 * backend+eﬀort lives here (upstream coupled it to Codex config).
 * @module dsh-llm-chatgpt-web/chatgpt-effort
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright-core'
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  activateChatGptEffortMenu,
  parseChatGptEffortSliderState,
} from './session.ts'
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_SOL_BACKEND_MODEL,
  resolveChatGptWebModelMode,
} from './model.ts'
import type { ChatGptWebAccountCapabilities } from './session.ts'
import { throwIfRateLimitDialog, throwIfSessionFailureAlert } from './guards.ts'

/** DSH model slug → upstream backend + effort. */
export function resolveSlugBackend(model: string): { backend: string; effort: string } {
  switch (model) {
    case 'chatgpt-web/luna': return { backend: CHATGPT_WEB_LUNA_BACKEND_MODEL, effort: 'low' }
    case 'chatgpt-web/think': return { backend: CHATGPT_WEB_LUNA_BACKEND_MODEL, effort: 'medium' }
    case 'chatgpt-web/light': return { backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'low' }
    case 'chatgpt-web/medium': return { backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'medium' }
    case 'chatgpt-web/high': return { backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'high' }
    case 'chatgpt-web/extra-high': return { backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'xhigh' }
    case 'chatgpt-web/pro': return { backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'max' }
    default:
      throw new LlmError(
        `ChatGPT Web model is not supported: ${model}. Available: chatgpt-web/luna|think|light|medium|high|extra-high|pro.`,
        'INVALID_REQUEST',
      )
  }
}

async function setThinkMode(composerForm: Locator, enabled: boolean): Promise<void> {
  const controls = composerForm
    .getByRole('button', { name: 'Think', exact: true })
    .filter({ visible: true })
  const count = await controls.count()
  if (count === 0) {
    if (enabled) throw new LlmError('ChatGPT Think control is not available on this Luna-only account.', 'INVALID_REQUEST')
    return
  }
  if (count !== 1) throw new LlmError(`ChatGPT exposed ${count} visible Think controls.`, 'PROVIDER_ERROR')
  const control = controls.first()
  const target = enabled ? 'true' : 'false'
  let pressed = await control.getAttribute('aria-pressed')
  if (pressed !== 'true' && pressed !== 'false') {
    throw new LlmError('ChatGPT Think control has no semantic pressed state.', 'PROVIDER_ERROR')
  }
  if (pressed !== target) {
    await control.click()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      pressed = await control.getAttribute('aria-pressed')
      if (pressed === target) break
      if (pressed !== 'true' && pressed !== 'false') {
        throw new LlmError('ChatGPT Think control lost its semantic pressed state.', 'PROVIDER_ERROR')
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
    }
    if (pressed !== target) {
      throw new LlmError(`ChatGPT did not ${enabled ? 'enable' : 'disable'} Think mode.`, 'PROVIDER_ERROR')
    }
  }
}

/**
 * Select the model+eﬀort for one turn. Every turn starts on a fresh page at
 * the default eﬀort, so this runs unconditionally before submit.
 */
export async function selectModelEffort(
  page: Page,
  model: string,
  capabilities: ChatGptWebAccountCapabilities,
): Promise<string> {
  const { backend, effort } = resolveSlugBackend(model)
  let mode
  try {
    mode = resolveChatGptWebModelMode(backend, effort, { ...capabilities, localToolsEnabled: false })
  } catch (error) {
    throw new LlmError(
      error instanceof Error ? error.message : String(error),
      'INVALID_REQUEST',
    )
  }
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).last()
  const composerForm = composer.locator('xpath=ancestor::form[1]')
  if (mode.uiEffortIndex === null) {
    await throwIfRateLimitDialog(page)
    await setThinkMode(composerForm, mode.thinkEnabled)
    return mode.displayLabel
  }
  const control = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last()
  try {
    await control.waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    await throwIfSessionFailureAlert(page)
    throw new LlmError(
      'ChatGPT rendered the composer but its model/effort control did not become ready.',
      'PROVIDER_ERROR',
    )
  }
  await throwIfRateLimitDialog(page)
  let activation
  try {
    activation = await activateChatGptEffortMenu(page, control)
  } catch (error) {
    throw new LlmError(
      error instanceof Error ? error.message : String(error),
      'PROVIDER_ERROR',
    )
  }
  const slider = activation.slider
  const container = activation.sliderContainer
  await container.waitFor({ state: 'visible', timeout: 30_000 })
  await slider.waitFor({ state: 'attached', timeout: 30_000 })
  let state = parseChatGptEffortSliderState(
    await slider.getAttribute('aria-valuemin'),
    await slider.getAttribute('aria-valuemax'),
    await slider.getAttribute('aria-valuenow'),
  )
  if (!state) {
    throw new LlmError('ChatGPT effort slider exposed an invalid ARIA range.', 'PROVIDER_ERROR')
  }
  const targetValue = state.min + mode.uiEffortIndex
  if (targetValue > state.max) {
    throw new LlmError(
      `ChatGPT effort slider does not expose ${mode.displayLabel} (min=${state.min}; max=${state.max}). The account may have hit a usage limit.`,
      'INVALID_REQUEST',
    )
  }
  const sliderControl = slider.locator("xpath=ancestor::*[@role='menuitem'][1]")
  while (state.value !== targetValue) {
    await throwIfRateLimitDialog(page)
    const direction = targetValue > state.value ? 1 : -1
    const key = direction > 0 ? 'ArrowRight' : 'ArrowLeft'
    const previousValue = state.value
    await sliderControl.press(key)
    const changeDeadline = Date.now() + 5_000
    do {
      state = parseChatGptEffortSliderState(
        await slider.getAttribute('aria-valuemin'),
        await slider.getAttribute('aria-valuemax'),
        await slider.getAttribute('aria-valuenow'),
      )
      if (!state) throw new LlmError('ChatGPT effort slider lost its semantic ARIA state.', 'PROVIDER_ERROR')
      if (state.value !== previousValue) break
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
    } while (Date.now() < changeDeadline)
    if (state.value !== previousValue + direction) {
      throw new LlmError(
        `ChatGPT effort slider did not move exactly one step with ${key} (before=${previousValue}; after=${state.value}).`,
        'PROVIDER_ERROR',
      )
    }
  }
  await page.keyboard.press('Escape').catch(() => {})
  return mode.displayLabel
}
