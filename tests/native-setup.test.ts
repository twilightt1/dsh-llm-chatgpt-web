import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
} from '../src/native/private-files.ts'
import type { ManagedNativeRuntimeConfig } from '../src/native/runtime-config.ts'
import type {
  TunnelInstallManifest,
  TunnelInstallTransaction,
} from '../src/native/tunnel-install.ts'
import {
  doctorManagedNativeRuntime,
  parseNativeSetupArgs,
  setupManagedNativeRuntime,
  stopManagedNativeRuntime,
} from '../src/native/setup.ts'
import { readHiddenRuntimeKey } from '../src/native/setup-main.ts'
import type { NativeSetupDependencies } from '../src/native/setup.ts'

const TUNNEL_ID = `tunnel_${'0'.repeat(32)}`

function binaryHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sourceKey(root: string): string {
  const path = join(root, 'source-runtime.key')
  atomicWritePrivateFile(path, 'source-secret-value')
  return path
}

function fakeInstaller(): {
  stage: NonNullable<NativeSetupDependencies['stageTunnelClient']>
  manifest: TunnelInstallManifest
  candidatePath: string
} {
  const binary = new TextEncoder().encode('fake tunnel client')
  const manifest: TunnelInstallManifest = {
    version: 1,
    tunnelClientVersion: '0.0.12',
    asset: 'fixture.zip',
    archiveSha256: 'a'.repeat(64),
    binarySha256: binaryHash(binary),
  }
  return {
    manifest,
    candidatePath: '',
    stage: async options => {
      const candidatePath = `${options.binaryPath}.candidate`
      atomicWritePrivateFile(candidatePath, binary, 0o700)
      const transaction: TunnelInstallTransaction = {
        candidatePath,
        manifest,
        commit: vi.fn(() => {
          atomicWritePrivateFile(options.binaryPath, binary, 0o700)
          atomicWritePrivateFile(options.manifestPath, `${JSON.stringify(manifest)}\n`)
          return options.binaryPath
        }),
        rollback: vi.fn(() => {}),
        finalize: vi.fn(() => {}),
      }
      return transaction
    },
  }
}

function baseConfig(root: string): ManagedNativeRuntimeConfig {
  const binary = new TextEncoder().encode('existing tunnel client')
  const binaryPath = join(root, 'bin', 'tunnel-client')
  const keyPath = join(root, 'secrets', 'tunnel-runtime.key')
  const profileDir = join(root, 'tunnel', 'profiles')
  ensurePrivateDirectory(join(root, 'bin'))
  ensurePrivateDirectory(join(root, 'secrets'))
  ensurePrivateDirectory(profileDir)
  atomicWritePrivateFile(binaryPath, binary, 0o700)
  atomicWritePrivateFile(keyPath, 'old-secret')
  return {
    version: 1,
    connectorName: 'DSH Native',
    tunnelClient: { path: binaryPath, version: '0.0.12', sha256: binaryHash(binary) },
    tunnel: {
      id: TUNNEL_ID,
      runtimeKeyFile: keyPath,
      profileDir,
      profileName: 'dsh-chatgpt-web',
      alias: 'dsh-chatgpt-web',
    },
  }
}

describe('native setup CLI parsing', () => {
  it('parses setup options without accepting inline runtime secrets', () => {
    expect(parseNativeSetupArgs([
      'setup', '--profile-dir', '/tmp/p', '--connector-name', 'DSH Native',
      '--tunnel-id', TUNNEL_ID, '--runtime-key-file', '/tmp/key',
    ])).toMatchObject({ command: 'setup', options: { connectorName: 'DSH Native' } })
    expect(() => parseNativeSetupArgs(['setup', '--runtime-key', 'secret']))
      .toThrow(/unknown option/i)
    expect(() => parseNativeSetupArgs([
      'setup', '--profile-dir', '/tmp/p', '--profile-dir', '/tmp/q',
    ])).toThrow(/duplicate/i)
  })

  it('parses redacted doctor and stop commands', () => {
    expect(parseNativeSetupArgs([
      'doctor', '--profile-dir', '/tmp/p', '--connector-name', 'DSH Native', '--json',
    ])).toEqual({ command: 'doctor', profileDir: '/tmp/p', connectorName: 'DSH Native', json: true })
    expect(parseNativeSetupArgs([
      'stop', '--profile-dir', '/tmp/p', '--connector-name', 'DSH Native',
    ])).toEqual({ command: 'stop', profileDir: '/tmp/p', connectorName: 'DSH Native' })
  })
})

describe('hidden runtime-key input', () => {
  it('does not echo input and restores raw mode after Enter', async () => {
    class FakeInput extends EventEmitter {
      readonly isTTY = true
      readonly modes: boolean[] = []
      resume(): void {}
      pause(): void {}
      setRawMode(mode: boolean): this {
        this.modes.push(mode)
        return this
      }
    }
    const stdin = new FakeInput()
    const promise = readHiddenRuntimeKey({
      stdin: stdin as never,
      stdout: {} as never,
      stderr: {} as never,
    })
    stdin.emit('data', 'secret')
    stdin.emit('data', '\bX\n')
    expect(await promise).toBe('secreX')
    expect(stdin.modes).toEqual([true, false])
    expect(stdin.listenerCount('data')).toBe(0)
  })
})

describe('managed native setup transaction', () => {
  it('writes private config/key, validates temporary and final runtimes, and stops them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-setup-'))
    const source = sourceKey(root)
    const installer = fakeInstaller()
    const lifecycle: string[] = []
    const dependencies: NativeSetupDependencies = {
      stageTunnelClient: installer.stage,
      createRuntime: options => ({
        start: async () => { lifecycle.push(`start:${options.config.tunnel.alias}`) },
        stop: async () => { lifecycle.push(`stop:${options.config.tunnel.alias}`) },
      }),
      mcpEntrypoint: '/tmp/package/lib/mcp-main.js',
      nodeExecutable: '/usr/local/bin/node',
    }

    const result = await setupManagedNativeRuntime({
      profileDir: join(root, 'profile'),
      connectorName: 'DSH Native',
      tunnelId: TUNNEL_ID,
      runtimeKeyFile: source,
    }, dependencies)

    expect(result.tunnelReady).toBe(true)
    expect(result.connectorSetupRequired).toBe(true)
    expect(result.sourceKeyRetained).toBe(true)
    expect(lifecycle).toEqual([
      'start:dsh-chatgpt-web-setup',
      'stop:dsh-chatgpt-web-setup',
      'start:dsh-chatgpt-web',
      'stop:dsh-chatgpt-web',
    ])
    const configText = readFileSync(result.configPath, 'utf8')
    expect(configText).not.toContain('source-secret-value')
    expect(statSync(result.configPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'profile', 'secrets', 'tunnel-runtime.key')).mode & 0o777).toBe(0o600)
  })

  it('restores existing managed files when validation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-setup-'))
    const profileDir = join(root, 'profile')
    const old = baseConfig(profileDir)
    const configPath = join(profileDir, 'native-runtime.json')
    atomicWritePrivateFile(configPath, `${JSON.stringify(old)}\n`)
    const source = sourceKey(root)
    const installer = fakeInstaller()
    const dependencies: NativeSetupDependencies = {
      stageTunnelClient: installer.stage,
      createRuntime: () => ({
        start: async () => { throw new Error(`validation failed for ${TUNNEL_ID}`) },
        stop: async () => {},
      }),
      mcpEntrypoint: '/tmp/package/lib/mcp-main.js',
      nodeExecutable: '/usr/local/bin/node',
    }

    await expect(setupManagedNativeRuntime({
      profileDir,
      connectorName: 'DSH Native',
      tunnelId: TUNNEL_ID,
      runtimeKeyFile: source,
    }, dependencies)).rejects.toThrow(/validation failed|setup/i)
    expect(readFileSync(configPath, 'utf8')).toBe(`${JSON.stringify(old)}\n`)
    expect(readFileSync(old.tunnel.runtimeKeyFile, 'utf8')).toBe('old-secret')
  })
})

describe('native doctor and stop', () => {
  it('reports a missing installation without exposing path contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-'))
    const report = doctorManagedNativeRuntime({ profileDir: join(root, 'missing'), connectorName: 'DSH Native' })
    expect(report.ok).toBe(false)
    expect(report.config).toBe('missing')
    expect(report.issues.join('\n')).not.toContain(TUNNEL_ID)
  })

  it('treats stop with no managed config as success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-stop-'))
    await expect(stopManagedNativeRuntime({
      profileDir: join(root, 'missing'),
      connectorName: 'DSH Native',
    })).resolves.toBeUndefined()
  })
})
