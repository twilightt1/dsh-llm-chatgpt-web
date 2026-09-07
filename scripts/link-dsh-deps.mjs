/**
 * Link harness workspace packages for local dev.
 *
 * The plugin's Cordis peers (`@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`,
 * `@deepseek-ai/schemastery`) resolve against a local deepseek-harness
 * checkout because their published versions may lag the workspace API this
 * plugin targets. `pnpm install` cannot `file:`-link them (their own
 * `workspace:^` deps are unresolvable outside that workspace), so this
 * postinstall script symlinks them instead and re-heals after every install.
 *
 * Override the checkout location with `DSH_HOME`.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env['DSH_HOME'] ?? '/Users/twilight/deepseek-harness'
const scope = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai')
const links = {
  'cordis': join(home, 'vendor/cordis'),
  'dsh-llm': join(home, 'packages/llm/llm'),
  'schemastery': join(home, 'vendor/schemastery'),
  'dsh-app-boot': join(home, 'packages/boot/app-boot'),
  'dsh-loader-smoke': join(home, 'packages/test-support/loader-smoke'),
}

mkdirSync(scope, { recursive: true })
for (const [name, target] of Object.entries(links)) {
  if (!existsSync(join(target, 'package.json'))) {
    console.warn(`[link-dsh-deps] skip ${name}: no package.json at ${target} (set DSH_HOME)`)
    continue
  }
  const link = join(scope, name)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
  console.log(`[link-dsh-deps] ${name} -> ${target}`)
}
