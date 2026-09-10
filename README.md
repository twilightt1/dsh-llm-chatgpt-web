# dsh-llm-chatgpt-web

ChatGPT Web as a DeepSeek Harness (`dsh`) provider — standalone. The plugin
owns its Chromium and signs in once. Text turns use a fresh Temporary Chat
page; opt-in native MCP turns use a normal connector-enabled chat whose
physical response can span several compatible DSH tool-result steps. The
adapter-owned conversation is deleted when that physical response settles; an
explicit compatibility change or page loss uses safe fresh replay only after
durable results are proven. The default text transport needs no external
bridge; an opt-in Unix MCP transport adds a local broker and stdio MCP server;
a separately provisioned connector/tunnel makes it reachable without changing
DSH's agent loop.

```sh
dsh plugin --profile web add github:twilightt1/dsh-llm-chatgpt-web
dsh web
# Model picker → provider "chatgpt-web"
```

> pnpm ≥10 blocks dependency build scripts by default; this package ships
> prebuilt `lib/` and needs **no** `allowBuilds` entry. If your client still
> prompts, decline it — nothing here needs to run at install time.

## 0.6.0 candidate notes

- Native MCP now keeps compatible tool-result steps on one physical ChatGPT
  response, with exact correlation, journaled replay, and safe fresh-replay
  fallback.
- Managed setup remains pinned, private, and fail-closed; text transport is
  unchanged and remains the default.
- Automated/package gates pass. This is an experimental 0.6.0 release: a real
  native tool continuation is not yet release-ready because ChatGPT safety
  checks blocked the bounded live tool probes. It is not presented as
  API-equivalent or production-ready.

## How it works

```
DSH agent-loop → GenerateOptions → ChatGptWebAdapter.stream()
  → text: fresh Temporary Chat page
  → native: one connector-enabled physical response + broker request
  → select effort → attach prompt → one Send
  → poll answer DOM (persistent Markdown buffer)
  → logical StreamChunks → usage + finish/tool boundary

Default text tools: JSON envelope + fenced tool-call contract.
Opt-in native tools: local broker ← stdio MCP façade ← connector/tunnel
  ← exact ChatGPT connector;
  broker batches become ordinary DSH tool-call chunks, then the next compatible
  step resolves exact results into the same physical response. Incompatible
  history/configuration or a recoverable page loss fences the old response
  before one canonical fresh replay. The adapter deletes each exact owned
  native conversation after settlement.
```

Text turns carry the full visible history in their prompt and remain
stateless across turns. Native tool turns use a normal chat because ChatGPT
disables connectors in Temporary Chat; one physical response retains its
assistant identity, broker request, DOM/Markdown cursor, deadlines, and
append-only logical-boundary journals while DSH executes tools. A compatible
next request must contain the exact assistant call and one text-only result per
call; it does not allocate a page, compile a prompt, select a connector, or
press Send again. A private restart-safe ledger retries failed cleanup before
the next native turn. Turns are serialized: at most one page is ever active.

The prompt transport follows codex-chatgpt-web's proven design: the DSH
conversation is wrapped in a `<dsh_context_json>` envelope with an explicit
transport contract (role semantics, read-before-acting, never echo), which
replaced the old plaintext transcript that made ChatGPT echo instructions
back. Answer extraction binds the newly-created assistant turn by its stable
DOM identity, then converts only that turn's answer-root HTML into Markdown
(turndown). It never falls back to an older turn or the whole document. An
append-only buffer with source ranges preserves code fences (including
```tool-call blocks), tables, and headings without retracting streamed text.
The session is persisted back to the profile after every completed turn
because ChatGPT rotates session tokens.

### Native continuation safety

Native continuation is experimental and remains opt-in. The replay envelope
contains only a versioned non-secret execution hash, logical boundary, and
opaque call IDs. Changes to provider-visible history, model, system prompt,
tool schemas, generation options, steering, or physical-page health select an
explicit fresh-replay path only when every prior tool result is durable and no
side effect is uncertain. A transport failure after submission, ambiguous tool
outcome, correlation conflict, or cleanup failure stops without resubmitting.
`RATE_LIMIT` opens a fixed five-minute adapter-local cooldown and is never
automatically retried. Text transport and auxiliary title/compaction calls do
not use this lifetime.

## Prerequisites

- Google Chrome installed (or set `chromeExecutablePath`).
- A `deepseek-harness` checkout for the Cordis peers (see below).

## Install (pick one)

**A. Local checkout (dev, no build step needed — `lib/` ships in the repo):**

```sh
dsh plugin --profile web add /absolute/path/to/dsh-llm-chatgpt-web
dsh web
```

The CLI registers `dsh.bundle.patch`, links the checkout, and appends the
bundle to the profile automatically (`--dump-config` shows the
`llm-chatgpt-web` row). Keep the checkout in place — the profile links it.

**B. Prebuilt tarball (no build permission asked):**

```sh
pnpm pack   # → dsh-llm-chatgpt-web-0.x.y.tgz
dsh plugin --profile web add ./dsh-llm-chatgpt-web-0.x.y.tgz
```

**C. GitHub (prebuilt `lib/` committed — no build permission needed):**

```sh
dsh plugin --profile web add github:twilightt1/dsh-llm-chatgpt-web
```

Then select provider `chatgpt-web` (model `chatgpt-web/high` or per your
account) in the Web UI model picker, or set it in an agent config. Requires
Google Chrome/Brave installed and one manual ChatGPT sign-in on first use.

Minimum harness peers are declared in `peerDependencies`
(`cordis ^4.0.1`, `dsh-llm ^0.1.1-rc.2`, `schemastery ^3.18.1`).
Runtime dependencies include `playwright-core` (drives system Chrome; no
browser download needed), the MCP SDK, and Zod.

## First run: sign-in

The first turn with no saved session opens a **headed** window at
chatgpt.com. Sign in manually inside that window; the plugin waits for the
composer (proof of session), saves it under `profileDir`
(`~/.dsh-chatgpt-web/storage-state.json`), and continues from then on.
Nothing is copied between browsers. If the session expires later, delete
the profile directory and run again.

> **Headed-hidden daemon (current status).** Turns run as tabs in one
> shared browser daemon (`lib/chatgpt/daemon-main.js`, auto-spawned detached
> on first use, endpoint in `browser-endpoint.json`, idle shutdown after
> `daemonIdleMs`). The daemon's single window is hidden+minimized at birth,
> so turns after the first never flash — attach, stream, detach, done.
> True headless was tried twice (Brave, then real Chrome): ChatGPT answers
> with an interactive Cloudflare checkbox that never clears headless
> (screenshot-proven), so the daemon stays headed-hidden. The adapter never
> closes the shared browser — only its own context, plus an internal
> connection detach so hosts exit cleanly.

## Mount

```yaml
- id: llm-chatgpt-web
  name: '/abs/path/to/dsh-llm-chatgpt-web/src/index.ts'
  config:
    profileDir: ~/.dsh-chatgpt-web
    headed: true
    # connectorTransport: text       # default; use mcp for native tools (Unix only)
    # Existing externally owned MCP runtime:
    # connectorTransport: mcp
    # connectorRuntime: external
    # connectorName: DSH Native      # exact Personalized connector title
    # brokerSocketPath: ~/.dsh-chatgpt-web/native-broker.sock
    # mcpInvocationTimeoutMs: 90000
    # Managed tunnel-client runtime (replace the block above):
    # connectorTransport: mcp
    # connectorRuntime: managed
    # connectorName: DSH Native
    # brokerSocketPath: ~/.dsh-chatgpt-web/native-broker.sock
    # nativeRuntimeConfigPath: ~/.dsh-chatgpt-web/native-runtime.json
    # mcpInvocationTimeoutMs: 90000
    # chromeExecutablePath: /usr/bin/google-chrome

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: chatgpt-web
        model: chatgpt-web/high
```

Models (effort is fixed per model): `chatgpt-web/luna`, `chatgpt-web/think`,
`chatgpt-web/light`, `chatgpt-web/medium`, `chatgpt-web/high`,
`chatgpt-web/extra-high`, `chatgpt-web/pro` (last two only if your account
exposes them — the effort probe fails closed otherwise).

Auto-detect order for the browser binary: explicit config →
`$CHROME_EXECUTABLE_PATH` → platform Chrome → Brave (macOS) → Playwright's
bundled Chromium. Call `adapter.dispose()` on host unload to release the
owned browser (the dev `scripts/live-turn.ts` shows the pattern).

### Native MCP setup (opt-in, Unix only)

Native MCP has two ownership modes. `connectorRuntime: external` keeps the
existing contract: an operator owns the tunnel process and launches the
package's stdio MCP child. `connectorRuntime: managed` makes this plugin own
the pinned tunnel-client lifecycle. Text transport remains the default.

#### 1. Account prerequisites

Create or select an OpenAI Secure MCP Tunnel and create a restricted runtime
API key with Tunnels **Read** and **Use** permissions. Keep the tunnel ID and
runtime key separate: the ID is metadata, while the key authenticates the
local tunnel client. Use the official [Secure MCP Tunnel
guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels),
[Platform Tunnels settings](https://platform.openai.com/settings/organization/tunnels),
and [Runtime API keys](https://platform.openai.com/settings/organization/api-keys).

This package does **not** create the account tunnel, runtime key, or ChatGPT
connector. It only installs a verified local client and configures the local
runtime after you supply those account-level values.

#### 2. Managed setup

Run setup on Darwin/Linux arm64 or x64. The client is pinned to
`openai/tunnel-client` `0.0.12`; setup verifies the release checksum, binary
version, private permissions, and a real connect/status/stop cycle before
writing the final runtime configuration:

```sh
dsh-chatgpt-web-native setup \
  --profile-dir "$HOME/.dsh-chatgpt-web" \
  --connector-name "DSH Native" \
  --tunnel-id "$TUNNEL_ID"
```

Without `--runtime-key-file`, setup asks for the runtime key through a hidden
TTY prompt. To read an existing private key file instead:

```sh
dsh-chatgpt-web-native setup \
  --profile-dir "$HOME/.dsh-chatgpt-web" \
  --connector-name "DSH Native" \
  --tunnel-id "$TUNNEL_ID" \
  --runtime-key-file /private/path/to/runtime-key
```

Setup copies the key to
`~/.dsh-chatgpt-web/secrets/tunnel-runtime.key` (`0600`) and stores only that
path in `native-runtime.json` (`0600`). It does not edit Cordis YAML or
account settings. A source key passed with `--runtime-key-file` is retained;
remove or rotate that source yourself after confirming the managed copy.

#### 3. Exact ChatGPT connector

In [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors),
create or select the **Personalized** connector with the exact name
`DSH Native` (or the configured `connectorName`). Use the tunnel connection,
select the same tunnel ID, and set **Authentication: None**. The account
connector must point at this tunnel; a healthy local process alone does not
prove ChatGPT can discover or call it.

#### 4. Managed Cordis configuration

After setup succeeds, mount the provider with the matching local paths:

```yaml
config:
  connectorTransport: mcp
  connectorRuntime: managed
  connectorName: DSH Native
  brokerSocketPath: ~/.dsh-chatgpt-web/native-broker.sock
  nativeRuntimeConfigPath: ~/.dsh-chatgpt-web/native-runtime.json
  mcpInvocationTimeoutMs: 90000
```

The plugin listens on the private broker socket before starting the tunnel,
then requires `process_running=true`, `healthy=true`, and `ready=true` before
it opens a ChatGPT turn. In managed mode, do **not** separately launch
`dsh-chatgpt-web-mcp`; the managed runtime launches the built stdio MCP
command itself.

#### 5. Doctor and stop

`doctor` is read-only and never prints the runtime-key value. Use `--json`
for a stable, redacted report suitable for an operator check:

```sh
dsh-chatgpt-web-native doctor \
  --profile-dir "$HOME/.dsh-chatgpt-web" \
  --connector-name "DSH Native" \
  --json

dsh-chatgpt-web-native stop \
  --profile-dir "$HOME/.dsh-chatgpt-web" \
  --connector-name "DSH Native"
```

`stop` stops only the configured local tunnel alias; it does not delete the
runtime key, config, tunnel, or ChatGPT connector.

#### 6. Existing external runtime

For an externally owned tunnel, keep the plugin opt-in but select the external
owner explicitly:

```yaml
config:
  connectorTransport: mcp
  connectorRuntime: external
  connectorName: DSH Native
  brokerSocketPath: ~/.dsh-chatgpt-web/native-broker.sock
```

Launch the stdio MCP child from the external tunnel runtime:

```sh
dsh-chatgpt-web-mcp --broker-socket "$HOME/.dsh-chatgpt-web/native-broker.sock"
```

The package does not authenticate or supervise that external tunnel. Existing
external MCP deployments remain supported; no managed config or account setup
is required for them.

#### 7. Fail-closed and evidence semantics

Native mode exposes only `dsh_round_start`, `dsh_tool_inventory`, and
`dsh_tool_call`. The broker snapshots the current DSH tool schemas, and all
invocations return to the ordinary DSH `ToolRuntime`/agent loop as standard
`tool/call` and matching `tool/result` events. No nested agent loop,
`ctx.tools.execute()`, fenced-text fallback, or prose-to-call inference exists.

Before Send, invalid private files, checksum/version drift, tunnel
unreadiness, connector-name mismatch, or an incorrectly selected connector
fail closed. After Send, the adapter never switches transport. A sentence
claiming that a command ran is not evidence; only the DSH call/result events
count.

#### 8. Live E2E gate

Do not call native E2E live or successful unless all of these are verified:

1. the exact built candidate is installed in the DSH `web` profile;
2. DSH MCP/core versions and package checksums are aligned;
3. `doctor --json` is successful;
4. the `DSH Native` Personalized connector uses the same tunnel and has
   Authentication set to None;
5. visible Chrome is running with `ChatGPT Web High` selected;
6. a request requiring `bash` proves `pwd` and
   `git rev-parse --show-toplevel` through actual DSH calls;
7. the session contains matching `tool/call` and `tool/result` events and at
   least two agent steps; and
8. the returned root is the real checkout, not `/` or model-authored prose.

If the account connector, tunnel, aligned artifacts, or session evidence
cannot be verified, report that blocker and do not claim live native E2E.

#### 9. Credential cleanup

Runtime keys must stay outside this repository, Cordis YAML, prompts, logs,
screenshots, and session history. Remove temporary source key files and
rotate any credential that was previously stored in plaintext profile config
before a live run. The `stop` command does not remove credentials; clean up
or retain the managed key intentionally and document the remaining risk.

## V1 scope and limits

- Text in/out with live deltas. Images, `stop` sequences, and `temperature`
  throw `UNSUPPORTED*` instead of being silently dropped.
- No selectable reasoning efforts: an explicit `reasoningEffort` throws —
  pick the effort via the model id.
- Text mode remains the default and cross-platform: tool schemas are advertised
  in the prompt and ChatGPT emits fenced ```tool-call blocks that the adapter
  parses into ordinary DSH tool-call chunks. Tool availability does not force
  every answer to call a tool.
- Native MCP mode is opt-in and Unix-only. The plugin snapshots the resolved
  DSH tools into a private `0600` Unix-socket broker. ChatGPT must use a
  Personalized connector named exactly `DSH Native` (or `connectorName`) and
  call `dsh_round_start`, `dsh_tool_inventory`, and `dsh_tool_call`. Broker
  batches are emitted through the normal DSH loop; no nested loop or direct
  `ctx.tools.execute()` path exists. Native results are text-only. Compatible
  tool-result steps continue the same connector-enabled physical response,
  broker request, conversation, and Send. Context/model/schema/options changes
  and recoverable page loss use canonical fresh replay only after durable
  results and cleanup safety are proven; uncertain effects fail without a
  hidden resubmit. Exact adapter-created conversation IDs are deleted after
  settlement, and failed deletions remain in a private ledger for retry. A
  tunnel/connector is required for live native E2E; this repository's local
  MCP and broker tests do not claim that external setup.
- Usage is a client-side char-based estimate; the page exposes no measured
  counts.
- Reasoning/thinking content is not surfaced separately in V1.
- Temporary Chat is a ChatGPT privacy mode, not anonymity: text-mode prompts
  are still processed by OpenAI under your account's settings. Native MCP
  turns necessarily use normal ChatGPT chats so the connector can run; the
  adapter deletes only the exact conversation IDs it created after completion
  and cannot guarantee immediate backend deletion or prevent prior
  Memory/Personalization effects. This is unofficial browser automation — UI
  changes break selectors loudly (explicit errors, never silent fallback), and
  you remain responsible for the applicable terms and workspace policies.

## Vendoring

The DOM selectors, effort-slider mechanics, Temporary Chat flow
(`src/chatgpt/session.ts`, `src/chatgpt/model.ts`), composer insertion, and
completion predicate derive from
[codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)
(MIT, © 2026 codex-chatgpt-web contributors). Only the ChatGPT-Web driving
surface was taken; the native broker, MCP façade, connector selection, and
adapter lifecycle are local additions. Each vendored file carries a
provenance header.

Local adaptations (live-verified Sep 2026): ProseMirror composer selectors
(upstream targeted Lexical only), whitespace-insensitive attach readback
(ProseMirror renders each newline as its own paragraph), settle-wait before
auth asserts (SPA hydration lags `domcontentloaded`).

## Live verification

Proven against a real Plus-class account (Sep 2026, after the JSON-envelope
+ Markdown-extraction rework):

- `scripts/live-lib.mjs` / `scripts/live-turn.ts`: fresh Temporary Chat →
  effort slider → attach JSON-envelope prompt → submit → streamed Markdown
  deltas (headings, lists, bold all survive) → usage + `stop` finish, on
  both the src (tsx) and built `lib/` paths.
- Text-mode tools and native persistent continuation are covered by local
  adapter, broker, coordinator, physical-response, and replay tests. A managed
  native turn with a `bash` schema attached but no connector call completed in
  27.439 s with a terminal `stop` and no broker invocation after the completion
  fence fix; the owned-conversation ledger was empty and no tunnel/MCP child
  remained. This validates no-tool completion only, not connector execution.
- Tool-required managed probes emitted no structured broker call; one provider
  response explicitly reported that the connector call was blocked by safety
  checks. Native MCP live E2E is therefore intentionally not claimed until a
  verifiable connector/tunnel run proves one-page/one-Send continuation, a
  final answer, exact call/result evidence, and cleanup.
- The storage state persists after every completed turn (ChatGPT rotates
  session tokens); `storage-state.json` mtime advances per turn.
- Heavier reasoning efforts (think/medium/high) need the raised budgets
  (15-minute turn, 5-minute stall) and single-evaluate polling: per-poll
  locator round-trips previously throttled ChatGPT's streaming DOM so hard
  that short answers never finished rendering.

## Layout

| File | Responsibility |
|---|---|
| `src/chatgpt/session.ts` | Vendored selectors / effort menu / auth / capability probe |
| `src/chatgpt/model.ts` | Vendored backend+effort resolution |
| `src/chatgpt/browser.ts` | Daemon attach, login, per-turn fresh page, session persist |
| `src/chatgpt/conversation-cleanup.ts` | Exact native conversation identity, private ownership ledger, deletion verification |
| `src/chatgpt/markdown.ts` | Vendored HTML→Markdown + append-only streaming buffer |
| `src/chatgpt/guards.ts` | Rate-limit / session / onboarding / terminal guards |
| `src/chatgpt/effort.ts` | Effort slider + Think toggle per turn |
| `src/chatgpt/prompt.ts` | DSH history → JSON envelope + transport contract |
| `src/chatgpt/turn.ts` | Attach → send → block-segment stream loop |
| `src/chatgpt/connector.ts` | Exact Personalized connector selection and native arbitration |
| `src/chatgpt/usage.ts` | Char-based usage estimates |
| `src/native/broker.ts` | In-memory provider-round batching, fences, TTL, retirement |
| `src/native/broker-socket.ts` | Private Unix JSON-line RPC transport |
| `src/native/mcp-server.ts` | Fixed MCP façade and handshake |
| `src/native/coordinator.ts` | Parked-page/session ownership transitions |
| `src/native/continuation.ts` | Execution identity, result correlation, and replay decisions |
| `src/native/physical-response.ts` | Persistent native response journals and uncertainty state |
| `src/native/plugin-runtime.ts` | Broker, tunnel readiness, and unload lifecycle |
| `src/native/mcp-main.ts` | Stdio MCP executable entry point |
| `src/native/setup-main.ts` | Managed runtime setup, doctor, and stop executable |
| `src/adapter.ts` | `ChatGptWebAdapter` (seam, queue, chunk protocol) |
| `src/index.ts` | Cordis plugin (`registerAdapter(['chatgpt-web'])`) |
