import { describe, expect, it } from 'vitest'
import {
  assertChatGptSurfaceUrl,
  chatGptSurfaceUrl,
  parseChatGptEffortSliderState,
} from '../src/chatgpt/session.ts'
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_SOL_BACKEND_MODEL,
  resolveChatGptWebModelMode,
} from '../src/chatgpt/model.ts'
import { resolveSlugBackend } from '../src/chatgpt/effort.ts'
import { estimateTokens, estimateUsage } from '../src/chatgpt/usage.ts'
import { defaultChromeExecutable } from '../src/chatgpt/launch.ts'

describe('ChatGPT surface URLs', () => {
  it('uses Temporary Chat for text and normal chat for connectors', () => {
    expect(chatGptSurfaceUrl('temporary')).toBe('https://chatgpt.com/?temporary-chat=true')
    expect(chatGptSurfaceUrl('connector')).toBe('https://chatgpt.com/')
  })

  it('rejects the connector-disabled Temporary Chat surface for native mode', () => {
    expect(() => assertChatGptSurfaceUrl('https://chatgpt.com/', 'connector')).not.toThrow()
    expect(() => assertChatGptSurfaceUrl('https://chatgpt.com/?temporary-chat=true', 'connector')).toThrow(/connector/i)
    expect(() => assertChatGptSurfaceUrl('https://chatgpt.com/?temporary-chat=true', 'temporary')).not.toThrow()
  })
})

describe('parseChatGptEffortSliderState', () => {
  it('accepts a valid 5-option range', () => {
    expect(parseChatGptEffortSliderState('0', '4', '2')).toEqual({ min: 0, max: 4, value: 2 })
  })

  it('rejects out-of-range and oversized ranges', () => {
    expect(parseChatGptEffortSliderState('0', '4', '9')).toBeUndefined()
    expect(parseChatGptEffortSliderState('0', '9', '0')).toBeUndefined()
    expect(parseChatGptEffortSliderState(null, '4', '2')).toBeUndefined()
    expect(parseChatGptEffortSliderState('a', '4', '2')).toBeUndefined()
  })
})

describe('resolveChatGptWebModelMode', () => {
  const sol = { localToolsEnabled: false, solAvailable: true, proAvailable: false }
  const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true }
  const lunaOnly = { localToolsEnabled: false, solAvailable: false, proAvailable: false }

  it('maps Sol efforts to UI indexes', () => {
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_SOL_BACKEND_MODEL, 'low', sol).uiEffortIndex).toBe(0)
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_SOL_BACKEND_MODEL, 'high', sol).uiEffortIndex).toBe(2)
  })

  it('gates xhigh/max behind Pro, Sol behind the selector', () => {
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_SOL_BACKEND_MODEL, 'max', sol)).toThrowError(/Pro/)
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_SOL_BACKEND_MODEL, 'high', lunaOnly)).toThrowError(/Luna-only/)
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_SOL_BACKEND_MODEL, 'max', pro).displayLabel).toBe('Pro')
  })

  it('resolves Luna vs Think by reasoning', () => {
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_BACKEND_MODEL, 'low', lunaOnly).displayLabel).toBe('Luna')
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_BACKEND_MODEL, 'medium', lunaOnly).displayLabel).toBe('Think')
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_BACKEND_MODEL, 'low', sol)).toThrowError(/Sol model selector/)
  })
})

describe('resolveSlugBackend', () => {
  it('maps every catalog slug to a backend + effort', () => {
    expect(resolveSlugBackend('chatgpt-web/luna')).toEqual({ backend: CHATGPT_WEB_LUNA_BACKEND_MODEL, effort: 'low' })
    expect(resolveSlugBackend('chatgpt-web/think')).toEqual({ backend: CHATGPT_WEB_LUNA_BACKEND_MODEL, effort: 'medium' })
    expect(resolveSlugBackend('chatgpt-web/light')).toEqual({ backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'low' })
    expect(resolveSlugBackend('chatgpt-web/pro')).toEqual({ backend: CHATGPT_WEB_SOL_BACKEND_MODEL, effort: 'max' })
    expect(() => resolveSlugBackend('chatgpt-web/unknown')).toThrowError(/not supported/)
  })
})

describe('usage estimates', () => {
  it('scales with length and never reports zero', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateUsage(400, 40)).toEqual({ inputTokens: 100, outputTokens: 10 })
  })
})

describe('defaultChromeExecutable', () => {
  it('resolves per platform', () => {
    expect(defaultChromeExecutable('darwin')).toContain('Google Chrome.app')
    expect(defaultChromeExecutable('win32', 'D:\\PF')).toContain('chrome.exe')
    expect(defaultChromeExecutable('linux')).toBe('/usr/bin/google-chrome')
  })
})
