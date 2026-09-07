/**
 * Browser daemon entry: one headed-hidden Chromium per profile directory,
 * shared by every adapter process. Spawned detached by `daemon.ts`, never by
 * hand. Args: `--profile-dir <dir> --idle-ms <n> [--executable <path>]`.
 *
 * Lifecycle: launch → hide + minimize → write endpoint file (0600) → serve
 * until the endpoint file goes untouched for `idleMs` (adapters touch it per
 * turn), then exit. A stale endpoint (dead daemon) is detected client-side
 * by failed connect, never by PID guessing.
 * @module dsh-llm-chatgpt-web/daemon-main
 */

import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { endpointPath, type DaemonEndpoint } from './daemon.ts'
import {
  DAEMON_MARKER_ARG,
  NO_STARTUP_WINDOW_ARGS,
  STEALTH_ARGS,
  STEALTH_IGNORE_DEFAULT_ARGS,
  STEALTH_INIT_SCRIPT,
  hideProcess,
  minimizeAllWindows,
  resizeWindowsMinimized,
  resolveChromeExecutable,
} from './launch.ts'

function parseArgs(argv: string[]): { profileDir: string; idleMs: number; executable: string | undefined; headless: boolean } {
  let profileDir: string | undefined
  let idleMs = 30 * 60 * 1_000
  let executable: string | undefined
  let headless = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile-dir') profileDir = argv[i + 1]
    else if (arg === '--idle-ms') idleMs = Number(argv[i + 1])
    else if (arg === '--executable') executable = argv[i + 1]
    else if (arg === '--headless') headless = true
  }
  if (!profileDir) throw new Error('daemon-main: --profile-dir is required')
  if (!Number.isFinite(idleMs) || idleMs < 60_000) {
    throw new Error('daemon-main: --idle-ms must be at least 60000')
  }
  return { profileDir, idleMs, executable, headless }
}

function writeEndpoint(profileDir: string, endpoint: DaemonEndpoint): void {
  const path = endpointPath(profileDir)
  writeFileSync(path, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.profileDir, { recursive: true, mode: 0o700 })
  const executable = args.executable ?? resolveChromeExecutable()
  const server = await chromium.launchServer({
    ...(executable !== undefined ? { executablePath: executable } : {}),
    headless: args.headless,
    args: [
      ...STEALTH_ARGS,
      // Hidden-window dressing only matters headed; headless has no windows.
      // Birth at 1x1: even if a first paint slips past hide+minimize, it is
      // a single dot. Grows to working size only while minimized (below).
      ...(args.headless ? [] : ['--window-size=1,1', '--window-position=-32000,-32000', ...NO_STARTUP_WINDOW_ARGS]),
      DAEMON_MARKER_ARG,
    ],
    ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS,
  })
  const shutdown = async (): Promise<never> => {
    await server.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  // Hide the app while it cold-starts, then warm up one minimized window so
  // the very first turn never paints visibly.
  void hideProcess(server.process().pid)
  const browser = await chromium.connect(server.wsEndpoint())
  const context = await browser.newContext()
  await context.addInitScript({ content: STEALTH_INIT_SCRIPT })
  await context.newPage()
  // Creating the window unhides the app (orderFront): hide AGAIN, minimize,
  // then grow to working size while still minimized.
  await hideProcess(server.process().pid)
  await minimizeAllWindows(browser, 'daemon-birth')
  if (!args.headless) {
    await resizeWindowsMinimized(browser, 'daemon-birth', 1280, 900)
  }
  await resizeWindowsMinimized(browser, 'daemon-birth', 1280, 900)
  // The warmup page stays: it owns the one window. Turn pages open as tabs
  // in it while the daemon lives — no new windows, no flashes. The
  // self-connection is intentionally never closed.
  void browser
  void context

  writeEndpoint(args.profileDir, {
    wsEndpoint: server.wsEndpoint(),
    daemonPid: process.pid,
    browserPid: server.process().pid,
    startedAt: new Date().toISOString(),
  })
  console.log(`[dsh-llm-chatgpt-web] daemon ready pid=${process.pid}`)

  // Idle reaper: adapters touch the endpoint file per turn.
  const path = endpointPath(args.profileDir)
  const checkInterval = setInterval(() => {
    try {
      const mtime = statSync(path).mtimeMs
      if (Date.now() - mtime > args.idleMs) {
        console.log('[dsh-llm-chatgpt-web] daemon idle, exiting')
        void shutdown()
      }
    } catch {
      // Endpoint deleted externally: exit rather than serve orphaned.
      void shutdown()
    }
  }, 30_000)
  checkInterval.unref?.()
}

// Program entry: this file is only ever executed, never imported (shared
// helpers live in daemon.ts). Unconditional top-level await survives
// bundler tree-shaking, unlike a guarded call.
await main().catch((error: unknown) => {
  process.stderr.write(`daemon-main: fatal ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
