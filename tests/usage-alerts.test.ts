import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createUsageAlertState,
  deserializeUsageAlertState,
  evaluateUsageAlerts,
  formatEtaSpan,
  serializeUsageAlertState,
  type UsageAlertProvider,
} from '../src/client/usage-alerts.ts'
import { translate, type TFn } from '../src/client/locale.ts'

const t: TFn = (key, params) => translate('zh', key, params)

/** 一个带百分比/ETA/重置时间的条目。 */
function provider(overrides: Partial<UsageAlertProvider> = {}): UsageAlertProvider {
  return {
    id: 'kimi',
    label: 'Kimi Code',
    status: 'ok',
    items: [{ label: '周额度', percent: 50, resetAt: '2026-10-09T00:00:00.000Z' }],
    ...overrides,
  }
}

const TH = 85 // alertPercent

test('crossing the threshold fires exactly once per window, however far it keeps climbing', () => {
  let state = createUsageAlertState()
  let r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 84, resetAt: 'w1' }] })], TH, state)
  state = r.state
  assert.equal(r.alerts.length, 0)
  r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 85, resetAt: 'w1' }] })], TH, state)
  state = r.state
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1)
  for (const pct of [88, 95, 100]) {
    r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: pct, resetAt: 'w1' }] })], TH, state)
    state = r.state
  }
  assert.equal(r.alerts.length, 0, 'same window never re-fires, even at 100%')
})

test('first observation already over the line counts as the one reminder', () => {
  const r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 95, resetAt: 'w1' }] })], TH, createUsageAlertState())
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1)
  const again = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 96, resetAt: 'w1' }] })], TH, r.state)
  assert.equal(again.alerts.length, 0)
})

test('a new window (resetAt change) may remind once again', () => {
  let state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 90, resetAt: 'w1' }] })], TH, createUsageAlertState()).state
  let r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 20, resetAt: 'w2' }] })], TH, state)
  state = r.state
  assert.equal(r.alerts.length, 0)
  r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 91, resetAt: 'w2' }] })], TH, state)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1, 'new window fires again')
})

test('dropping below the threshold clears the window mark even without a resetAt change', () => {
  let state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 90 }] })], TH, createUsageAlertState()).state
  state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 40 }] })], TH, state).state
  const r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 86 }] })], TH, state)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1, 're-crossing after a dip is a new event')
})

test('eta fires once per window and re-arms after recovering past the recover line', () => {
  let state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 20, etaMinutes: 25, resetAt: 'w1' }] })], TH, createUsageAlertState()).state
  let r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 20, etaMinutes: 20, resetAt: 'w1' }] })], TH, state)
  state = r.state
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 0, 'same window already fired')
  state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 20, etaMinutes: 120, resetAt: 'w1' }] })], TH, state).state
  r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 20, etaMinutes: 15, resetAt: 'w1' }] })], TH, state)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 1, 'recovered past 60min then dipped again: new event')
})

test('a disappearing item resets its bookkeeping', () => {
  let state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 90, etaMinutes: 10 }] })], TH, createUsageAlertState()).state
  state = evaluateUsageAlerts([provider({ items: [] })], TH, state).state
  const r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 91, etaMinutes: 10 }] })], TH, state)
  assert.equal(r.alerts.length, 2, 'threshold + eta both count as fresh after the item vanished')
})

test('platforms that are not ok are ignored', () => {
  const r = evaluateUsageAlerts([provider({ status: 'error', items: [{ label: '周额度', percent: 99 }] })], TH, createUsageAlertState())
  assert.equal(r.alerts.length, 0)
})

test('evaluate is pure: inputs and the previous state stay untouched', () => {
  const state = createUsageAlertState()
  state.lastPercent.set('kimi::周额度', 10)
  state.shown.set('kimi::周额度', 'w1')
  state.firedEta.add('kimi::周额度@w1')
  const snapshot = serializeUsageAlertState(state)
  const providers = [provider({ items: [{ label: '周额度', percent: 90, etaMinutes: 5 }] })]
  const r = evaluateUsageAlerts(providers, TH, state)
  assert.equal(serializeUsageAlertState(state), snapshot, 'previous state untouched')
  assert.notEqual(r.state, state)
  assert.equal(providers[0]!.items[0]!.percent, 90, 'providers untouched')
})

test('serialization round-trips the whole state and rejects garbage', () => {
  const state = createUsageAlertState()
  state.lastPercent.set('a::b', 42)
  state.shown.set('a::b', 'w9')
  state.firedEta.add('a::b@w9')
  const back = deserializeUsageAlertState(serializeUsageAlertState(state))
  assert.deepEqual(back, state)
  assert.equal(deserializeUsageAlertState('{oops'), undefined)
  assert.equal(deserializeUsageAlertState('{"v":2}'), undefined)
  const partial = deserializeUsageAlertState('{"v":1,"lastPercent":[["a::b","x"]],"firedEta":[1,2]}')
  assert.deepEqual(partial, createUsageAlertState(), 'malformed entries drop out silently')
})

test('formatEtaSpan mirrors the panel eta granularity in both locales', () => {
  assert.equal(formatEtaSpan(23, t), '约 23 分钟')
  assert.equal(formatEtaSpan(90, t), '约 1.5 小时')
  assert.equal(formatEtaSpan(3000, (key, params) => translate('en', key, params)), '~2.1 d')
})
