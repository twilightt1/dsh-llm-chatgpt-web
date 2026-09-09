/**
 * Managed browser attachment for ChatGPT turns: connects to the shared
 * daemon browser, owns one context per adapter lifetime and one FRESH page
 * per turn.
 *
 * Login model: the first run with no saved session opens a headed window at
 * chatgpt.com where the user signs in manually; the verified session is
 * saved and all later turns attach to the daemon. No launcher app, no
 * copied profiles. The daemon (not this process) owns hiding and
 * minimization, so turns never flash a window after the daemon's birth.
 *
 * Session freshness (ported from upstream browser-worker): after EVERY
 * successful turn the context storageState is atomically persisted back to
 * the profile — ChatGPT rotates session tokens continuously, so a state
 * captured only at login goes stale mid-flight.
 *
 * Page lifecycle (ported from upstream pageForNewTurn): each turn owns a
 * fresh page; reusing one SPA page across turns retains the previous
 * transcript and autocomplete DOM, which breaks assistant-turn indexing.
 * The adapter closes the page after the turn.
 * @module dsh-llm-chatgpt-web/chatgpt-browser
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ensureDaemonBrowser, touchEndpoint } from './daemon.ts'
import { STEALTH_ARGS, STEALTH_IGNORE_DEFAULT_ARGS, STEALTH_INIT_SCRIPT } from './launch.ts'
import { assertAuthenticatedChatGptPage } from './session.ts'

export interface ChatGptBrowserOptions {
  profileDir: string
  /** Explicit executable for the daemon; `undefined` means bundled Chromium. */
  chromeExecutablePath: string | undefined
  headed: boolean
  /** Headed but hidden (daemon birth); login window always stays on-screen. */
  offscreen: boolean
  loginTimeoutMs: number
  /** Daemon idle shutdown; the daemon exits untouched this long. */
  daemonIdleMs: number
}

function storageStatePath(profileDir: string): string {
  return join(profileDir, 'storage-state.json')
}

/** Atomic write: temp file + rename, so a crash never truncates the state. */
function persistStorageState(profileDir: string, state: unknown): void {
  const path = storageStatePath(profileDir)
  const temp = `${path}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    console.log(
      `[dsh-llm-chatgpt-web] storageState persist failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Open a page, reconnecting once and re-reading the replacement context. */
export async function openNewPageWithReconnect(
  currentContext: () => BrowserContext | undefined,
  reconnect: () => Promise<void>,
): Promise<Page> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context = currentContext()
    if (!context) throw new LlmError('ChatGPT Web browser is not ready.', 'TRANSPORT')
    try {
      return await context.newPage()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const connectionDropped = /browser closed|connection closed|context closed|target closed|session closed/i.test(message)
      if (!connectionDropped || attempt > 0) {
        throw new LlmError(
          `ChatGPT Web browser page could not be opened (${message}).`,
          'TRANSPORT',
          { cause: error },
        )
      }
      await reconnect()
    }
  }
  throw new LlmError('ChatGPT Web browser page could not be opened.', 'TRANSPORT')
}

/**
 * One daemon attachment for the adapter's lifetime. Turns are serialized by
 * the caller; each turn gets a FRESH page in the shared context and closes
 * it when done.
 *
 * Never closes the shared browser: `close()` releases only this attachment's
 * context. The daemon reaps itself after `daemonIdleMs` without turns.
 */
export class ChatGptBrowser {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private capabilitiesProbed = false
  private loginPromise: Promise<void> | undefined

  constructor(private readonly options: ChatGptBrowserOptions) {}

  /** Connect (spawning the daemon on first use) and guarantee a login session. */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.browser && this.context) {
      if (this.browser.isConnected()) return
      console.log('[dsh-llm-chatgpt-web] daemon connection dead; reattaching')
      this.context = undefined
      this.browser = undefined
      this.capabilitiesProbed = false
    }
    mkdirSync(this.options.profileDir, { recursive: true, mode: 0o700 })
    if (!existsSync(storageStatePath(this.options.profileDir))) {
      await this.loginOnce(signal)
    }
    this.browser = await ensureDaemonBrowser(this.options.profileDir, {
      idleMs: this.options.daemonIdleMs,
      executable: this.options.chromeExecutablePath,
      headless: !this.options.headed,
    })
    this.context = await this.browser.newContext({
      storageState: storageStatePath(this.options.profileDir),
    })
    await this.context.addInitScript({ content: STEALTH_INIT_SCRIPT })
  }

  /** Whether the account probe already ran on this attachment. */
  get probed(): boolean {
    return this.capabilitiesProbed
  }

  markProbed(): void {
    this.capabilitiesProbed = true
  }

  /**
   * Open a FRESH page for one turn (upstream pageForNewTurn: a reused SPA
   * page retains the previous transcript and autocomplete DOM). The caller
   * closes it. Self-healing: if the daemon connection dropped between turns
   * (idle exit raced a connect, machine sleep, crash), one reconnect
   * attempt runs before surfacing the error.
   */
  async newTurnPage(): Promise<Page> {
    touchEndpoint(this.options.profileDir)
    return openNewPageWithReconnect(
      () => this.context,
      async () => {
        // The daemon died between connect and use. Reset the attachment and
        // reconnect (spawning a fresh daemon when needed).
        console.log('[dsh-llm-chatgpt-web] daemon connection lost; reconnecting')
        this.context = undefined
        this.browser = undefined
        this.capabilitiesProbed = false
        await this.ensureReady()
      },
    )
  }

  /**
   * Persist the session after a completed turn (upstream does this after
   * every managed-chrome turn): ChatGPT rotates session tokens, and the
   * daemon keeps living cookies fresher than the login-time snapshot.
   * Best-effort — a failed persist never fails the turn.
   */
  async persistSession(): Promise<void> {
    if (!this.context) return
    try {
      const state = await this.context.storageState()
      persistStorageState(this.options.profileDir, state)
    } catch (error) {
      console.log(
        `[dsh-llm-chatgpt-web] storageState read failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async close(): Promise<void> {
    // Best-effort final persist before releasing the context.
    await this.persistSession().catch(() => {})
    await this.context?.close().catch(() => {})
    this.context = undefined
    this.capabilitiesProbed = false
    // Detach from the shared daemon WITHOUT closing it: browser.close()
    // would terminate the shared browser for everyone. The internal
    // connection close only drops our socket (verified: process exits
    // cleanly, daemon keeps serving).
    const browser = this.browser
    this.browser = undefined
    if (browser) {
      try {
        const internal = browser as unknown as { _connection?: { close?: () => Promise<void> } }
        await internal._connection?.close?.()
      } catch { /* process exit reaps the socket */ }
    }
  }

  /**
   * Headed manual sign-in: opens chatgpt.com, waits for the composer (proof
   * the user finished signing in), saves the session, closes. Concurrent
   * callers share one login window.
   */
  private loginOnce(signal?: AbortSignal): Promise<void> {
    this.loginPromise ??= (async () => {
      if (signal?.aborted) {
        throw new LlmError('ChatGPT Web login aborted by caller.', 'ABORTED')
      }
      console.log(
        `[dsh-llm-chatgpt-web] no saved session — opening ${this.options.chromeExecutablePath ?? 'bundled Chromium'} for manual sign-in`,
      )
      const loginBrowser = await chromium.launch({
        ...this.options.chromeExecutablePath !== undefined
          ? { executablePath: this.options.chromeExecutablePath }
          : {},
        headless: false,
        args: [...STEALTH_ARGS],
        ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
      })
      try {
        const context = await loginBrowser.newContext()
        await context.addInitScript({ content: STEALTH_INIT_SCRIPT })
        const page = await context.newPage()
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
        // The user signs in inside this owned window; nothing is copied
        // between browsers. The composer proves the session is live.
        const deadline = Date.now() + this.options.loginTimeoutMs
        for (;;) {
          if (signal?.aborted) throw new LlmError('ChatGPT Web login aborted by caller.', 'ABORTED')
          if (page.isClosed()) {
            throw new LlmError('ChatGPT Web login window was closed before sign-in completed.', 'ABORTED')
          }
          try {
            await assertAuthenticatedChatGptPage(page)
            break
          } catch {
            if (Date.now() >= deadline) {
              throw new LlmError(
                'ChatGPT Web sign-in timed out waiting for the composer. Sign in inside the opened window and retry.',
                'TIMEOUT',
              )
            }
            await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000))
          }
        }
        await context.storageState({ path: storageStatePath(this.options.profileDir) })
        await context.close()
      } finally {
        await loginBrowser.close().catch(() => {})
      }
    })()
    const shared = this.loginPromise
    void shared.catch(() => {
      if (this.loginPromise === shared) this.loginPromise = undefined
    })
    return shared
  }
}
