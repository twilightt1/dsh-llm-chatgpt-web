/**
 * Shared Chromium launch knowledge: stealth flags, executable resolution,
 * macOS hide, and window minimization. Used by the in-process browser owner
 * and the standalone daemon alike.
 * @module dsh-llm-chatgpt-web/chatgpt-launch
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser } from 'playwright-core'

/**
 * Launch hardening against bot gates (Cloudflare loops when `navigator.webdriver`
 * or `--enable-automation` leak through). Human input stays human: the user
 * still clicks and types everything themselves.
 */
export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
]
export const STEALTH_IGNORE_DEFAULT_ARGS = ['--enable-automation']
export const STEALTH_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}
  try {
    if (!window.chrome) window.chrome = { runtime: {} };
  } catch {}
})()`
/** Off-screen placement for headed turns (macOS clamps it; CDP minimize is the real cover). */
export const OFFSCREEN_ARGS = ['--window-position=-32000,-32000', '--window-size=1280,900']
/** No window at launch: first tab creates it, minimized within milliseconds. */
export const NO_STARTUP_WINDOW_ARGS = ['--no-startup-window']
/** Marker flag identifying daemon-owned browser processes for safe reaping. */
export const DAEMON_MARKER_ARG = '--dsh-chatgpt-web-daemon'

/** Resolve the system Chrome executable, mirroring upstream conventions. */
export function defaultChromeExecutable(
  platform: string = process.platform,
  programFiles: string | undefined = process.env['PROGRAMFILES'],
): string {
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  if (platform === 'win32') {
    return join(programFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
  }
  return '/usr/bin/google-chrome'
}

const BRAVE_MACOS_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

/**
 * Resolve the executable: explicit config, env, conventional paths, Brave on
 * macOS, else `undefined` (Playwright's bundled Chromium).
 */
export function resolveChromeExecutable(configured?: string): string | undefined {
  if (configured && configured.length > 0) return configured
  if (process.env['CHROME_EXECUTABLE_PATH']) return process.env['CHROME_EXECUTABLE_PATH']
  const conventional = defaultChromeExecutable()
  if (existsSync(conventional)) return conventional
  if (process.platform === 'darwin' && existsSync(BRAVE_MACOS_PATH)) return BRAVE_MACOS_PATH
  return undefined
}

/** Default profile home: login session + diagnostics live here (0600-style privacy). */
export function defaultProfileDir(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.'
  return join(home, '.dsh-chatgpt-web')
}

/**
 * Best-effort macOS hide of an exact PID. Never fatal; denial or failure
 * silently falls back to CDP minimize.
 */
export async function hideProcess(pid: number | undefined): Promise<void> {
  if (process.platform !== 'darwin' || pid === undefined) return
  await new Promise<void>((resolve) => {
    const script = `try\ntell application "System Events" to set visible of (first process whose unix id is ${pid}) to false\nend try`
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5_000 }, (error) => {
      console.log(
        `[dsh-llm-chatgpt-web] hide pid=${pid} ${error ? `failed: ${String(error).split('\n')[0]}` : 'ok'}`,
      )
      resolve()
    })
  })
}

/** Minimize every page window on a connected browser; logs the count. */
export async function minimizeAllWindows(browser: Browser, reason: string): Promise<void> {
  const session = await browser.newBrowserCDPSession()
  try {
    const { targetInfos } = await session.send('Target.getTargets')
    const pages = targetInfos.filter((target: { type: string }) => target.type === 'page')
    for (const pageTarget of pages) {
      const { windowId } = await session.send('Browser.getWindowForTarget', {
        targetId: pageTarget.targetId,
      })
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      })
    }
    console.log(`[dsh-llm-chatgpt-web] minimize (${reason}): windows=${pages.length}`)
  } finally {
    await session.detach().catch(() => {})
  }
}

/**
 * Resize every page window while keeping it minimized. Used at daemon birth:
 * the window opens at 1x1 (any first paint is a single dot) and grows only
 * after it is hidden+minimized, so no full-size flash ever reaches the user.
 * Size travels alone: CDP rejects combining minimized/maximized/fullscreen
 * with width/height in one call.
 */
export async function resizeWindowsMinimized(
  browser: Browser,
  reason: string,
  width: number,
  height: number,
): Promise<void> {
  const session = await browser.newBrowserCDPSession()
  try {
    const { targetInfos } = await session.send('Target.getTargets')
    const pages = targetInfos.filter((target: { type: string }) => target.type === 'page')
    for (const pageTarget of pages) {
      const { windowId } = await session.send('Browser.getWindowForTarget', {
        targetId: pageTarget.targetId,
      })
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width, height },
      })
    }
    console.log(`[dsh-llm-chatgpt-web] resize-minimized (${reason}): windows=${pages.length} ${width}x${height}`)
  } finally {
    await session.detach().catch(() => {})
  }
}
