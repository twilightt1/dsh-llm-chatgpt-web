/**
 * Cordis plugin: register a {@link ChatGptWebAdapter} for the `chatgpt-web`
 * provider route on `ctx.llm`.
 *
 * The adapter owns its Chromium (system Chrome + a plugin profile directory
 * holding the ChatGPT login session). Connection facts are resolved once per
 * operation, so a changed profile or timeout reaches the next request while
 * an in-flight turn keeps the facts it started with.
 * @module dsh-llm-chatgpt-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  ChatGptWebAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_DAEMON_IDLE_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
} from './adapter.ts'
import type { ChatGptWebCatalogModel, ChatGptWebConnectionOptions } from './adapter.ts'
import { defaultProfileDir, resolveChromeExecutable } from './chatgpt/launch.ts'

export { ChatGptWebAdapter } from './adapter.ts'
export type {
  ChatGptWebAdapterOptions,
  ChatGptWebCatalogModel,
  ChatGptWebConnectionOptions,
} from './adapter.ts'
export { compilePrompt } from './chatgpt/prompt.ts'

export const name = 'llm-chatgpt-web'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'chatgpt-web'

const DEFAULT_MODELS: ChatGptWebCatalogModel[] = [
  { id: 'chatgpt-web/luna', name: 'ChatGPT Web Luna', contextWindow: 1_050_000 },
  { id: 'chatgpt-web/think', name: 'ChatGPT Web Think', contextWindow: 1_050_000 },
  { id: 'chatgpt-web/light', name: 'ChatGPT Web Instant', contextWindow: 41_000 },
  { id: 'chatgpt-web/medium', name: 'ChatGPT Web Medium', contextWindow: 90_000 },
  { id: 'chatgpt-web/high', name: 'ChatGPT Web High', contextWindow: 90_000 },
  { id: 'chatgpt-web/extra-high', name: 'ChatGPT Web Extra High', contextWindow: 112_001 },
  { id: 'chatgpt-web/pro', name: 'ChatGPT Web Pro', contextWindow: 112_001 },
]

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** Plugin config. Paths accept `~` (expanded) — never shared between users. */
export interface Config {
  /** Profile home for the ChatGPT login session; defaults to `~/.dsh-chatgpt-web`. */
  profileDir?: string
  /** System Chrome executable; omitted means auto-detect, then bundled Chromium. */
  chromeExecutablePath?: string
  /** Run turns headed (reserved; the daemon is always headed-hidden). */
  headed?: boolean
  /** Headed but placed off-screen (reserved; the daemon is always hidden). */
  offscreen?: boolean
  /** Daemon idle shutdown in ms (default 30 minutes; min 1 minute). */
  daemonIdleMs?: number
  /** Budget for the manual sign-in window (default 10 minutes). */
  loginTimeoutMs?: number
  /** Whole-turn budget (default 5 minutes). */
  turnTimeoutMs?: number
  /** No-output-growth budget while streaming (default 2 minutes). */
  stallTimeoutMs?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers. */
  models?: ChatGptWebCatalogModel[]
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<ChatGptWebCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config: z<Config> = z.object({
  profileDir: z.string().default(defaultProfileDir()),
  chromeExecutablePath: z.string(),
  headed: z.boolean().default(false),
  offscreen: z.boolean().default(true),
  daemonIdleMs: z.number().min(60_000).max(2_147_483_647).default(DEFAULT_DAEMON_IDLE_MS),
  loginTimeoutMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_LOGIN_TIMEOUT_MS),
  turnTimeoutMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_TURN_TIMEOUT_MS),
  stallTimeoutMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_STALL_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  retryPolicy: RetryPolicySchema,
})

function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.'
    return home + path.slice(1)
  }
  return path
}

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly ChatGptWebCatalogModel[] | undefined): ChatGptWebCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-chatgpt-web: catalog model ids must be non-empty')
    if (!model.id.startsWith('chatgpt-web/')) {
      throw new Error(`llm-chatgpt-web: catalog model "${model.id}" must start with "chatgpt-web/"`)
    }
    if (seen.has(model.id)) throw new Error(`llm-chatgpt-web: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...(model.inputModalities ?? ['text'])],
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 */
export function resolveAdapterOptions(config: Config): ChatGptWebConnectionOptions {
  return {
    profileDir: expandHome(config.profileDir ?? defaultProfileDir()),
    chromeExecutablePath: config.chromeExecutablePath
      ? expandHome(config.chromeExecutablePath)
      : resolveChromeExecutable(),
    headed: config.headed ?? false,
    offscreen: config.offscreen ?? true,
    daemonIdleMs: config.daemonIdleMs ?? DEFAULT_DAEMON_IDLE_MS,
    loginTimeoutMs: config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    stallTimeoutMs: config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-chatgpt-web: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  const options = (): ChatGptWebConnectionOptions => resolveAdapterOptions(config)
  options()

  const adapter = new ChatGptWebAdapter({ options })
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  void registration
  // Release the owned browser with the calling fiber (same pattern as the
  // persistent-bash providers): HMR/reload/unload never strands Chromium.
  ctx.effect(() => () => {
    void adapter.dispose().catch(() => {})
  })
}
