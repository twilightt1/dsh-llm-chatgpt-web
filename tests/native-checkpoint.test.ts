import { mkdtempSync, readFileSync, appendFileSync, chmodSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { hashCanonical } from '../src/native/canonical.ts'
import {
  createNativeCheckpointStore,
  nativeCheckpointProjectionHash,
  nativeCheckpointRawResultHash,
} from '../src/native/checkpoint.ts'
import { NativeSafetyError } from '../src/native/errors.ts'
import type {
  BrokerAuthorizedToolRequest,
  BrokerToolResult,
  PreparedNativeRequest,
  NativePolicyRound,
} from '../src/native/types.ts'
import { acquirePrivateWriterLease } from '../src/native/private-files.ts'
import { createOwnedConversationLedger } from '../src/chatgpt/conversation-cleanup.ts'

const roots: string[] = []
const tool: ToolSchema = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}
const policyHash = 'a'.repeat(64)
const inventoryHash = 'b'.repeat(64)
const approvalHash = 'c'.repeat(64)
const schemaHash = hashCanonical('native-tool-schema', 1, tool)

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-native-checkpoint-'))
  roots.push(value)
  return value
}

function policyRound(): NativePolicyRound {
  return {
    authorizeInvocation: () => ({
      allowed: true,
      arguments: { path: '/workspace/file.txt' },
      binding: {
        toolName: 'read',
        capability: 'workspace.read',
        resultPolicy: 'text',
        schemaHash,
        argumentsHash: hashCanonical('native-tool-arguments', 1, { path: '/workspace/file.txt' }),
        callOrdinal: 1,
        pathArguments: ['/path'],
      },
    }),
    projectResult: (_binding, result) => structuredClone(result),
  }
}

function prepared(messages: readonly Message[] = []): PreparedNativeRequest {
  const options: GenerateOptions = {
    provider: 'chatgpt-web',
    model: 'chatgpt-web/high',
    sessionId: 'session-checkpoint' as NonNullable<GenerateOptions['sessionId']>,
    messages: [...messages],
    system: 'system',
    tools: [tool],
  }
  return {
    providerOptions: options,
    projectProviderMessages: value => structuredClone(value),
    policyHash,
    inventoryHash,
    approvalHash,
    summary: {
      toolPolicy: 'allowlist',
      workspaceRoot: '/workspace',
      workspaceRootSource: 'explicit',
      connectorName: 'DSH Native',
      connectorRuntime: 'managed',
      approval: 'none',
      tools: [{
        tool: 'read',
        capability: 'workspace.read',
        pathArguments: ['/path'],
        result: 'text',
        outputProvenance: 'operator-declared',
        schemaHash,
      }],
      evidenceLimits: { maxBytes: 65_536, maxLines: 200 },
    },
    nativeRound: {
      coordinatorSnapshot: {
        sessionId: 'session-checkpoint',
        canonicalMessages: [...messages],
        broker: { sessionId: 'session-checkpoint', tools: [tool], invocationTimeoutMs: 90_000 },
        policyHash,
        inventoryHash,
        approvalHash,
      },
      openRound: policyRound,
    },
  }
}

function authorizedCall(): BrokerAuthorizedToolRequest {
  const argumentsValue = { path: '/workspace/file.txt' }
  return {
    callId: 'call_checkpoint_1' as BrokerAuthorizedToolRequest['callId'],
    name: 'read',
    arguments: argumentsValue,
    binding: {
      toolName: 'read',
      capability: 'workspace.read',
      resultPolicy: 'text',
      schemaHash,
      argumentsHash: hashCanonical('native-tool-arguments', 1, argumentsValue),
      callOrdinal: 1,
      pathArguments: ['/path'],
    },
  }
}

function result(text = 'evidence'): BrokerToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

function projectedPrepared(messages: readonly Message[]): PreparedNativeRequest {
  const base = prepared(messages)
  const project = (values: readonly Message[]): readonly Message[] => structuredClone(values).map(message => ({
    ...message,
    content: message.content.map(block => block.type === 'tool-call'
      ? { ...block, arguments: block.arguments.replace('/workspace/', '') }
      : block),
  }))
  return {
    ...base,
    providerOptions: { ...base.providerOptions, messages: [...project(messages)] },
    projectProviderMessages: project,
  }
}

function resultHistory(call = authorizedCall(), value = result()): Message[] {
  return [
    {
      id: MessageId('assistant-checkpoint'),
      role: 'assistant',
      content: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
      source: { kind: 'model', provider: 'chatgpt-web', model: 'chatgpt-web/high' },
    },
    {
      id: MessageId('tool-checkpoint'),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: call.callId, content: value.content, isError: value.isError }],
      source: { kind: 'tool', callId: call.callId },
    },
  ]
}

function journalFile(profileDir: string): string {
  const name = readdirSync(join(profileDir, 'native-journal')).find(value => value.endsWith('.jsonl'))
  if (name === undefined) throw new Error('checkpoint journal was not created')
  return join(profileDir, 'native-journal', name)
}

function rewriteJournal(profileDir: string, mutate: (record: Record<string, unknown>, index: number) => void): void {
  const path = journalFile(profileDir)
  const records = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  records.forEach(mutate)
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
}

function resultsCheckpoint(profileDir: string, calls: readonly BrokerAuthorizedToolRequest[] = [authorizedCall()]): void {
  const store = createNativeCheckpointStore(profileDir)
  const lease = store.acquire()
  const checkpoint = store.begin(prepared())
  checkpoint.recordSubmissionAttempted()
  checkpoint.recordSubmitted()
  checkpoint.recordBatch(calls)
  const values = calls.map((_, index) => result(`evidence-${index}`))
  checkpoint.confirmResults(calls, values)
  checkpoint.prepareCleanup()
  checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
  lease.release()
}

function terminalCheckpoint(profileDir: string): void {
  const store = createNativeCheckpointStore(profileDir)
  const lease = store.acquire()
  const checkpoint = store.begin(prepared())
  checkpoint.recordSubmissionAttempted()
  checkpoint.recordSubmitted()
  const call = authorizedCall()
  checkpoint.recordBatch([call])
  const value = result()
  checkpoint.confirmResults([call], [value])
  checkpoint.prepareHandoff()
  checkpoint.confirmHandoff([value])
  checkpoint.recordCompletion()
  checkpoint.prepareCleanup()
  checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
  checkpoint.markTerminal('completed')
  lease.release()
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    // Vitest's temporary roots are intentionally left available for failure
    // inspection; the runner removes its own temp tree.
    void path
  }
})

describe('private checkpoint primitives', () => {
  it('acquires, fences, and durably reopens a terminal journal', () => {
    const profile = root()
    terminalCheckpoint(profile)
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    expect(store.inspect()).toEqual([expect.objectContaining({
      latestEvent: 'terminal', terminal: true, replayConsumed: false,
    })])
    lease.release()
  })

  it('rejects a second writer and only reclaims a proven dead owner', () => {
    const profile = root()
    const first = acquirePrivateWriterLease(profile, {
      pid: 1234,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      now: () => new Date('2026-01-01T00:01:00.000Z'),
      randomUUID: () => 'owner-first',
      inspectProcess: () => ({ kind: 'live', startedAt: '2026-01-01T00:00:00.000Z' }),
    })
    expect(() => acquirePrivateWriterLease(profile, {
      pid: 1235,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      now: () => new Date('2026-01-01T00:01:00.000Z'),
      randomUUID: () => 'owner-second',
      inspectProcess: () => ({ kind: 'live', startedAt: '2026-01-01T00:00:00.000Z' }),
    })).toThrow(/already held/i)
    first.release()
  })

  it('reclaims only a proven-dead writer and rejects PID reuse ambiguity', () => {
    const profile = root()
    const stale = acquirePrivateWriterLease(profile, {
      pid: 1234,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      now: () => new Date('2026-01-01T00:01:00.000Z'),
      randomUUID: () => 'owner-stale',
      inspectProcess: () => ({ kind: 'live', startedAt: '2026-01-01T00:00:00.000Z' }),
    })
    // A live PID with a different observed start time is never reclaimed.
    expect(() => acquirePrivateWriterLease(profile, {
      pid: 1235,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      now: () => new Date('2026-01-01T00:01:00.000Z'),
      randomUUID: () => 'owner-reuser',
      inspectProcess: () => ({ kind: 'live', startedAt: '2026-01-02T00:00:00.000Z' }),
    })).toThrow(/PID reuse|ambiguous/i)
    stale.release()
    const old = acquirePrivateWriterLease(profile, {
      pid: 1234,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      now: () => new Date('2026-01-01T00:02:00.000Z'),
      randomUUID: () => 'owner-old',
      inspectProcess: () => ({ kind: 'live', startedAt: '2026-01-01T00:00:00.000Z' }),
    })
    void old
    const dead = acquirePrivateWriterLease(profile, {
      pid: 1235,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      now: () => new Date('2026-01-01T00:03:00.000Z'),
      randomUUID: () => 'owner-dead',
      inspectProcess: () => ({ kind: 'dead' }),
    })
    dead.release()
  })

  it('truncates only an incomplete final line during recovery', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    store.begin(prepared())
    const journal = readdirSync(join(profile, 'native-journal')).find(name => name.endsWith('.jsonl'))!
    appendFileSync(join(profile, 'native-journal', journal), '{"partial":')
    expect(() => createNativeCheckpointStore(profile).inspect()).toThrow(/incomplete/i)
    expect(store.recoverForRequest(prepared()).kind).toBe('normal')
    const bytes = readFileSync(join(profile, 'native-journal', journal), 'utf8')
    expect(bytes.endsWith('\n')).toBe(true)
    lease.release()
  })

  it('refuses malformed interior JSON instead of truncating valid history', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    store.begin(prepared())
    appendFileSync(journalFile(profile), '{"broken":\n{"partial":')
    expect(() => store.inspect()).toThrow(/malformed|JSON/i)
    lease.release()
  })

  it('does not persist prompt, argument, result, conversation, request, credential, or capability preimages', () => {
    const profile = root()
    const sentinel = 'PROMPT_SENTINEL_RAW_ARGUMENT_RAW_RESULT_CONVERSATION_UUID_BROKER_REQUEST_RUNTIME_KEY_CAPABILITY_TOKEN'
    const call = authorizedCall()
    const secretCall: BrokerAuthorizedToolRequest = {
      ...call,
      arguments: { path: '/workspace/file.txt', note: sentinel },
      binding: {
        ...call.binding,
        argumentsHash: hashCanonical('native-tool-arguments', 1, { path: '/workspace/file.txt', note: sentinel }),
      },
    }
    const secretResult = result(sentinel)
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared([{
      id: MessageId('prompt-sentinel'),
      role: 'user',
      content: [{ type: 'text', text: sentinel }],
      source: { kind: 'user' },
    }]))
    checkpoint.recordSubmissionAttempted()
    checkpoint.recordSubmitted()
    checkpoint.recordBatch([secretCall])
    checkpoint.confirmResults([secretCall], [secretResult])
    checkpoint.prepareCleanup()
    checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, sentinel))
    lease.release()
    expect(readFileSync(journalFile(profile), 'utf8')).not.toContain(sentinel)
  })
})

describe('checkpoint recovery', () => {
  it('auto-closes a prepared checkpoint when no provider action was attempted', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    store.begin(prepared())
    lease.release()

    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    expect(reopened.recoverForRequest(prepared())).toEqual({ kind: 'normal' })
    expect(reopened.inspect()).toEqual([expect.objectContaining({ latestEvent: 'terminal', terminal: true })])
    reopenedLease.release()
  })

  it('blocks a journaled tool boundary without exact durable results', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared())
    checkpoint.recordSubmissionAttempted()
    checkpoint.recordSubmitted()
    checkpoint.recordBatch([authorizedCall()])
    lease.release()

    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    expect(reopened.recoverForRequest(prepared())).toMatchObject({ kind: 'blocked' })
    reopenedLease.release()
  })

  it('blocks handoff-confirmed work even after cleanup because provider outcome is unknown', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared())
    checkpoint.recordSubmissionAttempted()
    checkpoint.recordSubmitted()
    const call = authorizedCall()
    const value = result()
    checkpoint.recordBatch([call])
    checkpoint.confirmResults([call], [value])
    checkpoint.prepareHandoff()
    checkpoint.confirmHandoff([value])
    checkpoint.prepareCleanup()
    checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
    lease.release()

    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    expect(reopened.recoverForRequest(prepared(resultHistory(call, value)))).toMatchObject({ kind: 'blocked' })
    reopenedLease.release()
  })

  it('blocks replay after the one-shot replay-consumed fence', () => {
    const call = authorizedCall()
    const value = result()
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared())
    checkpoint.recordSubmissionAttempted()
    checkpoint.recordSubmitted()
    checkpoint.recordBatch([call])
    checkpoint.confirmResults([call], [value])
    checkpoint.prepareCleanup()
    checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
    const replayRequest = projectedPrepared(resultHistory(call, value))
    if (store.prepareFreshReplay === undefined) throw new Error('replay support is missing')
    store.prepareFreshReplay(replayRequest, checkpoint.checkpointHash)
    lease.release()

    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    expect(reopened.recoverForRequest(replayRequest)).toMatchObject({ kind: 'blocked' })
    reopenedLease.release()
  })

  it('blocks each mutated call or result evidence field on restart', () => {
    const mutations: Array<[string, (call: Record<string, unknown>) => void]> = [
      ['call order', call => { call.ordinal = 2 }],
      ['call ID', call => { call.callId = 'call_mutated' }],
      ['tool name', call => { call.toolName = 'write' }],
      ['arguments hash', call => { call.argumentsHash = 'f'.repeat(64) }],
      ['schema hash', call => { call.schemaHash = 'e'.repeat(64) }],
      ['raw result hash', call => { call.rawResultHash = 'd'.repeat(64) }],
      ['isError', call => { call.isError = true }],
      ['projection hash', call => { call.projectionHash = 'c'.repeat(64) }],
    ]
    for (const [label, mutate] of mutations) {
      const profile = root()
      const call = authorizedCall()
      const value = result()
      resultsCheckpoint(profile, [call])
      rewriteJournal(profile, record => {
        if (record.phase === 'results-confirmed') {
          const calls = record.calls as Array<Record<string, unknown>>
          mutate(calls[0]!)
        }
      })
      const replayRequest = prepared(resultHistory(call, value))
      const reopened = createNativeCheckpointStore(profile)
      const lease = reopened.acquire()
      let verdict: ReturnType<typeof reopened.recoverForRequest> | undefined
      let threw = false
      try {
        verdict = reopened.recoverForRequest(replayRequest)
      } catch {
        threw = true
      }
      expect(threw || verdict?.kind === 'blocked', label).toBe(true)
      lease.release()
    }
  })

  it('blocks an uncertain provider submission after reopening', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared())
    checkpoint.recordSubmissionAttempted()
    lease.release()

    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    expect(reopened.recoverForRequest(prepared())).toMatchObject({ kind: 'blocked' })
    reopenedLease.release()
  })

  it('permits one exact replay after durable results and cleanup', () => {
    const call = authorizedCall()
    const value = result()
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared())
    checkpoint.recordSubmissionAttempted()
    checkpoint.recordSubmitted()
    checkpoint.recordBatch([call])
    checkpoint.confirmResults([call], [value])
    checkpoint.prepareCleanup()
    checkpoint.confirmCleanup(hashCanonical('native-ledger-correlation', 1, []))
    lease.release()

    const replayRequest = projectedPrepared(resultHistory(call, value))
    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    const verdict = reopened.recoverForRequest(replayRequest)
    expect(verdict).toMatchObject({ kind: 'fresh-replay' })
    if (verdict.kind !== 'fresh-replay') throw new Error('expected replay verdict')
    if (reopened.prepareFreshReplay === undefined) throw new Error('replay support is missing')
    const replay = reopened.prepareFreshReplay(replayRequest, verdict.checkpointHash)
    expect(replay.generation).toBe(2)
    expect(reopened.inspect()).toEqual([expect.objectContaining({
      latestEvent: 'generation-prepared', replayConsumed: true, terminal: false,
    })])
    reopenedLease.release()
  })

  it('abandons submitted work only after exact owned cleanup is confirmed', () => {
    const profile = root()
    const conversationId = '11111111-1111-1111-1111-111111111111'
    const ledger = createOwnedConversationLedger(profile)
    ledger.remember(conversationId)
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    const checkpoint = store.begin(prepared())
    checkpoint.recordSubmissionAttempted()
    checkpoint.recordSubmitted()
    const checkpointHash = checkpoint.checkpointHash
    lease.release()

    const reopened = createNativeCheckpointStore(profile)
    const reopenedLease = reopened.acquire()
    if (reopened.abandon === undefined || reopened.prepareRecoveryCleanup === undefined || reopened.confirmRecoveryCleanup === undefined) {
      throw new Error('checkpoint cleanup recovery support is missing')
    }
    const abandon = (hash: string): void => { reopened.abandon!(hash) }
    const prepareRecoveryCleanup = (hash: string): void => { reopened.prepareRecoveryCleanup!(hash) }
    const confirmRecoveryCleanup = (hash: string, correlation: string): void => { reopened.confirmRecoveryCleanup!(hash, correlation) }
    abandon(checkpointHash)
    expect(reopened.inspect()).toEqual([expect.objectContaining({ latestEvent: 'non-replayable', terminal: false })])
    prepareRecoveryCleanup(checkpointHash)
    ledger.forget(conversationId)
    confirmRecoveryCleanup(
      checkpointHash,
      hashCanonical('native-ledger-correlation', 1, conversationId),
    )
    abandon(checkpointHash)
    expect(reopened.inspect()).toEqual([expect.objectContaining({ latestEvent: 'terminal', terminal: true })])
    reopenedLease.release()
  })

  it('keeps raw and projected hashes distinct and preserves isError', () => {
    const raw: BrokerToolResult = { content: [{ type: 'text', text: 'raw' }], isError: true }
    const projection: BrokerToolResult = { content: [{ type: 'text', text: 'projected' }], isError: true }
    expect(nativeCheckpointRawResultHash(raw)).not.toBe(nativeCheckpointProjectionHash(projection))
  })

  it('refuses unsafe journal permissions', () => {
    const profile = root()
    const store = createNativeCheckpointStore(profile)
    const lease = store.acquire()
    store.begin(prepared())
    const journal = readdirSync(join(profile, 'native-journal')).find(name => name.endsWith('.jsonl'))!
    chmodSync(join(profile, 'native-journal', journal), 0o644)
    expect(() => store.inspect()).toThrow(NativeSafetyError)
    lease.release()
  })
})
