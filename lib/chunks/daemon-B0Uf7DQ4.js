import { LlmError } from "@deepseek-ai/dsh-llm";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
//#region src/chatgpt/launch.ts
/**
* Shared Chromium launch knowledge: stealth flags, executable resolution,
* macOS hide, and window minimization. Used by the in-process browser owner
* and the standalone daemon alike.
* @module dsh-llm-chatgpt-web/chatgpt-launch
*/
/**
* Launch hardening against bot gates (Cloudflare loops when `navigator.webdriver`
* or `--enable-automation` leak through). Human input stays human: the user
* still clicks and types everything themselves.
*/
const STEALTH_ARGS = [
	"--disable-blink-features=AutomationControlled",
	"--no-first-run",
	"--no-default-browser-check"
];
const STEALTH_IGNORE_DEFAULT_ARGS = ["--enable-automation"];
const STEALTH_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}
  try {
    if (!window.chrome) window.chrome = { runtime: {} };
  } catch {}
})()`;
/** No window at launch: first tab creates it, minimized within milliseconds. */
const NO_STARTUP_WINDOW_ARGS = ["--no-startup-window"];
/** Marker flag identifying daemon-owned browser processes for safe reaping. */
const DAEMON_MARKER_ARG = "--dsh-chatgpt-web-daemon";
/** Resolve the system Chrome executable, mirroring upstream conventions. */
function defaultChromeExecutable(platform = process.platform, programFiles = process.env["PROGRAMFILES"]) {
	if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	if (platform === "win32") return join(programFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
	return "/usr/bin/google-chrome";
}
const BRAVE_MACOS_PATH = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
/**
* Resolve the executable: explicit config, env, conventional paths, Brave on
* macOS, else `undefined` (Playwright's bundled Chromium).
*/
function resolveChromeExecutable(configured) {
	if (configured && configured.length > 0) return configured;
	if (process.env["CHROME_EXECUTABLE_PATH"]) return process.env["CHROME_EXECUTABLE_PATH"];
	const conventional = defaultChromeExecutable();
	if (existsSync(conventional)) return conventional;
	if (process.platform === "darwin" && existsSync(BRAVE_MACOS_PATH)) return BRAVE_MACOS_PATH;
}
/** Default profile home: login session + diagnostics live here (0600-style privacy). */
function defaultProfileDir() {
	const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
	return join(home, ".dsh-chatgpt-web");
}
/**
* Best-effort macOS hide of an exact PID. Never fatal; denial or failure
* silently falls back to CDP minimize.
*/
async function hideProcess(pid) {
	if (process.platform !== "darwin" || pid === void 0) return;
	await new Promise((resolve) => {
		const script = `try\ntell application "System Events" to set visible of (first process whose unix id is ${pid}) to false\nend try`;
		execFile("/usr/bin/osascript", ["-e", script], { timeout: 5e3 }, (error) => {
			console.log(`[dsh-llm-chatgpt-web] hide pid=${pid} ${error ? `failed: ${String(error).split("\n")[0]}` : "ok"}`);
			resolve();
		});
	});
}
/** Minimize every page window on a connected browser; logs the count. */
async function minimizeAllWindows(browser, reason) {
	const session = await browser.newBrowserCDPSession();
	try {
		const { targetInfos } = await session.send("Target.getTargets");
		const pages = targetInfos.filter((target) => target.type === "page");
		for (const pageTarget of pages) {
			const { windowId } = await session.send("Browser.getWindowForTarget", { targetId: pageTarget.targetId });
			await session.send("Browser.setWindowBounds", {
				windowId,
				bounds: { windowState: "minimized" }
			});
		}
		console.log(`[dsh-llm-chatgpt-web] minimize (${reason}): windows=${pages.length}`);
	} finally {
		await session.detach().catch(() => {});
	}
}
/**
* Resize every page window while keeping it minimized. Used at daemon birth:
* the window opens at 1x1 (any first paint is a single dot) and grows only
* after it is hidden+minimized, so no full-size flash ever reaches the user.
* Size travels alone: CDP rejects combining minimized/maximized/fullscreen
* with width/height in one call.
*/
async function resizeWindowsMinimized(browser, reason, width, height) {
	const session = await browser.newBrowserCDPSession();
	try {
		const { targetInfos } = await session.send("Target.getTargets");
		const pages = targetInfos.filter((target) => target.type === "page");
		for (const pageTarget of pages) {
			const { windowId } = await session.send("Browser.getWindowForTarget", { targetId: pageTarget.targetId });
			await session.send("Browser.setWindowBounds", {
				windowId,
				bounds: {
					width,
					height
				}
			});
		}
		console.log(`[dsh-llm-chatgpt-web] resize-minimized (${reason}): windows=${pages.length} ${width}x${height}`);
	} finally {
		await session.detach().catch(() => {});
	}
}
//#endregion
//#region src/chatgpt/daemon.ts
/**
* Daemon client: connect to the shared browser daemon, spawning it detached
* on first use. Staleness is proven by failed connect, never by PID guess;
* orphaned browsers are reaped only after their command line proves the
* daemon marker flag.
* @module dsh-llm-chatgpt-web/chatgpt-daemon
*/
function endpointPath(profileDir) {
	return join(profileDir, "browser-endpoint.json");
}
/** Accept only loopback WebSocket endpoints (never a remote URL). Exported for tests. */
function isLoopbackEndpoint(wsEndpoint) {
	if (!wsEndpoint.startsWith("ws://")) return false;
	const rest = wsEndpoint.slice(5);
	if (rest.startsWith("[")) {
		const end = rest.indexOf("]");
		if (end < 0) return false;
		const next = rest[end + 1];
		if (next !== void 0 && next !== ":" && next !== "/") return false;
		return rest.slice(0, end + 1) === "[::1]";
	}
	const host = rest.split(/[/:]/)[0];
	return host === "127.0.0.1" || host === "localhost";
}
function readEndpoint(profileDir) {
	const path = endpointPath(profileDir);
	if (!existsSync(path)) return void 0;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed["wsEndpoint"] !== "string" || !isLoopbackEndpoint(parsed["wsEndpoint"])) return;
		return parsed;
	} catch {
		return;
	}
}
/** Touch the endpoint file: the daemon's idle clock. */
function touchEndpoint(profileDir) {
	try {
		utimesSync(endpointPath(profileDir), /* @__PURE__ */ new Date(), /* @__PURE__ */ new Date());
	} catch {}
}
/** True when the PID is alive AND its command line carries our marker. */
function isOurDaemonBrowser(pid) {
	return new Promise((resolve) => {
		execFile("/bin/ps", [
			"-p",
			String(pid),
			"-o",
			"args="
		], (error, stdout) => {
			if (error) return resolve(false);
			resolve(stdout.includes(DAEMON_MARKER_ARG));
		});
	});
}
async function reapStaleBrowser(endpoint) {
	if (typeof endpoint.browserPid !== "number") return;
	try {
		if (await isOurDaemonBrowser(endpoint.browserPid)) process.kill(endpoint.browserPid, "SIGTERM");
	} catch {}
}
function resolveTsxLoader() {
	try {
		return fileURLToPath(import.meta.resolve("tsx/esm"));
	} catch {
		throw new LlmError("ChatGPT Web daemon entry not found. Run `pnpm build` in dsh-llm-chatgpt-web first.", "TRANSPORT");
	}
}
function daemonMainPath() {
	const here = dirname(fileURLToPath(import.meta.url));
	const builtLayouts = [join(here, "..", "..", "lib", "chatgpt", "daemon-main.js"), join(here, "chatgpt", "daemon-main.js")];
	for (const built of builtLayouts) if (existsSync(built)) return {
		kind: "lib",
		path: built
	};
	const src = join(here, "daemon-main.ts");
	if (existsSync(src)) return {
		kind: "tsx",
		path: src
	};
	throw new LlmError("ChatGPT Web daemon entry not found. Run `pnpm build` in dsh-llm-chatgpt-web first.", "TRANSPORT");
}
async function waitForEndpoint(profileDir, timeoutMs, child) {
	const deadline = Date.now() + timeoutMs;
	let polls = 0;
	for (;;) {
		const endpoint = readEndpoint(profileDir);
		if (endpoint) return endpoint;
		polls += 1;
		if (polls % 20 === 0) console.log(`[dsh-llm-chatgpt-web] waiting for endpoint (${Math.round((Date.now() - (deadline - timeoutMs)) / 1e3)}s) childExit=${String(child.exitCode)} childKilled=${String(child.killed)} file=${existsSync(endpointPath(profileDir)) ? "present-unreadable?" : "absent"}`);
		if (child.exitCode !== null && child.exitCode !== 0) throw new LlmError(`ChatGPT Web daemon exited during startup (code ${child.exitCode}). Run the daemon entry manually for its stderr.`, "TRANSPORT");
		if (Date.now() >= deadline) throw new LlmError("ChatGPT Web daemon did not publish its endpoint in time.", "TIMEOUT");
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
	}
}
/**
* Connect to the shared daemon browser, spawning the daemon detached when
* no live endpoint exists. Resolves with a connected browser the caller must
* NOT close (contexts and pages are caller-owned; the daemon owns the rest).
*/
async function ensureDaemonBrowser(profileDir, options) {
	const existing = readEndpoint(profileDir);
	if (existing) try {
		const browser = await chromium.connect(existing.wsEndpoint, { timeout: 1e4 });
		console.log("[dsh-llm-chatgpt-web] attaching to live daemon");
		touchEndpoint(profileDir);
		return browser;
	} catch {
		await reapStaleBrowser(existing);
	}
	console.log("[dsh-llm-chatgpt-web] spawning browser daemon");
	const main = daemonMainPath();
	console.log(`[dsh-llm-chatgpt-web] daemon entry kind=${main.kind} path=${main.path}`);
	const daemonArgs = [
		"--profile-dir",
		profileDir,
		"--idle-ms",
		String(options.idleMs),
		...options.executable ? ["--executable", options.executable] : []
	];
	const child = main.kind === "lib" ? spawn(process.execPath, [main.path, ...daemonArgs], {
		detached: true,
		stdio: "ignore"
	}) : spawn(process.execPath, [
		"--import",
		resolveTsxLoader(),
		main.path,
		...daemonArgs
	], {
		detached: true,
		stdio: "ignore"
	});
	const spawnError = await new Promise((resolve) => {
		child.once("error", (error) => resolve(error));
		setImmediate(() => resolve(void 0));
	});
	if (spawnError) throw new LlmError(`ChatGPT Web daemon failed to spawn: ${spawnError.message}`, "TRANSPORT", { cause: spawnError });
	child.unref();
	console.log(`[dsh-llm-chatgpt-web] daemon spawned pid=${child.pid ?? "unknown"}`);
	child.on("exit", (code, signal) => {
		console.log(`[dsh-llm-chatgpt-web] daemon child exit code=${code} signal=${signal}`);
	});
	const endpoint = await waitForEndpoint(profileDir, options.spawnTimeoutMs ?? 6e4, child);
	try {
		const browser = await chromium.connect(endpoint.wsEndpoint, { timeout: 15e3 });
		touchEndpoint(profileDir);
		return browser;
	} catch (error) {
		throw new LlmError("ChatGPT Web daemon started but refused connection.", "TRANSPORT", { cause: error });
	}
}
//#endregion
export { NO_STARTUP_WINDOW_ARGS as a, STEALTH_INIT_SCRIPT as c, minimizeAllWindows as d, resizeWindowsMinimized as f, DAEMON_MARKER_ARG as i, defaultProfileDir as l, ensureDaemonBrowser as n, STEALTH_ARGS as o, resolveChromeExecutable as p, touchEndpoint as r, STEALTH_IGNORE_DEFAULT_ARGS as s, endpointPath as t, hideProcess as u };
