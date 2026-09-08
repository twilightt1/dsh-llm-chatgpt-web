import { describe, expect, it } from 'vitest'
import {
  ChatGptMarkdownBuffer,
  chatGptHtmlToMarkdown,
  type ChatGptMarkdownSegment,
} from '../src/chatgpt/markdown.ts'

function segment(
  index: number,
  html: string,
  text: string,
  extra: Partial<ChatGptMarkdownSegment> = {},
): ChatGptMarkdownSegment {
  return {
    key: `k${index}`,
    html,
    text,
    streamable: true,
    ...extra,
  }
}

/** Mirror the browser worker's streamable rule: only a block FOLLOWED by another is streamable. */
function streamableSnapshot(segments: ChatGptMarkdownSegment[]): ChatGptMarkdownSegment[] {
  return segments.map((seg, index) => ({ ...seg, streamable: index < segments.length - 1 }))
}

describe('chatGptHtmlToMarkdown', () => {
  it('keeps code fences with their language tag', () => {
    const md = chatGptHtmlToMarkdown('<pre><code class="language-tool-call">{"name":"bash"}</code></pre>')
    expect(md).toContain('```tool-call')
    expect(md).toContain('{"name":"bash"}')
  })

  it('converts headings, lists, and emphasis', () => {
    const md = chatGptHtmlToMarkdown('<h2>Done</h2><ul><li>one</li><li>two</li></ul><p><strong>ok</strong></p>')
    expect(md).toContain('## Done')
    expect(md).toContain('- one')
    expect(md).toContain('**ok**')
  })

  it('strips buttons and images', () => {
    const md = chatGptHtmlToMarkdown('<p>text<button>Copy</button><img src="x" alt="y"></p>')
    expect(md).toContain('text')
    expect(md).not.toContain('Copy')
    expect(md).not.toContain('<img')
  })
})

describe('ChatGptMarkdownBuffer', () => {
  it('streams committed blocks append-only', () => {
    const buffer = new ChatGptMarkdownBuffer(0)
    // Snapshot 1: a is streamable (b follows), b is the tail — not yet.
    const first = buffer.observe(streamableSnapshot([
      segment(1, '<p>a</p>', 'a', { sourceStart: 0, sourceEnd: 1 }),
      segment(2, '<p>b</p>', 'b', { sourceStart: 2, sourceEnd: 3 }),
    ]))
    expect(first).toContain('a')
    // Snapshot 2: b becomes streamable once c appears.
    const second = buffer.observe(streamableSnapshot([
      segment(1, '<p>a</p>', 'a', { sourceStart: 0, sourceEnd: 1 }),
      segment(2, '<p>b</p>', 'b', { sourceStart: 2, sourceEnd: 3 }),
      segment(3, '<p>c</p>', 'c', { sourceStart: 4, sourceEnd: 5 }),
    ]))
    expect(second).toContain('b')
    const final = buffer.finish()
    expect(final.markdown).toBe('a\n\nb\n\nc')
    expect(final.delta).toContain('c')
  })

  it('ignores a virtualized (missing) committed prefix', () => {
    const buffer = new ChatGptMarkdownBuffer(0)
    buffer.observe(streamableSnapshot([
      segment(1, '<p>a</p>', 'a', { sourceStart: 0, sourceEnd: 1 }),
      segment(2, '<p>b</p>', 'b', { sourceStart: 2, sourceEnd: 3 }),
    ]))
    // Later DOM dropped block 1 (virtualization): the still-present blocks
    // keep streaming without a consistency error, and nothing is re-sent.
    const delta = buffer.observe(streamableSnapshot([
      segment(2, '<p>b</p>', 'b', { sourceStart: 2, sourceEnd: 3 }),
      segment(3, '<p>c</p>', 'c', { sourceStart: 4, sourceEnd: 5 }),
    ]))
    expect(delta).toContain('b')
    const final = buffer.finish()
    expect(final.markdown).toBe('a\n\nb\n\nc')
    expect(buffer.currentSnapshotIsConsistent()).toBe(true)
  })

  it('errors loudly when committed text changes', () => {
    const buffer = new ChatGptMarkdownBuffer(0)
    buffer.observe(streamableSnapshot([
      segment(1, '<p>a</p>', 'a', { sourceStart: 0, sourceEnd: 1 }),
      segment(2, '<p>b</p>', 'b', { sourceStart: 2, sourceEnd: 3 }),
    ]))
    // Citation hydration rewrote block 1's text at the same source range.
    const result = buffer.observe(streamableSnapshot([
      segment(1, '<p>a [1]</p>', 'a [1]', { sourceStart: 0, sourceEnd: 1 }),
      segment(2, '<p>b</p>', 'b', { sourceStart: 2, sourceEnd: 3 }),
    ]))
    expect(result).toBe('')
    expect(buffer.currentSnapshotIsConsistent()).toBe(false)
  })
})
