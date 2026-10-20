/**
 * Quota insights: time-series sampling of every refresh, burn-rate (%/h or
 * units/h) over the current monotonic window segment, and an estimated
 * time-to-depletion. Pure functions — no I/O, no cordis — so the whole
 * module is unit-testable with node --test.
 *
 * Window quotas reset periodically, which shows up as an abrupt value drop;
 * the burn rate is only ever computed on the segment AFTER the last reset,
 * so a weekly reset never poisons the 24h rate.
 *
 * Balance items drain monotonically instead (a recharge is the abrupt rise
 * that starts a new segment). Their spend rate is measured on CALENDAR time
 * over the trailing 7 days — idle time included: an "active hour" rate
 * multiplied by 7×24h overstates a real user by the sleep/idle factor
 * (typically ~3×), which is exactly how a ¥20/day user got "¥430/week".
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
/** 余额型条目：日历时间口径的统计窗口（滚动近 7 天）。 */
export const SPEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** 余额型条目：样本跨度不足一天时不给日均——几十分钟的活跃速率外推一周会放大数倍。 */
export const SPEND_MIN_SPAN_MS = 24 * 60 * 60 * 1000
/** 余额型条目：日均口径比瞬时速率稳，耗尽预估可以放宽到一年。 */
export const MAX_BALANCE_ETA_MS = 365 * 24 * 60 * 60 * 1000

/** History key for one provider item row. */
export function itemKey(providerId: string, label: string): string {
  return `${providerId}::${label}`
}

/** The numeric value tracked for an item: percent when present, else used,
 * else remaining (余额型条目——递减序列，供 spendInsight 算消耗速率). */
function trackValue(item: QuotaItem): number | undefined {
  if (item.percent !== undefined && Number.isFinite(item.percent)) return item.percent
  if (item.used !== undefined && Number.isFinite(item.used)) return item.used
  if (item.remaining !== undefined && Number.isFinite(item.remaining)) return item.remaining
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
 * Union two histories: per key, merge points by timestamp (later wins) and
 * sort ascending. Used to fold the on-disk cache back into the live series
 * after a restart — the settings snapshot itself lives in memory only.
 */
export function mergeHistory(a: HistoryMap, b: HistoryMap): HistoryMap {
  const out: HistoryMap = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const byTime = new Map<number, number>()
    for (const point of [...(a[key] ?? []), ...(b[key] ?? [])]) {
      if (!Array.isArray(point) || point.length !== 2) continue
      const [t, v] = point
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      byTime.set(t, v)
    }
    out[key] = [...byTime.entries()].sort((x, y) => x[0] - y[0])
  }
  return out
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
      // 只有「重置级」跳变（窗口重置的骤降 / 充值的突增）才绕过最小间隔；
      // 普通小额变动按 10 分钟节流——否则余额条目每 5 分钟就落一个点，
      // 1000 点上限只够存 3 天多，近 7 天窗口永远凑不满。
      if (last === undefined || now - last[0] >= SAMPLE_MIN_GAP_MS || Math.abs(last[1] - value) > RESET_DROP) {
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

export interface SpendInsight {
  /** 日历时间平均消耗速率（单位/h，含闲置；= 日均 / 24）。 */
  ratePerHour: number
  /** 按日历日均消耗估算的余额归零时间。 */
  etaMinutes: number
  /** 近 7 天实测消耗（不足 7 天按已观测跨度折算，与余额同币种）。 */
  weeklySpent: number
  /** 实测跨度（毫秒）：客户端据此标注「实测 N 天折算」。 */
  spanMs: number
}

/**
 * 余额型条目的消耗洞察（日历时间口径）：
 * - 段 = 最后一次充值（余额突增）之后的样本，避免跨充值算出负消耗；
 * - 窗口 = 段内最近 7 天；速率 = 窗口内余额降幅 / 窗口时长（含闲置），
 *   所以它给出的是真实日均，而不是「只在开着 dsh 的那几小时」的活跃速率；
 * - weeklySpent = 日均 × 7，etaMinutes = 余额 / 日均；
 * - 跨度不足 24h、余额不降、或 ETA 超过一年时返回 undefined——样本太短
 *   就外推一周正是这个数失真的根源，宁可不显示。
 */
export function spendInsight(series: Sample[], item: Pick<QuotaItem, 'remaining'>, now: number): SpendInsight | undefined {
  const remaining = item.remaining
  if (remaining === undefined || !Number.isFinite(remaining) || remaining < 0) return undefined
  const pruned = pruneSeries(series, now)
  // 递减序列的「重置」是突增（充值）：从最后一次明显上涨之后开始取段。
  let start = 0
  for (let i = 1; i < pruned.length; i++) {
    if (pruned[i]![1] > pruned[i - 1]![1] + RESET_DROP) start = i
  }
  const segment = pruned.slice(start)
  if (segment.length < 2) return undefined
  const last = segment[segment.length - 1]!
  // 只取最近 7 天的样本：更早的点对「当前日均」没有参考价值。
  let from = segment.length - 1
  while (from > 0 && segment[from - 1]![0] >= last[0] - SPEND_WINDOW_MS) from -= 1
  const first = segment[from]!
  const spanMs = last[0] - first[0]
  if (spanMs < SPEND_MIN_SPAN_MS) return undefined
  const spent = first[1] - last[1]
  if (spent <= 0) return undefined
  const dailySpent = spent / (spanMs / (24 * 60 * 60 * 1000))
  if (!Number.isFinite(dailySpent) || dailySpent <= 0) return undefined
  const etaMinutes = (remaining / dailySpent) * 1440
  if (!Number.isFinite(etaMinutes) || etaMinutes * 60000 > MAX_BALANCE_ETA_MS) return undefined
  return {
    ratePerHour: Number((dailySpent / 24).toFixed(2)),
    etaMinutes: Math.round(etaMinutes),
    weeklySpent: Number((dailySpent * 7).toFixed(2)),
    spanMs,
  }
}
