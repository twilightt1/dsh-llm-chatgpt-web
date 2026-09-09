#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { runDshNativeMcpServer } from './mcp-server.ts'

/** Parse the intentionally narrow executable CLI. */
export async function runDshNativeMcpMain(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--broker-socket' || args[1] === undefined) {
    throw new Error('usage: dsh-chatgpt-web-mcp --broker-socket /absolute/path/to/broker.sock')
  }
  if (!isAbsolute(args[1])) throw new Error('native MCP --broker-socket must be an absolute path')
  await runDshNativeMcpServer(args[1])
}

const invokedPath = process.argv[1] === undefined
  ? ''
  : realpathSync(resolve(process.argv[1]))
const modulePath = realpathSync(fileURLToPath(import.meta.url))
if (invokedPath === modulePath) {
  void runDshNativeMcpMain(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`dsh-chatgpt-web-mcp: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
