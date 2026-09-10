import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquirePrivateWriterLease,
  currentProcessStartedAt,
  durableAtomicWritePrivateFile,
  ensurePrivateDirectory,
  inspectPrivateWriterLease,
} from '../src/native/private-files.ts'
import {
  NATIVE_SECURITY_STATE_MAX_AGE_MS,
  nativeSecuritySummaryHash,
  readNativeSecurityState,
  writeNativeSecurityState,
} from '../src/native/security-state.ts'
import { createNativeCheckpointStore } from '../src/native/checkpoint.ts'
import { approveNativeChallenge, readNativeApprovalChallenge, requireNativeApproval } from '../src/native/grants.ts'
import { tunnelReleaseAsset } from '../src/native/tunnel-install.ts'
import type { ManagedNativeRuntimeConfig } from '../src/native/runtime-config.ts'
import type { PreparedNativeRequest } from '../src/native/types.ts'
import { doctorManagedNativeRuntime, formatNativeDoctorReport } from '../src/native/setup.ts'

const HASH = 'a'.repeat(64)

function prepared(root: string): PreparedNativeRequest {
  return {
    providerOptions: {
      provider: 'chatgpt-web',
      model: 'chatgpt-web/high',
      messages: [],
      tools: [],
      sessionId: 'security-state-test' as never,
    },
    projectProviderMessages: messages => structuredClone(messages),
    policyHash: HASH,
    inventoryHash: 'b'.repeat(64),
    approvalHash: 'c'.repeat(64),
    summary: {
      policyImplementationVersion: '0.7.0',
      toolPolicy: 'evidence-only',
      workspaceRoot: root,
      workspaceRootSource: 'explicit',
      connectorName: 'DSH Native',
      connectorRuntime: 'managed',
      approval: 'workspace-policy',
      tools: [{
        tool: 'read_file',
        capability: 'workspace.read',
        pathArguments: ['/path'],
        result: 'sanitized-evidence',
        outputProvenance: 'operator-declared',
        schemaHash: 'd'.repeat(64),
      }],
      evidenceLimits: { maxBytes: 65_536, maxLines: 200 },
    },
    nativeRound: {
      coordinatorSnapshot: {
        sessionId: 'security-state-test',
        canonicalMessages: [],
        broker: { sessionId: 'security-state-test', tools: [], invocationTimeoutMs: 90_000 },
        policyHash: HASH,
        inventoryHash: 'b'.repeat(64),
        approvalHash: 'c'.repeat(64),
      },
      openRound: () => ({
        authorizeInvocation: () => ({ allowed: false, code: 'NATIVE_POLICY_DENIED', message: 'denied' }),
        projectResult: (_binding, result) => result,
      }),
    },
  }
}

describe('native security state snapshots', () => {
  it('writes a private, redacted, strictly-shaped snapshot and reads it without mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-security-state-'))
    const statePath = join(root, 'native-security-state.json')
    const request = prepared(root)
    writeNativeSecurityState(root, request, {
      pid: process.pid,
      startedAt: currentProcessStartedAt(),
    }, new Date('2026-01-01T00:00:00.000Z'))

    expect(lstatSync(statePath).mode & 0o777).toBe(0o600)
    const raw = readFileSync(statePath, 'utf8')
    expect(raw).not.toMatch(/"(?:messages|arguments|results|conversation|request[_-]?id|secret|token)"/i)
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'version', 'generatedAt', 'runtimeProcess', 'policyHash', 'inventoryHash',
      'approvalHash', 'workspaceRootSource', 'summary',
    ])
    const before = raw
    expect(readNativeSecurityState(root)).toMatchObject({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      runtimeProcess: { pid: process.pid, startedAt: currentProcessStartedAt() },
      policyHash: HASH,
      summary: { workspaceRoot: root, connectorName: 'DSH Native' },
    })
    expect(readFileSync(statePath, 'utf8')).toBe(before)
  })

  it('rejects malformed, symlinked, and incorrectly-modeled snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-security-state-invalid-'))
    const statePath = join(root, 'native-security-state.json')
    writeFileSync(statePath, '{"version":1}\n')
    chmodSync(statePath, 0o600)
    expect(() => readNativeSecurityState(root)).toThrow(/security state/i)

    writeFileSync(statePath, '{}\n')
    chmodSync(statePath, 0o644)
    expect(() => readNativeSecurityState(root)).toThrow(/security state/i)

    const target = join(root, 'target.json')
    durableAtomicWritePrivateFile(target, '{}\n')
    writeFileSync(statePath, '')
    // Replace the regular file with a symlink without asking the reader to repair it.
    unlinkSync(statePath)
    symlinkSync(target, statePath)
    expect(() => readNativeSecurityState(root)).toThrow(/security state/i)
  })

  it('does not treat an old snapshot as fresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-security-state-old-'))
    const request = prepared(root)
    writeNativeSecurityState(root, request, {
      pid: process.pid,
      startedAt: currentProcessStartedAt(),
    }, new Date(Date.now() - NATIVE_SECURITY_STATE_MAX_AGE_MS - 1))
    const report = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
    const check = report.checks.find(item => item.id === 'native.snapshot.freshness')
    expect(check?.status).toBe('warning')
    expect(report.ok).toBe(false)
  })
})

function managedConfig(root: string): ManagedNativeRuntimeConfig {
  const binaryPath = join(root, 'bin', 'tunnel-client')
  const keyPath = join(root, 'secrets', 'tunnel-runtime.key')
  const tunnelProfileDir = join(root, 'tunnel', 'profiles')
  ensurePrivateDirectory(join(root, 'bin'))
  ensurePrivateDirectory(join(root, 'secrets'))
  ensurePrivateDirectory(tunnelProfileDir)
  const binary = Buffer.from('#!/bin/sh\n')
  const binarySha256 = createHash('sha256').update(binary).digest('hex')
  const asset = tunnelReleaseAsset()
  durableAtomicWritePrivateFile(binaryPath, binary, 0o700)
  durableAtomicWritePrivateFile(keyPath, 'runtime-key\n')
  durableAtomicWritePrivateFile(join(root, 'bin', 'tunnel-client-manifest.json'), JSON.stringify({
    version: 1,
    tunnelClientVersion: '0.0.12',
    asset: asset.name,
    archiveSha256: asset.archiveSha256,
    binarySha256,
  }) + '\n')
  return {
    version: 1,
    connectorName: 'DSH Native',
    tunnelClient: { path: binaryPath, version: '0.0.12', sha256: binarySha256 },
    tunnel: {
      id: `tunnel_${'0'.repeat(32)}`,
      runtimeKeyFile: keyPath,
      profileDir: tunnelProfileDir,
      profileName: 'dsh-chatgpt-web',
      alias: 'dsh-chatgpt-web',
    },
  }
}

function directoryFingerprint(root: string): string {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name)
    const stat = lstatSync(path)
    const hash = stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''
    return [name, stat.ino, stat.mode, stat.size, stat.mtimeMs, hash].join(':')
  }).join('|')
}

describe('native doctor diagnostics', () => {
  it('uses stable check IDs and leaves a missing profile untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-state-'))
    const missing = join(root, 'missing-profile')
    const report = doctorManagedNativeRuntime({ profileDir: missing, connectorName: 'DSH Native' })
    expect(report.version).toBe(2)
    expect(report.checks.map(item => item.id)).toEqual(expect.arrayContaining([
      'native.platform',
      'native.managed.binary',
      'native.runtime.config',
      'native.connector.name',
      'native.workspace.root',
      'native.policy.schema',
      'native.policy.output-provenance',
      'native.approval.grant',
      'native.checkpoint.writer',
      'native.checkpoint.recovery',
      'native.cleanup.owned-conversations',
      'native.snapshot.freshness',
      'native.rollback.safe',
    ]))
    expect(lstatSync(missing, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('reports live, stale, and ambiguous writer leases without repairing them', () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-live-'))
    const liveLease = acquirePrivateWriterLease(liveRoot)
    expect(inspectPrivateWriterLease(liveRoot).state).toBe('live')
    liveLease.release()

    const staleRoot = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-stale-'))
    const staleLease = acquirePrivateWriterLease(staleRoot, {
      pid: 999_999_999,
      processStartedAt: new Date(Date.now() - 1_000).toISOString(),
      randomUUID: () => 'stale-owner-token',
      inspectProcess: () => ({ kind: 'dead' }),
    })
    expect(inspectPrivateWriterLease(staleRoot).state).toBe('stale')
    staleLease.release()

    const ambiguousRoot = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-ambiguous-'))
    const ambiguousLease = acquirePrivateWriterLease(ambiguousRoot, {
      pid: process.pid,
      processStartedAt: new Date(Date.now() - 1_000).toISOString(),
      randomUUID: () => 'ambiguous-owner-token',
    })
    expect(inspectPrivateWriterLease(ambiguousRoot).state).toBe('ambiguous')
    ambiguousLease.release()
  })

  it('reports broad output provenance and mismatched grants', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-grant-'))
    const request = prepared(root)
    const fullSummary = {
      ...request.summary,
      toolPolicy: 'full' as const,
      approval: 'workspace-policy' as const,
      tools: [{
        ...request.summary.tools[0]!,
        capability: 'full-unrestricted' as const,
        result: 'raw-unbounded' as const,
        outputProvenance: 'unverified-full' as const,
        pathArguments: [],
      }],
    }
    const fullRequest = { ...request, summary: fullSummary }
    writeNativeSecurityState(root, fullRequest, { pid: process.pid, startedAt: currentProcessStartedAt() })
    const provenance = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
      .checks.find(item => item.id === 'native.policy.output-provenance')
    expect(provenance?.status).toBe('warning')

    expect(() => requireNativeApproval(root, 'workspace-policy', fullRequest)).toThrow(/approve/i)
    const challenge = readNativeApprovalChallenge(root)!
    approveNativeChallenge({ profileDir: root, challengeId: challenge.challengeId, confirmation: 'approve' })
    const approved = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
      .checks.find(item => item.id === 'native.approval.grant')
    expect(approved?.status).toBe('ok')

    const grantPath = join(root, 'native-approval', 'grant.json')
    const grant = JSON.parse(readFileSync(grantPath, 'utf8')) as Record<string, unknown>
    durableAtomicWritePrivateFile(grantPath, JSON.stringify({
      ...grant,
      approvalHash: 'e'.repeat(64),
      summaryHash: nativeSecuritySummaryHash(fullSummary),
    }) + '\n')
    const mismatch = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
      .checks.find(item => item.id === 'native.approval.grant')
    expect(mismatch?.status).toBe('error')
  })

  it('keeps managed and external connector identities distinguishable', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-runtime-'))
    const config = managedConfig(root)
    durableAtomicWritePrivateFile(join(root, 'native-runtime.json'), JSON.stringify(config) + '\n')
    writeNativeSecurityState(root, prepared(root), {
      pid: process.pid,
      startedAt: currentProcessStartedAt(),
    })
    const runner = () => ({
      status: 0,
      stdout: '{"process_running":false,"healthy":false,"ready":false}',
      stderr: '',
    })
    const managed = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native', run: runner })
    expect(managed.config).toBe('ok')
    expect(managed.binary).toBe('ok')
    expect(managed.key).toBe('ok')
    expect(managed.profile).toBe('ok')
    expect(managed.checks.find(item => item.id === 'native.connector.runtime')?.status).toBe('ok')

    const externalSummary = { ...prepared(root).summary, connectorRuntime: 'external' as const }
    writeNativeSecurityState(root, { ...prepared(root), summary: externalSummary }, {
      pid: process.pid,
      startedAt: currentProcessStartedAt(),
    })
    const external = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native', run: runner })
    expect(external.checks.find(item => item.id === 'native.connector.runtime')?.status).toBe('warning')
  })

  it('reports checkpoint recovery and owned-conversation cleanup blockers', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-checkpoint-'))
    const store = createNativeCheckpointStore(root)
    const lease = store.acquire()
    store.begin(prepared(root))
    lease.release()
    durableAtomicWritePrivateFile(join(root, 'owned-conversations.json'), JSON.stringify({
      version: 1,
      conversationIds: ['00000000-0000-4000-8000-000000000000'],
    }) + '\n')
    const report = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
    expect(report.checks.find(item => item.id === 'native.checkpoint.recovery')?.status).toBe('error')
    expect(report.checks.find(item => item.id === 'native.cleanup.owned-conversations')?.status).toBe('error')
    expect(report.checks.find(item => item.id === 'native.rollback.safe')?.status).toBe('warning')
  })

  it('does not mutate profile entries when producing human or JSON output', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-readonly-'))
    durableAtomicWritePrivateFile(join(root, 'marker'), 'unchanged\n')
    const before = directoryFingerprint(root)
    const report = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
    formatNativeDoctorReport(report, false)
    formatNativeDoctorReport(report, true)
    expect(directoryFingerprint(root)).toBe(before)
  })

  it('escapes terminal control bytes in human output', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-doctor-output-'))
    const report = doctorManagedNativeRuntime({ profileDir: root, connectorName: 'DSH Native' })
    const unsafe = {
      ...report,
      checks: [{ id: 'native.test', status: 'warning' as const, summary: 'bad\u001b]8;;https://evil\u0007' }],
      issues: ['bad\u001b]8;;https://evil\u0007'],
    }
    const output = formatNativeDoctorReport(unsafe, false)
    expect(output).not.toContain('\u001b')
    expect(output).toContain('\\u001b')
  })
})
