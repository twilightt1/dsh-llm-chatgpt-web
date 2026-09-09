import z from "@deepseek-ai/schemastery";
import { CallId, ContentBlock, GenerateOptions, LlmAdapter, LlmError, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, Message, ModelModality, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk, ToolSchema } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
//#region src/native/types.d.ts
/** A provider-side tool request handed to the DSH agent loop. */
interface BrokerToolRequest {
  readonly callId: CallId;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
/** A DSH tool result held until the model-facing result is available. */
interface BrokerToolResult {
  readonly content: ContentBlock[];
  readonly isError: boolean;
}
/** Immutable facts captured when one provider round is registered. */
interface BrokerRoundSnapshot {
  readonly sessionId: string;
  readonly tools: readonly ToolSchema[];
  readonly invocationTimeoutMs: number;
}
/** JSON-RPC request/response values used by the private broker socket. */
interface BrokerRpcError {
  readonly message: string;
}
interface BrokerRpcResponse<T = unknown> {
  readonly id: string;
  readonly result?: T;
  readonly error?: string;
}
//#endregion
//#region src/native/broker.d.ts
/**
 * In-memory owner-side broker for one native ChatGPT provider round.
 *
 * The MCP subprocess sees only the socket façade. The adapter/coordinator keep
 * this object in-process so tool calls retain ordinary DSH loop ownership.
 */
declare class NativeToolBroker {
  private readonly rounds;
  private readonly retired;
  private closed;
  register(input: BrokerRoundSnapshot & {
    readonly ttlMs: number;
  }): string;
  start(requestId: string): {
    started: true;
    duplicate: boolean;
  };
  claimActivity(requestId: string, activityId: string): BrokerRoundSnapshot;
  completeActivity(requestId: string, activityId: string): void;
  invoke(requestId: string, activityId: string, name: string, args: Record<string, unknown>): Promise<BrokerToolResult>;
  takeToolBatch(requestId: string, now?: number): readonly BrokerToolRequest[] | undefined;
  beginSettlement(requestId: string): void;
  completeTool(requestId: string, callId: CallId, result: BrokerToolResult): void;
  waitForQuiescence(requestId: string, signal?: AbortSignal): Promise<void>;
  beginCompletionFence(requestId: string): number | undefined;
  commitCompletionFence(requestId: string, revision: number): boolean;
  revoke(requestId: string, reason?: Error): void;
  waitForRetirement(requestId: string, signal?: AbortSignal): Promise<void>;
  close(): void;
  private requireRound;
  private requestsFor;
  private wait;
  private resolveWaiter;
  private rejectWaiter;
  private settleQuiescence;
  private assertActivityId;
  private rememberRetired;
}
//#endregion
//#region src/native/coordinator.d.ts
/** Cleanup owned by one browser turn; stop preserves the page until close follows. */
type NativeRoundCleanup = (mode: 'stop' | 'close') => Promise<void>;
/** The adapter-facing lease for one registered provider round. */
interface NativeStepLease {
  readonly requestId: string;
  bindCleanup(cleanup: NativeRoundCleanup): void;
  takeToolBatch(now?: number): readonly BrokerToolRequest[] | undefined;
  beginCompletionFence(): number | undefined;
  commitCompletionFence(revision: number): boolean;
  park(cleanup: NativeRoundCleanup): Promise<void>;
  complete(cleanup: NativeRoundCleanup): Promise<void>;
  fail(cleanup: NativeRoundCleanup, cause: Error): Promise<void>;
}
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}
interface BeginStepInput {
  readonly sessionId: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSchema[];
  readonly ttlMs: number;
  readonly invocationTimeoutMs: number;
  readonly signal?: AbortSignal;
}
interface BeginWaiter {
  readonly input: BeginStepInput;
  readonly deferred: Deferred<NativeStepLease>;
  onAbort?: () => void;
}
type LeaseState = 'open' | 'parked' | 'transitioning' | 'terminal';
declare class RoundRecord {
  readonly sessionId: string;
  readonly requestId: string;
  readonly lease: NativeLease;
  state: LeaseState;
  cleanup: NativeRoundCleanup | undefined;
  cleanupCalled: boolean;
  released: boolean;
  retired: boolean;
  resumeWaiter: BeginWaiter | undefined;
  constructor(owner: NativeRoundCoordinator, sessionId: string, requestId: string);
}
/**
 * Correlate the durable tool results for one broker batch.
 *
 * Results not belonging to the pending batch are intentionally ignored: the
 * session can contain older completed calls. Every pending call must occur
 * exactly once, and image-bearing results are rejected before they can be
 * replayed through the text-only ChatGPT connector.
 */
declare function correlateToolResults(messages: readonly Message[], calls: readonly BrokerToolRequest[]): readonly BrokerToolResult[];
declare class NativeLease implements NativeStepLease {
  private readonly owner;
  private readonly record;
  readonly requestId: string;
  constructor(owner: NativeRoundCoordinator, record: RoundRecord, requestId: string);
  bindCleanup(cleanup: NativeRoundCleanup): void;
  takeToolBatch(now?: number): readonly BrokerToolRequest[] | undefined;
  beginCompletionFence(): number | undefined;
  commitCompletionFence(revision: number): boolean;
  park(cleanup: NativeRoundCleanup): Promise<void>;
  complete(cleanup: NativeRoundCleanup): Promise<void>;
  fail(cleanup: NativeRoundCleanup, cause: Error): Promise<void>;
  private setCleanup;
  private assertOpen;
}
/** Serialize one browser reservation while giving its parked owner priority. */
declare class NativeRoundCoordinator {
  readonly broker: NativeToolBroker;
  private reservation;
  private readonly waiters;
  private draining;
  private disposed;
  constructor(broker: NativeToolBroker);
  beginStep(input: BeginStepInput): Promise<NativeStepLease>;
  stopAtTurnBoundary(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  currentRecord(): RoundRecord | undefined;
  /** Called by a lease only after it has transferred page ownership. */
  watchParkedRound(record: RoundRecord): void;
  private scheduleDrain;
  private drain;
  private takeNextWaiter;
  private grant;
  private resume;
  private registerFresh;
  finish(record: RoundRecord, mode: 'stop' | 'close', cleanup: NativeRoundCleanup | undefined, cause?: Error): Promise<void>;
  private releaseRecord;
  private watchRetirement;
  private onRetired;
  private rejectQueuedSession;
  private resolveWaiter;
  private rejectWaiter;
  private removeAbortListener;
}
//#endregion
//#region src/adapter.d.ts
/** Transport used to connect ChatGPT to DSH tools. */
type ConnectorTransport = 'text' | 'mcp';
/** One advisory model entry (the id is the DSH-facing slug). */
interface ChatGptWebCatalogModel {
  /** DSH model id, e.g. `chatgpt-web/high`. */
  id: string;
  /** Selector label; defaults to {@link id}. */
  name?: string;
  /** Optional selector detail. */
  description?: string;
  /** Known combined request/response context capacity. */
  contextWindow?: number;
  /** Per-request output cap for this model. */
  maxTokens?: number;
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[];
}
/** Validated connection facts for one operation (re-read per operation). */
interface ChatGptWebConnectionOptions {
  /** Profile home for the login session. */
  profileDir: string;
  /** System Chrome executable; `undefined` means Playwright's bundled Chromium. */
  chromeExecutablePath: string | undefined;
  /** Run turns headed (default false; first login is always headed). */
  headed: boolean;
  /** Headed but placed off-screen (default true; login stays on-screen). */
  offscreen: boolean;
  /** Daemon idle shutdown (default 30 minutes without turns). */
  daemonIdleMs: number;
  /** Budget for the manual sign-in window. */
  loginTimeoutMs: number;
  /** Whole-turn budget. */
  turnTimeoutMs: number;
  /** No-output-growth budget while a turn is expected to stream. */
  stallTimeoutMs: number;
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number;
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number;
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly ChatGptWebCatalogModel[];
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy;
  /** ChatGPT tool transport; text remains the default. */
  connectorTransport: ConnectorTransport;
  /** Exact ChatGPT connector title used by the native MCP transport. */
  connectorName: string;
  /** Private Unix socket endpoint used by the native MCP façade. */
  brokerSocketPath: string;
  /** Native MCP invocation and broker TTL budget. */
  mcpInvocationTimeoutMs: number;
}
/** Constructor options: the operation-local resolution hooks the plugin owns. */
interface ChatGptWebAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => ChatGptWebConnectionOptions;
  /** Plugin-owned native broker lifecycle; omitted for the default text path. */
  native?: {
    readonly coordinator: NativeRoundCoordinator;
    readonly ready: Promise<void>;
  };
}
/**
 * ChatGPT Web adapter. One instance owns one browser; concurrent `stream()`
 * calls are serialized so at most one Temporary Chat page is ever active.
 */
declare class ChatGptWebAdapter extends LlmAdapter {
  private readonly config;
  private browser;
  private browserKey;
  private capabilities;
  private queue;
  /** One-shot retry notices keyed by session (consumed on next turn). */
  private pendingNotices;
  constructor(config: ChatGptWebAdapterOptions);
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  /** Stop a parked native round at a durable agent turn boundary. */
  stopNativeRound(sessionId: string): Promise<void>;
  /** Release the owned browser. Hosts should call this on plugin unload. */
  dispose(): Promise<void>;
  /** Serialize turns: one page at a time, in call order. */
  private enqueue;
  private browserFor;
  /** Consume (get + delete) the pending retry notice for this session, if any. */
  private takeNotice;
  /** Remember a retry notice for the session's next turn. */
  private stashNotice;
  /**
   * Detect the echo failure mode (observed live: a 130k-char reply that was
   * the compiled prompt rendered back, marker structure and all, instead of
   * an answer). Echo ⇒ the whole reply is wasted tokens; fail fast with a
   * non-retryable diagnostic and a retry notice for the next turn.
   */
  private isEcho;
  /**
   * Close the turn: text block-end, parsed tool calls, usage, terminal
   * finish. Live text deltas already streamed as block 0; calls follow in
   * source order with fresh indexes (assembler joins them deterministically).
   */
  private emitTurnResult;
  private runTurn;
}
//#endregion
//#region src/chatgpt/prompt.d.ts
/** Binding for the opt-in native ChatGPT MCP connector contract. */
interface NativePromptBinding {
  readonly requestId: string;
  readonly connectorName: string;
}
/**
 * Compile one ChatGPT prompt: transport contract + JSON context envelope.
 *
 * The contract mirrors the upstream shared contract (role semantics, read
 * before acting, no echo, no transport talk) adapted to DSH: the tool
 * protocol rides as its own section and the reminder keeps last-token
 * position.
 */
declare function compilePrompt(options: GenerateOptions, maxChars: number, notice?: string, native?: NativePromptBinding): string;
//#endregion
//#region src/index.d.ts
declare const name = "llm-chatgpt-web";
declare const inject: string[];
/** The single provider route this plugin owns. */
declare const PROVIDER = "chatgpt-web";
/** Plugin config. Paths accept `~` (expanded) — never shared between users. */
interface Config {
  /** Profile home for the ChatGPT login session; defaults to `~/.dsh-chatgpt-web`. */
  profileDir?: string;
  /** System Chrome executable; omitted means auto-detect, then bundled Chromium. */
  chromeExecutablePath?: string;
  /** Run turns headed (reserved; the daemon is always headed-hidden). */
  headed?: boolean;
  /** Headed but placed off-screen (reserved; the daemon is always hidden). */
  offscreen?: boolean;
  /** Daemon idle shutdown in ms (default 30 minutes; min 1 minute). */
  daemonIdleMs?: number;
  /** Budget for the manual sign-in window (default 10 minutes). */
  loginTimeoutMs?: number;
  /** Whole-turn budget (default 5 minutes). */
  turnTimeoutMs?: number;
  /** No-output-growth budget while streaming (default 2 minutes). */
  stallTimeoutMs?: number;
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number;
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number;
  /** Advisory models shown by discovery consumers. */
  models?: ChatGptWebCatalogModel[];
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig;
  /** Tool transport; text is the safe default, MCP is opt-in and Unix-only. */
  connectorTransport?: 'text' | 'mcp';
  /** Exact title of the ChatGPT connector used in native MCP mode. */
  connectorName?: string;
  /** Optional private Unix socket path for the native broker. */
  brokerSocketPath?: string;
  /** Native MCP call/round timeout in milliseconds. */
  mcpInvocationTimeoutMs?: number;
}
declare const Config: z<Config>;
/**
 * Derive a private, profile-specific Unix endpoint without exposing the
 * profile path or any credential-bearing configuration in logs.
 */
declare function defaultBrokerSocketPath(profileDir: string): string;
/**
 * The one explicit resolve step from raw config to validated connection facts.
 */
declare function resolveAdapterOptions(config: Config): ChatGptWebConnectionOptions;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { type BrokerRoundSnapshot, type BrokerRpcError, type BrokerRpcResponse, type BrokerToolRequest, type BrokerToolResult, ChatGptWebAdapter, type ChatGptWebAdapterOptions, type ChatGptWebCatalogModel, type ChatGptWebConnectionOptions, Config, type ConnectorTransport, type NativeRoundCleanup, NativeRoundCoordinator, type NativeStepLease, NativeToolBroker, PROVIDER, apply, compilePrompt, correlateToolResults, defaultBrokerSocketPath, inject, name, resolveAdapterOptions };