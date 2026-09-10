#!/usr/bin/env node
import { $ as hashCanonical, B as ChatGptBrowser, C as loadManagedNativeRuntimeConfig, E as createOwnedConversationLedger, I as ensurePrivateDirectory, L as inspectPrivateWriterLease, M as assertPrivateRegularFile, N as atomicWritePrivateFile, O as retryPendingConversationDeletions, P as currentProcessStartedAt, R as snapshotPrivateFile, S as ensureManagedRuntimeDirectories, _ as redactTunnelDetail, a as nativeSecuritySummaryHash, b as defaultManagedRuntimePaths, c as approveNativeChallenge, d as readNativeApprovalState, g as ManagedTunnelRuntime, j as assertPrivateDirectory, l as formatNativeApprovalChallenge, o as readNativeSecurityState, p as shellQuotePosix, t as createNativeCheckpointStore, u as readNativeApprovalChallenge, v as runCommand, w as parseManagedNativeRuntimeConfig, y as MANAGED_TUNNEL_CLIENT_VERSION } from "./chunks/checkpoint-iOkOb-Sy.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
//#region src/native/tunnel-install.ts
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${MANAGED_TUNNEL_CLIENT_VERSION}`;
const MAX_DOWNLOAD_BYTES = 104857600;
const SHA256$1 = /^[a-f0-9]{64}$/;
const RELEASE_ASSETS = {
	"darwin/amd64": {
		name: "tunnel-client-v0.0.12-darwin-amd64.zip",
		archiveSha256: "33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009"
	},
	"darwin/arm64": {
		name: "tunnel-client-v0.0.12-darwin-arm64.zip",
		archiveSha256: "42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02"
	},
	"linux/amd64": {
		name: "tunnel-client-v0.0.12-linux-amd64.zip",
		archiveSha256: "2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81"
	},
	"linux/arm64": {
		name: "tunnel-client-v0.0.12-linux-arm64.zip",
		archiveSha256: "6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6"
	}
};
function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
function normalizeArch(arch) {
	if (arch === "x64" || arch === "amd64") return "amd64";
	if (arch === "arm64") return "arm64";
	throw new Error(`unsupported tunnel-client architecture: ${arch}`);
}
function tunnelReleaseAsset(platform = process.platform, arch = process.arch) {
	if (platform !== "darwin" && platform !== "linux") throw new Error(`unsupported tunnel-client platform: ${platform}`);
	const asset = RELEASE_ASSETS[`${platform}/${normalizeArch(arch)}`];
	if (asset === void 0) throw new Error(`unsupported tunnel-client platform/architecture: ${platform}/${arch}`);
	return asset;
}
function parseReleaseChecksum(text, asset) {
	const checksum = text.split(/\r?\n/).find((candidate) => {
		const parts = candidate.trim().split(/\s+/);
		return parts.length >= 2 && parts.at(-1) === asset;
	})?.trim().split(/\s+/)[0]?.toLowerCase();
	if (checksum === void 0 || !SHA256$1.test(checksum)) throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`);
	return checksum;
}
async function fetchBytes(url, maximumBytes) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 12e4);
	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`download failed (${response.status})`);
		const contentLength = Number(response.headers.get("content-length") ?? "0");
		if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error(`download exceeds ${maximumBytes} bytes`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maximumBytes) throw new Error(`download exceeds ${maximumBytes} bytes`);
		return bytes;
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`download timed out after 120000ms: ${url}`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
function pathExistsOrSymlink$1(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}
function parseManifest(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("existing tunnel-client manifest is not an object");
	const record = value;
	if (record.version !== 1 || record.tunnelClientVersion !== "0.0.12") throw new Error("existing tunnel-client manifest has an unsupported version");
	if (typeof record.asset !== "string" || record.asset.length === 0) throw new Error("existing tunnel-client manifest has no asset");
	if (typeof record.archiveSha256 !== "string" || !SHA256$1.test(record.archiveSha256)) throw new Error("existing tunnel-client manifest has an invalid archive SHA-256");
	if (typeof record.binarySha256 !== "string" || !SHA256$1.test(record.binarySha256)) throw new Error("existing tunnel-client manifest has an invalid binary SHA-256");
	return {
		version: 1,
		tunnelClientVersion: MANAGED_TUNNEL_CLIENT_VERSION,
		asset: record.asset,
		archiveSha256: record.archiveSha256,
		binarySha256: record.binarySha256
	};
}
function validateExistingInstallation(binaryPath, manifestPath, run, expectedAsset) {
	const binaryExists = pathExistsOrSymlink$1(binaryPath);
	const manifestExists = pathExistsOrSymlink$1(manifestPath);
	if (!binaryExists && !manifestExists) return void 0;
	assertPrivateRegularFile(binaryPath, "existing tunnel-client", true);
	assertPrivateRegularFile(manifestPath, "existing tunnel-client manifest");
	let manifest;
	try {
		manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
	} catch (error) {
		throw new Error(`existing tunnel-client manifest failed integrity validation: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (manifest.asset !== expectedAsset.name || manifest.archiveSha256 !== expectedAsset.archiveSha256) throw new Error("existing tunnel-client manifest does not match the pinned release asset");
	if (digest(new Uint8Array(readFileSync(binaryPath))) !== manifest.binarySha256) throw new Error("existing tunnel-client binary hash does not match its manifest");
	const version = run(binaryPath, ["--version"], { timeoutMs: 1e4 });
	if (version.status !== 0 || !`${version.stdout}\n${version.stderr}`.includes("0.0.12")) throw new Error(`existing tunnel-client did not report version ${MANAGED_TUNNEL_CLIENT_VERSION}`);
	return manifest;
}
function noOpTransaction(binaryPath, manifest) {
	return {
		candidatePath: binaryPath,
		manifest,
		commit: () => binaryPath,
		rollback: () => {},
		finalize: () => {}
	};
}
function removeCandidate(path) {
	rmSync(path, { force: true });
}
function stagedTransaction(candidatePath, binaryPath, manifestPath, manifest) {
	let state = "staged";
	let binarySnapshot;
	let manifestSnapshot;
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	const restoreSnapshots = () => {
		const errors = [];
		try {
			manifestSnapshot?.restore();
		} catch (error) {
			errors.push(error);
		}
		try {
			binarySnapshot?.restore();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "failed to restore tunnel-client installation");
	};
	return {
		candidatePath,
		manifest,
		commit() {
			if (state === "committed" || state === "finalized") return binaryPath;
			if (state === "rolled-back") throw new Error("tunnel-client installation transaction was rolled back");
			try {
				binarySnapshot = snapshotPrivateFile(binaryPath);
				manifestSnapshot = snapshotPrivateFile(manifestPath);
				atomicWritePrivateFile(binaryPath, new Uint8Array(readFileSync(candidatePath)), 448);
				atomicWritePrivateFile(manifestPath, manifestText);
				state = "committed";
				return binaryPath;
			} catch (error) {
				try {
					restoreSnapshots();
				} catch (restoreError) {
					state = "rolled-back";
					removeCandidate(candidatePath);
					throw new AggregateError([error, restoreError], "tunnel-client installation commit and rollback failed");
				}
				state = "rolled-back";
				removeCandidate(candidatePath);
				throw error;
			}
		},
		rollback() {
			if (state === "rolled-back" || state === "finalized") return;
			if (state === "committed") restoreSnapshots();
			removeCandidate(candidatePath);
			state = "rolled-back";
		},
		finalize() {
			if (state === "finalized" || state === "rolled-back") return;
			binarySnapshot?.discard();
			manifestSnapshot?.discard();
			removeCandidate(candidatePath);
			state = "finalized";
		}
	};
}
async function stageTunnelClient(options) {
	const run = options.run ?? runCommand;
	const supportedAsset = tunnelReleaseAsset(options.platform ?? process.platform, options.arch ?? process.arch);
	const asset = options.releaseAsset ?? supportedAsset;
	const existing = validateExistingInstallation(options.binaryPath, options.manifestPath, run, asset);
	if (existing !== void 0) return noOpTransaction(options.binaryPath, existing);
	ensurePrivateDirectory(dirname(options.binaryPath));
	ensurePrivateDirectory(dirname(options.manifestPath));
	if (!asset.name.endsWith(".zip") || asset.name.includes("\n") || !SHA256$1.test(asset.archiveSha256)) throw new Error("tunnel-client release asset is invalid");
	const getBytes = options.fetchBytes ?? fetchBytes;
	const [archive, sums] = await Promise.all([getBytes(`${RELEASE_BASE}/${asset.name}`, MAX_DOWNLOAD_BYTES), getBytes(`${RELEASE_BASE}/SHA256SUMS.txt`, MAX_DOWNLOAD_BYTES)]);
	if (archive.byteLength > MAX_DOWNLOAD_BYTES || sums.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`tunnel-client download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
	const archiveHash = digest(archive);
	if (archiveHash !== asset.archiveSha256) throw new Error(`tunnel-client archive checksum mismatch for ${asset.name}`);
	if (parseReleaseChecksum(new TextDecoder().decode(sums), asset.name) !== asset.archiveSha256) throw new Error(`release checksum mismatch for ${asset.name}`);
	let files;
	try {
		files = unzipSync(archive);
	} catch (error) {
		throw new Error(`tunnel-client archive is not a valid ZIP: ${error instanceof Error ? error.message : String(error)}`);
	}
	const matches = Object.entries(files).filter(([name]) => basename(name.replaceAll("\\", "/")) === "tunnel-client");
	if (matches.length !== 1 || matches[0]?.[1].byteLength === 0) throw new Error("tunnel-client archive must contain exactly one non-empty tunnel-client binary");
	const binaryEntry = matches[0];
	if (binaryEntry === void 0) throw new Error("tunnel-client archive did not contain a binary");
	const binary = binaryEntry[1];
	const candidatePath = `${options.binaryPath}.install-${process.pid}-${randomUUID()}`;
	let manifest;
	try {
		atomicWritePrivateFile(candidatePath, binary, 448);
		const version = run(candidatePath, ["--version"], { timeoutMs: 1e4 });
		if (version.status !== 0 || !`${version.stdout}\n${version.stderr}`.includes("0.0.12")) throw new Error(`installed tunnel-client did not report version ${MANAGED_TUNNEL_CLIENT_VERSION}`);
		manifest = {
			version: 1,
			tunnelClientVersion: MANAGED_TUNNEL_CLIENT_VERSION,
			asset: asset.name,
			archiveSha256: archiveHash,
			binarySha256: digest(binary)
		};
	} catch (error) {
		removeCandidate(candidatePath);
		throw error;
	}
	return stagedTransaction(candidatePath, options.binaryPath, options.manifestPath, manifest);
}
//#endregion
//#region src/native/setup.ts
const TUNNEL_ID = /^tunnel_[a-f0-9]{32}$/;
const CONNECTOR_NAME_MAX = 80;
const PROFILE_NAME = "dsh-chatgpt-web";
const SETUP_PROFILE_NAME = "dsh-chatgpt-web-setup";
const DEFAULT_BROKER_SOCKET_NAME = "native-broker.sock";
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/;
function expandHome(value) {
	if (value === "~" || value.startsWith("~/")) return (process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".") + value.slice(1);
	return value;
}
function requiredOption(args, index, flag) {
	const value = args[index + 1];
	if (value === void 0 || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return {
		value,
		next: index + 2
	};
}
function connectorName(value) {
	if (value.length === 0 || value.trim() !== value || value.length > CONNECTOR_NAME_MAX || /[\r\n\u0000]/.test(value)) throw new Error("connector name is invalid");
	return value;
}
function profilePath(value) {
	const expanded = expandHome(value);
	if (!isAbsolute(expanded) || CONTROL_BYTES.test(expanded)) throw new Error("profile directory must be an absolute control-free path");
	return resolve(expanded);
}
function tunnelId(value) {
	if (!TUNNEL_ID.test(value)) throw new Error("Tunnel ID is invalid");
	return value;
}
function parseCommandOptions(args, command) {
	let profileDir;
	let name;
	let id;
	let keyFile;
	let challenge;
	let checkpointHash;
	let abandon = false;
	let json = false;
	const seen = /* @__PURE__ */ new Set();
	let index = 1;
	while (index < args.length) {
		const flag = args[index];
		if (flag === void 0) break;
		if (flag === "--json" && command === "doctor") {
			if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
			seen.add(flag);
			json = true;
			index += 1;
			continue;
		}
		if (flag === "--abandon") {
			if (command !== "recover") throw new Error(`${command} does not accept ${flag}`);
			if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
			seen.add(flag);
			abandon = true;
			index += 1;
			continue;
		}
		if (flag === "--checkpoint") {
			if (command !== "recover") throw new Error(`${command} does not accept ${flag}`);
			if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
			seen.add(flag);
			const option = requiredOption(args, index, flag);
			checkpointHash = option.value;
			index = option.next;
			continue;
		}
		if (flag === "--challenge") {
			if (command !== "approve") throw new Error(`${command} does not accept ${flag}`);
			if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
			seen.add(flag);
			const option = requiredOption(args, index, flag);
			challenge = option.value;
			index = option.next;
			continue;
		}
		if (flag === "--profile-dir" || flag === "--connector-name" || flag === "--tunnel-id" || flag === "--runtime-key-file") {
			if ((command === "approve" || command === "recover") && flag !== "--profile-dir") throw new Error(`${command} does not accept ${flag}`);
			if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
			seen.add(flag);
			const option = requiredOption(args, index, flag);
			if (flag === "--profile-dir") profileDir = option.value;
			else if (flag === "--connector-name") name = option.value;
			else if (flag === "--tunnel-id") id = option.value;
			else keyFile = option.value;
			index = option.next;
			continue;
		}
		throw new Error(`unknown option ${flag}`);
	}
	if (profileDir === void 0) throw new Error("--profile-dir is required");
	if (command === "recover") {
		if (checkpointHash === void 0 || !SHA256.test(checkpointHash)) throw new Error("--checkpoint is required and must be a public checkpoint hash");
		if (!abandon) throw new Error("recover requires --abandon");
		if (name !== void 0 || id !== void 0 || keyFile !== void 0 || json || challenge !== void 0) throw new Error("recover accepts only --profile-dir, --checkpoint, and --abandon");
		return {
			command,
			profileDir: profilePath(profileDir),
			checkpointHash,
			abandon: true
		};
	}
	if (command === "approve") {
		if (challenge === void 0 || challenge.length === 0 || challenge.length > 128 || CONTROL_BYTES.test(challenge)) throw new Error("--challenge is required and must be control-free");
		if (name !== void 0 || id !== void 0 || keyFile !== void 0 || json) throw new Error("approve accepts only --profile-dir and --challenge");
		return {
			command,
			profileDir: profilePath(profileDir),
			challengeId: challenge
		};
	}
	if (name === void 0) throw new Error("--connector-name is required");
	if (command === "setup") {
		if (id === void 0) throw new Error("--tunnel-id is required");
		return {
			command,
			options: {
				profileDir: profilePath(profileDir),
				connectorName: connectorName(name),
				tunnelId: tunnelId(id),
				...keyFile === void 0 ? {} : { runtimeKeyFile: profilePath(keyFile) }
			}
		};
	}
	if (id !== void 0 || keyFile !== void 0) throw new Error(`${command} does not accept tunnel or key options`);
	return {
		command,
		profileDir: profilePath(profileDir),
		connectorName: connectorName(name),
		...command === "doctor" ? { json } : {}
	};
}
function parseNativeSetupArgs(args) {
	const command = args[0];
	if (command !== "setup" && command !== "doctor" && command !== "stop" && command !== "approve" && command !== "recover") throw new Error("command must be setup, doctor, stop, approve, or recover");
	return parseCommandOptions(args, command);
}
function normalizeKeyBytes(value) {
	let end = value.byteLength;
	while (end > 0 && value[end - 1] === 10) end -= 1;
	if (end > 0 && value[end - 1] === 13) end -= 1;
	const bytes = value.slice(0, end);
	if (bytes.byteLength === 0 || bytes.byteLength > 65536) throw new Error("runtime key is empty or unexpectedly large");
	return bytes;
}
function readRuntimeKey(options) {
	if (options.runtimeKeyFile !== void 0 && options.runtimeKeyValue !== void 0) throw new Error("provide either runtimeKeyFile or runtimeKeyValue, not both");
	if (options.runtimeKeyValue !== void 0) return {
		bytes: normalizeKeyBytes(new TextEncoder().encode(options.runtimeKeyValue)),
		sourceKeyRetained: false
	};
	if (options.runtimeKeyFile === void 0) throw new Error("a runtime key file or value is required");
	const source = profilePath(options.runtimeKeyFile);
	assertPrivateRegularFile(source, "source runtime key");
	return {
		bytes: normalizeKeyBytes(new Uint8Array(readFileSync(source))),
		sourceKeyRetained: true
	};
}
function resolveMcpEntrypoint(explicit) {
	if (explicit !== void 0) {
		if (!isAbsolute(explicit)) throw new Error("MCP entrypoint must be absolute");
		return explicit;
	}
	const current = dirname(fileURLToPath(import.meta.url));
	const found = [join(current, "mcp-main.js"), join(current, "../../lib/mcp-main.js")].find((candidate) => existsSync(candidate));
	if (found === void 0) throw new Error("built lib/mcp-main.js is missing; run pnpm build first");
	return found;
}
function runtimeConfig(options) {
	return parseManagedNativeRuntimeConfig({
		version: 1,
		connectorName: options.connectorName,
		tunnelClient: {
			path: options.binaryPath,
			version: MANAGED_TUNNEL_CLIENT_VERSION,
			sha256: options.binarySha256
		},
		tunnel: {
			id: options.tunnelId,
			runtimeKeyFile: options.runtimeKeyFile,
			profileDir: options.profileDir,
			profileName: options.profileName,
			alias: options.alias
		}
	});
}
function setupBrokerSocket(profileDir) {
	return join(profileDir, DEFAULT_BROKER_SOCKET_NAME);
}
function createRuntime(dependencies, config, brokerSocketPath, mcpEntrypoint) {
	return (dependencies.createRuntime ?? ((options) => new ManagedTunnelRuntime(options)))({
		config,
		nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
		mcpEntrypoint,
		brokerSocketPath,
		...dependencies.run === void 0 ? {} : { run: dependencies.run }
	});
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
async function setupManagedNativeRuntime(options, dependencies = {}) {
	const profileDir = profilePath(options.profileDir);
	const name = connectorName(options.connectorName);
	const id = tunnelId(options.tunnelId);
	const paths = ensureManagedRuntimeDirectories(profileDir);
	const key = readRuntimeKey(options);
	const stage = dependencies.stageTunnelClient ?? stageTunnelClient;
	const mcpEntrypoint = resolveMcpEntrypoint(dependencies.mcpEntrypoint);
	const brokerSocketPath = setupBrokerSocket(profileDir);
	let transaction;
	let keySnapshot;
	let configSnapshot;
	let profileSnapshot;
	let temporaryRuntime;
	let finalRuntime;
	let temporaryProfileDir;
	try {
		transaction = await stage({
			binaryPath: paths.binaryPath,
			manifestPath: paths.manifestPath,
			...dependencies.run === void 0 ? {} : { run: dependencies.run }
		});
		keySnapshot = snapshotPrivateFile(paths.keyPath);
		configSnapshot = snapshotPrivateFile(paths.configPath);
		const provisionalProfile = join(paths.tunnelProfileDir, `${PROFILE_NAME}.yaml`);
		profileSnapshot = snapshotPrivateFile(provisionalProfile);
		atomicWritePrivateFile(paths.keyPath, key.bytes);
		temporaryProfileDir = join(paths.tunnelProfileDir, `.setup-${process.pid}-${randomUUID()}`);
		ensurePrivateDirectory(temporaryProfileDir);
		temporaryRuntime = createRuntime(dependencies, runtimeConfig({
			connectorName: name,
			tunnelId: id,
			binaryPath: transaction.candidatePath,
			binarySha256: transaction.manifest.binarySha256,
			runtimeKeyFile: paths.keyPath,
			profileDir: temporaryProfileDir,
			profileName: SETUP_PROFILE_NAME,
			alias: SETUP_PROFILE_NAME
		}), brokerSocketPath, mcpEntrypoint);
		await temporaryRuntime.start();
		await temporaryRuntime.stop();
		transaction.commit();
		const finalConfig = runtimeConfig({
			connectorName: name,
			tunnelId: id,
			binaryPath: paths.binaryPath,
			binarySha256: transaction.manifest.binarySha256,
			runtimeKeyFile: paths.keyPath,
			profileDir: paths.tunnelProfileDir,
			profileName: PROFILE_NAME,
			alias: PROFILE_NAME
		});
		finalRuntime = createRuntime(dependencies, finalConfig, brokerSocketPath, mcpEntrypoint);
		await finalRuntime.start();
		await finalRuntime.stop();
		atomicWritePrivateFile(paths.configPath, `${JSON.stringify(finalConfig, null, 2)}\n`);
		transaction.finalize();
		keySnapshot.discard();
		configSnapshot.discard();
		profileSnapshot.discard();
		if (temporaryProfileDir !== void 0) rmSync(temporaryProfileDir, {
			recursive: true,
			force: true
		});
		return {
			configPath: paths.configPath,
			connectorName: name,
			tunnelReady: true,
			connectorSetupRequired: true,
			sourceKeyRetained: key.sourceKeyRetained
		};
	} catch (error) {
		try {
			await finalRuntime?.stop();
		} catch {}
		try {
			await temporaryRuntime?.stop();
		} catch {}
		try {
			configSnapshot?.restore();
		} catch {}
		try {
			keySnapshot?.restore();
		} catch {}
		try {
			profileSnapshot?.restore();
		} catch {}
		try {
			transaction?.rollback();
		} catch {}
		if (temporaryProfileDir !== void 0) rmSync(temporaryProfileDir, {
			recursive: true,
			force: true
		});
		throw new Error(`managed native setup failed: ${redactTunnelDetail(errorMessage(error))}`);
	}
}
function pathExistsOrSymlink(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		return true;
	}
}
function digestFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function validateManifest(path, expectedHash, expectedAsset) {
	assertPrivateRegularFile(path, "managed tunnel-client manifest");
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("manifest is not an object");
	const record = value;
	if (record.version !== 1 || record.tunnelClientVersion !== "0.0.12") throw new Error("manifest version is invalid");
	if (typeof record.asset !== "string" || record.asset.length === 0) throw new Error("manifest asset is invalid");
	if (typeof record.archiveSha256 !== "string" || !SHA256.test(record.archiveSha256)) throw new Error("manifest archive hash is invalid");
	if (record.binarySha256 !== expectedHash) throw new Error("manifest binary hash does not match runtime config");
	if (expectedAsset !== void 0 && (record.asset !== expectedAsset.name || record.archiveSha256 !== expectedAsset.archiveSha256)) throw new Error("manifest does not match the pinned tunnel-client release asset");
}
function brokerState(path) {
	if (!pathExistsOrSymlink(path)) return "stopped";
	try {
		const stat = lstatSync(path);
		if (!stat.isSocket()) return "invalid";
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "invalid";
		if ((stat.mode & 511) !== 384) return "invalid";
		return "ready";
	} catch {
		return "invalid";
	}
}
const NATIVE_DOCTOR_CHECK_IDS = [
	"native.platform",
	"native.managed.binary",
	"native.runtime.config",
	"native.runtime.key",
	"native.runtime.profile",
	"native.connector.name",
	"native.connector.runtime",
	"native.workspace.root",
	"native.policy.schema",
	"native.policy.output-provenance",
	"native.approval.grant",
	"native.checkpoint.writer",
	"native.checkpoint.recovery",
	"native.cleanup.owned-conversations",
	"native.snapshot.freshness",
	"native.rollback.safe",
	"native.managed.process",
	"native.broker.socket"
];
function doctorCheck(id, status, summary, action) {
	return {
		id,
		status,
		summary,
		...action === void 0 ? {} : { action }
	};
}
function nativeAction(profileDir, command, ...argumentsValue) {
	try {
		return [
			"dsh-chatgpt-web-native",
			command,
			"--profile-dir",
			shellQuotePosix(profileDir),
			...argumentsValue.map((value) => shellQuotePosix(value))
		].join(" ");
	} catch {
		return;
	}
}
function escapeTerminalControls(value) {
	return value.replace(/[\u007f-\u009f\u2028\u2029]/g, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}
function terminalQuote(value) {
	return escapeTerminalControls(JSON.stringify(value));
}
function safeJson(value) {
	return escapeTerminalControls(JSON.stringify(value, null, 2));
}
function processIdentityIsLive(pid, startedAt) {
	if (pid === process.pid) return startedAt === currentProcessStartedAt();
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return false;
	}
}
function validPathPointer(pointer) {
	if (pointer === "") return true;
	if (!pointer.startsWith("/")) return false;
	for (let index = 0; index < pointer.length; index += 1) if (pointer[index] === "~" && pointer[index + 1] !== "0" && pointer[index + 1] !== "1") return false;
	return true;
}
function publicTunnelStatus(status) {
	return {
		ok: status.ok,
		processRunning: status.processRunning,
		healthy: status.healthy,
		ready: status.ready,
		detail: status.ok ? "managed tunnel is running and ready" : "managed tunnel is stopped or not ready"
	};
}
function invalidProfileDoctorReport() {
	return {
		version: 2,
		ok: false,
		config: "invalid",
		binary: "missing",
		key: "missing",
		profile: "missing",
		runtime: { state: "stopped" },
		broker: "invalid",
		issues: ["profile directory is invalid"],
		checks: NATIVE_DOCTOR_CHECK_IDS.map((id) => doctorCheck(id, id === "native.platform" ? "ok" : "error", id === "native.platform" ? "native MCP platform is supported" : "profile directory is invalid"))
	};
}
function doctorManagedNativeRuntime(options) {
	let profileDir;
	try {
		profileDir = profilePath(options.profileDir);
	} catch {
		return invalidProfileDoctorReport();
	}
	const checks = [];
	const configPath = defaultManagedRuntimePaths(profileDir).configPath;
	let config;
	let configStatus = "missing";
	if (!pathExistsOrSymlink(configPath)) configStatus = "missing";
	else try {
		assertPrivateRegularFile(configPath, "managed runtime config");
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		const candidate = parseManagedNativeRuntimeConfig(parsed);
		if (candidate.connectorName !== options.connectorName) throw new Error("connector name mismatch");
		config = candidate;
		configStatus = "ok";
	} catch {
		configStatus = "invalid";
	}
	let binary = "missing";
	let key = "missing";
	let profile = "missing";
	let runtime = { state: "stopped" };
	let expectedAsset;
	try {
		expectedAsset = tunnelReleaseAsset();
		checks.push(doctorCheck("native.platform", "ok", "native MCP platform and architecture are supported"));
	} catch {
		checks.push(doctorCheck("native.platform", "error", "native MCP platform or architecture is unsupported"));
	}
	if (config !== void 0) {
		try {
			assertPrivateRegularFile(config.tunnelClient.path, "managed tunnel client", true);
			if (digestFile(config.tunnelClient.path) !== config.tunnelClient.sha256) throw new Error("binary hash mismatch");
			validateManifest(join(dirname(config.tunnelClient.path), "tunnel-client-manifest.json"), config.tunnelClient.sha256, expectedAsset);
			binary = "ok";
		} catch {
			binary = pathExistsOrSymlink(config.tunnelClient.path) ? "invalid" : "missing";
		}
		try {
			assertPrivateRegularFile(config.tunnel.runtimeKeyFile, "managed runtime key");
			key = "ok";
		} catch {
			key = pathExistsOrSymlink(config.tunnel.runtimeKeyFile) ? "invalid" : "missing";
		}
		try {
			assertPrivateDirectory(config.tunnel.profileDir, "managed tunnel profile directory");
			profile = "ok";
		} catch {
			profile = "missing";
		}
		if (binary === "ok" && key === "ok" && profile === "ok") try {
			runtime = publicTunnelStatus(new ManagedTunnelRuntime({
				config,
				nodeExecutable: process.execPath,
				mcpEntrypoint: resolveMcpEntrypoint(void 0),
				brokerSocketPath: options.brokerSocketPath ?? setupBrokerSocket(profileDir),
				...options.run === void 0 ? {} : { run: options.run }
			}).status());
		} catch {
			runtime = { state: "stopped" };
		}
	}
	const broker = brokerState(options.brokerSocketPath ?? setupBrokerSocket(profileDir));
	let snapshot;
	let snapshotError = false;
	try {
		snapshot = readNativeSecurityState(profileDir);
	} catch {
		snapshotError = true;
	}
	let approval;
	let approvalError = false;
	try {
		approval = readNativeApprovalState(profileDir);
	} catch {
		approvalError = true;
	}
	let checkpointSummaries = [];
	let checkpointError = false;
	try {
		checkpointSummaries = createNativeCheckpointStore(profileDir).inspect();
	} catch {
		checkpointError = true;
	}
	let ownedConversationCount = 0;
	let ownershipError = false;
	try {
		ownedConversationCount = createOwnedConversationLedger(profileDir).pending().length;
	} catch {
		ownershipError = true;
	}
	const configSummary = configStatus === "ok" ? "managed runtime configuration is valid" : configStatus === "missing" ? "managed runtime configuration is missing" : "managed runtime configuration is invalid";
	checks.push(doctorCheck("native.runtime.config", configStatus === "ok" ? "ok" : "error", configSummary));
	const binarySummary = binary === "ok" ? "managed tunnel-client binary and pinned manifest are valid" : binary === "missing" ? "managed tunnel-client binary is missing" : "managed tunnel-client binary or manifest is invalid";
	checks.push(doctorCheck("native.managed.binary", binary === "ok" ? "ok" : "error", binarySummary));
	checks.push(doctorCheck("native.runtime.key", key === "ok" ? "ok" : "error", key === "ok" ? "managed runtime key is private and readable" : key === "missing" ? "managed runtime key is missing" : "managed runtime key is invalid"));
	checks.push(doctorCheck("native.runtime.profile", profile === "ok" ? "ok" : "error", profile === "ok" ? "managed tunnel profile directory is private and readable" : "managed tunnel profile directory is missing or invalid"));
	const connectorMatches = config?.connectorName === options.connectorName && (snapshot === void 0 || snapshot.summary.connectorName === options.connectorName);
	checks.push(doctorCheck("native.connector.name", connectorMatches ? "ok" : "error", connectorMatches ? "connector name matches the managed configuration" : "connector name does not match the managed configuration"));
	const connectorRuntime = snapshot?.summary.connectorRuntime;
	checks.push(doctorCheck("native.connector.runtime", snapshot === void 0 ? "warning" : connectorRuntime === "managed" ? "ok" : "warning", snapshot === void 0 ? "connector runtime identity is unavailable until a request is prepared" : connectorRuntime === "managed" ? "connector runtime identity is managed" : "last prepared connector runtime identity is external"));
	if (snapshot === void 0) checks.push(doctorCheck("native.workspace.root", "warning", "workspace root is unavailable until a request is prepared"));
	else checks.push(doctorCheck("native.workspace.root", snapshot.summary.workspaceRootSource === "process.cwd" ? "warning" : "ok", snapshot.summary.workspaceRootSource === "process.cwd" ? "workspace root falls back to process.cwd; configure nativeSecurity.workspaceRoot explicitly" : "workspace root is explicitly configured"));
	let policySchemaStatus = snapshotError ? "error" : snapshot === void 0 ? "warning" : "ok";
	let policySchemaSummary = snapshotError ? "security-state snapshot is malformed or unsafe" : snapshot === void 0 ? "policy schema is unavailable until a request is prepared" : "policy schema and tool inventory are valid";
	if (snapshot !== void 0) {
		const tools = snapshot.summary.tools;
		const duplicate = new Set(tools.map((tool) => tool.tool)).size !== tools.length;
		const invalidTool = tools.some((tool) => tool.schemaHash === void 0 || !SHA256.test(tool.schemaHash) || tool.pathArguments.some((pointer) => !validPathPointer(pointer)));
		const secureViolation = snapshot.summary.toolPolicy !== "full" && tools.some((tool) => tool.capability === "full-unrestricted" || tool.result === "raw-unbounded" || tool.outputProvenance === "unverified-full");
		if (duplicate || invalidTool || secureViolation || snapshot.summary.policyImplementationVersion !== "0.7.0") {
			policySchemaStatus = "error";
			policySchemaSummary = "policy implementation, schema hashes, paths, or capability restrictions are invalid";
		}
	}
	checks.push(doctorCheck("native.policy.schema", policySchemaStatus, policySchemaSummary));
	let provenanceStatus = snapshotError ? "error" : snapshot === void 0 ? "warning" : "ok";
	let provenanceSummary = snapshotError ? "output-provenance state could not be read safely" : snapshot === void 0 ? "output provenance is unavailable until a request is prepared" : "tool output provenance is operator-declared";
	if (snapshot !== void 0 && snapshot.summary.tools.some((tool) => tool.outputProvenance === "unverified-full")) {
		provenanceStatus = "warning";
		provenanceSummary = "full-mode tool output is unverified; evidence-only or allowlist mode is safer";
	}
	checks.push(doctorCheck("native.policy.output-provenance", provenanceStatus, provenanceSummary));
	let approvalStatus;
	let approvalSummary;
	let approvalAction;
	if (approvalError) {
		approvalStatus = "error";
		approvalSummary = "native approval state is malformed or unsafe";
	} else if (snapshot === void 0) {
		approvalStatus = approval?.grant === void 0 && approval?.challenge === void 0 ? "warning" : "error";
		approvalSummary = approvalStatus === "warning" ? "approval state is unavailable until a request is prepared" : "approval state cannot be matched without a prepared policy snapshot";
	} else if (snapshot.summary.approval === "none" || snapshot.summary.tools.length === 0) {
		approvalStatus = approval?.grant === void 0 && approval?.challenge === void 0 ? "ok" : "warning";
		approvalSummary = approvalStatus === "ok" ? "no native approval grant is required" : "approval files exist for a policy with no effective tools";
	} else if (approval?.grant === void 0) {
		approvalStatus = "error";
		approvalSummary = "effective native policy grant is missing or expired";
		approvalAction = approval?.challenge === void 0 ? void 0 : nativeAction(profileDir, "approve", "--challenge", approval.challenge.challengeId);
	} else if (approval.grant.approvalHash !== snapshot.approvalHash || approval.grant.summaryHash !== nativeSecuritySummaryHash(snapshot.summary)) {
		approvalStatus = "error";
		approvalSummary = "effective native policy grant does not match the prepared policy";
	} else if (approval.claimCount !== 0 || approval.challenge !== void 0) {
		approvalStatus = "warning";
		approvalSummary = "native approval contains a pending or abandoned claim";
	} else {
		approvalStatus = "ok";
		approvalSummary = "effective native policy grant matches the prepared policy";
	}
	checks.push(doctorCheck("native.approval.grant", approvalStatus, approvalSummary, approvalAction));
	const writer = inspectPrivateWriterLease(profileDir);
	const writerStatus = writer.state === "invalid" || writer.state === "ambiguous" ? "error" : writer.state === "live" || writer.state === "stale" ? "warning" : "ok";
	checks.push(doctorCheck("native.checkpoint.writer", writerStatus, writer.state === "missing" ? "checkpoint writer lease is not held" : writer.state === "live" ? "checkpoint writer lease is held by a live runtime" : writer.state === "stale" ? "checkpoint writer lease is stale and requires a safe reclaim" : "checkpoint writer lease is invalid or ambiguous"));
	const nonTerminal = checkpointSummaries.filter((item) => !item.terminal);
	const unresolvedReplay = nonTerminal.some((item) => item.replayConsumed);
	const recoveryStatus = checkpointError || unresolvedReplay || nonTerminal.length > 0 ? "error" : "ok";
	const recoverySummary = checkpointError ? "checkpoint journals are malformed or unsafe" : nonTerminal.length === 0 ? "all checkpoint journals are terminal" : `${nonTerminal.length} checkpoint journal(s) require recovery; replay safety is blocked`;
	const recoveryAction = nonTerminal[0] === void 0 ? void 0 : nativeAction(profileDir, "recover", "--checkpoint", nonTerminal[0].checkpointHash, "--abandon");
	checks.push(doctorCheck("native.checkpoint.recovery", recoveryStatus, recoverySummary, recoveryAction));
	const cleanupStatus = ownershipError ? "error" : ownedConversationCount === 0 ? "ok" : "error";
	checks.push(doctorCheck("native.cleanup.owned-conversations", cleanupStatus, ownershipError ? "owned-conversation ledger is malformed or unsafe" : ownedConversationCount === 0 ? "owned-conversation cleanup ledger is empty" : "owned-conversation cleanup is pending"));
	let snapshotStatus;
	let snapshotSummary;
	if (snapshotError) {
		snapshotStatus = "error";
		snapshotSummary = "security-state snapshot is malformed or unsafe";
	} else if (snapshot === void 0) {
		snapshotStatus = "warning";
		snapshotSummary = "security-state snapshot is missing; no prior success is assumed";
	} else {
		const age = Date.now() - Date.parse(snapshot.generatedAt);
		const fresh = age >= 0 && age <= 864e5 && processIdentityIsLive(snapshot.runtimeProcess.pid, snapshot.runtimeProcess.startedAt);
		snapshotStatus = fresh ? "ok" : "warning";
		snapshotSummary = fresh ? "security-state snapshot matches a live runtime process" : "security-state snapshot is stale and cannot establish current readiness";
	}
	checks.push(doctorCheck("native.snapshot.freshness", snapshotStatus, snapshotSummary));
	const runtimeOffline = configStatus === "missing" || "ok" in runtime && runtime.processRunning === false;
	const allTerminal = !checkpointError && checkpointSummaries.every((item) => item.terminal);
	const rollbackSafe = runtimeOffline && writer.state === "missing" && allTerminal && !unresolvedReplay && !ownershipError && ownedConversationCount === 0;
	checks.push(doctorCheck("native.rollback.safe", rollbackSafe ? "ok" : "warning", rollbackSafe ? "safe rollback preconditions are satisfied while offline" : "rollback is unsafe until the runtime is offline, the writer is free, checkpoints are terminal, replay is resolved, and cleanup is empty"));
	const processStatus = config === void 0 ? "error" : "ok" in runtime && runtime.ok ? "ok" : "warning";
	checks.push(doctorCheck("native.managed.process", processStatus, config === void 0 ? "managed process state is unavailable without runtime configuration" : "ok" in runtime && runtime.ok ? "managed tunnel is running and ready" : "managed tunnel is stopped or not ready"));
	checks.push(doctorCheck("native.broker.socket", broker === "ready" ? "ok" : broker === "stopped" ? "warning" : "error", broker === "ready" ? "private broker socket is ready" : broker === "stopped" ? "private broker socket is stopped" : "broker socket is invalid"));
	const issues = checks.filter((check) => check.status !== "ok").map((check) => check.summary);
	return {
		version: 2,
		ok: checks.every((check) => check.status === "ok"),
		config: configStatus,
		binary,
		key,
		profile,
		runtime,
		broker,
		issues,
		checks
	};
}
async function abandonNativeCheckpoint(profileDir, checkpointHash) {
	const resolvedProfileDir = profilePath(profileDir);
	const store = createNativeCheckpointStore(resolvedProfileDir);
	const lease = store.acquire();
	let browser;
	let page;
	let failure;
	try {
		if (store.abandon === void 0 || store.prepareRecoveryCleanup === void 0 || store.confirmRecoveryCleanup === void 0) throw new Error("native checkpoint abandonment is unavailable");
		store.abandon(checkpointHash);
		const ledger = createOwnedConversationLedger(resolvedProfileDir);
		const pending = ledger.pending();
		if (pending.length !== 0) {
			if (pending.length !== 1) throw new Error("native checkpoint abandonment requires exactly one owned conversation");
			store.prepareRecoveryCleanup(checkpointHash);
			browser = new ChatGptBrowser({
				profileDir: resolvedProfileDir,
				chromeExecutablePath: void 0,
				headed: false,
				offscreen: true,
				loginTimeoutMs: 6e5,
				daemonIdleMs: 18e5
			});
			await browser.ensureReady();
			page = await browser.newTurnPage();
			await retryPendingConversationDeletions(page, ledger);
			if (ledger.pending().length !== 0) throw new Error("native checkpoint ownership cleanup remained pending");
			store.confirmRecoveryCleanup(checkpointHash, hashCanonical("native-ledger-correlation", 1, pending[0]));
			store.abandon(checkpointHash);
		}
		const remaining = store.inspect().find((summary) => summary.checkpointHash === checkpointHash);
		if (remaining !== void 0 && !remaining.terminal) throw new Error("native checkpoint abandonment remains blocked; exact cleanup could not be confirmed");
	} catch (error) {
		failure = error;
	}
	try {
		await page?.close();
	} catch (error) {
		failure ??= error;
	}
	try {
		await browser?.close();
	} catch (error) {
		failure ??= error;
	}
	try {
		lease.release();
	} catch (error) {
		failure ??= error;
	}
	if (failure !== void 0) throw failure;
}
async function stopManagedNativeRuntime(options) {
	const profileDir = profilePath(options.profileDir);
	const configPath = defaultManagedRuntimePaths(profileDir).configPath;
	if (!pathExistsOrSymlink(configPath)) return;
	const config = loadManagedNativeRuntimeConfig(configPath, { connectorName: options.connectorName });
	await new ManagedTunnelRuntime({
		config,
		nodeExecutable: process.execPath,
		mcpEntrypoint: resolveMcpEntrypoint(void 0),
		brokerSocketPath: setupBrokerSocket(profileDir)
	}).stop();
}
function formatNativeDoctorReport(report, json) {
	if (json) return `${safeJson(report)}\n`;
	return [
		`managed native runtime: ${report.ok ? "ok" : "not ready"}`,
		`config=${report.config} binary=${report.binary} key=${report.key} profile=${report.profile}`,
		`runtime=${"ok" in report.runtime ? report.runtime.ok ? "ready" : "not-ready" : report.runtime.state}`,
		`broker=${report.broker}`,
		...report.checks.map((check) => [`check ${check.id}: ${check.status} ${terminalQuote(check.summary)}`, ...check.action === void 0 ? [] : [`  action: ${terminalQuote(check.action)}`]].join("\n")),
		...report.issues.map((issue) => `issue: ${terminalQuote(issue)}`)
	].join("\n") + "\n";
}
//#endregion
//#region src/native/setup-main.ts
function defaultIo() {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr
	};
}
function readHiddenRuntimeKey(io) {
	const stdin = io.stdin;
	if (stdin.isTTY !== true || stdin.setRawMode === void 0) throw new Error("runtime key prompt requires an interactive TTY; pass --runtime-key-file");
	return new Promise((resolveKey, reject) => {
		let value = "";
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			stdin.setRawMode?.(false);
			stdin.removeListener("data", onData);
			stdin.removeListener("error", onError);
			stdin.pause();
			const result = value;
			value = "";
			if (error !== void 0) reject(error);
			else resolveKey(result);
		};
		const onError = (error) => finish(error);
		const onData = (chunk) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const character of text) {
				if (character === "") {
					finish(/* @__PURE__ */ new Error("runtime key prompt cancelled"));
					return;
				}
				if (character === "\r" || character === "\n") {
					finish();
					return;
				}
				if (character === "\b" || character === "") value = value.slice(0, -1);
				else value += character;
			}
		};
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.on("data", onData);
		stdin.once("error", onError);
	});
}
function readApprovalConfirmation(io) {
	const stdin = io.stdin;
	const setRawMode = stdin.setRawMode;
	if (stdin.isTTY !== true || setRawMode === void 0) throw new Error("native approval requires an interactive TTY");
	const enableRawMode = setRawMode.bind(stdin);
	return new Promise((resolveConfirmation, reject) => {
		let value = "";
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			stdin.setRawMode?.(false);
			stdin.removeListener("data", onData);
			stdin.removeListener("error", onError);
			stdin.pause();
			const result = value;
			value = "";
			if (error !== void 0) reject(error);
			else resolveConfirmation(result);
		};
		const onError = (error) => finish(error);
		const onData = (chunk) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const character of text) {
				if (character === "") {
					finish(/* @__PURE__ */ new Error("native approval prompt cancelled"));
					return;
				}
				if (character === "\r" || character === "\n") {
					finish();
					return;
				}
				if (character === "\b" || character === "") value = value.slice(0, -1);
				else value += character;
			}
		};
		enableRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		stdin.once("error", onError);
	});
}
async function runDshNativeSetupMain(args, io = defaultIo()) {
	try {
		const command = parseNativeSetupArgs(args);
		if (command.command === "setup") {
			const result = await setupManagedNativeRuntime(await (command.options.runtimeKeyFile === void 0 ? (() => {
				io.stdout.write("Runtime key (hidden): ");
				return readHiddenRuntimeKey(io).then((value) => ({
					...command.options,
					runtimeKeyValue: value
				}));
			})() : Promise.resolve(command.options)));
			io.stdout.write(`Managed native runtime ready for connector ${JSON.stringify(result.connectorName)}.\nCreate or attach the exact ChatGPT Personalized connector; setup does not change account settings.
`);
			return 0;
		}
		if (command.command === "doctor") {
			const report = doctorManagedNativeRuntime(command);
			io.stdout.write(formatNativeDoctorReport(report, command.json));
			return report.ok ? 0 : 1;
		}
		if (command.command === "recover") {
			if (io.stdin.isTTY !== true) throw new Error("native recovery requires an interactive TTY");
			io.stdout.write(`Abandon checkpoint ${JSON.stringify(command.checkpointHash)}? Type abandon: `);
			if (await readApprovalConfirmation(io) !== "abandon") throw new Error("native recovery requires the exact confirmation \"abandon\"");
			await abandonNativeCheckpoint(command.profileDir, command.checkpointHash);
			io.stdout.write("Native checkpoint marked abandoned.\n");
			return 0;
		}
		if (command.command === "approve") {
			if (io.stdin.isTTY !== true) throw new Error("native approval requires an interactive TTY");
			const challenge = readNativeApprovalChallenge(command.profileDir);
			if (challenge === void 0) throw new Error("native approval challenge is missing or already claimed");
			io.stdout.write(formatNativeApprovalChallenge(challenge));
			io.stdout.write("Confirmation: ");
			const confirmation = await readApprovalConfirmation(io);
			approveNativeChallenge({
				profileDir: command.profileDir,
				challengeId: command.challengeId,
				confirmation
			});
			io.stdout.write("Native policy approval recorded.\n");
			return 0;
		}
		await stopManagedNativeRuntime(command);
		io.stdout.write("Managed native tunnel stopped.\n");
		return 0;
	} catch (error) {
		io.stderr.write(`dsh-chatgpt-web-native: ${redactTunnelDetail(error instanceof Error ? error.message : error)}\n`);
		return 1;
	}
}
if ((process.argv[1] === void 0 ? "" : realpathSync(resolve(process.argv[1]))) === realpathSync(fileURLToPath(import.meta.url))) runDshNativeSetupMain(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
//#endregion
export { readHiddenRuntimeKey, runDshNativeSetupMain };
