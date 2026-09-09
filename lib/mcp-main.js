#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createConnection } from "node:net";
//#region src/native/broker-socket.ts
const MAX_LINE_BYTES = 67108864;
const DEFAULT_RPC_TIMEOUT_MS = 3e4;
function rpcId() {
	return `rpc_${randomBytes(12).toString("base64url")}`;
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function abortError(message) {
	return new DOMException(message, "AbortError");
}
function timeoutError(message) {
	const error = new Error(message);
	error.name = "TimeoutError";
	return error;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Create an RPC client with one isolated connection per operation. */
function createBrokerRpcClient(socketPath) {
	const call = async (method, fields, signal, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) => {
		const id = rpcId();
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("native broker RPC timeout must be positive");
		return await new Promise((resolve, reject) => {
			const socket = createConnection(socketPath);
			let settled = false;
			let sent = false;
			let buffered = "";
			const timer = setTimeout(() => {
				finishReject(timeoutError(`native broker RPC timed out after ${timeoutMs}ms`));
				socket.destroy();
			}, timeoutMs);
			timer.unref?.();
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				socket.removeAllListeners();
			};
			const finishResolve = (value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			const finishReject = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onAbort = () => {
				finishReject(abortError("native broker RPC aborted"));
				socket.destroy();
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.setEncoding("utf8");
			socket.once("connect", () => {
				sent = true;
				socket.write(`${JSON.stringify({
					id,
					method,
					...fields
				})}\n`);
			});
			socket.on("data", (chunk) => {
				if (settled) return;
				buffered += chunk;
				if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
					finishReject(/* @__PURE__ */ new Error("native broker response line is too large"));
					socket.destroy();
					return;
				}
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				const line = buffered.slice(0, newline);
				let response;
				try {
					const parsed = JSON.parse(line);
					if (!isRecord(parsed) || parsed.id !== id) throw new Error("native broker RPC response id mismatch");
					if (Object.hasOwn(parsed, "result") === Object.hasOwn(parsed, "error")) throw new Error("native broker RPC response must contain exactly one result or error");
					response = parsed;
				} catch (error) {
					finishReject(new Error(errorMessage(error)));
					socket.destroy();
					return;
				}
				if (response.error !== void 0) finishReject(new Error(response.error));
				else finishResolve(response.result);
				socket.destroy();
			});
			socket.once("error", (error) => {
				finishReject(error instanceof Error ? error : new Error(String(error)));
			});
			socket.once("close", () => {
				if (!settled && sent) finishReject(/* @__PURE__ */ new Error("native broker socket closed before its response"));
			});
		});
	};
	const release = async (requestId) => {
		await call("release", { request_id: requestId }, void 0, 5e3).then(() => void 0);
	};
	return {
		async start(requestId, signal) {
			const result = await call("start", { request_id: requestId }, signal);
			if (result.started !== true || typeof result.duplicate !== "boolean") throw new Error("native broker start response is invalid");
			return {
				started: true,
				duplicate: result.duplicate
			};
		},
		async claim(requestId, activityId, signal) {
			const result = await call("claim", {
				request_id: requestId,
				activity_id: activityId
			}, signal);
			if (!isRecord(result) || typeof result.sessionId !== "string" || !Array.isArray(result.tools) || !Number.isSafeInteger(result.invocationTimeoutMs)) throw new Error("native broker claim response is invalid");
			return result;
		},
		async completeActivity(requestId, activityId) {
			await call("activity_complete", {
				request_id: requestId,
				activity_id: activityId
			});
		},
		async invoke(requestId, activityId, name, args, timeoutMs, signal) {
			try {
				const result = await call("invoke", {
					request_id: requestId,
					activity_id: activityId,
					name,
					arguments: args
				}, signal, timeoutMs);
				if (!isRecord(result) || !Array.isArray(result.content) || typeof result.isError !== "boolean") throw new Error("native broker invoke response is invalid");
				return result;
			} catch (error) {
				await release(requestId).catch(() => {});
				throw error;
			}
		},
		release
	};
}
//#endregion
//#region src/native/mcp-server.ts
const REQUEST_ID_MAX = 256;
const INVENTORY_QUERY_MAX = 500;
const INVENTORY_LIMIT_MAX = 50;
const TOOL_NAME_MAX = 1e3;
const INVOCATION_ACTIVITY_PREFIX = "activity_";
function requestIdSchema() {
	return z.string().min(1).max(REQUEST_ID_MAX);
}
function activityId() {
	return `${INVOCATION_ACTIVITY_PREFIX}${randomBytes(18).toString("base64url")}`;
}
function hash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
function logRequest(operation, requestId, extra = "") {
	console.error(`[dsh-native-mcp] ${operation} request_hash=${hash(requestId)} request_chars=${requestId.length}` + (extra.length > 0 ? ` ${extra}` : ""));
}
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
function errorResult(error) {
	return {
		content: [{
			type: "text",
			text: errorText(error)
		}],
		isError: true
	};
}
function jsonText(value) {
	const serialized = JSON.stringify(value);
	return serialized === void 0 ? String(value) : serialized;
}
function textResult(value, isError = false) {
	return {
		content: [{
			type: "text",
			text: typeof value === "string" ? value : jsonText(value)
		}],
		...isError ? { isError: true } : {}
	};
}
function toolMatches(tool, query) {
	const needle = query?.trim().toLowerCase();
	if (!needle) return true;
	return `${tool.name}\n${tool.description}`.toLowerCase().includes(needle);
}
function inventory(snapshot, query, offset, limit, includeSchema) {
	const matches = snapshot.tools.filter((tool) => toolMatches(tool, query));
	const page = matches.slice(offset, offset + limit).map((tool) => ({
		wire_name: tool.name,
		name: tool.name,
		description: tool.description,
		...includeSchema ? { parameters: tool.parameters } : {}
	}));
	return {
		tools: page,
		total: matches.length,
		next_offset: offset + page.length < matches.length ? offset + page.length : null
	};
}
function mcpContent(result) {
	const content = [];
	for (const block of result.content) {
		if (block.type !== "text") throw new Error(`unsupported_content: native MCP result contains ${block.type} content`);
		content.push({
			type: "text",
			text: block.text
		});
	}
	return {
		content,
		...result.isError ? { isError: true } : {}
	};
}
/**
* Construct the fixed MCP surface. The façade deliberately has no dynamic
* registration path: the only tools ChatGPT can call are the three broker
* protocol operations below.
*/
function createDshNativeMcpServer(client) {
	const server = new McpServer({
		name: "dsh-native-chatgpt-web",
		version: "1.0.0"
	});
	server.registerTool("dsh_round_start", {
		title: "Start a DSH native tool round",
		description: "Start the DSH provider round before inspecting or calling its tools.",
		inputSchema: { request_id: requestIdSchema() }
	}, async ({ request_id }) => {
		logRequest("dsh_round_start", request_id);
		try {
			return textResult(await client.start(request_id));
		} catch (error) {
			return errorResult(error);
		}
	});
	server.registerTool("dsh_tool_inventory", {
		title: "List DSH tools for this round",
		description: "List the exact DSH tools advertised for the current native provider round.",
		inputSchema: {
			request_id: requestIdSchema(),
			query: z.string().max(INVENTORY_QUERY_MAX).optional(),
			offset: z.number().int().min(0).max(1e5).default(0),
			limit: z.number().int().min(1).max(INVENTORY_LIMIT_MAX).default(20),
			include_schema: z.boolean().default(true)
		}
	}, async ({ request_id, query, offset, limit, include_schema }, extra) => {
		logRequest("dsh_tool_inventory", request_id, `query_chars=${query?.length ?? 0}`);
		return await withActivity(client, request_id, extra.signal, async (snapshot) => textResult(inventory(snapshot, query, offset, limit, include_schema)));
	});
	server.registerTool("dsh_tool_call", {
		title: "Call one DSH tool",
		description: "Call an exact wire_name returned by dsh_tool_inventory for this native round.",
		inputSchema: {
			request_id: requestIdSchema(),
			wire_name: z.string().min(1).max(TOOL_NAME_MAX),
			arguments: z.record(z.string(), z.unknown()).optional()
		}
	}, async ({ request_id, wire_name, arguments: args }, extra) => {
		logRequest("dsh_tool_call", request_id, `name_chars=${wire_name.length} args_chars=${jsonText(args ?? {}).length}`);
		return await withActivity(client, request_id, extra.signal, async (snapshot, id, signal) => {
			const tool = snapshot.tools.find((candidate) => candidate.name === wire_name);
			if (tool === void 0) throw new Error(`native MCP tool is not advertised: ${wire_name}`);
			let result;
			try {
				result = await client.invoke(request_id, id, tool.name, args ?? {}, snapshot.invocationTimeoutMs, signal);
			} catch (error) {
				await client.release(request_id).catch(() => {});
				throw error;
			}
			return mcpContent(result);
		});
	});
	return server;
}
async function withActivity(client, requestId, signal, action) {
	const id = activityId();
	let result = errorResult(/* @__PURE__ */ new Error("native MCP activity did not produce a result"));
	try {
		result = await action(await client.claim(requestId, id, signal), id, signal);
	} catch (error) {
		result = errorResult(error);
	} finally {
		try {
			await client.completeActivity(requestId, id);
		} catch (error) {
			if (result.isError !== true) result = errorResult(error);
		}
	}
	return result;
}
/** Start the façade on stdio; stdout is reserved for MCP protocol frames. */
async function runDshNativeMcpServer(socketPath) {
	if (!isAbsolute(socketPath)) throw new Error("native MCP broker socket path must be absolute");
	await createDshNativeMcpServer(createBrokerRpcClient(socketPath)).connect(new StdioServerTransport());
}
//#endregion
//#region src/native/mcp-main.ts
/** Parse the intentionally narrow executable CLI. */
async function runDshNativeMcpMain(args) {
	if (args.length !== 2 || args[0] !== "--broker-socket" || args[1] === void 0) throw new Error("usage: dsh-chatgpt-web-mcp --broker-socket /absolute/path/to/broker.sock");
	if (!resolve(args[1]).startsWith("/") || args[1] !== resolve(args[1])) throw new Error("native MCP --broker-socket must be an absolute path");
	await runDshNativeMcpServer(args[1]);
}
const invokedPath = process.argv[1] === void 0 ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url)) || invokedPath.endsWith("/mcp-main.js")) runDshNativeMcpMain(process.argv.slice(2)).catch((error) => {
	console.error(`dsh-chatgpt-web-mcp: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
//#endregion
export { runDshNativeMcpMain };
