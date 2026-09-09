import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, symlinkSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPrivateRegularFile,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
} from '../src/native/private-files.ts'
import {
  loadManagedNativeRuntimeConfig,
  parseManagedNativeRuntimeConfig,
} from '../src/native/runtime-config.ts'
import type { ManagedNativeRuntimeConfig } from '../src/native/runtime-config.ts'

function validConfig(root: string): ManagedNativeRuntimeConfig {
  return {
    version: 1,
    connectorName: 'DSH Native',
    tunnelClient: {
      path: join(root, 'bin', 'tunnel-client'),
      version: '0.0.12',
      sha256: createHash('sha256').update(new Uint8Array([1])).digest('hex'),
    },
    tunnel: {
      id: `tunnel_${'0'.repeat(32)}`,
      runtimeKeyFile: join(root, 'secrets', 'tunnel-runtime.key'),
      profileDir: join(root, 'tunnel', 'profiles'),
      profileName: 'dsh-chatgpt-web',
      alias: 'dsh-chatgpt-web',
    },
  }
}

function prepareConfigFiles(config: ManagedNativeRuntimeConfig): void {
  ensurePrivateDirectory(config.tunnel.profileDir)
  atomicWritePrivateFile(config.tunnelClient.path, new Uint8Array([1]), 0o700)
  atomicWritePrivateFile(config.tunnel.runtimeKeyFile, 'runtime-key')
}

describe('managed native runtime config', () => {
  it('round-trips a private managed runtime config', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-config-'))
    const config = validConfig(root)
    prepareConfigFiles(config)
    const path = join(root, 'native-runtime.json')
    atomicWritePrivateFile(path, `${JSON.stringify(config)}\n`)

    expect(loadManagedNativeRuntimeConfig(path, { connectorName: 'DSH Native' }))
      .toEqual(config)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(path).isFile()).toBe(true)
  })

  it('rejects symlinks and group-readable managed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-config-'))
    const real = join(root, 'real.json')
    writeFileSync(real, '{}', { mode: 0o644 })
    expect(() => assertPrivateRegularFile(real, 'runtime config')).toThrow(/permissions/)

    const link = join(root, 'link.json')
    symlinkSync(real, link)
    expect(() => assertPrivateRegularFile(link, 'runtime config')).toThrow(/symlink/)
  })

  it('rejects an unsafe existing directory instead of repairing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-config-'))
    const unsafe = join(root, 'unsafe')
    ensurePrivateDirectory(unsafe)
    chmodSync(unsafe, 0o755)
    expect(() => ensurePrivateDirectory(unsafe)).toThrow(/permissions/)
  })

  it('rejects malformed ids, hashes, names, and relative paths', () => {
    const base = validConfig('/tmp/private')
    expect(() => parseManagedNativeRuntimeConfig({
      ...base,
      tunnel: { ...base.tunnel, id: 'bad' },
    })).toThrow(/Tunnel ID/)
    expect(() => parseManagedNativeRuntimeConfig({
      ...base,
      tunnelClient: { ...base.tunnelClient, sha256: 'bad' },
    })).toThrow(/SHA-256/)
    expect(() => parseManagedNativeRuntimeConfig({
      ...base,
      connectorName: ' DSH Native ',
    })).toThrow(/connector name/)
    expect(() => parseManagedNativeRuntimeConfig({
      ...base,
      tunnelClient: { ...base.tunnelClient, path: 'relative-client' },
    })).toThrow(/absolute/)
    expect(() => parseManagedNativeRuntimeConfig({
      ...base,
      version: 2,
    })).toThrow(/version/)
  })

  it('rejects a binary hash mismatch while loading', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-config-'))
    const config = validConfig(root)
    prepareConfigFiles(config)
    const path = join(root, 'native-runtime.json')
    const mismatched = {
      ...config,
      tunnelClient: { ...config.tunnelClient, sha256: 'a'.repeat(64) },
    }
    atomicWritePrivateFile(path, `${JSON.stringify(mismatched)}\n`)
    expect(() => loadManagedNativeRuntimeConfig(path, { connectorName: 'DSH Native' }))
      .toThrow(/hash/i)
  })

  it('rejects a connector-name mismatch while loading', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-config-'))
    const config = validConfig(root)
    prepareConfigFiles(config)
    const path = join(root, 'native-runtime.json')
    atomicWritePrivateFile(path, `${JSON.stringify(config)}\n`)
    expect(() => loadManagedNativeRuntimeConfig(path, { connectorName: 'Other Connector' }))
      .toThrow(/connector name/i)
  })
})
