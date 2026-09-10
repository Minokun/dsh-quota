/**
 * Quota insights: time-series sampling of every refresh, burn-rate (%/h or
 * units/h) over the current monotonic window segment, and an estimated
 * time-to-depletion. Pure functions — no I/O, no cordis — so the whole
 * module is unit-testable with node --test.
 *
 * Window quotas reset periodically, which shows up as an abrupt value drop;
 * the burn rate is only ever computed on the segment AFTER the last reset,
 * so a weekly reset never poisons the 24h rate.
 * @module dsh-quota/insights
 */

import type { ProviderSnapshot, QuotaItem } from './config.ts'

/** One sample point: [epoch milliseconds, value] (percent or used-units). */
export type Sample = [number, number]

/** History keyed by `${providerId}::${itemLabel}`. */
export type HistoryMap = Record<string, Sample[]>

/** Samples older than this are pruned. */
export const HISTORY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
/** Append at most one sample per this interval (refresh may run more often). */
export const SAMPLE_MIN_GAP_MS = 10 * 60 * 1000
/** Hard cap per series (retention usually kicks in first). */
export const HISTORY_MAX_POINTS = 1000
/** A drop larger than this between consecutive samples means the window reset. */
export const RESET_DROP = 3
/** A burn rate is only reported once the segment spans at least this long. */
export const MIN_SPAN_MS = 30 * 60 * 1000
/** ETA longer than this is noise (rate ≈ 0) and is not reported. */
export const MAX_ETA_MS = 60 * 24 * 60 * 60 * 1000

/** History key for one provider item row. */
export function itemKey(providerId: string, label: string): string {
  return `${providerId}::${label}`
}

/** The numeric value tracked for an item: percent when present, else used. */
function trackValue(item: QuotaItem): number | undefined {
  if (item.percent !== undefined && Number.isFinite(item.percent)) return item.percent
  if (item.used !== undefined && Number.isFinite(item.used)) return item.used
  return undefined
}

/** Prune aged/excess points (mutates and returns the series). */
export function pruneSeries(series: Sample[], now: number): Sample[] {
  let s = series
  const cutoff = now - HISTORY_RETENTION_MS
  if (s.length > 0 && s[0]![0] < cutoff) s = s.filter((p) => p[0] >= cutoff)
  if (s.length > HISTORY_MAX_POINTS) s = s.slice(s.length - HISTORY_MAX_POINTS)
  return s
}

/**
 * Fold the latest provider snapshot into the history map. Returns a NEW map
 * (the settings scope treats state immutably); series are appended only when
 * the last point is older than SAMPLE_MIN_GAP_MS, and pruned to the
 * retention window. Series for rows that disappeared age out on their own.
 */
export function recordSamples(history: HistoryMap, providers: ProviderSnapshot[], now: number): HistoryMap {
  const next: HistoryMap = {}
  // Carry existing series forward (pruned), so rows missing in this round
  // still age out naturally instead of vanishing on one failed refresh.
  for (const [key, series] of Object.entries(history)) {
    if (!Array.isArray(series)) continue
    next[key] = pruneSeries(series.filter((p) => Array.isArray(p) && p.length === 2), now)
  }
  for (const provider of providers) {
    if (provider.status !== 'ok') continue
    for (const item of provider.items) {
      const value = trackValue(item)
      if (value === undefined) continue
      const key = itemKey(provider.id, item.label)
      const series = next[key] ?? []
      const last = series[series.length - 1]
      if (last === undefined || now - last[0] >= SAMPLE_MIN_GAP_MS || Math.abs(last[1] - value) > Number.EPSILON) {
        series.push([now, value])
      }
      next[key] = pruneSeries(series, now)
    }
  }
  return next
}

/** Samples of the current monotonic segment: everything after the last reset drop. */
export function currentSegment(series: Sample[]): Sample[] {
  let start = 0
  for (let i = 1; i < series.length; i++) {
    if (series[i]![1] < series[i - 1]![1] - RESET_DROP) start = i
  }
  return series.slice(start)
}

export interface BurnInsight {
  /** Average consumption rate over the current segment (%/h or units/h). */
  ratePerHour: number
  /** Estimated minutes until the window/limit is depleted. */
  etaMinutes: number
}

/**
 * Burn rate + depletion ETA for one item from its sample series.
 * Percent items deplete at 100; used/limit items deplete at `limit` (or by
 * `remaining`). Returns undefined when the segment is too young, flat, or
 * the quota would outlive MAX_ETA_MS — a quota that is not meaningfully
 * draining should not produce a scary countdown.
 */
export function burnInsight(series: Sample[], item: Pick<QuotaItem, 'percent' | 'used' | 'limit' | 'remaining'>, now: number): BurnInsight | undefined {
  const segment = currentSegment(pruneSeries(series, now))
  if (segment.length < 2) return undefined
  const first = segment[0]!
  const last = segment[segment.length - 1]!
  const spanMs = last[0] - first[0]
  if (spanMs < MIN_SPAN_MS) return undefined
  const gained = last[1] - first[1]
  if (gained <= 0) return undefined
  const ratePerHour = gained / (spanMs / 3600000)
  if (ratePerHour <= 0) return undefined

  let left: number | undefined
  if (item.percent !== undefined) {
    left = 100 - last[1]
  } else if (item.remaining !== undefined) {
    left = item.remaining
  } else if (item.limit !== undefined) {
    left = item.limit - last[1]
  }
  if (left === undefined || left < 0) return undefined
  const etaMinutes = (left / ratePerHour) * 60
  if (!Number.isFinite(etaMinutes) || etaMinutes * 60000 > MAX_ETA_MS) return undefined
  return { ratePerHour: Number(ratePerHour.toFixed(2)), etaMinutes: Math.round(etaMinutes) }
}
