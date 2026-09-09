import type { ManagedNativeRuntimeConfig } from './runtime-config.ts'
import { runCommand } from './process.ts'
import type { CommandRunner } from './process.ts'

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const MAX_DETAIL_CHARS = 2_000

export class ManagedRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagedRuntimeConfigurationError'
  }
}

export class ManagedRuntimeTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagedRuntimeTransportError'
  }
}

export interface TunnelRuntimeStatus {
  readonly ok: boolean
  readonly processRunning: boolean
  readonly healthy: boolean
  readonly ready: boolean
  readonly state?: string
  readonly detail: string
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

export function redactTunnelDetail(value: unknown): string {
  return textValue(value)
    .replace(/tunnel_[a-f0-9]{32}/gi, '[tunnel-id]')
    .replace(/request_[A-Za-z0-9_-]{12,}/g, '[redacted-request]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/gi, 'Bearer [redacted-token]')
    .slice(0, MAX_DETAIL_CHARS)
}

function rejectNewline(value: string, label: string): void {
  if (/[\r\n\u0000]/.test(value)) throw new ManagedRuntimeConfigurationError(`${label} contains a newline or NUL byte`)
}

function shellQuote(value: string, label: string): string {
  rejectNewline(value, label)
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function tunnelCommandQuote(value: string, label: string): string {
  rejectNewline(value, label)
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function mcpCommand(options: {
  readonly nodeExecutable: string
  readonly mcpEntrypoint: string
  readonly brokerSocketPath: string
  readonly platform?: NodeJS.Platform
}): string {
  const platform = options.platform ?? process.platform
  const values = [
    options.nodeExecutable,
    options.mcpEntrypoint,
    '--broker-socket',
    options.brokerSocketPath,
  ]
  return platform === 'win32'
    ? values.map((value, index) => tunnelCommandQuote(value, `MCP command argument ${index}`)).join(' ')
    : values.map((value, index) => shellQuote(value, `MCP command argument ${index}`)).join(' ')
}

function commandOutput(stdout: string, stderr: string): string {
  return [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const nested = (value as Record<string, unknown>)[key]
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined
}

export function parseTunnelStatus(output: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return {
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      detail: redactTunnelDetail(commandOutput(output, '')) || `tunnel-client exited with status ${exitStatus}`,
    }
  }
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(output) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('status is not an object')
    parsed = value as Record<string, unknown>
  } catch {
    return {
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      detail: `tunnel-client returned non-JSON status: ${redactTunnelDetail(output)}`,
    }
  }
  const processRunning = parsed.process_running === true
  const healthy = parsed.healthy === true
  const ready = parsed.ready === true
  const state = typeof parsed.runtime_state === 'string'
    ? parsed.runtime_state
    : typeof parsed.status === 'string' ? parsed.status : undefined
  const local = nestedRecord(parsed, 'local')
  const issues = Array.isArray(local?.issues)
    ? local.issues.filter((issue): issue is string => typeof issue === 'string').slice(0, 3)
    : []
  const explicitError = typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : undefined
  const log = nestedRecord(local, 'log')
  const logTail = typeof log?.tail === 'string' && log.tail.trim().length > 0 ? log.tail.trim() : undefined
  const ok = processRunning && healthy && ready
  const detail = ok
    ? 'process_running=true healthy=true ready=true'
    : redactTunnelDetail([
      `process_running=${processRunning}`,
      `healthy=${healthy}`,
      `ready=${ready}`,
      ...(state === undefined ? [] : [`state=${state}`]),
      ...(explicitError === undefined ? [] : [explicitError]),
      ...issues,
      ...(logTail === undefined ? [] : [`runtime_log=${logTail}`]),
    ].join('; '))
  return {
    ok,
    processRunning,
    healthy,
    ready,
    ...(state === undefined ? {} : { state }),
    detail,
  }
}

function parseConnectResponse(output: string): { running: boolean; healthy: boolean; ready: boolean } {
  try {
    const parsed = JSON.parse(output) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('connect output is not an object')
    const record = parsed as Record<string, unknown>
    return {
      running: record.running === true,
      healthy: record.healthy === true,
      ready: record.ready === true,
    }
  } catch {
    throw new ManagedRuntimeTransportError(`tunnel-client returned non-JSON connect output: ${redactTunnelDetail(output)}`)
  }
}

function validateDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ManagedRuntimeConfigurationError(`${label} must be a positive safe integer no greater than 2147483647`)
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class ManagedTunnelRuntime {
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private started = false
  private stopIssued = false

  private readonly run: CommandRunner
  private readonly readyTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly command: string

  constructor(options: {
    readonly config: ManagedNativeRuntimeConfig
    readonly nodeExecutable: string
    readonly mcpEntrypoint: string
    readonly brokerSocketPath: string
    readonly run?: CommandRunner
    readonly readyTimeoutMs?: number
    readonly pollIntervalMs?: number
  }) {
    this.run = options.run ?? runCommand
    this.readyTimeoutMs = validateDuration(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 'tunnel readiness timeout')
    this.pollIntervalMs = validateDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'tunnel status poll interval')
    this.command = mcpCommand({
      nodeExecutable: options.nodeExecutable,
      mcpEntrypoint: options.mcpEntrypoint,
      brokerSocketPath: options.brokerSocketPath,
    })
    this.config = options.config
  }

  private readonly config: ManagedNativeRuntimeConfig

  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    if (this.startPromise !== undefined) return this.startPromise
    this.stopIssued = false
    const promise = this.startInternal()
    this.startPromise = promise
    void promise.then(
      () => { if (this.startPromise === promise) this.startPromise = undefined },
      () => { if (this.startPromise === promise) this.startPromise = undefined },
    )
    return promise
  }

  status(): TunnelRuntimeStatus {
    try {
      const result = this.run(
        this.config.tunnelClient.path,
        ['runtimes', 'status', this.config.tunnel.alias, '--json'],
        { timeoutMs: 10_000 },
      )
      return parseTunnelStatus(commandOutput(result.stdout, result.stderr), result.status)
    } catch (error) {
      return {
        ok: false,
        processRunning: false,
        healthy: false,
        ready: false,
        detail: redactTunnelDetail(error instanceof Error ? error.message : error),
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    if (this.stopIssued && !this.started) return Promise.resolve()
    const pendingStart = this.startPromise
    const promise = (async () => {
      if (pendingStart !== undefined) await pendingStart.catch(() => {})
      await this.stopInternal()
    })()
    this.stopPromise = promise
    void promise.then(
      () => { if (this.stopPromise === promise) this.stopPromise = undefined },
      () => { if (this.stopPromise === promise) this.stopPromise = undefined },
    )
    return promise
  }

  private async startInternal(): Promise<void> {
    try {
      const connect = this.run(
        this.config.tunnelClient.path,
        [
          'runtimes', 'connect',
          '--alias', this.config.tunnel.alias,
          '--profile', this.config.tunnel.profileName,
          '--profile-dir', this.config.tunnel.profileDir,
          '--tunnel-client-bin', this.config.tunnelClient.path,
          '--tunnel-id', this.config.tunnel.id,
          '--runtime-api-key', `file:${this.config.tunnel.runtimeKeyFile}`,
          '--mcp-command', this.command,
          '--json',
        ],
        { timeoutMs: this.readyTimeoutMs },
      )
      if (connect.status !== 0) {
        throw new ManagedRuntimeTransportError(
          `managed tunnel connect failed: ${redactTunnelDetail(commandOutput(connect.stdout, connect.stderr))}`,
        )
      }
      const launch = parseConnectResponse(commandOutput(connect.stdout, connect.stderr))
      if (!launch.running || !launch.healthy) {
        throw new ManagedRuntimeTransportError(
          `managed tunnel exited during launch: ${redactTunnelDetail(commandOutput(connect.stdout, connect.stderr))}`,
        )
      }
      const deadline = Date.now() + this.readyTimeoutMs
      let current = this.status()
      while (!current.ok && Date.now() < deadline) {
        await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())))
        current = this.status()
      }
      if (!current.ok) throw new ManagedRuntimeTransportError(`managed tunnel did not become ready: ${current.detail}`)
      this.started = true
      this.stopIssued = false
    } catch (error) {
      this.started = false
      try {
        await this.stopInternal()
      } catch {
        // Preserve the launch/readiness failure; stop remains available to the caller.
      }
      if (error instanceof ManagedRuntimeTransportError) throw error
      throw new ManagedRuntimeTransportError(
        `managed tunnel startup failed: ${redactTunnelDetail(error instanceof Error ? error.message : error)}`,
      )
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.stopIssued && !this.started) return
    this.stopIssued = true
    try {
      const result = this.run(
        this.config.tunnelClient.path,
        ['runtimes', 'stop', this.config.tunnel.alias, '--json'],
        { timeoutMs: 15_000 },
      )
      const output = commandOutput(result.stdout, result.stderr)
      if (result.status !== 0 && !/not found|not running|unknown alias|alias[^\n]{0,160}is not known/i.test(output)) {
        throw new ManagedRuntimeTransportError(`managed tunnel stop failed: ${redactTunnelDetail(output)}`)
      }
      this.started = false
    } catch (error) {
      this.stopIssued = false
      if (error instanceof ManagedRuntimeTransportError) throw error
      throw new ManagedRuntimeTransportError(
        `managed tunnel stop failed: ${redactTunnelDetail(error instanceof Error ? error.message : error)}`,
      )
    }
  }
}
