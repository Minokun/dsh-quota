import assert from 'node:assert/strict'
import test from 'node:test'
import { DIRECT_ADAPTERS, customHttpFetch, zhipuAccountItems } from '../src/direct.ts'

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


// ── 智谱：API key 查余额（/api/biz/account/query-customer-account-report） ──

const zhipu = DIRECT_ADAPTERS.find((adapter) => adapter.id === 'zhipu')!

test('zhipu API key renders the standard-API balance without a console login', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(`${url} ${String((init?.headers as Record<string, string> | undefined)?.Authorization)}`)
    if (url.includes('/api/monitor/usage/quota/limit')) {
      return jsonResponse({
        code: 200,
        data: {
          planName: 'pro',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12, nextResetTime: 1793287132998 },
            { type: 'TIME_LIMIT', usage: 1000, currentValue: 10, remaining: 990, percentage: 1 },
          ],
        },
      })
    }
    if (url.includes('/api/biz/account/query-customer-account-report')) {
      return jsonResponse({
        code: 200,
        data: {
          balance: 0,
          // 与余额同源：可用余额优先
          availableBalance: 0,
          rechargeAmount: 120,
          giveAmount: 94.908478,
          totalSpendAmount: 214.908478,
          todaySpendAmount: null,
          frozenBalance: 0,
        },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const snapshot = await zhipu.fetch('test-key')

  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(snapshot.items, [
    { label: '5 小时窗口', percent: 12, display: '已用 12%', resetAt: new Date(1793287132998).toISOString() },
    { label: '搜索/工具额度', used: 10, limit: 1000, remaining: 990, percent: 1, resetAt: undefined },
    { label: '账户余额', display: '¥0' },
    { label: '累计消费', display: '¥214.91' },
  ])
  // 余额走的是标准 API key，不是控制台 JWT
  assert.match(calls[1] ?? '', /query-customer-account-report Bearer test-key/)
})

test('zhipu keeps the quota rows when the balance endpoint is forbidden', async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url.includes('/api/monitor/usage/quota/limit')) {
      return jsonResponse({ code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40 }] } })
    }
    return new Response('APIKey not allow access', { status: 403 })
  }) as typeof fetch

  const snapshot = await zhipu.fetch('test-key')
  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(snapshot.items, [{ label: '5 小时窗口', percent: 40, display: '已用 40%', resetAt: undefined }])
})

test('zhipuAccountItems prefers availableBalance and hides a zero today-spend', () => {
  assert.deepEqual(
    zhipuAccountItems({ data: { balance: 10, availableBalance: 5.5, totalSpendAmount: 0, todaySpendAmount: 0 } }),
    [{ label: '账户余额', display: '¥5.5' }, { label: '累计消费', display: '¥0' }],
  )
  assert.deepEqual(
    zhipuAccountItems({ balance: 7, totalSpendAmount: 214.908478, todaySpendAmount: 3.5 }),
    [
      { label: '账户余额', display: '¥7' },
      { label: '累计消费', display: '¥214.91' },
      { label: '今日消费', display: '¥3.5' },
    ],
  )
  assert.deepEqual(zhipuAccountItems({ data: {} }), [])
  assert.deepEqual(zhipuAccountItems(null), [])
})
