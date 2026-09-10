import { describe, expect, it } from 'vitest'
import { canonicalJson, hashCanonical } from '../src/native/canonical.ts'

describe('native canonical identities', () => {
  it('sorts object keys while preserving array order', () => {
    expect(canonicalJson({ b: 2, a: 1, nested: { z: true, y: false }, items: [3, 1, 2] }))
      .toBe('{"a":1,"b":2,"items":[3,1,2],"nested":{"y":false,"z":true}}')
  })

  it('matches JSON undefined omission and array null conversion', () => {
    expect(canonicalJson({ present: 'yes', omitted: undefined })).toBe('{"present":"yes"}')
    expect(canonicalJson([undefined, 'yes'])).toBe('[null,"yes"]')
    expect(canonicalJson(undefined)).toBe('undefined')
  })

  it('allows repeated references but rejects cycles', () => {
    const shared = { value: 'shared' }
    expect(canonicalJson({ first: shared, second: shared })).toBe(
      '{"first":{"value":"shared"},"second":{"value":"shared"}}',
    )

    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => canonicalJson(value)).toThrow(/cycle/i)
  })

  it('rejects non-plain objects and non-JSON values', () => {
    expect(() => canonicalJson(new Date())).toThrow(/plain|json/i)
    expect(() => canonicalJson(new Map())).toThrow(/plain|json/i)
    expect(() => canonicalJson(new Set())).toThrow(/plain|json/i)
    expect(() => canonicalJson({ value: 1n })).toThrow(/json|bigint/i)
    expect(() => canonicalJson({ value: Symbol('x') })).toThrow(/json|symbol/i)
    expect(() => canonicalJson({ value: () => {} })).toThrow(/json|function/i)
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/i)
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/finite/i)
  })

  it('domain-separates and length-binds hashes', () => {
    const policy = hashCanonical('policy', 1, { b: 2, a: 1 })
    expect(policy).toMatch(/^[a-f0-9]{64}$/)
    expect(policy).toBe(hashCanonical('policy', 1, { a: 1, b: 2 }))
    expect(policy).not.toBe(hashCanonical('inventory', 1, { a: 1, b: 2 }))
    expect(policy).not.toBe(hashCanonical('policy', 2, { a: 1, b: 2 }))
    expect(policy).not.toBe(hashCanonical('policy', 1, { a: 1, b: 3 }))
  })
})
