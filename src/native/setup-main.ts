#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  doctorManagedNativeRuntime,
  formatNativeDoctorReport,
  parseNativeSetupArgs,
  setupManagedNativeRuntime,
  stopManagedNativeRuntime,
} from './setup.ts'
import type { NativeSetupIo } from './setup.ts'
import { redactTunnelDetail } from './tunnel-runtime.ts'

function defaultIo(): NativeSetupIo {
  return {
    stdin: process.stdin as unknown as NativeSetupIo['stdin'],
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

export function readHiddenRuntimeKey(io: NativeSetupIo): Promise<string> {
  const stdin = io.stdin
  if (stdin.isTTY !== true || stdin.setRawMode === undefined) {
    throw new Error('runtime key prompt requires an interactive TTY; pass --runtime-key-file')
  }
  return new Promise<string>((resolveKey, reject) => {
    let value = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      stdin.setRawMode?.(false)
      stdin.removeListener('data', onData)
      stdin.removeListener('error', onError)
      stdin.pause()
      const result = value
      value = ''
      if (error !== undefined) reject(error)
      else resolveKey(result)
    }
    const onError = (error: Error): void => finish(error)
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const character of text) {
        if (character === '\u0003') {
          finish(new Error('runtime key prompt cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.on('data', onData)
    stdin.once('error', onError)
  })
}

export async function runDshNativeSetupMain(
  args: readonly string[],
  io: NativeSetupIo = defaultIo(),
): Promise<number> {
  try {
    const command = parseNativeSetupArgs(args)
    if (command.command === 'setup') {
      const options = command.options.runtimeKeyFile === undefined
          ? (() => {
            io.stdout.write('Runtime key (hidden): ')
            return readHiddenRuntimeKey(io).then(value => ({ ...command.options, runtimeKeyValue: value }))
          })()
          : Promise.resolve(command.options)
      const configured = await options
      const result = await setupManagedNativeRuntime(configured)
      io.stdout.write(
        `Managed native runtime ready for connector ${JSON.stringify(result.connectorName)}.\n`
        + 'Create or attach the exact ChatGPT Personalized connector; setup does not change account settings.\n',
      )
      return 0
    }
    if (command.command === 'doctor') {
      const report = doctorManagedNativeRuntime(command)
      io.stdout.write(formatNativeDoctorReport(report, command.json))
      return report.ok ? 0 : 1
    }
    await stopManagedNativeRuntime(command)
    io.stdout.write('Managed native tunnel stopped.\n')
    return 0
  } catch (error) {
    io.stderr.write(`dsh-chatgpt-web-native: ${redactTunnelDetail(error instanceof Error ? error.message : error)}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] === undefined
  ? ''
  : realpathSync(resolve(process.argv[1]))
const modulePath = realpathSync(fileURLToPath(import.meta.url))
if (invokedPath === modulePath) {
  void runDshNativeSetupMain(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
