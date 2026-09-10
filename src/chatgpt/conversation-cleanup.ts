import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Locator, Page } from 'playwright-core'
import { durableAtomicWritePrivateFile, assertPrivateRegularFile } from '../native/private-files.ts'

const CHATGPT_ORIGIN = 'https://chatgpt.com'
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEDGER_FILE_NAME = 'owned-conversations.json'
const LEDGER_VERSION = 1
const DEFAULT_DELETE_TIMEOUT_MS = 10_000

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function assertConversationId(value: string): void {
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new Error(`invalid ChatGPT conversation ID: ${value}`)
  }
}

/** Extract a conversation ID only from the canonical ChatGPT conversation route. */
export function conversationIdFromUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.origin !== CHATGPT_ORIGIN) return undefined
  const match = /^\/c\/([^/]+)$/.exec(url.pathname)
  if (match === null || !CONVERSATION_ID_PATTERN.test(match[1]!)) return undefined
  return match[1]
}

/** Build the canonical URL for one already-validated owned conversation. */
export function conversationUrl(conversationId: string): string {
  assertConversationId(conversationId)
  return `${CHATGPT_ORIGIN}/c/${conversationId}`
}

interface LedgerFile {
  readonly version: 1
  readonly conversationIds: readonly string[]
}

function ledgerPath(profileDir: string): string {
  return join(profileDir, LEDGER_FILE_NAME)
}

function readLedgerFile(path: string): string[] {
  try {
    lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  assertPrivateRegularFile(path, 'owned conversation ledger')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error('owned conversation ledger is not valid JSON', { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('owned conversation ledger has an invalid shape')
  }
  const file = parsed as Partial<LedgerFile>
  if (file.version !== LEDGER_VERSION || !Array.isArray(file.conversationIds)) {
    throw new Error('owned conversation ledger has an unsupported version or shape')
  }
  const ids = file.conversationIds.map(id => {
    if (typeof id !== 'string') throw new Error('owned conversation ledger contains a non-string ID')
    assertConversationId(id)
    return id
  })
  if (new Set(ids).size !== ids.length) throw new Error('owned conversation ledger contains duplicate IDs')
  return ids
}

function writeLedgerFile(path: string, ids: readonly string[]): void {
  const file: LedgerFile = { version: LEDGER_VERSION, conversationIds: ids }
  durableAtomicWritePrivateFile(path, `${JSON.stringify(file)}\n`, 0o600)
}

export interface OwnedConversationLedger {
  pending(): readonly string[]
  remember(conversationId: string): void
  forget(conversationId: string): void
}

/** Private, restart-safe ledger for chats created by this adapter only. */
export function createOwnedConversationLedger(profileDir: string): OwnedConversationLedger {
  const path = ledgerPath(profileDir)
  let ids = readLedgerFile(path)
  return {
    pending(): readonly string[] {
      return [...ids]
    },
    remember(conversationId: string): void {
      assertConversationId(conversationId)
      if (ids.includes(conversationId)) return
      const next = [...ids, conversationId]
      writeLedgerFile(path, next)
      ids = next
    },
    forget(conversationId: string): void {
      assertConversationId(conversationId)
      if (!ids.includes(conversationId)) return
      const next = ids.filter(id => id !== conversationId)
      writeLedgerFile(path, next)
      ids = next
    },
  }
}

function visible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false)
}

async function waitVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await visible(locator)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
  }
}

async function waitForDeletionVerification(page: Page, conversationId: string, timeoutMs: number): Promise<void> {
  const historyLink = page.locator(`a[href="/c/${conversationId}"]`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const activeId = conversationIdFromUrl(page.url())
    const listed = await historyLink.count().catch(() => 0)
    if (activeId !== conversationId && listed === 0) return
    if (Date.now() >= deadline) {
      throw new LlmError(
        'ChatGPT conversation deletion could not be verified for the adapter-owned conversation.',
        'PROVIDER_ERROR',
      )
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
}

/** Delete exactly the conversation currently open on `page`, then verify it is gone. */
export async function deleteOwnedConversation(
  page: Page,
  conversationId: string,
  timeoutMs = DEFAULT_DELETE_TIMEOUT_MS,
): Promise<void> {
  assertConversationId(conversationId)
  if (conversationIdFromUrl(page.url()) !== conversationId) {
    throw new LlmError(
      'Refusing to delete a ChatGPT conversation whose URL does not match the owned ID.',
      'PROVIDER_ERROR',
    )
  }
  // Scope the trigger to the active conversation header. A page-wide options
  // selector can also match unrelated sidebar rows and must never be used for
  // destructive cleanup, even though the active URL has already been checked.
  const optionsButton = page
    .locator('#conversation-header-actions')
    .getByTestId('conversation-options-button')
    .last()
  if (!await waitVisible(optionsButton, timeoutMs)) {
    throw new LlmError('ChatGPT owned conversation has no active-header conversation-options control.', 'PROVIDER_ERROR')
  }
  await optionsButton.click({ force: true })
  const deleteButton = page.getByTestId('delete-chat-menu-item').filter({ visible: true }).last()
  if (!await waitVisible(deleteButton, timeoutMs)) {
    throw new LlmError('ChatGPT owned conversation has no delete action.', 'PROVIDER_ERROR')
  }
  await deleteButton.click({ force: true })
  const confirmButton = page.getByTestId('delete-conversation-confirm-button').filter({ visible: true }).last()
  if (!await waitVisible(confirmButton, timeoutMs)) {
    throw new LlmError('ChatGPT owned conversation deletion has no confirmation action.', 'PROVIDER_ERROR')
  }
  await confirmButton.click({ force: true })
  await waitForDeletionVerification(page, conversationId, timeoutMs)
}

async function waitForOwnedConversationReady(page: Page, conversationId: string, timeoutMs: number): Promise<void> {
  const optionsButton = page
    .locator('#conversation-header-actions')
    .getByTestId('conversation-options-button')
    .filter({ visible: true })
    .last()
  const turns = page.locator('[data-testid^="conversation-turn-"]')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (conversationIdFromUrl(page.url()) === conversationId
      && await visible(optionsButton)
      && await turns.count().catch(() => 0) > 0) return
    if (Date.now() >= deadline) {
      throw new LlmError(
        'ChatGPT could not load the adapter-owned conversation before cleanup.',
        'PROVIDER_ERROR',
      )
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
}

async function waitForSettledHome(page: Page, conversationId: string, timeoutMs: number): Promise<boolean> {
  const historyLink = page.locator(`a[href="/c/${conversationId}"]`)
  const composer = page.locator('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"].ProseMirror, [role="textbox"][aria-label="Chat with ChatGPT"]')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (conversationIdFromUrl(page.url()) !== undefined) return false
    if (await visible(composer) && await historyLink.count().catch(() => 0) === 0) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
}

/** Retry private deletion records before a new native turn can create another chat. */
export async function retryPendingConversationDeletions(
  page: Page,
  ledger: OwnedConversationLedger,
  timeoutMs = DEFAULT_DELETE_TIMEOUT_MS,
): Promise<void> {
  for (const conversationId of ledger.pending()) {
    await page.goto(conversationUrl(conversationId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    if (conversationIdFromUrl(page.url()) === conversationId) {
      await waitForOwnedConversationReady(page, conversationId, timeoutMs)
      await deleteOwnedConversation(page, conversationId, timeoutMs)
    } else if (!await waitForSettledHome(page, conversationId, timeoutMs)) {
      throw new LlmError(
        'ChatGPT could not verify removal of a pending adapter-owned conversation.',
        'PROVIDER_ERROR',
      )
    }
    ledger.forget(conversationId)
  }
}
