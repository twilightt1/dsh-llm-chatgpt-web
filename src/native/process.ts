import { spawnSync } from 'node:child_process'

export interface CommandResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandOptions {
  readonly timeoutMs?: number
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('command timeout must be a positive safe integer no greater than 2147483647')
  }
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: timeoutMs,
  })
  if (result.error !== undefined) throw result.error
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}
