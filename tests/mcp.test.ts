import assert from 'node:assert/strict'
import test from 'node:test'
import { MCP_ADAPTERS } from '../src/mcp.ts'

const supawriter = MCP_ADAPTERS.find((adapter) => adapter.id === 'supawriter')!

function parse(value: unknown): ReturnType<typeof supawriter.parse> {
  return supawriter.parse([{ name: 'mcp__supawriter__sw_status', value }])
}

test('supawriter prefers the subscription quota over the legacy dashboard pair', () => {
  const items = parse({
    loggedIn: true,
    user: { membership_tier: 'superuser' },
    // The legacy pair the panel used to show: 73 is the all-time article count.
    dashboard: { monthly_articles: 73, quota_used: 73, quota_total: 300 },
    quota: { plan_quota: 999999, plan_used: 4, plan_remaining: 999995 },
  })
  assert.deepEqual(items, [
    { label: '月度文章额度', used: 4, limit: 999999, remaining: 999995, percent: 0 },
    { label: '会员', display: 'superuser' },
  ])
})

test('supawriter falls back to the dashboard pair when the MCP reports no quota', () => {
  const items = parse({ loggedIn: true, dashboard: { monthly_articles: 73, quota_used: 73, quota_total: 300 } })
  assert.deepEqual(items, [{ label: '月度文章额度', used: 73, limit: 300, remaining: 227, percent: 24.3 }])
})

test('supawriter reports a logged-out MCP as such', () => {
  assert.deepEqual(parse({ loggedIn: false }), [{ label: '登录态', display: '未登录' }])
})

// ── BigModel ────────────────────────────────────────────────────────────────

const bigmodel = MCP_ADAPTERS.find((adapter) => adapter.id === 'bigmodel')!

/** Feed results in `adapter.calls` order, like `runMcpAdapter` does. */
function parseBigmodel(account: unknown, subscriptions: unknown): ReturnType<typeof bigmodel.parse> {
  const valueOf: Record<string, unknown> = {
    mcp__bigmodel__bm_account_set: account,
    mcp__bigmodel__bm_subscription_list: subscriptions,
  }
  return bigmodel.parse(bigmodel.calls.map((call) => ({ name: call.name, value: valueOf[call.name] })))
}

test('bigmodel shows the coding subscription next to the account balance', () => {
  const items = parseBigmodel(
    { basicCustomerInfo: { customerName: 'mpvseed9', balance: 0 } },
    [
      { productName: 'GLM Coding Pro', status: 'VALID', valid: '2027-03-28 10:00:00-2028-03-28 10:00:00' },
      { productName: 'GLM Coding Pro', status: 'VALID', valid: '2027-03-28 10:00:00-2027-04-28 10:00:00' },
    ],
  )
  assert.deepEqual(items, [
    { label: 'GLM Coding Pro', display: '生效中 · 至 2028-03-28' },
    { label: '账户余额', display: '¥0' },
    { label: '账户', display: 'mpvseed9' },
  ])
})

test('bigmodel keeps the balance row when the subscription call returns nothing', () => {
  const items = parseBigmodel({ basicCustomerInfo: { customerName: 'mpvseed9', balance: 12.5 } }, [])
  assert.deepEqual(items, [
    { label: '账户余额', display: '¥12.5' },
    { label: '账户', display: 'mpvseed9' },
  ])
})

test('bigmodel marks an ended subscription instead of pretending it is active', () => {
  const items = bigmodel.parse([
    {
      name: 'mcp__bigmodel__bm_subscription_list',
      value: [{ productName: 'GLM Coding Pro', status: 'EXPIRED', valid: '2025-01-01 10:00:00-2025-02-01 10:00:00' }],
    },
  ])
  assert.deepEqual(items, [{ label: 'GLM Coding Pro', display: '已结束 · 原至 2025-02-01' }])
})
