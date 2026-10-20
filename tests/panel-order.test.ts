import assert from 'node:assert/strict'
import test from 'node:test'
import { orderProviders, providerRowOf } from '../src/client/panel-order.ts'
import type { PanelProvider } from '../src/client/controller.ts'

/** Minimal provider row (the ordering helpers only touch id/keyRef/status). */
function row(id: string, keyRef?: string, status: PanelProvider['status'] = 'ok'): PanelProvider {
  return { id, label: id, keyRef, status, items: [] }
}

const ROWS: PanelProvider[] = [
  row('kimi'),
  row('deepseek', 'DEEPSEEK_API_KEY'),
  row('zhipu'),
  row('qianwen'),
]

test('providerRowOf: exact apiKeyEnv ref wins over the platform id (same platform, two accounts)', () => {
  const rows = [row('deepseek', 'DEEPSEEK_API_KEY_A'), row('deepseek#2', 'DEEPSEEK_API_KEY_B')]
  const refs = { 'deepseek-b': 'DEEPSEEK_API_KEY_B' }
  assert.equal(providerRowOf(rows, 'deepseek-b', refs)?.id, 'deepseek#2')
})

test('providerRowOf: falls back to the platform id and its #-suffixed variants', () => {
  assert.equal(providerRowOf([row('kimi#2')], 'kimi', {})?.id, 'kimi#2')
  assert.equal(providerRowOf([row('kimi')], 'kimi', {})?.id, 'kimi')
})

test('providerRowOf: a custom platform row matches by apiKeyEnv even without a built-in platform mapping', () => {
  const rows = [row('my-agg', 'MY_AGG_KEY'), row('kimi')]
  const refs = { 'aggregator-proxy': 'MY_AGG_KEY' }
  assert.equal(providerRowOf(rows, 'aggregator-proxy', refs)?.id, 'my-agg')
  assert.deepEqual(orderProviders(rows, 'aggregator-proxy', refs).map((p) => p.id), ['my-agg', 'kimi'])
})

test('providerRowOf: unknown or empty provider resolves to nothing', () => {
  assert.equal(providerRowOf(ROWS, '', {}), undefined)
  assert.equal(providerRowOf(ROWS, 'some-unknown-provider', {}), undefined)
  // Not configured in the panel → the ref cannot match either.
  assert.equal(providerRowOf(ROWS, 'deepseek', { deepseek: 'DEEPSEEK_API_KEY' })?.id, 'deepseek')
  assert.equal(providerRowOf(ROWS, 'deepseek', { deepseek: 'OTHER_KEY' })?.id, 'deepseek')
})

test('orderProviders: the platform in use is pinned first, the rest keep host order', () => {
  const ordered = orderProviders(ROWS, 'zhipu', {})
  assert.deepEqual(ordered.map((p) => p.id), ['zhipu', 'kimi', 'deepseek', 'qianwen'])
})

test('orderProviders: an unresolved platform leaves the order untouched (and never drops a row)', () => {
  const ordered = orderProviders(ROWS, 'not-a-platform', {})
  assert.deepEqual(ordered.map((p) => p.id), ROWS.map((p) => p.id))
  assert.equal(ordered.length, ROWS.length)
  // The input array is not mutated in place.
  assert.deepEqual(ROWS.map((p) => p.id), ['kimi', 'deepseek', 'zhipu', 'qianwen'])
})

test('orderProviders: multi-account platform pins only the exact-ref row', () => {
  const rows = [row('deepseek', 'DEEPSEEK_API_KEY_A'), row('deepseek#2', 'DEEPSEEK_API_KEY_B'), row('kimi')]
  const ordered = orderProviders(rows, 'deepseek-b', { 'deepseek-b': 'DEEPSEEK_API_KEY_B' })
  assert.deepEqual(ordered.map((p) => p.id), ['deepseek#2', 'deepseek', 'kimi'])
})
