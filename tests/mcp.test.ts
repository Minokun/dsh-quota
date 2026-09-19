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
