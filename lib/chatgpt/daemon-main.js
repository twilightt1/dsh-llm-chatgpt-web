import { a as NO_STARTUP_WINDOW_ARGS, c as STEALTH_INIT_SCRIPT, d as minimizeAllWindows, f as resizeWindowsMinimized, i as DAEMON_MARKER_ARG, o as STEALTH_ARGS, p as resolveChromeExecutable, s as STEALTH_IGNORE_DEFAULT_ARGS, t as endpointPath, u as hideProcess } from "../chunks/daemon-DqpESjWr.js";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
//#region src/chatgpt/daemon-main.ts
/**
* Browser daemon entry: one headed-hidden Chromium per profile directory,
* shared by every adapter process. Spawned detached by `daemon.ts`, never by
* hand. Args: `--profile-dir <dir> --idle-ms <n> [--executable <path>]`.
*
* Lifecycle: launch → hide + minimize → write endpoint file (0600) → serve
* until the endpoint file goes untouched for `idleMs` (adapters touch it per
* turn), then exit. A stale endpoint (dead daemon) is detected client-side
* by failed connect, never by PID guessing.
* @module dsh-llm-chatgpt-web/daemon-main
*/
function parseArgs(argv) {
	let profileDir;
	let idleMs = 18e5;
	let executable;
	let headless = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--profile-dir") profileDir = argv[i + 1];
		else if (arg === "--idle-ms") idleMs = Number(argv[i + 1]);
		else if (arg === "--executable") executable = argv[i + 1];
		else if (arg === "--headless") headless = true;
	}
	if (!profileDir) throw new Error("daemon-main: --profile-dir is required");
	if (!Number.isFinite(idleMs) || idleMs < 6e4) throw new Error("daemon-main: --idle-ms must be at least 60000");
	return {
		profileDir,
		idleMs,
		executable,
		headless
	};
}
function writeEndpoint(profileDir, endpoint) {
	const path = endpointPath(profileDir);
	writeFileSync(path, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 384 });
	chmodSync(path, 384);
}
async function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.profileDir, {
		recursive: true,
		mode: 448
	});
	const executable = args.executable ?? resolveChromeExecutable();
	const server = await chromium.launchServer({
		...executable !== void 0 ? { executablePath: executable } : {},
		headless: args.headless,
		args: [
			...STEALTH_ARGS,
			...args.headless ? [] : [
				"--window-size=1,1",
				"--window-position=-32000,-32000",
				...NO_STARTUP_WINDOW_ARGS
			],
			DAEMON_MARKER_ARG
		],
		ignoreDefaultArgs: STEALTH_IGNORE_DEFAULT_ARGS
	});
	const shutdown = async () => {
		rmSync(endpointPath(args.profileDir), { force: true });
		await server.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
	hideProcess(server.process().pid);
	const browser = await chromium.connect(server.wsEndpoint());
	const context = await browser.newContext();
	await context.addInitScript({ content: STEALTH_INIT_SCRIPT });
	await context.newPage();
	await hideProcess(server.process().pid);
	await minimizeAllWindows(browser, "daemon-birth");
	if (!args.headless) await resizeWindowsMinimized(browser, "daemon-birth", 1280, 900);
	await resizeWindowsMinimized(browser, "daemon-birth", 1280, 900);
	writeEndpoint(args.profileDir, {
		wsEndpoint: server.wsEndpoint(),
		daemonPid: process.pid,
		browserPid: server.process().pid,
		startedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	console.log(`[dsh-llm-chatgpt-web] daemon ready pid=${process.pid}`);
	const path = endpointPath(args.profileDir);
	setInterval(() => {
		try {
			const mtime = statSync(path).mtimeMs;
			if (Date.now() - mtime > args.idleMs) {
				console.log("[dsh-llm-chatgpt-web] daemon idle, exiting");
				shutdown();
			}
		} catch {
			shutdown();
		}
	}, 3e4).unref?.();
}
await main().catch((error) => {
	process.stderr.write(`daemon-main: fatal ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
//#endregion
export {};
