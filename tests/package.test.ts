import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MANAGED_TUNNEL_CLIENT_VERSION,
  tunnelReleaseAsset,
} from '../src/native/tunnel-install.ts'

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

  it('pins the v0.7.0 release metadata and tunnel assets', () => {
    expect(pkg['version']).toBe('0.7.0')
    const deps = pkg['dependencies'] as Record<string, string>
    expect(deps.fflate).toBe('0.8.3')
    expect(MANAGED_TUNNEL_CLIENT_VERSION).toBe('0.0.12')
    const assets = [
      ['darwin', 'amd64', 'tunnel-client-v0.0.12-darwin-amd64.zip', '33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009'],
      ['darwin', 'arm64', 'tunnel-client-v0.0.12-darwin-arm64.zip', '42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02'],
      ['linux', 'amd64', 'tunnel-client-v0.0.12-linux-amd64.zip', '2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81'],
      ['linux', 'arm64', 'tunnel-client-v0.0.12-linux-arm64.zip', '6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6'],
    ] as const
    for (const [platform, arch, name, archiveSha256] of assets) {
      expect(tunnelReleaseAsset(platform, arch)).toEqual({ name, archiveSha256 })
    }
  })

  it('keeps runtime dependencies and the native MCP executable in the package', () => {
    const deps = pkg['dependencies'] as Record<string, string>
    expect(deps['playwright-core']).toBeDefined()
    expect(deps['@modelcontextprotocol/sdk']).toBeDefined()
    expect(deps.fflate).toBe('0.8.3')
    expect(deps.zod).toBe('4.4.3')
    const bin = pkg['bin'] as Record<string, string>
    expect(bin['dsh-chatgpt-web-mcp']).toBe('./lib/mcp-main.js')
    expect(bin['dsh-chatgpt-web-native']).toBe('./lib/native-setup-main.js')
    for (const file of ['lib/mcp-main.js', 'lib/native-setup-main.js']) {
      expect(existsSync(join(root, file))).toBe(true)
      expect(readFileSync(join(root, file), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/)
    }
  })

  it('does not require a version-specific runtime call-id brand export or ship key-shaped literals', () => {
    const built = readFileSync(join(root, 'lib/index.js'), 'utf8')
    expect(built).not.toMatch(/import \{[^}]*\b(?:CallId|ToolCallId)\b[^}]*\} from ["']@deepseek-ai\/dsh-llm["']/)
    for (const file of ['lib/index.js', 'lib/native-setup-main.js', 'lib/mcp-main.js']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/)
    }
  })

  it('keeps the public security documentation and excludes internal docs from the packed tree', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    for (const term of [
      'toolPolicy', 'workspaceRoot', 'approval', '.dsh-chatgptignore', 'approve',
      'recover --abandon', 'doctor --json', 'TOCTOU', 'output-provenance',
      'rollback', 'experimental 0.7.0',
    ]) expect(readme).toContain(term)
    const packed = JSON.parse(execFileSync('pnpm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    })) as { files: Array<{ path: string }> }
    expect(packed.files.every(file => !/docs\/internal|research|superpowers/.test(file.path))).toBe(true)
  })

  it('targets a supported node runtime', () => {
    const engines = pkg['engines'] as { node?: string }
    expect(engines.node).toMatch(/22/)
  })
})
