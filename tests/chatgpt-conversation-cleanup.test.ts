import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import {
  conversationIdFromUrl,
  conversationUrl,
  createOwnedConversationLedger,
  retryPendingConversationDeletions,
} from '../src/chatgpt/conversation-cleanup.ts'

const conversationId = '6aa191d8-a134-83ec-8f59-da2b18ec3024'

describe('ChatGPT owned conversation identity', () => {
  it('accepts only a ChatGPT conversation URL with a UUID path', () => {
    expect(conversationIdFromUrl(`https://chatgpt.com/c/${conversationId}`)).toBe(conversationId)
    expect(conversationIdFromUrl(`https://chatgpt.com/c/${conversationId}?foo=bar`)).toBe(conversationId)
    expect(conversationIdFromUrl('https://chatgpt.com/')).toBeUndefined()
    expect(conversationIdFromUrl(`https://example.com/c/${conversationId}`)).toBeUndefined()
    expect(conversationIdFromUrl('https://chatgpt.com/c/not-a-conversation')).toBeUndefined()
  })

  it('builds only the exact conversation route', () => {
    expect(conversationUrl(conversationId)).toBe(`https://chatgpt.com/c/${conversationId}`)
    expect(() => conversationUrl('not-a-conversation')).toThrow(/conversation/i)
  })
})

describe('owned conversation UI deletion', () => {
  it('deletes only through the matching active conversation header and verifies navigation away', async () => {
    let currentUrl = `https://chatgpt.com/c/${conversationId}`
    const clicks: string[] = []
    const control = (name: string, onClick?: () => void) => ({
      isVisible: vi.fn(async () => true),
      count: vi.fn(async () => 0),
      click: vi.fn(async () => { clicks.push(name); onClick?.() }),
      last(): unknown { return this },
    })
    const header = {
      getByTestId: (testId: string) => control(testId),
    }
    const page = {
      url: () => currentUrl,
      getByTestId: (testId: string) => control(testId, testId === 'delete-conversation-confirm-button' ? () => {
        currentUrl = 'https://chatgpt.com/'
      } : undefined),
      locator: (selector: string) => selector === '#conversation-header-actions' ? header : control('history'),
    } as unknown as Page

    const { deleteOwnedConversation } = await import('../src/chatgpt/conversation-cleanup.ts')
    await deleteOwnedConversation(page, conversationId)
    expect(clicks).toEqual([
      'conversation-options-button',
      'delete-chat-menu-item',
      'delete-conversation-confirm-button',
    ])
  })

  it('refuses to delete a different conversation route', async () => {
    const page = { url: () => 'https://chatgpt.com/c/6aa191d8-a134-83ec-8f59-da2b18ec3025' } as unknown as Page
    const { deleteOwnedConversation } = await import('../src/chatgpt/conversation-cleanup.ts')
    await expect(deleteOwnedConversation(page, conversationId)).rejects.toThrow(/does not match/i)
  })
})

describe('owned conversation deletion ledger', () => {
  it('persists private IDs and removes only the requested ID', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-cleanup-'))
    const ledger = createOwnedConversationLedger(profileDir)

    ledger.remember(conversationId)
    expect(ledger.pending()).toEqual([conversationId])
    const ledgerPath = join(profileDir, 'owned-conversations.json')
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual({ version: 1, conversationIds: [conversationId] })

    const otherId = '6aa191d8-a134-83ec-8f59-da2b18ec3025'
    ledger.remember(otherId)
    ledger.forget(conversationId)
    expect(ledger.pending()).toEqual([otherId])
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual({ version: 1, conversationIds: [otherId] })
  })

  it('retries an exact pending deletion before forgetting its ledger record', async () => {
    let currentUrl = 'https://chatgpt.com/'
    const forget = vi.fn()
    const control = (onClick?: () => void) => ({
      isVisible: vi.fn(async () => true),
      count: vi.fn(async () => 0),
      click: vi.fn(async () => { onClick?.() }),
      last(): unknown { return this },
    })
    const page = {
      url: () => currentUrl,
      goto: vi.fn(async (url: string) => { currentUrl = url }),
      getByTestId: (testId: string) => control(testId === 'delete-conversation-confirm-button' ? () => {
        currentUrl = 'https://chatgpt.com/'
      } : undefined),
      locator: (selector: string) => selector === '#conversation-header-actions'
        ? { getByTestId: () => control() }
        : control(),
    } as unknown as Page
    const ledger = {
      pending: () => [conversationId],
      remember: vi.fn(),
      forget,
    }

    await retryPendingConversationDeletions(page, ledger)

    expect(page.goto).toHaveBeenCalledWith(`https://chatgpt.com/c/${conversationId}`, expect.objectContaining({
      waitUntil: 'domcontentloaded',
    }))
    expect(forget).toHaveBeenCalledWith(conversationId)
  })

  it('retains a pending record when retry deletion cannot reach the active control', async () => {
    const forget = vi.fn()
    const hiddenControl = {
      isVisible: vi.fn(async () => false),
      last(): unknown { return this },
    }
    const page = {
      url: () => `https://chatgpt.com/c/${conversationId}`,
      goto: vi.fn(async () => undefined),
      locator: (selector: string) => selector === '#conversation-header-actions'
        ? { getByTestId: () => hiddenControl }
        : { count: vi.fn(async () => 1) },
    } as unknown as Page
    const ledger = {
      pending: () => [conversationId],
      remember: vi.fn(),
      forget,
    }

    await expect(retryPendingConversationDeletions(page, ledger, 0)).rejects.toThrow(/active-header/i)
    expect(forget).not.toHaveBeenCalled()
  })
})
