import assert from 'node:assert/strict'
import test from 'node:test'
import { jsonSafe } from '../src/json-safe.ts'

/** The harness rule set: nothing a JSON round trip would drop or change. */
function isLossless(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (Array.isArray(value)) return value.every((item) => isLossless(item))
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return false
  return Object.entries(value).every(([, item]) => isLossless(item))
}

test('jsonSafe omits undefined object properties', () => {
  const out = jsonSafe({ id: 'kimi', message: undefined, via: 'api' })
  assert.deepEqual(out, { id: 'kimi', via: 'api' })
  assert.equal(Object.hasOwn(out, 'message'), false)
})

test('jsonSafe drops non-finite numbers and -0', () => {
  const out = jsonSafe({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY, d: -0, keep: 0 })
  assert.deepEqual(out, { keep: 0 })
})

test('jsonSafe compacts arrays and keeps nested records', () => {
  const out = jsonSafe({
    items: [{ label: '周额度', used: 43, resetAt: undefined }, undefined, { label: '余额', display: '¥1' }],
  })
  assert.deepEqual(out, { items: [{ label: '周额度', used: 43 }, { label: '余额', display: '¥1' }] })
})

test('jsonSafe output satisfies the harness lossless-JSON rule', () => {
  const snapshot = {
    refreshedAt: '2026-09-19T15:04:33.462Z',
    providers: [
      {
        id: 'kimi',
        label: 'Kimi Code',
        status: 'ok',
        message: undefined,
        via: 'api',
        items: [
          {
            label: '周额度',
            used: 43,
            limit: 100,
            remaining: 57,
            percent: 43,
            resetAt: undefined,
            burnRatePerHour: Number.POSITIVE_INFINITY,
          },
        ],
      },
    ],
  }
  assert.equal(isLossless(snapshot), false)
  assert.equal(isLossless(jsonSafe(snapshot)), true)
})

test('jsonSafe leaves an already JSON-ready snapshot untouched', () => {
  const value = {
    refreshedAt: '2026-09-19T15:04:33.462Z',
    providers: [{ id: 'deepseek', label: 'DeepSeek', status: 'ok', items: [{ label: 'CNY 总余额', display: '¥36.45' }] }],
  }
  assert.deepEqual(jsonSafe(value), value)
})
