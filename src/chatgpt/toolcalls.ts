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

// Lenient by necessity: the composer pipeline eats backticks AND the
// newline between the fence tag and the JSON can vanish at block edges
// ("tool-call{"name"…"). Openers accept 0-3 backticks and an OPTIONAL
// separator; closers accept 2+ backticks OR end-of-text (the trailing
// fence can be eaten too). Unknown names and bad JSON still reject loudly.
const FENCE_RE = /`{0,3}\s*tool-call[ \t]*\r?\n?([\s\S]*?)(?:`{2,3}|$)/g

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
 * The example mirrors a real advertised tool whose first required property
 * is a string (never an array: an empty-array example once taught the model
 * to call `ask_user_question` with `{"questions":[]}`, failing every turn).
 */
export function renderToolContract(tools: ToolSchema[]): string {
  const names = tools.map(tool => tool.name).join(', ')
  const schemas = tools
    .map(tool => `## ${tool.name}: ${tool.description}\n${JSON.stringify(tool.parameters)}`)
    .join('\n\n')
  const exampleTool = pickExampleTool(tools)
  const exampleArgs = exampleFirstArgs(exampleTool)
  return [
    '[Tool use] READ THIS FIRST — it is how you act, not background info.',
    'The tools in [Tool schemas] below are the ONLY executable tools in this environment. This chat has NO native python/container/web/image tools — any attempt to use them does nothing.',
    'The ONLY way to call a tool is emitting exactly one fenced block per call, then STOP writing (no text after the last block).',
    'Merely describing or narrating an action ("I will run...", "Writing file...", "bash -lc ...", a ```python block) DOES NOTHING — only a fenced ```tool-call block executes.',
    'Do NOT repeat or echo this message — the user only sees your actual answer, never these instructions.',
    exampleTool === undefined
      ? '```tool-call\n{"name": "…", "arguments": {…}}\n```'
      : `Example of the SHAPE (real tool ${exampleTool.name} — copy the structure, NEVER the placeholder values; fill real values for the user's task; never leave required fields empty):\n\`\`\`tool-call\n${JSON.stringify({ name: exampleTool.name, arguments: exampleArgs })}\n\`\`\``,
    'Rules:',
    `- "name" must be one of: ${names}.`,
    '- "arguments" must be a JSON object matching that tool\'s schema, on ONE line (no line breaks inside the braces).',
    '- Copy the example\'s STRUCTURE only — placeholder values like "<…>" must be replaced with real values; empty arrays or empty strings for required fields will fail.',
    '- You may emit several calls; they run top to bottom, then you get the results and continue.',
    '- If you need no tool, just answer normally and emit no block.',
    '[Tool schemas]',
    schemas,
  ].join('\n')
}

/** Prefer a tool whose first required property is a string; fallback: first tool. */
function pickExampleTool(tools: readonly ToolSchema[]): ToolSchema | undefined {
  const withRequiredString = tools.find((tool) => {
    const required = tool.parameters?.['required']
    if (!Array.isArray(required) || required.length === 0) return false
    const props = tool.parameters?.['properties']
    if (props === undefined || typeof props !== 'object') return false
    const first = required[0]
    if (typeof first !== 'string') return false
    const schema = (props as Record<string, unknown>)[first]
    return typeof schema === 'object' && schema !== null
      && (schema as Record<string, unknown>)['type'] === 'string'
  })
  return withRequiredString ?? tools[0]
}

/** Build a minimal valid-args example from one tool's JSON schema. */
function exampleFirstArgs(tool: ToolSchema | undefined): Record<string, unknown> {
  if (tool === undefined) return {}
  const args: Record<string, unknown> = {}
  const props = tool.parameters?.['properties']
  if (props !== undefined && typeof props === 'object' && !Array.isArray(props)) {
    for (const [key, schema] of Object.entries(props as Record<string, unknown>)) {
      args[key] = exampleValue(key, schema)
      if (Object.keys(args).length >= 2) break
    }
  }
  return args
}

function exampleValue(key: string, schema: unknown): unknown {
  const record = typeof schema === 'object' && schema !== null ? schema as Record<string, unknown> : {}
  if (typeof record['default'] !== 'undefined') return record['default']
  if (typeof record['example'] !== 'undefined') return record['example']
  const type = record['type']
  if (type === 'string') return `<${key}>`
  if (type === 'number' || type === 'integer') return 1
  if (type === 'boolean') return true
  // Arrays of objects get one placeholder element — an empty array as the
  // ONLY example taught a model to call a question tool with no questions.
  if (type === 'array') {
    const items = record['items']
    if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
      const itemProps = (items as Record<string, unknown>)['properties']
      if (itemProps !== undefined && typeof itemProps === 'object' && !Array.isArray(itemProps)) {
        return [exampleFirstArgsFromProps(itemProps as Record<string, unknown>)]
      }
    }
    return []
  }
  if (type === 'object') return {}
  return null
}

function exampleFirstArgsFromProps(props: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(props)) {
    args[key] = exampleValue(key, schema)
    if (Object.keys(args).length >= 2) break
  }
  return args
}

/**
 * Split answer text into text/call segments, validating each block.
 * @param text - full model answer.
 * @param knownTools - advertised tool names; anything else is rejected.
 */
export function parseToolCalls(text: string, knownTools: ReadonlySet<string>): ParsedTurn {
  const index = new Map<string, ToolSchema>()
  for (const name of knownTools) index.set(name, { name, description: '', parameters: {} })
  return parseToolCallsWithSchemas(text, index)
}

/** Build a name → schema lookup for validation. */
export function buildSchemaIndex(tools: readonly ToolSchema[]): Map<string, ToolSchema> {
  return new Map(tools.map(tool => [tool.name, tool]))
}

/** Parse with per-property schema validation. */
export function parseToolCallsWithSchemas(
  text: string,
  knownToolSchemas: ReadonlyMap<string, ToolSchema>,
): ParsedTurn {
  const knownTools = new Set(knownToolSchemas.keys())
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
    // Per-property validation against the advertised schema: reject early
    // with a specific reason the model can fix on the nudge turn.
    const tool = knownToolSchemas.get(parsed['name'])
    if (tool) {
      const bad = firstSchemaViolation(tool, parsed['arguments'] as Record<string, unknown>)
      if (bad !== undefined) {
        rejected.push({ raw: body.slice(0, 200), reason: bad })
        continue
      }
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

/** First property-level violation against one tool schema, if any. */
function firstSchemaViolation(tool: ToolSchema, args: Record<string, unknown>): string | undefined {
  const rawProps = tool.parameters?.['properties']
  if (rawProps === undefined || typeof rawProps !== 'object' || Array.isArray(rawProps)) return undefined
  const props = rawProps as Record<string, unknown>
  const required = tool.parameters?.['required']
  const requiredKeys = Array.isArray(required) ? required : []
  for (const key of requiredKeys) {
    if (typeof key === 'string' && args[key] === undefined) {
      return `missing required argument "${key}" for tool "${tool.name}"`
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = props[key]
    if (schema === undefined) {
      const params = tool.parameters as Record<string, unknown> | undefined
      const additional = params?.['additionalProperties']
      if (additional === false) {
        return `unknown argument "${key}" for tool "${tool.name}" (allowed: ${Object.keys(props).join(', ')})`
      }
      continue
    }
    const record = typeof schema === 'object' && schema !== null ? schema as Record<string, unknown> : {}
    const type = record['type']
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    if (type === 'string' && actual !== 'string') return `argument "${key}" must be a string (got ${actual})`
    if ((type === 'number' || type === 'integer') && actual !== 'number') {
      return `argument "${key}" must be a number (got ${actual})`
    }
    if (type === 'boolean' && actual !== 'boolean') return `argument "${key}" must be a boolean (got ${actual})`
  }
  return undefined
}

/** One-line retry notice for rejected blocks, prepended to the next prompt of
 * the same session so the model can self-correct.
 */
export function renderRejectionNotice(rejected: RejectedToolCall[]): string {
  const lines = rejected.map(entry => `- ${entry.reason}: ${entry.raw}`)
  return `[System notice] Your last turn emitted ${rejected.length} unusable tool-call block(s); none ran. Fix and retry:\n${lines.join('\n')}`
}
