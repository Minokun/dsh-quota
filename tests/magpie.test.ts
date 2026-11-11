import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import test from 'node:test'
import {
  cardItems,
  cardLabel,
  cardsOf,
  clearMagpieCache,
  fetchMagpieRows,
  isMagpiePlatform,
  magpieLineRefs,
  magpieSettingsPath,
  parseLines,
  probeMagpie,
  rowsFromCards,
  windowLabel,
} from '../src/magpie.ts'
import { MAGPIE_PLATFORM_PREFIX, platformForProvider } from '../src/platform-map.ts'

// ── 线路凭证引用 ─────────────────────────────────────────────────────────────

test('line refs match the connector credential naming exactly', () => {
  // 与 dsh-magpie-connector/lib/host/runtime.js 的 lineCredentialRefs 必须一字不差，
  // 否则 connector 里已存的 key 在 quota 面板读不到。
  assert.deepEqual(magpieLineRefs('9625deb7'), {
    key: 'MAGPIE_LINE_9625DEB7_API_KEY',
    accessClientId: 'MAGPIE_LINE_9625DEB7_ACCESS_CLIENT_ID',
    accessClientSecret: 'MAGPIE_LINE_9625DEB7_ACCESS_CLIENT_SECRET',
  })
})

// ── settings.json 解析 ───────────────────────────────────────────────────────

test('parseLines keeps complete lines and drops ones without a baseUrl', () => {
  const lines = parseLines({
    lines: [
      { id: '9625deb7', baseUrl: 'https://magpie.abworks.cn/v1', accessMode: 'direct' },
      { id: 'aabbccdd', baseUrl: '' }, // 用户还没填地址
      { id: 'not-hex', baseUrl: 'https://x.dev/v1' },
      { baseUrl: 'https://y.dev/v1' },
    ],
  })
  assert.deepEqual(lines, [
    { id: '9625deb7', baseUrl: 'https://magpie.abworks.cn/v1', accessMode: 'direct' },
    { id: 'not-hex', baseUrl: 'https://x.dev/v1', accessMode: 'direct' },
  ])
})

test('parseLines tolerates a missing/garbage settings file body', () => {
  assert.deepEqual(parseLines(undefined), [])
  assert.deepEqual(parseLines({}), [])
  assert.deepEqual(parseLines({ lines: 'nope' }), [])
})

test('parseLines strips trailing slashes so the endpoint is not doubled', () => {
  const [line] = parseLines({ lines: [{ id: 'aa', baseUrl: 'https://g.dev/v1///' }] })
  assert.equal(line?.baseUrl, 'https://g.dev/v1')
})

test('parseLines keeps cloudflare access mode and defaults everything else to direct', () => {
  const lines = parseLines({
    lines: [
      { id: 'aa', baseUrl: 'https://g.dev/v1', accessMode: 'cloudflare' },
      { id: 'bb', baseUrl: 'https://g.dev/v1', accessMode: 'weird' },
    ],
  })
  assert.equal(lines[0]?.accessMode, 'cloudflare')
  assert.equal(lines[1]?.accessMode, 'direct')
})

test('magpieSettingsPath resolves under DSH_HOME and honours the override', () => {
  assert.equal(
    magpieSettingsPath({ DSH_HOME: 'C:/Users/x/.dsh' } as NodeJS.ProcessEnv, 'C:/Users/x'),
    join('C:/Users/x/.dsh', 'plugins', 'dsh-magpie-connector', 'settings.json'),
  )
  assert.equal(
    magpieSettingsPath({ DSH_MAGPIE_SETTINGS_FILE: 'C:/tmp/magpie.json' } as NodeJS.ProcessEnv, 'C:/Users/x'),
    'C:/tmp/magpie.json',
  )
  // 没有 DSH_HOME 时回落到 ~/.dsh，且路径分隔符遵循当前平台。
  assert.equal(
    magpieSettingsPath({} as NodeJS.ProcessEnv, join('C:', 'Users', 'x')),
    join('C:', 'Users', 'x', '.dsh', 'plugins', 'dsh-magpie-connector', 'settings.json'),
  )
  assert.equal(sep.length, 1)
})

// ── 卡片 → 条目 ──────────────────────────────────────────────────────────────

test('windowLabel maps the gateway window names onto the panel vocabulary', () => {
  assert.equal(windowLabel('5 hours'), '5 小时窗口')
  assert.equal(windowLabel('7 days'), '周额度')
  assert.equal(windowLabel('Weekly'), '周额度')
  assert.equal(windowLabel('Credits'), '额度')
  assert.equal(windowLabel('Monthly'), '月额度')
  assert.equal(windowLabel('3 天'), '3 天窗口')
  assert.equal(windowLabel(undefined), '额度')
  // 认不出的窗口名原样透出，不吞信息。
  assert.equal(windowLabel('Turbo Pack'), 'Turbo Pack')
})

test('cardLabel appends the plan unless it repeats the name', () => {
  assert.equal(cardLabel({ name: 'Command Code', plan: 'GOAT' }, 'commandcode'), 'Command Code · GOAT')
  assert.equal(cardLabel({ name: 'Codex', plan: 'codex' }, 'codex'), 'Codex')
  assert.equal(cardLabel({ name: 'Codex' }, 'codex'), 'Codex')
  assert.equal(cardLabel({}, 'opendesign'), 'opendesign')
})

test('cardItems turns every window into a percent row and adds a balance row', () => {
  const items = cardItems({
    provider: 'commandcode',
    windows: [
      { name: '5 hours', used: 0.10014129, resetsAt: '2026-11-10T21:47:35.461Z' },
      { name: 'Weekly', used: 55.33903724457143, resetsAt: '2026-11-12T11:10:03.231Z' },
      { name: 'Credits', used: 34.81727308728572, resetsAt: '2026-11-22T06:47:57Z', display: '24.37 / 70.00 credits' },
    ],
    balance: '$45.63',
  })
  // 网关给的百分比是长小数（55.33903724457143），面板只显示两位。
  assert.deepEqual(items, [
    { label: '5 小时窗口', percent: 0.1, resetAt: '2026-11-10T21:47:35.461Z' },
    { label: '周额度', percent: 55.34, resetAt: '2026-11-12T11:10:03.231Z' },
    { label: '额度', percent: 34.82, resetAt: '2026-11-22T06:47:57Z', display: '24.37 / 70.00 credits' },
    { label: '余额', display: '$45.63', remaining: 45.63 },
  ])
})

test('cardItems keeps negative balances and windows without used', () => {
  const items = cardItems({
    windows: [{ name: '7 days', resetsAt: '2026-11-17T11:43:45.967Z', display: '22.1k / 200k credits' }],
    balance: '$-0.79',
  })
  assert.deepEqual(items, [
    { label: '周额度', resetAt: '2026-11-17T11:43:45.967Z', display: '22.1k / 200k credits' },
    { label: '余额', display: '$-0.79', remaining: -0.79 },
  ])
})

test('cardItems returns nothing for a card with no windows and no balance', () => {
  assert.deepEqual(cardItems({ provider: 'x' }), [])
})

// ── 卡片 → 行 ────────────────────────────────────────────────────────────────

test('rowsFromCards merges the plan card and the balance card of one provider', () => {
  const rows = rowsFromCards([
    { provider: 'commandcode', name: 'Command Code', plan: 'GOAT', kind: 'plan', windows: [{ name: '5 hours', used: 12, resetsAt: '2026-11-10T21:47:35Z' }] },
    { provider: 'commandcode', name: 'Command Code', kind: 'balance', windows: [], balance: '$45.63' },
  ], '9625deb7', false, 'MAGPIE_LINE_9625DEB7_API_KEY', 'file')
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row?.id, 'magpie-commandcode')
  assert.equal(row?.label, 'Command Code · GOAT')
  assert.equal(row?.status, 'ok')
  assert.equal(row?.via, 'api')
  assert.equal(row?.keyRef, 'MAGPIE_LINE_9625DEB7_API_KEY')
  assert.equal(row?.keySource, 'file')
  assert.deepEqual(row?.items.map((i) => i.label), ['5 小时窗口', '余额'])
})

test('rowsFromCards keeps one row per provider in first-seen order', () => {
  const rows = rowsFromCards([
    { provider: 'codex', name: 'Codex', windows: [{ name: '7 days', used: 100 }] },
    { provider: 'opendesign', name: 'Open Design', windows: [{ name: '7 days', used: 11 }] },
    { provider: 'codex', name: 'Codex', windows: [{ name: '5 hours', used: 3 }] },
  ], 'line1', true, 'MAGPIE_LINE_LINE1_API_KEY', 'env')
  assert.deepEqual(rows.map((r) => r.id), ['magpie-codex#line1', 'magpie-opendesign#line1'])
  assert.deepEqual(rows[0]?.items.map((i) => i.label), ['周额度', '5 小时窗口'])
})

test('rowsFromCards surfaces a per-card error as a failed row', () => {
  const rows = rowsFromCards([
    { provider: 'codex', name: 'Codex', error: 'upstream 503', windows: [] },
  ], 'aa', false, 'MAGPIE_LINE_AA_API_KEY', 'file')
  assert.equal(rows[0]?.status, 'error')
  assert.equal(rows[0]?.message, 'upstream 503')
})

test('rowsFromCards lowercases the provider so ids stay stable', () => {
  const rows = rowsFromCards([{ provider: ' CommandCode ', name: 'CC' }], 'aa', false, 'ref', 'env')
  assert.equal(rows[0]?.id, 'magpie-commandcode')
})

test('rowsFromCards skips cards without a provider', () => {
  assert.deepEqual(rowsFromCards([{ name: 'no owner' }], 'aa', false, 'ref', 'env'), [])
})

// ── 响应体容错 ──────────────────────────────────────────────────────────────

test('cardsOf accepts the gateway envelope and a bare array', () => {
  const card = { provider: 'codex' }
  assert.deepEqual(cardsOf({ data: [card], object: 'list' }), [card])
  assert.deepEqual(cardsOf([card]), [card])
  assert.deepEqual(cardsOf({ data: 'nope' }), [])
  assert.deepEqual(cardsOf(null), [])
  assert.deepEqual(cardsOf({ data: [null, card] }), [card])
})

// ── 平台映射 ─────────────────────────────────────────────────────────────────

test('a magpie connector route maps onto its own quota row', () => {
  // connector 注册的路由是 dsh-magpie-connector-<owner>；面板行是 magpie-<owner>。
  assert.equal(platformForProvider('dsh-magpie-connector-commandcode'), 'magpie-commandcode')
  assert.equal(platformForProvider('dsh-magpie-connector-codex'), 'magpie-codex')
  assert.equal(platformForProvider('DSH-MAGPIE-CONNECTOR-OpenDesign'), 'magpie-opendesign')
  // 空 owner 不产生一个只有前缀的行 id。
  assert.equal(platformForProvider('dsh-magpie-connector-'), '')
})

test('magpie rows are matched before the generic keyword rules', () => {
  // owner 里含 opendesign / openai 之类的词时，不能被通用规则抢走。
  assert.equal(platformForProvider('dsh-magpie-connector-opendesign'), 'magpie-opendesign')
  assert.equal(platformForProvider('dsh-magpie-connector-openai'), 'magpie-openai')
  // 没有 connector 前缀时，通用规则照旧。
  assert.equal(platformForProvider('opendesign'), 'opendesign')
  assert.equal(platformForProvider('openai'), 'openai-admin')
})

test('isMagpiePlatform distinguishes magpie rows from every other row', () => {
  assert.equal(isMagpiePlatform(`${MAGPIE_PLATFORM_PREFIX}codex`), true)
  assert.equal(isMagpiePlatform('magpie-line-9625deb7'), true)
  assert.equal(isMagpiePlatform('codex'), false)
  assert.equal(isMagpiePlatform('volcark'), false)
})

// ── fetchMagpieRows：无凭证 / 无设置时整行隐藏 ───────────────────────────────

test('fetchMagpieRows hides every row when the connector has no settings file', async () => {
  clearMagpieCache()
  const previous = process.env.DSH_MAGPIE_SETTINGS_FILE
  process.env.DSH_MAGPIE_SETTINGS_FILE = 'C:/definitely/not/here/settings.json'
  try {
    assert.deepEqual(await fetchMagpieRows({}), [])
  } finally {
    if (previous === undefined) delete process.env.DSH_MAGPIE_SETTINGS_FILE
    else process.env.DSH_MAGPIE_SETTINGS_FILE = previous
    clearMagpieCache()
  }
})

test('probeMagpie explains a missing settings file instead of throwing', async () => {
  const previous = process.env.DSH_MAGPIE_SETTINGS_FILE
  process.env.DSH_MAGPIE_SETTINGS_FILE = 'C:/definitely/not/here/settings.json'
  try {
    const result = await probeMagpie('magpie-codex', undefined)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /线路配置/)
  } finally {
    if (previous === undefined) delete process.env.DSH_MAGPIE_SETTINGS_FILE
    else process.env.DSH_MAGPIE_SETTINGS_FILE = previous
  }
})
