import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>

describe('package manifest', () => {
  it('declares the dsh bundle patch used by `dsh plugin add`', () => {
    const dsh = pkg['dsh'] as { bundle?: { patch?: string } }
    expect(dsh.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(join(root, 'cordis.patch.yml'))).toBe(true)
  })

  it('ships the entry, manifest, and docs', () => {
    const files = pkg['files'] as string[]
    for (const file of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      expect(files).toContain(file)
    }
    const exports = pkg['exports'] as Record<string, unknown>
    expect(exports['.']).toBeDefined()
    expect(exports['./package.json']).toBe('./package.json')
  })

  it('keeps playwright-core a runtime dependency (no browser download needed)', () => {
    const deps = pkg['dependencies'] as Record<string, string>
    expect(deps['playwright-core']).toBeDefined()
  })

  it('targets a supported node runtime', () => {
    const engines = pkg['engines'] as { node?: string }
    expect(engines.node).toMatch(/22/)
  })
})
