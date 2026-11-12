import assert from 'node:assert/strict'
import test from 'node:test'
import { orderProviders, providerRowOf } from '../src/client/panel-order.ts'
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

test('orderProviders: a magpie session pins the row of ITS provider, not the first row', () => {
  // Magpie 网关的所有行共用同一个凭证引用（MAGPIE_GATEWAY_KEY），所以
  // apiKeyEnv 精确匹配必然命中「本机第一行」——codex 卡片会错误置顶，而会话
  // 实际跑的是 codex 还是 sidrune 完全没被考虑。模型 id 的 provider 前缀才是
  // 唯一可靠的依据。
  const rows = [
    row('magpie#codex', 'MAGPIE_GATEWAY_KEY'),
    row('magpie#sidrune', 'MAGPIE_GATEWAY_KEY'),
    row('magpie#kimi', 'MAGPIE_GATEWAY_KEY'),
    row('kimi', 'KIMI_CODING_API_KEY'),
  ]
  const refs = { 'magpie-responses': 'MAGPIE_GATEWAY_KEY', 'magpie-anthropic': 'MAGPIE_GATEWAY_KEY', 'magpie': 'MAGPIE_GATEWAY_KEY' }
  // provider 前缀来自模型 id：`sidrune/claude-sonnet-5-5` → magpie#sidrune。
  assert.equal(providerRowOf(rows, 'magpie-anthropic', refs, 'sidrune/claude-sonnet-5-5')?.id, 'magpie#sidrune')
  assert.deepEqual(
    orderProviders(rows, 'magpie-anthropic', refs, 'sidrune/claude-sonnet-5-5').map((p) => p.id),
    ['magpie#sidrune', 'magpie#codex', 'magpie#kimi', 'kimi'],
  )
  // 模型没给（旧调用点）时退回 ref 匹配，行为与改动前一致。
  assert.equal(providerRowOf(rows, 'magpie-responses', refs)?.id, 'magpie#codex')
})

test('orderProviders: a magpie model whose provider has no row falls back to the first magpie row', () => {
  const rows = [row('magpie#codex', 'MAGPIE_GATEWAY_KEY'), row('kimi')]
  // 模型路由到网关里没接的供应商时，不要因此丢掉置顶（退回 ref 命中）。
  assert.equal(providerRowOf(rows, 'magpie-responses', { 'magpie-responses': 'MAGPIE_GATEWAY_KEY' }, 'zai/glm-5.3')?.id, 'magpie#codex')
})
