import assert from 'node:assert/strict'
import test from 'node:test'
import { orderKey, orderProviders, providerRowOf } from '../src/client/panel-order.ts'
import type { PanelProvider } from '../src/client/controller.ts'

/** Minimal provider row (the ordering helpers only touch id/keyRef/status). */
function row(id: string, keyRef?: string, status: PanelProvider['status'] = 'ok'): PanelProvider {
  return { id, label: id, keyRef, status, items: [] }
}

const ROWS: PanelProvider[] = [
  row('kimi'),
  row('deepseek', 'DEEPSEEK_API_KEY'),
  row('zhipu'),
  row('qianwen'),
]

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
  assert.deepEqual(orderProviders(rows, 'aggregator-proxy', refs).map((p) => p.id), ['my-agg', 'kimi'])
})

test('providerRowOf: unknown or empty provider resolves to nothing', () => {
  assert.equal(providerRowOf(ROWS, '', {}), undefined)
  assert.equal(providerRowOf(ROWS, 'some-unknown-provider', {}), undefined)
  // Not configured in the panel → the ref cannot match either.
  assert.equal(providerRowOf(ROWS, 'deepseek', { deepseek: 'DEEPSEEK_API_KEY' })?.id, 'deepseek')
  assert.equal(providerRowOf(ROWS, 'deepseek', { deepseek: 'OTHER_KEY' })?.id, 'deepseek')
})

test('orderProviders: the platform in use is pinned first, the rest keep host order', () => {
  const ordered = orderProviders(ROWS, 'zhipu', {})
  assert.deepEqual(ordered.map((p) => p.id), ['zhipu', 'kimi', 'deepseek', 'qianwen'])
})

test('orderProviders: an unresolved platform leaves the order untouched (and never drops a row)', () => {
  const ordered = orderProviders(ROWS, 'not-a-platform', {})
  assert.deepEqual(ordered.map((p) => p.id), ROWS.map((p) => p.id))
  assert.equal(ordered.length, ROWS.length)
  // The input array is not mutated in place.
  assert.deepEqual(ROWS.map((p) => p.id), ['kimi', 'deepseek', 'zhipu', 'qianwen'])
})

test('orderProviders: the 火山方舟 row is pinned for an ark session (keyRefs differ)', () => {
  // 真实快照里的形状：供应商 ark 的 apiKeyEnv 是 ARK_API_KEY，而面板行
  // volcark 的 keyRef 是 VOLC_ACCESS_KEY_ID（额度走 AK/SK 控制面），所以
  // keyRef 精确匹配必然落空，只能靠 provider id 映射认领——客户端那份映射
  // 曾经缺 ark 规则，于是这张卡永远排不到最前。
  const rows = [row('kimi', 'KIMI_CODING_API_KEY'), row('volcark', 'VOLC_ACCESS_KEY_ID'), row('opendesign', 'OPENDESIGN_CONTROL_KEY')]
  const refs = { ark: 'ARK_API_KEY', 'kimi-coding': 'KIMI_CODING_API_KEY', opendesign: 'OPENDESIGN_API_KEY' }
  assert.deepEqual(orderProviders(rows, 'ark', refs).map((p) => p.id), ['volcark', 'kimi', 'opendesign'])
})

test('orderProviders: multi-account platform pins only the exact-ref row', () => {
  const rows = [row('deepseek', 'DEEPSEEK_API_KEY_A'), row('deepseek#2', 'DEEPSEEK_API_KEY_B'), row('kimi')]
  const ordered = orderProviders(rows, 'deepseek-b', { 'deepseek-b': 'DEEPSEEK_API_KEY_B' })
  assert.deepEqual(ordered.map((p) => p.id), ['deepseek#2', 'deepseek', 'kimi'])
})

test('orderKey: multi-account, multi-line and probe rows collapse onto their platform group', () => {
  assert.equal(orderKey('kimi'), 'kimi')
  assert.equal(orderKey('deepseek#DEEPSEEK_B_API_KEY'), 'deepseek')
  assert.equal(orderKey('magpie-codex#9625DEB7'), 'magpie-codex')
  assert.equal(orderKey('probe#aihub'), 'aihub')
})

test('orderProviders: manual order wins, unknown platforms keep host order at the end', () => {
  const ordered = orderProviders(ROWS, 'not-a-platform', {}, ['qianwen', 'deepseek'])
  assert.deepEqual(ordered.map((p) => p.id), ['qianwen', 'deepseek', 'kimi', 'zhipu'])
  assert.equal(ordered.length, ROWS.length)
})

test('orderProviders: a manual position for the active platform beats the pin (no跳位 when the model changes)', () => {
  // 用户把 zhipu 排在最后；当前模型恰好走 zhipu——仍按用户顺序，不置顶。
  const ordered = orderProviders(ROWS, 'zhipu', {}, ['kimi', 'deepseek', 'qianwen', 'zhipu'])
  assert.deepEqual(ordered.map((p) => p.id), ['kimi', 'deepseek', 'qianwen', 'zhipu'])
})

test('orderProviders: the active platform still pins when the manual order does not mention it', () => {
  // 新线路/新账号（或刚换到手动顺序里没有的平台）继续享受置顶。
  const ordered = orderProviders(ROWS, 'zhipu', {}, ['qianwen', 'deepseek'])
  assert.deepEqual(ordered.map((p) => p.id), ['zhipu', 'qianwen', 'deepseek', 'kimi'])
})

test('orderProviders: a group stays together when its rows carry #-suffixes', () => {
  const rows = [row('kimi'), row('deepseek#A'), row('deepseek#B'), row('zhipu')]
  const ordered = orderProviders(rows, 'not-a-platform', {}, ['deepseek', 'kimi', 'zhipu'])
  assert.deepEqual(ordered.map((p) => p.id), ['deepseek#A', 'deepseek#B', 'kimi', 'zhipu'])
})

test('orderProviders: stale ids in the manual order are ignored, not dropped or reordered', () => {
  // 平台行被隐藏（未配 key）后手动顺序仍留着它——行回来了位置不变。
  const ordered = orderProviders(ROWS, 'not-a-platform', {}, ['removed-platform', 'kimi'])
  assert.deepEqual(ordered.map((p) => p.id), ['kimi', 'deepseek', 'zhipu', 'qianwen'])
})
