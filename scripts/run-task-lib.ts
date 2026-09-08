/**
 * Dev-only loop task runner against the BUILT lib/ mount (production path):
 * boots the composition from lib-cordis.yml (plugin mounted via lib/index.js)
 * and runs one agent-loop task. NOT part of the published package.
 *
 *   node --import tsx/esm scripts/run-task-lib.ts "task..."
 */
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { Context } from '@deepseek-ai/cordis'

const NAME = 'dsh-chatgpt-web-task-lib'
const tasks = process.argv.slice(2).join(' ').split(' ::: ').map(part => part.trim()).filter(part => part.length > 0)
if (tasks.length === 0) throw new Error(`${NAME}: expected a task argument`)
const configPath = fileURLToPath(new URL('../lib-cordis.yml', import.meta.url))

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  for (const [index, task] of tasks.entries()) {
    const result = await runFixtureTurn(ctx, {
      task,
      onEvent: (_sessionId: string, event: unknown) => {
        const record = event as { type?: string }
        if (record.type === 'assistant/chunk') {
          const chunk = (record as { chunk?: { type?: string; text?: string } }).chunk
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') process.stdout.write(chunk.text)
        }
      },
    })
    process.stdout.write(`\n[result ${index + 1}/${tasks.length}] ${JSON.stringify(result)}\n`)
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
