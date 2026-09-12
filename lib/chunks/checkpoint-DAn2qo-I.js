import { c as STEALTH_INIT_SCRIPT, n as ensureDaemonBrowser, o as STEALTH_ARGS, r as touchEndpoint, s as STEALTH_IGNORE_DEFAULT_ARGS } from "./daemon-DqpESjWr.js";
import { r as NativeSafetyError, t as NativeApprovalRequiredError } from "./errors-cqWy_ojP.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } from "node:constants";
//#region src/native/canonical.ts
const CONTROL_BYTES$2 = /[\u0000-\u001f\u007f]/;
function normalizeJson(value, stack, inArray) {
	if (value === void 0) return inArray ? null : void 0;
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("native canonical JSON cannot contain a non-finite number");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`native canonical JSON contains a non-JSON value (${typeof value})`);
	if (stack.has(value)) throw new TypeError("native canonical JSON contains a cycle");
	stack.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => normalizeJson(item, stack, true));
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError("native canonical JSON accepts only plain objects");
		const result = {};
		const objectValue = value;
		for (const key of Object.keys(objectValue).sort()) {
			const child = normalizeJson(objectValue[key], stack, false);
			if (child !== void 0) result[key] = child;
		}
		return result;
	} finally {
		stack.delete(value);
	}
}
/** Serialize JSON-shaped values with deterministic object-key ordering. */
function canonicalJson(value) {
	const serialized = JSON.stringify(normalizeJson(value, /* @__PURE__ */ new WeakSet(), false));
	return serialized === void 0 ? "undefined" : serialized;
}
/** Hash one canonical value with an explicit domain, version, and payload length. */
function hashCanonical(domain, version, value) {
	if (domain.length === 0 || CONTROL_BYTES$2.test(domain)) throw new TypeError("native canonical hash domain must be non-empty and control-free");
	if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("native canonical hash version must be a non-negative safe integer");
	const payload = canonicalJson(value);
	return createHash("sha256").update(`${domain}\u0000${version}\u0000${Buffer.byteLength(payload, "utf8")}\u0000`).update(payload).digest("hex");
}
//#endregion
//#region src/chatgpt/session.ts
const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_CONNECTOR_CHAT_URL = "https://chatgpt.com/";
function chatGptSurfaceUrl(surface) {
	return surface === "temporary" ? CHATGPT_TEMPORARY_CHAT_URL : CHATGPT_CONNECTOR_CHAT_URL;
}
function assertChatGptSurfaceUrl(value, surface) {
	const url = new URL(value);
	const expected = new URL(chatGptSurfaceUrl(surface));
	const isTemporary = url.searchParams.get("temporary-chat") === "true";
	if (url.origin === expected.origin && url.pathname === expected.pathname && (surface === "temporary" ? isTemporary : !isTemporary)) return;
	if (surface === "temporary") throw new Error(`ChatGPT left the isolated Temporary Chat surface (${value})`);
	throw new Error(`ChatGPT left the normal connector-enabled chat surface (${value})`);
}
const CHATGPT_COMPOSER_SELECTOR = [
	"[data-testid=\"prompt-textarea\"]",
	"#prompt-textarea",
	"[contenteditable=\"true\"][data-lexical-editor=\"true\"]",
	"[contenteditable=\"true\"].ProseMirror",
	"[role=\"textbox\"][aria-label=\"Chat with ChatGPT\"]"
].join(", ");
/** Visible mention rows used by the Personalized connector picker. */
const CHATGPT_CONNECTOR_MENU_ITEM_SELECTOR = ".__menu-item[tabindex=\"0\"]";
/** Connector pills are verified by exact keyword after mention selection. */
const CHATGPT_CONNECTOR_PILL_SELECTOR = "[data-id^=\"plugin:\"][data-keyword]";
const CHATGPT_EFFORT_CONTROL_SELECTOR = ["button[aria-haspopup=\"menu\"][data-tone=\"neutral\"]", "button[data-testid=\"model-switcher-dropdown-button\"][aria-haspopup=\"menu\"]"].join(", ");
const CHATGPT_EFFORT_MENU_SELECTOR = [
	"[data-testid=\"composer-intelligence-picker-content\"]:has([role=\"menuitemradio\"], [data-model-reasoning-effort-slider])",
	"[role=\"menu\"]:has([role=\"menuitemradio\"], [data-model-reasoning-effort-slider])",
	"[role=\"group\"]:has([role=\"menuitemradio\"], [data-model-reasoning-effort-slider])"
].join(", ");
const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = "[data-model-reasoning-effort-slider]";
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
* daemon browser, owns one context per adapter lifetime and one FRESH page
* per turn.
*
* Login model: the first run with no saved session opens a headed window at
* chatgpt.com where the user signs in manually; the verified session is
* saved and all later turns attach to the daemon. No launcher app, no
* copied profiles. The daemon (not this process) owns hiding and
* minimization, so turns never flash a window after the daemon's birth.
*
* Session freshness (ported from upstream browser-worker): after EVERY
* successful turn the context storageState is atomically persisted back to
* the profile — ChatGPT rotates session tokens continuously, so a state
* captured only at login goes stale mid-flight.
*
* Page lifecycle (ported from upstream pageForNewTurn): each turn owns a
* fresh page; reusing one SPA page across turns retains the previous
* transcript and autocomplete DOM, which breaks assistant-turn indexing.
* The adapter closes the page after the turn.
* @module dsh-llm-chatgpt-web/chatgpt-browser
*/
function storageStatePath(profileDir) {
	return join(profileDir, "storage-state.json");
}
/** Atomic write: temp file + rename, so a crash never truncates the state. */
function persistStorageState(profileDir, state) {
	const path = storageStatePath(profileDir);
	const temp = `${path}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 384 });
		renameSync(temp, path);
	} catch (error) {
		console.log(`[dsh-llm-chatgpt-web] storageState persist failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Open a page, reconnecting once and re-reading the replacement context. */
async function openNewPageWithReconnect(currentContext, reconnect) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const context = currentContext();
		if (!context) throw new LlmError("ChatGPT Web browser is not ready.", "TRANSPORT");
		try {
			return await context.newPage();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/browser closed|connection closed|context closed|target closed|session closed/i.test(message) || attempt > 0) throw new LlmError(`ChatGPT Web browser page could not be opened (${message}).`, "TRANSPORT", { cause: error });
			await reconnect();
		}
	}
	throw new LlmError("ChatGPT Web browser page could not be opened.", "TRANSPORT");
}
/**
* One daemon attachment for the adapter's lifetime. Turns are serialized by
* the caller; each turn gets a FRESH page in the shared context and closes
* it when done.
*
* Never closes the shared browser: `close()` releases only this attachment's
* context. The daemon reaps itself after `daemonIdleMs` without turns.
*/
var ChatGptBrowser = class {
	options;
	browser;
	context;
	capabilitiesProbed = false;
	loginPromise;
	constructor(options) {
		this.options = options;
	}
	/** Connect (spawning the daemon on first use) and guarantee a login session. */
	async ensureReady(signal) {
		if (this.browser && this.context) {
			if (this.browser.isConnected()) return;
			console.log("[dsh-llm-chatgpt-web] daemon connection dead; reattaching");
			this.context = void 0;
			this.browser = void 0;
			this.capabilitiesProbed = false;
		}
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
	/**
	* Open a FRESH page for one turn (upstream pageForNewTurn: a reused SPA
	* page retains the previous transcript and autocomplete DOM). The caller
	* closes it. Self-healing: if the daemon connection dropped between turns
	* (idle exit raced a connect, machine sleep, crash), one reconnect
	* attempt runs before surfacing the error.
	*/
	async newTurnPage() {
		touchEndpoint(this.options.profileDir);
		return openNewPageWithReconnect(() => this.context, async () => {
			console.log("[dsh-llm-chatgpt-web] daemon connection lost; reconnecting");
			this.context = void 0;
			this.browser = void 0;
			this.capabilitiesProbed = false;
			await this.ensureReady();
		});
	}
	/**
	* Persist the session after a completed turn (upstream does this after
	* every managed-chrome turn): ChatGPT rotates session tokens, and the
	* daemon keeps living cookies fresher than the login-time snapshot.
	* Best-effort — a failed persist never fails the turn.
	*/
	async persistSession() {
		if (!this.context) return;
		try {
			const state = await this.context.storageState();
			persistStorageState(this.options.profileDir, state);
		} catch (error) {
			console.log(`[dsh-llm-chatgpt-web] storageState read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async close() {
		await this.persistSession().catch(() => {});
		await this.context?.close().catch(() => {});
		this.context = void 0;
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
//#region src/native/private-files.ts
function errorCode$2(error) {
	return error?.code;
}
function assertCurrentUser(stat, label) {
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
}
function assertPrivateMode(mode, label, executable) {
	const permissions = mode & 511;
	const expected = executable ? 448 : 384;
	if (permissions !== expected) throw new Error(`${label} has unsafe permissions: expected ${expected.toString(8)}, got ${permissions.toString(8)}`);
}
function assertPrivateRegularFile(path, label, executable = false) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (errorCode$2(error) === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
	if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
	assertCurrentUser(stat, label);
	assertPrivateMode(stat.mode, label, executable);
}
function assertPrivateDirectory(path, label = "private directory") {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (errorCode$2(error) === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
	if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	assertCurrentUser(stat, label);
	if ((stat.mode & 511) !== 448) throw new Error(`${label} has unsafe permissions: expected 700, got ${(stat.mode & 511).toString(8)}`);
}
/** Create a missing directory privately; never repair an unsafe existing one. */
function ensurePrivateDirectory(path) {
	try {
		lstatSync(path);
	} catch (error) {
		if (errorCode$2(error) !== "ENOENT") throw error;
		mkdirSync(path, {
			recursive: true,
			mode: 448
		});
	}
	assertPrivateDirectory(path);
}
function assertPrivate0600(path, label) {
	assertPrivateRegularFile(path, label);
	const mode = lstatSync(path).mode & 511;
	if (mode !== 384) throw new Error(`${label} has unsafe permissions: expected 600, got ${mode.toString(8)}`);
}
function assertReplaceableTarget(path) {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`private file must not be a symlink: ${path}`);
		if (!stat.isFile()) throw new Error(`private file is not a regular file: ${path}`);
		assertCurrentUser(stat, "private file");
		if ((stat.mode & 63) !== 0) throw new Error(`private file has unsafe permissions: ${path}`);
	} catch (error) {
		if (errorCode$2(error) !== "ENOENT") throw error;
	}
}
/** Write a private file with file and parent-directory durability. */
function durableAtomicWritePrivateFile(path, data, mode = 384) {
	ensurePrivateDirectory(dirname(path));
	assertReplaceableTarget(path);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let fd;
	let createdTemporary = false;
	try {
		fd = openSync(temporary, "wx", mode);
		createdTemporary = true;
		fchmodSync(fd, mode);
		writeFileSync(fd, data);
		fsyncSync(fd);
		closeSync(fd);
		fd = void 0;
		renameSync(temporary, path);
		assertPrivateRegularFile(path, "private file", mode === 448);
		const directoryFd = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} catch (error) {
		if (fd !== void 0) try {
			closeSync(fd);
		} catch {}
		if (createdTemporary) try {
			rmSync(temporary, { force: true });
		} catch {}
		throw error;
	}
}
/** Sync an already-private directory after a durable mutation. */
function syncPrivateDirectory(path) {
	assertPrivateDirectory(path);
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
const MAX_PRIVATE_APPEND_RECORD_BYTES = 16384;
const MAX_PRIVATE_APPEND_BYTES = 4194304;
const MAX_PRIVATE_APPEND_RECORDS = 4096;
function privateStateError(message, cause) {
	return new NativeSafetyError(message, cause, "NATIVE_PRIVATE_STATE");
}
function validateAppendFile(path, nextBytes) {
	assertPrivate0600(path, "private append file");
	const bytes = readFileSync(path);
	if (bytes.byteLength > MAX_PRIVATE_APPEND_BYTES || bytes.byteLength + nextBytes > MAX_PRIVATE_APPEND_BYTES) throw privateStateError("private append file exceeds its durability limit");
	if (bytes.byteLength === 0) return {
		size: 0,
		records: 0
	};
	if (bytes[bytes.byteLength - 1] !== 10) throw privateStateError("private append file has an incomplete final line");
	const lines = bytes.toString("utf8").slice(0, -1).split("\n");
	if (lines.length > MAX_PRIVATE_APPEND_RECORDS) throw privateStateError("private append file exceeds its record limit");
	for (const line of lines) {
		if (Buffer.byteLength(line, "utf8") + 1 > MAX_PRIVATE_APPEND_RECORD_BYTES) throw privateStateError("private append record exceeds its size limit");
		try {
			JSON.parse(line);
		} catch (error) {
			throw privateStateError("private append file contains malformed JSON", error);
		}
	}
	return {
		size: bytes.byteLength,
		records: lines.length
	};
}
/** Append one complete, fsynced, bounded JSONL record to a private file. */
function appendDurablePrivateJsonLine(path, record) {
	if (record === null || typeof record !== "object" || Array.isArray(record)) throw privateStateError("private append records must be JSON objects");
	let serialized;
	try {
		serialized = JSON.stringify(record);
	} catch (error) {
		throw privateStateError("private append record is not JSON serializable", error);
	}
	if (serialized === void 0) throw privateStateError("private append record is not JSON serializable");
	const line = `${serialized}\n`;
	const lineBytes = Buffer.byteLength(line, "utf8");
	if (lineBytes > MAX_PRIVATE_APPEND_RECORD_BYTES) throw privateStateError("private append record exceeds its size limit");
	const parent = dirname(path);
	let fd;
	let created = false;
	let writeCompleted = false;
	try {
		ensurePrivateDirectory(parent);
		try {
			fd = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW, 384);
			created = true;
		} catch (error) {
			if (errorCode$2(error) !== "EEXIST") throw error;
			if (validateAppendFile(path, lineBytes).records >= MAX_PRIVATE_APPEND_RECORDS) throw privateStateError("private append file exceeds its record limit");
			fd = openSync(path, O_WRONLY | O_APPEND | O_NOFOLLOW);
		}
		if (fd === void 0) throw privateStateError("private append file could not be opened");
		try {
			if (created === false) assertPrivate0600(path, "private append file");
			fchmodSync(fd, 384);
			writeFileSync(fd, line, "utf8");
			fsyncSync(fd);
			writeCompleted = true;
		} finally {
			closeSync(fd);
			fd = void 0;
		}
		assertPrivate0600(path, "private append file");
		syncPrivateDirectory(parent);
	} catch (error) {
		if (fd !== void 0) try {
			closeSync(fd);
		} catch {}
		if (created && !writeCompleted) try {
			unlinkSync(path);
			syncPrivateDirectory(parent);
		} catch {}
		if (error instanceof NativeSafetyError) throw error;
		throw privateStateError("private append could not be completed safely", error);
	}
}
const PRIVATE_WRITER_LOCK = "native-checkpoint-writer.lock";
const PRIVATE_WRITER_OWNER = "owner.json";
const PRIVATE_WRITER_VERSION = 1;
const WRITER_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
function isoNow(value, label) {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw privateStateError(`private writer ${label} is invalid`);
	return value.toISOString();
}
function writerText(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw privateStateError(`private writer ${label} is invalid`);
	return value;
}
function writerToken(value, label) {
	const text = writerText(value, label);
	if (!WRITER_TOKEN.test(text)) throw privateStateError(`private writer ${label} is invalid`);
	return text;
}
function writerTimestamp(value, label) {
	const text = writerText(value, label);
	try {
		if (new Date(text).toISOString() !== text) throw privateStateError(`private writer ${label} is invalid`);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw privateStateError(`private writer ${label} is invalid`, error);
	}
	return text;
}
function parseWriterOwner(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw privateStateError("private writer owner metadata is invalid");
	const candidate = value;
	const required = [
		"version",
		"pid",
		"ownerToken",
		"processStartedAt",
		"heartbeatAt"
	];
	if (Object.keys(candidate).some((key) => !required.includes(key)) || required.some((key) => !Object.hasOwn(candidate, key))) throw privateStateError("private writer owner metadata has an invalid key set");
	const pid = candidate.pid;
	if (candidate.version !== PRIVATE_WRITER_VERSION || !Number.isSafeInteger(pid) || pid <= 0) throw privateStateError("private writer owner metadata is invalid");
	return {
		version: 1,
		pid,
		ownerToken: writerToken(candidate.ownerToken, "owner token"),
		processStartedAt: writerTimestamp(candidate.processStartedAt, "process start"),
		heartbeatAt: writerTimestamp(candidate.heartbeatAt, "heartbeat")
	};
}
function readWriterOwner(path) {
	assertPrivate0600(path, "private writer owner");
	try {
		return parseWriterOwner(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw privateStateError("private writer owner metadata is not valid JSON", error);
	}
}
const DEFAULT_PROCESS_STARTED_AT = (/* @__PURE__ */ new Date(Date.now() - process.uptime() * 1e3)).toISOString();
/** Stable process-start identity shared by leases and advisory diagnostics. */
function currentProcessStartedAt() {
	return DEFAULT_PROCESS_STARTED_AT;
}
/** Inspect the writer lease without acquiring, repairing, or deleting it. */
function inspectPrivateWriterLease(profileDir, now = /* @__PURE__ */ new Date()) {
	const lockPath = join(profileDir, PRIVATE_WRITER_LOCK);
	try {
		lstatSync(profileDir);
		assertPrivateDirectory(profileDir, "private writer profile directory");
	} catch (error) {
		if (errorCode$2(error) === "ENOENT") return { state: "missing" };
		return {
			state: "invalid",
			reason: "profile directory is not private"
		};
	}
	try {
		lstatSync(lockPath);
	} catch (error) {
		if (errorCode$2(error) === "ENOENT") return { state: "missing" };
		return {
			state: "invalid",
			reason: "writer lease path could not be inspected"
		};
	}
	try {
		assertPrivateDirectory(lockPath, "private writer lease");
		const entries = readdirSync(lockPath);
		if (entries.length !== 1 || entries[0] !== PRIVATE_WRITER_OWNER) return {
			state: "invalid",
			reason: "writer lease contains unexpected entries"
		};
		const owner = readWriterOwner(join(lockPath, PRIVATE_WRITER_OWNER));
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return {
			state: "ambiguous",
			reason: "writer lease inspection clock is invalid"
		};
		if (Date.parse(owner.heartbeatAt) > now.getTime() || Date.parse(owner.processStartedAt) > now.getTime()) return {
			state: "ambiguous",
			reason: "writer lease timestamp is in the future"
		};
		const observed = defaultWriterDependencies().inspectProcess(owner.pid);
		if (observed.kind === "dead") return {
			state: "stale",
			reason: "writer lease owner is dead"
		};
		if (observed.kind === "ambiguous") return {
			state: "ambiguous",
			reason: "writer lease owner is ambiguous"
		};
		if (observed.startedAt !== owner.processStartedAt) return {
			state: "ambiguous",
			reason: "writer lease PID reuse is ambiguous"
		};
		return { state: "live" };
	} catch (error) {
		if (error instanceof NativeSafetyError) return {
			state: "invalid",
			reason: "writer lease metadata is invalid"
		};
		return {
			state: "ambiguous",
			reason: "writer lease process state is ambiguous"
		};
	}
}
function defaultWriterDependencies() {
	const processStartedAt = DEFAULT_PROCESS_STARTED_AT;
	return {
		pid: process.pid,
		processStartedAt,
		now: () => /* @__PURE__ */ new Date(),
		randomUUID,
		inspectProcess(pid) {
			if (pid === process.pid) return {
				kind: "live",
				startedAt: processStartedAt
			};
			try {
				process.kill(pid, 0);
				return { kind: "ambiguous" };
			} catch (error) {
				if (errorCode$2(error) === "ESRCH") return { kind: "dead" };
				return { kind: "ambiguous" };
			}
		}
	};
}
function sameWriterOwner(left, right) {
	return left.version === right.version && left.pid === right.pid && left.ownerToken === right.ownerToken && left.processStartedAt === right.processStartedAt;
}
function removeQuarantine(path, parent) {
	rmSync(path, {
		recursive: true,
		force: false
	});
	syncPrivateDirectory(parent);
}
/** Acquire the profile-wide atomic checkpoint writer lease. */
function acquirePrivateWriterLease(profileDir, supplied) {
	const defaults = defaultWriterDependencies();
	const dependencies = {
		pid: supplied?.pid ?? defaults.pid,
		processStartedAt: supplied?.processStartedAt ?? defaults.processStartedAt,
		now: supplied?.now ?? defaults.now,
		randomUUID: supplied?.randomUUID ?? defaults.randomUUID,
		inspectProcess: supplied?.inspectProcess ?? defaults.inspectProcess
	};
	try {
		ensurePrivateDirectory(profileDir);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw privateStateError("private writer profile directory is not safe", error);
	}
	const lockPath = join(profileDir, PRIVATE_WRITER_LOCK);
	const ownerPath = join(lockPath, PRIVATE_WRITER_OWNER);
	if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 0) throw privateStateError("private writer PID is invalid");
	const makeOwner = () => ({
		version: PRIVATE_WRITER_VERSION,
		pid: dependencies.pid,
		ownerToken: writerToken(dependencies.randomUUID(), "owner token"),
		processStartedAt: writerTimestamp(dependencies.processStartedAt, "process start"),
		heartbeatAt: isoNow(dependencies.now(), "heartbeat")
	});
	const writeOwner = (owner) => {
		if (!WRITER_TOKEN.test(owner.ownerToken)) throw privateStateError("private writer owner token is invalid");
		durableAtomicWritePrivateFile(ownerPath, `${JSON.stringify(owner)}\n`, 384);
	};
	const createLease = () => {
		const owner = makeOwner();
		let created = false;
		try {
			mkdirSync(lockPath, { mode: 448 });
			created = true;
			assertPrivateDirectory(lockPath);
			syncPrivateDirectory(profileDir);
			writeOwner(owner);
		} catch (error) {
			if (created) try {
				rmSync(lockPath, {
					recursive: true,
					force: true
				});
			} catch {}
			throw error;
		}
		let released = false;
		const assertOwner = () => {
			if (released) throw privateStateError("private writer lease is already released");
			const current = readWriterOwner(ownerPath);
			if (!sameWriterOwner(current, owner)) throw privateStateError("private writer lease ownership changed");
			return current;
		};
		return {
			ownerToken: owner.ownerToken,
			heartbeat() {
				const next = {
					...assertOwner(),
					heartbeatAt: isoNow(dependencies.now(), "heartbeat")
				};
				writeOwner(next);
			},
			release() {
				if (released) return;
				assertOwner();
				rmSync(lockPath, {
					recursive: true,
					force: false
				});
				syncPrivateDirectory(profileDir);
				released = true;
			}
		};
	};
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			return createLease();
		} catch (error) {
			if (error.code !== "EEXIST") {
				if (error instanceof NativeSafetyError) throw error;
				throw privateStateError("private writer lease is unavailable", error);
			}
		}
		let existing;
		try {
			assertPrivateDirectory(lockPath);
			existing = readWriterOwner(ownerPath);
		} catch (error) {
			if (error instanceof NativeSafetyError) throw error;
			throw privateStateError("private writer lease metadata is unreadable", error);
		}
		const now = dependencies.now();
		if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || new Date(existing.heartbeatAt).getTime() > now.getTime() || new Date(existing.processStartedAt).getTime() > now.getTime()) throw privateStateError("private writer lease heartbeat is ambiguous");
		let state;
		try {
			state = dependencies.inspectProcess(existing.pid);
		} catch (error) {
			throw privateStateError("private writer lease process state is ambiguous", error);
		}
		if (state.kind !== "dead" && state.kind !== "live" && state.kind !== "ambiguous") throw privateStateError("private writer lease process state is invalid");
		if (state.kind === "ambiguous") throw privateStateError("private writer lease owner is ambiguous");
		if (state.kind === "live") {
			if (writerTimestamp(state.startedAt, "observed process start") !== existing.processStartedAt) throw privateStateError("private writer lease owner has ambiguous PID reuse");
			throw privateStateError("private checkpoint writer lease is already held");
		}
		const quarantine = join(profileDir, `.native-checkpoint-writer-stale-${writerToken(dependencies.randomUUID(), "quarantine token")}`);
		try {
			renameSync(lockPath, quarantine);
			syncPrivateDirectory(profileDir);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw privateStateError("private writer lease could not be quarantined safely", error);
		}
		let moved;
		try {
			moved = readWriterOwner(join(quarantine, PRIVATE_WRITER_OWNER));
		} catch (error) {
			try {
				renameSync(quarantine, lockPath);
			} catch {}
			throw error;
		}
		if (!sameWriterOwner(moved, existing)) {
			try {
				renameSync(quarantine, lockPath);
			} catch {}
			throw privateStateError("private writer lease changed during quarantine");
		}
		try {
			const lease = createLease();
			try {
				removeQuarantine(quarantine, profileDir);
			} catch (error) {
				try {
					lease.release();
				} catch {}
				throw privateStateError("private writer stale lease could not be removed safely", error);
			}
			return lease;
		} catch (error) {
			try {
				removeQuarantine(quarantine, profileDir);
			} catch {}
			if (errorCode$2(error) === "EEXIST") continue;
			throw error;
		}
	}
	throw privateStateError("private writer lease could not be acquired without a race");
}
function atomicWritePrivateFile(path, data, mode = 384) {
	ensurePrivateDirectory(dirname(path));
	assertReplaceableTarget(path);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const fd = openSync(temporary, "wx", mode);
	try {
		writeFileSync(fd, data);
		closeSync(fd);
		renameSync(temporary, path);
		chmodSync(path, mode);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {}
		rmSync(temporary, { force: true });
		throw error;
	}
}
function removePrivateFile(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (errorCode$2(error) === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error(`refusing to remove symlink: ${path}`);
	if (!stat.isFile()) throw new Error(`refusing to remove non-file: ${path}`);
	assertCurrentUser(stat, "private file");
	if ((stat.mode & 63) !== 0) throw new Error(`refusing to remove unsafe private file: ${path}`);
	unlinkSync(path);
}
function snapshotPrivateFile(path) {
	let existed = false;
	let bytes = /* @__PURE__ */ new Uint8Array();
	let mode = 384;
	try {
		const stat = lstatSync(path);
		existed = true;
		if (stat.isSymbolicLink()) throw new Error(`cannot snapshot symlink: ${path}`);
		if (!stat.isFile()) throw new Error(`cannot snapshot non-file: ${path}`);
		assertCurrentUser(stat, "private file");
		if ((stat.mode & 63) !== 0) throw new Error(`cannot snapshot unsafe private file: ${path}`);
		bytes = new Uint8Array(readFileSync(path));
		mode = (stat.mode & 73) !== 0 ? 448 : 384;
	} catch (error) {
		if (errorCode$2(error) !== "ENOENT") throw error;
	}
	let active = true;
	return {
		path,
		restore() {
			if (!active) return;
			if (existed) atomicWritePrivateFile(path, bytes, mode);
			else removePrivateFile(path);
			active = false;
		},
		discard() {
			active = false;
		}
	};
}
//#endregion
//#region src/chatgpt/conversation-cleanup.ts
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEDGER_FILE_NAME = "owned-conversations.json";
const LEDGER_VERSION = 1;
const DEFAULT_DELETE_TIMEOUT_MS = 1e4;
function errorCode$1(error) {
	return error?.code;
}
function assertConversationId(value) {
	if (!CONVERSATION_ID_PATTERN.test(value)) throw new Error(`invalid ChatGPT conversation ID: ${value}`);
}
/** Extract a conversation ID only from the canonical ChatGPT conversation route. */
function conversationIdFromUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return;
	}
	if (url.origin !== CHATGPT_ORIGIN) return void 0;
	const match = /^\/c\/([^/]+)$/.exec(url.pathname);
	if (match === null || !CONVERSATION_ID_PATTERN.test(match[1])) return void 0;
	return match[1];
}
/** Build the canonical URL for one already-validated owned conversation. */
function conversationUrl(conversationId) {
	assertConversationId(conversationId);
	return `${CHATGPT_ORIGIN}/c/${conversationId}`;
}
function ledgerPath(profileDir) {
	return join(profileDir, LEDGER_FILE_NAME);
}
function readLedgerFile(path) {
	try {
		lstatSync(path);
	} catch (error) {
		if (errorCode$1(error) === "ENOENT") return [];
		throw error;
	}
	assertPrivateRegularFile(path, "owned conversation ledger");
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error("owned conversation ledger is not valid JSON", { cause: error });
	}
	if (parsed === null || typeof parsed !== "object") throw new Error("owned conversation ledger has an invalid shape");
	const file = parsed;
	if (file.version !== LEDGER_VERSION || !Array.isArray(file.conversationIds)) throw new Error("owned conversation ledger has an unsupported version or shape");
	const ids = file.conversationIds.map((id) => {
		if (typeof id !== "string") throw new Error("owned conversation ledger contains a non-string ID");
		assertConversationId(id);
		return id;
	});
	if (new Set(ids).size !== ids.length) throw new Error("owned conversation ledger contains duplicate IDs");
	return ids;
}
function writeLedgerFile(path, ids) {
	durableAtomicWritePrivateFile(path, `${JSON.stringify({
		version: LEDGER_VERSION,
		conversationIds: ids
	})}\n`, 384);
}
/** Private, restart-safe ledger for chats created by this adapter only. */
function createOwnedConversationLedger(profileDir) {
	const path = ledgerPath(profileDir);
	let ids = readLedgerFile(path);
	return {
		pending() {
			return [...ids];
		},
		remember(conversationId) {
			assertConversationId(conversationId);
			if (ids.includes(conversationId)) return;
			const next = [...ids, conversationId];
			writeLedgerFile(path, next);
			ids = next;
		},
		forget(conversationId) {
			assertConversationId(conversationId);
			if (!ids.includes(conversationId)) return;
			const next = ids.filter((id) => id !== conversationId);
			writeLedgerFile(path, next);
			ids = next;
		}
	};
}
function visible(locator) {
	return locator.isVisible().catch(() => false);
}
async function waitVisible(locator, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await visible(locator)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
}
async function waitForDeletionVerification(page, conversationId, timeoutMs) {
	const historyLink = page.locator(`a[href="/c/${conversationId}"]`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const activeId = conversationIdFromUrl(page.url());
		const listed = await historyLink.count().catch(() => 0);
		if (activeId !== conversationId && listed === 0) return;
		if (Date.now() >= deadline) throw new LlmError("ChatGPT conversation deletion could not be verified for the adapter-owned conversation.", "PROVIDER_ERROR");
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
}
/** Delete exactly the conversation currently open on `page`, then verify it is gone. */
async function deleteOwnedConversation(page, conversationId, timeoutMs = DEFAULT_DELETE_TIMEOUT_MS) {
	assertConversationId(conversationId);
	if (conversationIdFromUrl(page.url()) !== conversationId) throw new LlmError("Refusing to delete a ChatGPT conversation whose URL does not match the owned ID.", "PROVIDER_ERROR");
	const optionsButton = page.locator("#conversation-header-actions").getByTestId("conversation-options-button").last();
	if (!await waitVisible(optionsButton, timeoutMs)) throw new LlmError("ChatGPT owned conversation has no active-header conversation-options control.", "PROVIDER_ERROR");
	await optionsButton.click({ force: true });
	const deleteButton = page.getByTestId("delete-chat-menu-item").filter({ visible: true }).last();
	if (!await waitVisible(deleteButton, timeoutMs)) throw new LlmError("ChatGPT owned conversation has no delete action.", "PROVIDER_ERROR");
	await deleteButton.click({ force: true });
	const confirmButton = page.getByTestId("delete-conversation-confirm-button").filter({ visible: true }).last();
	if (!await waitVisible(confirmButton, timeoutMs)) throw new LlmError("ChatGPT owned conversation deletion has no confirmation action.", "PROVIDER_ERROR");
	await confirmButton.click({ force: true });
	await waitForDeletionVerification(page, conversationId, timeoutMs);
}
async function waitForOwnedConversationReady(page, conversationId, timeoutMs) {
	const optionsButton = page.locator("#conversation-header-actions").getByTestId("conversation-options-button").filter({ visible: true }).last();
	const turns = page.locator("[data-testid^=\"conversation-turn-\"]");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (conversationIdFromUrl(page.url()) === conversationId && await visible(optionsButton) && await turns.count().catch(() => 0) > 0) return;
		if (Date.now() >= deadline) throw new LlmError("ChatGPT could not load the adapter-owned conversation before cleanup.", "PROVIDER_ERROR");
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
}
async function waitForSettledHome(page, conversationId, timeoutMs) {
	const historyLink = page.locator(`a[href="/c/${conversationId}"]`);
	const composer = page.locator("[data-testid=\"prompt-textarea\"], #prompt-textarea, [contenteditable=\"true\"].ProseMirror, [role=\"textbox\"][aria-label=\"Chat with ChatGPT\"]");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (conversationIdFromUrl(page.url()) !== void 0) return false;
		if (await visible(composer) && await historyLink.count().catch(() => 0) === 0) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
}
/** Retry private deletion records before a new native turn can create another chat. */
async function retryPendingConversationDeletions(page, ledger, timeoutMs = DEFAULT_DELETE_TIMEOUT_MS) {
	for (const conversationId of ledger.pending()) {
		await page.goto(conversationUrl(conversationId), {
			waitUntil: "domcontentloaded",
			timeout: 6e4
		});
		if (conversationIdFromUrl(page.url()) === conversationId) {
			await waitForOwnedConversationReady(page, conversationId, timeoutMs);
			await deleteOwnedConversation(page, conversationId, timeoutMs);
		} else if (!await waitForSettledHome(page, conversationId, timeoutMs)) throw new LlmError("ChatGPT could not verify removal of a pending adapter-owned conversation.", "PROVIDER_ERROR");
		ledger.forget(conversationId);
	}
}
//#endregion
//#region src/native/runtime-config.ts
const MANAGED_TUNNEL_CLIENT_VERSION = "0.0.12";
const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const CONNECTOR_NAME_MAX = 80;
function defaultNativeRuntimeConfigPath(profileDir) {
	return join(resolve(profileDir), "native-runtime.json");
}
function defaultManagedRuntimePaths(profileDir) {
	const root = resolve(profileDir);
	const binDir = join(root, "bin");
	return {
		configPath: defaultNativeRuntimeConfigPath(root),
		keyPath: join(root, "secrets", "tunnel-runtime.key"),
		binaryPath: join(binDir, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client"),
		manifestPath: join(binDir, "tunnel-client-manifest.json"),
		tunnelProfileDir: join(root, "tunnel", "profiles")
	};
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value, field) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`managed runtime ${field} must be a non-empty string`);
	return value;
}
function absoluteField(value, field) {
	const text = stringField(value, field);
	if (!isAbsolute(text)) throw new Error(`managed runtime ${field} must be an absolute path`);
	if (text.includes("\0")) throw new Error(`managed runtime ${field} contains a NUL byte`);
	return text;
}
function connectorName(value) {
	const name = stringField(value, "connector name");
	if (name.trim() !== name || name.length > CONNECTOR_NAME_MAX || /[\r\n\u0000]/.test(name)) throw new Error("managed runtime connector name is invalid");
	return name;
}
function safeName(value, field) {
	const name = stringField(value, field);
	if (!SAFE_NAME.test(name)) throw new Error(`managed runtime ${field} is invalid`);
	return name;
}
function parseManagedNativeRuntimeConfig(value) {
	if (!isRecord$2(value)) throw new Error("managed runtime config must be an object");
	if (value.version !== 1) throw new Error("managed runtime config version must be 1");
	if (!isRecord$2(value.tunnelClient)) throw new Error("managed runtime tunnelClient must be an object");
	if (!isRecord$2(value.tunnel)) throw new Error("managed runtime tunnel must be an object");
	if (stringField(value.tunnelClient.version, "tunnel client version") !== "0.0.12") throw new Error(`managed runtime tunnel client version must be ${MANAGED_TUNNEL_CLIENT_VERSION}`);
	const tunnelClientHash = stringField(value.tunnelClient.sha256, "tunnel client SHA-256");
	if (!SHA256.test(tunnelClientHash)) throw new Error("managed runtime tunnel client SHA-256 is invalid");
	const tunnelId = stringField(value.tunnel.id, "Tunnel ID");
	if (!TUNNEL_ID.test(tunnelId)) throw new Error("managed runtime Tunnel ID is invalid");
	return {
		version: 1,
		connectorName: connectorName(value.connectorName),
		tunnelClient: {
			path: absoluteField(value.tunnelClient.path, "tunnel client path"),
			version: MANAGED_TUNNEL_CLIENT_VERSION,
			sha256: tunnelClientHash
		},
		tunnel: {
			id: tunnelId,
			runtimeKeyFile: absoluteField(value.tunnel.runtimeKeyFile, "runtime key path"),
			profileDir: absoluteField(value.tunnel.profileDir, "tunnel profile directory"),
			profileName: safeName(value.tunnel.profileName, "tunnel profile name"),
			alias: safeName(value.tunnel.alias, "tunnel alias")
		}
	};
}
function loadManagedNativeRuntimeConfig(path, expected) {
	assertPrivateRegularFile(path, "managed runtime config");
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`managed runtime config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const config = parseManagedNativeRuntimeConfig(parsed);
	if (config.connectorName !== expected.connectorName) throw new Error(`managed runtime connector name ${JSON.stringify(config.connectorName)} does not match configured connector ${JSON.stringify(expected.connectorName)}`);
	assertPrivateRegularFile(config.tunnelClient.path, "managed tunnel client", true);
	if (createHash("sha256").update(readFileSync(config.tunnelClient.path)).digest("hex") !== config.tunnelClient.sha256) throw new Error("managed tunnel client binary hash does not match runtime config");
	assertPrivateRegularFile(config.tunnel.runtimeKeyFile, "managed runtime key");
	assertPrivateDirectory(config.tunnel.profileDir, "managed tunnel profile directory");
	return config;
}
/** Prepare the directory layout used by setup; existing unsafe directories fail closed. */
function ensureManagedRuntimeDirectories(profileDir) {
	const paths = defaultManagedRuntimePaths(profileDir);
	ensurePrivateDirectory(resolve(profileDir));
	ensurePrivateDirectory(join(resolve(profileDir), "bin"));
	ensurePrivateDirectory(join(resolve(profileDir), "secrets"));
	ensurePrivateDirectory(paths.tunnelProfileDir);
	return paths;
}
//#endregion
//#region src/native/process.ts
const MAX_COMMAND_OUTPUT_BYTES = 2097152;
function runCommand(command, args, options = {}) {
	const timeoutMs = options.timeoutMs ?? 12e4;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error("command timeout must be a positive safe integer no greater than 2147483647");
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		stdio: "pipe",
		timeout: timeoutMs,
		maxBuffer: MAX_COMMAND_OUTPUT_BYTES
	});
	if (result.error !== void 0) throw result.error;
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? ""
	};
}
//#endregion
//#region src/native/tunnel-runtime.ts
const DEFAULT_READY_TIMEOUT_MS = 12e4;
const DEFAULT_POLL_INTERVAL_MS = 1e3;
const MAX_DETAIL_CHARS = 2e3;
var ManagedRuntimeConfigurationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ManagedRuntimeConfigurationError";
	}
};
var ManagedRuntimeTransportError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ManagedRuntimeTransportError";
	}
};
function textValue(value) {
	if (typeof value === "string") return value;
	try {
		const serialized = JSON.stringify(value);
		return serialized === void 0 ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
function redactTunnelDetail(value) {
	return textValue(value).replace(/tunnel_[a-f0-9]{32}/gi, "[tunnel-id]").replace(/request_[A-Za-z0-9_-]{12,}/g, "[redacted-request]").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]").replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/gi, "Bearer [redacted-token]").slice(0, MAX_DETAIL_CHARS);
}
function rejectNewline(value, label) {
	if (/[\r\n\u0000]/.test(value)) throw new ManagedRuntimeConfigurationError(`${label} contains a newline or NUL byte`);
}
function shellQuote(value, label) {
	rejectNewline(value, label);
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function tunnelCommandQuote(value, label) {
	rejectNewline(value, label);
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
function mcpCommand(options) {
	const platform = options.platform ?? process.platform;
	const values = [
		options.nodeExecutable,
		options.mcpEntrypoint,
		"--broker-socket",
		options.brokerSocketPath
	];
	return platform === "win32" ? values.map((value, index) => tunnelCommandQuote(value, `MCP command argument ${index}`)).join(" ") : values.map((value, index) => shellQuote(value, `MCP command argument ${index}`)).join(" ");
}
function commandOutput(stdout, stderr) {
	return [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
}
function nestedRecord(value, key) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const nested = value[key];
	return typeof nested === "object" && nested !== null && !Array.isArray(nested) ? nested : void 0;
}
function parseTunnelStatus(output, exitStatus = 0) {
	if (exitStatus !== 0) return {
		ok: false,
		processRunning: false,
		healthy: false,
		ready: false,
		detail: redactTunnelDetail(commandOutput(output, "")) || `tunnel-client exited with status ${exitStatus}`
	};
	let parsed;
	try {
		const value = JSON.parse(output);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("status is not an object");
		parsed = value;
	} catch {
		return {
			ok: false,
			processRunning: false,
			healthy: false,
			ready: false,
			detail: `tunnel-client returned non-JSON status: ${redactTunnelDetail(output)}`
		};
	}
	const processRunning = parsed.process_running === true;
	const healthy = parsed.healthy === true;
	const ready = parsed.ready === true;
	const state = typeof parsed.runtime_state === "string" ? parsed.runtime_state : typeof parsed.status === "string" ? parsed.status : void 0;
	const local = nestedRecord(parsed, "local");
	const issues = Array.isArray(local?.issues) ? local.issues.filter((issue) => typeof issue === "string").slice(0, 3) : [];
	const explicitError = typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : void 0;
	const log = nestedRecord(local, "log");
	const logTail = typeof log?.tail === "string" && log.tail.trim().length > 0 ? log.tail.trim() : void 0;
	const ok = processRunning && healthy && ready;
	const detail = ok ? "process_running=true healthy=true ready=true" : redactTunnelDetail([
		`process_running=${processRunning}`,
		`healthy=${healthy}`,
		`ready=${ready}`,
		...state === void 0 ? [] : [`state=${state}`],
		...explicitError === void 0 ? [] : [explicitError],
		...issues,
		...logTail === void 0 ? [] : [`runtime_log=${logTail}`]
	].join("; "));
	return {
		ok,
		processRunning,
		healthy,
		ready,
		...state === void 0 ? {} : { state },
		detail
	};
}
function parseConnectResponse(output) {
	try {
		const parsed = JSON.parse(output);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("connect output is not an object");
		const record = parsed;
		return {
			running: record.running === true,
			healthy: record.healthy === true,
			ready: record.ready === true
		};
	} catch {
		throw new ManagedRuntimeTransportError(`tunnel-client returned non-JSON connect output: ${redactTunnelDetail(output)}`);
	}
}
function validateDuration(value, label) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new ManagedRuntimeConfigurationError(`${label} must be a positive safe integer no greater than 2147483647`);
	return value;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
var ManagedTunnelRuntime = class {
	startPromise;
	stopPromise;
	started = false;
	stopIssued = false;
	run;
	readyTimeoutMs;
	pollIntervalMs;
	command;
	constructor(options) {
		this.run = options.run ?? runCommand;
		this.readyTimeoutMs = validateDuration(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, "tunnel readiness timeout");
		this.pollIntervalMs = validateDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "tunnel status poll interval");
		this.command = mcpCommand({
			nodeExecutable: options.nodeExecutable,
			mcpEntrypoint: options.mcpEntrypoint,
			brokerSocketPath: options.brokerSocketPath
		});
		this.config = options.config;
	}
	config;
	start() {
		if (this.started) return Promise.resolve();
		if (this.startPromise !== void 0) return this.startPromise;
		this.stopIssued = false;
		const promise = this.startInternal();
		this.startPromise = promise;
		promise.then(() => {
			if (this.startPromise === promise) this.startPromise = void 0;
		}, () => {
			if (this.startPromise === promise) this.startPromise = void 0;
		});
		return promise;
	}
	status() {
		try {
			const result = this.run(this.config.tunnelClient.path, [
				"runtimes",
				"status",
				this.config.tunnel.alias,
				"--json"
			], { timeoutMs: 1e4 });
			return parseTunnelStatus(commandOutput(result.stdout, result.stderr), result.status);
		} catch (error) {
			return {
				ok: false,
				processRunning: false,
				healthy: false,
				ready: false,
				detail: redactTunnelDetail(error instanceof Error ? error.message : error)
			};
		}
	}
	stop() {
		if (this.stopPromise !== void 0) return this.stopPromise;
		if (this.stopIssued && !this.started) return Promise.resolve();
		const pendingStart = this.startPromise;
		const promise = (async () => {
			if (pendingStart !== void 0) await pendingStart.catch(() => {});
			await this.stopInternal();
		})();
		this.stopPromise = promise;
		promise.then(() => {
			if (this.stopPromise === promise) this.stopPromise = void 0;
		}, () => {
			if (this.stopPromise === promise) this.stopPromise = void 0;
		});
		return promise;
	}
	async startInternal() {
		try {
			const version = this.run(this.config.tunnelClient.path, ["--version"], { timeoutMs: 1e4 });
			const versionOutput = commandOutput(version.stdout, version.stderr);
			if (version.status !== 0 || !/\b0\.0\.12\b/.test(versionOutput)) throw new ManagedRuntimeConfigurationError(`managed tunnel client must report version ${MANAGED_TUNNEL_CLIENT_VERSION}: ${redactTunnelDetail(versionOutput)}`);
			const connect = this.run(this.config.tunnelClient.path, [
				"runtimes",
				"connect",
				"--alias",
				this.config.tunnel.alias,
				"--profile",
				this.config.tunnel.profileName,
				"--profile-dir",
				this.config.tunnel.profileDir,
				"--tunnel-client-bin",
				this.config.tunnelClient.path,
				"--tunnel-id",
				this.config.tunnel.id,
				"--runtime-api-key",
				`file:${this.config.tunnel.runtimeKeyFile}`,
				"--mcp-command",
				this.command,
				"--json"
			], { timeoutMs: this.readyTimeoutMs });
			if (connect.status !== 0) throw new ManagedRuntimeTransportError(`managed tunnel connect failed: ${redactTunnelDetail(commandOutput(connect.stdout, connect.stderr))}`);
			const launch = parseConnectResponse(commandOutput(connect.stdout, connect.stderr));
			if (!launch.running || !launch.healthy) throw new ManagedRuntimeTransportError(`managed tunnel exited during launch: ${redactTunnelDetail(commandOutput(connect.stdout, connect.stderr))}`);
			const deadline = Date.now() + this.readyTimeoutMs;
			let current = this.status();
			while (!current.ok && Date.now() < deadline) {
				await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
				current = this.status();
			}
			if (!current.ok) throw new ManagedRuntimeTransportError(`managed tunnel did not become ready: ${current.detail}`);
			this.started = true;
			this.stopIssued = false;
		} catch (error) {
			this.started = false;
			try {
				await this.stopInternal();
			} catch {}
			if (error instanceof ManagedRuntimeTransportError || error instanceof ManagedRuntimeConfigurationError) throw error;
			throw new ManagedRuntimeTransportError(`managed tunnel startup failed: ${redactTunnelDetail(error instanceof Error ? error.message : error)}`);
		}
	}
	async stopInternal() {
		if (this.stopIssued && !this.started) return;
		this.stopIssued = true;
		try {
			const result = this.run(this.config.tunnelClient.path, [
				"runtimes",
				"stop",
				this.config.tunnel.alias,
				"--json"
			], { timeoutMs: 15e3 });
			const output = commandOutput(result.stdout, result.stderr);
			if (result.status !== 0 && !/not found|not running|unknown alias|alias[^\n]{0,160}is not known/i.test(output)) throw new ManagedRuntimeTransportError(`managed tunnel stop failed: ${redactTunnelDetail(output)}`);
			this.started = false;
		} catch (error) {
			this.stopIssued = false;
			if (error instanceof ManagedRuntimeTransportError) throw error;
			throw new ManagedRuntimeTransportError(`managed tunnel stop failed: ${redactTunnelDetail(error instanceof Error ? error.message : error)}`);
		}
	}
};
//#endregion
//#region src/native/grants.ts
const APPROVAL_VERSION = 1;
const APPROVAL_TTL_MS = 6e5;
const APPROVAL_DIRECTORY = "native-approval";
const PENDING_FILE = "pending.json";
const GRANT_FILE = "grant.json";
const CHALLENGE_ID = /^challenge_[0-9a-f-]{36}$/;
const HASH$1 = /^[a-f0-9]{64}$/;
const CONTROL_BYTES$1 = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_APPROVAL_FILE_BYTES = 1048576;
const MAX_CLAIM_FILES = 8;
const CLAIM_FILE = /^\.pending-claim-([0-9]+)-([0-9a-f-]{36})$/;
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys$1(value, required, optional = []) {
	const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error("native approval record has an invalid key set");
}
function text$1(value, field, max = 1e3) {
	if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL_BYTES$1.test(value)) throw new Error(`native approval ${field} is invalid`);
	return value;
}
function hash$1(value, field) {
	const candidate = text$1(value, field, 64);
	if (!HASH$1.test(candidate)) throw new Error(`native approval ${field} is invalid`);
	return candidate;
}
function instant$1(value, field) {
	const candidate = text$1(value, field, 32);
	const milliseconds = Date.parse(candidate);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== candidate) throw new Error(`native approval ${field} is invalid`);
	return candidate;
}
function summary$1(value) {
	if (!isRecord$1(value)) throw new Error("native approval summary is invalid");
	exactKeys$1(value, [
		"toolPolicy",
		"workspaceRoot",
		"workspaceRootSource",
		"connectorName",
		"connectorRuntime",
		"approval",
		"tools",
		"evidenceLimits"
	], ["policyImplementationVersion"]);
	if (value.toolPolicy !== "full" && value.toolPolicy !== "evidence-only" && value.toolPolicy !== "allowlist") throw new Error("native approval summary tool policy is invalid");
	if (value.workspaceRootSource !== "explicit" && value.workspaceRootSource !== "process.cwd") throw new Error("native approval summary workspace root source is invalid");
	if (value.connectorRuntime !== "external" && value.connectorRuntime !== "managed") throw new Error("native approval summary connector runtime is invalid");
	if (value.approval !== "none" && value.approval !== "workspace-policy") throw new Error("native approval summary approval mode is invalid");
	const policyImplementationVersion = value.policyImplementationVersion === void 0 ? void 0 : text$1(value.policyImplementationVersion, "policy implementation version", 128);
	const workspaceRoot = text$1(value.workspaceRoot, "workspace root", 4096);
	const connectorName = text$1(value.connectorName, "connector name", 256);
	if (!Array.isArray(value.tools)) throw new Error("native approval summary tools are invalid");
	const tools = value.tools.map((toolValue) => {
		if (!isRecord$1(toolValue)) throw new Error("native approval summary tool is invalid");
		exactKeys$1(toolValue, [
			"tool",
			"capability",
			"pathArguments",
			"result",
			"outputProvenance"
		], ["schemaHash"]);
		const tool = text$1(toolValue.tool, "tool name", 256);
		const capabilities = /* @__PURE__ */ new Set([
			"workspace.read",
			"workspace.search",
			"git.read",
			"execution.read",
			"side-effect",
			"full-unrestricted"
		]);
		if (typeof toolValue.capability !== "string" || !capabilities.has(toolValue.capability)) throw new Error("native approval summary capability is invalid");
		if (!Array.isArray(toolValue.pathArguments) || toolValue.pathArguments.some((path) => typeof path !== "string")) throw new Error("native approval summary path arguments are invalid");
		if (toolValue.result !== "text" && toolValue.result !== "sanitized-evidence" && toolValue.result !== "raw-unbounded") throw new Error("native approval summary result policy is invalid");
		if (toolValue.outputProvenance !== "operator-declared" && toolValue.outputProvenance !== "unverified-full") throw new Error("native approval summary provenance is invalid");
		const schemaHash = toolValue.schemaHash === void 0 ? void 0 : hash$1(toolValue.schemaHash, "schema hash");
		return {
			tool,
			capability: toolValue.capability,
			pathArguments: Object.freeze([...toolValue.pathArguments]),
			result: toolValue.result,
			outputProvenance: toolValue.outputProvenance,
			...schemaHash === void 0 ? {} : { schemaHash }
		};
	});
	if (!isRecord$1(value.evidenceLimits)) throw new Error("native approval summary evidence limits are invalid");
	exactKeys$1(value.evidenceLimits, ["maxBytes", "maxLines"]);
	const maxBytes = value.evidenceLimits.maxBytes;
	const maxLines = value.evidenceLimits.maxLines;
	if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof maxLines !== "number" || !Number.isSafeInteger(maxLines) || maxLines < 1) throw new Error("native approval summary evidence limits are invalid");
	return Object.freeze({
		...policyImplementationVersion === void 0 ? {} : { policyImplementationVersion },
		toolPolicy: value.toolPolicy,
		workspaceRoot,
		workspaceRootSource: value.workspaceRootSource,
		connectorName,
		connectorRuntime: value.connectorRuntime,
		approval: value.approval,
		tools: Object.freeze(tools),
		evidenceLimits: Object.freeze({
			maxBytes,
			maxLines
		})
	});
}
function parsePending(value) {
	if (!isRecord$1(value)) throw new Error("native approval pending record is invalid");
	exactKeys$1(value, [
		"version",
		"challengeId",
		"approvalHash",
		"createdAt",
		"expiresAt",
		"summary"
	]);
	if (value.version !== APPROVAL_VERSION) throw new Error("native approval pending version is invalid");
	const challengeId = text$1(value.challengeId, "challenge id", 128);
	if (!CHALLENGE_ID.test(challengeId)) throw new Error("native approval challenge id is invalid");
	const createdAt = instant$1(value.createdAt, "createdAt");
	const expiresAt = instant$1(value.expiresAt, "expiresAt");
	if (Date.parse(expiresAt) - Date.parse(createdAt) !== APPROVAL_TTL_MS) throw new Error("native approval challenge lifetime is invalid");
	return Object.freeze({
		version: APPROVAL_VERSION,
		challengeId,
		approvalHash: hash$1(value.approvalHash, "approval hash"),
		createdAt,
		expiresAt,
		summary: summary$1(value.summary)
	});
}
function parseGrant(value) {
	if (!isRecord$1(value)) throw new Error("native approval grant record is invalid");
	exactKeys$1(value, [
		"version",
		"approvalHash",
		"approvedAt",
		"summaryHash"
	]);
	if (value.version !== APPROVAL_VERSION) throw new Error("native approval grant version is invalid");
	return Object.freeze({
		version: APPROVAL_VERSION,
		approvalHash: hash$1(value.approvalHash, "approval hash"),
		approvedAt: instant$1(value.approvedAt, "approvedAt"),
		summaryHash: hash$1(value.summaryHash, "summary hash")
	});
}
function readJson(path, label, parse) {
	try {
		lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	try {
		assertPrivateRegularFile(path, label);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError(`native approval ${label} is not a safe private file`, error, "NATIVE_APPROVAL_STATE");
	}
	let value;
	try {
		if (lstatSync(path).size > MAX_APPROVAL_FILE_BYTES) throw new Error("native approval state file exceeds the private size limit");
		const raw = readFileSync(path, "utf8");
		if (Buffer.byteLength(raw, "utf8") > MAX_APPROVAL_FILE_BYTES) throw new Error("native approval state file exceeds the private size limit");
		value = JSON.parse(raw);
	} catch (error) {
		throw new NativeSafetyError(`native approval ${label} is not valid private JSON`, error, "NATIVE_APPROVAL_STATE");
	}
	try {
		return parse(value);
	} catch (error) {
		throw new NativeSafetyError(`native approval ${label} has an invalid schema`, error, "NATIVE_APPROVAL_STATE");
	}
}
function profile(value) {
	if (typeof value !== "string" || CONTROL_BYTES$1.test(value) || !isAbsolute(value)) throw new NativeSafetyError("native approval profile directory must be an absolute control-free path", void 0, "NATIVE_APPROVAL_STATE");
	const resolved = resolve(value);
	try {
		ensurePrivateDirectory(resolved);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval profile directory is not private", error, "NATIVE_APPROVAL_STATE");
	}
	return resolved;
}
function inspectApprovalDirectory(directory) {
	let claimCount = 0;
	for (const entry of readdirSync(directory)) {
		if (entry === PENDING_FILE || entry === GRANT_FILE) continue;
		if (!CLAIM_FILE.test(entry)) throw new NativeSafetyError("native approval directory contains an unexpected state file", void 0, "NATIVE_APPROVAL_STATE");
		claimCount += 1;
		if (claimCount > MAX_CLAIM_FILES) throw new NativeSafetyError("native approval directory contains too many abandoned claims", void 0, "NATIVE_APPROVAL_STATE");
		assertPrivateRegularFile(join(directory, entry), "native approval claim");
	}
}
function approvalDirectory(profileDir) {
	const directory = join(profileDir, APPROVAL_DIRECTORY);
	let created = false;
	try {
		lstatSync(directory);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		created = true;
	}
	try {
		ensurePrivateDirectory(directory);
		if (created) syncPrivateDirectory(profileDir);
		inspectApprovalDirectory(directory);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval directory is not private", error, "NATIVE_APPROVAL_STATE");
	}
	return directory;
}
function readOnlyProfile(value) {
	if (typeof value !== "string" || CONTROL_BYTES$1.test(value) || !isAbsolute(value)) throw new NativeSafetyError("native approval profile directory must be an absolute control-free path", void 0, "NATIVE_APPROVAL_STATE");
	const resolved = resolve(value);
	try {
		lstatSync(resolved);
	} catch (error) {
		if (error.code === "ENOENT") return resolved;
		throw new NativeSafetyError("native approval profile directory could not be inspected safely", error, "NATIVE_APPROVAL_STATE");
	}
	try {
		assertPrivateDirectory(resolved, "native approval profile directory");
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval profile directory is not private", error, "NATIVE_APPROVAL_STATE");
	}
	return resolved;
}
function readOnlyApprovalDirectory(profileDir) {
	const resolved = readOnlyProfile(profileDir);
	try {
		lstatSync(resolved);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw new NativeSafetyError("native approval profile directory could not be inspected safely", error, "NATIVE_APPROVAL_STATE");
	}
	try {
		const directory = join(resolved, APPROVAL_DIRECTORY);
		try {
			lstatSync(directory);
		} catch (error) {
			if (error.code === "ENOENT") return void 0;
			throw error;
		}
		assertPrivateDirectory(directory, "native approval directory");
		inspectApprovalDirectory(directory);
		return directory;
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval directory is not private", error, "NATIVE_APPROVAL_STATE");
	}
}
/** Read approval files without creating, claiming, replacing, or repairing them. */
function readNativeApprovalState(profileDir) {
	const directory = readOnlyApprovalDirectory(profileDir);
	if (directory === void 0) return {
		directory: "missing",
		claimCount: 0
	};
	const claimCount = readdirSync(directory).filter((entry) => CLAIM_FILE.test(entry)).length;
	const challenge = readJson(join(directory, PENDING_FILE), "pending challenge", parsePending);
	const grant = readJson(join(directory, GRANT_FILE), "grant", parseGrant);
	return {
		directory: "ok",
		...challenge === void 0 ? {} : { challenge },
		...grant === void 0 ? {} : { grant },
		claimCount
	};
}
function clock$1(now) {
	const value = now ?? /* @__PURE__ */ new Date();
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new NativeSafetyError("native approval clock value is invalid", void 0, "NATIVE_APPROVAL_STATE");
	return value;
}
function summaryHash(value) {
	return hashCanonical("native-approval-summary", APPROVAL_VERSION, value);
}
function approvalCommand(profileDir, challengeId) {
	return `dsh-chatgpt-web-native approve --profile-dir ${shellQuotePosix(profileDir)} --challenge ${shellQuotePosix(challengeId)}`;
}
function throwRequired(profileDir, challengeId) {
	throw new NativeApprovalRequiredError(`Native MCP policy approval is required. Run exactly:\n${approvalCommand(profileDir, challengeId)}`);
}
function pendingMatches(pending, prepared, expectedSummaryHash, now) {
	return pending.approvalHash === prepared.approvalHash && summaryHash(pending.summary) === expectedSummaryHash && Date.parse(pending.expiresAt) > now.getTime() && Date.parse(pending.createdAt) <= now.getTime();
}
function removeClaim(path, directory) {
	assertPrivateRegularFile(path, "native approval claim");
	unlinkSync(path);
	syncPrivateDirectory(directory);
}
function replaceUnclaimedPending(directory, observed, desired) {
	const pendingPath = join(directory, PENDING_FILE);
	const claimedPath = join(directory, `.pending-claim-${process.pid}-${randomUUID()}`);
	try {
		renameSync(pendingPath, claimedPath);
		syncPrivateDirectory(directory);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	try {
		const claimed = readJson(claimedPath, "pending claim", parsePending);
		if (claimed === void 0 || JSON.stringify(claimed) !== JSON.stringify(observed)) throw new NativeSafetyError("native approval pending state changed during replacement", void 0, "NATIVE_APPROVAL_STATE");
		writePending(pendingPath, desired);
		removeClaim(claimedPath, directory);
		return true;
	} catch (error) {
		try {
			lstatSync(claimedPath);
			removeClaim(claimedPath, directory);
		} catch {}
		throw error;
	}
}
function writePending(path, pending) {
	try {
		durableAtomicWritePrivateFile(path, `${JSON.stringify(pending)}\n`, 384);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval pending state could not be written safely", error, "NATIVE_APPROVAL_STATE");
	}
}
function createPending(prepared, now) {
	return Object.freeze({
		version: APPROVAL_VERSION,
		challengeId: `challenge_${randomUUID()}`,
		approvalHash: prepared.approvalHash,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
		summary: prepared.summary
	});
}
/** Require an exact local grant before any effective native capability opens. */
function requireNativeApproval(profileDir, approval, prepared, now) {
	if (approval !== "none" && approval !== "workspace-policy") throw new NativeSafetyError("native approval mode is invalid", void 0, "NATIVE_APPROVAL_STATE");
	if (approval === "none" || prepared.summary.tools.length === 0) return;
	try {
		const current = clock$1(now);
		const resolvedProfile = profile(profileDir);
		const directory = approvalDirectory(resolvedProfile);
		const grantPath = join(directory, GRANT_FILE);
		const pendingPath = join(directory, PENDING_FILE);
		const expectedSummaryHash = summaryHash(prepared.summary);
		const grant = readJson(grantPath, "grant", parseGrant);
		if (grant !== void 0) {
			const approvedAt = Date.parse(grant.approvedAt);
			if (!Number.isFinite(approvedAt) || approvedAt > current.getTime()) throw new NativeSafetyError("native approval grant timestamp is invalid", void 0, "NATIVE_APPROVAL_STATE");
			if (grant.approvalHash === prepared.approvalHash && grant.summaryHash === expectedSummaryHash) return;
		}
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const pending = readJson(pendingPath, "pending challenge", parsePending);
			if (pending !== void 0 && Date.parse(pending.createdAt) > current.getTime()) throw new NativeSafetyError("native approval challenge was created in the future; refusing a clock rollback", void 0, "NATIVE_APPROVAL_CLOCK");
			if (pending !== void 0 && pendingMatches(pending, prepared, expectedSummaryHash, current)) throwRequired(resolvedProfile, pending.challengeId);
			const desired = createPending(prepared, current);
			if (pending === void 0) writePending(pendingPath, desired);
			else replaceUnclaimedPending(directory, pending, desired);
			const persisted = readJson(pendingPath, "pending challenge", parsePending);
			if (persisted !== void 0 && pendingMatches(persisted, prepared, expectedSummaryHash, current)) throwRequired(resolvedProfile, persisted.challengeId);
		}
		throw new NativeSafetyError("native approval state changed concurrently; retry after inspecting the profile", void 0, "NATIVE_APPROVAL_STATE");
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval state could not be accessed safely", error, "NATIVE_APPROVAL_STATE");
	}
}
/** Approve one exact pending challenge through the interactive local CLI. */
function approveNativeChallenge(input) {
	if (input.confirmation !== "approve") throw new NativeSafetyError("native approval confirmation must be exactly approve", void 0, "NATIVE_APPROVAL_CONFIRMATION");
	const current = clock$1(input.now);
	const directory = approvalDirectory(profile(input.profileDir));
	const pendingPath = join(directory, PENDING_FILE);
	const claimedPath = join(directory, `.pending-claim-${process.pid}-${randomUUID()}`);
	try {
		renameSync(pendingPath, claimedPath);
		syncPrivateDirectory(directory);
	} catch (error) {
		if (error.code === "ENOENT") throw new NativeSafetyError("native approval challenge is missing or already claimed", error, "NATIVE_APPROVAL_STATE");
		throw new NativeSafetyError("native approval challenge could not be claimed safely", error, "NATIVE_APPROVAL_STATE");
	}
	let grantWritten = false;
	try {
		const pending = readJson(claimedPath, "pending claim", parsePending);
		if (pending === void 0 || pending.challengeId !== input.challengeId) throw new NativeSafetyError("native approval challenge does not match the pending record", void 0, "NATIVE_APPROVAL_STATE");
		const createdAt = Date.parse(pending.createdAt);
		const expiresAt = Date.parse(pending.expiresAt);
		if (createdAt > current.getTime() || expiresAt <= current.getTime()) throw new NativeSafetyError("native approval challenge is expired or from the future", void 0, "NATIVE_APPROVAL_EXPIRED");
		const grant = Object.freeze({
			version: APPROVAL_VERSION,
			approvalHash: pending.approvalHash,
			approvedAt: current.toISOString(),
			summaryHash: summaryHash(pending.summary)
		});
		durableAtomicWritePrivateFile(join(directory, GRANT_FILE), `${JSON.stringify(grant)}\n`, 384);
		grantWritten = true;
		removeClaim(claimedPath, directory);
		return grant;
	} catch (error) {
		if (!grantWritten) try {
			lstatSync(claimedPath);
			removeClaim(claimedPath, directory);
		} catch {}
		if (error instanceof NativeSafetyError) throw error;
		throw new NativeSafetyError("native approval could not be completed safely", error, "NATIVE_APPROVAL_STATE");
	}
}
/** Quote one value for a POSIX shell without allowing expansion or control bytes. */
function shellQuotePosix(value) {
	if (typeof value !== "string" || CONTROL_BYTES$1.test(value)) throw new NativeSafetyError("native approval command value contains a control byte", void 0, "NATIVE_APPROVAL_STATE");
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function displayValue(value) {
	const serialized = JSON.stringify(value);
	if (serialized === void 0) return "null";
	return serialized.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}
/** Render a terminal-safe, human-readable challenge summary. */
function formatNativeApprovalChallenge(challenge) {
	return [
		`Native MCP approval challenge ${displayValue(challenge.challengeId)}`,
		`Created: ${displayValue(challenge.createdAt)}`,
		`Expires: ${displayValue(challenge.expiresAt)}`,
		`Effective approval hash: ${displayValue(challenge.approvalHash)}`,
		`Policy implementation: ${displayValue(challenge.summary.policyImplementationVersion ?? "unknown")}`,
		`Policy summary: ${displayValue(challenge.summary)}`,
		"Type approve exactly to authorize this effective native tool inventory."
	].join("\n") + "\n";
}
function readNativeApprovalChallenge(profileDir) {
	const directory = approvalDirectory(profile(profileDir));
	return readJson(join(directory, PENDING_FILE), "pending challenge", parsePending);
}
const NATIVE_SECURITY_STATE_FILE = "native-security-state.json";
const NATIVE_SECURITY_STATE_MAX_AGE_MS = 864e5;
const MAX_STATE_BYTES = 1048576;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_SUMMARY_TOOLS = 4096;
const MAX_SUMMARY_PATH_ARGUMENTS = 256;
function safety$1(message, cause) {
	return new NativeSafetyError(message, cause, "NATIVE_SECURITY_STATE");
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
	const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw safety$1("native security state contains an invalid key set");
}
function text(value, field, maximum = 4096, allowEmpty = false) {
	if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.length > maximum || CONTROL_BYTES.test(value)) throw safety$1(`native security state ${field} is invalid`);
	return value;
}
function hash(value, field) {
	const candidate = text(value, field, 64);
	if (!HASH.test(candidate)) throw safety$1(`native security state ${field} is invalid`);
	return candidate;
}
function instant(value, field) {
	const candidate = text(value, field, 32);
	const milliseconds = Date.parse(candidate);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== candidate) throw safety$1(`native security state ${field} is invalid`);
	return candidate;
}
function profilePath(value) {
	if (typeof value !== "string" || !isAbsolute(value) || CONTROL_BYTES.test(value)) throw safety$1("native security state profile directory must be an absolute control-free path");
	return resolve(value);
}
function parseSummary(value) {
	if (!isRecord(value)) throw safety$1("native security state summary is invalid");
	exactKeys(value, [
		"toolPolicy",
		"workspaceRoot",
		"workspaceRootSource",
		"connectorName",
		"connectorRuntime",
		"approval",
		"tools",
		"evidenceLimits"
	], ["policyImplementationVersion"]);
	if (value.toolPolicy !== "full" && value.toolPolicy !== "evidence-only" && value.toolPolicy !== "allowlist") throw safety$1("native security state summary tool policy is invalid");
	if (value.workspaceRootSource !== "explicit" && value.workspaceRootSource !== "process.cwd") throw safety$1("native security state summary workspace root source is invalid");
	if (value.connectorRuntime !== "external" && value.connectorRuntime !== "managed") throw safety$1("native security state summary connector runtime is invalid");
	if (value.approval !== "none" && value.approval !== "workspace-policy") throw safety$1("native security state summary approval mode is invalid");
	const policyImplementationVersion = value.policyImplementationVersion === void 0 ? void 0 : text(value.policyImplementationVersion, "policy implementation version", 128);
	const workspaceRoot = text(value.workspaceRoot, "workspace root");
	if (!isAbsolute(workspaceRoot)) throw safety$1("native security state workspace root is not absolute");
	const connectorName = text(value.connectorName, "connector name", 256);
	if (!Array.isArray(value.tools) || value.tools.length > MAX_SUMMARY_TOOLS) throw safety$1("native security state summary tools are invalid");
	const seenTools = /* @__PURE__ */ new Set();
	const tools = value.tools.map((toolValue) => {
		if (!isRecord(toolValue)) throw safety$1("native security state summary tool is invalid");
		exactKeys(toolValue, [
			"tool",
			"capability",
			"pathArguments",
			"result",
			"outputProvenance"
		], ["schemaHash"]);
		const tool = text(toolValue.tool, "tool name", 256);
		if (seenTools.has(tool)) throw safety$1("native security state summary contains duplicate tools");
		seenTools.add(tool);
		const capabilities = /* @__PURE__ */ new Set([
			"workspace.read",
			"workspace.search",
			"git.read",
			"execution.read",
			"side-effect",
			"full-unrestricted"
		]);
		if (typeof toolValue.capability !== "string" || !capabilities.has(toolValue.capability)) throw safety$1("native security state summary capability is invalid");
		if (!Array.isArray(toolValue.pathArguments) || toolValue.pathArguments.length > MAX_SUMMARY_PATH_ARGUMENTS || toolValue.pathArguments.some((path) => typeof path !== "string" || CONTROL_BYTES.test(path))) throw safety$1("native security state summary path arguments are invalid");
		if (toolValue.result !== "text" && toolValue.result !== "sanitized-evidence" && toolValue.result !== "raw-unbounded") throw safety$1("native security state summary result policy is invalid");
		if (toolValue.outputProvenance !== "operator-declared" && toolValue.outputProvenance !== "unverified-full") throw safety$1("native security state summary output provenance is invalid");
		const schemaHash = toolValue.schemaHash === void 0 ? void 0 : hash(toolValue.schemaHash, "schema hash");
		return {
			tool,
			capability: toolValue.capability,
			pathArguments: Object.freeze([...toolValue.pathArguments]),
			result: toolValue.result,
			outputProvenance: toolValue.outputProvenance,
			...schemaHash === void 0 ? {} : { schemaHash }
		};
	});
	if (!isRecord(value.evidenceLimits)) throw safety$1("native security state evidence limits are invalid");
	exactKeys(value.evidenceLimits, ["maxBytes", "maxLines"]);
	const maxBytes = value.evidenceLimits.maxBytes;
	const maxLines = value.evidenceLimits.maxLines;
	if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || typeof maxLines !== "number" || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 1e4) throw safety$1("native security state evidence limits are invalid");
	return Object.freeze({
		...policyImplementationVersion === void 0 ? {} : { policyImplementationVersion },
		toolPolicy: value.toolPolicy,
		workspaceRoot,
		workspaceRootSource: value.workspaceRootSource,
		connectorName,
		connectorRuntime: value.connectorRuntime,
		approval: value.approval,
		tools: Object.freeze(tools),
		evidenceLimits: Object.freeze({
			maxBytes,
			maxLines
		})
	});
}
function parseState(value) {
	if (!isRecord(value)) throw safety$1("native security state is invalid");
	exactKeys(value, [
		"version",
		"generatedAt",
		"runtimeProcess",
		"policyHash",
		"inventoryHash",
		"approvalHash",
		"workspaceRootSource",
		"summary"
	]);
	if (value.version !== 1) throw safety$1("native security state version is invalid");
	const generatedAt = instant(value.generatedAt, "generatedAt");
	if (!isRecord(value.runtimeProcess)) throw safety$1("native security state runtime process is invalid");
	exactKeys(value.runtimeProcess, ["pid", "startedAt"]);
	const pid = value.runtimeProcess.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw safety$1("native security state runtime PID is invalid");
	const startedAt = instant(value.runtimeProcess.startedAt, "runtime process start");
	const workspaceRootSource = value.workspaceRootSource;
	if (workspaceRootSource !== "explicit" && workspaceRootSource !== "process.cwd") throw safety$1("native security state workspace root source is invalid");
	const summary = parseSummary(value.summary);
	if (summary.workspaceRootSource !== workspaceRootSource) throw safety$1("native security state workspace root source does not match its summary");
	return Object.freeze({
		version: 1,
		generatedAt,
		runtimeProcess: Object.freeze({
			pid,
			startedAt
		}),
		policyHash: hash(value.policyHash, "policy hash"),
		inventoryHash: hash(value.inventoryHash, "inventory hash"),
		approvalHash: hash(value.approvalHash, "approval hash"),
		workspaceRootSource,
		summary
	});
}
function clock(now) {
	const value = now ?? /* @__PURE__ */ new Date();
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw safety$1("native security state clock value is invalid");
	return value;
}
function redactedSummary(summary) {
	return parseSummary({
		...summary.policyImplementationVersion === void 0 ? {} : { policyImplementationVersion: summary.policyImplementationVersion },
		toolPolicy: summary.toolPolicy,
		workspaceRoot: summary.workspaceRoot,
		workspaceRootSource: summary.workspaceRootSource,
		connectorName: summary.connectorName,
		connectorRuntime: summary.connectorRuntime,
		approval: summary.approval,
		tools: summary.tools.map((tool) => ({
			tool: tool.tool,
			capability: tool.capability,
			pathArguments: [...tool.pathArguments],
			result: tool.result,
			outputProvenance: tool.outputProvenance,
			...tool.schemaHash === void 0 ? {} : { schemaHash: tool.schemaHash }
		})),
		evidenceLimits: { ...summary.evidenceLimits }
	});
}
function nativeSecurityStatePath(profileDir) {
	return join(profilePath(profileDir), NATIVE_SECURITY_STATE_FILE);
}
/** Persist only the prepared request's redacted policy facts; never use this for authorization. */
function writeNativeSecurityState(profileDir, prepared, runtimeProcess, now) {
	const current = clock(now);
	const pid = runtimeProcess.pid;
	if (!Number.isSafeInteger(pid) || pid <= 0) throw safety$1("native security state runtime PID is invalid");
	const summary = redactedSummary(prepared.summary);
	const state = parseState({
		version: 1,
		generatedAt: current.toISOString(),
		runtimeProcess: {
			pid,
			startedAt: runtimeProcess.startedAt
		},
		policyHash: prepared.policyHash,
		inventoryHash: prepared.inventoryHash,
		approvalHash: prepared.approvalHash,
		workspaceRootSource: summary.workspaceRootSource,
		summary
	});
	try {
		durableAtomicWritePrivateFile(nativeSecurityStatePath(profileDir), `${JSON.stringify(state)}\n`, 384);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw safety$1("native security state could not be written safely", error);
	}
}
/** Read the advisory snapshot without creating or repairing any profile state. */
function readNativeSecurityState(profileDir) {
	const resolvedProfile = profilePath(profileDir);
	try {
		lstatSync(resolvedProfile);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw safety$1("native security state profile directory could not be inspected safely", error);
	}
	try {
		assertPrivateDirectory(resolvedProfile, "native security state profile directory");
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw safety$1("native security state profile directory is not private", error);
	}
	const path = join(resolvedProfile, NATIVE_SECURITY_STATE_FILE);
	try {
		lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw safety$1("native security state file could not be inspected safely", error);
	}
	try {
		assertPrivateRegularFile(path, "native security state");
		if (lstatSync(path).size > MAX_STATE_BYTES) throw new Error("native security state exceeds its private size limit");
		const raw = readFileSync(path, "utf8");
		if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw new Error("native security state exceeds its private size limit");
		return parseState(JSON.parse(raw));
	} catch (error) {
		if (error instanceof NativeSafetyError && error.nativeCode === "NATIVE_SECURITY_STATE") throw error;
		throw safety$1("native security state is not valid private JSON", error);
	}
}
function nativeSecuritySummaryHash(summary) {
	return hashCanonical("native-approval-summary", 1, redactedSummary(summary));
}
//#endregion
//#region src/native/checkpoint.ts
const CHECKPOINT_VERSION = 1;
const JOURNAL_DIRECTORY = "native-journal";
const JOURNAL_SUFFIX = ".jsonl";
const CHECKPOINT_HASH = /^[a-f0-9]{64}$/;
const VALUE_HASH = /^[a-f0-9]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_RECORD_BYTES = 16384;
const MAX_JOURNAL_BYTES = 4194304;
const MAX_RECORDS = 4096;
const MAX_TERMINAL_JOURNALS = 64;
const MAX_NON_TERMINAL_JOURNALS = 128;
const JOURNAL_PHASES = /* @__PURE__ */ new Set([
	"generation-prepared",
	"submission-attempted",
	"generation-submitted",
	"batch-journaled",
	"results-confirmed",
	"handoff-prepared",
	"handoff-confirmed",
	"completion-journaled",
	"cleanup-prepared",
	"cleanup-confirmed",
	"replay-consumed",
	"non-replayable",
	"terminal"
]);
function safety(message, cause) {
	return new NativeSafetyError(message, cause, "NATIVE_CHECKPOINT_UNAVAILABLE");
}
function errorCode(error) {
	return error?.code;
}
function assertHash(value, label) {
	if (typeof value !== "string" || !VALUE_HASH.test(value)) throw safety(`native checkpoint ${label} is invalid`);
	return value;
}
function assertBoundedText(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw safety(`native checkpoint ${label} is invalid`);
	return value;
}
function timestamp(value, label) {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw safety(`native checkpoint ${label} is invalid`);
	return value.toISOString();
}
function assertTimestamp(value, label) {
	const text = assertBoundedText(value, label);
	try {
		if (new Date(text).toISOString() !== text) throw safety(`native checkpoint ${label} is invalid`);
	} catch (error) {
		if (error instanceof NativeSafetyError) throw error;
		throw safety(`native checkpoint ${label} is invalid`, error);
	}
	return text;
}
function journalPath(directory, checkpointHash) {
	return join(directory, `${checkpointHash}${JOURNAL_SUFFIX}`);
}
function callId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw safety("native checkpoint call ID is invalid");
	return value;
}
function toolName(value) {
	return assertBoundedText(value, "tool name");
}
function parseCall(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw safety("native checkpoint call binding is invalid");
	const source = value;
	const keys = [
		"ordinal",
		"callId",
		"toolName",
		"schemaHash",
		"argumentsHash",
		"rawResultHash",
		"projectionHash",
		"isError"
	];
	if (Object.keys(source).some((key) => !keys.includes(key))) throw safety("native checkpoint call binding has an invalid key set");
	const ordinal = source.ordinal;
	if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw safety("native checkpoint call ordinal is invalid");
	const result = {
		ordinal,
		callId: callId(source.callId),
		toolName: toolName(source.toolName),
		schemaHash: assertHash(source.schemaHash, "schema hash"),
		argumentsHash: assertHash(source.argumentsHash, "arguments hash"),
		...source.rawResultHash === void 0 ? {} : { rawResultHash: assertHash(source.rawResultHash, "raw result hash") },
		...source.projectionHash === void 0 ? {} : { projectionHash: assertHash(source.projectionHash, "projection hash") },
		...source.isError === void 0 ? {} : { isError: source.isError === true }
	};
	if (source.isError !== void 0 && typeof source.isError !== "boolean") throw safety("native checkpoint error flag is invalid");
	return result;
}
function parseRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw safety("native checkpoint record is invalid");
	const source = value;
	const keys = [
		"version",
		"sequence",
		"checkpointHash",
		"generation",
		"boundary",
		"phase",
		"timestamp",
		"sessionHash",
		"workspaceHash",
		"providerHash",
		"modelHash",
		"systemHash",
		"projectedToolsHash",
		"projectedOptionsHash",
		"executionHash",
		"policyHash",
		"inventoryHash",
		"approvalHash",
		"calls",
		"ledgerCorrelationHash",
		"reasonCode",
		"verdict",
		"replayConsumed"
	];
	if (Object.keys(source).some((key) => !keys.includes(key))) throw safety("native checkpoint record has an invalid key set");
	const sequence = source.sequence;
	const generation = source.generation;
	const boundary = source.boundary;
	if (source.version !== CHECKPOINT_VERSION || !Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(generation) || generation <= 0 || !Number.isSafeInteger(boundary) || boundary < 0 || typeof source.phase !== "string" || !JOURNAL_PHASES.has(source.phase)) throw safety("native checkpoint record has invalid sequencing fields");
	const requiredHashes = [
		["checkpoint hash", source.checkpointHash],
		["session hash", source.sessionHash],
		["workspace hash", source.workspaceHash],
		["provider hash", source.providerHash],
		["model hash", source.modelHash],
		["system hash", source.systemHash],
		["projected tools hash", source.projectedToolsHash],
		["projected options hash", source.projectedOptionsHash],
		["execution hash", source.executionHash],
		["policy hash", source.policyHash],
		["inventory hash", source.inventoryHash],
		["approval hash", source.approvalHash]
	];
	for (const [label, value] of requiredHashes) assertHash(value, label);
	const derivedExecutionHash = hashCanonical("native-checkpoint-execution", 1, {
		sessionHash: source.sessionHash,
		workspaceHash: source.workspaceHash,
		providerHash: source.providerHash,
		modelHash: source.modelHash,
		systemHash: source.systemHash,
		projectedToolsHash: source.projectedToolsHash,
		projectedOptionsHash: source.projectedOptionsHash,
		policyHash: source.policyHash,
		inventoryHash: source.inventoryHash,
		approvalHash: source.approvalHash
	});
	if (source.executionHash !== derivedExecutionHash) throw safety("native checkpoint execution identity is inconsistent");
	const calls = source.calls === void 0 ? void 0 : (() => {
		if (!Array.isArray(source.calls) || source.calls.length === 0) throw safety("native checkpoint calls are invalid");
		const parsed = source.calls.map(parseCall);
		if (parsed.some((item, index) => index > 0 && item.ordinal <= parsed[index - 1].ordinal)) throw safety("native checkpoint call order is invalid");
		if (new Set(parsed.map((item) => String(item.callId))).size !== parsed.length) throw safety("native checkpoint calls contain duplicate IDs");
		return parsed;
	})();
	if (source.ledgerCorrelationHash !== void 0) assertHash(source.ledgerCorrelationHash, "ledger correlation hash");
	if (source.reasonCode !== void 0) {
		const reason = assertBoundedText(source.reasonCode, "reason code");
		if (!SAFE_TOKEN.test(reason)) throw safety("native checkpoint reason code is invalid");
	}
	if (source.verdict !== void 0 && source.verdict !== "completed" && source.verdict !== "failed" && source.verdict !== "abandoned") throw safety("native checkpoint verdict is invalid");
	if (source.replayConsumed !== void 0 && source.replayConsumed !== true) throw safety("native checkpoint replay marker is invalid");
	return {
		version: 1,
		sequence,
		checkpointHash: source.checkpointHash,
		generation,
		boundary,
		phase: source.phase,
		timestamp: assertTimestamp(source.timestamp, "timestamp"),
		sessionHash: source.sessionHash,
		workspaceHash: source.workspaceHash,
		providerHash: source.providerHash,
		modelHash: source.modelHash,
		systemHash: source.systemHash,
		projectedToolsHash: source.projectedToolsHash,
		projectedOptionsHash: source.projectedOptionsHash,
		executionHash: source.executionHash,
		policyHash: source.policyHash,
		inventoryHash: source.inventoryHash,
		approvalHash: source.approvalHash,
		...calls === void 0 ? {} : { calls },
		...source.ledgerCorrelationHash === void 0 ? {} : { ledgerCorrelationHash: source.ledgerCorrelationHash },
		...source.reasonCode === void 0 ? {} : { reasonCode: source.reasonCode },
		...source.verdict === void 0 ? {} : { verdict: source.verdict },
		...source.replayConsumed === void 0 ? {} : { replayConsumed: true }
	};
}
function validNextPhase(previous, next) {
	return {
		"generation-prepared": [
			"submission-attempted",
			"cleanup-prepared",
			"non-replayable"
		],
		"submission-attempted": ["generation-submitted", "non-replayable"],
		"generation-submitted": [
			"batch-journaled",
			"completion-journaled",
			"non-replayable"
		],
		"batch-journaled": ["results-confirmed", "non-replayable"],
		"results-confirmed": [
			"handoff-prepared",
			"cleanup-prepared",
			"non-replayable"
		],
		"handoff-prepared": ["handoff-confirmed", "non-replayable"],
		"handoff-confirmed": [
			"batch-journaled",
			"completion-journaled",
			"cleanup-prepared",
			"non-replayable"
		],
		"completion-journaled": ["cleanup-prepared", "non-replayable"],
		"cleanup-prepared": ["cleanup-confirmed", "non-replayable"],
		"cleanup-confirmed": ["terminal", "generation-prepared"],
		"replay-consumed": ["generation-prepared", "non-replayable"],
		"non-replayable": ["cleanup-prepared", "terminal"],
		"terminal": []
	}[previous].includes(next);
}
function validateJournal(records, expectedHash) {
	if (records.length === 0) throw safety("native checkpoint journal is empty");
	let previous;
	for (const record of records) {
		if (record.checkpointHash !== expectedHash) throw safety("native checkpoint hash does not match its filename");
		if (previous === void 0 && (record.sequence !== 1 || record.generation !== 1 || record.boundary !== 0 || record.phase !== "generation-prepared")) throw safety("native checkpoint journal does not start with generation preparation");
		if (previous !== void 0) {
			if (record.sequence !== previous.sequence + 1) throw safety("native checkpoint sequence is not contiguous");
			if (!validNextPhase(previous.phase, record.phase)) throw safety("native checkpoint contains an invalid phase transition");
			if (record.generation < previous.generation) throw safety("native checkpoint generation moved backwards");
			if (record.generation === previous.generation && record.boundary < previous.boundary) throw safety("native checkpoint boundary moved backwards");
			if (!expectedBoundary(record.phase, record.boundary, previous.boundary)) throw safety("native checkpoint boundary transition is invalid");
			if (record.generation > previous.generation) {
				if (record.phase !== "generation-prepared" || record.generation !== previous.generation + 1 || record.boundary !== 0 || record.replayConsumed !== true) throw safety("native checkpoint generation transition is invalid");
			}
			if (record.sessionHash !== previous.sessionHash || record.workspaceHash !== previous.workspaceHash || record.providerHash !== previous.providerHash || record.modelHash !== previous.modelHash || record.systemHash !== previous.systemHash || record.projectedToolsHash !== previous.projectedToolsHash || record.projectedOptionsHash !== previous.projectedOptionsHash || record.executionHash !== previous.executionHash || record.policyHash !== previous.policyHash || record.inventoryHash !== previous.inventoryHash || record.approvalHash !== previous.approvalHash) throw safety("native checkpoint identity changed within a journal");
		}
		if (record.phase === "generation-prepared" && record.boundary !== 0) throw safety("native checkpoint generation preparation has a non-zero boundary");
		const callPhase = record.phase === "batch-journaled" || record.phase === "results-confirmed" || record.phase === "handoff-prepared" || record.phase === "handoff-confirmed";
		if (callPhase && record.calls === void 0) throw safety("native checkpoint boundary has no call bindings");
		if (!callPhase && record.calls !== void 0) throw safety("native checkpoint event has unexpected call bindings");
		if ((record.phase === "batch-journaled" || record.phase === "results-confirmed" || record.phase === "handoff-prepared") && record.calls?.some((call) => call.projectionHash !== void 0)) throw safety("native checkpoint pre-handoff call evidence is malformed");
		if (record.phase === "results-confirmed" || record.phase === "handoff-prepared" || record.phase === "handoff-confirmed") {
			if (record.calls?.some((call) => call.rawResultHash === void 0 || call.isError === void 0)) throw safety("native checkpoint results omit raw result evidence");
		}
		if (record.phase === "handoff-confirmed" && record.calls?.some((call) => call.projectionHash === void 0)) throw safety("native checkpoint handoff omits projection evidence");
		if (record.phase === "handoff-confirmed" && record.calls?.some((call) => call.rawResultHash === void 0 || call.isError === void 0)) throw safety("native checkpoint handoff omits raw result evidence");
		if (record.phase !== "cleanup-confirmed" && record.ledgerCorrelationHash !== void 0) throw safety("native checkpoint event has unexpected cleanup correlation");
		if (record.phase !== "non-replayable" && record.reasonCode !== void 0) throw safety("native checkpoint event has unexpected reason code");
		if (record.phase !== "terminal" && record.verdict !== void 0) throw safety("native checkpoint event has unexpected terminal verdict");
		if (record.phase !== "generation-prepared" && record.replayConsumed !== void 0) throw safety("native checkpoint event has unexpected replay marker");
		if (previous !== void 0) {
			if (previous.phase === "batch-journaled" && record.phase === "results-confirmed" && !sameCallBase(previous.calls, record.calls)) throw safety("native checkpoint result evidence changed its call binding");
			if (previous.phase === "results-confirmed" && record.phase === "handoff-prepared" && !sameResultEvidence(previous.calls, record.calls)) throw safety("native checkpoint handoff preparation changed result evidence");
			const prior = previous;
			if (prior.phase === "handoff-prepared" && record.phase === "handoff-confirmed" && (!sameResultEvidence(prior.calls, record.calls) || record.calls.some((call, index) => call.projectionHash === void 0 || String(call.callId) !== String(prior.calls[index].callId)))) throw safety("native checkpoint handoff confirmation changed result evidence");
		}
		if (record.phase === "cleanup-confirmed" && record.ledgerCorrelationHash === void 0) throw safety("native checkpoint cleanup confirmation omits its correlation");
		if (record.phase === "non-replayable" && record.reasonCode === void 0) throw safety("native checkpoint non-replayable event omits its reason");
		if (record.phase === "terminal" && record.verdict === void 0) throw safety("native checkpoint terminal event omits its verdict");
		previous = record;
	}
}
function stateFor(journal) {
	const records = journal.records;
	const latest = records[records.length - 1];
	const current = records.filter((record) => record.generation === latest.generation);
	const identity = {
		sessionHash: latest.sessionHash,
		workspaceHash: latest.workspaceHash,
		providerHash: latest.providerHash,
		modelHash: latest.modelHash,
		systemHash: latest.systemHash,
		projectedToolsHash: latest.projectedToolsHash,
		projectedOptionsHash: latest.projectedOptionsHash,
		executionHash: latest.executionHash,
		policyHash: latest.policyHash,
		inventoryHash: latest.inventoryHash,
		approvalHash: latest.approvalHash
	};
	const batches = current.filter((record) => record.phase === "batch-journaled");
	const latestBatch = batches[batches.length - 1];
	const results = current.filter((record) => record.phase === "results-confirmed");
	const latestResults = results[results.length - 1];
	const cleanups = current.filter((record) => record.phase === "cleanup-confirmed");
	const cleanupConfirmed = cleanups[cleanups.length - 1];
	const latestHandoff = latestBatch === void 0 ? void 0 : current.filter((record) => record.phase === "handoff-confirmed" && record.sequence > latestBatch.sequence).at(-1);
	const hasHandoffAfterLatestBatch = latestHandoff !== void 0 && !current.some((record) => record.phase === "completion-journaled" && record.sequence > latestHandoff.sequence);
	return {
		journal,
		identity,
		latest,
		replayConsumed: records.some((record) => record.replayConsumed === true || record.phase === "replay-consumed"),
		generation: latest.generation,
		currentGenerationRecords: current,
		...latestBatch === void 0 ? {} : { latestBatch },
		...latestResults === void 0 ? {} : { latestResults },
		...cleanupConfirmed === void 0 ? {} : { cleanupConfirmed },
		hasSubmissionAttempt: current.some((record) => record.phase === "submission-attempted" || record.phase === "generation-submitted" || record.phase === "batch-journaled" || record.phase === "results-confirmed" || record.phase === "handoff-prepared" || record.phase === "handoff-confirmed" || record.phase === "completion-journaled"),
		hasCompletion: current.some((record) => record.phase === "completion-journaled"),
		hasNonReplayable: current.some((record) => record.phase === "non-replayable"),
		hasHandoffAfterLatestBatch
	};
}
function readJournal(path, allowTailTruncate) {
	const fileName = path.split("/").pop() ?? "";
	const match = /^([a-f0-9]{64})\.jsonl$/.exec(fileName);
	if (match === null) throw safety("native checkpoint filename is invalid");
	const checkpointHash = match[1];
	try {
		assertPrivateRegularFile(path, "native checkpoint journal");
		if ((lstatSync(path).mode & 511) !== 384) throw new Error("native checkpoint journal must have 0600 permissions");
	} catch (error) {
		throw safety("native checkpoint journal is not a safe private file", error);
	}
	let bytes = readFileSync(path);
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_JOURNAL_BYTES) throw safety("native checkpoint journal size is invalid");
	if (bytes[bytes.byteLength - 1] !== 10) {
		if (!allowTailTruncate) throw safety("native checkpoint journal has an incomplete final line");
		const lastNewline = bytes.lastIndexOf(10);
		if (lastNewline < 0) throw safety("native checkpoint journal has no complete record");
		const fd = openSync(path, "r+");
		try {
			ftruncateSync(fd, lastNewline + 1);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		syncPrivateDirectory(dirname(path));
		bytes = bytes.subarray(0, lastNewline + 1);
	}
	const lines = bytes.toString("utf8").slice(0, -1).split("\n");
	if (lines.length > MAX_RECORDS) throw safety("native checkpoint journal exceeds its record limit");
	const records = lines.map((line) => {
		if (Buffer.byteLength(line, "utf8") + 1 > MAX_RECORD_BYTES) throw safety("native checkpoint record exceeds its size limit");
		try {
			return parseRecord(JSON.parse(line));
		} catch (error) {
			if (error instanceof NativeSafetyError) throw error;
			throw safety("native checkpoint journal contains malformed JSON", error);
		}
	});
	validateJournal(records, checkpointHash);
	return {
		path,
		checkpointHash,
		records
	};
}
function identityFor(prepared) {
	const snapshot = prepared.nativeRound?.coordinatorSnapshot;
	if (snapshot === void 0) throw safety("native checkpoint requires a prepared coordinator round");
	const options = prepared.providerOptions;
	const systemHash = hashCanonical("native-checkpoint-system", 1, options.system);
	const projectedToolsHash = hashCanonical("native-checkpoint-tools", 1, options.tools);
	const projectedOptionsHash = hashCanonical("native-checkpoint-options", 1, {
		reasoningEffort: options.reasoningEffort,
		temperature: options.temperature,
		maxTokens: options.maxTokens,
		stop: options.stop,
		purpose: options.purpose
	});
	const sessionHash = hashCanonical("native-checkpoint-session", 1, snapshot.sessionId);
	const workspaceHash = hashCanonical("native-checkpoint-workspace", 1, prepared.summary.workspaceRoot);
	const providerHash = hashCanonical("native-checkpoint-provider", 1, options.provider);
	const modelHash = hashCanonical("native-checkpoint-model", 1, options.model);
	return {
		sessionHash,
		workspaceHash,
		providerHash,
		modelHash,
		systemHash,
		projectedToolsHash,
		projectedOptionsHash,
		executionHash: hashCanonical("native-checkpoint-execution", 1, {
			sessionHash,
			workspaceHash,
			providerHash,
			modelHash,
			systemHash,
			projectedToolsHash,
			projectedOptionsHash,
			policyHash: prepared.policyHash,
			inventoryHash: prepared.inventoryHash,
			approvalHash: prepared.approvalHash
		}),
		policyHash: assertHash(prepared.policyHash, "policy hash"),
		inventoryHash: assertHash(prepared.inventoryHash, "inventory hash"),
		approvalHash: assertHash(prepared.approvalHash, "approval hash")
	};
}
function rawResultHash(result) {
	return hashCanonical("native-tool-result", 1, {
		content: result.content,
		isError: result.isError === true
	});
}
function projectionHash(result) {
	return hashCanonical("native-tool-projection", 1, {
		content: result.content,
		isError: result.isError === true
	});
}
/**
* @deprecated Checkpoint result hashes are implementation-owned evidence.
*/
function nativeCheckpointRawResultHash(result) {
	return rawResultHash(result);
}
/**
* @deprecated Checkpoint result hashes are implementation-owned evidence.
*/
function nativeCheckpointProjectionHash(result) {
	return projectionHash(result);
}
function sameIdentity(left, right) {
	return left.sessionHash === right.sessionHash && left.workspaceHash === right.workspaceHash && left.providerHash === right.providerHash && left.modelHash === right.modelHash && left.systemHash === right.systemHash && left.projectedToolsHash === right.projectedToolsHash && left.projectedOptionsHash === right.projectedOptionsHash && left.executionHash === right.executionHash && left.policyHash === right.policyHash && left.inventoryHash === right.inventoryHash && left.approvalHash === right.approvalHash;
}
function sameCallBindings(left, right) {
	return canonicalJson(left) === canonicalJson(right);
}
function sameCallBase(left, right) {
	if (left.length !== right.length) return false;
	return left.every((call, index) => {
		const other = right[index];
		return other !== void 0 && call.ordinal === other.ordinal && String(call.callId) === String(other.callId) && call.toolName === other.toolName && call.schemaHash === other.schemaHash && call.argumentsHash === other.argumentsHash;
	});
}
function sameResultEvidence(left, right) {
	if (left.length !== right.length) return false;
	return left.every((call, index) => {
		const other = right[index];
		return other !== void 0 && sameCallBase([call], [other]) && call.rawResultHash === other.rawResultHash && call.isError === other.isError;
	});
}
function expectedBoundary(next, boundary, previousBoundary) {
	if (next === "generation-prepared") return boundary === 0;
	if (next === "batch-journaled") return boundary === previousBoundary + 1;
	return boundary === previousBoundary;
}
function callBindings(calls) {
	if (calls.length === 0) throw safety("native checkpoint cannot journal an empty tool batch");
	const bindings = calls.map((call) => {
		const binding = call.binding;
		if (binding === void 0) throw safety("native checkpoint requires an immutable policy call binding");
		const id = callId(call.callId);
		const name = toolName(call.name);
		if (binding.toolName !== name) throw safety("native checkpoint call binding tool name does not match its call");
		if (!Number.isSafeInteger(binding.callOrdinal) || binding.callOrdinal <= 0) throw safety("native checkpoint call ordinal is invalid");
		if (!CHECKPOINT_HASH.test(binding.schemaHash) || !CHECKPOINT_HASH.test(binding.argumentsHash)) throw safety("native checkpoint call binding hash is invalid");
		let argumentsHash;
		try {
			argumentsHash = hashCanonical("native-tool-arguments", 1, call.arguments);
		} catch (error) {
			throw safety("native checkpoint call arguments are not canonical JSON", error);
		}
		if (argumentsHash !== binding.argumentsHash) throw safety("native checkpoint call arguments do not match their binding hash");
		return {
			ordinal: binding.callOrdinal,
			callId: id,
			toolName: name,
			schemaHash: binding.schemaHash,
			argumentsHash: binding.argumentsHash
		};
	});
	if (bindings.some((item, index) => index > 0 && item.ordinal <= bindings[index - 1].ordinal)) throw safety("native checkpoint call ordinals are not increasing");
	if (new Set(bindings.map((item) => String(item.callId))).size !== bindings.length) throw safety("native checkpoint batch contains duplicate call IDs");
	return bindings;
}
function exactCallBindings(calls, expected) {
	const actual = callBindings(calls);
	if (!sameCallBindings(actual, expected)) throw safety("native checkpoint call evidence does not match the journal");
	return actual;
}
function resultBindings(calls, results, expected) {
	if (calls.length !== results.length) throw safety("native checkpoint result count does not match its calls");
	return exactCallBindings(calls, expected).map((call, index) => ({
		...call,
		rawResultHash: rawResultHash(results[index]),
		isError: results[index].isError === true
	}));
}
function projectionBindings(expected, projections) {
	if (expected.length !== projections.length) throw safety("native checkpoint projection count does not match its calls");
	return expected.map((call, index) => {
		if (call.rawResultHash === void 0 || call.isError === void 0) throw safety("native checkpoint raw result evidence is missing");
		const result = projections[index];
		if (result.isError === true !== call.isError) throw safety("native checkpoint projection changed the error flag");
		return {
			...call,
			projectionHash: projectionHash(result)
		};
	});
}
function incomingToolResult(value, expectedCallId) {
	if (value === null || typeof value !== "object") return void 0;
	const message = value;
	if (message.role !== "user" || message.source?.kind !== "tool" || String(message.source.callId) !== expectedCallId || !Array.isArray(message.content) || message.content.length !== 1) return void 0;
	const block = message.content[0];
	if (block?.type !== "tool-result" || String(block.toolCallId) !== expectedCallId || !Array.isArray(block.content) || block.content.some((item) => item?.type !== "text") || block.isError !== void 0 && typeof block.isError !== "boolean") return void 0;
	return {
		content: structuredClone(block.content),
		isError: block.isError === true
	};
}
function exactIncomingResults(prepared, bindings) {
	if (bindings.some((binding) => prepared.summary.tools.find((tool) => tool.tool === binding.toolName)?.schemaHash !== binding.schemaHash)) return false;
	const canonicalMessages = prepared.nativeRound?.coordinatorSnapshot.canonicalMessages;
	if (canonicalMessages === void 0) return false;
	const providerMessages = prepared.providerOptions.messages;
	const find = (messages, expectedArguments) => {
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			const blocks = message.content.filter((item) => item?.type === "tool-call");
			if (blocks.length !== bindings.length) continue;
			if (!bindings.every((binding, callIndex) => {
				const block = blocks[callIndex];
				if (block === void 0 || String(block.id) !== String(binding.callId) || block.name !== binding.toolName || typeof block.arguments !== "string") return false;
				if (expectedArguments !== void 0) return block.arguments === expectedArguments[callIndex];
				let args;
				try {
					args = JSON.parse(block.arguments);
				} catch {
					return false;
				}
				return hashCanonical("native-tool-arguments", 1, args) === binding.argumentsHash;
			})) continue;
			const results = [];
			let complete = true;
			for (let resultIndex = 0; resultIndex < bindings.length; resultIndex += 1) {
				const result = incomingToolResult(messages[index + 1 + resultIndex], String(bindings[resultIndex].callId));
				if (result === void 0 || rawResultHash(result) !== bindings[resultIndex].rawResultHash) {
					complete = false;
					break;
				}
				results.push(result);
			}
			if (complete) return {
				index,
				results
			};
		}
	};
	const canonical = find(canonicalMessages);
	if (canonical === void 0) return false;
	const canonicalAssistant = canonicalMessages[canonical.index];
	if (canonicalAssistant === void 0) return false;
	const projectedAssistant = prepared.projectProviderMessages([canonicalAssistant])[0];
	if (projectedAssistant === void 0 || !Array.isArray(projectedAssistant.content)) return false;
	const projectedArguments = projectedAssistant.content.filter((block) => block.type === "tool-call").map((block) => block.arguments);
	if (projectedArguments.length !== bindings.length) return false;
	const provider = find(providerMessages, projectedArguments);
	if (provider === void 0) return false;
	return bindings.every((binding, index) => (binding.projectionHash === void 0 || projectionHash(provider.results[index]) === binding.projectionHash) && provider.results[index].isError === binding.isError);
}
var NativeCheckpointImpl = class {
	store;
	current;
	closed = false;
	constructor(store, state) {
		this.store = store;
		this.current = state;
	}
	get checkpointHash() {
		return this.current.journal.checkpointHash;
	}
	get generation() {
		return this.current.generation;
	}
	recordSubmissionAttempted() {
		this.append("submission-attempted", 0);
	}
	recordSubmitted() {
		this.append("generation-submitted", 0);
	}
	recordBatch(calls) {
		const previousBoundary = this.current.latest.boundary;
		const bindings = callBindings(calls);
		this.append("batch-journaled", previousBoundary + 1, { calls: bindings });
	}
	confirmResults(calls, results) {
		const latest = this.requirePhase("batch-journaled");
		const bindings = resultBindings(calls, results, latest.calls ?? []);
		this.append("results-confirmed", latest.boundary, { calls: bindings });
	}
	prepareHandoff() {
		const latest = this.requirePhase("results-confirmed");
		this.append("handoff-prepared", latest.boundary, { calls: latest.calls });
	}
	confirmHandoff(projections) {
		const latest = this.requirePhase("handoff-prepared");
		const bindings = projectionBindings(latest.calls ?? [], projections);
		this.append("handoff-confirmed", latest.boundary, { calls: bindings });
	}
	recordCompletion() {
		if (this.current.latest.phase !== "generation-submitted" && this.current.latest.phase !== "handoff-confirmed") throw safety(`native checkpoint cannot journal completion after ${this.current.latest.phase}`);
		this.append("completion-journaled", this.current.latest.boundary);
	}
	prepareCleanup() {
		if (!(/* @__PURE__ */ new Set([
			"generation-prepared",
			"results-confirmed",
			"handoff-confirmed",
			"completion-journaled",
			"non-replayable"
		])).has(this.current.latest.phase)) throw safety(`native checkpoint cannot prepare cleanup after ${this.current.latest.phase}`);
		this.append("cleanup-prepared", this.current.latest.boundary);
	}
	confirmCleanup(ledgerCorrelationHash) {
		assertHash(ledgerCorrelationHash, "ledger correlation hash");
		this.requirePhase("cleanup-prepared");
		this.store.assertCleanupLedgerEmpty();
		this.append("cleanup-confirmed", this.current.latest.boundary, { ledgerCorrelationHash });
	}
	consumeReplayAndPrepareNextGeneration() {
		const latest = this.requirePhase("cleanup-confirmed");
		if (this.current.latestBatch === void 0 || this.current.latestResults === void 0) throw safety("native checkpoint has no exact result boundary to replay");
		const nextGeneration = latest.generation + 1;
		this.append("generation-prepared", 0, { replayConsumed: true }, nextGeneration);
		return nextGeneration;
	}
	markNonReplayable(reasonCode) {
		const reason = assertBoundedText(reasonCode, "reason code");
		if (!SAFE_TOKEN.test(reason)) throw safety("native checkpoint reason code is invalid");
		if (this.current.latest.phase === "terminal") return;
		if (this.current.latest.phase === "non-replayable") return;
		this.append("non-replayable", this.current.latest.boundary, { reasonCode: reason });
	}
	markTerminal(verdict) {
		if (this.current.latest.phase === "terminal") return;
		this.requirePhase("cleanup-confirmed");
		this.append("terminal", this.current.latest.boundary, { verdict });
		this.store.onTerminal(this.current.journal.checkpointHash);
	}
	requirePhase(phase) {
		if (this.current.latest.phase !== phase) throw safety(`native checkpoint expected ${phase}, found ${this.current.latest.phase}`);
		return this.current.latest;
	}
	append(phase, boundary, extras = {}, generation = this.current.generation) {
		this.store.assertCheckpointWriter();
		if (this.closed) throw safety("native checkpoint is closed");
		const previous = this.current.latest;
		if (generation === previous.generation && boundary < previous.boundary) throw safety("native checkpoint boundary moved backwards");
		if (!validNextPhase(previous.phase, phase) && !(generation > previous.generation && phase === "generation-prepared")) throw safety(`native checkpoint cannot append ${phase} after ${previous.phase}`);
		const record = {
			version: 1,
			sequence: previous.sequence + 1,
			checkpointHash: this.current.journal.checkpointHash,
			generation,
			boundary,
			phase,
			timestamp: this.store.nowTimestamp(),
			...this.current.identity,
			...extras
		};
		appendDurableJsonRecord(this.current.journal.path, record);
		const records = [...this.current.journal.records, record];
		validateJournal(records, this.current.journal.checkpointHash);
		this.current = stateFor({
			...this.current.journal,
			records
		});
	}
	close() {
		this.closed = true;
	}
};
function appendDurableJsonRecord(path, record) {
	if (Buffer.byteLength(JSON.stringify(record), "utf8") + 1 > MAX_RECORD_BYTES) throw safety("native checkpoint record exceeds its size limit");
	appendDurablePrivateJsonLine(path, record);
}
function summary(state) {
	const blockedReason = state.latest.phase === "terminal" ? void 0 : state.latest.phase === "generation-prepared" && state.latest.replayConsumed === true ? "replay-consumed-before-submission" : state.latest.phase === "submission-attempted" || state.latest.phase === "generation-submitted" ? "provider-outcome-unknown" : state.latest.phase === "batch-journaled" ? "potentially-executed-tool-boundary" : state.latest.phase === "handoff-prepared" ? "result-handoff-unknown" : void 0;
	return {
		checkpointHash: state.journal.checkpointHash,
		executionHash: state.identity.executionHash,
		latestEvent: state.latest.phase,
		terminal: state.latest.phase === "terminal",
		replayConsumed: state.replayConsumed,
		...blockedReason === void 0 ? {} : { blockedReason }
	};
}
var NativeCheckpointStoreImpl = class {
	profileDir;
	options;
	directory;
	now;
	makeUUID;
	writer;
	active = /* @__PURE__ */ new Map();
	recoveryCleanupCorrelations = /* @__PURE__ */ new Map();
	constructor(profileDir, options = {}) {
		this.profileDir = profileDir;
		this.options = options;
		this.directory = join(profileDir, JOURNAL_DIRECTORY);
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.makeUUID = options.randomUUID ?? randomUUID;
	}
	acquire() {
		if (this.writer !== void 0) return this.writer;
		ensurePrivateDirectory(this.profileDir);
		ensurePrivateDirectory(this.directory);
		const acquired = acquirePrivateWriterLease(this.profileDir, this.options.writerDependencies ?? this.options);
		let released = false;
		const wrapped = {
			ownerToken: acquired.ownerToken,
			heartbeat: () => {
				if (released) throw safety("native checkpoint writer lease is released");
				acquired.heartbeat();
			},
			release: () => {
				if (released) return;
				acquired.release();
				for (const checkpoint of this.active.values()) checkpoint.close();
				this.active.clear();
				released = true;
				if (this.writer === wrapped) this.writer = void 0;
			}
		};
		this.writer = wrapped;
		return wrapped;
	}
	inspect() {
		if (this.writer !== void 0) this.assertCheckpointWriter();
		return this.load(this.writer !== void 0).map(summary);
	}
	recoverForRequest(prepared) {
		this.assertCheckpointWriter();
		const states = this.load(true);
		const identity = identityFor(prepared);
		const nonTerminal = states.filter((state) => state.latest.phase !== "terminal");
		for (const state of nonTerminal) {
			if (this.active.get(state.journal.checkpointHash) !== void 0) {
				if (state.identity.executionHash === identity.executionHash) continue;
				return {
					kind: "blocked",
					checkpointHash: state.journal.checkpointHash,
					reason: "another native checkpoint is active"
				};
			}
			if (state.latest.phase === "generation-prepared" && state.latest.replayConsumed !== true && !state.hasSubmissionAttempt) {
				if (!this.ledgerIsEmpty()) return {
					kind: "cleanup-required",
					checkpointHash: state.journal.checkpointHash
				};
				this.autoClosePrepared(state);
				continue;
			}
			if (state.latest.phase === "generation-prepared" && state.latest.replayConsumed === true) return {
				kind: "blocked",
				checkpointHash: state.journal.checkpointHash,
				reason: "replay was consumed before submission was proven"
			};
			if (state.latest.phase === "replay-consumed") return {
				kind: "blocked",
				checkpointHash: state.journal.checkpointHash,
				reason: "replay was already consumed"
			};
			if (state.latest.phase === "submission-attempted" || state.latest.phase === "generation-submitted") return {
				kind: "blocked",
				checkpointHash: state.journal.checkpointHash,
				reason: "provider outcome is uncertain; refusing resubmission"
			};
			if (state.latest.phase === "batch-journaled") return {
				kind: "blocked",
				checkpointHash: state.journal.checkpointHash,
				reason: "tool boundary may have executed; exact results are not durable"
			};
			if (state.latest.phase === "handoff-prepared" || state.latest.phase === "handoff-confirmed") return {
				kind: "blocked",
				checkpointHash: state.journal.checkpointHash,
				reason: "provider continuation outcome is unknown"
			};
			if (state.latest.phase === "non-replayable" || state.latest.phase === "completion-journaled" || state.latest.phase === "cleanup-prepared" || state.latest.phase === "results-confirmed") return {
				kind: "cleanup-required",
				checkpointHash: state.journal.checkpointHash
			};
			if (state.latest.phase === "cleanup-confirmed") {
				if (state.hasHandoffAfterLatestBatch) return {
					kind: "blocked",
					checkpointHash: state.journal.checkpointHash,
					reason: "provider continuation outcome is unknown"
				};
				if (state.hasNonReplayable) {
					this.materialize(state).markTerminal("failed");
					continue;
				}
				if (!this.ledgerIsEmpty()) return {
					kind: "cleanup-required",
					checkpointHash: state.journal.checkpointHash
				};
				if (state.hasCompletion || state.latestBatch === void 0 || state.latestResults === void 0) {
					this.materialize(state).markTerminal(state.hasCompletion ? "completed" : "failed");
					continue;
				}
				if (!sameIdentity(state.identity, identity)) return {
					kind: "blocked",
					checkpointHash: state.journal.checkpointHash,
					reason: "native checkpoint identity does not match the request"
				};
				if (!exactIncomingResults(prepared, state.latestResults.calls ?? [])) return {
					kind: "blocked",
					checkpointHash: state.journal.checkpointHash,
					reason: "canonical tool calls or results do not exactly match the journal"
				};
				return {
					kind: "fresh-replay",
					checkpointHash: state.journal.checkpointHash,
					generation: state.generation + 1
				};
			}
			if (state.latest.phase === "terminal") continue;
			return {
				kind: "blocked",
				checkpointHash: state.journal.checkpointHash,
				reason: "native checkpoint state is not recoverable"
			};
		}
		return { kind: "normal" };
	}
	begin(prepared) {
		this.assertCheckpointWriter();
		const identity = identityFor(prepared);
		this.pruneAndCheckCaps();
		ensurePrivateDirectory(this.directory);
		let checkpointHash = "";
		let path = "";
		for (let attempt = 0; attempt < 8; attempt += 1) {
			checkpointHash = hashCanonical("native-checkpoint-id", 1, {
				nonce: this.makeUUID(),
				attempt
			});
			path = journalPath(this.directory, checkpointHash);
			try {
				const stat = lstatSync(path);
				if (stat.isSymbolicLink() || !stat.isFile()) throw safety("native checkpoint identifier collides with an unsafe target");
				continue;
			} catch (error) {
				if (errorCode(error) === "ENOENT") break;
				if (error instanceof NativeSafetyError) throw error;
				throw safety("native checkpoint identifier could not be checked safely", error);
			}
		}
		if (path.length === 0) throw safety("native checkpoint identifier could not be allocated");
		try {
			lstatSync(path);
			throw safety("native checkpoint identifier collision could not be resolved");
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const record = {
			version: 1,
			sequence: 1,
			checkpointHash,
			generation: 1,
			boundary: 0,
			phase: "generation-prepared",
			timestamp: this.nowTimestamp(),
			...identity
		};
		appendDurableJsonRecord(path, record);
		const state = stateFor({
			path,
			checkpointHash,
			records: [record]
		});
		const checkpoint = new NativeCheckpointImpl(this, state);
		this.active.set(checkpointHash, checkpoint);
		return checkpoint;
	}
	prepareRecoveryCleanup(checkpointHash) {
		this.assertCheckpointWriter();
		const state = this.load(true).find((item) => item.journal.checkpointHash === checkpointHash);
		if (state === void 0) throw safety("native checkpoint was not found");
		if (this.active.has(checkpointHash)) throw safety("native checkpoint cleanup is owned by the active runtime");
		const pending = createOwnedConversationLedger(this.profileDir).pending();
		if (state.latest.phase === "cleanup-confirmed") {
			if (pending.length !== 0) throw safety("native checkpoint cleanup confirmation conflicts with the ownership ledger");
			this.recoveryCleanupCorrelations.delete(checkpointHash);
			return;
		}
		if (pending.length !== 1) throw safety("native checkpoint cleanup cannot be correlated to exactly one owned conversation");
		this.recoveryCleanupCorrelations.set(checkpointHash, hashCanonical("native-ledger-correlation", 1, pending[0]));
		if (state.latest.phase !== "cleanup-prepared") this.materialize(state).prepareCleanup();
	}
	confirmRecoveryCleanup(checkpointHash, ledgerCorrelationHash) {
		this.assertCheckpointWriter();
		const state = this.load(true).find((item) => item.journal.checkpointHash === checkpointHash);
		if (state === void 0) throw safety("native checkpoint was not found");
		if (this.active.has(checkpointHash)) throw safety("native checkpoint cleanup is owned by the active runtime");
		if (state.latest.phase === "cleanup-confirmed") {
			if (createOwnedConversationLedger(this.profileDir).pending().length !== 0) throw safety("native checkpoint cleanup confirmation conflicts with the ownership ledger");
			this.recoveryCleanupCorrelations.delete(checkpointHash);
			return;
		}
		const expected = this.recoveryCleanupCorrelations.get(checkpointHash);
		if (expected === void 0 || expected !== ledgerCorrelationHash) throw safety("native checkpoint cleanup correlation is not the prepared ownership proof");
		if (createOwnedConversationLedger(this.profileDir).pending().length !== 0) throw safety("native checkpoint cleanup cannot be confirmed while ownership remains pending");
		this.materialize(state).confirmCleanup(ledgerCorrelationHash);
		this.recoveryCleanupCorrelations.delete(checkpointHash);
	}
	prepareFreshReplay(prepared, checkpointHash) {
		this.assertCheckpointWriter();
		if (!CHECKPOINT_HASH.test(checkpointHash)) throw safety("native checkpoint hash is invalid");
		const state = this.load(true).find((item) => item.journal.checkpointHash === checkpointHash);
		if (state === void 0) throw safety("native checkpoint was not found");
		const identity = identityFor(prepared);
		if (!sameIdentity(state.identity, identity)) throw safety("native checkpoint identity does not match the replay request");
		if (state.latest.phase !== "cleanup-confirmed" || state.latestBatch === void 0 || state.latestResults === void 0) throw safety("native checkpoint is not ready for a fresh replay");
		if (!exactIncomingResults(prepared, state.latestResults.calls ?? [])) throw safety("native checkpoint replay evidence does not match the request");
		const checkpoint = this.materialize(state);
		checkpoint.consumeReplayAndPrepareNextGeneration();
		this.active.set(checkpointHash, checkpoint);
		return checkpoint;
	}
	abandon(checkpointHash) {
		this.assertCheckpointWriter();
		if (!CHECKPOINT_HASH.test(checkpointHash)) throw safety("native checkpoint hash is invalid");
		const state = this.load(true).find((item) => item.journal.checkpointHash === checkpointHash);
		if (state === void 0) throw safety("native checkpoint was not found");
		if (this.active.has(checkpointHash)) throw safety("native checkpoint is owned by the active runtime");
		if (state.latest.phase === "terminal") return;
		if (state.latest.phase === "cleanup-confirmed") {
			if (!this.ledgerIsEmpty()) throw safety("native checkpoint abandonment requires confirmed ownership cleanup");
			if (state.hasHandoffAfterLatestBatch) throw safety("native checkpoint abandonment cannot close an unknown provider continuation");
			this.materialize(state).markTerminal("abandoned");
			return;
		}
		const checkpoint = this.materialize(state);
		if (state.latest.phase !== "non-replayable") checkpoint.markNonReplayable("operator-abandon");
		if (state.hasSubmissionAttempt) return;
		checkpoint.prepareCleanup();
		checkpoint.confirmCleanup(hashCanonical("native-ledger-correlation", 1, []));
		checkpoint.markTerminal("abandoned");
	}
	nowTimestamp() {
		return timestamp(this.now(), "timestamp");
	}
	onTerminal(checkpointHash) {
		this.active.get(checkpointHash)?.close();
		this.active.delete(checkpointHash);
	}
	materialize(state) {
		const active = this.active.get(state.journal.checkpointHash);
		if (active !== void 0) return active;
		return new NativeCheckpointImpl(this, state);
	}
	autoClosePrepared(state) {
		const checkpoint = this.materialize(state);
		checkpoint.prepareCleanup();
		checkpoint.confirmCleanup(hashCanonical("native-ledger-correlation", 1, []));
		checkpoint.markTerminal("abandoned");
	}
	assertCheckpointWriter() {
		this.requireWriter();
		try {
			this.writer.heartbeat();
		} catch (error) {
			throw safety("native checkpoint writer ownership could not be verified", error);
		}
	}
	assertCleanupLedgerEmpty() {
		if (!this.ledgerIsEmpty()) throw safety("native checkpoint ownership ledger is not empty");
	}
	requireWriter() {
		if (this.writer === void 0) throw safety("native checkpoint writer lease is required");
	}
	ledgerIsEmpty() {
		return createOwnedConversationLedger(this.profileDir).pending().length === 0;
	}
	pruneAndCheckCaps() {
		const states = this.load(true);
		const terminals = states.filter((state) => state.latest.phase === "terminal").sort((left, right) => left.latest.timestamp.localeCompare(right.latest.timestamp));
		for (const state of terminals.slice(0, Math.max(0, terminals.length - MAX_TERMINAL_JOURNALS))) {
			assertPrivateRegularFile(state.journal.path, "native checkpoint journal");
			rmSync(state.journal.path, { force: false });
			syncPrivateDirectory(this.directory);
		}
		if (states.filter((state) => !terminals.some((item) => item.journal.checkpointHash === state.journal.checkpointHash && terminals.indexOf(item) < Math.max(0, terminals.length - MAX_TERMINAL_JOURNALS))).filter((state) => state.latest.phase !== "terminal").length > MAX_NON_TERMINAL_JOURNALS) throw safety("native checkpoint non-terminal journal cap has been reached");
	}
	load(allowTailTruncate) {
		try {
			lstatSync(this.profileDir);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return [];
			throw safety("native checkpoint profile directory could not be inspected safely", error);
		}
		assertPrivateDirectory(this.profileDir, "native checkpoint profile directory");
		try {
			lstatSync(this.directory);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return [];
			throw safety("native checkpoint journal directory could not be inspected safely", error);
		}
		assertPrivateDirectory(this.directory, "native checkpoint journal directory");
		const entries = readdirSync(this.directory, { withFileTypes: true });
		const states = [];
		for (const entry of entries) {
			if (!entry.name.endsWith(JOURNAL_SUFFIX)) throw safety("native checkpoint directory contains an unexpected entry");
			const path = join(this.directory, entry.name);
			if (entry.isSymbolicLink() || !entry.isFile()) throw safety("native checkpoint journal is not a regular file");
			states.push(stateFor(readJournal(path, allowTailTruncate)));
		}
		return states;
	}
};
function createNativeCheckpointStore(profileDir, dependencies = {}) {
	return new NativeCheckpointStoreImpl(profileDir, dependencies);
}
//#endregion
export { hashCanonical as $, appendDurablePrivateJsonLine as A, ChatGptBrowser as B, loadManagedNativeRuntimeConfig as C, deleteOwnedConversation as D, createOwnedConversationLedger as E, durableAtomicWritePrivateFile as F, CHATGPT_EFFORT_CONTROL_SELECTOR as G, CHATGPT_COMPOSER_SELECTOR as H, ensurePrivateDirectory as I, assertChatGptSurfaceUrl as J, activateChatGptEffortMenu as K, inspectPrivateWriterLease as L, assertPrivateRegularFile as M, atomicWritePrivateFile as N, retryPendingConversationDeletions as O, currentProcessStartedAt as P, canonicalJson as Q, snapshotPrivateFile as R, ensureManagedRuntimeDirectories as S, conversationIdFromUrl as T, CHATGPT_CONNECTOR_MENU_ITEM_SELECTOR as U, CHATGPT_ASSISTANT_TURN_SELECTOR as V, CHATGPT_CONNECTOR_PILL_SELECTOR as W, detectChatGptAccountCapabilities as X, chatGptSurfaceUrl as Y, parseChatGptEffortSliderState as Z, redactTunnelDetail as _, nativeSecuritySummaryHash as a, defaultManagedRuntimePaths as b, approveNativeChallenge as c, readNativeApprovalState as d, requireNativeApproval as f, ManagedTunnelRuntime as g, ManagedRuntimeTransportError as h, NATIVE_SECURITY_STATE_MAX_AGE_MS as i, assertPrivateDirectory as j, acquirePrivateWriterLease as k, formatNativeApprovalChallenge as l, ManagedRuntimeConfigurationError as m, nativeCheckpointProjectionHash as n, readNativeSecurityState as o, shellQuotePosix as p, assertAuthenticatedChatGptPage as q, nativeCheckpointRawResultHash as r, writeNativeSecurityState as s, createNativeCheckpointStore as t, readNativeApprovalChallenge as u, runCommand as v, parseManagedNativeRuntimeConfig as w, defaultNativeRuntimeConfigPath as x, MANAGED_TUNNEL_CLIENT_VERSION as y, syncPrivateDirectory as z };
