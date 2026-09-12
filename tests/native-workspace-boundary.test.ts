import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceBoundary } from '../src/native/workspace-boundary.ts'
import { resolveNativeSecurityConfig } from '../src/native/policy.ts'

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-boundary-'))
  workspaces.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
  await writeFile(join(root, 'README.md'), '# test\n')
  return realpath(root)
}

function boundary(root: string) {
  return createWorkspaceBoundary(resolveNativeSecurityConfig({ workspaceRoot: root }, root))
}

describe('WorkspaceBoundary path confinement', () => {
  it('canonicalizes in-root paths, rejects escapes and resolves missing children', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-native-outside-'))
    workspaces.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const sibling = join(root, '..', `${basename(root)}-other`)
    await mkdir(sibling)
    workspaces.push(sibling)
    await writeFile(join(sibling, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'linked-directory'))
    await symlink(join(outside, 'secret.txt'), join(root, 'linked-file'))
    const confined = boundary(root)

    const original = { path: 'src/index.ts', paths: ['README.md'] }
    const decision = confined.rewriteArguments(
      original,
      ['/path', '/paths'],
    )
    expect(decision.arguments).toEqual({
      path: join(root, 'src', 'index.ts'),
      paths: [join(root, 'README.md')],
    })
    expect(decision.arguments).not.toBe(original)
    expect(Object.isFrozen(decision.arguments)).toBe(true)
    expect(Object.isFrozen(decision.arguments.paths)).toBe(true)
    expect(decision.argumentsHash).toMatch(/^[a-f0-9]{64}$/)

    expect(confined.rewriteArguments({ path: join(root, 'src', 'index.ts') }, ['/path']).arguments.path)
      .toBe(join(root, 'src', 'index.ts'))
    expect(confined.rewriteArguments({ path: 'new/deep/file.txt' }, ['/path']).arguments.path)
      .toBe(join(root, 'new', 'deep', 'file.txt'))
    expect(() => confined.rewriteArguments({ path: '../dsh-native-outside-x/secret.txt' }, ['/path']))
      .toThrow(/workspace|outside|root/i)
    expect(() => confined.rewriteArguments({ path: join(sibling, 'secret.txt') }, ['/path']))
      .toThrow(/workspace|outside|root/i)
    expect(() => confined.rewriteArguments({ path: 'src\u0000/index.ts' }, ['/path']))
      .toThrow(/control|NUL/i)
    expect(() => confined.rewriteArguments({ path: join(outside, 'secret.txt') }, ['/path']))
      .toThrow(/workspace|outside|root/i)
    expect(() => confined.rewriteArguments({ path: 'linked-directory/secret.txt' }, ['/path']))
      .toThrow(/workspace|outside|root/i)
    expect(() => confined.rewriteArguments({ path: 'linked-file' }, ['/path']))
      .toThrow(/workspace|outside|root/i)
  })

  it('rejects a symlinked workspace root and sensitive paths after canonicalization', async () => {
    const root = await workspace()
    const rootLink = join(root, '..', `${basename(root)}-link`)
    await symlink(root, rootLink)
    workspaces.push(rootLink)
    expect(() => boundary(rootLink)).toThrow(/symlink|root/i)

    await writeFile(join(root, '.env'), 'TOKEN=secret\n')
    await writeFile(join(root, '.env.example'), 'TOKEN=example\n')
    await mkdir(join(root, '.ssh'))
    await writeFile(join(root, '.ssh', 'config'), 'Host example\n')
    await writeFile(join(root, 'notes.pem'), 'private\n')
    await writeFile(join(root, 'notes.txt'), 'safe\n')
    const confined = boundary(root)
    for (const path of [
      '.env', '.env.local', '.ssh/config', '.aws/credentials', '.azure/token',
      '.config/gcloud/credentials', '.gnupg/private', '.kube/config', '.npmrc',
      '.netrc', '_netrc', '.git-credentials', 'Library/Keychains/login.keychain-db',
      '.cloudflared/cert.pem', '.git/config', '.hg/store', '.svn/entries', '.dsh/state',
      'notes.pem', 'notes.p12', 'notes.pfx', 'notes.key', 'id_ed25519', 'folder/id_dsa',
    ]) {
      expect(() => confined.rewriteArguments({ path }, ['/path'])).toThrow(/sensitive|private|denied|workspace/i)
    }
    expect(confined.rewriteArguments({ path: '.env.example' }, ['/path']).arguments.path)
      .toBe(join(root, '.env.example'))
    expect(confined.rewriteArguments({ path: 'notes.txt' }, ['/path']).arguments.path)
      .toBe(join(root, 'notes.txt'))
  })

  it('denies exact configured adapter-private paths without using string prefixes', async () => {
    const root = await workspace()
    const privateProfile = join(root, 'adapter-profile')
    const privateRuntime = join(root, 'native-runtime.json')
    const privateSocket = join(root, 'native-broker.sock')
    const confined = createWorkspaceBoundary(
      resolveNativeSecurityConfig({ workspaceRoot: root }, root),
      [privateProfile, privateRuntime, privateSocket],
    )
    for (const path of ['adapter-profile', 'adapter-profile/state.json', 'native-runtime.json', 'native-broker.sock']) {
      expect(() => confined.rewriteArguments({ path }, ['/path'])).toThrow(/private|denied|workspace/i)
    }
    expect(confined.rewriteArguments({ path: 'adapter-profile-other/file.txt' }, ['/path']).arguments.path)
      .toBe(join(root, 'adapter-profile-other', 'file.txt'))
  })

  it('rewrites JSON Pointer values atomically and recursively freezes the result', async () => {
    const root = await workspace()
    const confined = boundary(root)
    const args = {
      path: 'src/index.ts',
      paths: ['README.md', 'src/index.ts'],
      nested: { 'a/b': 'README.md' },
      untouched: { value: 'left alone' },
    }
    const decision = confined.rewriteArguments(args, ['/path', '/paths', '/nested/a~1b'])
    expect(decision.arguments).toEqual({
      path: join(root, 'src', 'index.ts'),
      paths: [join(root, 'README.md'), join(root, 'src', 'index.ts')],
      nested: { 'a/b': join(root, 'README.md') },
      untouched: { value: 'left alone' },
    })
    expect(args).toEqual({
      path: 'src/index.ts',
      paths: ['README.md', 'src/index.ts'],
      nested: { 'a/b': 'README.md' },
      untouched: { value: 'left alone' },
    })
    expect(Object.isFrozen(decision.arguments)).toBe(true)
    expect(Object.isFrozen(decision.arguments.paths)).toBe(true)
    expect(Object.isFrozen(decision.arguments.nested)).toBe(true)
    expect(Object.isFrozen(decision.arguments.untouched)).toBe(true)

    expect(() => confined.rewriteArguments({ paths: ['README.md', '../escape'] }, ['/paths']))
      .toThrow(/workspace|outside|root/i)
    expect(() => confined.rewriteArguments({ paths: [] }, ['/paths'])).toThrow(/path/i)
    expect(() => confined.rewriteArguments({ paths: [''] }, ['/paths'])).toThrow(/path/i)
    expect(() => confined.rewriteArguments({ paths: ['README.md', 1] }, ['/paths']))
      .toThrow(/path|string/i)
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => confined.rewriteArguments({ paths: cyclic }, ['/paths'])).toThrow(/path|string|cycle/i)
    expect(() => confined.rewriteArguments({ path: 'README.md' }, ['/missing'])).toThrow(/pointer|missing/i)
    expect(() => confined.rewriteArguments({ path: 'README.md' }, ['path'])).toThrow(/pointer/i)
    expect(() => confined.rewriteArguments({ path: 'README.md' }, ['/path~2bad'])).toThrow(/pointer|escape/i)
    expect(() => confined.rewriteArguments({ path: 'README.md' }, [''])).toThrow(/root|path/i)
  })

  it('rebases canonical absolute arguments to normalized provider paths', async () => {
    const root = await workspace()
    const confined = boundary(root)
    const absolute = confined.rewriteArguments(
      { path: 'src/index.ts', paths: ['README.md'] },
      ['/path', '/paths'],
    ).arguments
    const rebased = confined.rebaseProviderArguments(absolute, ['/path', '/paths'])
    expect(rebased).toEqual({ path: 'src/index.ts', paths: ['README.md'] })
    expect(Object.isFrozen(rebased)).toBe(true)
    expect(confined.rebaseProviderArguments({ path: root }, ['/path']).path).toBe('.')
    expect(() => confined.rebaseProviderArguments({ path: '/tmp/outside' }, ['/path']))
      .toThrow(/workspace|outside|root/i)
  })
})

describe('WorkspaceBoundary literal .dsh-chatgptignore', () => {
  it('loads UTF-8 literal files and snapshots their rules per boundary', async () => {
    const root = await workspace()
    await mkdir(join(root, 'build'))
    await writeFile(join(root, '.dsh-chatgptignore'), '# comment\n\n秘密.txt\nbuild/\n')
    await writeFile(join(root, '秘密.txt'), 'private\n')
    await writeFile(join(root, 'public.txt'), 'public\n')
    const first = boundary(root)
    expect(first.ignoreDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => first.rewriteArguments({ path: '秘密.txt' }, ['/path'])).toThrow(/ignored|sensitive|denied/i)
    expect(() => first.rewriteArguments({ path: 'build/new.txt' }, ['/path'])).toThrow(/ignored|sensitive|denied/i)
    expect(first.rewriteArguments({ path: 'public.txt' }, ['/path']).arguments.path).toBe(join(root, 'public.txt'))

    await writeFile(join(root, '.dsh-chatgptignore'), 'public.txt\n')
    const second = boundary(root)
    expect(second.ignoreDigest).not.toBe(first.ignoreDigest)
    expect(() => first.rewriteArguments({ path: '秘密.txt' }, ['/path'])).toThrow(/ignored|sensitive|denied/i)
    expect(second.rewriteArguments({ path: '秘密.txt' }, ['/path']).arguments.path).toBe(join(root, '秘密.txt'))
    expect(() => second.rewriteArguments({ path: 'public.txt' }, ['/path'])).toThrow(/ignored|sensitive|denied/i)
  })

  it('accepts the exact byte cap and rejects oversize, malformed, symlink, and invalid grammar', async () => {
    const root = await workspace()
    await writeFile(join(root, '.dsh-chatgptignore'), `#${'x'.repeat(65_535)}`)
    expect(boundary(root).ignoreDigest).toMatch(/^[a-f0-9]{64}$/)

    const invalid = [
      '/absolute/path',
      '../escape',
      'foo/../bar',
      '!secret.txt',
      'foo*',
      'foo?',
      'foo[bar]',
      'foo\\bar',
      'bad\u0000path',
      '.',
      'foo/./bar',
      'duplicate.txt\nduplicate.txt',
    ]
    for (const content of invalid) {
      await writeFile(join(root, '.dsh-chatgptignore'), content)
      expect(() => boundary(root), content).toThrow(/ignore|path|invalid|traversal|absolute|duplicate/i)
    }

    await writeFile(join(root, '.dsh-chatgptignore'), 'x'.repeat(65_537))
    expect(() => boundary(root)).toThrow(/64|size|large|ignore/i)
    await writeFile(join(root, '.dsh-chatgptignore'), Buffer.from([0xff, 0xfe]))
    expect(() => boundary(root)).toThrow(/UTF|encoding|ignore/i)

    await rm(join(root, '.dsh-chatgptignore'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-native-ignore-outside-'))
    workspaces.push(outside)
    await writeFile(join(outside, 'ignore.txt'), 'secret.txt\n')
    await symlink(join(outside, 'ignore.txt'), join(root, '.dsh-chatgptignore'))
    expect(() => boundary(root)).toThrow(/symlink|ignore/i)
  })
})
