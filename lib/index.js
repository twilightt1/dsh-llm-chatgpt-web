import { c as STEALTH_INIT_SCRIPT, l as defaultProfileDir, n as ensureDaemonBrowser, o as STEALTH_ARGS, p as resolveChromeExecutable, r as touchEndpoint, s as STEALTH_IGNORE_DEFAULT_ARGS } from "./chunks/daemon-B0Uf7DQ4.js";
import z from "@deepseek-ai/schemastery";
import { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, RetryPolicySchema, contentHasImage, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
//#region src/chatgpt/session.ts
const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_COMPOSER_SELECTOR = [
	"[data-testid=\"prompt-textarea\"]",
	"#prompt-textarea",
	"[contenteditable=\"true\"][data-lexical-editor=\"true\"]",
	"[contenteditable=\"true\"].ProseMirror",
	"[role=\"textbox\"][aria-label=\"Chat with ChatGPT\"]"
].join(", ");
const CHATGPT_EFFORT_CONTROL_SELECTOR = ["button[aria-haspopup=\"menu\"][data-tone=\"neutral\"]", "button[data-testid=\"model-switcher-dropdown-button\"][aria-haspopup=\"menu\"]"].join(", ");
const CHATGPT_EFFORT_MENU_SELECTOR = [
	"[data-testid=\"composer-intelligence-picker-content\"]:has([role=\"menuitemradio\"], [data-model-reasoning-effort-slider])",
	"[role=\"menu\"]:has([role=\"menuitemradio\"], [data-model-reasoning-effort-slider])",
	"[role=\"group\"]:has([role=\"menuitemradio\"], [data-model-reasoning-effort-slider])"
].join(", ");
const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = "[data-model-reasoning-effort-slider]";
const CHATGPT_STOP_BUTTON_SELECTOR = "[data-testid=\"stop-button\"]";
const CHATGPT_COMPLETION_ACTION_SELECTOR = "button[data-testid=\"copy-turn-action-button\"]";
const CHATGPT_ASSISTANT_TURN_SELECTOR = [
	"[data-testid^=\"conversation-turn-\"][data-turn=\"assistant\"]",
	"[data-testid^=\"conversation-turn-\"][data-message-author-role=\"assistant\"]",
	"[data-testid^=\"conversation-turn-\"]:has([data-message-author-role=\"assistant\"])"
].join(", ");
[
	"[data-testid^=\"conversation-turn-\"][data-turn=\"user\"]",
	"[data-testid^=\"conversation-turn-\"][data-message-author-role=\"user\"]",
	"[data-testid^=\"conversation-turn-\"]:has([data-message-author-role=\"user\"])"
].join(", ");
function chatGptEffortSlider(page) {
	const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last();
	return {
		sliderContainer,
		slider: sliderContainer.locator("[role=\"slider\"]")
	};
}
function effortMenuSelectorForId(menuId) {
	return `[id=${JSON.stringify(menuId)}]`;
}
async function chatGptEffortMenuForControl(page, control) {
	const menuId = await control.getAttribute("aria-controls").catch(() => null);
	if (menuId) return page.locator(effortMenuSelectorForId(menuId));
	return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}
async function visibleEffortSurface(page, control) {
	const menu = await chatGptEffortMenuForControl(page, control);
	const surface = chatGptEffortSlider(page);
	if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) return {
		menu,
		...surface
	};
}
async function waitForEffortSurface(page, control, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	do {
		const surface = await visibleEffortSurface(page, control);
		if (surface) return surface;
		if (Date.now() >= deadline) return void 0;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	} while (true);
}
async function clearGhostEffortState(page, control) {
	const expanded = await control.getAttribute("aria-expanded").catch(() => null);
	const state = await control.getAttribute("data-state").catch(() => null);
	if (expanded === "true" || state === "open") await page.keyboard.press("Escape").catch(() => {});
}
async function activateChatGptEffortMenu(page, control, options = {}) {
	const openSurface = await visibleEffortSurface(page, control);
	if (openSurface) return {
		method: "already-open",
		...openSurface
	};
	const settleMs = options.settleMs ?? 3e3;
	await clearGhostEffortState(page, control);
	await control.click({
		force: true,
		timeout: Math.max(1, settleMs)
	});
	const clickedSurface = await waitForEffortSurface(page, control, settleMs);
	if (clickedSurface) return {
		method: "click",
		...clickedSurface
	};
	await clearGhostEffortState(page, control);
	await control.dispatchEvent("pointerdown", {
		button: 0,
		buttons: 1,
		pointerType: "mouse",
		isPrimary: true
	});
	const pointerSurface = await waitForEffortSurface(page, control, settleMs);
	if (pointerSurface) return {
		method: "pointerdown",
		...pointerSurface
	};
	throw new Error("ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown");
}
function safeIntegerAttribute(value) {
	if (value === null || !/^-?\d+$/.test(value)) return void 0;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function parseChatGptEffortSliderState(rawMin, rawMax, rawValue) {
	const min = safeIntegerAttribute(rawMin);
	const max = safeIntegerAttribute(rawMax);
	const value = safeIntegerAttribute(rawValue);
	if (min === void 0 || max === void 0 || value === void 0) return void 0;
	const optionCount = max - min + 1;
	if (optionCount < 1 || optionCount > 5) return void 0;
	if (value < min || value > max) return void 0;
	return {
		min,
		max,
		value
	};
}
async function anyVisible(locator) {
	const count = await locator.count();
	for (let index = 0; index < count; index += 1) if (await locator.nth(index).isVisible().catch(() => false)) return true;
	return false;
}
async function assertAuthenticatedChatGptPage(page) {
	if (!await anyVisible(page.locator(CHATGPT_COMPOSER_SELECTOR))) throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
}
async function assertTemporaryChatPage(page) {
	const url = new URL(page.url());
	const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
}
async function detectChatGptAccountCapabilities(page, options = {}) {
	const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
	const composerForm = composers.last().locator("xpath=ancestor::form[1]");
	const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
	const deadline = Date.now() + (options.selectorTimeoutMs ?? 3e4);
	const stableAbsenceMs = options.stableAbsenceMs ?? 3e3;
	let absenceSince;
	let presenceObservations = 0;
	while (true) {
		if (await effortButton.isVisible().catch(() => false)) {
			presenceObservations += 1;
			absenceSince = void 0;
			if (presenceObservations >= 2) break;
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
			continue;
		}
		presenceObservations = 0;
		const composerReady = await composers.count().then((count) => count === 1).catch(() => false);
		const formReady = await composerForm.count().then((count) => count === 1).catch(() => false);
		const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
		if (composerReady && formReady && documentReady) {
			absenceSince ??= Date.now();
			if (Date.now() - absenceSince >= stableAbsenceMs) return {
				solAvailable: false,
				proAvailable: false
			};
		} else absenceSince = void 0;
		if (Date.now() >= deadline) throw new Error("ChatGPT account capability probe did not reach a stable composer state");
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	const menuVisible = await page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last().isVisible().catch(() => false);
	const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
	if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
	try {
		const { sliderContainer, slider } = chatGptEffortSlider(page);
		const timeout = options.selectorTimeoutMs ?? 7e4;
		await sliderContainer.waitFor({
			state: "visible",
			timeout
		});
		await slider.waitFor({
			state: "attached",
			timeout
		});
		const state = parseChatGptEffortSliderState(await slider.getAttribute("aria-valuemin"), await slider.getAttribute("aria-valuemax"), await slider.getAttribute("aria-valuenow"));
		if (!state) throw new Error("ChatGPT model controls are unavailable. Reload ChatGPT and retry.", { cause: /* @__PURE__ */ new Error("ChatGPT effort slider exposed an invalid ARIA range") });
		return {
			solAvailable: true,
			proAvailable: state.max - state.min + 1 >= 5
		};
	} finally {
		await page.keyboard.press("Escape").catch(() => {});
	}
}
//#endregion
//#region src/chatgpt/browser.ts
/**
* Managed browser attachment for ChatGPT turns: connects to the shared
* daemon browser, owns one context + one reused page per adapter lifetime.
*
* Login model: the first run with no saved session opens a headed window at
* chatgpt.com where the user signs in manually; the verified session is saved
* and all later turns attach to the daemon. No launcher app, no copied
* profiles. The daemon (not this process) owns hiding and minimization, so
* turns never flash a window after the daemon's birth.
* @module dsh-llm-chatgpt-web/chatgpt-browser
*/
function storageStatePath(profileDir) {
	return join(profileDir, "storage-state.json");
}
/**
* One daemon attachment for the adapter's lifetime. Turns are serialized by
* the caller and share ONE page: a fresh Temporary Chat navigation per turn
* starts an empty chat (temp chats never persist).
*
* Never closes the shared browser: `close()` releases only this attachment's
* context. The daemon reaps itself after `daemonIdleMs` without turns.
*/
var ChatGptBrowser = class {
	options;
	browser;
	context;
	page;
	capabilitiesProbed = false;
	loginPromise;
	constructor(options) {
		this.options = options;
	}
	/** Connect (spawning the daemon on first use) and guarantee a login session. */
	async ensureReady(signal) {
		if (this.browser && this.context) return;
		mkdirSync(this.options.profileDir, {
			recursive: true,
			mode: 448
		});
		if (!existsSync(storageStatePath(this.options.profileDir))) await this.loginOnce(signal);
		this.browser = await ensureDaemonBrowser(this.options.profileDir, {
			idleMs: this.options.daemonIdleMs,
			executable: this.options.chromeExecutablePath,
			headless: !this.options.headed
		});
		this.context = await this.browser.newContext({ storageState: storageStatePath(this.options.profileDir) });
		await this.context.addInitScript({ content: STEALTH_INIT_SCRIPT });
	}
	/** Whether the account probe already ran on this attachment. */
	get probed() {
		return this.capabilitiesProbed;
	}
	markProbed() {
		this.capabilitiesProbed = true;
	}
	/** Open (or reuse) the single turn page; heartbeats the daemon. */
	async newTurnPage() {
		if (!this.context) throw new LlmError("ChatGPT Web browser is not ready.", "TRANSPORT");
		touchEndpoint(this.options.profileDir);
		if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
		return this.page;
	}
	async close() {
		await this.context?.close().catch(() => {});
		this.context = void 0;
		this.page = void 0;
		this.capabilitiesProbed = false;
		const browser = this.browser;
		this.browser = void 0;
		if (browser) try {
			await browser._connection?.close?.();
		} catch {}
	}
	/**
	* Headed manual sign-in: opens chatgpt.com, waits for the composer (proof
	* the user finished signing in), saves the session, closes. Concurrent
	* callers share one login window.
	*/
	loginOnce(signal) {
		this.loginPromise ??= (async () => {
			if (signal?.aborted) throw new LlmError("ChatGPT Web login aborted by caller.", "ABORTED");
			console.log(`[dsh-llm-chatgpt-web] no saved session — opening ${this.options.chromeExecutablePath ?? "bundled Chromium"} for manual sign-in`);
			const loginBrowser = await chromium.launch({
				...this.options.chromeExecutablePath !== void 0 ? { executablePath: this.options.chromeExecutablePath } : {},
				headless: false,
				args: [...STEALTH_ARGS],
				ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS
			});
			try {
				const context = await loginBrowser.newContext();
				await context.addInitScript({ content: STEALTH_INIT_SCRIPT });
				const page = await context.newPage();
				await page.goto("https://chatgpt.com/", {
					waitUntil: "domcontentloaded",
					timeout: 6e4
				});
				const deadline = Date.now() + this.options.loginTimeoutMs;
				for (;;) {
					if (signal?.aborted) throw new LlmError("ChatGPT Web login aborted by caller.", "ABORTED");
					if (page.isClosed()) throw new LlmError("ChatGPT Web login window was closed before sign-in completed.", "ABORTED");
					try {
						await assertAuthenticatedChatGptPage(page);
						break;
					} catch {
						if (Date.now() >= deadline) throw new LlmError("ChatGPT Web sign-in timed out waiting for the composer. Sign in inside the opened window and retry.", "TIMEOUT");
						await new Promise((resolveSleep) => setTimeout(resolveSleep, 1e3));
					}
				}
				await context.storageState({ path: storageStatePath(this.options.profileDir) });
				await context.close();
			} finally {
				await loginBrowser.close().catch(() => {});
			}
		})();
		const shared = this.loginPromise;
		shared.catch(() => {
			if (this.loginPromise === shared) this.loginPromise = void 0;
		});
		return shared;
	}
};
//#endregion
//#region src/chatgpt/toolcalls.ts
const FENCE_RE = /(?:`{2,3})?tool-call[ \t]*\r?\n([\s\S]*?)`{2,3}/g;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Render the tool-use contract + schemas appended to the prompt when tools
* are advertised. Pure text: the model reads it, the page executes nothing.
*/
function renderToolContract(tools) {
	const names = tools.map((tool) => tool.name).join(", ");
	const schemas = tools.map((tool) => `## ${tool.name}: ${tool.description}\n${JSON.stringify(tool.parameters)}`).join("\n\n");
	return [
		"[Tool use] READ THIS FIRST — it is how you act, not background info.",
		"The tools in [Tool schemas] below are the ONLY executable tools in this environment. This chat has NO native python/container/web/image tools — any attempt to use them does nothing.",
		"The ONLY way to call a tool is emitting exactly one fenced block per call, then STOP writing (no text after the last block).",
		"Merely describing or narrating an action (\"I will run...\", \"Writing file...\", \"bash -lc ...\", a ```python block) DOES NOTHING — only a fenced ```tool-call block executes.",
		"Example — this block really runs, prose does not:",
		"```tool-call",
		"{\"name\": \"bash\", \"arguments\": {\"command\": \"echo hello-loops\"}}",
		"```",
		"Rules:",
		`- "name" must be one of: ${names}.`,
		"- \"arguments\" must be a JSON object matching that tool's schema.",
		"- You may emit several calls; they run top to bottom, then you get the results and continue.",
		"- If you need no tool, just answer normally and emit no block.",
		"Proof this works (an earlier exchange in this same session):",
		"Assistant:",
		"```tool-call",
		"{\"name\": \"bash\", \"arguments\": {\"command\": \"echo hello-loops\"}}",
		"```",
		"System: [Tool result] hello-loops",
		"Assistant: Done — the command ran and returned its output above.",
		"[Tool schemas]",
		schemas
	].join("\n");
}
/**
* Split answer text into text/call segments, validating each block.
* @param text - full model answer.
* @param knownTools - advertised tool names; anything else is rejected.
*/
function parseToolCalls(text, knownTools) {
	const segments = [];
	const rejected = [];
	let callCount = 0;
	let cursor = 0;
	FENCE_RE.lastIndex = 0;
	for (;;) {
		const match = FENCE_RE.exec(text);
		if (!match || match.index === void 0) break;
		const body = (match[1] ?? "").trim();
		const end = match.index + match[0].length;
		const head = text.slice(cursor, match.index);
		if (head.length > 0) segments.push({
			type: "text",
			text: head
		});
		cursor = end;
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			rejected.push({
				raw: body.slice(0, 200),
				reason: "block is not valid JSON"
			});
			continue;
		}
		if (!isRecord(parsed) || typeof parsed["name"] !== "string") {
			rejected.push({
				raw: body.slice(0, 200),
				reason: "block needs a string \"name\""
			});
			continue;
		}
		if (!knownTools.has(parsed["name"])) {
			rejected.push({
				raw: body.slice(0, 200),
				reason: `unknown tool "${parsed["name"]}"`
			});
			continue;
		}
		if (!isRecord(parsed["arguments"])) {
			rejected.push({
				raw: body.slice(0, 200),
				reason: "\"arguments\" must be a JSON object"
			});
			continue;
		}
		callCount += 1;
		segments.push({
			type: "call",
			call: {
				name: parsed["name"],
				arguments: JSON.stringify(parsed["arguments"]),
				start: match.index,
				end
			}
		});
	}
	const tail = text.slice(cursor);
	if (tail.length > 0) segments.push({
		type: "text",
		text: tail
	});
	return {
		segments,
		rejected,
		callCount
	};
}
/**
* One-line retry notice for rejected blocks, prepended to the next prompt of
* the same session so the model can self-correct.
*/
function renderRejectionNotice(rejected) {
	const lines = rejected.map((entry) => `- ${entry.reason}: ${entry.raw}`);
	return `[System notice] Your last turn emitted ${rejected.length} unusable tool-call block(s); none ran. Fix and retry:\n${lines.join("\n")}`;
}
//#endregion
//#region src/chatgpt/prompt.ts
/**
* DSH history → one plain-text ChatGPT prompt.
*
* Each turn owns a fresh Temporary Chat page, so the full visible history is
* compiled into every prompt (same stateless discipline as the upstream
* multipart transport, without its Codex envelope). Tool calls and results
* are rendered as labeled transcripts — V1 is text-only, so the model can
* read tool traffic but cannot issue new calls from the page.
* @module dsh-llm-chatgpt-web/chatgpt-prompt
*/
function textOf(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function renderMessage(message) {
	if (message.source.kind === "tool") {
		const block = message.content[0];
		if (block === void 0 || block.type !== "tool-result" || message.content.length !== 1) throw new LlmError("ChatGPT Web adapter expects tool results as single tool-result messages.", "INVALID_REQUEST");
		if (contentHasImage(block.content)) throw new LlmError("ChatGPT Web adapter cannot represent image content (V1 is text-only).", "UNSUPPORTED_CONTENT");
		return `[Tool result]\n${textOf(block.content)}`;
	}
	if (contentHasImage(message.content)) throw new LlmError("ChatGPT Web adapter cannot represent image content (V1 is text-only).", "UNSUPPORTED_CONTENT");
	if (message.role === "assistant") {
		const calls = message.content.filter((block) => block.type === "tool-call");
		const parts = [];
		const text = textOf(message.content.filter((block) => block.type !== "tool-call"));
		if (text.length > 0) parts.push(text);
		for (const block of calls) {
			if (block.type !== "tool-call") continue;
			let args = block.arguments;
			try {
				args = JSON.stringify(JSON.parse(block.arguments));
			} catch {}
			parts.push(`\`\`\`tool-call\n{"name": ${JSON.stringify(block.name)}, "arguments": ${args}}\n\`\`\``);
		}
		return `[Assistant]\n${parts.join("\n")}`;
	}
	return `[User]\n${textOf(message.content)}`;
}
/**
* Compile one prompt for a fresh Temporary Chat page.
* @param options - fully assembled harness request.
* @param maxChars - composer budget; exceeding it fails with context overflow.
* @param notice - optional one-shot system notice (e.g. tool-call retry).
*/
function compilePrompt(options, maxChars, notice) {
	if (options.reasoningEffort !== void 0) throw new LlmError(`ChatGPT Web does not support reasoning effort "${options.reasoningEffort}"; pick the effort via the model (chatgpt-web/light|medium|high|extra-high|pro|luna).`, "UNSUPPORTED_REASONING_EFFORT");
	if (options.stop !== void 0 && options.stop.length > 0) throw new LlmError("ChatGPT Web adapter does not support stop sequences.", "UNSUPPORTED");
	if (options.temperature !== void 0) throw new LlmError("ChatGPT Web adapter does not support temperature.", "UNSUPPORTED");
	const sections = [];
	if (options.system !== void 0 && options.system.length > 0) sections.push(`[System]\n${options.system}`);
	if (options.tools !== void 0 && options.tools.length > 0) {
		sections.push(renderToolContract(options.tools));
		if (!options.messages.some((message) => message.content.some((block) => block.type === "tool-call"))) {
			sections.push("[User]\nReady. Demonstrate the tool protocol once: call bash with {\"command\": \"echo priming-echo\"}.");
			sections.push("[Assistant]\n```tool-call\n{\"name\": \"bash\", \"arguments\": {\"command\": \"echo priming-echo\"}}\n```");
			sections.push("[Tool result]\npriming-echo");
			sections.push("[Assistant]\nDone — the protocol works as demonstrated.");
		}
	}
	if (notice !== void 0 && notice.length > 0) sections.push(notice);
	for (const message of options.messages) sections.push(renderMessage(message));
	if (options.tools !== void 0 && options.tools.length > 0) sections.push("[Reminder] If the task needs an action, your ENTIRE reply must be tool-call fenced block(s) — never narration like \"bash -lc ...\" or a ```python block. If it needs no action, answer in plain text.");
	const prompt = sections.join("\n\n");
	if (prompt.length > maxChars) throw new LlmError(`ChatGPT Web prompt is ${prompt.length} chars, over the ${maxChars}-char composer budget. Compact the session or shorten the request.`, "CONTEXT_WINDOW_EXCEEDED");
	return prompt;
}
//#endregion
//#region src/chatgpt/guards.ts
/**
* Fail-closed page guards: rate limits, expired sessions, onboarding, and
* terminal turn errors. Selector knowledge derives from codex-chatgpt-web
* (MIT); the implementation here is original and text-turn scoped.
* @module dsh-llm-chatgpt-web/chatgpt-guards
*/
const rateLimitDialog = (page) => page.locator("[role=\"dialog\"]").filter({ hasText: /Too many requests/i }).filter({ hasText: /making requests too quickly/i }).last();
/** Throw RATE_LIMIT when ChatGPT shows its too-many-requests dialog. */
async function throwIfRateLimitDialog(page) {
	const dialog = rateLimitDialog(page);
	if (!await dialog.isVisible().catch(() => false)) return;
	const acknowledge = dialog.getByRole("button", { name: /^(Got it)$/ }).last();
	if (await acknowledge.isVisible().catch(() => false)) await acknowledge.press("Enter").catch(() => {});
	throw new LlmError("ChatGPT rate limit: too many requests. Try again in a few minutes.", "RATE_LIMIT");
}
const expiredSessionAlert = (page) => page.locator("[role=\"alert\"], [role=\"dialog\"]").filter({ hasText: /Your session has expired/i }).last();
const subscriptionAlert = (page) => page.locator("[role=\"alert\"]").filter({ hasText: /Failed to load subscription/i }).last();
/** Throw AUTH when the login expired, SERVER when the subscription won't load. */
async function throwIfSessionFailureAlert(page) {
	if (await expiredSessionAlert(page).isVisible().catch(() => false)) throw new LlmError("The ChatGPT session has expired. Delete the plugin profile directory and run again to sign in.", "AUTH");
	if (!await subscriptionAlert(page).isVisible().catch(() => false)) return;
	throw new LlmError("ChatGPT could not load the account subscription. Reload and retry; sign in again only if it persists.", "SERVER");
}
const temporaryChatOnboardingDialog = (page) => page.locator("[role=\"dialog\"]").filter({ hasText: "Not in history" }).filter({ hasText: "No model training" }).filter({ hasText: "Memory off" }).last();
/** Dismiss the first-run Temporary Chat explainer; returns whether it was shown. */
async function dismissTemporaryChatOnboarding(page) {
	const dialog = temporaryChatOnboardingDialog(page);
	if (!await dialog.isVisible().catch(() => false)) return false;
	const continueButton = dialog.getByRole("button", {
		name: "Continue",
		exact: true
	}).last();
	if (!await continueButton.isVisible().catch(() => false)) throw new LlmError("ChatGPT Temporary Chat onboarding is visible without its Continue action.", "PROVIDER_ERROR");
	await continueButton.click({ force: true });
	await dialog.waitFor({
		state: "hidden",
		timeout: 1e4
	});
	return true;
}
const terminalErrorText = (page) => page.getByText(/Something went wrong[\s\S]*help\.openai\.com/i).last();
/** Throw when the turn surface ends in a banner error instead of an answer. */
async function throwIfTerminalError(page) {
	if (!await terminalErrorText(page).isVisible().catch(() => false)) return;
	throw new LlmError("ChatGPT ended the turn with 'Something went wrong'. Retry the turn.", "SERVER");
}
//#endregion
//#region src/chatgpt/model.ts
/**
* ChatGPT model/effort resolution.
*
* Vendored from codex-chatgpt-web `src/adapters/chatgpt-web/model.ts`
* (MIT, (c) 2026 codex-chatgpt-web contributors) with one change: the backend
* model ids are defined locally instead of imported from the upstream catalog.
* No behavioral changes.
* @module dsh-llm-chatgpt-web/chatgpt-model
*/
/** ChatGPT web backend behind the Sol (reasoning-selector) surface. */
const CHATGPT_WEB_SOL_BACKEND_MODEL = "gpt-5.6-sol";
/** ChatGPT web backend behind the Luna (Free/Go) surface. */
const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
function resolveChatGptWebModelMode(modelId, reasoning, capabilities) {
	if (modelId === "gpt-5.6-luna") {
		if (capabilities.solAvailable) throw new Error("ChatGPT Luna is not available while the account exposes the Sol model selector");
		const effort = reasoning ?? "low";
		if (effort !== "low" && effort !== "medium") throw new Error(`ChatGPT Luna mode is not supported: ${effort}`);
		const thinkEnabled = effort === "medium";
		return {
			modelId,
			effort,
			displayLabel: thinkEnabled ? "Think" : "Luna",
			uiEffortIndex: null,
			thinkEnabled,
			localTools: capabilities.localToolsEnabled
		};
	}
	if (modelId !== "gpt-5.6-sol") throw new Error(`ChatGPT web model is not supported: ${modelId}`);
	if (!capabilities.solAvailable) throw new Error("ChatGPT Sol modes are not available for this Luna-only account");
	const effort = reasoning ?? "high";
	switch (effort) {
		case "low": return {
			modelId,
			effort,
			displayLabel: "Instant",
			uiEffortIndex: 0,
			thinkEnabled: false,
			localTools: capabilities.localToolsEnabled
		};
		case "medium": return {
			modelId,
			effort,
			displayLabel: "Medium",
			uiEffortIndex: 1,
			thinkEnabled: false,
			localTools: capabilities.localToolsEnabled
		};
		case "high": return {
			modelId,
			effort,
			displayLabel: "High",
			uiEffortIndex: 2,
			thinkEnabled: false,
			localTools: capabilities.localToolsEnabled
		};
		case "xhigh":
			if (!capabilities.proAvailable) throw new Error("ChatGPT Extra High effort is not available for this account");
			return {
				modelId,
				effort,
				displayLabel: "Extra High",
				uiEffortIndex: 3,
				thinkEnabled: false,
				localTools: capabilities.localToolsEnabled
			};
		case "max":
			if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
			return {
				modelId,
				effort,
				displayLabel: "Pro",
				uiEffortIndex: 4,
				thinkEnabled: false,
				localTools: capabilities.localToolsEnabled
			};
		default: throw new Error(`ChatGPT web effort is not supported: ${effort}`);
	}
}
//#endregion
//#region src/chatgpt/effort.ts
/**
* Model/effort selection on a fresh Temporary Chat page.
*
* Mechanics derive from codex-chatgpt-web (MIT): the effort menu owns an ARIA
* slider, moved one step per arrow key to `min + uiEffortIndex`; Luna-only
* accounts use the Think toggle instead. The mapping from DSH model slug to
* backend+eﬀort lives here (upstream coupled it to Codex config).
* @module dsh-llm-chatgpt-web/chatgpt-effort
*/
/** DSH model slug → upstream backend + effort. */
function resolveSlugBackend(model) {
	switch (model) {
		case "chatgpt-web/luna": return {
			backend: CHATGPT_WEB_LUNA_BACKEND_MODEL,
			effort: "low"
		};
		case "chatgpt-web/think": return {
			backend: CHATGPT_WEB_LUNA_BACKEND_MODEL,
			effort: "medium"
		};
		case "chatgpt-web/light": return {
			backend: CHATGPT_WEB_SOL_BACKEND_MODEL,
			effort: "low"
		};
		case "chatgpt-web/medium": return {
			backend: CHATGPT_WEB_SOL_BACKEND_MODEL,
			effort: "medium"
		};
		case "chatgpt-web/high": return {
			backend: CHATGPT_WEB_SOL_BACKEND_MODEL,
			effort: "high"
		};
		case "chatgpt-web/extra-high": return {
			backend: CHATGPT_WEB_SOL_BACKEND_MODEL,
			effort: "xhigh"
		};
		case "chatgpt-web/pro": return {
			backend: CHATGPT_WEB_SOL_BACKEND_MODEL,
			effort: "max"
		};
		default: throw new LlmError(`ChatGPT Web model is not supported: ${model}. Available: chatgpt-web/luna|think|light|medium|high|extra-high|pro.`, "INVALID_REQUEST");
	}
}
async function setThinkMode(composerForm, enabled) {
	const controls = composerForm.getByRole("button", {
		name: "Think",
		exact: true
	}).filter({ visible: true });
	const count = await controls.count();
	if (count === 0) {
		if (enabled) throw new LlmError("ChatGPT Think control is not available on this Luna-only account.", "INVALID_REQUEST");
		return;
	}
	if (count !== 1) throw new LlmError(`ChatGPT exposed ${count} visible Think controls.`, "PROVIDER_ERROR");
	const control = controls.first();
	const target = enabled ? "true" : "false";
	let pressed = await control.getAttribute("aria-pressed");
	if (pressed !== "true" && pressed !== "false") throw new LlmError("ChatGPT Think control has no semantic pressed state.", "PROVIDER_ERROR");
	if (pressed !== target) {
		await control.click();
		const deadline = Date.now() + 5e3;
		while (Date.now() < deadline) {
			pressed = await control.getAttribute("aria-pressed");
			if (pressed === target) break;
			if (pressed !== "true" && pressed !== "false") throw new LlmError("ChatGPT Think control lost its semantic pressed state.", "PROVIDER_ERROR");
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
		}
		if (pressed !== target) throw new LlmError(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode.`, "PROVIDER_ERROR");
	}
}
/**
* Select the model+eﬀort for one turn. Every turn starts on a fresh page at
* the default eﬀort, so this runs unconditionally before submit.
*/
async function selectModelEffort(page, model, capabilities) {
	const { backend, effort } = resolveSlugBackend(model);
	let mode;
	try {
		mode = resolveChatGptWebModelMode(backend, effort, {
			...capabilities,
			localToolsEnabled: false
		});
	} catch (error) {
		throw new LlmError(error instanceof Error ? error.message : String(error), "INVALID_REQUEST");
	}
	const composerForm = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).last().locator("xpath=ancestor::form[1]");
	if (mode.uiEffortIndex === null) {
		await throwIfRateLimitDialog(page);
		await setThinkMode(composerForm, mode.thinkEnabled);
		return mode.displayLabel;
	}
	const control = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
	try {
		await control.waitFor({
			state: "visible",
			timeout: 3e4
		});
	} catch {
		await throwIfSessionFailureAlert(page);
		throw new LlmError("ChatGPT rendered the composer but its model/effort control did not become ready.", "PROVIDER_ERROR");
	}
	await throwIfRateLimitDialog(page);
	let activation;
	try {
		activation = await activateChatGptEffortMenu(page, control);
	} catch (error) {
		throw new LlmError(error instanceof Error ? error.message : String(error), "PROVIDER_ERROR");
	}
	const slider = activation.slider;
	await activation.sliderContainer.waitFor({
		state: "visible",
		timeout: 3e4
	});
	await slider.waitFor({
		state: "attached",
		timeout: 3e4
	});
	let state = parseChatGptEffortSliderState(await slider.getAttribute("aria-valuemin"), await slider.getAttribute("aria-valuemax"), await slider.getAttribute("aria-valuenow"));
	if (!state) throw new LlmError("ChatGPT effort slider exposed an invalid ARIA range.", "PROVIDER_ERROR");
	const targetValue = state.min + mode.uiEffortIndex;
	if (targetValue > state.max) throw new LlmError(`ChatGPT effort slider does not expose ${mode.displayLabel} (min=${state.min}; max=${state.max}). The account may have hit a usage limit.`, "INVALID_REQUEST");
	const sliderControl = slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
	while (state.value !== targetValue) {
		await throwIfRateLimitDialog(page);
		const direction = targetValue > state.value ? 1 : -1;
		const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
		const previousValue = state.value;
		await sliderControl.press(key);
		const changeDeadline = Date.now() + 5e3;
		do {
			state = parseChatGptEffortSliderState(await slider.getAttribute("aria-valuemin"), await slider.getAttribute("aria-valuemax"), await slider.getAttribute("aria-valuenow"));
			if (!state) throw new LlmError("ChatGPT effort slider lost its semantic ARIA state.", "PROVIDER_ERROR");
			if (state.value !== previousValue) break;
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
		} while (Date.now() < changeDeadline);
		if (state.value !== previousValue + direction) throw new LlmError(`ChatGPT effort slider did not move exactly one step with ${key} (before=${previousValue}; after=${state.value}).`, "PROVIDER_ERROR");
	}
	await page.keyboard.press("Escape").catch(() => {});
	return mode.displayLabel;
}
//#endregion
//#region src/chatgpt/turn.ts
/**
* One text turn on a fresh Temporary Chat page: prepare → attach → send →
* stream answer deltas until the completion predicate holds.
*
* The completion predicate mirrors the upstream rule (response present, not
* running, non-empty text, copy action visible) scoped to the response turn.
* @module dsh-llm-chatgpt-web/chatgpt-turn
*/
/** Composer budget in chars (measured upstream envelope, fail-closed). */
const COMPOSER_CHAR_BUDGET = 2e5;
/**
* Plain-text insertion through the browser editing command (upstream lesson:
* CDP typing can trigger Lexical Markdown shortcuts and corrupt backticks).
* Runs in page context — must stay self-contained.
*/
function insertPlainTextIntoComposer(element, value) {
	if (document.activeElement !== element) element.focus();
	if (document.activeElement !== element) return false;
	const selection = window.getSelection();
	if (!selection) return false;
	if (!(selection.isCollapsed && selection.anchorNode !== null && element.contains(selection.anchorNode))) {
		const range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		selection.removeAllRanges();
		selection.addRange(range);
	}
	if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return false;
	return document.execCommand("insertText", false, value);
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw new LlmError("ChatGPT Web turn aborted by caller.", "ABORTED");
}
/** Resolve on the next DOM mutation batch (≤timeoutMs), for streaming polls. */
async function waitForDomMutation(page, timeoutMs) {
	await page.evaluate((timeout) => new Promise((resolveMutation) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			observer.disconnect();
			clearTimeout(timeoutTimer);
			if (settleTimer !== void 0) clearTimeout(settleTimer);
			resolveMutation();
		};
		let settleTimer;
		const observer = new MutationObserver(() => {
			if (settleTimer !== void 0) return;
			settleTimer = setTimeout(finish, 16);
		});
		observer.observe(document.documentElement, {
			subtree: true,
			childList: true,
			characterData: true
		});
		const timeoutTimer = setTimeout(finish, timeout);
	}), timeoutMs).catch(() => {});
}
async function activeComposer(page, timeoutMs = 3e4) {
	const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
	const deadline = Date.now() + timeoutMs;
	let count = 0;
	while (Date.now() < deadline) {
		count = await composers.count().catch(() => 0);
		if (count === 1) return composers.first();
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	throw new LlmError(`ChatGPT composer is unavailable (visible composer count was ${count}). Reload ChatGPT and retry.`, "PROVIDER_ERROR");
}
async function stopVisible(page) {
	return await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
}
/**
* Read the answer text, preferring the markdown content node: the turn
* container can also hold UI chrome (e.g. personality nudges) that must not
* leak into model output.
*/
async function responseText(responseTurn, fallback) {
	const markdown = responseTurn.locator(".markdown");
	if (await markdown.count().then((count) => count > 0).catch(() => false)) return await markdown.last().innerText().catch(() => fallback);
	return await responseTurn.innerText().catch(() => fallback);
}
/**
* Prepare a fresh page: Temporary Chat navigation, onboarding, auth asserts.
* Exported so the adapter can probe account capabilities on a settled
* surface before the turn starts streaming. On auth failure, saves a
* screenshot + URL/title into `diagDir` (when given) for diagnosis.
*/
async function prepareTemporaryChatSurface(page, diagDir, settleTimeoutMs = 9e4) {
	await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
		waitUntil: "domcontentloaded",
		timeout: 6e4
	});
	const settleDeadline = Date.now() + settleTimeoutMs;
	for (;;) {
		if (await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).count().then((c) => c > 0).catch(() => false)) break;
		if (Date.now() >= settleDeadline) break;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 1e3));
	}
	await dismissTemporaryChatOnboarding(page);
	await throwIfSessionFailureAlert(page);
	try {
		await assertAuthenticatedChatGptPage(page);
		await assertTemporaryChatPage(page);
	} catch (error) {
		if (diagDir) {
			const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
			await page.screenshot({ path: `${diagDir}/prepare-failed-${stamp}.png` }).catch(() => {});
			const { writeFileSync } = await import("node:fs");
			try {
				writeFileSync(`${diagDir}/prepare-failed-${stamp}.txt`, `url=${page.url()}\ntitle=${JSON.stringify(await page.title().catch(() => "?"))}\nerror=${error instanceof Error ? error.message : String(error)}\n`);
			} catch {}
		}
		throw error;
	}
}
/**
* Stream one turn on a prepared page. The caller owns the page (fresh per
* turn) and closes it. Yields text deltas, then returns the final answer.
*/
async function* streamTextTurn(page, options) {
	const { signal } = options;
	const deadline = Date.now() + options.turnTimeoutMs;
	const checkDeadline = () => {
		throwIfAborted(signal);
		if (Date.now() >= deadline) throw new LlmError(`ChatGPT Web turn exceeded its ${options.turnTimeoutMs}ms budget.`, "TIMEOUT");
		if (page.isClosed()) throw new LlmError("ChatGPT Web page was closed mid-turn.", "TRANSPORT");
	};
	if (page.url() !== "https://chatgpt.com/?temporary-chat=true") await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
		waitUntil: "domcontentloaded",
		timeout: 6e4
	});
	await prepareTemporaryChatSurface(page);
	await selectModelEffort(page, options.model, options.capabilities);
	const assistantTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
	const initialAssistantTurns = await assistantTurns.count().catch(() => 0);
	const squash = (value) => value.replace(/\s+/g, "");
	/** Attach one text to the composer with readback verification. */
	async function attach(text) {
		const composer = await activeComposer(page);
		await composer.fill("");
		await composer.focus();
		if (!await composer.evaluate(insertPlainTextIntoComposer, text, { timeout: 2e4 })) throw new LlmError("ChatGPT composer rejected the plain-text editing command.", "PROVIDER_ERROR");
		const readback = await composer.innerText().catch(() => "");
		const tail = squash(text.slice(-240));
		if (tail.length > 0 && (!squash(readback).includes(tail) || squash(readback).length < squash(text).length * .95)) throw new LlmError("ChatGPT composer readback does not contain the attached prompt.", "PROVIDER_ERROR");
	}
	/** Submit and wait for the model to start answering. */
	async function submit(baseCount) {
		const sendButton = (await activeComposer(page)).locator("xpath=ancestor::form[1]").getByTestId("send-button");
		await sendButton.waitFor({
			state: "visible",
			timeout: 3e4
		});
		const sendDeadline = Date.now() + 2e4;
		for (;;) {
			checkDeadline();
			await throwIfSessionFailureAlert(page);
			await throwIfRateLimitDialog(page);
			if (await sendButton.isEnabled().catch(() => false)) break;
			if (Date.now() >= sendDeadline) throw new LlmError("ChatGPT send button remained disabled after the complete prompt was attached.", "PROVIDER_ERROR");
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
		}
		await sendButton.press("Enter");
		checkDeadline();
		const submitDeadline = Date.now() + 6e4;
		for (;;) {
			checkDeadline();
			await throwIfSessionFailureAlert(page);
			await throwIfRateLimitDialog(page);
			if (await assistantTurns.count().catch(() => 0) > baseCount || await stopVisible(page)) break;
			if (Date.now() >= submitDeadline) {
				await throwIfTerminalError(page);
				throw new LlmError("ChatGPT did not accept the submitted prompt (no turn appeared).", "PROVIDER_ERROR");
			}
			await waitForDomMutation(page, 500);
		}
	}
	/** Poll one round's assistant turn (created at `baseCount`) to completion. */
	async function* captureRound(baseCount) {
		let previousText = "";
		let lastGrowth = Date.now();
		let settledObservations = 0;
		let lastPollText = "";
		const REQUIRED_SETTLED_OBSERVATIONS = 3;
		for (;;) {
			checkDeadline();
			await throwIfSessionFailureAlert(page);
			await throwIfRateLimitDialog(page);
			const count = await assistantTurns.count().catch(() => 0);
			let responseTurn;
			if (count > baseCount) responseTurn = assistantTurns.nth(baseCount);
			else if (count > 0) responseTurn = assistantTurns.last();
			let currentText = "";
			if (responseTurn) {
				currentText = await responseText(responseTurn, previousText);
				await throwIfTerminalError(page);
			}
			if (currentText.length > previousText.length && currentText.startsWith(previousText)) {
				const delta = currentText.slice(previousText.length);
				previousText = currentText;
				lastGrowth = Date.now();
				yield {
					type: "delta",
					delta
				};
			} else if (currentText !== previousText && currentText.length >= previousText.length) {
				previousText = currentText;
				lastGrowth = Date.now();
			}
			const running = await stopVisible(page);
			let copyVisible = false;
			if (responseTurn && count > 0) {
				copyVisible = await responseTurn.locator(CHATGPT_COMPLETION_ACTION_SELECTOR).last().isVisible().catch(() => false);
				if (!copyVisible) copyVisible = await page.locator(CHATGPT_COMPLETION_ACTION_SELECTOR).last().isVisible().catch(() => false);
			}
			const settled = (count > baseCount || count > 0 && previousText.length > 0) && !running && previousText.length > 0 && copyVisible && currentText === lastPollText;
			lastPollText = currentText;
			settledObservations = settled ? settledObservations + 1 : 0;
			if (settledObservations >= REQUIRED_SETTLED_OBSERVATIONS) return previousText;
			if (!running && previousText.length > 0 && Date.now() - lastGrowth >= options.stallTimeoutMs) return previousText;
			if (Date.now() - lastGrowth >= options.stallTimeoutMs) throw new LlmError(`ChatGPT Web turn stalled with no output growth for ${options.stallTimeoutMs}ms.`, "TIMEOUT");
			await waitForDomMutation(page, 1e3);
		}
	}
	const NUDGE = "[System reminder] That was narration, not a tool call — nothing executed. Your ENTIRE next reply must be ONLY the ```tool-call fenced block for the task. No prose, no explanations.";
	const fenceSeen = (text) => /`{0,3}tool-call[ \t]*\r?\n/.test(text);
	const maxRounds = options.requiresToolCall ? 3 : 1;
	let captured = "";
	for (let round = 0; round < maxRounds; round += 1) {
		const isNudge = round > 0;
		const baseCount = isNudge ? await assistantTurns.count().catch(() => initialAssistantTurns) : initialAssistantTurns;
		await attach(isNudge ? NUDGE : options.prompt);
		await submit(baseCount);
		const roundText = yield* captureRound(baseCount);
		captured += (captured.length > 0 ? "\n\n" : "") + roundText;
		if (!options.requiresToolCall || fenceSeen(captured)) break;
		if (round === 0) console.log("[dsh-llm-chatgpt-web] no tool-call block; nudging in-chat");
	}
	return {
		text: captured,
		promptChars: options.prompt.length
	};
}
/** Build a usage record from prompt + answer lengths. */
function estimateUsage(promptChars, answerChars) {
	return {
		inputTokens: Math.max(1, Math.ceil(promptChars / 4)),
		outputTokens: Math.max(1, Math.ceil(answerChars / 4))
	};
}
//#endregion
//#region src/adapter.ts
/**
* `ChatGptWebAdapter`: drive ChatGPT Temporary Chat in an owned Chromium and
* emit harness StreamChunks. Transport-only: connection facts arrive through
* a thunk resolved once per operation; turns are serialized on one browser.
*
* No bridge daemon, no Codex task, no MCP: each turn owns a fresh Temporary
* Chat page and the full DSH history is compiled into its prompt.
* @module dsh-llm-chatgpt-web/adapter
*/
/** Monotonic suffix for provider-issued call ids (unique per process). */
let toolCallSequence = 0;
function mintCallId() {
	toolCallSequence += 1;
	return CallId(`call-${toolCallSequence}`);
}
/** Default whole-turn budget. */
const DEFAULT_TURN_TIMEOUT_MS = 3e5;
const DEFAULT_STALL_TIMEOUT_MS = 12e4;
/** Default manual login window. */
const DEFAULT_LOGIN_TIMEOUT_MS = 6e5;
/** Default daemon idle shutdown. */
const DEFAULT_DAEMON_IDLE_MS = 18e5;
/** Default combined request/response context capacity (Plus High window). */
const DEFAULT_CONTEXT_WINDOW = 9e4;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 16384;
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.inputModalities ?? ["text"]
	};
}
/** One-line page snapshot for probe/setup failures (no content, just shape). */
async function describeProbePage(page) {
	const url = page.url();
	const title = await page.title().catch(() => "?");
	const composers = await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).count().catch(() => -1);
	return `url=${url} title=${JSON.stringify(title)} visibleComposers=${composers}`;
}
/**
* ChatGPT Web adapter. One instance owns one browser; concurrent `stream()`
* calls are serialized so at most one Temporary Chat page is ever active.
*/
var ChatGptWebAdapter = class extends LlmAdapter {
	config;
	browser;
	browserKey;
	capabilities;
	queue = Promise.resolve();
	/** One-shot retry notices keyed by session (consumed on next turn). */
	pendingNotices = /* @__PURE__ */ new Map();
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "ChatGPT Web"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = connection.models.find((entry) => entry.id === model);
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens
		});
	}
	stream(options) {
		return this.enqueue(() => this.runTurn(options));
	}
	/** Release the owned browser. Hosts should call this on plugin unload. */
	async dispose() {
		const pending = this.queue;
		let release = () => {};
		this.queue = new Promise((resolve) => {
			release = resolve;
		});
		await pending;
		try {
			await this.browser?.close().catch(() => {});
		} finally {
			this.browser = void 0;
			this.browserKey = void 0;
			this.capabilities = void 0;
			release();
		}
	}
	/** Serialize turns: one page at a time, in call order. */
	async *enqueue(run) {
		const previous = this.queue;
		let release = () => {};
		this.queue = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			yield* run();
		} finally {
			release();
		}
	}
	browserFor(connection) {
		const key = `${connection.profileDir}\0${connection.chromeExecutablePath ?? ""}\0${connection.headed}\0${connection.offscreen}`;
		if (!this.browser || this.browserKey !== key) {
			this.browser?.close().catch(() => {});
			this.browser = new ChatGptBrowser({
				profileDir: connection.profileDir,
				chromeExecutablePath: connection.chromeExecutablePath,
				headed: connection.headed,
				offscreen: connection.offscreen,
				loginTimeoutMs: connection.loginTimeoutMs,
				daemonIdleMs: connection.daemonIdleMs
			});
			this.browserKey = key;
			this.capabilities = void 0;
		}
		return this.browser;
	}
	/** Consume (get + delete) the pending retry notice for this session, if any. */
	takeNotice(options) {
		const key = options.sessionId !== void 0 ? String(options.sessionId) : "standalone";
		const notice = this.pendingNotices.get(key);
		if (notice !== void 0) this.pendingNotices.delete(key);
		return notice;
	}
	/** Remember a retry notice for the session's next turn. */
	stashNotice(options, notice) {
		const key = options.sessionId !== void 0 ? String(options.sessionId) : "standalone";
		this.pendingNotices.set(key, notice);
	}
	/**
	* Close the turn: text block-end, parsed tool calls, usage, terminal
	* finish. Live text deltas already streamed as block 0; calls follow in
	* source order with fresh indexes (assembler joins them deterministically).
	*/
	async *emitTurnResult(options, prompt, fullText, textIndex) {
		const known = new Set((options.tools ?? []).map((tool) => tool.name));
		yield {
			type: "block-end",
			index: textIndex,
			block: {
				type: "text",
				text: fullText
			}
		};
		let callCount = 0;
		if (known.size > 0) {
			const parsed = parseToolCalls(fullText, known);
			let nextIndex = textIndex + 1;
			for (const segment of parsed.segments) {
				if (segment.type !== "call") continue;
				const id = mintCallId();
				yield {
					type: "block-start",
					index: nextIndex,
					blockType: "tool-call"
				};
				yield {
					type: "tool-call-delta",
					index: nextIndex,
					id,
					name: segment.call.name,
					argumentsDelta: segment.call.arguments
				};
				yield {
					type: "block-end",
					index: nextIndex,
					block: {
						type: "tool-call",
						id,
						name: segment.call.name,
						arguments: segment.call.arguments
					}
				};
				nextIndex += 1;
			}
			callCount = parsed.callCount;
			if (parsed.rejected.length > 0) {
				for (const entry of parsed.rejected) console.log(`[dsh-llm-chatgpt-web] rejected tool-call: ${entry.reason} :: ${JSON.stringify(entry.raw)}`);
				this.stashNotice(options, renderRejectionNotice(parsed.rejected));
			}
		}
		yield {
			type: "usage",
			usage: estimateUsage(prompt.length, fullText.length)
		};
		if (fullText.length === 0 && callCount === 0) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				}
			};
			return;
		}
		yield {
			type: "finish",
			reason: callCount > 0 ? { kind: "tool-calls" } : { kind: "stop" }
		};
	}
	async *runTurn(options) {
		const connection = this.config.options();
		for (const message of options.messages) if (contentHasImage(message.content)) throw new LlmError("ChatGPT Web adapter cannot represent image content (V1 is text-only).", "UNSUPPORTED_CONTENT");
		const prompt = compilePrompt(options, COMPOSER_CHAR_BUDGET, this.takeNotice(options));
		const browser = this.browserFor(connection);
		await browser.ensureReady(options.signal);
		const page = await browser.newTurnPage();
		let iterator;
		try {
			await prepareTemporaryChatSurface(page, connection.profileDir);
			if (!this.capabilities || !browser.probed) {
				try {
					this.capabilities = await detectChatGptAccountCapabilities(page);
				} catch (error) {
					throw new LlmError(`ChatGPT account capability probe failed (${error instanceof Error ? error.message : String(error)}). page=${await describeProbePage(page)}`, "PROVIDER_ERROR", { cause: error });
				}
				browser.markProbed();
			}
			const capabilities = this.capabilities;
			const hasTools = (options.tools?.length ?? 0) > 0;
			iterator = streamTextTurn(page, {
				model: options.model,
				prompt,
				capabilities,
				turnTimeoutMs: connection.turnTimeoutMs,
				stallTimeoutMs: connection.stallTimeoutMs,
				...options.signal !== void 0 ? { signal: options.signal } : {},
				...hasTools ? { requiresToolCall: true } : {}
			})[Symbol.asyncIterator]();
			let blockIndex = -1;
			let fullText = "";
			for (;;) {
				const step = await iterator.next();
				if (step.done) {
					fullText = step.value.text;
					break;
				}
				if (blockIndex < 0) {
					blockIndex = 0;
					yield {
						type: "block-start",
						index: blockIndex,
						blockType: "text"
					};
				}
				fullText += step.value.delta;
				yield {
					type: "text-delta",
					index: blockIndex,
					text: step.value.delta
				};
			}
			if (blockIndex < 0) {
				blockIndex = 0;
				yield {
					type: "block-start",
					index: blockIndex,
					blockType: "text"
				};
			}
			yield* this.emitTurnResult(options, prompt, fullText, blockIndex);
		} catch (error) {
			if (options.signal?.aborted) {
				await page.locator("[data-testid=\"stop-button\"]").last().press("Enter").catch(() => {});
				try {
					await iterator?.return?.();
				} catch {}
				throw new LlmError("ChatGPT Web request aborted by caller.", "ABORTED", { cause: error });
			}
			if (error instanceof LlmError) throw error;
			throw new LlmError("ChatGPT Web turn failed.", "TRANSPORT", { cause: error });
		}
	}
};
//#endregion
//#region src/index.ts
const name = "llm-chatgpt-web";
const inject = ["llm"];
/** The single provider route this plugin owns. */
const PROVIDER = "chatgpt-web";
const DEFAULT_MODELS = [
	{
		id: "chatgpt-web/luna",
		name: "ChatGPT Web Luna",
		contextWindow: 105e4
	},
	{
		id: "chatgpt-web/think",
		name: "ChatGPT Web Think",
		contextWindow: 105e4
	},
	{
		id: "chatgpt-web/light",
		name: "ChatGPT Web Instant",
		contextWindow: 41e3
	},
	{
		id: "chatgpt-web/medium",
		name: "ChatGPT Web Medium",
		contextWindow: 9e4
	},
	{
		id: "chatgpt-web/high",
		name: "ChatGPT Web High",
		contextWindow: 9e4
	},
	{
		id: "chatgpt-web/extra-high",
		name: "ChatGPT Web Extra High",
		contextWindow: 112001
	},
	{
		id: "chatgpt-web/pro",
		name: "ChatGPT Web Pro",
		contextWindow: 112001
	}
];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	inputModalities: z.array(z.union(["text", "image"])).min(1).default(["text"])
});
const Config = z.object({
	profileDir: z.string().default(defaultProfileDir()),
	chromeExecutablePath: z.string(),
	headed: z.boolean().default(false),
	offscreen: z.boolean().default(true),
	daemonIdleMs: z.number().min(6e4).max(2147483647).default(DEFAULT_DAEMON_IDLE_MS),
	loginTimeoutMs: z.number().min(1).max(2147483647).default(DEFAULT_LOGIN_TIMEOUT_MS),
	turnTimeoutMs: z.number().min(1).max(2147483647).default(DEFAULT_TURN_TIMEOUT_MS),
	stallTimeoutMs: z.number().min(1).max(2147483647).default(DEFAULT_STALL_TIMEOUT_MS),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	retryPolicy: RetryPolicySchema
});
function expandHome(path) {
	if (path === "~" || path.startsWith("~/")) return (process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".") + path.slice(1);
	return path;
}
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-chatgpt-web: catalog model ids must be non-empty");
		if (!model.id.startsWith("chatgpt-web/")) throw new Error(`llm-chatgpt-web: catalog model "${model.id}" must start with "chatgpt-web/"`);
		if (seen.has(model.id)) throw new Error(`llm-chatgpt-web: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			inputModalities: [...model.inputModalities ?? ["text"]]
		};
	});
}
/**
* The one explicit resolve step from raw config to validated connection facts.
*/
function resolveAdapterOptions(config) {
	return {
		profileDir: expandHome(config.profileDir ?? defaultProfileDir()),
		chromeExecutablePath: config.chromeExecutablePath ? expandHome(config.chromeExecutablePath) : resolveChromeExecutable(),
		headed: config.headed ?? false,
		offscreen: config.offscreen ?? true,
		daemonIdleMs: config.daemonIdleMs ?? 18e5,
		loginTimeoutMs: config.loginTimeoutMs ?? 6e5,
		turnTimeoutMs: config.turnTimeoutMs ?? 3e5,
		stallTimeoutMs: config.stallTimeoutMs ?? 12e4,
		maxTokens: config.maxTokens ?? 16384,
		defaultContextWindow: config.defaultContextWindow ?? 9e4,
		models: resolveModels(config.models),
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-chatgpt-web: retryPolicy")
	};
}
function apply(ctx, config) {
	const options = () => resolveAdapterOptions(config);
	options();
	const adapter = new ChatGptWebAdapter({ options });
	ctx.llm.registerAdapter([PROVIDER], adapter);
	ctx.effect(() => () => {
		adapter.dispose().catch(() => {});
	});
}
//#endregion
export { ChatGptWebAdapter, Config, PROVIDER, apply, compilePrompt, inject, name, resolveAdapterOptions };
