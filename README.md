# dsh-llm-chatgpt-web

ChatGPT Web as a DeepSeek Harness (`dsh`) provider — standalone. The plugin
owns its Chromium, signs in once, and drives ChatGPT Temporary Chat directly.
No API key, no bridge daemon, no Codex.

## How it works

```
DSH agent-loop → GenerateOptions → ChatGptWebAdapter.stream()
  → compilePrompt(history) → fresh Temporary Chat page (owned Chromium)
  → select effort → attach prompt → send
  → poll answer DOM → text-delta StreamChunks → usage + finish
```

Each turn owns a fresh Temporary Chat page and carries the full visible
history in its prompt (stateless turns, no cross-turn browser state). Turns
are serialized: at most one page is ever active.

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

**C. GitHub (after publishing; commit `lib/`):**

```sh
dsh plugin --profile web add github:you/dsh-llm-chatgpt-web#<commit-or-tag>
```

Then select provider `chatgpt-web` (model `chatgpt-web/high` or per your
account) in the Web UI model picker, or set it in an agent config. Requires
Google Chrome/Brave installed and one manual ChatGPT sign-in on first use.

Minimum harness peers are declared in `peerDependencies`
(`cordis ^4.0.1`, `dsh-llm ^0.1.1-rc.2`, `schemastery ^3.18.1`).
Runtime dependency: `playwright-core` (drives system Chrome; no browser
download needed).

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

## V1 scope and limits

- Text in/out with live deltas. Images, `stop` sequences, and `temperature`
  throw `UNSUPPORTED*` instead of being silently dropped.
- No selectable reasoning efforts: an explicit `reasoningEffort` throws —
  pick the effort via the model id.
- No tool calls from the page: tool schemas are rendered into the prompt as
  a labeled transcript the model can read, but the loop receives text only.
  (Driving page-side tool use back into DSH tools is V2 work.)
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
surface was taken — no Codex task, Responses bridge, MCP broker, launcher,
or tunnel code. Each vendored file carries a provenance header.

Local adaptations (live-verified Sep 2026): ProseMirror composer selectors
(upstream targeted Lexical only), whitespace-insensitive attach readback
(ProseMirror renders each newline as its own paragraph), settle-wait before
auth asserts (SPA hydration lags `domcontentloaded`).

## Live verification

Proven against a real Plus-class account (`scripts/live-turn.ts`):
manual headed login → saved session → capability probe (Sol detected,
Luna correctly refused with failover to Instant) → effort slider → attach →
send → streamed deltas → copy-action completion → usage + `stop` finish,
clean process exit via `dispose()`.

Proven through the real agent loop (`scripts/run-task.ts` +
`chatgpt-web.cordis.yml`, DSH Loader `boot` + `runFixtureTurn` over
`agent-spine-demo`): two consecutive tasks returned exact outputs
(`LOOP READY`, `LOOP TWO`) with session + usage records, and fiber unload
closes the owned browser (effect disposer, same pattern as the
persistent-bash providers).

## Layout

| File | Responsibility |
|---|---|
| `src/chatgpt/session.ts` | Vendored selectors / effort menu / auth / capability probe |
| `src/chatgpt/model.ts` | Vendored backend+effort resolution |
| `src/chatgpt/browser.ts` | Chromium launch, login, profile, page pool |
| `src/chatgpt/guards.ts` | Rate-limit / session / onboarding / terminal guards |
| `src/chatgpt/effort.ts` | Effort slider + Think toggle per turn |
| `src/chatgpt/prompt.ts` | DSH history → plain-text prompt |
| `src/chatgpt/turn.ts` | Attach → send → stream loop |
| `src/chatgpt/usage.ts` | Char-based usage estimates |
| `src/adapter.ts` | `ChatGptWebAdapter` (seam, queue, chunk protocol) |
| `src/index.ts` | Cordis plugin (`registerAdapter(['chatgpt-web'])`) |
