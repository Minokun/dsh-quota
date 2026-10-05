import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateSessionCost, formatTokens, formatUsd, lookupModelPrice, type ModelPrice } from '../src/client/pricing.ts'

/** 逐字段断言单价（deepEqual 对同构不同引用对象的比较不稳定，直接比字段）。 */
function assertPrice(actual: ModelPrice | undefined, expected: ModelPrice): void {
  assert.ok(actual, 'price entry missing')
  assert.equal(actual.input, expected.input)
  assert.equal(actual.cacheRead, expected.cacheRead)
  assert.equal(actual.cacheWrite, expected.cacheWrite)
  assert.equal(actual.output, expected.output)
}

const FLASH: ModelPrice = { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 }
const V4_PRO: ModelPrice = { input: 0.66, cacheRead: 0.022, cacheWrite: 0.66, output: 1.98 }

test('lookupModelPrice matches by prefix, longest prefix wins, case-insensitive', () => {
  assertPrice(lookupModelPrice('deepseek-flash'), FLASH)
  // 最长前缀优先：v4-pro 不能被更短的 deepseek- 前缀截胡。
  assertPrice(lookupModelPrice('deepseek-v4-pro'), V4_PRO)
  assertPrice(lookupModelPrice('deepseek-v4-pro-0813'), V4_PRO)
  // 大小写不敏感 + 前后空白容忍。
  assertPrice(lookupModelPrice('  DeepSeek-Chat '), FLASH)
  assertPrice(lookupModelPrice('deepseek-reasoner'), FLASH)
  // 别名 v4-flash 系列按 Flash 价计。
  assertPrice(lookupModelPrice('deepseek-v4-flash-vision-exp'), FLASH)
})

test('lookupModelPrice returns undefined for unknown models', () => {
  assert.equal(lookupModelPrice('glm-4.7'), undefined)
  assert.equal(lookupModelPrice('kimi-k2'), undefined)
  assert.equal(lookupModelPrice(''), undefined)
  assert.equal(lookupModelPrice('not-deepseek-chat'), undefined)
})

test('estimateSessionCost prices each bucket separately', () => {
  // 1M 未缓存输入 + 1M 缓存读 + 1M 缓存写 + 1M 输出（deepseek-flash）。
  const usd = estimateSessionCost('deepseek-flash', {
    uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
  })
  assert.ok(usd)
  // 0.30 + 0.006 + 0.30 + 1.20 = 1.806
  assert.ok(Math.abs(usd.usd - 1.806) < 1e-9, `expected 1.806, got ${usd.usd}`)
})

test('estimateSessionCost scales linearly and handles zero buckets', () => {
  const small = estimateSessionCost('deepseek-v4-pro', {
    uncachedInputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 200_000, cacheWriteTokens: 0,
  })
  assert.ok(small)
  // 0.1×0.66 + 0.05×1.98 + 0.2×0.022 + 0 = 0.066 + 0.099 + 0.0044 = 0.1694
  assert.ok(Math.abs(small.usd - 0.1694) < 1e-9, `expected 0.1694, got ${small.usd}`)
  const zero = estimateSessionCost('deepseek-flash', {
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
  assert.deepEqual(zero, { usd: 0 })
})

test('estimateSessionCost returns undefined without a price entry', () => {
  assert.equal(estimateSessionCost('glm-4.7', {
    uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1,
  }), undefined)
})

test('formatTokens renders k/M compactly', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(12345), '12.3k')
  assert.equal(formatTokens(999_499), '999k')
  assert.equal(formatTokens(1_200_000), '1.2M')
  assert.equal(formatTokens(12_340_000), '12.3M')
  assert.equal(formatTokens(Number.NaN), '—')
})

test('formatUsd keeps 4 decimals under $1, 2 above', () => {
  assert.equal(formatUsd(0.0123), '0.0123')
  assert.equal(formatUsd(0.004), '0.0040')
  assert.equal(formatUsd(0.99), '0.9900')
  assert.equal(formatUsd(1), '1.00')
  assert.equal(formatUsd(1.806), '1.81')
  assert.equal(formatUsd(123.456), '123.46')
})
