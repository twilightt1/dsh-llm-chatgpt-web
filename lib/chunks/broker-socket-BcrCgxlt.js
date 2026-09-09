import { randomBytes } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
//#region src/native/broker-socket.ts
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const MAX_LINE_BYTES = 67108864;
const MAX_TIMER_MS = 2147483647;
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
/** A private one-request-per-connection Unix socket server around the broker. */
var NativeBrokerSocketServer = class {
	socketPath;
	broker;
	server;
	listenPromise;
	ownsEndpoint = false;
	sockets = /* @__PURE__ */ new Set();
	maxLineBytes;
	constructor(socketPath, broker, options = {}) {
		this.socketPath = socketPath;
		this.broker = broker;
		const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
		if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > MAX_LINE_BYTES) throw new Error(`native broker maxLineBytes must be a positive integer no greater than ${MAX_LINE_BYTES}`);
		this.maxLineBytes = maxLineBytes;
	}
	listen() {
		if (this.listenPromise !== void 0) return this.listenPromise;
		this.listenPromise = this.startListening();
		return this.listenPromise;
	}
	async close() {
		const pendingListen = this.listenPromise;
		if (pendingListen !== void 0) await pendingListen.catch(() => {});
		const server = this.server;
		this.server = void 0;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (server !== void 0) await new Promise((resolve, reject) => {
			server.close((error) => {
				if (error !== void 0 && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
				else resolve();
			});
		}).catch((error) => {
			if (error?.code !== "ERR_SERVER_NOT_RUNNING") throw error;
		});
		if (this.ownsEndpoint) {
			this.ownsEndpoint = false;
			try {
				if (lstatSync(this.socketPath).isSocket()) {
					let stale = true;
					try {
						await this.probeExistingEndpoint();
					} catch {
						stale = false;
					}
					if (stale) {
						if (lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
					}
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		this.listenPromise = void 0;
	}
	async startListening() {
		if (process.platform === "win32") throw new Error("native broker socket transport requires Unix sockets and is unsupported on win32");
		if (!isAbsolute(this.socketPath)) throw new Error("native broker socket path must be absolute");
		const pathBytes = Buffer.byteLength(this.socketPath);
		if (pathBytes > MAX_UNIX_SOCKET_PATH_BYTES) throw new Error(`native broker socket path is ${pathBytes} bytes, over the ${MAX_UNIX_SOCKET_PATH_BYTES}-byte Unix limit`);
		const parentPath = dirname(this.socketPath);
		mkdirSync(parentPath, {
			recursive: true,
			mode: 448
		});
		const parent = lstatSync(parentPath);
		if (!parent.isDirectory() || (parent.mode & 63) !== 0) throw new Error("unsafe broker directory permissions: expected a private directory");
		let existing;
		try {
			existing = lstatSync(this.socketPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (existing !== void 0) {
			if (!existing.isSocket()) throw new Error("broker endpoint exists and is not a socket");
			if (typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("broker endpoint is not owned by the current user");
			if ((Number(existing.mode) & 63) !== 0) throw new Error("broker endpoint has unsafe permissions");
			await this.probeExistingEndpoint();
			let afterProbe;
			try {
				afterProbe = lstatSync(this.socketPath);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			if (afterProbe !== void 0) {
				if (!afterProbe.isSocket()) throw new Error("broker endpoint exists and is not a socket");
				if (typeof process.getuid === "function" && afterProbe.uid !== process.getuid()) throw new Error("broker endpoint is not owned by the current user");
				if ((Number(afterProbe.mode) & 63) !== 0) throw new Error("broker endpoint has unsafe permissions");
				unlinkSync(this.socketPath);
			}
		}
		await new Promise((resolve, reject) => {
			const server = createServer((socket) => this.handleSocket(socket));
			this.server = server;
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				this.ownsEndpoint = true;
				try {
					chmodSync(this.socketPath, 384);
					resolve();
				} catch (error) {
					reject(error);
				}
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.socketPath);
		}).catch((error) => {
			this.server = void 0;
			if (this.ownsEndpoint) try {
				if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
			} catch {} finally {
				this.ownsEndpoint = false;
			}
			throw error;
		});
	}
	async probeExistingEndpoint() {
		await new Promise((resolve, reject) => {
			const probe = createConnection(this.socketPath);
			let settled = false;
			const finish = (action) => {
				if (settled) return;
				settled = true;
				probe.destroy();
				action();
			};
			probe.setTimeout(2e3, () => finish(() => reject(/* @__PURE__ */ new Error("timed out while probing existing broker endpoint"))));
			probe.once("connect", () => finish(() => reject(/* @__PURE__ */ new Error("broker endpoint is already owned by another process"))));
			probe.once("error", (error) => {
				const code = error.code;
				if (code === "ECONNREFUSED" || code === "ENOENT") finish(resolve);
				else finish(() => reject(/* @__PURE__ */ new Error(`could not probe existing broker endpoint: ${error.message}`)));
			});
		});
	}
	handleSocket(socket) {
		this.sockets.add(socket);
		const disconnected = new AbortController();
		let settled = false;
		let buffered = Buffer.alloc(0);
		const cleanup = () => {
			this.sockets.delete(socket);
			disconnected.abort();
		};
		socket.once("close", cleanup);
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			if (settled) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			buffered = Buffer.concat([buffered, bytes]);
			const newline = buffered.indexOf(10);
			if (newline < 0) {
				if (buffered.length > this.maxLineBytes) {
					settled = true;
					this.writeResponse(socket, {
						id: "unknown",
						error: "native broker request line is too large"
					});
				}
				return;
			}
			settled = true;
			const line = buffered.subarray(0, newline);
			if (line.length > this.maxLineBytes) {
				this.writeResponse(socket, {
					id: "unknown",
					error: "native broker request line is too large"
				});
				return;
			}
			let request;
			try {
				const parsed = JSON.parse(line.toString("utf8"));
				this.validateRequest(parsed);
				request = parsed;
			} catch (error) {
				this.writeResponse(socket, {
					id: "unknown",
					error: errorMessage(error)
				});
				return;
			}
			this.dispatch(request, disconnected.signal).then((result) => this.writeResponse(socket, {
				id: request.id,
				result
			}), (error) => this.writeResponse(socket, {
				id: request.id,
				error: errorMessage(error)
			}));
		});
	}
	writeResponse(socket, response) {
		if (socket.destroyed) return;
		const line = `${JSON.stringify(response)}\n`;
		if (Buffer.byteLength(line) > this.maxLineBytes) {
			socket.end(`${JSON.stringify({
				id: response.id,
				error: "native broker response is too large"
			})}\n`);
			return;
		}
		socket.end(line);
	}
	validateRequest(value) {
		if (!isRecord(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256 || typeof value.method !== "string" || ![
			"start",
			"claim",
			"activity_complete",
			"invoke",
			"release"
		].includes(value.method)) throw new Error("native broker request is invalid");
	}
	async dispatch(request, socketSignal) {
		switch (request.method) {
			case "start": return this.broker.start(this.requiredString(request.request_id, "request_id"));
			case "claim": return this.broker.claimActivity(this.requiredString(request.request_id, "request_id"), this.requiredString(request.activity_id, "activity_id"));
			case "activity_complete":
				this.broker.completeActivity(this.requiredString(request.request_id, "request_id"), this.requiredString(request.activity_id, "activity_id"));
				return { completed: true };
			case "release":
				this.broker.revoke(this.requiredString(request.request_id, "request_id"), /* @__PURE__ */ new Error("native broker round released by MCP consumer"));
				return { released: true };
			case "invoke": {
				const requestId = this.requiredString(request.request_id, "request_id");
				const activityId = this.requiredString(request.activity_id, "activity_id");
				const name = this.requiredString(request.name, "name");
				if (!isRecord(request.arguments)) throw new Error("native broker invoke arguments must be an object");
				const pending = this.broker.invoke(requestId, activityId, name, request.arguments);
				return await this.awaitConsumer(pending, requestId, socketSignal);
			}
		}
	}
	async awaitConsumer(pending, requestId, signal) {
		if (signal.aborted) {
			this.broker.revoke(requestId, /* @__PURE__ */ new Error("native broker invocation consumer aborted"));
			throw abortError("native broker invocation consumer aborted");
		}
		return await new Promise((resolve, reject) => {
			let done = false;
			const finish = (action) => {
				if (done) return;
				done = true;
				signal.removeEventListener("abort", onAbort);
				action();
			};
			const onAbort = () => {
				this.broker.revoke(requestId, /* @__PURE__ */ new Error("native broker invocation consumer aborted"));
				finish(() => reject(abortError("native broker invocation consumer aborted")));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.then((result) => finish(() => resolve(result)), (error) => finish(() => reject(error)));
		});
	}
	requiredString(value, field) {
		if (typeof value !== "string" || value.length === 0 || value.length > 1e6) throw new Error(`native broker ${field} is required`);
		return value;
	}
};
/** Create an RPC client with one isolated connection per operation. */
function createBrokerRpcClient(socketPath) {
	const call = async (method, fields, signal, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) => {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) throw new Error(`native broker RPC timeout must be a positive safe integer no greater than ${MAX_TIMER_MS}`);
		if (signal?.aborted) throw abortError("native broker RPC aborted");
		const id = rpcId();
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
export { createBrokerRpcClient as n, NativeBrokerSocketServer as t };
