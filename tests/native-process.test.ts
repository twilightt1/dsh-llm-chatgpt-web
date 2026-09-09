import { describe, expect, it, vi } from 'vitest'

const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({
  status: 0,
  stdout: '',
  stderr: '',
})));

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

import { runCommand } from '../src/native/process.ts'

describe('bounded native subprocess wrapper', () => {
  it('passes an explicit output bound and validated timeout to spawnSync', () => {
    runCommand('/tmp/tunnel-client', ['--version'], { timeoutMs: 1_000 })
    expect(spawnSyncMock).toHaveBeenCalledWith('/tmp/tunnel-client', ['--version'], expect.objectContaining({
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 1_000,
      maxBuffer: 2 * 1024 * 1024,
    }))
  })
})
