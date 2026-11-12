import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProviderSnapshot } from '../src/config.ts'
import {
  MAGPIE_PLATFORM_ID,
  fetchMagpieRows,
  magpieBaseUrl,
  magpieRowForModel,
  magpieWindowItem,
  mergeMagpieSpend,
  parseMagpieSpend,
  magpieWindowLabel,
  parseMagpieQuotas,
  dropDuplicateSubscriptionRows,
} from '../src/magpie.ts'

// ── 窗口名 ───────────────────────────────────────────────────────────────────

test('window names translate to the panel vocabulary', () => {
  // 这些标签必须命中 summarize() 的 /窗口|周|余额|额度|金额|消耗/，否则 pill 没摘要。
  assert.equal(magpieWindowLabel('5 hours'), '5 小时窗口')
  assert.equal(magpieWindowLabel('30 days'), '30 天窗口')
  assert.equal(magpieWindowLabel('7 days'), '7 天窗口')
  assert.equal(magpieWindowLabel('MCP · Month'), 'MCP 月度额度')
  assert.equal(magpieWindowLabel('Extra usage'), '额外额度')
  // 认不出的原样返回，绝不吞掉窗口。
  assert.equal(magpieWindowLabel('Rolling fortnight'), 'Rolling fortnight')
  assert.equal(magpieWindowLabel(undefined), '额度')
})

// ── 单项三车道 ───────────────────────────────────────────────────────────────

test('a percent window turns into 已用 N% and never double-renders remaining', () => {
  // 真实载荷：Kimi 的 7 天窗口，used/remaining 互补为 100。
  const item = magpieWindowItem({ name: '7 days', used: 99.97, remaining: 0.030000000000001137, resetsAt: '2026-11-13T00:23:45Z' })
  assert.equal(item.label, '7 天窗口')
  assert.equal(item.percent, 99.97)
  assert.equal(item.display, '已用 99.97%')
  // remaining 不设：设了面板会在条后追加「剩 0.03」，与 display 的百分比重复。
  assert.equal(item.remaining, undefined)
  assert.equal(item.resetAt, '2026-11-13T00:23:45Z')
})

test('remaining alone still yields a percent (used missing after a reset)', () => {
  const item = magpieWindowItem({ name: '5 hours', remaining: 100 })
  assert.equal(item.percent, 0)
  assert.equal(item.display, '已用 0%')
})

test('a counted window keeps the upstream display string as the reading', () => {
  // 真实载荷：ZCode 的 MCP · Month → display "0 / 1000", limit 1000。
  const item = magpieWindowItem({ name: 'MCP · Month', used: 0, remaining: 100, display: '0 / 1000', limit: 1000, resetsAt: '2026-11-29T15:18:52.999Z' })
  assert.equal(item.label, 'MCP 月度额度')
  assert.equal(item.display, '0 / 1000')
  assert.equal(item.percent, 0)
  assert.equal(item.resetAt, '2026-11-29T15:18:52.999Z')
})

test('a money window renders the balance instead of a bar', () => {
  // 真实载荷：Kimi 的 Extra usage → unit CNY, balance 0。
  const cny = magpieWindowItem({ name: 'Extra usage', used: 0, unit: 'CNY', balance: 0 })
  assert.equal(cny.label, '额外额度')
  assert.equal(cny.display, '¥0')
  assert.equal(cny.percent, undefined)
  const usd = magpieWindowItem({ name: 'Extra usage', unit: 'USD', balance: 12.5 })
  assert.equal(usd.display, '$12.5')
})

// ── 行组装 ───────────────────────────────────────────────────────────────────

/** 本机真实网关返回的 `data[]`（2026-11-10 实测，已裁剪无关字段）。 */
const REAL_BODY = {
  data: [
    { provider: 'codex', name: 'Codex', kind: 'subscription', plan: 'free', user: '952718180@qq.com',
      windows: [{ name: '30 days', used: 0, remaining: 100, resetsAt: '2026-12-10T15:56:52+08:00', holdsWhy: 'low' }] },
    { provider: 'zcode', name: 'ZCode', kind: 'subscription', plan: 'GLM Coding Pro', user: 'ZCode',
      windows: [{ name: '5 hours', used: 0, remaining: 100 }, { name: 'MCP · Month', used: 0, remaining: 100, resetsAt: '2026-11-29T15:18:52.999Z', display: '0 / 1000', limit: 1000 }],
      until: '2027-03-27T16:00:00Z', renew: 'off' },
    { provider: 'kimi', name: 'Kimi Code', kind: 'plan',
      windows: [{ name: '5 hours', used: 0, remaining: 100 }, { name: '7 days', used: 99.97, remaining: 0.03 }, { name: 'Extra usage', used: 0, remaining: 100, unit: 'CNY', balance: 0 }] },
    { provider: 'zhipu', name: 'Zhipu GLM', kind: 'plan', plan: 'pro',
      windows: [{ name: 'MCP · Month', used: 0, remaining: 100 }, { name: '5 hours', used: 0, remaining: 100 }], until: '2027-03-28T00:00:00+08:00', renew: 'off' },
    { provider: 'zhipu', name: 'Zhipu GLM', kind: 'balance', windows: [], balance: '¥0.00' },
  ],
  object: 'list',
}

test('one row per provider, and the balance card merges into its plan row', () => {
  const rows = parseMagpieQuotas(REAL_BODY)
  assert.deepEqual(rows.map((r) => r.id), [
    `${MAGPIE_PLATFORM_ID}#codex`,
    `${MAGPIE_PLATFORM_ID}#zcode`,
    `${MAGPIE_PLATFORM_ID}#kimi`,
    `${MAGPIE_PLATFORM_ID}#zhipu`,
  ])
  // 智谱的 plan 卡与 balance 卡是同一账号：余额并进那行，不单独成行。
  const zhipu = rows.find((r) => r.id === `${MAGPIE_PLATFORM_ID}#zhipu`)
  assert.deepEqual(zhipu?.items.map((i) => i.label), ['MCP 月度额度', '5 小时窗口', '账户余额'])
  assert.equal(zhipu?.items.at(-1)?.display, '¥0.00')
  assert.equal(zhipu?.label, 'Magpie · Zhipu GLM · pro')
})

test('a row carries the account and expiry as the gray note', () => {
  const rows = parseMagpieQuotas(REAL_BODY)
  const zcode = rows.find((r) => r.id === `${MAGPIE_PLATFORM_ID}#zcode`)
  assert.equal(zcode?.message, '账号 ZCode · 有效期至 2027-03-27 · 不自动续费')
  const kimi = rows.find((r) => r.id === `${MAGPIE_PLATFORM_ID}#kimi`)
  assert.equal(kimi?.message, undefined, '没有账号/有效期信息时不留空注释')
})

test('every row is ok/api so the panel never shows a red magpie card', () => {
  for (const row of parseMagpieQuotas(REAL_BODY)) {
    assert.equal(row.status, 'ok')
    assert.equal(row.via, 'api')
    assert.ok(row.items.length > 0)
  }
})

test('an empty card (not signed in) is dropped instead of rendering blank', () => {
  // 真实载荷：Gemini 未登录时是 windows: []，没有余额卡。
  const rows = parseMagpieQuotas({ data: [{ provider: 'gemini', name: 'Gemini CLI', kind: 'subscription', windows: [] }] })
  assert.deepEqual(rows, [])
})

test('a balance-only account still gets a row', () => {
  const rows = parseMagpieQuotas({ data: [{ provider: 'relay', name: '我的中转站', kind: 'balance', windows: [], balance: '$12.34' }] })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]?.items, [{ label: '账户余额', display: '$12.34' }])
})

test('two accounts under one provider split into two rows', () => {
  const rows = parseMagpieQuotas({
    data: [
      { provider: 'claude', name: 'Claude', kind: 'subscription', user: 'a@x.com', windows: [{ name: '5 hours', used: 10, remaining: 90 }] },
      { provider: 'claude', name: 'Claude', kind: 'subscription', user: 'b@x.com', windows: [{ name: '5 hours', used: 40, remaining: 60 }] },
    ],
  })
  assert.deepEqual(rows.map((r) => r.id), [`${MAGPIE_PLATFORM_ID}#claude/a@x.com`, `${MAGPIE_PLATFORM_ID}#claude/b@x.com`])
  assert.deepEqual(rows.map((r) => r.items[0]?.percent), [10, 40])
})

test('a malformed body throws instead of silently blanking the panel', () => {
  assert.throws(() => parseMagpieQuotas({ object: 'list' }), /data\[\]/)
  assert.throws(() => parseMagpieQuotas(null), /data\[\]/)
})

// ── 当前模型认领 ─────────────────────────────────────────────────────────────

test('the row for the running model is picked by the model id prefix', () => {
  const rows = parseMagpieQuotas(REAL_BODY)
  // 所有 magpie 行共用同一个凭证引用，按 provider 前缀才认得出是哪一行。
  assert.equal(magpieRowForModel(rows, 'codex/gpt-5.6-terra')?.id, `${MAGPIE_PLATFORM_ID}#codex`)
  assert.equal(magpieRowForModel(rows, 'kimi/k3.1-pro')?.id, `${MAGPIE_PLATFORM_ID}#kimi`)
  // 网关里有这个 provider 但模型不在其中 → 认领该 provider 的行。
  assert.equal(magpieRowForModel(rows, 'zhipu/glm-5.3')?.id, `${MAGPIE_PLATFORM_ID}#zhipu`)
  // 网关里没有的 provider（如 sidrune 走的是普通 API key）→ 不认领。
  assert.equal(magpieRowForModel(rows, 'sidrune/claude-sonnet-5-5'), undefined)
  assert.equal(magpieRowForModel(rows, ''), undefined)
})

// ── 用量记账 ─────────────────────────────────────────────────────────────────

/** `/v1/magpie/usage?period=30d` 的真实形状（已裁剪 series[]）。 */
const REAL_USAGE = {
  period: '30d',
  calls: 481,
  cost: 35.15,
  models: [
    { id: 'sidrune/claude-sonnet-5-5', provider: 'sidrune', calls: 392, cost: 17.03 },
    { id: 'codex/gpt-5.6-terra', provider: 'codex', calls: 21, cost: 0.453 },
    { id: 'sidrune/claude-fable-5-2', provider: 'sidrune', calls: 35, cost: 17.67 },
  ],
  providerKeys: [{ id: 'sidrune#28d6ad7c3a', provider: 'sidrune', calls: 433, cost: 35.01 }],
}

test('spend sums per provider from models and lets providerKeys override', () => {
  const spend = parseMagpieSpend(REAL_USAGE)
  // providerKeys 只列带 key 的供应商：codex 这种订阅账号只出现在 models 里，
  // 所以只读 providerKeys 会把它整行漏掉。
  assert.deepEqual(spend, [
    { provider: 'sidrune', calls: 433, cost: 35.01 },
    { provider: 'codex', calls: 21, cost: 0.453 },
  ])
})

test('spend lines merge onto the matching quota row', () => {
  const rows = mergeMagpieSpend(parseMagpieQuotas(REAL_BODY), parseMagpieSpend(REAL_USAGE))
  const codex = rows.find((r) => r.id === `${MAGPIE_PLATFORM_ID}#codex`)
  // 额度窗口在前，消耗垫后。
  assert.deepEqual(codex?.items.map((i) => i.label), ['30 天窗口', '近 30 天消耗'])
  assert.equal(codex?.items[1]?.display, '$0.453 · 21 次')
})

test('a pay-as-you-go provider with no quota card still gets a row', () => {
  const rows = mergeMagpieSpend(parseMagpieQuotas(REAL_BODY), parseMagpieSpend(REAL_USAGE))
  // sidrune 在 /v1/magpie/quotas 里没有卡片，但它是真正花钱的那个。
  const sidrune = rows.find((r) => r.id === `${MAGPIE_PLATFORM_ID}#sidrune`)
  assert.equal(sidrune?.label, 'Magpie · sidrune')
  assert.deepEqual(sidrune?.items.map((i) => i.label), ['近 30 天消耗'])
  assert.equal(sidrune?.status, 'ok')
})

test('an empty or unparsable usage body contributes nothing', () => {
  assert.deepEqual(parseMagpieSpend({}), [])
  assert.deepEqual(parseMagpieSpend(null), [])
  const rows = parseMagpieQuotas(REAL_BODY)
  assert.deepEqual(mergeMagpieSpend(rows, []).length, rows.length)
})

test('a usage failure leaves the quota rows untouched', async () => {
  // 额度接口正常、用量接口 500：花费没了，额度行照旧。
  let call = 0
  const halfBroken = (async (url: string) => {
    call += 1
    const isUsage = String(url).includes('/usage')
    return { ok: !isUsage, status: isUsage ? 500 : 200, json: async () => REAL_BODY } as unknown as Response
  }) as unknown as typeof fetch
  const rows = await fetchMagpieRows({ fetchImpl: halfBroken, now: () => 1, baseUrl: 'http://127.0.0.1:3425' })
  assert.equal(call, 2)
  assert.deepEqual(rows.map((r) => r.id), [
    `${MAGPIE_PLATFORM_ID}#codex`,
    `${MAGPIE_PLATFORM_ID}#zcode`,
    `${MAGPIE_PLATFORM_ID}#kimi`,
    `${MAGPIE_PLATFORM_ID}#zhipu`,
  ])
})

// ── 网关地址与网络 ───────────────────────────────────────────────────────────

test('the gateway URL defaults to the loopback port and honours MAGPIE_URL', () => {
  assert.equal(magpieBaseUrl({}), 'http://127.0.0.1:3425')
  assert.equal(magpieBaseUrl({ MAGPIE_URL: 'http://127.0.0.1:4000//' }), 'http://127.0.0.1:4000')
})

/** A fetch stand-in that answers one canned body. */
function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch
}

test('fetchMagpieRows parses the live payload shape', async () => {
  const rows = await fetchMagpieRows({ fetchImpl: fakeFetch(REAL_BODY), now: () => 1, baseUrl: 'http://127.0.0.1:3425' })
  assert.equal(rows.length, 4)
  assert.equal(rows[0]?.id, `${MAGPIE_PLATFORM_ID}#codex`)
})

test('a gateway that is not running yields no rows (probe fallback stays)', async () => {
  const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
  assert.deepEqual(await fetchMagpieRows({ fetchImpl: down, now: () => 1, baseUrl: 'http://127.0.0.1:3425' }), [])
})

test('a non-2xx answer yields no rows rather than a red card', async () => {
  assert.deepEqual(await fetchMagpieRows({ fetchImpl: fakeFetch({}, false, 503), now: () => 1, baseUrl: 'http://127.0.0.1:3425' }), [])
})

// ── 与内置订阅行去重 ─────────────────────────────────────────────────────────

test('the built-in Codex row steps aside when magpie reports that account', () => {
  // 两边读同一份 ~/.codex/auth.json；magpie 带代理与 token 续期，直连那条在
  // 需要代理的网络里只会红成「fetch failed」。
  const magpieRows = parseMagpieQuotas(REAL_BODY)
  const subscriptions: ProviderSnapshot[] = [
    { id: 'codex', label: 'Codex', status: 'error', message: 'fetch failed', via: 'api', items: [] },
    { id: 'claude-code', label: 'Claude Code', status: 'ok', via: 'api', items: [{ label: '5 小时窗口', percent: 12 }] },
  ]
  const kept = dropDuplicateSubscriptionRows(subscriptions, magpieRows)
  // codex 被 magpie#codex 替换；claude 网关里没有 → 内置行必须留着。
  assert.deepEqual(kept.map((r) => r.id), ['claude-code'])
})

test('the built-in row stays when magpie has no quota for that account', () => {
  // 网关没跑（空数组）、或该 provider 的行是空的/失败的 → 不能丢内置行。
  const subscriptions: ProviderSnapshot[] = [
    { id: 'codex', label: 'Codex', status: 'error', message: 'fetch failed', via: 'api', items: [] },
  ]
  assert.deepEqual(dropDuplicateSubscriptionRows(subscriptions, []).map((r) => r.id), ['codex'])
  const emptyMagpie: ProviderSnapshot[] = [{ id: `${MAGPIE_PLATFORM_ID}#codex`, label: 'Magpie · Codex', status: 'ok', via: 'api', items: [] }]
  assert.deepEqual(dropDuplicateSubscriptionRows(subscriptions, emptyMagpie).map((r) => r.id), ['codex'])
  const failedMagpie: ProviderSnapshot[] = [{ id: `${MAGPIE_PLATFORM_ID}#codex`, label: 'Magpie · Codex', status: 'error', message: 'x', via: 'api', items: [] }]
  assert.deepEqual(dropDuplicateSubscriptionRows(subscriptions, failedMagpie).map((r) => r.id), ['codex'])
})

test('claude-code yields to a magpie claude row once the gateway has one', () => {
  // 用户在 magpie 里加了 Claude 订阅后，内置 Claude Code 行同样让位。
  const magpieRows = parseMagpieQuotas({
    data: [{ provider: 'claude', name: 'Claude', kind: 'subscription', user: 'a@x.com', windows: [{ name: '5 hours', used: 20, remaining: 80 }] }],
  })
  const subscriptions: ProviderSnapshot[] = [
    { id: 'claude-code', label: 'Claude Code', status: 'ok', via: 'api', items: [{ label: '5 小时窗口', percent: 20 }] },
  ]
  assert.deepEqual(dropDuplicateSubscriptionRows(subscriptions, magpieRows), [])
})
