import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cleanupFixtures = vi.hoisted(() => ({
  ledger: {
    pending: vi.fn(() => [] as string[]),
    remember: vi.fn(),
    forget: vi.fn(),
  },
  deleteOwnedConversation: vi.fn(async () => {}),
  retryPendingConversationDeletions: vi.fn(async () => {}),
}))

const fixtures = vi.hoisted(() => {
  const stopLocator = {
    isVisible: vi.fn(async () => false),
    press: vi.fn(async () => {}),
  }
  const page = {
    isClosed: vi.fn(() => false),
    url: vi.fn(() => 'https://chatgpt.com/c/6aa191d8-a134-83ec-8f59-da2b18ec3024'),
    locator: vi.fn(() => ({ last: () => stopLocator })),
    close: vi.fn(async () => {}),
  }
  const browser = {
    ensureReady: vi.fn(async () => {}),
    newTurnPage: vi.fn(async () => page),
    persistSession: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    markProbed: vi.fn(),
  }
  const stream = vi.fn((..._args: unknown[]) => (async function* () {
    yield { type: 'delta', delta: 'answer' }
    return { kind: 'completed', text: 'answer', promptChars: 6 }
  })())
  const start = vi.fn(async (...args: unknown[]) => {
    const turnOptions = args[1] as { onPromptSubmitted?: () => void }
    turnOptions.onPromptSubmitted?.()
    const source = stream(...args) as AsyncIterable<{ type: 'delta'; delta: string } | unknown>
    const iterator = source[Symbol.asyncIterator]()
    return {
      nextBoundary: async function* () {
        for (;;) {
          const step = await iterator.next()
          if (step.done) return step.value
          yield step.value as { type: 'delta'; delta: string }
        }
      },
      deliverResults: vi.fn(async () => {}),
      markToolResultDelivered: vi.fn(),
      stop: vi.fn(async () => {}),
    }
  })
  return {
    browser,
    page,
    prepare: vi.fn(async () => {}),
    compile: vi.fn(() => 'prompt'),
    detect: vi.fn(async () => ({ solAvailable: true, proAvailable: true })),
    stream,
    start,
  }
})

vi.mock('../src/chatgpt/browser.ts', () => ({
  ChatGptBrowser: class {
    get probed(): boolean { return false }
    ensureReady = fixtures.browser.ensureReady
    newTurnPage = fixtures.browser.newTurnPage
    persistSession = fixtures.browser.persistSession
    close = fixtures.browser.close
    markProbed = fixtures.browser.markProbed
  },
}))
vi.mock('../src/chatgpt/prompt.ts', () => ({ compilePrompt: fixtures.compile }))
vi.mock('../src/chatgpt/conversation-cleanup.ts', () => ({
  conversationIdFromUrl: vi.fn(() => '6aa191d8-a134-83ec-8f59-da2b18ec3024'),
  createOwnedConversationLedger: vi.fn(() => cleanupFixtures.ledger),
  deleteOwnedConversation: cleanupFixtures.deleteOwnedConversation,
  retryPendingConversationDeletions: cleanupFixtures.retryPendingConversationDeletions,
}))
vi.mock('../src/chatgpt/session.ts', () => ({
  CHATGPT_COMPOSER_SELECTOR: '#prompt-textarea',
  detectChatGptAccountCapabilities: fixtures.detect,
}))
vi.mock('../src/chatgpt/turn.ts', () => ({
  COMPOSER_CHAR_BUDGET: 1000,
  prepareChatGptSurface: fixtures.prepare,
  startChatGptTurnSession: fixtures.start,
  streamTextTurn: fixtures.stream,
}))

import { createToolResultMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { ChatGptWebAdapter } from '../src/adapter.ts'
import { ManagedRuntimeTransportError } from '../src/native/tunnel-runtime.ts'
import { NativeRoundCoordinator } from '../src/native/coordinator.ts'
import { NativeToolBroker } from '../src/native/broker.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import type { Message, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'

const tool: ToolSchema = {
  name: 'write',
  description: 'write a file',
  parameters: { type: 'object' },
}
const userMessage: Message = {
  id: MessageId('user-1'),
  role: 'user',
  content: [{ type: 'text', text: 'answer' }],
  source: { kind: 'user' },
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function input(
  sessionId: string,
  tools: readonly ToolSchema[] = [tool],
  purpose?: 'compaction' | 'session-title',
): Parameters<ChatGptWebAdapter['stream']>[0] {
  return {
    provider: 'chatgpt-web',
    model: 'chatgpt-web/high',
    messages: [userMessage],
    tools: [...tools],
    sessionId: sessionId as never,
    ...(purpose === undefined ? {} : { purpose }),
  }
}

describe('native adapter lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the connector-enabled surface only for native tool turns', async () => {
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const nativeOptions = resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorRuntime: 'external',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const nativeAdapter = new ChatGptWebAdapter({
      options: () => nativeOptions,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    await collect(nativeAdapter.stream(input('native')))
    expect(fixtures.prepare).toHaveBeenCalledWith(expect.anything(), 'connector', nativeOptions.profileDir)
    expect(cleanupFixtures.retryPendingConversationDeletions).toHaveBeenCalledWith(expect.anything(), cleanupFixtures.ledger)
    const nativeStreamCall = (fixtures.stream.mock.calls as unknown as Array<[unknown, { surface?: unknown }]>)[0]
    expect(nativeStreamCall?.[1]).toMatchObject({ surface: 'connector' })
    await nativeAdapter.dispose()
    broker.close()

    const textOptions = resolveAdapterOptions({
      profileDir: '/tmp/dsh-text-adapter-test',
      brokerSocketPath: '/tmp/dsh-text-adapter-test.sock',
    })
    const textAdapter = new ChatGptWebAdapter({ options: () => textOptions })
    await collect(textAdapter.stream(input('text')))
    expect(fixtures.prepare).toHaveBeenLastCalledWith(expect.anything(), 'temporary', textOptions.profileDir)
    const textStreamCall = (fixtures.stream.mock.calls as unknown as Array<[unknown, { surface?: unknown }]>).at(-1)
    expect(textStreamCall?.[1]).toMatchObject({ surface: 'temporary' })
    await textAdapter.dispose()
  })

  it('records and deletes the owned normal-chat conversation after a native turn', async () => {
    const conversationId = '6aa191d8-a134-83ec-8f59-da2b18ec3024'
    fixtures.stream.mockImplementationOnce((...args: unknown[]) => {
      const turnOptions = args[1] as { onConversationCreated?: (id: string) => void }
      turnOptions.onConversationCreated?.(conversationId)
      return (async function* () {
        yield { type: 'delta', delta: 'answer' }
        return { kind: 'completed', text: 'answer', promptChars: 6 }
      })()
    })
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorRuntime: 'external',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    await collect(adapter.stream(input('s1')))
    expect(cleanupFixtures.ledger.remember).toHaveBeenCalledWith(conversationId)
    expect(cleanupFixtures.deleteOwnedConversation).toHaveBeenCalledWith(expect.anything(), conversationId)
    expect(cleanupFixtures.ledger.forget).toHaveBeenCalledWith(conversationId)
    await adapter.dispose()
    broker.close()
  })

  it('surfaces deletion failure and still closes the owned page', async () => {
    const conversationId = '6aa191d8-a134-83ec-8f59-da2b18ec3024'
    cleanupFixtures.deleteOwnedConversation.mockRejectedValueOnce(new Error('delete unavailable'))
    fixtures.stream.mockImplementationOnce((...args: unknown[]) => {
      const turnOptions = args[1] as { onConversationCreated?: (id: string) => void }
      turnOptions.onConversationCreated?.(conversationId)
      return (async function* () {
        yield { type: 'delta', delta: 'answer' }
        return { kind: 'completed', text: 'answer', promptChars: 6 }
      })()
    })
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorRuntime: 'external',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    await expect(collect(adapter.stream(input('s1')))).rejects.toThrow(/delete unavailable/i)
    expect(cleanupFixtures.ledger.forget).not.toHaveBeenCalled()
    expect(fixtures.page.close).toHaveBeenCalled()
    await adapter.dispose()
    broker.close()
  })

  it('does not let slow browser setup consume the native broker TTL', async () => {
    fixtures.browser.ensureReady.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 10,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    const chunks = await collect(adapter.stream(input('slow-setup')))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await adapter.dispose()
    broker.close()
  })

  it('does not allocate a browser page when managed readiness fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-adapter-ready-'))
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorRuntime: 'managed',
      profileDir: root,
      brokerSocketPath: join(root, 'broker.sock'),
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: {
        coordinator,
        ready: Promise.reject(new ManagedRuntimeTransportError('tunnel not ready')),
        assertConnection: () => {},
      },
    })

    await expect(collect(adapter.stream(input('s1')))).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(fixtures.browser.ensureReady).not.toHaveBeenCalled()
    expect(fixtures.browser.newTurnPage).not.toHaveBeenCalled()
    await adapter.dispose()
  })

  it.each(['session-title', 'compaction'] as const)('does not reserve a native round for %s model calls', async (purpose) => {
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const beginStep = vi.spyOn(coordinator, 'beginStep')
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      connectorRuntime: 'external',
      profileDir: '/tmp/dsh-native-adapter-title-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-title-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    await collect(adapter.stream(input(purpose, [], purpose)))
    expect(beginStep).not.toHaveBeenCalled()
    expect(fixtures.prepare).toHaveBeenCalledWith(expect.anything(), 'temporary', options.profileDir)
    await adapter.dispose()
    broker.close()
  })

  it('reserves the browser for MCP no-tool turns without attaching a connector', async () => {
    const gate = deferred<void>()
    fixtures.stream.mockImplementationOnce(() => (async function* () {
      yield { type: 'delta', delta: 'answer' }
      await gate.promise
      return { kind: 'completed', text: 'answer', promptChars: 6 }
    })())
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    const iterator = adapter.stream(input('s1', []))[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    expect(fixtures.stream).toHaveBeenCalled()
    const streamCall = (fixtures.stream.mock.calls as unknown as Array<[unknown, { native?: unknown }]>)[0]
    expect(streamCall?.[1]).not.toHaveProperty('native')

    const waiting = coordinator.beginStep({
      sessionId: 's2',
      messages: [],
      tools: [],
      ttlMs: 1_000,
      invocationTimeoutMs: 1_000,
    })
    const ownership = await Promise.race([
      waiting.then(() => 'granted' as const),
      new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 50)),
    ])
    expect(ownership).toBe('waiting')

    await iterator.return?.()
    const next = await waiting
    await next.complete(async () => {})
    await adapter.dispose()
  })

  it('preserves the empty completed-response block shape', async () => {
    fixtures.stream.mockImplementationOnce(() => (async function* () {
      return { kind: 'completed', text: '', promptChars: 6 }
    })())
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(input('s1'))) chunks.push(chunk)
    expect(chunks.slice(0, 2)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    await adapter.dispose()
    broker.close()
  })

  it('continues one physical response across tool-result streams without a second page', async () => {
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const invocationResults: Promise<unknown>[] = []
    const deliveredResults: unknown[] = []
    const activityId = 'activity_adapter_abcdefghijklmnop'
    fixtures.start.mockImplementationOnce(async (...args: unknown[]) => {
      const turnOptions = args[1] as {
        onPromptSubmitted?: () => void
        native?: {
          requestId: string
          takeToolBatch: (now?: number) => readonly { callId: string; name: string; arguments: Record<string, unknown> }[] | undefined
        }
      }
      turnOptions.onPromptSubmitted?.()
      const native = turnOptions.native
      if (native === undefined) throw new Error('native controls missing')
      let boundary = 0
      return {
        nextBoundary: async function* () {
          if (boundary++ === 0) {
            broker.start(native.requestId)
            broker.claimActivity(native.requestId, activityId)
            invocationResults.push(broker.invoke(native.requestId, activityId, 'write', { path: 'x' }))
            const calls = native.takeToolBatch(Date.now() + 100)
            if (calls === undefined) throw new Error('native call batch missing')
            return { kind: 'tool-batch', text: '', calls, promptChars: 6 }
          }
          broker.completeActivity(native.requestId, activityId)
          yield { type: 'delta', delta: 'done' }
          return { kind: 'completed', text: 'done', promptChars: 6 }
        },
        deliverResults: vi.fn(async (results: unknown[]) => { deliveredResults.push(results) }),
        markToolResultDelivered: vi.fn(),
        stop: vi.fn(async () => {}),
      }
    })
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    const first = await collect(adapter.stream(input('s1')))
    const callBlock = first.find((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> =>
      chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    const finish = first.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
    expect(callBlock?.block.type).toBe('tool-call')
    expect(finish?.reason.kind).toBe('tool-calls')
    if (callBlock?.block.type !== 'tool-call' || finish?.reason.kind !== 'tool-calls') throw new Error('missing native boundary')
    const assistant: Message = {
      id: MessageId('assistant-native-boundary-1'),
      role: 'assistant',
      content: [callBlock.block],
      source: {
        kind: 'model',
        provider: 'chatgpt-web',
        model: 'chatgpt-web/high',
        replayState: finish.replayState,
      },
    }
    const result = createToolResultMessage({
      callId: callBlock.block.id,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    const second = await collect(adapter.stream({
      ...input('s1'),
      messages: [userMessage, assistant, result],
    }))
    await expect(invocationResults[0]).resolves.toMatchObject({ isError: false })
    expect(deliveredResults).toEqual([])
    expect(second.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(fixtures.browser.newTurnPage).toHaveBeenCalledTimes(1)
    expect(fixtures.start).toHaveBeenCalledTimes(1)
    expect(fixtures.prepare).toHaveBeenCalledTimes(1)
    expect(fixtures.compile).toHaveBeenCalledTimes(1)
    await adapter.dispose()
    broker.close()
  })

  it('revokes an unfinished native lease when the consumer closes after finish', async () => {
    const broker = new NativeToolBroker()
    const coordinator = new NativeRoundCoordinator(broker)
    const options = resolveAdapterOptions({
      connectorTransport: 'mcp',
      profileDir: '/tmp/dsh-native-adapter-test',
      brokerSocketPath: '/tmp/dsh-native-adapter-test.sock',
      mcpInvocationTimeoutMs: 1_000,
    })
    const adapter = new ChatGptWebAdapter({
      options: () => options,
      native: { coordinator, ready: Promise.resolve(), assertConnection: () => {} },
    })

    const iterator = adapter.stream(input('s1'))[Symbol.asyncIterator]()
    let sawFinish = false
    for (;;) {
      const step = await iterator.next()
      if (step.done) break
      if (step.value.type === 'finish') {
        sawFinish = true
        break
      }
    }
    expect(sawFinish).toBe(true)
    await iterator.return?.()

    const next = await Promise.race([
      coordinator.beginStep({
        sessionId: 's2',
        messages: [],
        tools: [],
        ttlMs: 1_000,
        invocationTimeoutMs: 1_000,
      }),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 100)),
    ])
    expect(next).toBeDefined()
    if (next !== undefined) await next.complete(async () => {})
    await adapter.dispose()
  })
})
