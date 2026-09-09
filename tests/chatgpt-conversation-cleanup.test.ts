import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import {
  conversationIdFromUrl,
  conversationUrl,
  createOwnedConversationLedger,
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
  it('deletes only when the page URL matches the owned ID and verifies navigation away', async () => {
    let currentUrl = `https://chatgpt.com/c/${conversationId}`
    const clicks: string[] = []
    const locator = (name: string, onClick?: () => void) => ({
      isVisible: vi.fn(async () => true),
      count: vi.fn(async () => 0),
      click: vi.fn(async () => { clicks.push(name); onClick?.() }),
      last(): unknown { return this },
    })
    const page = {
      url: () => currentUrl,
      getByTestId: (testId: string) => locator(testId, testId === 'delete-conversation-confirm-button' ? () => {
        currentUrl = 'https://chatgpt.com/'
      } : undefined),
      locator: () => locator('history'),
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
})
