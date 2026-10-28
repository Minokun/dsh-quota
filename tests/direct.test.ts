import assert from 'node:assert/strict'
import test from 'node:test'
import { customHttpFetch, DIRECT_ADAPTERS } from '../src/direct.ts'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test.after(() => {
  globalThis.fetch = originalFetch
})

test('openai-billing converts total_usage cents to dollars', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    return url.endsWith('/subscription')
      ? jsonResponse({ hard_limit_usd: 20 })
      : jsonResponse({ total_usage: 350 })
  }) as typeof fetch

  const result = await customHttpFetch({ id: 'hub', label: 'Hub', endpoint: 'https://hub.example.com', keyRef: 'HUB_KEY', format: 'openai-billing' })('secret')

  assert.deepEqual(calls, [
    'https://hub.example.com/v1/dashboard/billing/subscription',
    'https://hub.example.com/v1/dashboard/billing/usage',
  ])
  assert.equal(result.items[0]?.used, 3.5)
  assert.equal(result.items[0]?.remaining, 16.5)
  // display stays free of the remaining amount — the panel appends 剩{remaining} itself.
  assert.equal(result.items[0]?.display, '$3.50 / $20.00')
})

test('openai-billing renders NewAPI unlimited-token sentinel without a fake limit', async () => {
  globalThis.fetch = (async (input) => String(input).endsWith('/subscription')
    ? jsonResponse({ hard_limit_usd: 100000000 })
    : jsonResponse({ total_usage: 1692.5988 })) as typeof fetch

  const result = await customHttpFetch({ id: 'hub', label: 'Hub', endpoint: 'https://hub.example.com', keyRef: 'HUB_KEY', format: 'openai-billing' })('secret')

  assert.equal(result.items[0]?.percent, undefined)
  assert.equal(result.items[0]?.display, '已用 $16.925988 · 无限额度')
})

test('newapi-account requests account quota with the required user header', async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://newapi.example.com/api/user/self')
    assert.deepEqual(init?.headers, {
      Authorization: 'Bearer system-access-token',
      'New-Api-User': '123',
    })
    return jsonResponse({ success: true, data: { quota: 18713632, used_quota: 1250000 } })
  }) as typeof fetch

  const result = await customHttpFetch({
    id: 'account',
    label: 'Account',
    endpoint: 'https://newapi.example.com',
    keyRef: 'NEWAPI_ACCESS_TOKEN',
    format: 'newapi-account',
    userId: '123',
    quotaPerUnit: 500000,
  })('system-access-token')

  assert.deepEqual(result.items, [
    { label: '账户余额 (USD)', display: '$37.427264' },
    { label: '累计已用 (USD)', display: '$2.50' },
  ])
})

test('newapi-account rejects a missing user id before sending a request', async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return jsonResponse({})
  }) as typeof fetch

  const fetchQuota = customHttpFetch({ id: 'account', label: 'Account', endpoint: 'https://newapi.example.com', keyRef: 'NEWAPI_ACCESS_TOKEN', format: 'newapi-account' })
  await assert.rejects(fetchQuota('system-access-token'), /userId must be a positive integer/)
  assert.equal(called, false)
})

const zhipu = DIRECT_ADAPTERS.find((a) => a.id === 'zhipu')!

test('zhipu adapter reads CREDIT_LIMIT windows (the Coding Plan meters credits, not tokens)', async () => {
  globalThis.fetch = (async () => jsonResponse({
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 9132, remaining: 2867, percentage: 76, nextResetTime: 1793184944153 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 60017, remaining: 0, percentage: 100, nextResetTime: 1793603577964 },
      ],
      level: 'pro',
    },
  })) as typeof fetch

  const snapshot = await zhipu.fetch('secret')

  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.label, '智谱 Coding Plan · pro')
  assert.deepEqual(snapshot.items, [
    { label: '5 小时窗口', used: 9132, limit: 12000, remaining: 2867, percent: 76, display: '已用 76%', resetAt: '2026-10-28T10:55:44.153Z' },
    { label: '本周窗口', used: 60017, limit: 60000, remaining: 0, percent: 100, display: '已用 100%', resetAt: '2026-11-02T07:12:57.964Z' },
  ])
})

test('zhipu adapter still reads TOKENS_LIMIT windows', async () => {
  globalThis.fetch = (async () => jsonResponse({
    code: 200,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 9132, remaining: 2867, percentage: 76, nextResetTime: 1793184944153 },
      ],
    },
  })) as typeof fetch

  const snapshot = await zhipu.fetch('secret')

  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.items[0]?.label, '5 小时窗口')
  assert.equal(snapshot.items[0]?.remaining, 2867)
  assert.equal(snapshot.items[0]?.percent, 76)
})
