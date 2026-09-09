import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  assertPrivateDirectory,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
} from './private-files.ts'

export const MANAGED_TUNNEL_CLIENT_VERSION = '0.0.12' as const
const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_NAME = /^[A-Za-z0-9._-]+$/
const CONNECTOR_NAME_MAX = 80

export interface ManagedNativeRuntimeConfig {
  readonly version: 1
  readonly connectorName: string
  readonly tunnelClient: {
    readonly path: string
    readonly version: typeof MANAGED_TUNNEL_CLIENT_VERSION
    readonly sha256: string
  }
  readonly tunnel: {
    readonly id: string
    readonly runtimeKeyFile: string
    readonly profileDir: string
    readonly profileName: string
    readonly alias: string
  }
}

export function defaultNativeRuntimeConfigPath(profileDir: string): string {
  return join(resolve(profileDir), 'native-runtime.json')
}

export function defaultManagedRuntimePaths(profileDir: string): {
  readonly configPath: string
  readonly keyPath: string
  readonly binaryPath: string
  readonly manifestPath: string
  readonly tunnelProfileDir: string
} {
  const root = resolve(profileDir)
  const binDir = join(root, 'bin')
  return {
    configPath: defaultNativeRuntimeConfigPath(root),
    keyPath: join(root, 'secrets', 'tunnel-runtime.key'),
    binaryPath: join(binDir, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'),
    manifestPath: join(binDir, 'tunnel-client-manifest.json'),
    tunnelProfileDir: join(root, 'tunnel', 'profiles'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`managed runtime ${field} must be a non-empty string`)
  return value
}

function absoluteField(value: unknown, field: string): string {
  const text = stringField(value, field)
  if (!isAbsolute(text)) throw new Error(`managed runtime ${field} must be an absolute path`)
  if (text.includes('\u0000')) throw new Error(`managed runtime ${field} contains a NUL byte`)
  return text
}

function connectorName(value: unknown): string {
  const name = stringField(value, 'connector name')
  if (name.trim() !== name || name.length > CONNECTOR_NAME_MAX || /[\r\n\u0000]/.test(name)) {
    throw new Error('managed runtime connector name is invalid')
  }
  return name
}

function safeName(value: unknown, field: string): string {
  const name = stringField(value, field)
  if (!SAFE_NAME.test(name)) throw new Error(`managed runtime ${field} is invalid`)
  return name
}

export function parseManagedNativeRuntimeConfig(value: unknown): ManagedNativeRuntimeConfig {
  if (!isRecord(value)) throw new Error('managed runtime config must be an object')
  if (value.version !== 1) throw new Error('managed runtime config version must be 1')
  if (!isRecord(value.tunnelClient)) throw new Error('managed runtime tunnelClient must be an object')
  if (!isRecord(value.tunnel)) throw new Error('managed runtime tunnel must be an object')

  const tunnelClientVersion = stringField(value.tunnelClient.version, 'tunnel client version')
  if (tunnelClientVersion !== MANAGED_TUNNEL_CLIENT_VERSION) {
    throw new Error(`managed runtime tunnel client version must be ${MANAGED_TUNNEL_CLIENT_VERSION}`)
  }
  const tunnelClientHash = stringField(value.tunnelClient.sha256, 'tunnel client SHA-256')
  if (!SHA256.test(tunnelClientHash)) throw new Error('managed runtime tunnel client SHA-256 is invalid')

  const tunnelId = stringField(value.tunnel.id, 'Tunnel ID')
  if (!TUNNEL_ID.test(tunnelId)) throw new Error('managed runtime Tunnel ID is invalid')

  return {
    version: 1,
    connectorName: connectorName(value.connectorName),
    tunnelClient: {
      path: absoluteField(value.tunnelClient.path, 'tunnel client path'),
      version: MANAGED_TUNNEL_CLIENT_VERSION,
      sha256: tunnelClientHash,
    },
    tunnel: {
      id: tunnelId,
      runtimeKeyFile: absoluteField(value.tunnel.runtimeKeyFile, 'runtime key path'),
      profileDir: absoluteField(value.tunnel.profileDir, 'tunnel profile directory'),
      profileName: safeName(value.tunnel.profileName, 'tunnel profile name'),
      alias: safeName(value.tunnel.alias, 'tunnel alias'),
    },
  }
}

export function loadManagedNativeRuntimeConfig(
  path: string,
  expected: { connectorName: string },
): ManagedNativeRuntimeConfig {
  assertPrivateRegularFile(path, 'managed runtime config')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`managed runtime config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = parseManagedNativeRuntimeConfig(parsed)
  if (config.connectorName !== expected.connectorName) {
    throw new Error(
      `managed runtime connector name ${JSON.stringify(config.connectorName)} does not match configured connector ${JSON.stringify(expected.connectorName)}`,
    )
  }
  assertPrivateRegularFile(config.tunnelClient.path, 'managed tunnel client', true)
  const binaryHash = createHash('sha256').update(readFileSync(config.tunnelClient.path)).digest('hex')
  if (binaryHash !== config.tunnelClient.sha256) {
    throw new Error('managed tunnel client binary hash does not match runtime config')
  }
  assertPrivateRegularFile(config.tunnel.runtimeKeyFile, 'managed runtime key')
  assertPrivateDirectory(config.tunnel.profileDir, 'managed tunnel profile directory')
  return config
}

/** Prepare the directory layout used by setup; existing unsafe directories fail closed. */
export function ensureManagedRuntimeDirectories(profileDir: string): ReturnType<typeof defaultManagedRuntimePaths> {
  const paths = defaultManagedRuntimePaths(profileDir)
  ensurePrivateDirectory(resolve(profileDir))
  ensurePrivateDirectory(join(resolve(profileDir), 'bin'))
  ensurePrivateDirectory(join(resolve(profileDir), 'secrets'))
  ensurePrivateDirectory(paths.tunnelProfileDir)
  return paths
}
