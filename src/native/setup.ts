import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertPrivateDirectory, assertPrivateRegularFile, atomicWritePrivateFile, ensurePrivateDirectory, snapshotPrivateFile } from './private-files.ts'
import {
  defaultManagedRuntimePaths,
  ensureManagedRuntimeDirectories,
  loadManagedNativeRuntimeConfig,
  MANAGED_TUNNEL_CLIENT_VERSION,
  parseManagedNativeRuntimeConfig,
} from './runtime-config.ts'
import type { ManagedNativeRuntimeConfig } from './runtime-config.ts'
import type { CommandRunner } from './process.ts'
import {
  stageTunnelClient,
} from './tunnel-install.ts'
import type { TunnelInstallTransaction } from './tunnel-install.ts'
import {
  ManagedTunnelRuntime,
  redactTunnelDetail,
} from './tunnel-runtime.ts'
import type { TunnelRuntimeStatus } from './tunnel-runtime.ts'

const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/
const CONNECTOR_NAME_MAX = 80
const PROFILE_NAME = 'dsh-chatgpt-web'
const SETUP_PROFILE_NAME = 'dsh-chatgpt-web-setup'
const DEFAULT_BROKER_SOCKET_NAME = 'native-broker.sock'
const SHA256 = /^[a-f0-9]{64}$/
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/

export interface NativeSetupOptions {
  readonly profileDir: string
  readonly connectorName: string
  readonly tunnelId: string
  readonly runtimeKeyFile?: string
  readonly runtimeKeyValue?: string
}

export interface NativeSetupResult {
  readonly configPath: string
  readonly connectorName: string
  readonly tunnelReady: true
  readonly connectorSetupRequired: true
  readonly sourceKeyRetained: boolean
}

type ManagedRuntimeFactory = (
  options: ConstructorParameters<typeof ManagedTunnelRuntime>[0],
) => Pick<ManagedTunnelRuntime, 'start' | 'stop'>

export interface NativeSetupDependencies {
  readonly stageTunnelClient?: typeof stageTunnelClient
  readonly createRuntime?: ManagedRuntimeFactory
  readonly nodeExecutable?: string
  readonly mcpEntrypoint?: string
  readonly run?: CommandRunner
}

export interface NativeSetupInput {
  readonly isTTY: boolean | undefined
  setRawMode?(mode: boolean): unknown
  resume(): void
  pause(): void
  on(event: 'data', listener: (chunk: Buffer | string) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  removeListener(event: 'data' | 'error', listener: (...args: never[]) => void): this
}

export interface NativeSetupIo {
  readonly stdin: NativeSetupInput
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

export type ParsedNativeSetupCommand =
  | { readonly command: 'setup'; readonly options: NativeSetupOptions }
  | { readonly command: 'doctor'; readonly profileDir: string; readonly connectorName: string; readonly json: boolean }
  | { readonly command: 'stop'; readonly profileDir: string; readonly connectorName: string }
  | { readonly command: 'approve'; readonly profileDir: string; readonly challengeId: string }

function expandHome(value: string): string {
  if (value === '~' || value.startsWith('~/')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.'
    return home + value.slice(1)
  }
  return value
}

function requiredOption(args: readonly string[], index: number, flag: string): { value: string; next: number } {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return { value, next: index + 2 }
}

function connectorName(value: string): string {
  if (value.length === 0 || value.trim() !== value || value.length > CONNECTOR_NAME_MAX || /[\r\n\u0000]/.test(value)) {
    throw new Error('connector name is invalid')
  }
  return value
}

function profilePath(value: string): string {
  const expanded = expandHome(value)
  if (!isAbsolute(expanded)) throw new Error('profile directory must be an absolute path')
  return resolve(expanded)
}

function tunnelId(value: string): string {
  if (!TUNNEL_ID.test(value)) throw new Error('Tunnel ID is invalid')
  return value
}

function parseCommandOptions(
  args: readonly string[],
  command: 'setup' | 'doctor' | 'stop' | 'approve',
): ParsedNativeSetupCommand {
  let profileDir: string | undefined
  let name: string | undefined
  let id: string | undefined
  let keyFile: string | undefined
  let challenge: string | undefined
  let json = false
  const seen = new Set<string>()
  let index = 1
  while (index < args.length) {
    const flag = args[index]
    if (flag === undefined) break
    if (flag === '--json' && command === 'doctor') {
      if (seen.has(flag)) throw new Error(`duplicate option ${flag}`)
      seen.add(flag)
      json = true
      index += 1
      continue
    }
    if (flag === '--challenge') {
      if (command !== 'approve') throw new Error(`${command} does not accept ${flag}`)
      if (seen.has(flag)) throw new Error(`duplicate option ${flag}`)
      seen.add(flag)
      const option = requiredOption(args, index, flag)
      challenge = option.value
      index = option.next
      continue
    }
    if (flag === '--profile-dir' || flag === '--connector-name' || flag === '--tunnel-id' || flag === '--runtime-key-file') {
      if (command === 'approve' && flag !== '--profile-dir') throw new Error(`${command} does not accept ${flag}`)
      if (seen.has(flag)) throw new Error(`duplicate option ${flag}`)
      seen.add(flag)
      const option = requiredOption(args, index, flag)
      if (flag === '--profile-dir') profileDir = option.value
      else if (flag === '--connector-name') name = option.value
      else if (flag === '--tunnel-id') id = option.value
      else keyFile = option.value
      index = option.next
      continue
    }
    throw new Error(`unknown option ${flag}`)
  }
  if (profileDir === undefined) throw new Error('--profile-dir is required')
  if (command === 'approve') {
    if (challenge === undefined || challenge.length === 0 || challenge.length > 128 || CONTROL_BYTES.test(challenge)) {
      throw new Error('--challenge is required and must be control-free')
    }
    if (name !== undefined || id !== undefined || keyFile !== undefined || json) {
      throw new Error('approve accepts only --profile-dir and --challenge')
    }
    return { command, profileDir: profilePath(profileDir), challengeId: challenge }
  }
  if (name === undefined) throw new Error('--connector-name is required')
  if (command === 'setup') {
    if (id === undefined) throw new Error('--tunnel-id is required')
    return {
      command,
      options: {
        profileDir: profilePath(profileDir),
        connectorName: connectorName(name),
        tunnelId: tunnelId(id),
        ...(keyFile === undefined ? {} : { runtimeKeyFile: profilePath(keyFile) }),
      },
    }
  }
  if (id !== undefined || keyFile !== undefined) {
    throw new Error(`${command} does not accept tunnel or key options`)
  }
  return {
    command,
    profileDir: profilePath(profileDir),
    connectorName: connectorName(name),
    ...(command === 'doctor' ? { json } : {}),
  } as ParsedNativeSetupCommand
}

export function parseNativeSetupArgs(args: readonly string[]): ParsedNativeSetupCommand {
  const command = args[0]
  if (command !== 'setup' && command !== 'doctor' && command !== 'stop' && command !== 'approve') {
    throw new Error('command must be setup, doctor, stop, or approve')
  }
  return parseCommandOptions(args, command)
}

function normalizeKeyBytes(value: Uint8Array): Uint8Array {
  let end = value.byteLength
  while (end > 0 && value[end - 1] === 0x0a) end -= 1
  if (end > 0 && value[end - 1] === 0x0d) end -= 1
  const bytes = value.slice(0, end)
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new Error('runtime key is empty or unexpectedly large')
  }
  return bytes
}

function readRuntimeKey(options: NativeSetupOptions): { bytes: Uint8Array; sourceKeyRetained: boolean } {
  if (options.runtimeKeyFile !== undefined && options.runtimeKeyValue !== undefined) {
    throw new Error('provide either runtimeKeyFile or runtimeKeyValue, not both')
  }
  if (options.runtimeKeyValue !== undefined) {
    return { bytes: normalizeKeyBytes(new TextEncoder().encode(options.runtimeKeyValue)), sourceKeyRetained: false }
  }
  if (options.runtimeKeyFile === undefined) throw new Error('a runtime key file or value is required')
  const source = profilePath(options.runtimeKeyFile)
  assertPrivateRegularFile(source, 'source runtime key')
  return { bytes: normalizeKeyBytes(new Uint8Array(readFileSync(source))), sourceKeyRetained: true }
}

function resolveMcpEntrypoint(explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error('MCP entrypoint must be absolute')
    return explicit
  }
  const current = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(current, 'mcp-main.js'), join(current, '../../lib/mcp-main.js')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error('built lib/mcp-main.js is missing; run pnpm build first')
  return found
}

function runtimeConfig(
  options: {
    connectorName: string
    tunnelId: string
    binaryPath: string
    binarySha256: string
    runtimeKeyFile: string
    profileDir: string
    profileName: string
    alias: string
  },
): ManagedNativeRuntimeConfig {
  return parseManagedNativeRuntimeConfig({
    version: 1,
    connectorName: options.connectorName,
    tunnelClient: {
      path: options.binaryPath,
      version: MANAGED_TUNNEL_CLIENT_VERSION,
      sha256: options.binarySha256,
    },
    tunnel: {
      id: options.tunnelId,
      runtimeKeyFile: options.runtimeKeyFile,
      profileDir: options.profileDir,
      profileName: options.profileName,
      alias: options.alias,
    },
  })
}

function setupBrokerSocket(profileDir: string): string {
  return join(profileDir, DEFAULT_BROKER_SOCKET_NAME)
}

function createRuntime(
  dependencies: NativeSetupDependencies,
  config: ManagedNativeRuntimeConfig,
  brokerSocketPath: string,
  mcpEntrypoint: string,
): Pick<ManagedTunnelRuntime, 'start' | 'stop'> {
  const factory = dependencies.createRuntime ?? (options => new ManagedTunnelRuntime(options))
  return factory({
    config,
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    mcpEntrypoint,
    brokerSocketPath,
    ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function setupManagedNativeRuntime(
  options: NativeSetupOptions,
  dependencies: NativeSetupDependencies = {},
): Promise<NativeSetupResult> {
  const profileDir = profilePath(options.profileDir)
  const name = connectorName(options.connectorName)
  const id = tunnelId(options.tunnelId)
  const paths = ensureManagedRuntimeDirectories(profileDir)
  const key = readRuntimeKey(options)
  const stage = dependencies.stageTunnelClient ?? stageTunnelClient
  const mcpEntrypoint = resolveMcpEntrypoint(dependencies.mcpEntrypoint)
  const brokerSocketPath = setupBrokerSocket(profileDir)

  let transaction: TunnelInstallTransaction | undefined
  let keySnapshot: ReturnType<typeof snapshotPrivateFile> | undefined
  let configSnapshot: ReturnType<typeof snapshotPrivateFile> | undefined
  let profileSnapshot: ReturnType<typeof snapshotPrivateFile> | undefined
  let temporaryRuntime: Pick<ManagedTunnelRuntime, 'start' | 'stop'> | undefined
  let finalRuntime: Pick<ManagedTunnelRuntime, 'start' | 'stop'> | undefined
  let temporaryProfileDir: string | undefined

  try {
    transaction = await stage({
      binaryPath: paths.binaryPath,
      manifestPath: paths.manifestPath,
      ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
    })
    keySnapshot = snapshotPrivateFile(paths.keyPath)
    configSnapshot = snapshotPrivateFile(paths.configPath)
    const provisionalProfile = join(paths.tunnelProfileDir, `${PROFILE_NAME}.yaml`)
    profileSnapshot = snapshotPrivateFile(provisionalProfile)
    atomicWritePrivateFile(paths.keyPath, key.bytes)

    temporaryProfileDir = join(paths.tunnelProfileDir, `.setup-${process.pid}-${randomUUID()}`)
    ensurePrivateDirectory(temporaryProfileDir)
    const temporaryConfig = runtimeConfig({
      connectorName: name,
      tunnelId: id,
      binaryPath: transaction.candidatePath,
      binarySha256: transaction.manifest.binarySha256,
      runtimeKeyFile: paths.keyPath,
      profileDir: temporaryProfileDir,
      profileName: SETUP_PROFILE_NAME,
      alias: SETUP_PROFILE_NAME,
    })
    temporaryRuntime = createRuntime(dependencies, temporaryConfig, brokerSocketPath, mcpEntrypoint)
    await temporaryRuntime.start()
    await temporaryRuntime.stop()

    transaction.commit()
    const finalConfig = runtimeConfig({
      connectorName: name,
      tunnelId: id,
      binaryPath: paths.binaryPath,
      binarySha256: transaction.manifest.binarySha256,
      runtimeKeyFile: paths.keyPath,
      profileDir: paths.tunnelProfileDir,
      profileName: PROFILE_NAME,
      alias: PROFILE_NAME,
    })
    finalRuntime = createRuntime(dependencies, finalConfig, brokerSocketPath, mcpEntrypoint)
    await finalRuntime.start()
    await finalRuntime.stop()
    atomicWritePrivateFile(paths.configPath, `${JSON.stringify(finalConfig, null, 2)}\n`)

    transaction.finalize()
    keySnapshot.discard()
    configSnapshot.discard()
    profileSnapshot.discard()
    if (temporaryProfileDir !== undefined) rmSync(temporaryProfileDir, { recursive: true, force: true })
    return {
      configPath: paths.configPath,
      connectorName: name,
      tunnelReady: true,
      connectorSetupRequired: true,
      sourceKeyRetained: key.sourceKeyRetained,
    }
  } catch (error) {
    try { await finalRuntime?.stop() } catch { /* cleanup is best effort */ }
    try { await temporaryRuntime?.stop() } catch { /* cleanup is best effort */ }
    try { configSnapshot?.restore() } catch { /* preserve the original failure */ }
    try { keySnapshot?.restore() } catch { /* preserve the original failure */ }
    try { profileSnapshot?.restore() } catch { /* preserve the original failure */ }
    try { transaction?.rollback() } catch { /* preserve the original failure */ }
    if (temporaryProfileDir !== undefined) rmSync(temporaryProfileDir, { recursive: true, force: true })
    throw new Error(`managed native setup failed: ${redactTunnelDetail(errorMessage(error))}`)
  }
}

function pathExistsOrSymlink(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    return true
  }
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function validateManifest(path: string, expectedHash: string): void {
  assertPrivateRegularFile(path, 'managed tunnel-client manifest')
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('manifest is not an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.tunnelClientVersion !== MANAGED_TUNNEL_CLIENT_VERSION) throw new Error('manifest version is invalid')
  if (typeof record.archiveSha256 !== 'string' || !SHA256.test(record.archiveSha256)) throw new Error('manifest archive hash is invalid')
  if (record.binarySha256 !== expectedHash) throw new Error('manifest binary hash does not match runtime config')
}

function brokerState(path: string): 'ready' | 'stopped' | 'invalid' {
  if (!pathExistsOrSymlink(path)) return 'stopped'
  try {
    const stat = lstatSync(path)
    if (!stat.isSocket()) return 'invalid'
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return 'invalid'
    if ((stat.mode & 0o777) !== 0o600) return 'invalid'
    return 'ready'
  } catch {
    return 'invalid'
  }
}

export interface NativeDoctorReport {
  readonly ok: boolean
  readonly config: 'ok' | 'missing' | 'invalid'
  readonly binary: 'ok' | 'missing' | 'invalid'
  readonly key: 'ok' | 'missing' | 'invalid'
  readonly profile: 'ok' | 'missing'
  readonly runtime: TunnelRuntimeStatus | { readonly state: 'stopped' }
  readonly broker: 'ready' | 'stopped' | 'invalid'
  readonly issues: readonly string[]
}

export function doctorManagedNativeRuntime(options: {
  readonly profileDir: string
  readonly connectorName: string
  readonly brokerSocketPath?: string
}): NativeDoctorReport {
  const issues: string[] = []
  let profileDir: string
  try {
    profileDir = profilePath(options.profileDir)
  } catch {
    return {
      ok: false,
      config: 'invalid',
      binary: 'missing',
      key: 'missing',
      profile: 'missing',
      runtime: { state: 'stopped' },
      broker: 'invalid',
      issues: ['profile directory is invalid'],
    }
  }
  const paths = defaultManagedRuntimePaths(profileDir)
  const configPath = paths.configPath
  let config: ManagedNativeRuntimeConfig | undefined
  let configStatus: NativeDoctorReport['config'] = 'missing'
  if (!pathExistsOrSymlink(configPath)) {
    issues.push('managed runtime config is missing')
  } else {
    try {
      assertPrivateRegularFile(configPath, 'managed runtime config')
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      const candidate = parseManagedNativeRuntimeConfig(parsed)
      if (candidate.connectorName !== options.connectorName) throw new Error('connector name mismatch')
      config = candidate
      configStatus = 'ok'
    } catch {
      configStatus = 'invalid'
      issues.push('managed runtime config is invalid')
    }
  }

  let binary: NativeDoctorReport['binary'] = 'missing'
  let key: NativeDoctorReport['key'] = 'missing'
  let profile: NativeDoctorReport['profile'] = 'missing'
  let runtime: TunnelRuntimeStatus | { readonly state: 'stopped' } = { state: 'stopped' }
  if (config !== undefined) {
    try {
      assertPrivateRegularFile(config.tunnelClient.path, 'managed tunnel client', true)
      if (digestFile(config.tunnelClient.path) !== config.tunnelClient.sha256) throw new Error('binary hash mismatch')
      validateManifest(join(dirname(config.tunnelClient.path), 'tunnel-client-manifest.json'), config.tunnelClient.sha256)
      binary = 'ok'
    } catch {
      binary = pathExistsOrSymlink(config.tunnelClient.path) ? 'invalid' : 'missing'
      issues.push(binary === 'missing' ? 'managed tunnel client is missing' : 'managed tunnel client is invalid')
    }
    try {
      assertPrivateRegularFile(config.tunnel.runtimeKeyFile, 'managed runtime key')
      key = 'ok'
    } catch {
      key = pathExistsOrSymlink(config.tunnel.runtimeKeyFile) ? 'invalid' : 'missing'
      issues.push(key === 'missing' ? 'managed runtime key is missing' : 'managed runtime key is invalid')
    }
    try {
      assertPrivateDirectory(config.tunnel.profileDir, 'managed tunnel profile directory')
      profile = 'ok'
    } catch {
      issues.push('managed tunnel profile directory is missing or invalid')
    }
    if (binary === 'ok' && key === 'ok' && profile === 'ok') {
      try {
        const runtimeObject = new ManagedTunnelRuntime({
          config,
          nodeExecutable: process.execPath,
          mcpEntrypoint: resolveMcpEntrypoint(undefined),
          brokerSocketPath: options.brokerSocketPath ?? setupBrokerSocket(profileDir),
        })
        runtime = runtimeObject.status()
        if (!runtime.ok) issues.push('managed tunnel is stopped or not ready')
      } catch {
        issues.push('managed tunnel status is unavailable')
      }
    }
  }
  const broker = brokerState(options.brokerSocketPath ?? setupBrokerSocket(profileDir))
  if (broker === 'invalid') issues.push('broker socket is invalid')
  const staticOk = configStatus === 'ok' && binary === 'ok' && key === 'ok' && profile === 'ok'
  return {
    ok: staticOk,
    config: configStatus,
    binary,
    key,
    profile,
    runtime,
    broker,
    issues,
  }
}

export async function stopManagedNativeRuntime(options: {
  readonly profileDir: string
  readonly connectorName: string
}): Promise<void> {
  const profileDir = profilePath(options.profileDir)
  const configPath = defaultManagedRuntimePaths(profileDir).configPath
  if (!pathExistsOrSymlink(configPath)) return
  const config = loadManagedNativeRuntimeConfig(configPath, { connectorName: options.connectorName })
  const runtime = new ManagedTunnelRuntime({
    config,
    nodeExecutable: process.execPath,
    mcpEntrypoint: resolveMcpEntrypoint(undefined),
    brokerSocketPath: setupBrokerSocket(profileDir),
  })
  await runtime.stop()
}

export function formatNativeDoctorReport(report: NativeDoctorReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`
  return [
    `managed native runtime: ${report.ok ? 'ok' : 'not ready'}`,
    `config=${report.config} binary=${report.binary} key=${report.key} profile=${report.profile}`,
    `runtime=${'ok' in report.runtime ? report.runtime.ok ? 'ready' : 'not-ready' : report.runtime.state}`,
    `broker=${report.broker}`,
    ...report.issues.map(issue => `issue: ${issue}`),
  ].join('\n') + '\n'
}
