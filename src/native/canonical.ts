import { createHash } from 'node:crypto'

const CONTROL_BYTES = /[\u0000-\u001f\u007f]/

function normalizeJson(value: unknown, stack: WeakSet<object>, inArray: boolean): unknown {
  if (value === undefined) return inArray ? null : undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('native canonical JSON cannot contain a non-finite number')
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError(`native canonical JSON contains a non-JSON value (${typeof value})`)
  }
  if (stack.has(value)) throw new TypeError('native canonical JSON contains a cycle')
  stack.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => normalizeJson(item, stack, true))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('native canonical JSON accepts only plain objects')
    }
    const result: Record<string, unknown> = {}
    const objectValue = value as Record<string, unknown>
    for (const key of Object.keys(objectValue).sort()) {
      const child = normalizeJson(objectValue[key], stack, false)
      if (child !== undefined) result[key] = child
    }
    return result
  } finally {
    stack.delete(value)
  }
}

/** Serialize JSON-shaped values with deterministic object-key ordering. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(normalizeJson(value, new WeakSet<object>(), false))
  return serialized === undefined ? 'undefined' : serialized
}

/** Hash one canonical value with an explicit domain, version, and payload length. */
export function hashCanonical(domain: string, version: number, value: unknown): string {
  if (domain.length === 0 || CONTROL_BYTES.test(domain)) {
    throw new TypeError('native canonical hash domain must be non-empty and control-free')
  }
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('native canonical hash version must be a non-negative safe integer')
  }
  const payload = canonicalJson(value)
  return createHash('sha256')
    .update(`${domain}\u0000${version}\u0000${Buffer.byteLength(payload, 'utf8')}\u0000`)
    .update(payload)
    .digest('hex')
}
