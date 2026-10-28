import assert from 'node:assert/strict'
import test from 'node:test'
import { customHttpFetch, CATALOG_EXTRA } from '../src/direct.ts'

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

const minimax = CATALOG_EXTRA.find((a) => a.id === 'minimax-cn')!

test('minimax adapter reports the 5h window and the weekly window', async () => {
  globalThis.fetch = (async () => jsonResponse({
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [{
      start_time: 1793167724570,
      end_time: 1793185724570,
      remains_time: 5580565,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: 'general',
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1792910410812,
      weekly_end_time: 1793515210812,
      weekly_remains_time: 335066807,
      current_interval_status: 1,
      current_interval_remaining_percent: 65,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 37,
    }],
  })) as typeof fetch

  const snapshot = await minimax.fetch('secret')

  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(snapshot.items, [
    { label: '5h 窗口', percent: 35, display: '已用 35%', resetAt: '2026-10-28T11:08:44.570Z' },
    { label: '本周窗口', percent: 63, display: '已用 63%', resetAt: '2026-11-01T06:40:10.812Z' },
  ])
})

test('minimax adapter still reports the 5h window when the weekly fields are absent', async () => {
  globalThis.fetch = (async () => jsonResponse({
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [{
      end_time: 1793185724570,
      current_interval_total_count: 12000,
      current_interval_usage_count: 4000,
      current_interval_remaining_percent: 65,
    }],
  })) as typeof fetch

  const snapshot = await minimax.fetch('secret')

  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.items[0]?.label, '5h 窗口')
  assert.equal(snapshot.items[0]?.percent, 35)
})
