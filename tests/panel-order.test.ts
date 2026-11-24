import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultOrderProviders, moveItem, orderKey, orderProviders, providerRowOf } from '../src/client/panel-order.ts'
import type { ModelCatalogGroupLike, PanelProvider } from '../src/client/controller.ts'
import { sortByDshModelOrder } from '../src/controller.ts'

/** Minimal provider row (the ordering helpers only touch id/keyRef/status). */
function row(id: string, keyRef?: string, status: PanelProvider['status'] = 'ok'): PanelProvider {
  return { id, label: id, keyRef, status, items: [] }
}

const ROWS: PanelProvider[] = [
  row('kimi', 'KIMI_CODING_API_KEY'),
  row('deepseek', 'DEEPSEEK_API_KEY'),
  row('zhipu', 'ZAI_CODING_CN_API_KEY'),
  row('qianwen'),
]

// ── providerRowOf：原位「在用」高亮与悬浮球摘要认领 ───────────────────────────

test('providerRowOf: exact apiKeyEnv ref wins over the platform id (same platform, two accounts)', () => {
  const rows = [row('deepseek', 'DEEPSEEK_API_KEY_A'), row('deepseek#2', 'DEEPSEEK_API_KEY_B')]
  const refs = { 'deepseek-b': 'DEEPSEEK_API_KEY_B' }
  assert.equal(providerRowOf(rows, 'deepseek-b', refs)?.id, 'deepseek#2')
})

test('providerRowOf: falls back to the platform id and its #-suffixed variants', () => {
  assert.equal(providerRowOf([row('kimi#2')], 'kimi', {})?.id, 'kimi#2')
  assert.equal(providerRowOf([row('kimi')], 'kimi', {})?.id, 'kimi')
})

test('providerRowOf: a custom platform row matches by apiKeyEnv even without a built-in platform mapping', () => {
  const rows = [row('my-agg', 'MY_AGG_KEY'), row('kimi')]
  const refs = { 'aggregator-proxy': 'MY_AGG_KEY' }
  assert.equal(providerRowOf(rows, 'aggregator-proxy', refs)?.id, 'my-agg')
})

test('providerRowOf: unknown or empty provider resolves to nothing', () => {
  assert.equal(providerRowOf(ROWS, '', {}), undefined)
  assert.equal(providerRowOf(ROWS, 'some-unknown-provider', {}), undefined)
  assert.equal(providerRowOf(ROWS, 'deepseek', { deepseek: 'DEEPSEEK_API_KEY' })?.id, 'deepseek')
  assert.equal(providerRowOf(ROWS, 'deepseek', { deepseek: 'OTHER_KEY' })?.id, 'deepseek')
})

test('providerRowOf: matches 火山方舟 row for an ark session when keyRefs differ', () => {
  const rows = [row('kimi', 'KIMI_CODING_API_KEY'), row('volcark', 'VOLC_ACCESS_KEY_ID'), row('opendesign', 'OPENDESIGN_CONTROL_KEY')]
  const refs = { ark: 'ARK_API_KEY', 'kimi-coding': 'KIMI_CODING_API_KEY', opendesign: 'OPENDESIGN_API_KEY' }
  assert.equal(providerRowOf(rows, 'ark', refs)?.id, 'volcark')
})

test('providerRowOf: a magpie session claims the row of ITS provider, with fallback to first magpie row', () => {
  const rows = [
    row('magpie#codex', 'MAGPIE_GATEWAY_KEY'),
    row('magpie#sidrune', 'MAGPIE_GATEWAY_KEY'),
    row('magpie#kimi', 'MAGPIE_GATEWAY_KEY'),
    row('kimi', 'KIMI_CODING_API_KEY'),
  ]
  const refs = { 'magpie-responses': 'MAGPIE_GATEWAY_KEY', 'magpie-anthropic': 'MAGPIE_GATEWAY_KEY', magpie: 'MAGPIE_GATEWAY_KEY' }
  assert.equal(providerRowOf(rows, 'magpie-anthropic', refs, 'sidrune/claude-sonnet-5-5')?.id, 'magpie#sidrune')
  assert.equal(providerRowOf(rows, 'magpie-responses', refs)?.id, 'magpie#codex')
  assert.equal(providerRowOf(rows, 'magpie-responses', refs, 'zai/glm-5.3')?.id, 'magpie#codex')
})

// ── 默认顺序：严格对齐 DSH 模型选择框，不再自动把当前模型置顶 ─────────────────

test('sortByDshModelOrder (host baseline): deepseek-account -> deepseek-official -> DSH llmProviders order, pure quota cards last', () => {
  const hostRows = [
    row('kimi', 'KIMI_CODING_API_KEY'),
    row('deepseek#DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'),
    row('deepseek#DEEPSEEK_ACCOUNT', 'DEEPSEEK_ACCOUNT'),
    row('zhipu', 'ZAI_CODING_CN_API_KEY'),
    row('scnet'), // 不在 DSH 模型列表里的纯 MCP 额度卡
  ]
  const llmProviders = [
    { id: 'zai-coding-cn', label: 'ZAI', keyRef: 'ZAI_CODING_CN_API_KEY' },
    { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
    { id: 'kimi-coding', label: 'Kimi', keyRef: 'KIMI_CODING_API_KEY' },
    { id: 'deepseek-account', label: 'DeepSeek Account' },
  ]
  const refs = {
    'deepseek-account': 'DEEPSEEK_ACCOUNT',
    'deepseek-official': 'DEEPSEEK_API_KEY',
    'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
    'kimi-coding': 'KIMI_CODING_API_KEY',
  }
  const sorted = sortByDshModelOrder(hostRows, llmProviders, refs)
  assert.deepEqual(sorted.map((p) => p.id), [
    'deepseek#DEEPSEEK_ACCOUNT',
    'deepseek#DEEPSEEK_API_KEY',
    'zhipu',
    'kimi',
    'scnet',
  ])
})

test('defaultOrderProviders (client catalog): refines Magpie sub-cards by model-picker appearance order and never pins active model', () => {
  const rows = [
    row('kimi', 'KIMI_CODING_API_KEY'),
    row('magpie#codex'),
    row('magpie#claude'),
    row('magpie#agy-cli'),
    row('deepseek#DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'),
    row('deepseek#DEEPSEEK_ACCOUNT', 'DEEPSEEK_ACCOUNT'),
    row('scnet'),
  ]
  const groups: ModelCatalogGroupLike[] = [
    {
      id: 'magpie-anthropic',
      models: [
        { id: 'agy-cli/gemini-4-carbon' },
        { id: 'claude/claude-sonnet-4-5' },
        { id: 'codex/gpt-5.6' },
      ],
    },
    { id: 'kimi-coding', models: [{ id: 'kimi-k2.5' }] },
    { id: 'deepseek-official', models: [{ id: 'deepseek-chat' }] },
    { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] },
  ]
  const refs = {
    'deepseek-account': 'DEEPSEEK_ACCOUNT',
    'deepseek-official': 'DEEPSEEK_API_KEY',
    'kimi-coding': 'KIMI_CODING_API_KEY',
  }
  const ordered = orderProviders(rows, [], groups, refs)
  assert.deepEqual(ordered.map((p) => p.id), [
    'deepseek#DEEPSEEK_ACCOUNT',
    'deepseek#DEEPSEEK_API_KEY',
    'magpie#agy-cli',
    'magpie#claude',
    'magpie#codex',
    'kimi',
    'scnet',
  ])
  // Input array stays untouched.
  assert.equal(rows[0]?.id, 'kimi')
})

test('orderProviders: without customOrder or catalogGroups, preserves Host baseline order with zero jumping', () => {
  const ordered = orderProviders(ROWS)
  assert.deepEqual(ordered.map((p) => p.id), ['kimi', 'deepseek', 'zhipu', 'qianwen'])
})

// ── 拖拽自定义排序：逐张卡片精确 id 独立排位 + 新卡排尾 + 旧组 key 兼容 ─────────

test('orderProviders: per-card drag order splits multi-account cards independently onto arbitrary slots', () => {
  const rows = [
    row('deepseek#DEEPSEEK_ACCOUNT', 'DEEPSEEK_ACCOUNT'),
    row('deepseek#DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'),
    row('magpie#codex'),
    row('kimi', 'KIMI_CODING_API_KEY'),
  ]
  // 用户把自己的 DeepSeek 账号卡留在第 1，把别人的 API key 卡拖到最底。
  const custom = ['deepseek#DEEPSEEK_ACCOUNT', 'magpie#codex', 'kimi', 'deepseek#DEEPSEEK_API_KEY']
  assert.deepEqual(orderProviders(rows, custom).map((p) => p.id), custom)
})

test('orderProviders: brand-new cards append at the end in DSH default order, while returning cards reclaim their saved slot', () => {
  const custom = ['zhipu', 'hidden-for-now', 'kimi']
  // `deepseek` 和 `qianwen` 是后来新出现的卡 → 按默认相对顺序追加在末尾。
  assert.deepEqual(orderProviders(ROWS, custom).map((p) => p.id), ['zhipu', 'kimi', 'deepseek', 'qianwen'])
  // 当 `hidden-for-now` 重新出现时，自动回到 zhipu 和 kimi 之间。
  const restored = [...ROWS, row('hidden-for-now')]
  assert.deepEqual(orderProviders(restored, custom).map((p) => p.id), ['zhipu', 'hidden-for-now', 'kimi', 'deepseek', 'qianwen'])
})

test('orderProviders: empty customOrder (reset action) immediately restores DSH default order', () => {
  const groups: ModelCatalogGroupLike[] = [
    { id: 'zai-coding-cn' },
    { id: 'kimi-coding' },
    { id: 'deepseek-official' },
  ]
  const refs = { 'deepseek-official': 'DEEPSEEK_API_KEY', 'zai-coding-cn': 'ZAI_CODING_CN_API_KEY', 'kimi-coding': 'KIMI_CODING_API_KEY' }
  const dragged = orderProviders(ROWS, ['qianwen', 'kimi', 'zhipu', 'deepseek'], groups, refs)
  assert.deepEqual(dragged.map((p) => p.id), ['qianwen', 'kimi', 'zhipu', 'deepseek'])
  // 点击「恢复默认顺序」（传入 []）后回到 DSH 模型顺序：deepseek -> zhipu -> kimi -> qianwen。
  const reset = orderProviders(ROWS, [], groups, refs)
  assert.deepEqual(reset.map((p) => p.id), ['deepseek', 'zhipu', 'kimi', 'qianwen'])
})

test('orderProviders: backward-compatible fallback honors legacy group keys in providerOrder', () => {
  assert.equal(orderKey('kimi'), 'kimi')
  assert.equal(orderKey('deepseek#DEEPSEEK_B_API_KEY'), 'deepseek')
  assert.equal(orderKey('probe#aihub'), 'aihub')
  assert.equal(orderKey('magpie#codex'), 'magpie#codex')
  assert.equal(orderKey('magpie#codex/alice'), 'magpie#codex')

  const rows = [row('kimi'), row('deepseek#A'), row('deepseek#B'), row('zhipu')]
  const ordered = orderProviders(rows, ['deepseek', 'kimi', 'zhipu'])
  assert.deepEqual(ordered.map((p) => p.id), ['deepseek#A', 'deepseek#B', 'kimi', 'zhipu'])
})

test('moveItem: pure slot-shift helper moves cards cleanly and ignores out-of-range indices', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], -1, 2), ['a', 'b', 'c'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 5), ['a', 'b', 'c'])
})
