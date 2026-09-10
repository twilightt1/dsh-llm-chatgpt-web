import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  assertPrivateDirectory,
  assertPrivateRegularFile,
  atomicWritePrivateFile,
  currentProcessStartedAt,
  ensurePrivateDirectory,
  inspectPrivateWriterLease,
  snapshotPrivateFile,
} from './private-files.ts'
import { createNativeCheckpointStore } from './checkpoint.ts'
import { hashCanonical } from './canonical.ts'
import { ChatGptBrowser } from '../chatgpt/browser.ts'
import {
  createOwnedConversationLedger,
  retryPendingConversationDeletions,
} from '../chatgpt/conversation-cleanup.ts'
import {
  defaultManagedRuntimePaths,
  ensureManagedRuntimeDirectories,
  loadManagedNativeRuntimeConfig,
  MANAGED_TUNNEL_CLIENT_VERSION,
  parseManagedNativeRuntimeConfig,
} from './runtime-config.ts'
import {
  readNativeApprovalState,
  shellQuotePosix,
} from './grants.ts'
import {
  readNativeSecurityState,
  nativeSecuritySummaryHash,
  NATIVE_SECURITY_STATE_MAX_AGE_MS,
} from './security-state.ts'
import type { ManagedNativeRuntimeConfig } from './runtime-config.ts'
import type { CommandRunner } from './process.ts'
import {
  stageTunnelClient,
  tunnelReleaseAsset,
} from './tunnel-install.ts'
import type { TunnelInstallTransaction } from './tunnel-install.ts'
import type { NativeDoctorCheck, NativeDoctorReport, NativeDoctorStatus } from './types.ts'
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
  | { readonly command: 'recover'; readonly profileDir: string; readonly checkpointHash: string; readonly abandon: true }

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
  if (!isAbsolute(expanded) || CONTROL_BYTES.test(expanded)) {
    throw new Error('profile directory must be an absolute control-free path')
  }
  return resolve(expanded)
}

function tunnelId(value: string): string {
  if (!TUNNEL_ID.test(value)) throw new Error('Tunnel ID is invalid')
  return value
}

function parseCommandOptions(
  args: readonly string[],
  command: 'setup' | 'doctor' | 'stop' | 'approve' | 'recover',
): ParsedNativeSetupCommand {
  let profileDir: string | undefined
  let name: string | undefined
  let id: string | undefined
  let keyFile: string | undefined
  let challenge: string | undefined
  let checkpointHash: string | undefined
  let abandon = false
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
    if (flag === '--abandon') {
      if (command !== 'recover') throw new Error(`${command} does not accept ${flag}`)
      if (seen.has(flag)) throw new Error(`duplicate option ${flag}`)
      seen.add(flag)
      abandon = true
      index += 1
      continue
    }
    if (flag === '--checkpoint') {
      if (command !== 'recover') throw new Error(`${command} does not accept ${flag}`)
      if (seen.has(flag)) throw new Error(`duplicate option ${flag}`)
      seen.add(flag)
      const option = requiredOption(args, index, flag)
      checkpointHash = option.value
      index = option.next
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
      if ((command === 'approve' || command === 'recover') && flag !== '--profile-dir') throw new Error(`${command} does not accept ${flag}`)
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
  if (command === 'recover') {
    if (checkpointHash === undefined || !SHA256.test(checkpointHash)) {
      throw new Error('--checkpoint is required and must be a public checkpoint hash')
    }
    if (!abandon) throw new Error('recover requires --abandon')
    if (name !== undefined || id !== undefined || keyFile !== undefined || json || challenge !== undefined) {
      throw new Error('recover accepts only --profile-dir, --checkpoint, and --abandon')
    }
    return { command, profileDir: profilePath(profileDir), checkpointHash, abandon: true }
  }
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
  if (command !== 'setup' && command !== 'doctor' && command !== 'stop' && command !== 'approve' && command !== 'recover') {
    throw new Error('command must be setup, doctor, stop, approve, or recover')
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

function validateManifest(path: string, expectedHash: string, expectedAsset?: { readonly name: string; readonly archiveSha256: string }): void {
  assertPrivateRegularFile(path, 'managed tunnel-client manifest')
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('manifest is not an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.tunnelClientVersion !== MANAGED_TUNNEL_CLIENT_VERSION) throw new Error('manifest version is invalid')
  if (typeof record.asset !== 'string' || record.asset.length === 0) throw new Error('manifest asset is invalid')
  if (typeof record.archiveSha256 !== 'string' || !SHA256.test(record.archiveSha256)) throw new Error('manifest archive hash is invalid')
  if (record.binarySha256 !== expectedHash) throw new Error('manifest binary hash does not match runtime config')
  if (expectedAsset !== undefined
    && (record.asset !== expectedAsset.name || record.archiveSha256 !== expectedAsset.archiveSha256)) {
    throw new Error('manifest does not match the pinned tunnel-client release asset')
  }
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

const NATIVE_DOCTOR_CHECK_IDS = [
  'native.platform',
  'native.managed.binary',
  'native.runtime.config',
  'native.runtime.key',
  'native.runtime.profile',
  'native.connector.name',
  'native.connector.runtime',
  'native.workspace.root',
  'native.policy.schema',
  'native.policy.output-provenance',
  'native.approval.grant',
  'native.checkpoint.writer',
  'native.checkpoint.recovery',
  'native.cleanup.owned-conversations',
  'native.snapshot.freshness',
  'native.rollback.safe',
  'native.managed.process',
  'native.broker.socket',
] as const

type NativeDoctorCheckId = typeof NATIVE_DOCTOR_CHECK_IDS[number]

export type { NativeDoctorReport } from './types.ts'

function doctorCheck(
  id: NativeDoctorCheckId,
  status: NativeDoctorStatus,
  summary: string,
  action?: string,
): NativeDoctorCheck {
  return {
    id,
    status,
    summary,
    ...(action === undefined ? {} : { action }),
  }
}

function nativeAction(profileDir: string, command: string, ...argumentsValue: string[]): string | undefined {
  try {
    return [
      'dsh-chatgpt-web-native',
      command,
      '--profile-dir',
      shellQuotePosix(profileDir),
      ...argumentsValue.map(value => shellQuotePosix(value)),
    ].join(' ')
  } catch {
    return undefined
  }
}

function escapeTerminalControls(value: string): string {
  return value.replace(/[\u007f-\u009f\u2028\u2029]/g, character => (
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
  ))
}

function terminalQuote(value: string): string {
  return escapeTerminalControls(JSON.stringify(value))
}

function safeJson(value: unknown): string {
  return escapeTerminalControls(JSON.stringify(value, null, 2))
}

function processIdentityIsLive(pid: number, startedAt: string): boolean {
  if (pid === process.pid) return startedAt === currentProcessStartedAt()
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return false
  }
}

function validPathPointer(pointer: string): boolean {
  if (pointer === '') return true
  if (!pointer.startsWith('/')) return false
  for (let index = 0; index < pointer.length; index += 1) {
    if (pointer[index] === '~' && pointer[index + 1] !== '0' && pointer[index + 1] !== '1') return false
  }
  return true
}

function publicTunnelStatus(status: TunnelRuntimeStatus): TunnelRuntimeStatus {
  return {
    ok: status.ok,
    processRunning: status.processRunning,
    healthy: status.healthy,
    ready: status.ready,
    detail: status.ok ? 'managed tunnel is running and ready' : 'managed tunnel is stopped or not ready',
  }
}

function invalidProfileDoctorReport(): NativeDoctorReport {
  const checks = NATIVE_DOCTOR_CHECK_IDS.map(id => doctorCheck(
    id,
    id === 'native.platform' ? 'ok' : 'error',
    id === 'native.platform' ? 'native MCP platform is supported' : 'profile directory is invalid',
  ))
  return {
    version: 2,
    ok: false,
    config: 'invalid',
    binary: 'missing',
    key: 'missing',
    profile: 'missing',
    runtime: { state: 'stopped' },
    broker: 'invalid',
    issues: ['profile directory is invalid'],
    checks,
  }
}

export function doctorManagedNativeRuntime(options: {
  readonly profileDir: string
  readonly connectorName: string
  readonly brokerSocketPath?: string
  readonly run?: CommandRunner
}): NativeDoctorReport {
  let profileDir: string
  try {
    profileDir = profilePath(options.profileDir)
  } catch {
    return invalidProfileDoctorReport()
  }

  const checks: NativeDoctorCheck[] = []
  const paths = defaultManagedRuntimePaths(profileDir)
  const configPath = paths.configPath
  let config: ManagedNativeRuntimeConfig | undefined
  let configStatus: NativeDoctorReport['config'] = 'missing'
  if (!pathExistsOrSymlink(configPath)) {
    configStatus = 'missing'
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
    }
  }

  let binary: NativeDoctorReport['binary'] = 'missing'
  let key: NativeDoctorReport['key'] = 'missing'
  let profile: NativeDoctorReport['profile'] = 'missing'
  let runtime: TunnelRuntimeStatus | { readonly state: 'stopped' } = { state: 'stopped' }
  let expectedAsset: { readonly name: string; readonly archiveSha256: string } | undefined
  try {
    expectedAsset = tunnelReleaseAsset()
    checks.push(doctorCheck('native.platform', 'ok', 'native MCP platform and architecture are supported'))
  } catch {
    checks.push(doctorCheck('native.platform', 'error', 'native MCP platform or architecture is unsupported'))
  }

  if (config !== undefined) {
    try {
      assertPrivateRegularFile(config.tunnelClient.path, 'managed tunnel client', true)
      if (digestFile(config.tunnelClient.path) !== config.tunnelClient.sha256) throw new Error('binary hash mismatch')
      validateManifest(join(dirname(config.tunnelClient.path), 'tunnel-client-manifest.json'), config.tunnelClient.sha256, expectedAsset)
      binary = 'ok'
    } catch {
      binary = pathExistsOrSymlink(config.tunnelClient.path) ? 'invalid' : 'missing'
    }
    try {
      assertPrivateRegularFile(config.tunnel.runtimeKeyFile, 'managed runtime key')
      key = 'ok'
    } catch {
      key = pathExistsOrSymlink(config.tunnel.runtimeKeyFile) ? 'invalid' : 'missing'
    }
    try {
      assertPrivateDirectory(config.tunnel.profileDir, 'managed tunnel profile directory')
      profile = 'ok'
    } catch {
      profile = 'missing'
    }
    if (binary === 'ok' && key === 'ok' && profile === 'ok') {
      try {
        const runtimeObject = new ManagedTunnelRuntime({
          config,
          nodeExecutable: process.execPath,
          mcpEntrypoint: resolveMcpEntrypoint(undefined),
          brokerSocketPath: options.brokerSocketPath ?? setupBrokerSocket(profileDir),
          ...(options.run === undefined ? {} : { run: options.run }),
        })
        runtime = publicTunnelStatus(runtimeObject.status())
      } catch {
        runtime = { state: 'stopped' }
      }
    }
  }

  const broker = brokerState(options.brokerSocketPath ?? setupBrokerSocket(profileDir))
  let snapshot: ReturnType<typeof readNativeSecurityState> | undefined
  let snapshotError = false
  try {
    snapshot = readNativeSecurityState(profileDir)
  } catch {
    snapshotError = true
  }

  let approval: ReturnType<typeof readNativeApprovalState> | undefined
  let approvalError = false
  try {
    approval = readNativeApprovalState(profileDir)
  } catch {
    approvalError = true
  }

  let checkpointSummaries: ReturnType<ReturnType<typeof createNativeCheckpointStore>['inspect']> = []
  let checkpointError = false
  try {
    checkpointSummaries = createNativeCheckpointStore(profileDir).inspect()
  } catch {
    checkpointError = true
  }

  let ownedConversationCount = 0
  let ownershipError = false
  try {
    ownedConversationCount = createOwnedConversationLedger(profileDir).pending().length
  } catch {
    ownershipError = true
  }

  const configSummary = configStatus === 'ok'
    ? 'managed runtime configuration is valid'
    : configStatus === 'missing' ? 'managed runtime configuration is missing' : 'managed runtime configuration is invalid'
  checks.push(doctorCheck('native.runtime.config', configStatus === 'ok' ? 'ok' : 'error', configSummary))
  const binarySummary = binary === 'ok'
    ? 'managed tunnel-client binary and pinned manifest are valid'
    : binary === 'missing' ? 'managed tunnel-client binary is missing' : 'managed tunnel-client binary or manifest is invalid'
  checks.push(doctorCheck('native.managed.binary', binary === 'ok' ? 'ok' : 'error', binarySummary))
  checks.push(doctorCheck(
    'native.runtime.key',
    key === 'ok' ? 'ok' : 'error',
    key === 'ok' ? 'managed runtime key is private and readable' : key === 'missing' ? 'managed runtime key is missing' : 'managed runtime key is invalid',
  ))
  checks.push(doctorCheck(
    'native.runtime.profile',
    profile === 'ok' ? 'ok' : 'error',
    profile === 'ok' ? 'managed tunnel profile directory is private and readable' : 'managed tunnel profile directory is missing or invalid',
  ))
  const connectorMatches = config?.connectorName === options.connectorName
    && (snapshot === undefined || snapshot.summary.connectorName === options.connectorName)
  checks.push(doctorCheck(
    'native.connector.name',
    connectorMatches ? 'ok' : 'error',
    connectorMatches ? 'connector name matches the managed configuration' : 'connector name does not match the managed configuration',
  ))
  const connectorRuntime = snapshot?.summary.connectorRuntime
  checks.push(doctorCheck(
    'native.connector.runtime',
    snapshot === undefined ? 'warning' : connectorRuntime === 'managed' ? 'ok' : 'warning',
    snapshot === undefined
      ? 'connector runtime identity is unavailable until a request is prepared'
      : connectorRuntime === 'managed' ? 'connector runtime identity is managed' : 'last prepared connector runtime identity is external',
  ))

  if (snapshot === undefined) {
    checks.push(doctorCheck('native.workspace.root', 'warning', 'workspace root is unavailable until a request is prepared'))
  } else {
    checks.push(doctorCheck(
      'native.workspace.root',
      snapshot.summary.workspaceRootSource === 'process.cwd' ? 'warning' : 'ok',
      snapshot.summary.workspaceRootSource === 'process.cwd'
        ? 'workspace root falls back to process.cwd; configure nativeSecurity.workspaceRoot explicitly'
        : 'workspace root is explicitly configured',
    ))
  }

  let policySchemaStatus: NativeDoctorStatus = snapshotError ? 'error' : snapshot === undefined ? 'warning' : 'ok'
  let policySchemaSummary = snapshotError
    ? 'security-state snapshot is malformed or unsafe'
    : snapshot === undefined ? 'policy schema is unavailable until a request is prepared' : 'policy schema and tool inventory are valid'
  if (snapshot !== undefined) {
    const tools = snapshot.summary.tools
    const duplicate = new Set(tools.map(tool => tool.tool)).size !== tools.length
    const invalidTool = tools.some(tool => tool.schemaHash === undefined
      || !SHA256.test(tool.schemaHash)
      || tool.pathArguments.some(pointer => !validPathPointer(pointer)))
    const secureViolation = snapshot.summary.toolPolicy !== 'full' && tools.some(tool => (
      tool.capability === 'full-unrestricted' || tool.result === 'raw-unbounded' || tool.outputProvenance === 'unverified-full'
    ))
    if (duplicate || invalidTool || secureViolation || snapshot.summary.policyImplementationVersion !== '0.7.0') {
      policySchemaStatus = 'error'
      policySchemaSummary = 'policy implementation, schema hashes, paths, or capability restrictions are invalid'
    }
  }
  checks.push(doctorCheck('native.policy.schema', policySchemaStatus, policySchemaSummary))

  let provenanceStatus: NativeDoctorStatus = snapshotError ? 'error' : snapshot === undefined ? 'warning' : 'ok'
  let provenanceSummary = snapshotError
    ? 'output-provenance state could not be read safely'
    : snapshot === undefined ? 'output provenance is unavailable until a request is prepared' : 'tool output provenance is operator-declared'
  if (snapshot !== undefined && snapshot.summary.tools.some(tool => tool.outputProvenance === 'unverified-full')) {
    provenanceStatus = 'warning'
    provenanceSummary = 'full-mode tool output is unverified; evidence-only or allowlist mode is safer'
  }
  checks.push(doctorCheck('native.policy.output-provenance', provenanceStatus, provenanceSummary))

  let approvalStatus: NativeDoctorStatus
  let approvalSummary: string
  let approvalAction: string | undefined
  if (approvalError) {
    approvalStatus = 'error'
    approvalSummary = 'native approval state is malformed or unsafe'
  } else if (snapshot === undefined) {
    approvalStatus = approval?.grant === undefined && approval?.challenge === undefined ? 'warning' : 'error'
    approvalSummary = approvalStatus === 'warning'
      ? 'approval state is unavailable until a request is prepared'
      : 'approval state cannot be matched without a prepared policy snapshot'
  } else if (snapshot.summary.approval === 'none' || snapshot.summary.tools.length === 0) {
    approvalStatus = approval?.grant === undefined && approval?.challenge === undefined ? 'ok' : 'warning'
    approvalSummary = approvalStatus === 'ok' ? 'no native approval grant is required' : 'approval files exist for a policy with no effective tools'
  } else if (approval?.grant === undefined) {
    approvalStatus = 'error'
    approvalSummary = 'effective native policy grant is missing or expired'
    approvalAction = approval?.challenge === undefined ? undefined : nativeAction(
      profileDir,
      'approve',
      '--challenge',
      approval.challenge.challengeId,
    )
  } else if (approval.grant.approvalHash !== snapshot.approvalHash
    || approval.grant.summaryHash !== nativeSecuritySummaryHash(snapshot.summary)) {
    approvalStatus = 'error'
    approvalSummary = 'effective native policy grant does not match the prepared policy'
  } else if (approval.claimCount !== 0 || approval.challenge !== undefined) {
    approvalStatus = 'warning'
    approvalSummary = 'native approval contains a pending or abandoned claim'
  } else {
    approvalStatus = 'ok'
    approvalSummary = 'effective native policy grant matches the prepared policy'
  }
  checks.push(doctorCheck('native.approval.grant', approvalStatus, approvalSummary, approvalAction))

  const writer = inspectPrivateWriterLease(profileDir)
  const writerStatus: NativeDoctorStatus = writer.state === 'invalid' || writer.state === 'ambiguous'
    ? 'error' : writer.state === 'live' || writer.state === 'stale' ? 'warning' : 'ok'
  checks.push(doctorCheck(
    'native.checkpoint.writer',
    writerStatus,
    writer.state === 'missing' ? 'checkpoint writer lease is not held'
      : writer.state === 'live' ? 'checkpoint writer lease is held by a live runtime'
        : writer.state === 'stale' ? 'checkpoint writer lease is stale and requires a safe reclaim'
          : 'checkpoint writer lease is invalid or ambiguous',
  ))

  const nonTerminal = checkpointSummaries.filter(item => !item.terminal)
  const unresolvedReplay = nonTerminal.some(item => item.replayConsumed)
  const recoveryStatus: NativeDoctorStatus = checkpointError || unresolvedReplay || nonTerminal.length > 0 ? 'error' : 'ok'
  const recoverySummary = checkpointError
    ? 'checkpoint journals are malformed or unsafe'
    : nonTerminal.length === 0
      ? 'all checkpoint journals are terminal'
      : `${nonTerminal.length} checkpoint journal(s) require recovery; replay safety is blocked`
  const recoveryAction = nonTerminal[0] === undefined ? undefined : nativeAction(
    profileDir,
    'recover',
    '--checkpoint',
    nonTerminal[0].checkpointHash,
    '--abandon',
  )
  checks.push(doctorCheck('native.checkpoint.recovery', recoveryStatus, recoverySummary, recoveryAction))

  const cleanupStatus: NativeDoctorStatus = ownershipError ? 'error' : ownedConversationCount === 0 ? 'ok' : 'error'
  checks.push(doctorCheck(
    'native.cleanup.owned-conversations',
    cleanupStatus,
    ownershipError
      ? 'owned-conversation ledger is malformed or unsafe'
      : ownedConversationCount === 0 ? 'owned-conversation cleanup ledger is empty' : 'owned-conversation cleanup is pending',
  ))

  let snapshotStatus: NativeDoctorStatus
  let snapshotSummary: string
  if (snapshotError) {
    snapshotStatus = 'error'
    snapshotSummary = 'security-state snapshot is malformed or unsafe'
  } else if (snapshot === undefined) {
    snapshotStatus = 'warning'
    snapshotSummary = 'security-state snapshot is missing; no prior success is assumed'
  } else {
    const age = Date.now() - Date.parse(snapshot.generatedAt)
    const fresh = age >= 0 && age <= NATIVE_SECURITY_STATE_MAX_AGE_MS
      && processIdentityIsLive(snapshot.runtimeProcess.pid, snapshot.runtimeProcess.startedAt)
    snapshotStatus = fresh ? 'ok' : 'warning'
    snapshotSummary = fresh
      ? 'security-state snapshot matches a live runtime process'
      : 'security-state snapshot is stale and cannot establish current readiness'
  }
  checks.push(doctorCheck('native.snapshot.freshness', snapshotStatus, snapshotSummary))

  const runtimeOffline = configStatus === 'missing'
    || ('ok' in runtime && runtime.processRunning === false)
  const allTerminal = !checkpointError && checkpointSummaries.every(item => item.terminal)
  const rollbackSafe = runtimeOffline && writer.state === 'missing' && allTerminal
    && !unresolvedReplay && !ownershipError && ownedConversationCount === 0
  checks.push(doctorCheck(
    'native.rollback.safe',
    rollbackSafe ? 'ok' : 'warning',
    rollbackSafe
      ? 'safe rollback preconditions are satisfied while offline'
      : 'rollback is unsafe until the runtime is offline, the writer is free, checkpoints are terminal, replay is resolved, and cleanup is empty',
  ))

  const processStatus: NativeDoctorStatus = config === undefined
    ? 'error'
    : 'ok' in runtime && runtime.ok ? 'ok' : 'warning'
  checks.push(doctorCheck(
    'native.managed.process',
    processStatus,
    config === undefined ? 'managed process state is unavailable without runtime configuration'
      : 'ok' in runtime && runtime.ok ? 'managed tunnel is running and ready' : 'managed tunnel is stopped or not ready',
  ))
  checks.push(doctorCheck(
    'native.broker.socket',
    broker === 'ready' ? 'ok' : broker === 'stopped' ? 'warning' : 'error',
    broker === 'ready' ? 'private broker socket is ready'
      : broker === 'stopped' ? 'private broker socket is stopped' : 'broker socket is invalid',
  ))

  const issues = checks.filter(check => check.status !== 'ok').map(check => check.summary)
  return {
    version: 2,
    ok: checks.every(check => check.status === 'ok'),
    config: configStatus,
    binary,
    key,
    profile,
    runtime,
    broker,
    issues,
    checks,
  }
}

export async function abandonNativeCheckpoint(profileDir: string, checkpointHash: string): Promise<void> {
  const resolvedProfileDir = profilePath(profileDir)
  const store = createNativeCheckpointStore(resolvedProfileDir)
  const lease = store.acquire()
  let browser: ChatGptBrowser | undefined
  let page: Awaited<ReturnType<ChatGptBrowser['newTurnPage']>> | undefined
  let failure: unknown
  try {
    if (store.abandon === undefined
      || store.prepareRecoveryCleanup === undefined
      || store.confirmRecoveryCleanup === undefined) {
      throw new Error('native checkpoint abandonment is unavailable')
    }
    // This first mutation is the durable operator acknowledgement. It either
    // closes a pre-submit checkpoint or leaves a non-replayable fence for the
    // exact owned-conversation cleanup below.
    store.abandon(checkpointHash)
    const ledger = createOwnedConversationLedger(resolvedProfileDir)
    const pending = ledger.pending()
    if (pending.length !== 0) {
      if (pending.length !== 1) throw new Error('native checkpoint abandonment requires exactly one owned conversation')
      store.prepareRecoveryCleanup(checkpointHash)
      browser = new ChatGptBrowser({
        profileDir: resolvedProfileDir,
        chromeExecutablePath: undefined,
        headed: false,
        offscreen: true,
        loginTimeoutMs: 600_000,
        daemonIdleMs: 1_800_000,
      })
      await browser.ensureReady()
      page = await browser.newTurnPage()
      await retryPendingConversationDeletions(page, ledger)
      if (ledger.pending().length !== 0) throw new Error('native checkpoint ownership cleanup remained pending')
      store.confirmRecoveryCleanup(
        checkpointHash,
        hashCanonical('native-ledger-correlation', 1, pending[0]),
      )
      store.abandon(checkpointHash)
    }
    const remaining = store.inspect().find(summary => summary.checkpointHash === checkpointHash)
    if (remaining !== undefined && !remaining.terminal) {
      throw new Error('native checkpoint abandonment remains blocked; exact cleanup could not be confirmed')
    }
  } catch (error) {
    failure = error
  }
  try { await page?.close() } catch (error) { failure ??= error }
  try { await browser?.close() } catch (error) { failure ??= error }
  try { lease.release() } catch (error) { failure ??= error }
  if (failure !== undefined) throw failure
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
  if (json) return `${safeJson(report)}\n`
  return [
    `managed native runtime: ${report.ok ? 'ok' : 'not ready'}`,
    `config=${report.config} binary=${report.binary} key=${report.key} profile=${report.profile}`,
    `runtime=${'ok' in report.runtime ? report.runtime.ok ? 'ready' : 'not-ready' : report.runtime.state}`,
    `broker=${report.broker}`,
    ...report.checks.map(check => [
      `check ${check.id}: ${check.status} ${terminalQuote(check.summary)}`,
      ...(check.action === undefined ? [] : [`  action: ${terminalQuote(check.action)}`]),
    ].join('\n')),
    ...report.issues.map(issue => `issue: ${terminalQuote(issue)}`),
  ].join('\n') + '\n'
}
