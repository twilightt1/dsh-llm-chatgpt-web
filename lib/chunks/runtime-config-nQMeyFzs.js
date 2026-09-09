import { dirname, isAbsolute, join, resolve } from "node:path";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
export { loadManagedNativeRuntimeConfig as a, assertPrivateRegularFile as c, snapshotPrivateFile as d, ensureManagedRuntimeDirectories as i, atomicWritePrivateFile as l, defaultManagedRuntimePaths as n, parseManagedNativeRuntimeConfig as o, defaultNativeRuntimeConfigPath as r, assertPrivateDirectory as s, MANAGED_TUNNEL_CLIENT_VERSION as t, ensurePrivateDirectory as u };
