import assert from 'node:assert/strict'
import test from 'node:test'
import { MCP_ADAPTERS, batchExecuteCapable, callTool, runMcpAdapter } from '../src/mcp.ts'

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

// ── ctx.tools.execute generation compatibility ──────────────────────────────

/**
 * DSH 0.2.2 switched `tools.execute` from one call to a `{ calls, signal }`
 * batch and moved dispatch behind a selected executor. Sending the legacy
 * single-call input to a 0.2.2 runtime reaches the batch scheduler, which
 * throws `ToolBatchExecutionError` ("Tool batch execution failed") before any
 * tool body runs — the BigModel row reported exactly that after upgrading.
 * Both input shapes must therefore keep working.
 */
function fakeTools(shape: 'legacy' | 'batch', reply: unknown | Error): { execute(input: unknown): Promise<unknown>; seen: unknown[]; selectExecutor?: () => void; definitions?: () => [] } {
  const seen: unknown[] = []
  const record = (input: unknown): void => {
    seen.push(input)
  }
  if (shape === 'batch') {
    return {
      seen,
      selectExecutor: () => undefined,
      definitions: () => [],
      async execute(input) {
        record(input)
        if (reply instanceof Error) throw reply
        return { results: [{ callId: 'c1', result: reply }], additionalContexts: [], concluded: false }
      },
    }
  }
  return {
    seen,
    async execute(input) {
      record(input)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
}

test('callTool encodes a one-call batch for the 0.2.2 executor', async () => {
  const tools = fakeTools('batch', {
    isError: false,
    value: { content: [{ type: 'text', text: '{"basicCustomerInfo":{"balance":1}}' }] },
    content: [],
  })
  const outcome = await callTool(tools, 'mcp__bigmodel__bm_account_set', { pageSize: 9999 }, AbortSignal.timeout(1000))
  assert.equal(outcome.isError, false)
  assert.deepEqual(outcome.value, { content: [{ type: 'text', text: '{"basicCustomerInfo":{"balance":1}}' }] })
  const input = tools.seen[0] as { calls: Array<{ type: string; name: string; arguments: string }>; signal: AbortSignal }
  assert.equal(input.calls.length, 1)
  assert.equal(input.calls[0]!.type, 'tool-call')
  assert.equal(input.calls[0]!.name, 'mcp__bigmodel__bm_account_set')
  assert.deepEqual(JSON.parse(input.calls[0]!.arguments), { pageSize: 9999 })
})

test('callTool normalizes a failed batch result to a message', async () => {
  const tools = fakeTools('batch', { isError: true, error: { message: 'upstream 500' }, content: [] })
  assert.deepEqual(await callTool(tools, 'mcp__bigmodel__bm_account_set', {}, AbortSignal.timeout(1000)), {
    isError: true,
    message: 'upstream 500',
  })
})

test('callTool keeps the legacy single-call shape for 0.2.1 runtimes', async () => {
  const tools = fakeTools('legacy', { isError: false, value: { ok: 1 } })
  const outcome = await callTool(tools, 'mcp__bigmodel__bm_account_set', {}, AbortSignal.timeout(1000))
  assert.deepEqual(outcome, { isError: false, value: { ok: 1 } })
  const input = tools.seen[0] as { callId: string; name: string; arguments: Record<string, unknown> }
  assert.equal(input.name, 'mcp__bigmodel__bm_account_set')
  assert.deepEqual(input.arguments, {})
  assert.equal(typeof input.callId, 'string')
})

test('batchExecuteCapable discriminates the two executor generations', () => {
  assert.equal(batchExecuteCapable(fakeTools('batch', {})), true)
  assert.equal(batchExecuteCapable(fakeTools('legacy', {})), false)
})

test('runMcpAdapter reads BigModel through the batch executor instead of erroring out', async () => {
  const account = { content: [{ type: 'text', text: JSON.stringify({ basicCustomerInfo: { customerName: 'mpvseed9', balance: 0 } }) }] }
  const subs = { content: [{ type: 'text', text: JSON.stringify([{ productName: 'GLM Coding Pro', status: 'VALID', valid: '2027-03-28 10:00:00-2028-03-28 10:00:00' }]) }] }
  let call = 0
  const tools = {
    selectExecutor: () => undefined,
    definitions: () => [],
    async execute() {
      call += 1
      const result = call === 1 ? subs : account
      return { results: [{ callId: 'c', result: { isError: false, value: result, content: [] } }], additionalContexts: [], concluded: false }
    },
  }
  const snapshot = await runMcpAdapter(tools as never, bigmodel)
  assert.equal(snapshot.status, 'ok')
  assert.deepEqual(snapshot.items, [
    { label: 'GLM Coding Pro', display: '生效中 · 至 2028-03-28' },
    { label: '账户余额', display: '¥0' },
    { label: '账户', display: 'mpvseed9' },
  ])
})

test('runMcpAdapter reports a surfacing error instead of a fake ok row', async () => {
  const tools = fakeTools('batch', { isError: true, error: { message: 'Tool batch execution failed' }, content: [] })
  const snapshot = await runMcpAdapter(tools as never, bigmodel)
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.message, 'Tool batch execution failed')
})
