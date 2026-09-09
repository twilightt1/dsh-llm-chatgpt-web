import { describe, expect, it, vi } from 'vitest'
import { classifyTurnFailure } from '../src/adapter.ts'
import { openNewPageWithReconnect } from '../src/chatgpt/browser.ts'
import {
  ChatGptCompletionTracker,
  ChatGptObservationFaultTracker,
  ChatGptTurnDomHealthTracker,
  resolveNewAssistantTurnIdentity,
  resolveReboundAssistantTurnIdentity,
} from '../src/chatgpt/turn.ts'

describe('resolveNewAssistantTurnIdentity', () => {
  it('binds only the assistant turn added after submission', () => {
    expect(resolveNewAssistantTurnIdentity(
      ['conversation-turn-2'],
      ['conversation-turn-2', 'conversation-turn-4'],
    )).toBe('conversation-turn-4')
  })

  it('does not fall back to an older assistant turn when no new turn exists', () => {
    expect(resolveNewAssistantTurnIdentity(
      ['conversation-turn-2'],
      ['conversation-turn-2'],
    )).toBeUndefined()
  })

  it('fails closed when one submission creates multiple assistant turns', () => {
    expect(() => resolveNewAssistantTurnIdentity(
      ['conversation-turn-2'],
      ['conversation-turn-2', 'conversation-turn-4', 'conversation-turn-6'],
    )).toThrow(/2 new assistant turns/)
  })
})

describe('resolveReboundAssistantTurnIdentity', () => {
  it('keeps the bound turn while it remains in the DOM', () => {
    expect(resolveReboundAssistantTurnIdentity(
      ['conversation-turn-2'],
      'conversation-turn-4',
      ['conversation-turn-4', 'conversation-turn-6'],
    )).toBe('conversation-turn-4')
  })

  it('rebinds when React replaces the submitted assistant turn', () => {
    expect(resolveReboundAssistantTurnIdentity(
      ['conversation-turn-2'],
      'conversation-turn-4',
      ['conversation-turn-2', 'conversation-turn-6'],
    )).toBe('conversation-turn-6')
  })
})

describe('ChatGptCompletionTracker', () => {
  it('requires a stable completed response with its completion action', () => {
    const tracker = new ChatGptCompletionTracker(2_000)
    const complete = {
      responsePresent: true,
      running: false,
      currentText: 'Done',
      currentHtml: '<p>Done</p>',
      completionActionVisible: true,
    }

    expect(tracker.update(complete, 1_000)).toBe(false)
    expect(tracker.update(complete, 2_999)).toBe(false)
    expect(tracker.update(complete, 3_000)).toBe(true)
  })
})

describe('ChatGptObservationFaultTracker', () => {
  it('tolerates only consecutive observation failures', () => {
    const tracker = new ChatGptObservationFaultTracker(2)
    expect(tracker.recordFailure(new TypeError('first'))).toBe(1)
    tracker.recordSuccess()
    expect(tracker.recordFailure(new TypeError('second'))).toBe(1)
    expect(tracker.recordFailure(new TypeError('third'))).toBe(2)
    expect(() => tracker.recordFailure(new TypeError('fourth'))).toThrow(/failed 3 times in a row/)
  })
})

describe('ChatGptTurnDomHealthTracker', () => {
  it('restarts the missing-completion-action grace when response text grows', () => {
    const tracker = new ChatGptTurnDomHealthTracker(60_000, 60_000, 1_000)
    const state = (currentText: string) => ({
      responsePresent: true,
      running: false,
      currentText,
      completionActionVisible: false,
    })

    expect(tracker.update(state('partial'), 1_000)).toBeUndefined()
    expect(tracker.update(state('more complete'), 1_900)).toBeUndefined()
    expect(tracker.update(state('more complete'), 2_899)).toBeUndefined()
    expect(tracker.update(state('more complete'), 2_900)).toMatch(/completed-turn action/)
  })
})

describe('openNewPageWithReconnect', () => {
  it('uses the replacement context after reconnecting', async () => {
    const staleContext = {
      newPage: vi.fn().mockRejectedValue(new Error('context closed')),
    }
    const page = { id: 'replacement-page' }
    const replacementContext = {
      newPage: vi.fn().mockResolvedValue(page),
    }
    let context: typeof staleContext | typeof replacementContext | undefined = staleContext

    const result = await openNewPageWithReconnect(
      () => context as never,
      async () => { context = replacementContext },
    )

    expect(result).toBe(page)
    expect(staleContext.newPage).toHaveBeenCalledTimes(1)
    expect(replacementContext.newPage).toHaveBeenCalledTimes(1)
  })
})

describe('classifyTurnFailure', () => {
  it('keeps browser connection failures retryable and exposes their cause', () => {
    const failure = classifyTurnFailure(new Error('browser connection closed unexpectedly'))
    expect(failure.code).toBe('TRANSPORT')
    expect(failure.message).toContain('browser connection closed unexpectedly')
  })

  it('keeps Playwright observation timeouts retryable', () => {
    const timeout = new Error('page.waitForSelector: Timeout 30000ms exceeded')
    timeout.name = 'TimeoutError'
    const failure = classifyTurnFailure(timeout)
    expect(failure.code).toBe('TIMEOUT')
    expect(failure.message).toContain('Timeout 30000ms exceeded')
  })

  it('reports UI/protocol failures as provider errors instead of transport errors', () => {
    const failure = classifyTurnFailure(new Error('completion action disappeared'))
    expect(failure.code).toBe('PROVIDER_ERROR')
    expect(failure.message).toContain('completion action disappeared')
  })
})
