import { describe, expect, it } from 'vitest'
import { apply, Config, PROVIDER, resolveAdapterOptions } from '../src/index.ts'

function stubCtx() {
  const routes: Array<{ providers: string[]; adapter: unknown }> = []
  const effects: Array<() => void> = []
  return {
    routes,
    effects,
    llm: {
      registerAdapter(providers: string[], adapter: unknown) {
        routes.push({ providers, adapter })
        return { replace: (_next: string[]) => {} }
      },
    },
    effect(setup: () => () => void) {
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
    expect(options.brokerSocketPath).toContain('native-broker-')
    expect(() => resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorName: '   ',
    })).toThrowError(/connectorName/i)
  })

  it('exposes a schemastery Config schema', () => {
    expect(Config).toBeDefined()
  })
})
