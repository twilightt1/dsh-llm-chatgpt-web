import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export interface PrivateFileSnapshot {
  readonly path: string
  restore(): void
  discard(): void
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function assertCurrentUser(stat: { uid: number }, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user`)
  }
}

function assertPrivateMode(mode: number, label: string, executable: boolean): void {
  const permissions = mode & 0o777
  const expected = executable ? 0o700 : 0o600
  if (permissions !== expected) {
    throw new Error(`${label} has unsafe permissions: expected ${expected.toString(8)}, got ${permissions.toString(8)}`)
  }
}

export function assertPrivateRegularFile(
  path: string,
  label: string,
  executable = false,
): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${label} does not exist: ${path}`)
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  assertCurrentUser(stat, label)
  assertPrivateMode(stat.mode, label, executable)
}

export function assertPrivateDirectory(path: string, label = 'private directory'): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${label} does not exist: ${path}`)
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
  assertCurrentUser(stat, label)
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label} has unsafe permissions: expected 700, got ${(stat.mode & 0o777).toString(8)}`)
  }
}

/** Create a missing directory privately; never repair an unsafe existing one. */
export function ensurePrivateDirectory(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  assertPrivateDirectory(path)
}

function assertReplaceableTarget(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`private file must not be a symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`private file is not a regular file: ${path}`)
    assertCurrentUser(stat, 'private file')
    if ((stat.mode & 0o077) !== 0) throw new Error(`private file has unsafe permissions: ${path}`)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

/** Write a private file with file and parent-directory durability. */
export function durableAtomicWritePrivateFile(
  path: string,
  data: string | Uint8Array,
  mode: 0o600 | 0o700 = 0o600,
): void {
  ensurePrivateDirectory(dirname(path))
  assertReplaceableTarget(path)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | undefined
  let createdTemporary = false
  try {
    fd = openSync(temporary, 'wx', mode)
    createdTemporary = true
    fchmodSync(fd, mode)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    assertPrivateRegularFile(path, 'private file', mode === 0o700)
    const directoryFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
    if (createdTemporary) {
      try { rmSync(temporary, { force: true }) } catch { /* preserve the original failure */ }
    }
    throw error
  }
}

/** Sync an already-private directory after a durable mutation. */
export function syncPrivateDirectory(path: string): void {
  assertPrivateDirectory(path)
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function atomicWritePrivateFile(
  path: string,
  data: string | Uint8Array,
  mode: 0o600 | 0o700 = 0o600,
): void {
  ensurePrivateDirectory(dirname(path))
  assertReplaceableTarget(path)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(temporary, 'wx', mode)
  try {
    writeFileSync(fd, data)
    closeSync(fd)
    renameSync(temporary, path)
    chmodSync(path, mode)
  } catch (error) {
    try { closeSync(fd) } catch { /* best effort */ }
    rmSync(temporary, { force: true })
    throw error
  }
}

function removePrivateFile(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing to remove symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`refusing to remove non-file: ${path}`)
  assertCurrentUser(stat, 'private file')
  if ((stat.mode & 0o077) !== 0) throw new Error(`refusing to remove unsafe private file: ${path}`)
  unlinkSync(path)
}

export function snapshotPrivateFile(path: string): PrivateFileSnapshot {
  let existed = false
  let bytes = new Uint8Array()
  let mode: 0o600 | 0o700 = 0o600
  try {
    const stat = lstatSync(path)
    existed = true
    if (stat.isSymbolicLink()) throw new Error(`cannot snapshot symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`cannot snapshot non-file: ${path}`)
    assertCurrentUser(stat, 'private file')
    if ((stat.mode & 0o077) !== 0) throw new Error(`cannot snapshot unsafe private file: ${path}`)
    bytes = new Uint8Array(readFileSync(path))
    mode = (stat.mode & 0o111) !== 0 ? 0o700 : 0o600
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }

  let active = true
  return {
    path,
    restore(): void {
      if (!active) return
      if (existed) atomicWritePrivateFile(path, bytes, mode)
      else removePrivateFile(path)
      active = false
    },
    discard(): void {
      active = false
    },
  }
}
