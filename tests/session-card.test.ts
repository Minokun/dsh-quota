import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionCardNote, sessionCardVisible, sessionUsageRows, sessionUsageTotal } from '../src/client/session-card.ts'
import type { TokenUsageView } from '../src/client/session-model.ts'

/** 一份四桶用量。 */
function usage(overrides: Partial<TokenUsageView> = {}): TokenUsageView {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides }
}

test('the card stays on screen while a session is visible, even before usage lands', () => {
  // 回归：可见性以前绑在「四桶之和 > 0」上，新会话 / 投影还没下发的那一帧
  // 会让面板顶上那条可折叠的 token 记录整块消失。
  assert.equal(sessionCardVisible(true, undefined), true)
  assert.equal(sessionCardVisible(true, usage()), true)
  assert.equal(sessionCardVisible(false, usage({ uncachedInputTokens: 10 })), true)
  // 没有会话也没有投影时才不渲染。
  assert.equal(sessionCardVisible(false, undefined), false)
})

test('rows keep the three billed buckets and drop the always-zero cache write', () => {
  const rows = sessionUsageRows(usage({ uncachedInputTokens: 1, cacheReadTokens: 2, outputTokens: 3, cacheWriteTokens: 9 }))
  assert.deepEqual(rows.map((r) => r.key), ['session.card.input', 'session.card.cacheRead', 'session.card.output'])
  assert.deepEqual(rows.map((r) => r.value), [1, 2, 3])
})

test('no projection yet reads as pending, an all-zero projection as empty', () => {
  assert.equal(sessionCardNote(undefined), 'pending')
  assert.equal(sessionCardNote(usage()), 'empty')
  assert.equal(sessionCardNote(usage({ outputTokens: 1 })), '')
  assert.deepEqual(sessionUsageRows(undefined), [])
})

test('the usage total counts the cache-write bucket too (it has no row of its own)', () => {
  // 只有缓存写用量的会话在面板上三行都是 0：总量必须把它算进来，否则会被
  // 误判成「还没有产生用量」，成本估算也会被跳过。
  assert.equal(sessionUsageTotal(usage({ cacheWriteTokens: 500 })), 500)
  assert.equal(sessionUsageTotal(usage({ uncachedInputTokens: 1, cacheReadTokens: 2, outputTokens: 4, cacheWriteTokens: 8 })), 15)
  assert.equal(sessionUsageTotal(undefined), 0)
  assert.equal(sessionCardNote(usage({ cacheWriteTokens: 500 })), '')
})
