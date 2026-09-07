/**
 * Fail-closed page guards: rate limits, expired sessions, onboarding, and
 * terminal turn errors. Selector knowledge derives from codex-chatgpt-web
 * (MIT); the implementation here is original and text-turn scoped.
 * @module dsh-llm-chatgpt-web/chatgpt-guards
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Page } from 'playwright-core'

const rateLimitDialog = (page: Page) => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests/i })
  .filter({ hasText: /making requests too quickly/i })
  .last()

/** Throw RATE_LIMIT when ChatGPT shows its too-many-requests dialog. */
export async function throwIfRateLimitDialog(page: Page): Promise<void> {
  const dialog = rateLimitDialog(page)
  if (!await dialog.isVisible().catch(() => false)) return
  const acknowledge = dialog.getByRole('button', { name: /^(Got it)$/ }).last()
  if (await acknowledge.isVisible().catch(() => false)) {
    await acknowledge.press('Enter').catch(() => {})
  }
  throw new LlmError(
    'ChatGPT rate limit: too many requests. Try again in a few minutes.',
    'RATE_LIMIT',
  )
}

const expiredSessionAlert = (page: Page) => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText: /Your session has expired/i })
  .last()

const subscriptionAlert = (page: Page) => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last()

/** Throw AUTH when the login expired, SERVER when the subscription won't load. */
export async function throwIfSessionFailureAlert(page: Page): Promise<void> {
  if (await expiredSessionAlert(page).isVisible().catch(() => false)) {
    throw new LlmError(
      'The ChatGPT session has expired. Delete the plugin profile directory and run again to sign in.',
      'AUTH',
    )
  }
  if (!await subscriptionAlert(page).isVisible().catch(() => false)) return
  throw new LlmError(
    'ChatGPT could not load the account subscription. Reload and retry; sign in again only if it persists.',
    'SERVER',
  )
}

const temporaryChatOnboardingDialog = (page: Page) => page
  .locator('[role="dialog"]')
  .filter({ hasText: 'Not in history' })
  .filter({ hasText: 'No model training' })
  .filter({ hasText: 'Memory off' })
  .last()

/** Dismiss the first-run Temporary Chat explainer; returns whether it was shown. */
export async function dismissTemporaryChatOnboarding(page: Page): Promise<boolean> {
  const dialog = temporaryChatOnboardingDialog(page)
  if (!await dialog.isVisible().catch(() => false)) return false
  const continueButton = dialog.getByRole('button', { name: 'Continue', exact: true }).last()
  if (!await continueButton.isVisible().catch(() => false)) {
    throw new LlmError(
      'ChatGPT Temporary Chat onboarding is visible without its Continue action.',
      'PROVIDER_ERROR',
    )
  }
  await continueButton.click({ force: true })
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
  return true
}

const terminalErrorText = (page: Page) => page
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last()

/** Throw when the turn surface ends in a banner error instead of an answer. */
export async function throwIfTerminalError(page: Page): Promise<void> {
  if (!await terminalErrorText(page).isVisible().catch(() => false)) return
  throw new LlmError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    'SERVER',
  )
}
