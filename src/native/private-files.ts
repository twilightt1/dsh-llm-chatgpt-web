import { randomUUID } from 'node:crypto'
import { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } from 'node:constants'
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
import { dirname, join } from 'node:path'
import { NativeSafetyError } from './errors.ts'
import type { PrivateProcessState, PrivateWriterLease, PrivateWriterLeaseDependencies } from './types.ts'

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

function assertPrivate0600(path: string, label: string): void {
  assertPrivateRegularFile(path, label)
  const mode = lstatSync(path).mode & 0o777
  if (mode !== 0o600) throw new Error(`${label} has unsafe permissions: expected 600, got ${mode.toString(8)}`)
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

const MAX_PRIVATE_APPEND_RECORD_BYTES = 16 * 1024
const MAX_PRIVATE_APPEND_BYTES = 4 * 1024 * 1024
const MAX_PRIVATE_APPEND_RECORDS = 4_096

function privateStateError(message: string, cause?: unknown): NativeSafetyError {
  return new NativeSafetyError(message, cause, 'NATIVE_PRIVATE_STATE')
}

function validateAppendFile(path: string, nextBytes: number): { readonly size: number; readonly records: number } {
  assertPrivate0600(path, 'private append file')
  const bytes = readFileSync(path)
  if (bytes.byteLength > MAX_PRIVATE_APPEND_BYTES || bytes.byteLength + nextBytes > MAX_PRIVATE_APPEND_BYTES) {
    throw privateStateError('private append file exceeds its durability limit')
  }
  if (bytes.byteLength === 0) return { size: 0, records: 0 }
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw privateStateError('private append file has an incomplete final line')
  }
  const text = bytes.toString('utf8')
  const lines = text.slice(0, -1).split('\n')
  if (lines.length > MAX_PRIVATE_APPEND_RECORDS) {
    throw privateStateError('private append file exceeds its record limit')
  }
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') + 1 > MAX_PRIVATE_APPEND_RECORD_BYTES) {
      throw privateStateError('private append record exceeds its size limit')
    }
    try {
      JSON.parse(line)
    } catch (error) {
      throw privateStateError('private append file contains malformed JSON', error)
    }
  }
  return { size: bytes.byteLength, records: lines.length }
}

/** Append one complete, fsynced, bounded JSONL record to a private file. */
export function appendDurablePrivateJsonLine(path: string, record: unknown): void {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw privateStateError('private append records must be JSON objects')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(record) as string
  } catch (error) {
    throw privateStateError('private append record is not JSON serializable', error)
  }
  if (serialized === undefined) throw privateStateError('private append record is not JSON serializable')
  const line = `${serialized}\n`
  const lineBytes = Buffer.byteLength(line, 'utf8')
  if (lineBytes > MAX_PRIVATE_APPEND_RECORD_BYTES) {
    throw privateStateError('private append record exceeds its size limit')
  }
  const parent = dirname(path)
  let fd: number | undefined
  let created = false
  let writeCompleted = false
  try {
    ensurePrivateDirectory(parent)
    try {
      fd = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      created = true
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const existing = validateAppendFile(path, lineBytes)
      if (existing.records >= MAX_PRIVATE_APPEND_RECORDS) {
        throw privateStateError('private append file exceeds its record limit')
      }
      fd = openSync(path, O_WRONLY | O_APPEND | O_NOFOLLOW)
    }
    if (fd === undefined) throw privateStateError('private append file could not be opened')
    try {
      if (created === false) {
        // validateAppendFile already checked the preimage; retain its exact
        // private mode and never repair an unsafe existing target.
        assertPrivate0600(path, 'private append file')
      }
      fchmodSync(fd, 0o600)
      writeFileSync(fd, line, 'utf8')
      fsyncSync(fd)
      writeCompleted = true
    } finally {
      closeSync(fd)
      fd = undefined
    }
    assertPrivate0600(path, 'private append file')
    syncPrivateDirectory(parent)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* preserve original failure */ }
    }
    if (created && !writeCompleted) {
      try {
        unlinkSync(path)
        syncPrivateDirectory(parent)
      } catch { /* preserve the original failure and fail closed */ }
    }
    if (error instanceof NativeSafetyError) throw error
    throw privateStateError('private append could not be completed safely', error)
  }
}

const PRIVATE_WRITER_LOCK = 'native-checkpoint-writer.lock'
const PRIVATE_WRITER_OWNER = 'owner.json'
const PRIVATE_WRITER_VERSION = 1 as const
const WRITER_TOKEN = /^[A-Za-z0-9_-]{1,128}$/

interface PrivateWriterOwner {
  readonly version: 1
  readonly pid: number
  readonly ownerToken: string
  readonly processStartedAt: string
  readonly heartbeatAt: string
}

function isoNow(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw privateStateError(`private writer ${label} is invalid`)
  }
  return value.toISOString()
}

function writerText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw privateStateError(`private writer ${label} is invalid`)
  }
  return value
}

function writerToken(value: unknown, label: string): string {
  const text = writerText(value, label)
  if (!WRITER_TOKEN.test(text)) throw privateStateError(`private writer ${label} is invalid`)
  return text
}

function writerTimestamp(value: unknown, label: string): string {
  const text = writerText(value, label)
  try {
    if (new Date(text).toISOString() !== text) throw privateStateError(`private writer ${label} is invalid`)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw privateStateError(`private writer ${label} is invalid`, error)
  }
  return text
}

function parseWriterOwner(value: unknown): PrivateWriterOwner {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw privateStateError('private writer owner metadata is invalid')
  }
  const candidate = value as Record<string, unknown>
  const required = ['version', 'pid', 'ownerToken', 'processStartedAt', 'heartbeatAt']
  if (Object.keys(candidate).some(key => !required.includes(key))
    || required.some(key => !Object.hasOwn(candidate, key))) {
    throw privateStateError('private writer owner metadata has an invalid key set')
  }
  const pid = candidate.pid
  if (candidate.version !== PRIVATE_WRITER_VERSION || !Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw privateStateError('private writer owner metadata is invalid')
  }
  const ownerToken = writerToken(candidate.ownerToken, 'owner token')
  const processStartedAt = writerTimestamp(candidate.processStartedAt, 'process start')
  const heartbeatAt = writerTimestamp(candidate.heartbeatAt, 'heartbeat')
  return { version: 1, pid: pid as number, ownerToken, processStartedAt, heartbeatAt }
}

function readWriterOwner(path: string): PrivateWriterOwner {
  assertPrivate0600(path, 'private writer owner')
  try {
    return parseWriterOwner(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw privateStateError('private writer owner metadata is not valid JSON', error)
  }
}

const DEFAULT_PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString()

function defaultWriterDependencies(): PrivateWriterLeaseDependencies {
  const processStartedAt = DEFAULT_PROCESS_STARTED_AT
  return {
    pid: process.pid,
    processStartedAt,
    now: () => new Date(),
    randomUUID,
    inspectProcess(pid: number): PrivateProcessState {
      if (pid === process.pid) return { kind: 'live', startedAt: processStartedAt }
      try {
        process.kill(pid, 0)
        return { kind: 'ambiguous' }
      } catch (error) {
        if (errorCode(error) === 'ESRCH') return { kind: 'dead' }
        return { kind: 'ambiguous' }
      }
    },
  }
}

function sameWriterOwner(left: PrivateWriterOwner, right: PrivateWriterOwner): boolean {
  return left.version === right.version
    && left.pid === right.pid
    && left.ownerToken === right.ownerToken
    && left.processStartedAt === right.processStartedAt
}

function removeQuarantine(path: string, parent: string): void {
  rmSync(path, { recursive: true, force: false })
  syncPrivateDirectory(parent)
}

/** Acquire the profile-wide atomic checkpoint writer lease. */
export function acquirePrivateWriterLease(
  profileDir: string,
  supplied?: Partial<PrivateWriterLeaseDependencies>,
): PrivateWriterLease {
  const defaults = defaultWriterDependencies()
  const dependencies: PrivateWriterLeaseDependencies = {
    pid: supplied?.pid ?? defaults.pid,
    processStartedAt: supplied?.processStartedAt ?? defaults.processStartedAt,
    now: supplied?.now ?? defaults.now,
    randomUUID: supplied?.randomUUID ?? defaults.randomUUID,
    inspectProcess: supplied?.inspectProcess ?? defaults.inspectProcess,
  }
  try {
    ensurePrivateDirectory(profileDir)
  } catch (error) {
    if (error instanceof NativeSafetyError) throw error
    throw privateStateError('private writer profile directory is not safe', error)
  }
  const lockPath = join(profileDir, PRIVATE_WRITER_LOCK)
  const ownerPath = join(lockPath, PRIVATE_WRITER_OWNER)
  if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 0) {
    throw privateStateError('private writer PID is invalid')
  }
  const makeOwner = (): PrivateWriterOwner => ({
    version: PRIVATE_WRITER_VERSION,
    pid: dependencies.pid,
    ownerToken: writerToken(dependencies.randomUUID(), 'owner token'),
    processStartedAt: writerTimestamp(dependencies.processStartedAt, 'process start'),
    heartbeatAt: isoNow(dependencies.now(), 'heartbeat'),
  })
  const writeOwner = (owner: PrivateWriterOwner): void => {
    if (!WRITER_TOKEN.test(owner.ownerToken)) throw privateStateError('private writer owner token is invalid')
    durableAtomicWritePrivateFile(ownerPath, `${JSON.stringify(owner)}\n`, 0o600)
  }
  const createLease = (): PrivateWriterLease => {
    const owner = makeOwner()
    let created = false
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      created = true
      assertPrivateDirectory(lockPath)
      syncPrivateDirectory(profileDir)
      writeOwner(owner)
    } catch (error) {
      if (created) {
        try { rmSync(lockPath, { recursive: true, force: true }) } catch { /* preserve original failure */ }
      }
      throw error
    }
    let released = false
    const assertOwner = (): PrivateWriterOwner => {
      if (released) throw privateStateError('private writer lease is already released')
      const current = readWriterOwner(ownerPath)
      if (!sameWriterOwner(current, owner)) {
        throw privateStateError('private writer lease ownership changed')
      }
      return current
    }
    return {
      ownerToken: owner.ownerToken,
      heartbeat(): void {
        const current = assertOwner()
        const next: PrivateWriterOwner = {
          ...current,
          heartbeatAt: isoNow(dependencies.now(), 'heartbeat'),
        }
        writeOwner(next)
      },
      release(): void {
        if (released) return
        assertOwner()
        rmSync(lockPath, { recursive: true, force: false })
        syncPrivateDirectory(profileDir)
        released = true
      },
    }
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return createLease()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (error instanceof NativeSafetyError) throw error
        throw privateStateError('private writer lease is unavailable', error)
      }
    }
    let existing: PrivateWriterOwner
    try {
      assertPrivateDirectory(lockPath)
      existing = readWriterOwner(ownerPath)
    } catch (error) {
      if (error instanceof NativeSafetyError) throw error
      throw privateStateError('private writer lease metadata is unreadable', error)
    }
    const now = dependencies.now()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())
      || new Date(existing.heartbeatAt).getTime() > now.getTime()
      || new Date(existing.processStartedAt).getTime() > now.getTime()) {
      throw privateStateError('private writer lease heartbeat is ambiguous')
    }
    let state: PrivateProcessState
    try {
      state = dependencies.inspectProcess(existing.pid)
    } catch (error) {
      throw privateStateError('private writer lease process state is ambiguous', error)
    }
    if (state.kind !== 'dead' && state.kind !== 'live' && state.kind !== 'ambiguous') {
      throw privateStateError('private writer lease process state is invalid')
    }
    if (state.kind === 'ambiguous') throw privateStateError('private writer lease owner is ambiguous')
    if (state.kind === 'live') {
      const startedAt = writerTimestamp(state.startedAt, 'observed process start')
      if (startedAt !== existing.processStartedAt) {
        throw privateStateError('private writer lease owner has ambiguous PID reuse')
      }
      throw privateStateError('private checkpoint writer lease is already held')
    }
    const quarantine = join(profileDir, `.native-checkpoint-writer-stale-${writerToken(dependencies.randomUUID(), 'quarantine token')}`)
    try {
      renameSync(lockPath, quarantine)
      syncPrivateDirectory(profileDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw privateStateError('private writer lease could not be quarantined safely', error)
    }
    let moved: PrivateWriterOwner
    try {
      moved = readWriterOwner(join(quarantine, PRIVATE_WRITER_OWNER))
    } catch (error) {
      try { renameSync(quarantine, lockPath) } catch { /* preserve block */ }
      throw error
    }
    if (!sameWriterOwner(moved, existing)) {
      try { renameSync(quarantine, lockPath) } catch { /* preserve block */ }
      throw privateStateError('private writer lease changed during quarantine')
    }
    try {
      const lease = createLease()
      try {
        removeQuarantine(quarantine, profileDir)
      } catch (error) {
        try { lease.release() } catch { /* preserve the quarantine failure */ }
        throw privateStateError('private writer stale lease could not be removed safely', error)
      }
      return lease
    } catch (error) {
      try { removeQuarantine(quarantine, profileDir) } catch { /* preserve original failure */ }
      if (errorCode(error) === 'EEXIST') continue
      throw error
    }
  }
  throw privateStateError('private writer lease could not be acquired without a race')
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
