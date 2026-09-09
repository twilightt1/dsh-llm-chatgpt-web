#!/usr/bin/env node
import { n as createBrokerRpcClient } from "./chunks/broker-socket-Du76mzjv.js";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
//#region src/native/mcp-server.ts
const REQUEST_ID_MAX = 256;
const INVENTORY_QUERY_MAX = 500;
const INVENTORY_LIMIT_MAX = 50;
const TOOL_NAME_MAX = 1e3;
const INVOCATION_ACTIVITY_PREFIX = "activity_";
const MAX_HANDSHAKES = 256;
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
	const startedRequests = /* @__PURE__ */ new Map();
	const rememberHandshake = (requestId) => {
		startedRequests.delete(requestId);
		if (startedRequests.size >= MAX_HANDSHAKES) {
			const oldest = startedRequests.keys().next();
			if (!oldest.done) startedRequests.delete(oldest.value);
		}
		startedRequests.set(requestId, true);
	};
	const requireHandshake = (requestId) => {
		if (!startedRequests.has(requestId)) throw new Error("native MCP round handshake required: call dsh_round_start first");
	};
	server.registerTool("dsh_round_start", {
		title: "Start a DSH native tool round",
		description: "Start the DSH provider round before inspecting or calling its tools.",
		inputSchema: { request_id: requestIdSchema() }
	}, async ({ request_id }) => {
		logRequest("dsh_round_start", request_id);
		try {
			const result = await client.start(request_id);
			rememberHandshake(request_id);
			return textResult(result);
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
		try {
			requireHandshake(request_id);
		} catch (error) {
			return errorResult(error);
		}
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
		try {
			requireHandshake(request_id);
		} catch (error) {
			return errorResult(error);
		}
		return await withActivity(client, request_id, extra.signal, async (snapshot, id, signal) => {
			const tool = snapshot.tools.find((candidate) => candidate.name === wire_name);
			if (tool === void 0) throw new Error(`native MCP tool is not advertised: ${wire_name}`);
			try {
				return mcpContent(await client.invoke(request_id, id, tool.name, args ?? {}, snapshot.invocationTimeoutMs, signal));
			} catch (error) {
				await client.release(request_id).catch(() => {});
				startedRequests.delete(request_id);
				throw error;
			}
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
	if (!isAbsolute(args[1])) throw new Error("native MCP --broker-socket must be an absolute path");
	await runDshNativeMcpServer(args[1]);
}
if ((process.argv[1] === void 0 ? "" : realpathSync(resolve(process.argv[1]))) === realpathSync(fileURLToPath(import.meta.url))) runDshNativeMcpMain(process.argv.slice(2)).catch((error) => {
	console.error(`dsh-chatgpt-web-mcp: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
//#endregion
export { runDshNativeMcpMain };
