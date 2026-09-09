import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, Config, PROVIDER, resolveAdapterOptions } from '../src/index.ts'

function stubCtx() {
  const routes: Array<{ providers: string[]; adapter: unknown }> = []
  const effects: Array<() => void | Promise<void>> = []
  const events: string[] = []
  return {
    routes,
    effects,
    events,
    llm: {
      registerAdapter(providers: string[], adapter: unknown) {
        routes.push({ providers, adapter })
        return { replace: (_next: string[]) => {} }
      },
    },
    on(name: string, _listener: unknown) {
      events.push(name)
      return () => {}
    },
    effect(setup: () => () => void | Promise<void>) {
      effects.push(setup())
      return () => {}
    },
  }
}

describe('plugin', () => {
  it('registers the chatgpt-web route', () => {
    const ctx = stubCtx()
    apply(ctx as never, {})
    expect(ctx.routes).toHaveLength(1)
    expect(ctx.routes[0]?.providers).toEqual([PROVIDER])
    expect(ctx.routes[0]?.adapter).toBeDefined()
  })

  it('releases the browser with the calling fiber', () => {
    const ctx = stubCtx()
    apply(ctx as never, {})
    expect(ctx.effects).toHaveLength(1)
  })

  it('resolves defaults and validates the catalog', () => {
    const options = resolveAdapterOptions({})
    expect(options.connectorTransport).toBe('text')
    expect(options.profileDir.length).toBeGreaterThan(0)
    expect(options.models.map(m => m.id)).toContain('chatgpt-web/high')
    expect(() => resolveAdapterOptions({ models: [{ id: 'openai/gpt-4' }] })).toThrowError(/chatgpt-web\//)
    expect(() => resolveAdapterOptions({
      models: [{ id: 'chatgpt-web/high' }, { id: 'chatgpt-web/high' }],
    })).toThrowError(/duplicate/i)
  })

  it('resolves native connector defaults and rejects an empty connector name', () => {
    const options = resolveAdapterOptions({ connectorTransport: 'mcp' })
    expect(options.connectorTransport).toBe('mcp')
    expect(options.connectorName).toBe('DSH Native')
    expect(options.mcpInvocationTimeoutMs).toBe(90_000)
    expect(options.brokerSocketPath).toMatch(/dsh-[^/]+\/b-[^/]+\.sock$/)
    expect(() => resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorName: '   ',
    })).toThrowError(/connectorName/i)
  })

  it('keeps external runtime compatible and resolves managed config explicitly', () => {
    const defaults = resolveAdapterOptions({})
    expect(defaults.connectorTransport).toBe('text')
    expect(defaults.connectorRuntime).toBe('external')

    const managed = resolveAdapterOptions({
      profileDir: '/tmp/dsh-managed-profile',
      connectorTransport: 'mcp',
      connectorRuntime: 'managed',
    })
    expect(managed.connectorRuntime).toBe('managed')
    expect(managed.nativeRuntimeConfigPath).toBe('/tmp/dsh-managed-profile/native-runtime.json')
  })

  it('rejects managed runtime outside MCP and on Windows', () => {
    expect(() => resolveAdapterOptions({ connectorRuntime: 'managed' }))
      .toThrow(/requires connectorTransport "mcp"/)
    expect(() => resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorRuntime: 'managed',
    }, 'win32')).toThrow(/unsupported on win32/)
  })

  it('installs native lifecycle listeners and tears down the broker stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-native-'))
    const ctx = stubCtx()
    apply(ctx as never, {
      connectorTransport: 'mcp',
      brokerSocketPath: join(root, 'broker.sock'),
    })
    expect(ctx.events).toEqual(['agent/turn-stopping', 'session/event'])
    await ctx.effects[0]?.()
  })

  it('keeps text mode free of native lifecycle listeners', () => {
    const ctx = stubCtx()
    apply(ctx as never, {})
    expect(ctx.events).toEqual([])
  })

  it('exposes a schemastery Config schema', () => {
    expect(Config).toBeDefined()
  })
})
