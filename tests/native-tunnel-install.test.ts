import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
} from '../src/native/private-files.ts'
import {
  MANAGED_TUNNEL_CLIENT_VERSION,
  parseReleaseChecksum,
  stageTunnelClient,
  tunnelReleaseAsset,
} from '../src/native/tunnel-install.ts'
import type { CommandResult, TunnelReleaseAsset } from '../src/native/tunnel-install.ts'

const VERSION = MANAGED_TUNNEL_CLIENT_VERSION

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixture(root: string): {
  binaryPath: string
  manifestPath: string
  archive: Uint8Array
  asset: TunnelReleaseAsset
  run: (command: string, args: readonly string[]) => CommandResult
} {
  const binaryPath = join(root, 'bin', 'tunnel-client')
  const manifestPath = join(root, 'bin', 'tunnel-client-manifest.json')
  ensurePrivateDirectory(join(root, 'bin'))
  const binary = new TextEncoder().encode('fixture tunnel client')
  const archive = zipSync({ 'nested/tunnel-client': binary })
  const asset: TunnelReleaseAsset = {
    name: 'fixture-tunnel-client.zip',
    archiveSha256: digest(archive),
  }
  const run = (_command: string, args: readonly string[]): CommandResult => ({
    status: 0,
    stdout: args[0] === '--version' ? `tunnel-client ${VERSION}` : '',
    stderr: '',
  })
  return { binaryPath, manifestPath, archive, asset, run }
}

describe('pinned tunnel-client assets', () => {
  it('selects the source-controlled archive checksums', () => {
    expect(tunnelReleaseAsset('darwin', 'amd64')).toEqual({
      name: 'tunnel-client-v0.0.12-darwin-amd64.zip',
      archiveSha256: '33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009',
    })
    expect(tunnelReleaseAsset('darwin', 'arm64').archiveSha256)
      .toBe('42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02')
    expect(tunnelReleaseAsset('linux', 'amd64').archiveSha256)
      .toBe('2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81')
    expect(tunnelReleaseAsset('linux', 'arm64').archiveSha256)
      .toBe('6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6')
    expect(tunnelReleaseAsset('darwin', 'x64').name).toContain('amd64')
    expect(() => tunnelReleaseAsset('win32', 'arm64')).toThrow(/unsupported/i)
  })

  it('requires a valid release checksum entry', () => {
    expect(() => parseReleaseChecksum(
      'bad\nabc123  other.zip\n',
      'tunnel-client.zip',
    )).toThrow()
    expect(() => parseReleaseChecksum('bad data', 'tunnel-client.zip')).toThrow(/valid entry/)
    expect(parseReleaseChecksum(`${'a'.repeat(64)}  tunnel-client.zip\n`, 'tunnel-client.zip'))
      .toBe('a'.repeat(64))
  })
})

describe('staged tunnel-client installation', () => {
  it('stages, commits, rolls back, and finalizes without exposing a partial install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath, archive, asset, run } = fixture(root)
    const sums = `${asset.archiveSha256}  ${asset.name}\n`
    const fetchBytes = async (url: string, maximumBytes: number): Promise<Uint8Array> => {
      expect(maximumBytes).toBe(100 * 1024 * 1024)
      return url.endsWith('SHA256SUMS.txt') ? new TextEncoder().encode(sums) : archive
    }

    const transaction = await stageTunnelClient({
      binaryPath,
      manifestPath,
      fetchBytes,
      run,
      releaseAsset: asset,
    })
    expect(statSync(transaction.candidatePath).mode & 0o777).toBe(0o700)
    expect(() => statSync(binaryPath)).toThrow()
    expect(() => statSync(manifestPath)).toThrow()

    expect(transaction.commit()).toBe(binaryPath)
    expect(readFileSync(binaryPath, 'utf8')).toBe('fixture tunnel client')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      version: 1,
      tunnelClientVersion: VERSION,
      asset: asset.name,
      archiveSha256: asset.archiveSha256,
    })

    transaction.rollback()
    expect(() => statSync(binaryPath)).toThrow()
    expect(() => statSync(manifestPath)).toThrow()

    const second = await stageTunnelClient({
      binaryPath,
      manifestPath,
      fetchBytes,
      run,
      releaseAsset: asset,
    })
    second.commit()
    second.finalize()
    expect(readFileSync(binaryPath, 'utf8')).toBe('fixture tunnel client')
    second.rollback()
    expect(readFileSync(binaryPath, 'utf8')).toBe('fixture tunnel client')
  })

  it('restores an existing valid installation after a committed replacement is rolled back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath, archive, asset, run } = fixture(root)
    const oldBinary = new TextEncoder().encode('old tunnel client')
    const oldHash = digest(oldBinary)

    const fetchBytes = async (url: string): Promise<Uint8Array> => (
      url.endsWith('SHA256SUMS.txt')
        ? new TextEncoder().encode(`${asset.archiveSha256}  ${asset.name}\n`)
        : archive
    )
    const transaction = await stageTunnelClient({
      binaryPath,
      manifestPath,
      fetchBytes,
      run,
      releaseAsset: asset,
    })
    // The final destination may be populated by another safe writer after
    // staging; commit must snapshot and restore it transactionally.
    atomicWritePrivateFile(binaryPath, oldBinary, 0o700)
    atomicWritePrivateFile(manifestPath, `${JSON.stringify({
      version: 1,
      tunnelClientVersion: VERSION,
      asset: asset.name,
      archiveSha256: asset.archiveSha256,
      binarySha256: oldHash,
    })}\n`)
    transaction.commit()
    expect(readFileSync(binaryPath, 'utf8')).toBe('fixture tunnel client')
    transaction.rollback()
    expect(readFileSync(binaryPath, 'utf8')).toBe('old tunnel client')
    expect((statSync(binaryPath).mode & 0o777)).toBe(0o700)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).binarySha256).toBe(oldHash)
  })

  it('reuses a valid existing installation without network access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath, asset } = fixture(root)
    const binary = new TextEncoder().encode('existing tunnel client')
    atomicWritePrivateFile(binaryPath, binary, 0o700)
    atomicWritePrivateFile(manifestPath, `${JSON.stringify({
      version: 1,
      tunnelClientVersion: VERSION,
      asset: asset.name,
      archiveSha256: asset.archiveSha256,
      binarySha256: digest(binary),
    })}\n`)
    let networkCalls = 0
    const transaction = await stageTunnelClient({
      binaryPath,
      manifestPath,
      fetchBytes: async () => {
        networkCalls += 1
        throw new Error('network must not be used')
      },
      run: (_command, args) => ({
        status: 0,
        stdout: args[0] === '--version' ? `tunnel-client ${VERSION}` : '',
        stderr: '',
      }),
      releaseAsset: asset,
    })
    expect(networkCalls).toBe(0)
    expect(transaction.commit()).toBe(binaryPath)
    transaction.finalize()
    expect(new Uint8Array(readFileSync(binaryPath))).toEqual(binary)
  })

  it('rejects an existing installation for a different release asset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath, asset, run } = fixture(root)
    const binary = new TextEncoder().encode('existing tunnel client')
    atomicWritePrivateFile(binaryPath, binary, 0o700)
    atomicWritePrivateFile(manifestPath, `${JSON.stringify({
      version: 1,
      tunnelClientVersion: VERSION,
      asset: 'other-release.zip',
      archiveSha256: 'b'.repeat(64),
      binarySha256: digest(binary),
    })}\n`)
    await expect(stageTunnelClient({
      binaryPath,
      manifestPath,
      run,
      releaseAsset: asset,
    })).rejects.toThrow(/asset|integrity/i)
  })

  it('rejects an existing installation on an unsupported platform', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath, asset, run } = fixture(root)
    const binary = new TextEncoder().encode('existing tunnel client')
    atomicWritePrivateFile(binaryPath, binary, 0o700)
    atomicWritePrivateFile(manifestPath, `${JSON.stringify({
      version: 1,
      tunnelClientVersion: VERSION,
      asset: asset.name,
      archiveSha256: asset.archiveSha256,
      binarySha256: digest(binary),
    })}\n`)
    await expect(stageTunnelClient({
      binaryPath,
      manifestPath,
      run,
      platform: 'win32',
      releaseAsset: asset,
    })).rejects.toThrow(/unsupported/i)
  })

  it('rejects oversized downloads and archives without unpacking them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath } = fixture(root)
    const oversized = { byteLength: 100 * 1024 * 1024 + 1 } as unknown as Uint8Array
    await expect(stageTunnelClient({
      binaryPath,
      manifestPath,
      fetchBytes: async () => oversized,
      run: () => ({ status: 0, stdout: `tunnel-client ${VERSION}`, stderr: '' }),
      releaseAsset: { name: 'fixture-tunnel-client.zip', archiveSha256: 'a'.repeat(64) },
    })).rejects.toThrow(/exceeds/i)
  })

  it('rejects an archive without exactly one tunnel-client binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath } = fixture(root)
    const archive = zipSync({ 'nested/not-the-client': new Uint8Array([1, 2, 3]) })
    const asset = { name: 'missing-binary.zip', archiveSha256: digest(archive) }
    const fetchBytes = async (url: string): Promise<Uint8Array> => (
      url.endsWith('SHA256SUMS.txt')
        ? new TextEncoder().encode(`${asset.archiveSha256}  ${asset.name}\n`)
        : archive
    )
    await expect(stageTunnelClient({
      binaryPath,
      manifestPath,
      fetchBytes,
      run: () => ({ status: 0, stdout: `tunnel-client ${VERSION}`, stderr: '' }),
      releaseAsset: asset,
    })).rejects.toThrow(/exactly one.*binary/i)
  })

  it('rejects checksum, archive, executable, and existing-file integrity failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const { binaryPath, manifestPath, archive, asset, run } = fixture(root)
    const fetchBytes = async (url: string): Promise<Uint8Array> => (
      url.endsWith('SHA256SUMS.txt')
        ? new TextEncoder().encode(`${'b'.repeat(64)}  ${asset.name}\n`)
        : archive
    )
    await expect(stageTunnelClient({ binaryPath, manifestPath, fetchBytes, run, releaseAsset: asset }))
      .rejects.toThrow(/checksum/i)

    const unsafeRoot = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const unsafe = fixture(unsafeRoot)
    writeFileSync(unsafe.binaryPath, 'unsafe', { mode: 0o644 })
    atomicWritePrivateFile(unsafe.manifestPath, '{}')
    await expect(stageTunnelClient({
      binaryPath: unsafe.binaryPath,
      manifestPath: unsafe.manifestPath,
      fetchBytes: async () => archive,
      run,
      releaseAsset: asset,
    })).rejects.toThrow(/permissions|integrity|manifest/i)

    const badVersionRoot = mkdtempSync(join(tmpdir(), 'dsh-tunnel-install-'))
    const badVersion = fixture(badVersionRoot)
    await expect(stageTunnelClient({
      binaryPath: badVersion.binaryPath,
      manifestPath: badVersion.manifestPath,
      fetchBytes: async (url: string) => url.endsWith('SHA256SUMS.txt')
        ? new TextEncoder().encode(`${asset.archiveSha256}  ${asset.name}\n`)
        : archive,
      run: (_command, _args) => ({ status: 0, stdout: 'tunnel-client 0.0.11', stderr: '' }),
      releaseAsset: asset,
    })).rejects.toThrow(/version/i)
  })
})
