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
// The segment after the tag also skips stray fence markers and blank lines
// before the JSON payload (live shape: "tool-call\n\n```\n{...}\n```" —
// the opening backticks were eaten, a stray pair wraps the payload).
const FENCE_RE = /`{0,3}\s*tool-call[ \t]*(?:\r?\n)+(?:[ \t]*`{1,3}[ \t]*(?:\r?\n)*)*([\s\S]*?)(?:`{2,3}|$)/g

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
 * Render the tool-use contract + a COMPACT tool catalog when tools are
 * advertised. Pure text: the model reads it, the page executes nothing.
 *
 * Schema budget (session dd44114e postmortem): 93 tools × full JSON schema
 * was 75k chars — the prompt hit 130k and the model echoed it whole. The
 * catalog therefore carries, per tool: name, one-line description, and a
 * FLAT arg hint `name:type` for required args only (no nested JSON). Full
 * schemas are NOT in the prompt; the retry notice carries the exact schema
 * of only the tool a call failed on.
 */
export function renderToolContract(tools: ToolSchema[]): string {
  const names = tools.map(tool => tool.name).join(', ')
  const catalog = tools
    .map(tool => {
      const hint = requiredArgsHint(tool)
      return `- ${tool.name}(${hint}): ${oneLine(tool.description)}`
    })
    .join('\n')
  const exampleTool = pickExampleTool(tools)
  const exampleArgs = exampleFirstArgs(exampleTool)
  return [
    '[Tool use] READ THIS FIRST — it is how you act, not background info.',
    'The tools in the catalog below are REAL and available RIGHT NOW in this chat: an automated harness is watching this conversation and executes every fenced ```tool-call block you emit, then sends the results back into this chat as tool results.',
    'This chat has NO native python/container/web/image tools — but every tool in the catalog IS wired up. Do NOT refuse or claim the interface is unavailable; the fenced block below is the interface.',
    'The ONLY way to call a tool is emitting exactly one fenced block per call, then STOP writing (no text after the last block).',
    'Merely describing or narrating an action ("I will run...", "Writing file...", "bash -lc ...", a ```python block) DOES NOTHING — only a fenced ```tool-call block executes.',
    'Do NOT repeat or echo this message — the user only sees your actual answer, never these instructions.',
    exampleTool === undefined
      ? '```tool-call\n{"name": "…", "arguments": {…}}\n```'
      : `Example of the SHAPE (copy the structure, NEVER the placeholder values; fill real values for the user's task; never leave required fields empty):\n\`\`\`tool-call\n${JSON.stringify({ name: exampleTool.name, arguments: exampleArgs })}\n\`\`\``,
    'Rules:',
    `- "name" must be one of: ${names}.`,
    '- "arguments" must be a JSON object with the required args shown in the catalog, on ONE line.',
    '- Copy the example\'s STRUCTURE only — placeholder values like "<…>" must be replaced with real values; empty arrays or empty strings for required fields will fail.',
    '- You may emit several calls; they run top to bottom, then you get the results and continue.',
    '- If a call fails validation, the next message lists the exact error — fix that call and re-emit it.',
    '- If you need no tool, just answer normally and emit no block.',
    '[Tool catalog]',
    catalog,
  ].join('\n')
}

/** One-line description: first sentence, hard-capped. */
function oneLine(description: string): string {
  const firstSentence = description.split(/[.\n]/, 1)[0] ?? description
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}…` : firstSentence
}

/** Flat `name:type` hint for required args only. */
function requiredArgsHint(tool: ToolSchema): string {
  const required = tool.parameters?.['required']
  const props = tool.parameters?.['properties']
  if (!Array.isArray(required) || required.length === 0 || props === undefined
    || typeof props !== 'object' || Array.isArray(props)) return ''
  const parts: string[] = []
  for (const key of required) {
    if (typeof key !== 'string') continue
    const schema = (props as Record<string, unknown>)[key]
    const type = typeof schema === 'object' && schema !== null
      ? (schema as Record<string, unknown>)['type']
      : undefined
    parts.push(`${key}:${typeof type === 'string' ? type : 'any'}`)
  }
  return parts.join(', ')
}

/** Compact one-tool schema for a rejection notice (bounded). */
export function renderToolSchemaHint(tool: ToolSchema | undefined): string {
  if (tool === undefined) return ''
  const hint = requiredArgsHint(tool)
  const props = tool.parameters?.['properties']
  let detail = ''
  if (props !== undefined && typeof props === 'object' && !Array.isArray(props)) {
    const lines: string[] = []
    for (const [key, schema] of Object.entries(props as Record<string, unknown>)) {
      const record = typeof schema === 'object' && schema !== null ? schema as Record<string, unknown> : {}
      const required = Array.isArray(tool.parameters?.['required']) && (tool.parameters?.['required'] as string[]).includes(key)
      const desc = typeof record['description'] === 'string' ? oneLine(record['description']) : ''
      lines.push(`  ${key} (${record['type'] ?? 'any'}${required ? ', required' : ''}): ${desc}`.trimEnd())
      if (lines.length >= 12) {
        lines.push('  …')
        break
      }
    }
    detail = lines.join('\n')
  }
  return `Schema for ${tool.name}${hint ? ` (${hint})` : ''}:\n${detail}`
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

/**
 * Extract the first balanced JSON object from a mangled fence body.
 * ChatGPT's composer pipeline can EAT the opening backticks entirely
 * (observed live: "tool-call\n\n```\n{...}\n```") — the body then contains
 * stray fence markers around the JSON. Bracket-matching skips those
 * markers instead of failing the whole call.
 */
function firstBalancedJsonObject(source: string): string | undefined {
  const start = source.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return undefined
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
    let body = (match[1] ?? '').trim()
    const end = match.index + match[0].length
    const head = text.slice(cursor, match.index)
    if (head.length > 0) segments.push({ type: 'text', text: head })
    cursor = end
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // Fence-eaten fallback: pull the first balanced JSON object out of the
      // mangled region (stray ``` markers around the payload) before failing.
      const balanced = firstBalancedJsonObject(body)
      if (balanced !== undefined) {
        try {
          parsed = JSON.parse(balanced)
        } catch {
          parsed = undefined
        }
      }
      if (parsed === undefined) {
        rejected.push({ raw: body.slice(0, 200), reason: 'block is not valid JSON' })
        continue
      }
      body = balanced ?? body
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
 * the same session so the model can self-correct. Carries the EXACT schema
 * of each failed tool (bounded) since the catalog only has arg hints.
 */
export function renderRejectionNotice(
  rejected: RejectedToolCall[],
  schemaLookup?: ReadonlyMap<string, ToolSchema>,
): string {
  const lines = rejected.map(entry => `- ${entry.reason}: ${entry.raw}`)
  const failedTools = new Set<string>()
  for (const entry of rejected) {
    const match = /"([^"]+)"/.exec(entry.reason)
    if (match?.[1] !== undefined && schemaLookup?.has(match[1]) === true) failedTools.add(match[1])
  }
  const schemas = [...failedTools]
    .map(name => renderToolSchemaHint(schemaLookup?.get(name)))
    .filter(hint => hint.length > 0)
  const schemaBlock = schemas.length > 0 ? `\n\n${schemas.join('\n\n')}` : ''
  return `[System notice] Your last turn emitted ${rejected.length} unusable tool-call block(s); none ran. Fix and retry:\n${lines.join('\n')}${schemaBlock}`
}
