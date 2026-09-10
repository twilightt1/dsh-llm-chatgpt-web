import { describe, expect, it } from 'vitest'
import { ChatGptProgressTracker } from '../src/chatgpt/progress.ts'

describe('ChatGptProgressTracker', () => {
  it('times out a running response whose semantic state does not change', () => {
    const tracker = new ChatGptProgressTracker({
      startedAt: 1_000,
      absoluteTimeoutMs: 10_000,
      inactivityTimeoutMs: 2_000,
    })
    tracker.observe({
      assistantIdentity: 'turn-2',
      text: '',
      html: '',
      running: true,
      nativeRevision: 0,
    }, 1_000)
    expect(() => tracker.assertAlive('first-progress', 2_999)).not.toThrow()
    expect(() => tracker.assertAlive('first-progress', 3_000)).toThrow(/first-progress.*2000ms/i)
  })

  it('does not reset inactivity for repeated equivalent samples', () => {
    const tracker = new ChatGptProgressTracker({
      startedAt: 0,
      absoluteTimeoutMs: 20_000,
      inactivityTimeoutMs: 1_000,
    })
    const sample = {
      assistantIdentity: 'turn-2',
      text: 'thinking',
      html: '<p>thinking</p>',
      running: true,
      nativeRevision: 0,
    }
    expect(tracker.observe(sample, 0)).toBe(true)
    expect(tracker.observe(sample, 500)).toBe(false)
    expect(tracker.observe(sample, 999)).toBe(false)
    expect(() => tracker.assertAlive('mcp-wait', 1_000)).toThrow(/mcp-wait/i)
  })

  it('resets inactivity only for semantic response or native activity progress', () => {
    const tracker = new ChatGptProgressTracker({
      startedAt: 0,
      absoluteTimeoutMs: 10_000,
      inactivityTimeoutMs: 1_000,
    })
    const sample = {
      assistantIdentity: 'turn-2',
      text: 'one',
      html: '<p>one</p>',
      running: true,
      nativeRevision: 0,
    }
    tracker.observe(sample, 0)
    expect(tracker.observe({ ...sample, text: 'two', html: '<p>two</p>' }, 900)).toBe(true)
    expect(tracker.observe({ ...sample, text: 'two', html: '<p>two</p>' }, 1_800)).toBe(false)
    expect(() => tracker.assertAlive('post-tool-progress', 1_899)).not.toThrow()
    expect(tracker.observe({ ...sample, text: 'two', html: '<p>two</p>', nativeRevision: 1 }, 2_700)).toBe(true)
    expect(() => tracker.assertAlive('completion', 3_699)).not.toThrow()
    expect(() => tracker.assertAlive('completion', 3_700)).toThrow(/completion/i)
  })

  it('never extends the absolute deadline when progress continues', () => {
    const tracker = new ChatGptProgressTracker({
      startedAt: 100,
      absoluteTimeoutMs: 2_000,
      inactivityTimeoutMs: 500,
    })
    tracker.observe({ assistantIdentity: 'turn-2', text: '', html: '', running: true, nativeRevision: 0 }, 100)
    tracker.observe({ assistantIdentity: 'turn-2', text: 'a', html: '<p>a</p>', running: true, nativeRevision: 0 }, 1_900)
    expect(() => tracker.assertAlive('completion', 2_099)).not.toThrow()
    expect(() => tracker.assertAlive('completion', 2_100)).toThrow(/absolute.*2000ms/i)
  })

  it('deduplicates repeated tool markers but records result delivery progress', () => {
    const tracker = new ChatGptProgressTracker({
      startedAt: 0,
      absoluteTimeoutMs: 10_000,
      inactivityTimeoutMs: 1_000,
    })
    tracker.mark('tool-batch', 1, 0)
    expect(tracker.mark('tool-batch', 1, 900)).toBe(false)
    expect(tracker.mark('tool-result', 2, 900)).toBe(true)
    expect(() => tracker.assertAlive('post-tool-progress', 1_899)).not.toThrow()
    expect(() => tracker.assertAlive('post-tool-progress', 1_900)).toThrow(/post-tool-progress/i)
  })
})
