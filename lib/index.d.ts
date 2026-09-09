import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmError, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ModelModality, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
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
export { ChatGptWebAdapter, type ChatGptWebAdapterOptions, type ChatGptWebCatalogModel, type ChatGptWebConnectionOptions, Config, type ConnectorTransport, PROVIDER, apply, compilePrompt, defaultBrokerSocketPath, inject, name, resolveAdapterOptions };