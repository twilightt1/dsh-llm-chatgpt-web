import { describe, expect, it } from 'vitest'
import { parseToolCalls, renderRejectionNotice, renderToolContract } from '../src/chatgpt/toolcalls.ts'

const KNOWN = new Set(['bash', 'read'])

describe('parseToolCalls', () => {
  it('extracts one call with canonical arguments', () => {
    const parsed = parseToolCalls(
      'I will check.\n```tool-call\n{"name": "bash", "arguments": {"command": "ls", "x": 1}}\n```',
      KNOWN,
    )
    expect(parsed.callCount).toBe(1)
    expect(parsed.rejected).toEqual([])
    expect(parsed.segments).toHaveLength(2)
    expect(parsed.segments[0]).toEqual({ type: 'text', text: 'I will check.\n' })
    const call = parsed.segments[1]
    expect(call?.type).toBe('call')
    if (call?.type === 'call') {
      expect(call.call.name).toBe('bash')
      expect(call.call.arguments).toBe('{"command":"ls","x":1}')
    }
  })

  it('handles several calls with text between and after', () => {
    const parsed = parseToolCalls(
      'a\n```tool-call\n{"name":"bash","arguments":{}}\n```\nmiddle\n```tool-call\n{"name":"read","arguments":{"p":"x"}}\n```\ntail',
      KNOWN,
    )
    expect(parsed.callCount).toBe(2)
    expect(parsed.segments.map(s => s.type)).toEqual(['text', 'call', 'text', 'call', 'text'])
  })

  it('rejects malformed blocks without executing anything', () => {
    const parsed = parseToolCalls(
      '```tool-call\nnot json\n```\n```tool-call\n{"name":"nope","arguments":{}}\n```\n```tool-call\n{"name":"bash","arguments":[]}\n```\n```tool-call\n{"arguments":{}}\n```',
      KNOWN,
    )
    expect(parsed.callCount).toBe(0)
    expect(parsed.rejected).toHaveLength(4)
    expect(parsed.rejected.map(r => r.reason)).toEqual([
      'block is not valid JSON',
      'unknown tool "nope"',
      '"arguments" must be a JSON object',
      'block needs a string "name"',
    ])
  })

  it('ignores other fences and plain text', () => {
    const parsed = parseToolCalls('```json\n{"name":"bash"}\n```\njust text', KNOWN)
    expect(parsed.callCount).toBe(0)
    expect(parsed.rejected).toEqual([])
    expect(parsed.segments).toEqual([{ type: 'text', text: '```json\n{"name":"bash"}\n```\njust text' }])
  })

  it('tolerates eaten backticks (live ChatGPT mangling)', () => {
    const twoTick = parseToolCalls(
      'ok\n``tool-call\n{"name":"bash","arguments":{"command":"ls"}}\n``',
      KNOWN,
    )
    expect(twoTick.callCount).toBe(1)
    const bare = parseToolCalls(
      'tool-call\n{"name":"read","arguments":{"p":"x"}}\n``',
      KNOWN,
    )
    expect(bare.callCount).toBe(1)
    if (bare.segments[0]?.type === 'call') {
      expect(bare.segments[0].call.name).toBe('read')
    } else {
      expect.unreachable('expected a call segment')
    }
  })

  it('recovers the JSON when the opening fence is eaten but a stray closing fence remains (live shape)', () => {
    // Observed live: ChatGPT rendered "tool-call\n\n```\n{...}\n```" — no
    // opening backticks, payload wrapped in a stray fence pair.
    const mangled = parseToolCalls(
      'tool-call\n\n```\n{"name":"read","arguments":{"path":"hello.txt"}}\n```',
      KNOWN,
    )
    expect(mangled.callCount).toBe(1)
    expect(mangled.rejected).toEqual([])
    const call = mangled.segments[0]
    expect(call?.type).toBe('call')
    if (call?.type === 'call') {
      expect(call.call.name).toBe('read')
      expect(JSON.parse(call.call.arguments)).toEqual({ path: 'hello.txt' })
    }
  })

  it('returns empty segments for empty input', () => {
    expect(parseToolCalls('', KNOWN)).toEqual({ segments: [], rejected: [], callCount: 0 })
  })
})

describe('renderToolContract', () => {
  it('names tools with flat arg hints, no full schemas', () => {
    const contract = renderToolContract([
      { name: 'bash', description: 'Run shell. Extra detail.', parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command' },
          description: { type: 'string', description: 'What it does' },
          timeoutMs: { type: 'number' },
        },
        required: ['command', 'description'],
      } },
    ])
    expect(contract).toContain('```tool-call')
    expect(contract).toContain('bash(command:string, description:string)')
    expect(contract).toContain('Run shell')
    // Full nested schema must NOT appear (75k-char echo prevention)
    expect(contract).not.toContain('"properties"')
  })
})

describe('renderRejectionNotice', () => {
  it('lists reasons for the retry turn', () => {
    const notice = renderRejectionNotice([{ raw: 'xx', reason: 'block is not valid JSON' }])
    expect(notice).toContain('block is not valid JSON')
    expect(notice).toContain('xx')
  })
})
