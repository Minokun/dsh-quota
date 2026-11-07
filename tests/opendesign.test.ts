import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG_EXTRA, fetchOpendesignSnapshot, opendesignPlanItems } from '../src/direct.ts'

const originalFetch = globalThis.fetch

/** 控制面响应合成为一个假 fetch，按路径分派。 */
function controlPlaneFetch(routes: Record<string, unknown>, status = 200): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input))
    const key = Object.keys(routes).find((p) => url.pathname.endsWith(p))
    if (key === undefined) return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 })
    return new Response(JSON.stringify(routes[key]), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

test.after(() => {
  globalThis.fetch = originalFetch
})

test('opendesign adapter is catalog-discovered and refuses model-plane keys as extra accounts', () => {
  const adapter = CATALOG_EXTRA.find((a) => a.id === 'opendesign')
  assert.ok(adapter, 'opendesign adapter must exist in CATALOG_EXTRA')
  assert.deepEqual(adapter.keyRefs, ['OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY'])
  // 推理 key（OPENDESIGN_API_KEY）权限不同，不能当控制面账号卡。
  assert.equal(adapter.extraRefsFromProviders, false)
  assert.ok(!adapter.keyRefs.includes('OPENDESIGN_API_KEY'))
})

test('opendesignPlanItems: one row per window, sorted short→long, never summed', () => {
  const plan = {
    eligible: true,
    tier: 'plus',
    windows: [
      { durationSeconds: 604800, usedCredits: '16142', limitCredits: '200000', remainingCredits: '183858', resetsAt: '2026-11-13T15:40:18.000Z' },
      { durationSeconds: 18000, usedCredits: '120', limitCredits: '5000', remainingCredits: '4880', resetsAt: '2026-11-07T20:00:00.000Z' },
    ],
  }
  const items = opendesignPlanItems(plan, 10_000)
  assert.equal(items.length, 2)
  assert.equal(items[0]?.label, '5 小时窗口')
  assert.equal(items[1]?.label, '7 天窗口')
  assert.equal(items[1]?.limit, 200_000)
  assert.equal(items[1]?.remaining, 183_858)
  assert.equal(items[1]?.percent, 8.1)
  assert.equal(items[1]?.resetAt, '2026-11-13T15:40:18.000Z')
  assert.match(String(items[1]?.display), /剩 183,858 \/ 200,000 credits \(\$18\.39\)/)
})

test('opendesignPlanItems: derives remaining when the upstream omits it', () => {
  const items = opendesignPlanItems({ windows: [{ durationSeconds: 604800, usedCredits: '100', limitCredits: '1000' }] }, 10_000)
  assert.equal(items[0]?.remaining, 900)
  assert.equal(items[0]?.percent, 10)
})

test('opendesignPlanItems: unusable rows are skipped, not rendered as 0', () => {
  const items = opendesignPlanItems({ windows: [{ durationSeconds: 604800, limitCredits: 0 }, { usedCredits: '5' }] }, 10_000)
  assert.deepEqual(items, [])
})

test('fetchOpendesignSnapshot: reads preflight for the one window plus wallet and spend rows', async () => {
  globalThis.fetch = controlPlaneFetch({
    '/workspaces/current': { workspaceId: 'ws_1', activeWorkspaceId: 'ws_1', role: 'owner' },
    '/billing/preflight': {
      workspaceId: 'ws_1',
      balanceUsd: '-0.3175',
      funding: 'coding_plan',
      codingPlan: {
        eligible: true,
        tier: 'plus',
        windows: [{ durationSeconds: 604800, usedCredits: '16142', limitCredits: '200000', remainingCredits: '183858', resetsAt: '2026-11-13T15:40:18.000Z' }],
      },
    },
    '/billing/summary': { creditsPerUsd: 10_000, totalConsumedUsd: '20.8175', usageCount: 1365, balanceUsd: '0.0000' },
  })
  const snap = await fetchOpendesignSnapshot('vela_ctrl_test')
  assert.equal(snap.status, 'ok')
  assert.equal(snap.id, 'opendesign')
  assert.equal(snap.label, 'OpenDesign · plus')
  const labels = snap.items.map((i) => i.label)
  assert.deepEqual(labels, ['7 天窗口', '钱包余额', '累计消费'])
  // 钱包取 preflight 的 balanceUsd；summary 那个 0.0000 是另一套口径，不能用。
  assert.equal(snap.items[1]?.remaining, -0.3175)
  assert.equal(snap.items[1]?.display, '-$0.32')
  assert.equal(snap.items[2]?.display, '$20.82 · 1,365 次调用')
})

test('fetchOpendesignSnapshot: a failed summary only drops the spend row', async () => {
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/workspaces/current')) {
      return new Response(JSON.stringify({ workspaceId: 'ws_1' }), { status: 200 })
    }
    if (url.pathname.endsWith('/billing/preflight')) {
      return new Response(JSON.stringify({
        balanceUsd: '1.5',
        codingPlan: { eligible: true, tier: 'plus', windows: [{ durationSeconds: 604800, usedCredits: '0', limitCredits: '200000', remainingCredits: '200000', resetsAt: '2026-11-13T15:40:18.000Z' }] },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
  }) as typeof fetch
  const snap = await fetchOpendesignSnapshot('vela_ctrl_test')
  assert.equal(snap.status, 'ok')
  assert.deepEqual(snap.items.map((i) => i.label), ['7 天窗口', '钱包余额'])
})

test('fetchOpendesignSnapshot: an inference key is told exactly what went wrong', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })) as typeof fetch
  await assert.rejects(
    () => fetchOpendesignSnapshot('sk-amr-nope'),
    /401：额度查询只认 vela_ctrl_… 控制面 key；sk-amr-… 推理 key 没有这个权限/,
  )
})

test('fetchOpendesignSnapshot: no plan and no wallet is reported as a fact, not an empty card', async () => {
  globalThis.fetch = controlPlaneFetch({
    '/workspaces/current': { workspaceId: 'ws_1' },
    '/billing/preflight': { codingPlan: { eligible: false, windows: [] } },
  })
  await assert.rejects(() => fetchOpendesignSnapshot('vela_ctrl_test'), /没有 Design Plan 额度/)
})

test('opendesignVelaControlKey: reads the vela login state, tolerates a missing file', async () => {
  const { opendesignVelaControlKey } = await import('../src/direct.ts')
  // 本机必然有 ~/.amr/config.json（Open Design 已登录）；没有也不能抛错。
  const key = opendesignVelaControlKey()
  assert.ok(key === undefined || key.startsWith('vela_ctrl_'), `unexpected key shape: ${String(key)}`)
  // 不存在的 profile 必须返回 undefined，而不是猜一个。
  assert.equal(opendesignVelaControlKey('no-such-profile-xyz'), undefined)
})

test('opendesignVelaControlKey: a logged-out machine yields undefined (the "please log in" state)', async () => {
  const { opendesignVelaControlKey } = await import('../src/direct.ts')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const saved = process.env.HOME
  process.env.HOME = mkdtempSync(join(tmpdir(), 'od-nologin-'))
  try {
    assert.equal(opendesignVelaControlKey(), undefined)
  } finally {
    process.env.HOME = saved
  }
})
