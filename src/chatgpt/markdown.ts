/**
 * Structurally-completed ChatGPT DOM blocks → append-only Markdown stream.
 *
 * Ported from codex-chatgpt-web `src/adapters/chatgpt-web/markdown.ts`
 * (MIT, © 2026 codex-chatgpt-web contributors), simplified for this plugin's
 * text-only needs (no Obsidian wiki links, no GFM plugin): the turndown
 * converter, the segment/source-range model, and the append-only buffer with
 * its consistency reconciliation are preserved — they are the pieces that
 * keep streamed Markdown monotonic while ChatGPT re-renders old HTML
 * (citation hydration, virtualized prefixes).
 * @module dsh-llm-chatgpt-web/chatgpt-markdown
 */

import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
})
turndown.remove(['button', 'script', 'style'])
turndown.addRule('removeImages', {
  filter: node => ['IMG', 'PICTURE', 'SOURCE'].includes(node.nodeName),
  replacement: () => '',
})
turndown.addRule('removeSvg', {
  filter: node => node.nodeName === 'SVG',
  replacement: () => '',
})
// Upstream compactListItem: turndown indents continuation lines of a list
// item with the full prefix width; ChatGPT renders tight lists, and the
// harness Markdown consumers expect single-space bullets.
turndown.addRule('compactListItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null
    let prefix = `${options.bulletListMarker} `
    if (parent?.nodeName === 'OL') {
      const start = Number(parent.getAttribute('start') ?? '1')
      const index = Array.prototype.indexOf.call(parent.children, node) as number
      prefix = `${start + index}. `
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, '')
      .replace(/\n/g, `\n${' '.repeat(prefix.length)}`)
    return `${prefix}${normalized}${node.nextSibling ? '\n' : ''}`
  },
})

/** HTML of one ChatGPT answer block → Markdown text. */
export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return ''
  return turndown.turndown(html).trim()
}

export interface ChatGptMarkdownSegment {
  key: string
  tag?: string
  html: string
  text: string
  group?: string
  sourceStart?: number
  sourceEnd?: number
  streamable: boolean
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number
  streamableAt?: number
}

interface CommittedChatGptMarkdownSegment {
  key: string
  tag?: string
  text: string
  sourceStart?: number
  sourceEnd?: number
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: {
      reason: 'text_changed' | 'block_order_changed' | 'source_range_overlap'
      observedTextChars: number
      committedTextChars: number
    },
  ) {
    super(message)
    this.name = 'ChatGptMarkdownConsistencyError'
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only
 * Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a
 * character prefix is not a safe commit boundary. It can also virtualize an
 * already-rendered prefix, so later DOM snapshots are partial observations
 * rather than the response ledger. The browser worker supplies source ranges
 * for semantic blocks and marks a block streamable only after a following
 * block exists. Once committed, a missing prefix is harmless; changing text
 * at a committed source range remains an explicit protocol error because
 * streamed deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>()
  private readonly committed: CommittedChatGptMarkdownSegment[] = []
  private latest: ChatGptMarkdownSegment[] = []
  private markdown = ''
  private consistencyError: ChatGptMarkdownConsistencyError | undefined

  constructor(
    private readonly stabilityMs = 750,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error('ChatGPT Markdown stability window must be a non-negative finite number')
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    const reconciled = this.reconcile(segments)
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      this.consistencyError = reconciled
      return ''
    }
    this.consistencyError = undefined
    this.latest = reconciled.map(segment => ({ ...segment }))

    const visibleCandidates = new Set<string>()
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment)
      visibleCandidates.add(candidateId)
      const previous = this.candidates.get(candidateId)
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      })
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId)
    }

    let delta = ''
    let committedCount = 0
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!
      const candidateId = this.candidateId(segment)
      const candidate = this.candidates.get(candidateId)
      if (!candidate?.streamable || candidate.streamableAt === undefined) break
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break
      delta += this.commit(candidate)
      this.committed.push(this.committedSegment(candidate))
      this.candidates.delete(candidateId)
      committedCount += 1
    }
    this.latest = this.latest.slice(committedCount)
    return delta
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError
    let delta = ''
    for (const segment of this.latest) {
      delta += this.commit(segment)
      this.committed.push(this.committedSegment(segment))
    }
    this.candidates.clear()
    this.latest = []
    return { markdown: this.markdown, delta }
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    if (this.committed.length === 0 || segments.length === 0) return segments

    const pending: ChatGptMarkdownSegment[] = []
    const lastRangedCommitted = this.committed
      .filter(segment => segment.sourceEnd !== undefined)
      .at(-1)
    const lastCommittedEnd = lastRangedCommitted?.sourceEnd
    let highestCommittedIndex = -1
    let sawPending = false
    let previousSourceStart: number | undefined

    for (const segment of segments) {
      if (segment.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && segment.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError(
            'ChatGPT final DOM exposed non-monotonic source ranges',
            { reason: 'block_order_changed', observedTextChars: segment.text.length, committedTextChars: 0 },
          )
        }
        previousSourceStart = segment.sourceStart
      }
      const committedIndex = this.committedIndex(segment)
      if (committedIndex !== undefined) {
        const committed = this.committed[committedIndex]!
        if (sawPending || committedIndex < highestCommittedIndex || committed.text !== segment.text) {
          return new ChatGptMarkdownConsistencyError(
            'ChatGPT rewrote text that was already streamed to the caller',
            {
              reason: sawPending || committedIndex < highestCommittedIndex ? 'block_order_changed' : 'text_changed',
              observedTextChars: segment.text.length,
              committedTextChars: committed.text.length,
            },
          )
        }
        highestCommittedIndex = committedIndex
        continue
      }

      if (segment.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (segment.sourceStart <= lastCommittedEnd) {
          return new ChatGptMarkdownConsistencyError(
            'ChatGPT final DOM could not be aligned with text already streamed to the caller',
            {
              reason: 'source_range_overlap',
              observedTextChars: segment.text.length,
              committedTextChars: lastRangedCommitted!.text.length,
            },
          )
        }
        sawPending = true
        pending.push(segment)
        continue
      }

      const followsVisibleCommittedTail = highestCommittedIndex === this.committed.length - 1
      if (!followsVisibleCommittedTail && !this.matchesLatestPending(segment)) {
        return new ChatGptMarkdownConsistencyError(
          'ChatGPT final DOM could not be aligned with text already streamed to the caller',
          { reason: 'block_order_changed', observedTextChars: segment.text.length, committedTextChars: 0 },
        )
      }
      sawPending = true
      pending.push(segment)
    }

    return pending
  }

  private committedIndex(segment: ChatGptMarkdownSegment): number | undefined {
    const exact = this.committed.findIndex(committed => (
      segment.sourceStart !== undefined && committed.sourceStart !== undefined
        ? segment.sourceStart === committed.sourceStart && segment.tag === committed.tag
        : segment.key === committed.key
    ))
    if (exact >= 0) return exact
    if (segment.sourceStart !== undefined) return undefined
    return undefined
  }

  private matchesLatestPending(segment: ChatGptMarkdownSegment): boolean {
    return this.latest.some(candidate => candidate.key === segment.key)
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `${segment.sourceStart}:${segment.tag ?? ''}`
      : segment.key
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const prefix = this.markdown.length > 0 ? '\n\n' : ''
    this.markdown += `${prefix}${segment.text}`
    return `${prefix}${segment.text}`
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag !== undefined ? { tag: segment.tag } : {}),
      text: segment.text,
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    }
  }
}
