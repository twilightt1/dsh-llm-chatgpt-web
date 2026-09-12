import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  approveNativeChallenge,
  formatNativeApprovalChallenge,
  readNativeApprovalChallenge,
  requireNativeApproval,
  shellQuotePosix,
} from '../src/native/grants.ts'
import { NativeApprovalRequiredError, NativeSafetyError } from '../src/native/errors.ts'
import {
  assertPrivateRegularFile,
  durableAtomicWritePrivateFile,
} from '../src/native/private-files.ts'
import type { NativePolicySummary, PreparedNativeRequest } from '../src/native/types.ts'

function summary(root: string, tools: NativePolicySummary['tools'] = [{
  tool: 'read_file',
  capability: 'workspace.read',
  pathArguments: ['/path'],
  result: 'text',
  outputProvenance: 'operator-declared',
  schemaHash: 'a'.repeat(64),
}]): NativePolicySummary {
  return {
    toolPolicy: 'allowlist',
    workspaceRoot: root,
    workspaceRootSource: 'explicit',
    connectorName: 'DSH Native',
    connectorRuntime: 'external',
    approval: 'workspace-policy',
    tools,
    evidenceLimits: { maxBytes: 65_536, maxLines: 200 },
  }
}

function prepared(root: string, hash = 'b'.repeat(64), tools = summary(root).tools): PreparedNativeRequest {
  const options: GenerateOptions = {
    provider: 'chatgpt-web',
    model: 'chatgpt-web/high',
    messages: [],
    tools: tools.map(tool => ({
      name: tool.tool,
      description: tool.tool,
      parameters: { type: 'object' },
    })),
    sessionId: 'session-1' as never,
  }
  return {
    providerOptions: options,
    projectProviderMessages: messages => structuredClone(messages),
    policyHash: 'c'.repeat(64),
    inventoryHash: 'd'.repeat(64),
    approvalHash: hash,
    summary: summary(root, tools),
  }
}

async function profileRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-native-approval-'))
}

describe('native approval grants', () => {
  it('writes durable private files and refuses unsafe existing targets', async () => {
    const root = await profileRoot()
    try {
      const path = join(root, 'state.json')
      durableAtomicWritePrivateFile(path, '{"ok":true}\n')
      assertPrivateRegularFile(path, 'state')
      expect(readFileSync(path, 'utf8')).toBe('{"ok":true}\n')
      chmodSync(path, 0o644)
      expect(() => durableAtomicWritePrivateFile(path, 'unsafe\n')).toThrow(/unsafe|permission/i)
      expect(readFileSync(path, 'utf8')).toBe('{"ok":true}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires one exact challenge, approves it once, and validates the exact hash', async () => {
    const root = await profileRoot()
    const now = new Date('2026-01-01T00:00:00.000Z')
    try {
      const first = prepared(root)
      expect(() => requireNativeApproval(root, 'workspace-policy', first, now))
        .toThrowError(NativeApprovalRequiredError)
      const challenge = readNativeApprovalChallenge(root)
      expect(challenge).toMatchObject({ version: 1, approvalHash: first.approvalHash, summary: first.summary })
      expect(challenge?.expiresAt).toBe('2026-01-01T00:10:00.000Z')
      const commandError = (() => {
        try { requireNativeApproval(root, 'workspace-policy', first, now) } catch (error) { return error }
        return undefined
      })()
      expect(commandError).toMatchObject({ nativeCode: 'NATIVE_APPROVAL_REQUIRED' })
      expect(String((commandError as Error).message)).toContain("--profile-dir '")
      expect(String((commandError as Error).message)).toContain('--challenge \'challenge_')

      const grant = approveNativeChallenge({
        profileDir: root,
        challengeId: challenge!.challengeId,
        confirmation: 'approve',
        now: new Date('2026-01-01T00:01:00.000Z'),
      })
      expect(grant).toEqual({
        version: 1,
        approvalHash: first.approvalHash,
        approvedAt: '2026-01-01T00:01:00.000Z',
        summaryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(readNativeApprovalChallenge(root)).toBeUndefined()
      expect(() => requireNativeApproval(root, 'workspace-policy', first, new Date('2026-01-01T00:02:00.000Z'))).not.toThrow()
      expect(() => approveNativeChallenge({
        profileDir: root,
        challengeId: challenge!.challengeId,
        confirmation: 'approve',
        now,
      })).toThrow(/missing|claimed/i)

      const changed = prepared(root, 'e'.repeat(64))
      expect(() => requireNativeApproval(root, 'workspace-policy', changed, new Date('2026-01-01T00:02:00.000Z'))).toThrow(NativeApprovalRequiredError)
      const replacement = readNativeApprovalChallenge(root)
      expect(replacement?.approvalHash).toBe(changed.approvalHash)
      expect(replacement?.challengeId).not.toBe(challenge?.challengeId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not create state for none or an empty effective inventory', async () => {
    const root = await profileRoot()
    const emptyRoot = join(root, 'empty')
    try {
      expect(() => requireNativeApproval(root, 'none', prepared(root))).not.toThrow()
      expect(existsSync(join(root, 'native-approval'))).toBe(false)
      expect(() => requireNativeApproval(emptyRoot, 'workspace-policy', prepared(emptyRoot, 'f'.repeat(64), []), new Date()))
        .not.toThrow()
      expect(existsSync(join(emptyRoot, 'native-approval'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects expiry, future timestamps, wrong confirmation, races, and unsafe approval directories', async () => {
    const root = await profileRoot()
    const now = new Date('2026-01-01T00:00:00.000Z')
    try {
      const current = prepared(root)
      expect(() => requireNativeApproval(root, 'workspace-policy', current, now)).toThrow(NativeApprovalRequiredError)
      const challenge = readNativeApprovalChallenge(root)!
      expect(() => approveNativeChallenge({
        profileDir: root,
        challengeId: challenge.challengeId,
        confirmation: 'yes',
        now,
      })).toThrow(/exactly approve/i)
      expect(() => approveNativeChallenge({
        profileDir: root,
        challengeId: challenge.challengeId,
        confirmation: 'approve',
        now: new Date('2026-01-01T00:10:00.000Z'),
      })).toThrow(/expired/i)
      expect(readNativeApprovalChallenge(root)).toBeUndefined()

      expect(() => requireNativeApproval(root, 'workspace-policy', current, now)).toThrow(NativeApprovalRequiredError)
      const future = readNativeApprovalChallenge(root)!
      const pendingPath = join(root, 'native-approval', 'pending.json')
      writeFileSync(pendingPath, JSON.stringify({ ...future, createdAt: '2026-01-01T00:11:00.000Z', expiresAt: '2026-01-01T00:21:00.000Z' }))
      expect(() => requireNativeApproval(root, 'workspace-policy', current, now)).toThrow(NativeSafetyError)
      expect(() => approveNativeChallenge({
        profileDir: root,
        challengeId: future.challengeId,
        confirmation: 'approve',
        now,
      })).toThrow(/future/i)
      expect(readNativeApprovalChallenge(root)).toBeUndefined()

      expect(() => requireNativeApproval(root, 'workspace-policy', current, now)).toThrow(NativeApprovalRequiredError)
      const concurrent = readNativeApprovalChallenge(root)!
      expect(() => approveNativeChallenge({ profileDir: root, challengeId: concurrent.challengeId, confirmation: 'approve', now })).not.toThrow()
      expect(() => approveNativeChallenge({ profileDir: root, challengeId: concurrent.challengeId, confirmation: 'approve', now }))
        .toThrow(/missing|claimed/i)

      const outside = join(root, 'outside')
      mkdirSync(outside)
      const approvalPath = join(root, 'native-approval')
      rmSync(approvalPath, { recursive: true, force: true })
      symlinkSync(outside, approvalPath)
      expect(() => requireNativeApproval(root, 'workspace-policy', current, now)).toThrow(NativeSafetyError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses safe POSIX quoting and terminal-safe challenge display', async () => {
    expect(shellQuotePosix("a b'c$`d")).toBe("'a b'\"'\"'c$`d'")
    expect(shellQuotePosix('')).toBe("''")
    expect(() => shellQuotePosix('bad\nvalue')).toThrow(/control/i)
    const root = await profileRoot()
    try {
      const challenge = {
        ...readChallengeFixture(root),
        summary: { ...summary(root), workspaceRoot: `/tmp/terminal\u007f-safe` },
      }
      const rendered = formatNativeApprovalChallenge(challenge)
      expect(rendered).toContain('Policy implementation:')
      expect(rendered).toContain('Effective approval hash:')
      expect(rendered).toContain('\\u007f')
      expect(rendered).not.toContain('\u007f')
      expect(rendered).not.toContain('\u001b')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed on malformed extra-key state and keeps sensitive preimages out of approval records', async () => {
    const root = await profileRoot()
    try {
      const value = prepared(root)
      expect(() => requireNativeApproval(root, 'workspace-policy', value)).toThrow(NativeApprovalRequiredError)
      const pendingPath = join(root, 'native-approval', 'pending.json')
      const raw = readFileSync(pendingPath, 'utf8')
      expect(raw).not.toContain('prompt-sentinel')
      expect(raw).not.toContain('runtime-key-sentinel')
      const pending = JSON.parse(raw) as Record<string, unknown>
      durableAtomicWritePrivateFile(pendingPath, JSON.stringify({ ...pending, extra: 'nope' }))
      expect(() => requireNativeApproval(root, 'workspace-policy', value)).toThrow(NativeSafetyError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function readChallengeFixture(root: string) {
  return {
    version: 1 as const,
    challengeId: 'challenge_00000000-0000-4000-8000-000000000000',
    approvalHash: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
    summary: summary(root),
  }
}
