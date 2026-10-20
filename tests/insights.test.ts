import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HISTORY_MAX_POINTS,
  HISTORY_RETENTION_MS,
  SAMPLE_MIN_GAP_MS,
  burnInsight,
  currentSegment,
  itemKey,
  mergeHistory,
  pruneSeries,
  recordSamples,
  spendInsight,
  type HistoryMap,
} from '../src/insights.ts'
import type { ProviderSnapshot } from '../src/config.ts'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const now = Date.parse('2026-09-10T12:00:00Z')

function provider(id: string, percent: number, label = '5h 窗口'): ProviderSnapshot {
  return { id, label: id, status: 'ok', via: 'api', items: [{ label, percent, display: `已用 ${percent}%` }] }
}

test('recordSamples appends on first sight and after the minimum gap', () => {
  let h: HistoryMap = {}
  h = recordSamples(h, [provider('kimi', 20)], now)
  const key = itemKey('kimi', '5h 窗口')
  assert.deepEqual(h[key], [[now, 20]])

  // Same value inside the gap: no new point.
  h = recordSamples(h, [provider('kimi', 20)], now + 5 * 60 * 1000)
  assert.equal(h[key]!.length, 1)

  // Small drift inside the gap is throttled — otherwise a balance item that
  // changes on every 5-minute refresh burns the 1000-point cap in ~3 days.
  h = recordSamples(h, [provider('kimi', 21)], now + 5 * 60 * 1000)
  assert.equal(h[key]!.length, 1)

  // A reset-sized jump is recorded immediately, even inside the gap.
  h = recordSamples(h, [provider('kimi', 25)], now + 6 * 60 * 1000)
  assert.equal(h[key]!.length, 2)

  h = recordSamples(h, [provider('kimi', 25)], now + 20 * 60 * 1000)
  assert.equal(h[key]!.length, 3)
})

test('recordSamples skips failed providers and valueless items', () => {
  const bad: ProviderSnapshot = { id: 'x', label: 'X', status: 'error', items: [{ label: '余额' }] }
  const h = recordSamples({}, [bad], now)
  assert.deepEqual(h, {})
})

test('pruneSeries drops points beyond retention and caps the series', () => {
  const old: [number, number][] = [[now - HISTORY_RETENTION_MS - 1000, 1], [now, 2]]
  assert.deepEqual(pruneSeries(old, now), [[now, 2]])

  const big: [number, number][] = Array.from({ length: HISTORY_MAX_POINTS + 50 }, (_, i) => [now - i * 1000, i])
  assert.equal(pruneSeries(big, now).length, HISTORY_MAX_POINTS)
})

test('mergeHistory unions series by timestamp, later value wins, sorted', () => {
  const a: HistoryMap = { k: [[now, 10], [now + 1000, 11]] }
  const b: HistoryMap = { k: [[now + 1000, 12], [now + 2000, 13]], j: [[now, 1]] }
  assert.deepEqual(mergeHistory(a, b), {
    k: [[now, 10], [now + 1000, 12], [now + 2000, 13]],
    j: [[now, 1]],
  })
})

test('currentSegment cuts the series at the last window reset drop', () => {
  const series: [number, number][] = [
    [now - 3 * HOUR, 80],
    [now - 2 * HOUR, 95],
    [now - 1 * HOUR, 5], // reset: 95 → 5
    [now, 12],
  ]
  assert.deepEqual(currentSegment(series), [[now - 1 * HOUR, 5], [now, 12]])
})

test('burnInsight reports percent-per-hour and depletion ETA', () => {
  const series: [number, number][] = [
    [now - 2 * HOUR, 40],
    [now - 1 * HOUR, 50],
    [now, 60],
  ]
  const insight = burnInsight(series, { percent: 60 }, now)
  assert.ok(insight)
  assert.equal(insight.ratePerHour, 10)
  assert.equal(insight.etaMinutes, 240) // (100 - 60) / 10 %/h = 4h
})

test('burnInsight uses remaining units for used/limit items', () => {
  const series: [number, number][] = [
    [now - 2 * HOUR, 1000],
    [now, 3000],
  ]
  const insight = burnInsight(series, { used: 3000, limit: 13000, remaining: 10000 }, now)
  assert.ok(insight)
  assert.equal(insight.ratePerHour, 1000)
  assert.equal(insight.etaMinutes, 600) // 10000 / 1000 = 10h
})

test('burnInsight ignores segments that are too young, flat, or across a reset', () => {
  // too young (< 30 min span)
  assert.equal(burnInsight([[now - 10 * 60 * 1000, 10], [now, 20]], { percent: 20 }, now), undefined)
  // flat
  assert.equal(burnInsight([[now - 2 * HOUR, 50], [now, 50]], { percent: 50 }, now), undefined)
  // the rise happened before a reset: the post-reset segment spans < 30 min
  const reset: [number, number][] = [[now - 2 * HOUR, 90], [now - 10 * 60 * 1000, 10], [now, 12]]
  assert.equal(burnInsight(reset, { percent: 12 }, now), undefined)
  // a longer-lived post-reset segment DOES yield a fresh rate (reset poisoned nothing)
  const recovered: [number, number][] = [[now - 2 * HOUR, 90], [now - HOUR, 10], [now, 20]]
  assert.deepEqual(burnInsight(recovered, { percent: 20 }, now), { ratePerHour: 10, etaMinutes: 480 })
})

test('burnInsight caps absurdly long ETAs', () => {
  const series: [number, number][] = [[now - 10 * HOUR, 10], [now, 10.1]] // 0.01 %/h
  assert.equal(burnInsight(series, { percent: 10.1 }, now), undefined)
})

test('spendInsight measures a calendar-day average, not the active-hour rate', () => {
  // 余额 3 天 200 → 140（共 60）：日历日均 20（含闲置），不是 2.5/h 那种
  // 「开着 dsh 时的活跃速率」。近 7 天 = 140，剩余 140 还能撑 7 天。
  const series: [number, number][] = [
    [now - 3 * DAY, 200],
    [now - 2 * DAY, 180],
    [now - DAY, 160],
    [now, 140],
  ]
  const insight = spendInsight(series, { remaining: 140 }, now)
  assert.ok(insight)
  assert.equal(insight.ratePerHour, 0.83) // 20 / 24
  assert.equal(insight.weeklySpent, 140)
  assert.equal(insight.etaMinutes, 10080) // 140 / 20 = 7 天
  assert.equal(insight.spanMs, 3 * DAY)
})

test('spendInsight only measures the trailing 7 days', () => {
  // 10 天前 1000 → 7 天前 900：更早的降幅不算进「近 7 天」。
  const series: [number, number][] = [
    [now - 10 * DAY, 1000],
    [now - 7 * DAY, 900],
    [now - 3 * DAY, 880],
    [now, 830],
  ]
  const insight = spendInsight(series, { remaining: 830 }, now)
  assert.ok(insight)
  // 窗口 = 近 7 天：900 → 830 = 70，日均 10 → 近 7 天 70
  assert.equal(insight.weeklySpent, 70)
  assert.equal(insight.ratePerHour, 0.42)
  assert.equal(insight.etaMinutes, 119520) // 830 / 10 = 83 天
})

test('spendInsight treats a recharge jump as a new segment', () => {
  // 中途充值（40 → 200 突增）：只按充值后的新段算，且新段要满 1 天。
  const series: [number, number][] = [
    [now - 3 * DAY, 80],
    [now - 2 * DAY, 40],
    [now - 30 * HOUR, 200], // 充值
    [now, 180],
  ]
  const insight = spendInsight(series, { remaining: 180 }, now)
  assert.ok(insight)
  // 充值后 30 小时：200 → 180 = 20 → 日均 16 → 近 7 天 112
  assert.equal(insight.weeklySpent, 112)
  assert.equal(insight.ratePerHour, 0.67)
  assert.equal(insight.etaMinutes, 16200) // 180 / 16 = 11.25 天
})

test('spendInsight refuses windows shorter than a day (no burst extrapolation)', () => {
  // 这正是线上那个 bug：68 分钟的活跃样本 ×168h 把 ¥20/天 放大成 ¥421/周。
  const burst: [number, number][] = [[now - 68 * 60 * 1000, 2828.93], [now, 2826.09]]
  assert.equal(spendInsight(burst, { remaining: 2826.09 }, now), undefined)
})

test('spendInsight ignores flat/young segments and missing remaining', () => {
  // 余额不动：无消耗
  assert.equal(spendInsight([[now - 2 * DAY, 100], [now, 100]], { remaining: 100 }, now), undefined)
  // 没有 remaining 数值
  assert.equal(spendInsight([[now - 2 * DAY, 100], [now, 90]], {}, now), undefined)
  // 充值后尚未消耗：回升段不算消耗
  assert.equal(spendInsight([[now - 2 * DAY, 50], [now, 200]], { remaining: 200 }, now), undefined)
  // 日均太低、ETA 超过一年上限
  assert.equal(spendInsight([[now - 2 * DAY, 100], [now, 99.9]], { remaining: 100 }, now), undefined)
})
