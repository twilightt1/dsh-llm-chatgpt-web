/**
 * Daemon client: connect to the shared browser daemon, spawning it detached
 * on first use. Staleness is proven by failed connect, never by PID guess;
 * orphaned browsers are reaped only after their command line proves the
 * daemon marker flag.
 * @module dsh-llm-chatgpt-web/chatgpt-daemon
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DAEMON_MARKER_ARG } from './launch.ts'

/** Endpoint file payload: how adapters find and validate a daemon. */
export interface DaemonEndpoint {
  wsEndpoint: string
  daemonPid: number
  browserPid: number | undefined
  startedAt: string
}

export function endpointPath(profileDir: string): string {
  return join(profileDir, 'browser-endpoint.json')
}

/** Accept only loopback WebSocket endpoints (never a remote URL). Exported for tests. */
export function isLoopbackEndpoint(wsEndpoint: string): boolean {
  if (!wsEndpoint.startsWith('ws://')) return false
  const rest = wsEndpoint.slice('ws://'.length)
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) return false
    // Reject `[::1]evil.com` smuggling: only :port or /path may follow ']'.
    const next = rest[end + 1]
    if (next !== undefined && next !== ':' && next !== '/') return false
    return rest.slice(0, end + 1) === '[::1]'
  }
  const host = rest.split(/[/:]/)[0]
  return host === '127.0.0.1' || host === 'localhost'
}

function readEndpoint(profileDir: string): DaemonEndpoint | undefined {
  const path = endpointPath(profileDir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonEndpoint>
    if (typeof parsed['wsEndpoint'] !== 'string' || !isLoopbackEndpoint(parsed['wsEndpoint'])) {
      return undefined
    }
    return parsed as DaemonEndpoint
  } catch {
    return undefined
  }
}

/** Touch the endpoint file: the daemon's idle clock. */
export function touchEndpoint(profileDir: string): void {
  try {
    utimesSync(endpointPath(profileDir), new Date(), new Date())
  } catch { /* best-effort */ }
}

/** True when the PID is alive AND its command line carries our marker. */
function isOurDaemonBrowser(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'args='], (error, stdout) => {
      if (error) return resolve(false)
      resolve(stdout.includes(DAEMON_MARKER_ARG))
    })
  })
}

async function reapStaleBrowser(endpoint: DaemonEndpoint): Promise<void> {
  if (typeof endpoint.browserPid !== 'number') return
  try {
    if (await isOurDaemonBrowser(endpoint.browserPid)) {
      process.kill(endpoint.browserPid, 'SIGTERM')
    }
  } catch { /* already gone or unkillable */ }
}

function resolveTsxLoader(): string {
  try {
    return fileURLToPath(import.meta.resolve('tsx/esm'))
  } catch {
    throw new LlmError(
      'ChatGPT Web daemon entry not found. Run `pnpm build` in dsh-llm-chatgpt-web first.',
      'TRANSPORT',
    )
  }
}

function daemonMainPath(): { kind: 'lib' | 'tsx'; path: string } {
  const here = dirname(fileURLToPath(import.meta.url))
  // Prefer the built entry in every layout: tsx-loaded sources hang when
  // spawned detached with ignored stdio, so the tsx path is a no-build
  // fallback only.
  const builtLayouts = [
    join(here, '..', '..', 'lib', 'chatgpt', 'daemon-main.js'), // dev: here=src/chatgpt
    join(here, 'chatgpt', 'daemon-main.js'), // bundled: here=lib
  ]
  for (const built of builtLayouts) {
    if (existsSync(built)) return { kind: 'lib', path: built }
  }
  const src = join(here, 'daemon-main.ts')
  if (existsSync(src)) return { kind: 'tsx', path: src }
  throw new LlmError(
    'ChatGPT Web daemon entry not found. Run `pnpm build` in dsh-llm-chatgpt-web first.',
    'TRANSPORT',
  )
}

async function waitForEndpoint(
  profileDir: string,
  timeoutMs: number,
  child: { exitCode: number | null; killed: boolean },
): Promise<DaemonEndpoint> {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  for (;;) {
    const endpoint = readEndpoint(profileDir)
    if (endpoint) return endpoint
    polls += 1
    if (polls % 20 === 0) {
      console.log(
        `[dsh-llm-chatgpt-web] waiting for endpoint (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`
        + ` childExit=${String(child.exitCode)} childKilled=${String(child.killed)}`
        + ` file=${existsSync(endpointPath(profileDir)) ? 'present-unreadable?' : 'absent'}`,
      )
    }
    // Fail fast when the child is already gone instead of a mystery timeout.
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new LlmError(
        `ChatGPT Web daemon exited during startup (code ${child.exitCode}). Run the daemon entry manually for its stderr.`,
        'TRANSPORT',
      )
    }
    if (Date.now() >= deadline) {
      throw new LlmError('ChatGPT Web daemon did not publish its endpoint in time.', 'TIMEOUT')
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
  }
}

/**
 * Connect to the shared daemon browser, spawning the daemon detached when
 * no live endpoint exists. Resolves with a connected browser the caller must
 * NOT close (contexts and pages are caller-owned; the daemon owns the rest).
 */
export async function ensureDaemonBrowser(
  profileDir: string,
  options: { idleMs: number; executable: string | undefined; headless: boolean; spawnTimeoutMs?: number },
): Promise<Browser> {
  const existing = readEndpoint(profileDir)
  if (existing) {
    try {
      const browser = await chromium.connect(existing.wsEndpoint, { timeout: 10_000 })
      console.log('[dsh-llm-chatgpt-web] attaching to live daemon')
      touchEndpoint(profileDir)
      return browser
    } catch {
      await reapStaleBrowser(existing)
    }
  }
  console.log('[dsh-llm-chatgpt-web] spawning browser daemon')
  const main = daemonMainPath()
  console.log(`[dsh-llm-chatgpt-web] daemon entry kind=${main.kind} path=${main.path}`)
  const daemonArgs = [
    '--profile-dir', profileDir,
    '--idle-ms', String(options.idleMs),
    ...(options.executable ? ['--executable', options.executable] : []),
  ]
  const child = main.kind === 'lib'
    ? spawn(process.execPath, [main.path, ...daemonArgs], { detached: true, stdio: 'ignore' })
    : spawn(process.execPath, ['--import', resolveTsxLoader(), main.path, ...daemonArgs], {
      detached: true,
      stdio: 'ignore',
    })
  // Fail fast on spawn errors (ENOENT etc.) instead of a mystery timeout.
  const spawnError = await new Promise<Error | undefined>((resolve) => {
    child.once('error', (error: Error) => resolve(error))
    setImmediate(() => resolve(undefined))
  })
  if (spawnError) {
    throw new LlmError(
      `ChatGPT Web daemon failed to spawn: ${spawnError.message}`,
      'TRANSPORT',
      { cause: spawnError },
    )
  }
  child.unref()
  console.log(`[dsh-llm-chatgpt-web] daemon spawned pid=${child.pid ?? 'unknown'}`)
  child.on('exit', (code, signal) => {
    console.log(`[dsh-llm-chatgpt-web] daemon child exit code=${code} signal=${signal}`)
  })
  const endpoint = await waitForEndpoint(profileDir, options.spawnTimeoutMs ?? 60_000, child)
  try {
    const browser = await chromium.connect(endpoint.wsEndpoint, { timeout: 15_000 })
    touchEndpoint(profileDir)
    return browser
  } catch (error) {
    throw new LlmError(
      'ChatGPT Web daemon started but refused connection.',
      'TRANSPORT',
      { cause: error },
    )
  }
}
