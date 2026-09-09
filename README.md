# dsh-llm-chatgpt-web

ChatGPT Web as a DeepSeek Harness (`dsh`) provider — standalone. The plugin
owns its Chromium, signs in once, and drives ChatGPT Temporary Chat directly.
The default text transport needs no external bridge; an opt-in Unix MCP
transport adds a local broker and stdio tunnel without changing DSH's agent loop.

```sh
dsh plugin --profile web add github:twilightt1/dsh-llm-chatgpt-web
dsh web
# Model picker → provider "chatgpt-web"
```

> pnpm ≥10 blocks dependency build scripts by default; this package ships
> prebuilt `lib/` and needs **no** `allowBuilds` entry. If your client still
> prompts, decline it — nothing here needs to run at install time.

## How it works

```
DSH agent-loop → GenerateOptions → ChatGptWebAdapter.stream()
  → fresh Temporary Chat page (owned Chromium daemon)
  → select effort → attach prompt → send
  → poll answer DOM (block segments → Markdown buffer)
  → text-delta StreamChunks → usage + finish

Default text tools: JSON envelope + fenced tool-call contract.
Opt-in native tools: local broker ← MCP stdio tunnel ← exact ChatGPT connector;
  broker batches become ordinary DSH tool-call chunks, then the next step uses
  a fresh Temporary Chat page with canonical DSH history.
```

Each turn owns a fresh Temporary Chat page and carries the full visible
history in its prompt (stateless turns, no cross-turn browser state). Turns
are serialized: at most one page is ever active.

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
    # connectorName: DSH Native      # exact Personalized connector title
    # brokerSocketPath: ~/.dsh-chatgpt-web/native-broker.sock
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

### Native MCP setup (opt-in)

Use the native path only on Unix systems. Configure the plugin with:

```yaml
config:
  connectorTransport: mcp
  connectorName: DSH Native
  brokerSocketPath: ~/.dsh-chatgpt-web/native-broker.sock
  mcpInvocationTimeoutMs: 90000
```

Configure a ChatGPT Personalized connector named exactly `DSH Native` to run
this external MCP tunnel command:

```sh
dsh-chatgpt-web-mcp --broker-socket "$HOME/.dsh-chatgpt-web/native-broker.sock"
```

The socket is created with a private directory and `0600` endpoint. Native
mode exposes only the three fixed DSH broker tools, returns text results, and
keeps execution in the normal DSH agent loop. Do not put credentials, bearer
tokens, or profile secrets in this repository or in the command above.

Before a live native E2E run, align the profile without printing secrets:

```sh
DSH_PROFILE="$HOME/.dsh/profiles/web"
pnpm --dir "$DSH_PROFILE" add @deepseek-ai/dsh-mcp-client@0.1.2-rc.1
pnpm --dir "$DSH_PROFILE" add /absolute/path/to/dsh-llm-chatgpt-web
sha256sum /absolute/path/to/dsh-llm-chatgpt-web/lib/index.js \
  "$DSH_PROFILE/node_modules/dsh-llm-chatgpt-web/lib/index.js"
```

Confirm the checksums match, remove/rotate any plaintext profile credentials,
and prove that the external connector/tunnel is reachable before sending a
real request. These profile and credential operations are deployment steps,
not performed by this package's tests.

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
  `ctx.tools.execute()` path exists. Native results are text-only, and every
  DSH step starts a fresh Temporary Chat page. A tunnel/connector is required
  for live native E2E; this repository's local MCP and broker tests do not
  claim that external setup.
- Usage is a client-side char-based estimate; the page exposes no measured
  counts.
- Reasoning/thinking content is not surfaced separately in V1.
- Temporary Chat is a ChatGPT privacy mode, not anonymity: prompts are still
  processed by OpenAI under your account's settings. This is unofficial
  browser automation — UI changes break selectors loudly (explicit errors,
  never silent fallback), and you remain responsible for the applicable
  terms and workspace policies.

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
- Text-mode tool behavior is covered locally through the adapter contract and
  DSH chunk tests. Native MCP live E2E is intentionally not claimed until a
  verifiable ChatGPT connector/tunnel and aligned profile artifacts are
  available.
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
| `src/native/mcp-main.ts` | Stdio MCP executable entry point |
| `src/adapter.ts` | `ChatGptWebAdapter` (seam, queue, chunk protocol) |
| `src/index.ts` | Cordis plugin (`registerAdapter(['chatgpt-web'])`) |
