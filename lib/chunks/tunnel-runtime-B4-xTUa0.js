import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
//#region src/native/private-files.ts
function errorCode(error) {
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
		if (errorCode(error) === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
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
		if (errorCode(error) === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
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
		if (errorCode(error) !== "ENOENT") throw error;
		mkdirSync(path, {
			recursive: true,
			mode: 448
		});
	}
	assertPrivateDirectory(path);
}
function assertReplaceableTarget(path) {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`private file must not be a symlink: ${path}`);
		if (!stat.isFile()) throw new Error(`private file is not a regular file: ${path}`);
		assertCurrentUser(stat, "private file");
		if ((stat.mode & 63) !== 0) throw new Error(`private file has unsafe permissions: ${path}`);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}
function atomicWritePrivateFile(path, data, mode = 384) {
	ensurePrivateDirectory(dirname(path));
	assertReplaceableTarget(path);
	const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
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
		if (errorCode(error) === "ENOENT") return;
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
		if (errorCode(error) !== "ENOENT") throw error;
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
function isRecord(value) {
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
	if (!isRecord(value)) throw new Error("managed runtime config must be an object");
	if (value.version !== 1) throw new Error("managed runtime config version must be 1");
	if (!isRecord(value.tunnelClient)) throw new Error("managed runtime tunnelClient must be an object");
	if (!isRecord(value.tunnel)) throw new Error("managed runtime tunnel must be an object");
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
export { runCommand as a, defaultNativeRuntimeConfigPath as c, parseManagedNativeRuntimeConfig as d, assertPrivateDirectory as f, snapshotPrivateFile as g, ensurePrivateDirectory as h, redactTunnelDetail as i, ensureManagedRuntimeDirectories as l, atomicWritePrivateFile as m, ManagedRuntimeTransportError as n, MANAGED_TUNNEL_CLIENT_VERSION as o, assertPrivateRegularFile as p, ManagedTunnelRuntime as r, defaultManagedRuntimePaths as s, ManagedRuntimeConfigurationError as t, loadManagedNativeRuntimeConfig as u };
