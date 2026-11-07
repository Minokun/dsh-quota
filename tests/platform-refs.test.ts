import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG_EXTRA, DIRECT_ADAPTERS, type DirectAdapter } from '../src/direct.ts'
import { platformRefHints, refRowLabel, type LlmProviderInfo } from '../src/controller.ts'

/** The DeepSeek catalog adapter (origins: api.deepseek.com). */
const deepseek = DIRECT_ADAPTERS.find((a) => a.id === 'deepseek')!

/** One DSH model provider row. */
function provider(id: string, keyRef?: string, baseURL?: string): LlmProviderInfo {
  return { id, label: id, ...(keyRef === undefined ? {} : { keyRef }), ...(baseURL === undefined ? {} : { baseURL }) }
}

/** Every ref the adapter would resolve on its own. */
function ownRefs(adapter: DirectAdapter): string[] {
  return [...new Set([...adapter.keyRefs, ...adapter.envKeys])]
}

test('catalog adapters carry their official endpoint origin', () => {
  assert.deepEqual(deepseek.origins, ['https://api.deepseek.com'])
  assert.deepEqual(DIRECT_ADAPTERS.find((a) => a.id === 'kimi')!.origins, ['https://api.kimi.com'])
})

test('platformRefHints: the official provider ref already in the catalog is not repeated', () => {
  assert.deepEqual(platformRefHints(deepseek, [provider('deepseek-official', 'DEEPSEEK_API_KEY')]), [])
})

test('platformRefHints: a second provider route on the same endpoint becomes an extra account ref', () => {
  const hints = platformRefHints(deepseek, [
    provider('deepseek-official', 'DEEPSEEK_API_KEY'),
    provider('deepseek-b', 'DEEPSEEK_B_API_KEY', 'https://api.deepseek.com/v1'),
  ])
  assert.deepEqual(hints, [{ ref: 'DEEPSEEK_B_API_KEY', provider: 'deepseek-b' }])
  // Every hint ref is genuinely new to the adapter (one card each).
  for (const hint of hints) assert.ok(!ownRefs(deepseek).includes(hint.ref))
})

test('platformRefHints: a gateway on another origin is skipped (no bogus official-endpoint call)', () => {
  const hints = platformRefHints(deepseek, [
    provider('deepseek-via-siliconflow', 'SILICONFLOW_DEEPSEEK_KEY', 'https://api.siliconflow.cn/v1'),
  ])
  assert.deepEqual(hints, [])
})

test('platformRefHints: a native provider without baseURL contributes its ref (DSH-managed route)', () => {
  const hints = platformRefHints(deepseek, [provider('deepseek-backup', 'DEEPSEEK_BACKUP_API_KEY')])
  assert.deepEqual(hints, [{ ref: 'DEEPSEEK_BACKUP_API_KEY', provider: 'deepseek-backup' }])
})

test('platformRefHints: providers for other platforms and keyless providers are ignored', () => {
  const hints = platformRefHints(deepseek, [
    provider('moonshot', 'MOONSHOT_API_KEY', 'https://api.moonshot.cn/v1'),
    provider('deepseek-keyless'),
  ])
  assert.deepEqual(hints, [])
})

test('platformRefHints: duplicate refs across providers yield one hint (first provider wins)', () => {
  const hints = platformRefHints(deepseek, [
    provider('deepseek-b', 'DEEPSEEK_SHARED_KEY', 'https://api.deepseek.com'),
    provider('deepseek-c', 'DEEPSEEK_SHARED_KEY', 'https://api.deepseek.com'),
  ])
  assert.deepEqual(hints, [{ ref: 'DEEPSEEK_SHARED_KEY', provider: 'deepseek-b' }])
})

test('refRowLabel: extra account rows carry their provider id, catalog rows keep the bare label', () => {
  const hints = [{ ref: 'DEEPSEEK_B_API_KEY', provider: 'deepseek-b' }]
  assert.equal(refRowLabel('DeepSeek', 'DEEPSEEK_API_KEY', hints), 'DeepSeek')
  assert.equal(refRowLabel('DeepSeek', 'DEEPSEEK_B_API_KEY', hints), 'DeepSeek · deepseek-b')
  assert.equal(refRowLabel('DeepSeek · 套餐 A', 'DEEPSEEK_B_API_KEY', hints), 'DeepSeek · 套餐 A · deepseek-b')
})

test('platformRefHints: admin-only endpoints never take a normal model-provider key', () => {
  const admin = CATALOG_EXTRA.find((a) => a.id === 'openai-admin')!
  const hints = platformRefHints(admin, [provider('openai', 'OPENAI_API_KEY', 'https://api.openai.com/v1')])
  assert.deepEqual(hints, [])
})
