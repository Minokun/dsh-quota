import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUsageAlertState, evaluateUsageAlerts, formatEtaSpan, type UsageAlertProvider, type UsageAlertState } from '../src/client/usage-alerts.ts'
import { translate, type TFn } from '../src/client/locale.ts'

/** One provider row with the fields usage-alert evaluation reads. */
function provider(overrides: Partial<UsageAlertProvider> = {}): UsageAlertProvider {
  return { id: 'kimi', label: 'Kimi Code', status: 'ok', items: [], ...overrides }
}

/** Convenience: evaluate with an empty dismissed set. */
function run(providers: UsageAlertProvider[], state: UsageAlertState, alertPercent = 85, dismissed: Set<string> = new Set()) {
  return evaluateUsageAlerts(providers, alertPercent, dismissed, state)
}

test('crossing the threshold fires once and does not repeat while staying above', () => {
  let s = createUsageAlertState()
  let r = run([provider({ items: [{ label: '周额度', percent: 83 }] })], s)
  assert.equal(r.alerts.length, 0)
  r = run([provider({ items: [{ label: '周额度', percent: 85 }] })], r.state)
  assert.deepEqual(r.alerts, [{ key: 'kimi::周额度', kind: 'threshold', providerId: 'kimi', providerLabel: 'Kimi Code', itemLabel: '周额度', percent: 85 }])
  r = run([provider({ items: [{ label: '周额度', percent: 90 }] })], r.state)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 0)
})

test('the first observation already over the threshold counts as one firing', () => {
  const r = run([provider({ items: [{ label: '周额度', percent: 99 }] })], createUsageAlertState())
  assert.equal(r.alerts.length, 1)
  assert.equal(r.alerts[0]!.kind, 'threshold')
  assert.equal(r.alerts[0]!.percent, 99)
})

test('after dismissal the alert refires only once the percent climbs ≥5 points', () => {
  const dismissed = new Set(['kimi::周额度'])
  // 用户在 86% 时点了 ✕：dismissedAt 记录 86。
  let s: UsageAlertState = { lastPercent: new Map([['kimi::周额度', 86]]), firedEta: new Set(), dismissedAt: new Map([['kimi::周额度', 86]]) }
  let r = run([provider({ items: [{ label: '周额度', percent: 88 }] })], s, 85, dismissed)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 0)
  r = run([provider({ items: [{ label: '周额度', percent: 90.9 }] })], r.state, 85, dismissed)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 0)
  r = run([provider({ items: [{ label: '周额度', percent: 91 }] })], r.state, 85, dismissed)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1)
  assert.equal(r.alerts.find((a) => a.kind === 'threshold')!.percent, 91)
  // 重触发一次后不再连发。
  r = run([provider({ items: [{ label: '周额度', percent: 95 }] })], r.state, 85, dismissed)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 0)
})

test('a window reset (percent falls back below the threshold) re-arms the alert', () => {
  const dismissed = new Set(['kimi::周额度'])
  let s: UsageAlertState = { lastPercent: new Map([['kimi::周额度', 86]]), firedEta: new Set(), dismissedAt: new Map([['kimi::周额度', 86]]) }
  // 窗口重置：骤降到 10 —— 解除 dismiss 抑制。
  let r = run([provider({ items: [{ label: '周额度', percent: 10 }] })], s, 85, dismissed)
  assert.equal(r.alerts.length, 0)
  assert.equal(r.state.dismissedAt.has('kimi::周额度'), false)
  // 再次跨越阈值 → 重新告警。
  r = run([provider({ items: [{ label: '周额度', percent: 86 }] })], r.state, 85, dismissed)
  assert.equal(r.alerts.filter((a) => a.kind === 'threshold').length, 1)
})

test('eta at or below 30 minutes fires once per window and resets after recovering above 60', () => {
  let s = createUsageAlertState()
  let r = run([provider({ items: [{ label: '300m 窗口', percent: 60, etaMinutes: 25 }] })], s)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 1)
  assert.equal(r.alerts.find((a) => a.kind === 'eta')!.etaMinutes, 25)
  r = run([provider({ items: [{ label: '300m 窗口', percent: 65, etaMinutes: 28 }] })], r.state)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 0)
  // 回升到 60 分钟以上：窗口缓解，重置已发标记。
  r = run([provider({ items: [{ label: '300m 窗口', percent: 40, etaMinutes: 90 }] })], r.state)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 0)
  r = run([provider({ items: [{ label: '300m 窗口', percent: 70, etaMinutes: 20 }] })], r.state)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 1)
})

test('an item disappearing resets the eta fired flag (and the threshold baseline)', () => {
  let s = createUsageAlertState()
  let r = run([provider({ items: [{ label: '300m 窗口', etaMinutes: 15 }] })], s)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 1)
  // 条目消失（平台只剩别的条目）→ 状态机清理该 key。
  r = run([provider({ items: [{ label: '周额度', percent: 50 }] })], r.state)
  assert.equal(r.state.firedEta.has('kimi::300m 窗口'), false)
  assert.equal(r.state.lastPercent.has('kimi::300m 窗口'), false)
  // 条目再次出现且又接近耗尽 → 按新窗口再告警一次。
  r = run([provider({ items: [{ label: '300m 窗口', etaMinutes: 15 }] })], r.state)
  assert.equal(r.alerts.filter((a) => a.kind === 'eta').length, 1)
})

test('non-ok platforms are skipped entirely', () => {
  const r = run([provider({ status: 'error', items: [{ label: '周额度', percent: 99 }, { label: '300m 窗口', etaMinutes: 5 }] })], createUsageAlertState())
  assert.equal(r.alerts.length, 0)
  assert.equal(r.state.lastPercent.size, 0)
  assert.equal(r.state.firedEta.size, 0)
})

test('evaluateUsageAlerts is pure: inputs are never mutated', () => {
  const state: UsageAlertState = {
    lastPercent: new Map([['kimi::周额度', 50]]),
    firedEta: new Set(['kimi::300m 窗口']),
    dismissedAt: new Map([['kimi::周额度', 86]]),
  }
  const dismissed = new Set(['kimi::周额度'])
  const providers = [provider({ items: [{ label: '周额度', percent: 95 }, { label: '300m 窗口', etaMinutes: 10 }] })]
  const snapshotProviders = JSON.stringify(providers)
  const r = evaluateUsageAlerts(providers, 85, dismissed, state)
  assert.ok(r.alerts.length > 0)
  assert.deepEqual([...state.lastPercent], [['kimi::周额度', 50]])
  assert.deepEqual([...state.firedEta], ['kimi::300m 窗口'])
  assert.deepEqual([...state.dismissedAt], [['kimi::周额度', 86]])
  assert.deepEqual([...dismissed], ['kimi::周额度'])
  assert.equal(JSON.stringify(providers), snapshotProviders)
  // 返回的是新实例，改它不影响原 state。
  r.state.lastPercent.set('other::x', 1)
  assert.equal(state.lastPercent.has('other::x'), false)
})

test('formatEtaSpan keeps the eta.minutes / eta.hours / eta.days granularity', () => {
  const zh: TFn = (key, params) => translate('zh', key, params)
  const en: TFn = (key, params) => translate('en', key, params)
  assert.equal(formatEtaSpan(25, zh), '约 25 分钟')
  assert.equal(formatEtaSpan(25, en), '~25 min')
  assert.equal(formatEtaSpan(138, zh), '约 2.3 小时')
  assert.equal(formatEtaSpan(138, en), '~2.3 h')
  assert.equal(formatEtaSpan(2880, zh), '约 2.0 天')
  assert.equal(formatEtaSpan(2880, en), '~2.0 d')
})
