import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createUsageAlertState,
  deserializeUsageAlertState,
  evaluateUsageAlerts,
  formatEtaSpan,
  sameWindow,
  serializeUsageAlertState,
  WINDOW_SAME_MS,
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

test('an item that blinks out for one round does not re-fire when it comes back', () => {
  // 回归：magpie 每 30s 自己刷账号额度，刷失败的那一轮那张卡连 windows 都没有，
  // 面板上条目闪没一次又回来。旧实现「条目消失 = 清空三张表」会因此重新弹。
  let state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 90, etaMinutes: 10, resetAt: 'w1' }] })], TH, createUsageAlertState()).state
  state = evaluateUsageAlerts([provider({ items: [] })], TH, state).state
  const r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 91, etaMinutes: 10, resetAt: 'w1' }] })], TH, state)
  assert.equal(r.alerts.length, 0, 'same window: vanishing for a round is not a new window')
})

test('a real window rollover after the item vanished still fires once', () => {
  let state = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 90, resetAt: '2026-10-09T00:00:00.000Z' }] })], TH, createUsageAlertState()).state
  state = evaluateUsageAlerts([provider({ items: [] })], TH, state).state
  const r = evaluateUsageAlerts([provider({ items: [{ label: '周额度', percent: 92, resetAt: '2026-10-16T00:00:00.000Z' }] })], TH, state)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1, 'next window is genuinely a new event')
})

test('resetAt jitter of a few seconds is the same window, not a new one', () => {
  // 回归：真实误弹证据 —— localStorage 里同一张 Codex 30 天窗口同时存在
  // `…T16:47:11+08:00` 与 `…T16:47:12+08:00` 两个窗口标识，同一条 100% 的
  // 窗口因此被当成两个新窗口反复提醒。
  let state = evaluateUsageAlerts([provider({ items: [{ label: '30 天窗口', percent: 100, resetAt: '2026-12-10T16:47:11+08:00' }] })], TH, createUsageAlertState()).state
  const r = evaluateUsageAlerts([provider({ items: [{ label: '30 天窗口', percent: 100, resetAt: '2026-12-10T16:47:12+08:00' }] })], TH, state)
  state = r.state
  assert.equal(r.alerts.length, 0, 'one second of drift is still the same window')
  const eta = evaluateUsageAlerts([provider({ items: [{ label: '30 天窗口', percent: 100, etaMinutes: 3, resetAt: '2026-12-10T16:47:13+08:00' }] })], TH, state)
  assert.equal(eta.alerts.filter((a) => a.kind === 'eta').length, 1, 'eta had not fired in this window yet')
  const again = evaluateUsageAlerts([provider({ items: [{ label: '30 天窗口', percent: 100, etaMinutes: 3, resetAt: '2026-12-10T16:47:11+08:00' }] })], TH, eta.state)
  assert.equal(again.alerts.length, 0, 'eta does not re-fire while the resetAt keeps wobbling')
})

test('sameWindow tolerates drift only up to the window tolerance', () => {
  const a = '2026-12-10T16:47:11+08:00'
  const at = Date.parse(a)
  const edge = new Date(at + WINDOW_SAME_MS).toISOString()
  const beyond = new Date(at + WINDOW_SAME_MS + 1000).toISOString()
  assert.equal(sameWindow(a, '2026-12-10T16:47:12+08:00'), true)
  assert.equal(sameWindow(a, edge), true, 'exactly WINDOW_SAME_MS apart still merges')
  assert.equal(sameWindow(a, beyond), false, 'beyond tolerance is a different window')
  assert.equal(sameWindow('static', 'static'), true)
  assert.equal(sameWindow('static', a), false)
  assert.equal(sameWindow(undefined, undefined), true)
})

test('repeated one-second drift never accumulates into a new window', () => {
  // 基准要跟着抖：否则每次 +1s 单向累积，跑够 WINDOW_SAME_MS 就又会当成新窗口。
  const base = Date.parse('2026-12-10T16:47:11+08:00')
  let state = createUsageAlertState()
  const steps = Math.ceil((WINDOW_SAME_MS * 3) / 1000)
  let fires = 0
  for (let i = 0; i < steps; i++) {
    const resetAt = new Date(base + i * 1000).toISOString()
    const r = evaluateUsageAlerts([provider({ items: [{ label: '30 天窗口', percent: 100, resetAt }] })], TH, state)
    state = r.state
    fires += r.alerts.length
  }
  assert.equal(fires, 1, 'drift keeps updating the baseline, so only the first round fires')
})

test('platforms that are not ok are ignored', () => {
  const r = evaluateUsageAlerts([provider({ status: 'error', items: [{ label: '周额度', percent: 99 }] })], TH, createUsageAlertState())
  assert.equal(r.alerts.length, 0)
})

test('evaluate is pure: inputs and the previous state stay untouched', () => {
  const state = createUsageAlertState()
  state.lastPercent.set('kimi::周额度', 10)
  state.shown.set('kimi::周额度', 'w1')
  state.firedEta.set('kimi::周额度', 'w1')
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
  state.firedEta.set('a::b', 'w9')
  const back = deserializeUsageAlertState(serializeUsageAlertState(state))
  assert.deepEqual(back, state)
  assert.equal(deserializeUsageAlertState('{oops'), undefined)
  assert.equal(deserializeUsageAlertState('{"v":9}'), undefined)
  const partial = deserializeUsageAlertState('{"v":2,"lastPercent":[["a::b","x"]],"firedEta":[1,2]}')
  assert.deepEqual(partial, createUsageAlertState(), 'malformed entries drop out silently')
})

test('v1 state (firedEta as strings) is migrated, keeping keys that contain @', () => {
  // 老版本把 eta 记成 `${key}@${windowId}`；magpie 的 key 自带邮箱（含 @），
  // 所以必须从右边拆，否则升级一次会把所有已提醒窗口当成没提醒过。
  const v1 = JSON.stringify({
    v: 1,
    lastPercent: [['magpie#codex/952718180@qq.com::30 天窗口', 100]],
    shown: [['magpie#codex/952718180@qq.com::30 天窗口', '2026-12-10T16:47:11+08:00']],
    firedEta: ['magpie#codex/952718180@qq.com::30 天窗口@2026-12-10T16:47:11+08:00'],
  })
  const state = deserializeUsageAlertState(v1)
  assert.equal(state?.firedEta.get('magpie#codex/952718180@qq.com::30 天窗口'), '2026-12-10T16:47:11+08:00')
  // 迁移过来的记录依然压得住同窗口提醒（哪怕 resetAt 抖了一秒）。
  const r = evaluateUsageAlerts([{
    id: 'magpie#codex/952718180@qq.com',
    label: 'Magpie · Codex · free',
    status: 'ok',
    items: [{ label: '30 天窗口', percent: 100, etaMinutes: 2, resetAt: '2026-12-10T16:47:12+08:00' }],
  }], TH, state!)
  assert.equal(r.alerts.length, 0, 'migrated state still suppresses the same window')
})

test('formatEtaSpan mirrors the panel eta granularity in both locales', () => {
  assert.equal(formatEtaSpan(23, t), '约 23 分钟')
  assert.equal(formatEtaSpan(90, t), '约 1.5 小时')
  assert.equal(formatEtaSpan(3000, (key, params) => translate('en', key, params)), '~2.1 d')
})
