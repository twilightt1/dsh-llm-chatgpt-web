import { describe, expect, it } from 'vitest'
import { isLoopbackEndpoint } from '../src/chatgpt/daemon.ts'

describe('isLoopbackEndpoint', () => {
  it('accepts IPv4, bracketed IPv6, and hostname loopbacks', () => {
    expect(isLoopbackEndpoint('ws://127.0.0.1:55982/abc')).toBe(true)
    expect(isLoopbackEndpoint('ws://[::1]:55982/abc')).toBe(true)
    expect(isLoopbackEndpoint('ws://localhost:55982/abc')).toBe(true)
  })

  it('rejects remote URLs and non-ws schemes', () => {
    expect(isLoopbackEndpoint('ws://192.168.1.2:55982/abc')).toBe(false)
    expect(isLoopbackEndpoint('ws://example.com/abc')).toBe(false)
    expect(isLoopbackEndpoint('wss://127.0.0.1/abc')).toBe(false)
    expect(isLoopbackEndpoint('ws://[::1]evil.com/abc')).toBe(false)
    expect(isLoopbackEndpoint('not-a-url')).toBe(false)
  })
})
