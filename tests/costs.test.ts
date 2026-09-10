import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG_EXTRA, FORMATS } from '../src/direct.ts'

const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Capture the next fetch call and answer with `body`. */
function captureFetch(body: unknown): { url: string; headers: Record<string, string> } {
  const seen = { url: '', headers: {} as Record<string, string> }
  globalThis.fetch = (async (input, init) => {
    seen.url = String(input)
    seen.headers = (init?.headers ?? {}) as Record<string, string>
    return jsonResponse(body)
  }) as typeof fetch
  return seen
}

const openaiAdapter = CATALOG_EXTRA.find((a) => a.id === 'openai-admin')!
const anthropicAdapter = CATALOG_EXTRA.find((a) => a.id === 'anthropic-admin')!

test('openai-admin adapter uses the Admin API costs endpoint with a Bearer key', async () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const day = 86400
  const seen = captureFetch({
    object: 'page',
    data: [
      { object: 'bucket', start_time: nowSec - 20 * day, results: [{ amount: { value: 1.5, currency: 'usd' } }] },
      { object: 'bucket', start_time: nowSec - 3 * day, results: [{ amount: { value: 2.25, currency: 'usd' } }] },
      { object: 'bucket', start_time: nowSec - 3600, results: [{ amount: { value: 0.5, currency: 'usd' } }] },
    ],
  })

  const snapshot = await openaiAdapter.fetch('sk-admin-test')

  assert.match(seen.url, /^https:\/\/api\.openai\.com\/v1\/organization\/costs\?start_time=\d+&bucket_width=1d&limit=31$/)
  assert.equal(seen.headers.Authorization, 'Bearer sk-admin-test')
  assert.deepEqual(snapshot.items.map((i) => [i.label, i.display]), [
    ['今日消耗', '$0.50'],
    ['近 7 天消耗', '$2.75'],
    ['近 30 天消耗', '$4.25'],
  ])
  assert.equal(snapshot.message, 'Admin API：仅用量/成本，余额见 OpenAI 后台')
})

test('anthropic-admin adapter sends x-api-key + anthropic-version and converts cents to USD', async () => {
  const day = 86400_000
  const seen = captureFetch({
    data: [
      { starting_at: new Date(Date.now() - 20 * day).toISOString(), results: [{ amount: '150.0', currency: 'USD' }] },
      { starting_at: new Date(Date.now() - 3 * day).toISOString(), results: [{ amount: '225.5', currency: 'USD' }] },
      { starting_at: new Date(Date.now() - 3600_000).toISOString(), results: [{ amount: '50.25', currency: 'USD' }] },
    ],
    has_more: false,
    next_page: null,
  })

  const snapshot = await anthropicAdapter.fetch('sk-ant-admin01-test')

  assert.match(seen.url, /^https:\/\/api\.anthropic\.com\/v1\/organizations\/cost_report\?starting_at=.*&bucket_width=1d&limit=31$/)
  assert.equal(seen.headers['x-api-key'], 'sk-ant-admin01-test')
  assert.equal(seen.headers['anthropic-version'], '2023-06-01')
  assert.equal(seen.headers.Authorization, undefined)
  // cents → dollars: 50.25 cents = $0.50 (rounded to cents for display)
  assert.deepEqual(snapshot.items.map((i) => [i.label, i.display]), [
    ['今日消耗', '$0.50'],
    ['近 7 天消耗', '$2.76'],
    ['近 30 天消耗', '$4.26'],
  ])
})

test('cost parsers fail loudly on empty buckets (no Admin API access)', async () => {
  assert.throws(() => FORMATS['openai-costs']!({ data: [] }), /Admin API access/)
  assert.throws(() => FORMATS['anthropic-costs']!({ data: [] }), /Admin API access/)
})
