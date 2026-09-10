import { r as NativeSafetyError, t as NativeApprovalRequiredError } from "./errors-cqWy_ojP.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { chmodSync, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
function isRecord$1(value) {
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
	if (!isRecord$1(value)) throw new Error("managed runtime config must be an object");
	if (value.version !== 1) throw new Error("managed runtime config version must be 1");
	if (!isRecord$1(value.tunnelClient)) throw new Error("managed runtime tunnelClient must be an object");
	if (!isRecord$1(value.tunnel)) throw new Error("managed runtime tunnel must be an object");
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
//#region src/native/canonical.ts
const CONTROL_BYTES$1 = /[\u0000-\u001f\u007f]/;
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
	if (domain.length === 0 || CONTROL_BYTES$1.test(domain)) throw new TypeError("native canonical hash domain must be non-empty and control-free");
	if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("native canonical hash version must be a non-negative safe integer");
	const payload = canonicalJson(value);
	return createHash("sha256").update(`${domain}\u0000${version}\u0000${Buffer.byteLength(payload, "utf8")}\u0000`).update(payload).digest("hex");
}
//#endregion
//#region src/native/grants.ts
const APPROVAL_VERSION = 1;
const APPROVAL_TTL_MS = 6e5;
const APPROVAL_DIRECTORY = "native-approval";
const PENDING_FILE = "pending.json";
const GRANT_FILE = "grant.json";
const CHALLENGE_ID = /^challenge_[0-9a-f-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_APPROVAL_FILE_BYTES = 1048576;
const MAX_CLAIM_FILES = 8;
const CLAIM_FILE = /^\.pending-claim-([0-9]+)-([0-9a-f-]{36})$/;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
	const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error("native approval record has an invalid key set");
}
function text(value, field, max = 1e3) {
	if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL_BYTES.test(value)) throw new Error(`native approval ${field} is invalid`);
	return value;
}
function hash(value, field) {
	const candidate = text(value, field, 64);
	if (!HASH.test(candidate)) throw new Error(`native approval ${field} is invalid`);
	return candidate;
}
function instant(value, field) {
	const candidate = text(value, field, 32);
	const milliseconds = Date.parse(candidate);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== candidate) throw new Error(`native approval ${field} is invalid`);
	return candidate;
}
function summary(value) {
	if (!isRecord(value)) throw new Error("native approval summary is invalid");
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
	if (value.toolPolicy !== "full" && value.toolPolicy !== "evidence-only" && value.toolPolicy !== "allowlist") throw new Error("native approval summary tool policy is invalid");
	if (value.workspaceRootSource !== "explicit" && value.workspaceRootSource !== "process.cwd") throw new Error("native approval summary workspace root source is invalid");
	if (value.connectorRuntime !== "external" && value.connectorRuntime !== "managed") throw new Error("native approval summary connector runtime is invalid");
	if (value.approval !== "none" && value.approval !== "workspace-policy") throw new Error("native approval summary approval mode is invalid");
	const policyImplementationVersion = value.policyImplementationVersion === void 0 ? void 0 : text(value.policyImplementationVersion, "policy implementation version", 128);
	const workspaceRoot = text(value.workspaceRoot, "workspace root", 4096);
	const connectorName = text(value.connectorName, "connector name", 256);
	if (!Array.isArray(value.tools)) throw new Error("native approval summary tools are invalid");
	const tools = value.tools.map((toolValue) => {
		if (!isRecord(toolValue)) throw new Error("native approval summary tool is invalid");
		exactKeys(toolValue, [
			"tool",
			"capability",
			"pathArguments",
			"result",
			"outputProvenance"
		], ["schemaHash"]);
		const tool = text(toolValue.tool, "tool name", 256);
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
	if (!isRecord(value.evidenceLimits)) throw new Error("native approval summary evidence limits are invalid");
	exactKeys(value.evidenceLimits, ["maxBytes", "maxLines"]);
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
	if (!isRecord(value)) throw new Error("native approval pending record is invalid");
	exactKeys(value, [
		"version",
		"challengeId",
		"approvalHash",
		"createdAt",
		"expiresAt",
		"summary"
	]);
	if (value.version !== APPROVAL_VERSION) throw new Error("native approval pending version is invalid");
	const challengeId = text(value.challengeId, "challenge id", 128);
	if (!CHALLENGE_ID.test(challengeId)) throw new Error("native approval challenge id is invalid");
	const createdAt = instant(value.createdAt, "createdAt");
	const expiresAt = instant(value.expiresAt, "expiresAt");
	if (Date.parse(expiresAt) - Date.parse(createdAt) !== APPROVAL_TTL_MS) throw new Error("native approval challenge lifetime is invalid");
	return Object.freeze({
		version: APPROVAL_VERSION,
		challengeId,
		approvalHash: hash(value.approvalHash, "approval hash"),
		createdAt,
		expiresAt,
		summary: summary(value.summary)
	});
}
function parseGrant(value) {
	if (!isRecord(value)) throw new Error("native approval grant record is invalid");
	exactKeys(value, [
		"version",
		"approvalHash",
		"approvedAt",
		"summaryHash"
	]);
	if (value.version !== APPROVAL_VERSION) throw new Error("native approval grant version is invalid");
	return Object.freeze({
		version: APPROVAL_VERSION,
		approvalHash: hash(value.approvalHash, "approval hash"),
		approvedAt: instant(value.approvedAt, "approvedAt"),
		summaryHash: hash(value.summaryHash, "summary hash")
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
	if (typeof value !== "string" || CONTROL_BYTES.test(value) || !isAbsolute(value)) throw new NativeSafetyError("native approval profile directory must be an absolute control-free path", void 0, "NATIVE_APPROVAL_STATE");
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
function clock(now) {
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
		const current = clock(now);
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
	const current = clock(input.now);
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
	if (typeof value !== "string" || CONTROL_BYTES.test(value)) throw new NativeSafetyError("native approval command value contains a control byte", void 0, "NATIVE_APPROVAL_STATE");
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
//#endregion
export { ensurePrivateDirectory as C, durableAtomicWritePrivateFile as S, syncPrivateDirectory as T, loadManagedNativeRuntimeConfig as _, shellQuotePosix as a, assertPrivateRegularFile as b, ManagedRuntimeConfigurationError as c, redactTunnelDetail as d, runCommand as f, ensureManagedRuntimeDirectories as g, defaultNativeRuntimeConfigPath as h, requireNativeApproval as i, ManagedRuntimeTransportError as l, defaultManagedRuntimePaths as m, formatNativeApprovalChallenge as n, canonicalJson as o, MANAGED_TUNNEL_CLIENT_VERSION as p, readNativeApprovalChallenge as r, hashCanonical as s, approveNativeChallenge as t, ManagedTunnelRuntime as u, parseManagedNativeRuntimeConfig as v, snapshotPrivateFile as w, atomicWritePrivateFile as x, assertPrivateDirectory as y };
