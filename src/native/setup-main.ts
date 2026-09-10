#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  abandonNativeCheckpoint,
  doctorManagedNativeRuntime,
  formatNativeDoctorReport,
  parseNativeSetupArgs,
  setupManagedNativeRuntime,
  stopManagedNativeRuntime,
} from './setup.ts'
import {
  approveNativeChallenge,
  formatNativeApprovalChallenge,
  readNativeApprovalChallenge,
} from './grants.ts'
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

function readApprovalConfirmation(io: NativeSetupIo): Promise<string> {
  const stdin = io.stdin
  const setRawMode = stdin.setRawMode
  if (stdin.isTTY !== true || setRawMode === undefined) {
    throw new Error('native approval requires an interactive TTY')
  }
  const enableRawMode = setRawMode.bind(stdin)
  return new Promise<string>((resolveConfirmation, reject) => {
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
      else resolveConfirmation(result)
    }
    const onError = (error: Error): void => finish(error)
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const character of text) {
        if (character === '\u0003') {
          finish(new Error('native approval prompt cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0008' || character === '\u007f') value = value.slice(0, -1)
        else value += character
      }
    }
    enableRawMode(true)
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
    if (command.command === 'recover') {
      if (io.stdin.isTTY !== true) throw new Error('native recovery requires an interactive TTY')
      io.stdout.write(`Abandon checkpoint ${JSON.stringify(command.checkpointHash)}? Type abandon: `)
      const confirmation = await readApprovalConfirmation(io)
      if (confirmation !== 'abandon') throw new Error('native recovery requires the exact confirmation "abandon"')
      await abandonNativeCheckpoint(command.profileDir, command.checkpointHash)
      io.stdout.write('Native checkpoint marked abandoned.\n')
      return 0
    }
    if (command.command === 'approve') {
      if (io.stdin.isTTY !== true) throw new Error('native approval requires an interactive TTY')
      const challenge = readNativeApprovalChallenge(command.profileDir)
      if (challenge === undefined) throw new Error('native approval challenge is missing or already claimed')
      io.stdout.write(formatNativeApprovalChallenge(challenge))
      io.stdout.write('Confirmation: ')
      const confirmation = await readApprovalConfirmation(io)
      approveNativeChallenge({
        profileDir: command.profileDir,
        challengeId: command.challengeId,
        confirmation,
      })
      io.stdout.write('Native policy approval recorded.\n')
      return 0
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
