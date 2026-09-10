import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HISTORY_MAX_POINTS,
  HISTORY_RETENTION_MS,
  SAMPLE_MIN_GAP_MS,
  burnInsight,
  currentSegment,
  itemKey,
  pruneSeries,
  recordSamples,
  type HistoryMap,
} from '../src/insights.ts'
import type { ProviderSnapshot } from '../src/config.ts'

const HOUR = 3600 * 1000
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

  // Value changed inside the gap: recorded (usage moves between refreshes).
  h = recordSamples(h, [provider('kimi', 21)], now + 5 * 60 * 1000)
  assert.equal(h[key]!.length, 2)

  h = recordSamples(h, [provider('kimi', 25)], now + SAMPLE_MIN_GAP_MS + 1)
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
