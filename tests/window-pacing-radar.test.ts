import assert from 'node:assert/strict'
import test from 'node:test'
import { burnInsight, evaluateWindowPacing } from '../src/insights.ts'
import { formatProviderSummary, rankHeadlineItems, selectHeadlineWindow } from '../src/window-rank.ts'
import { createUsageAlertState, evaluateUsageAlerts, willResetBeforeEta } from '../src/client/usage-alerts.ts'
import { translate } from '../src/client/locale.ts'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const now = Date.parse('2026-11-24T12:00:00Z')

test('selectHeadlineWindow picks the tightest window (91% weekly beats 15% 5h window)', () => {
  const items = [
    { label: '5小时窗口', percent: 15 },
    { label: '周额度', percent: 91 },
  ]
  const picked = selectHeadlineWindow(items)
  assert.ok(picked)
  assert.equal(picked.label, '周额度')
  assert.equal(picked.percent, 91)
})

test('selectHeadlineWindow prioritizes depletesBeforeReset over raw lower-risk window, and shorter window on ties', () => {
  const byPace = selectHeadlineWindow([
    { label: '5小时窗口', percent: 62, depletesBeforeReset: false },
    { label: '周额度', percent: 55, depletesBeforeReset: true },
  ])
  assert.equal(byPace?.label, '周额度')

  const tieShortWins = selectHeadlineWindow([
    { label: '月额度', percent: 70 },
    { label: '周额度', percent: 70 },
    { label: '5小时窗口', percent: 70 },
  ])
  assert.equal(tieShortWins?.label, '5小时窗口')
})

test('formatProviderSummary surfaces the tightest windows first when >2 windows exist', () => {
  const summary = formatProviderSummary({
    status: 'ok',
    items: [
      { label: '5 小时窗口', percent: 10 },
      { label: '月度搜索窗口', percent: 12 },
      { label: '周额度', percent: 94 },
    ],
  }, {
    weeklyTag: '周',
    monthlyTag: '月',
    remainingPercent: (p) => `剩${p}%`,
    remainingCount: (n) => `剩${n}`,
  })
  assert.match(summary, /^周 剩6%/)
})

test('imminent reset (resetAt in 8m, raw ETA 25m) suppresses etaMinutes and blocks false eta usageAlert', () => {
  const resetAt = new Date(now + 8 * MIN).toISOString()
  // Series draining ~48%/h: at 80% left=20% -> raw ETA = 25 min, but reset is in 8 min!
  const series: [number, number][] = [
    [now - HOUR, 32],
    [now, 80],
  ]
  const insight = burnInsight(series, { percent: 80, resetAt }, now)
  assert.ok(insight)
  assert.equal(insight.depletesBeforeReset, false)
  assert.equal(insight.etaMinutes, undefined)

  // Even if an item arrives with explicit etaMinutes: 25 and resetAt in 8m, evaluateUsageAlerts must NOT emit kind='eta'
  const alertEval = evaluateUsageAlerts(
    [{
      id: 'codex',
      label: 'Codex',
      status: 'ok',
      items: [{ label: '5小时窗口', percent: 88, etaMinutes: 25, resetAt }],
    }],
    95,
    createUsageAlertState(),
    now,
  )
  assert.equal(alertEval.alerts.some((a) => a.kind === 'eta'), false)
  assert.equal(willResetBeforeEta(25, resetAt, now), true)
})

test('weekly over-pace (55% used, ETA 40h, reset in 120h) flags depletesBeforeReset = true and bilingual copy exists', () => {
  const resetAt = new Date(now + 120 * HOUR).toISOString()
  // 45% left, draining at 1.125%/h -> ETA = 40h (2400 min), reset in 120h (7200 min)
  const series: [number, number][] = [
    [now - 8 * HOUR, 46],
    [now, 55],
  ]
  const insight = burnInsight(series, { percent: 55, resetAt }, now)
  assert.ok(insight)
  assert.equal(insight.etaMinutes, 2400)
  assert.equal(insight.depletesBeforeReset, true)

  assert.match(translate('zh', 'pace.warn'), /重置前耗尽/)
  assert.match(translate('en', 'pace.warn'), /Pace exceeds reset window/)
})

test('evaluateWindowPacing handles missing resetAt, expired resetAt, ±60s jitter, percent=0, and percent=100', () => {
  // Missing resetAt
  assert.deepEqual(evaluateWindowPacing(120, undefined, now), { etaMinutes: 120 })
  // Expired resetAt
  assert.deepEqual(evaluateWindowPacing(120, new Date(now - MIN).toISOString(), now), { etaMinutes: 120 })
  // Safety margin (90%-100% of reset window): ±60s jitter near reset boundary does not flip to depletesBeforeReset=true
  const resetIn60m = new Date(now + 60 * MIN).toISOString()
  const resetIn59m = new Date(now + 59 * MIN).toISOString()
  assert.equal(evaluateWindowPacing(56, resetIn60m, now).depletesBeforeReset, false)
  assert.equal(evaluateWindowPacing(56, resetIn59m, now).depletesBeforeReset, false)
  // Already at 100% (rawEtaMinutes = 0) with future reset -> depletesBeforeReset = true
  assert.deepEqual(evaluateWindowPacing(0, resetIn60m, now), { etaMinutes: 0, depletesBeforeReset: true })
  // percent = 0 with flat series -> burnInsight returns undefined
  assert.equal(burnInsight([[now - HOUR, 0], [now, 0]], { percent: 0, resetAt: resetIn60m }, now), undefined)
  // rankHeadlineItems preserves non-percent balance items after percent windows
  const ranked = rankHeadlineItems([
    { label: '总余额' },
    { label: '5小时窗口', percent: 20 },
    { label: '周额度', percent: 85 },
  ])
  assert.deepEqual(ranked.map((i) => i.label), ['周额度', '5小时窗口', '总余额'])
})
