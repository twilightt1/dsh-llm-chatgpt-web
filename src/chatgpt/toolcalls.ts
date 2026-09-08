/**
 * Text-protocol tool calls: the page cannot issue native function calls, so
 * the model emits fenced ```tool-call blocks that the adapter translates
 * into harness tool-call chunks for the loop to execute. Malformed blocks
 * are reported (never executed) and surfaced back to the model next turn.
 * @module dsh-llm-chatgpt-web/chatgpt-toolcalls
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Fence language tag the model must use. */
export const TOOL_CALL_FENCE = 'tool-call'

// Lenient by necessity: ChatGPT's composer pipeline eats backticks, so live
// answers arrive with ```, ``, or occasionally a bare `tool-call` opener.
// Closing needs 2+ backticks (single-backtick inline code must never parse
// as a call). Unknown names and bad JSON still reject loudly.
const FENCE_RE = /(?:`{2,3})?tool-call[ \t]*\r?\n([\s\S]*?)`{2,3}/g

/** One validated call with its span in the source text. */
export interface ParsedToolCall {
  name: string
  /** Canonical JSON string of the arguments object. */
  arguments: string
  start: number
  end: number
}

/** One rejected block with a human-readable reason for the retry notice. */
export interface RejectedToolCall {
  raw: string
  reason: string
}

export type TurnSegment =
  | { type: 'text'; text: string }
  | { type: 'call'; call: ParsedToolCall }

export interface ParsedTurn {
  segments: TurnSegment[]
  rejected: RejectedToolCall[]
  /** Number of valid calls. */
  callCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render the tool-use contract + schemas appended to the prompt when tools
 * are advertised. Pure text: the model reads it, the page executes nothing.
 */
export function renderToolContract(tools: ToolSchema[]): string {
  const names = tools.map(tool => tool.name).join(', ')
  const schemas = tools
    .map(tool => `## ${tool.name}: ${tool.description}\n${JSON.stringify(tool.parameters)}`)
    .join('\n\n')
  return [
    '[Tool use] READ THIS FIRST — it is how you act, not background info.',
    'The tools in [Tool schemas] below are the ONLY executable tools in this environment. This chat has NO native python/container/web/image tools — any attempt to use them does nothing.',
    'The ONLY way to call a tool is emitting exactly one fenced block per call, then STOP writing (no text after the last block).',
    'Merely describing or narrating an action ("I will run...", "Writing file...", "bash -lc ...", a ```python block) DOES NOTHING — only a fenced ```tool-call block executes.',
    'Example — this block really runs, prose does not:',
    '```tool-call',
    '{"name": "bash", "arguments": {"command": "echo hello-loops"}}',
    '```',
    'Rules:',
    `- "name" must be one of: ${names}.`,
    '- "arguments" must be a JSON object matching that tool\'s schema.',
    '- You may emit several calls; they run top to bottom, then you get the results and continue.',
    '- If you need no tool, just answer normally and emit no block.',
    'Proof this works (an earlier exchange in this same session):',
    'Assistant:',
    '```tool-call',
    '{"name": "bash", "arguments": {"command": "echo hello-loops"}}',
    '```',
    'System: [Tool result] hello-loops',
    'Assistant: Done — the command ran and returned its output above.',
    '[Tool schemas]',
    schemas,
  ].join('\n')
}

/**
 * Split answer text into text/call segments, validating each block.
 * @param text - full model answer.
 * @param knownTools - advertised tool names; anything else is rejected.
 */
export function parseToolCalls(text: string, knownTools: ReadonlySet<string>): ParsedTurn {
  const segments: TurnSegment[] = []
  const rejected: RejectedToolCall[] = []
  let callCount = 0
  let cursor = 0
  FENCE_RE.lastIndex = 0
  for (;;) {
    const match = FENCE_RE.exec(text)
    if (!match || match.index === undefined) break
    const body = (match[1] ?? '').trim()
    const end = match.index + match[0].length
    const head = text.slice(cursor, match.index)
    if (head.length > 0) segments.push({ type: 'text', text: head })
    cursor = end
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      rejected.push({ raw: body.slice(0, 200), reason: 'block is not valid JSON' })
      continue
    }
    if (!isRecord(parsed) || typeof parsed['name'] !== 'string') {
      rejected.push({ raw: body.slice(0, 200), reason: 'block needs a string "name"' })
      continue
    }
    if (!knownTools.has(parsed['name'])) {
      rejected.push({ raw: body.slice(0, 200), reason: `unknown tool "${parsed['name']}"` })
      continue
    }
    if (!isRecord(parsed['arguments'])) {
      rejected.push({ raw: body.slice(0, 200), reason: '"arguments" must be a JSON object' })
      continue
    }
    callCount += 1
    segments.push({
      type: 'call',
      call: {
        name: parsed['name'],
        arguments: JSON.stringify(parsed['arguments']),
        start: match.index,
        end,
      },
    })
  }
  const tail = text.slice(cursor)
  if (tail.length > 0) segments.push({ type: 'text', text: tail })
  return { segments, rejected, callCount }
}

/**
 * One-line retry notice for rejected blocks, prepended to the next prompt of
 * the same session so the model can self-correct.
 */
export function renderRejectionNotice(rejected: RejectedToolCall[]): string {
  const lines = rejected.map(entry => `- ${entry.reason}: ${entry.raw}`)
  return `[System notice] Your last turn emitted ${rejected.length} unusable tool-call block(s); none ran. Fix and retry:\n${lines.join('\n')}`
}
