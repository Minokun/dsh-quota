import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { codexAuthPaths, extractClaudeCodeToken, extractCodexAuth, parseClaudeCodeUsage, parseCodexUsage, resolveCodexAuth } from '../src/subscription.ts'

// ── parseClaudeCodeUsage ─────────────────────────────────────────────────────

test('claude: legacy flat buckets map to 5h/weekly rows', () => {
  const { items, message } = parseClaudeCodeUsage({
    five_hour: { utilization: 42.5, resets_at: '2026-07-10T12:00:00Z' },
    seven_day: { utilization: 87, resets_at: '2026-07-13T00:00:00Z' },
  })
  assert.equal(message, undefined)
  assert.deepEqual(items, [
    { label: '5 小时窗口', percent: 42.5, resetAt: '2026-07-10T12:00:00Z' },
    { label: '周额度', percent: 87, resetAt: '2026-07-13T00:00:00Z' },
  ])
})

test('claude: null buckets render as 0% without resetAt', () => {
  const { items } = parseClaudeCodeUsage({
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: null, resets_at: null },
  })
  assert.deepEqual(items, [
    { label: '5 小时窗口', percent: 0 },
    { label: '周额度', percent: 0 },
  ])
})

test('claude: limits[] fallback ignores placeholders and scopes weekly by model', () => {
  const { items } = parseClaudeCodeUsage({
    limits: [
      { kind: 'session', percent: 30, resets_at: '2026-07-10T12:00:00Z' },
      { kind: 'weekly_all', percent: 0, resets_at: null }, // 无 scope 的 0% 占位 → 忽略
      { kind: 'weekly_scoped', percent: 15, resets_at: null, scope: { model: { display_name: 'claude-opus-4' } } },
    ],
  })
  assert.deepEqual(items, [
    { label: '5 小时窗口', percent: 30, resetAt: '2026-07-10T12:00:00Z' },
    { label: '周额度 · claude-opus-4', percent: 15 },
  ])
})

test('claude: extra_usage cents convert to dollars', () => {
  const withLimit = parseClaudeCodeUsage({
    five_hour: { utilization: 10, resets_at: '2026-07-10T12:00:00Z' },
    extra_usage: { monthly_limit: 20000, used_credits: 12345, utilization: 61, currency: 'USD' },
  })
  assert.equal(withLimit.items.at(-1)?.label, '本月花费')
  assert.equal(withLimit.items.at(-1)?.display, '123.45 USD / 200.00')
  assert.equal(withLimit.items.at(-1)?.percent, undefined)

  const noLimit = parseClaudeCodeUsage({ extra_usage: { used_credits: 500 } })
  assert.equal(noLimit.items.at(-1)?.display, '5.00 USD')
})

test('claude: unrecognized body yields empty items with a message', () => {
  const out = parseClaudeCodeUsage({ hello: 'world' })
  assert.deepEqual(out.items, [])
  assert.ok(out.message?.includes('无法识别'))
  assert.deepEqual(parseClaudeCodeUsage('nope').items, [])
})

// ── parseCodexUsage ──────────────────────────────────────────────────────────

test('codex: both windows with epoch-second resetAt and plan_type message', () => {
  const { items, message } = parseCodexUsage({
    plan_type: 'chatgpt_plus',
    rate_limit: {
      primary_window: { used_percent: 64.2, reset_at: 1783500000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 12, reset_at: 1783900000, limit_window_seconds: 604800 },
    },
  })
  assert.equal(message, 'chatgpt_plus')
  assert.deepEqual(items[0], { label: '5 小时窗口', percent: 64.2, resetAt: new Date(1783500000 * 1000).toISOString() })
  assert.deepEqual(items[1], { label: '本周窗口', percent: 12, resetAt: new Date(1783900000 * 1000).toISOString() })
})

test('codex: credits entry with unlimited handling and no percent', () => {
  const { items } = parseCodexUsage({ credits: { has_credits: true, balance: '12.34' } })
  assert.deepEqual(items, [{ label: 'Credits', display: '12.34' }])
  assert.deepEqual(parseCodexUsage({ credits: { has_credits: true, unlimited: true } }).items, [{ label: 'Credits', display: '无限' }])
})

test('codex: missing fields degrade gracefully', () => {
  assert.deepEqual(parseCodexUsage({}).items, [])
  assert.ok(parseCodexUsage({}).message)
  // 只有 plan_type 也能成行（message 拼接，items 可为空）。
  assert.deepEqual(parseCodexUsage({ plan_type: 'ChatGPT Plus' }).items, [])
  assert.equal(parseCodexUsage({ plan_type: 'ChatGPT Plus' }).message, 'ChatGPT Plus')
  // 缺 reset_at 的窗口不带 resetAt。
  const { items } = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5 } } })
  assert.deepEqual(items, [{ label: '5 小时窗口', percent: 5 }])
})

// ── 凭证检测 ─────────────────────────────────────────────────────────────────

test('claude credentials JSON: only claudeAiOauth counts as logged in', () => {
  assert.equal(extractClaudeCodeToken({ claudeAiOauth: { accessToken: 'sk-ant-oat-abc' } }), 'sk-ant-oat-abc')
  // 只有 mcpOAuth → 未登录。
  assert.equal(extractClaudeCodeToken({ mcpOAuth: { access_token: 'x' } }), undefined)
  assert.equal(extractClaudeCodeToken({ claudeAiOauth: { accessToken: '' } }), undefined)
  assert.equal(extractClaudeCodeToken('junk'), undefined)
})

test('codex auth.json: full tokens triple enables, OPENAI_API_KEY alone does not', () => {
  const full = extractCodexAuth({
    OPENAI_API_KEY: 'test',
    tokens: { access_token: 'acc', account_id: 'org-1', refresh_token: 'ref' },
    last_refresh: '2026-07-01T00:00:00Z',
  })
  assert.equal(full?.accessToken, 'acc')
  assert.equal(full?.accountId, 'org-1')
  assert.equal(full?.refreshToken, 'ref')

  assert.equal(extractCodexAuth({ OPENAI_API_KEY: 'test' }), undefined)
  assert.equal(extractCodexAuth({ tokens: { access_token: 'acc', account_id: '', refresh_token: 'ref' } }), undefined)
  assert.equal(extractCodexAuth(null), undefined)
})

test('codex auth path candidates: CODEX_HOME wins, config fallback only without it', () => {
  const home = '/home/tester'
  assert.deepEqual(codexAuthPaths({ CODEX_HOME: '/custom/codex' }, home), ['/custom/codex/auth.json'])
  assert.deepEqual(codexAuthPaths({}, home), ['/home/tester/.codex/auth.json', '/home/tester/.config/codex/auth.json'])
})

test('codex resolveCodexAuth: reads a real auth.json from a temp CODEX_HOME', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-codex-'))
  const prevHome = process.env.CODEX_HOME
  try {
    // 无文件 → undefined（隐藏）。
    process.env.CODEX_HOME = join(dir, 'empty')
    await mkdir(process.env.CODEX_HOME, { recursive: true })
    assert.equal(await resolveCodexAuth(), undefined)

    // 有完整 tokens → 解析出三元组并记住命中路径。
    process.env.CODEX_HOME = join(dir, 'has')
    await mkdir(process.env.CODEX_HOME, { recursive: true })
    await writeFile(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'test',
      tokens: { access_token: 'a1', account_id: 'acct', refresh_token: 'r1' },
    }), 'utf8')
    const auth = await resolveCodexAuth()
    assert.equal(auth?.accessToken, 'a1')
    assert.equal(auth?.path, join(process.env.CODEX_HOME, 'auth.json'))
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevHome
    await rm(dir, { recursive: true, force: true })
  }
})
