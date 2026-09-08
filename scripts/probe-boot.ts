import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
const file = process.argv[2] as string
const uninstallFailLoud = installFailLoud('probe-boot')
let ctx: Context | undefined
try {
  ctx = await boot('probe-boot', resolveConfigPath(file, undefined))
  console.log('BOOT OK:', file)
} catch (error: unknown) {
  const err = error as { errors?: unknown[] }
  console.log('BOOT FAIL:', file)
  for (const inner of err.errors ?? [error]) {
    console.log('---', String(inner).split('\n').slice(0, 6).join(' | '))
  }
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
