/**
 * Window urgency ranking for multi-window Coding Plans (5h / weekly / monthly).
 *
 * Pure, dependency-free helpers shared by the Host (`controller.ts`) and
 * Browser (`QuotaPanel.tsx`, `QuotaDockBar.tsx`, `client/controller.ts`) so
 * a relaxed short window (e.g. 5h @ 12%) never masks a nearly exhausted
 * weekly window (e.g. weekly @ 94%) on the ring, pill, or dock bar.
 * @module dsh-quota/window-rank
 */

/** Structural subset of QuotaItem / PanelItem used for urgency ranking. */
export interface WindowRankItem {
  label: string
  percent?: number
  remaining?: number
  display?: string
  depletesBeforeReset?: boolean
}

/**
 * Coarse duration bucket from an item label so ties prefer shorter windows
 * (5h / 300m before daily before weekly before monthly).
 */
export function windowDurationBucket(label: string): number {
  if (/(\d+)\s*(?:m|min|分钟|h|hr|小时)\b/i.test(label) || (/窗口|window/i.test(label) && !/周|月|week|month/i.test(label))) {
    return 0
  }
  if (/今日|每日|日额|day|daily/i.test(label)) return 1
  if (/本周|周|week/i.test(label)) return 2
  if (/本月|月|month/i.test(label)) return 3
  return 4
}

/** Compare two percent-bearing quota items: tighter / higher-risk comes first. */
export function comparePercentWindows(a: WindowRankItem, b: WindowRankItem): number {
  const aPace = a.depletesBeforeReset === true ? 1 : 0
  const bPace = b.depletesBeforeReset === true ? 1 : 0
  if (aPace !== bPace) return bPace - aPace

  const aPct = a.percent ?? -1
  const bPct = b.percent ?? -1
  if (aPct !== bPct) return bPct - aPct

  return windowDurationBucket(a.label) - windowDurationBucket(b.label)
}

/**
 * Pick the single tightest percent-bearing window for a provider card
 * (used by the floating ring and composer dock headline).
 */
export function selectHeadlineWindow<T extends WindowRankItem>(items: readonly T[]): T | undefined {
  const withPct = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.percent !== undefined && Number.isFinite(item.percent))
  if (withPct.length === 0) return undefined
  withPct.sort((x, y) => {
    const cmp = comparePercentWindows(x.item, y.item)
    return cmp !== 0 ? cmp : x.idx - y.idx
  })
  return withPct[0]?.item
}

/**
 * Rank headline items for 1–2 item pill/dock summaries: percent windows sort
 * by urgency first; balance/count items keep their relative order after them.
 */
export function rankHeadlineItems<T extends WindowRankItem>(items: readonly T[]): T[] {
  const headlines = items.filter((i) => /窗口|周|月|余额|额度|金额|消耗|window|week|month|balance|credit/i.test(i.label))
  const pool = headlines.length > 0 ? headlines : items
  return pool
    .map((item, idx) => ({ item, idx }))
    .sort((x, y) => {
      const xHasPct = x.item.percent !== undefined && Number.isFinite(x.item.percent)
      const yHasPct = y.item.percent !== undefined && Number.isFinite(y.item.percent)
      if (xHasPct && yHasPct) {
        const cmp = comparePercentWindows(x.item, y.item)
        return cmp !== 0 ? cmp : x.idx - y.idx
      }
      if (xHasPct !== yHasPct) return xHasPct ? -1 : 1
      return x.idx - y.idx
    })
    .map((entry) => entry.item)
}

/** Format up to two tightest headline items into a single-line summary string. */
export function formatProviderSummary<T extends WindowRankItem>(
  provider: { status: string; items: readonly T[] } | undefined,
  opts: {
    weeklyTag: string
    monthlyTag: string
    remainingPercent: (p: number) => string
    remainingCount: (n: number) => string
  },
): string {
  if (!provider || provider.status !== 'ok') return ''
  const shortTag = (label: string): string => {
    if (/5\s*小时/.test(label)) return '5h'
    const m = label.match(/(\d+)\s*m\b/)
    if (m) return `${m[1]}m`
    if (/本周|周/.test(label)) return opts.weeklyTag
    if (/月/.test(label)) return opts.monthlyTag
    return ''
  }
  const head = (item: T): string | undefined => {
    const value = item.percent !== undefined
      ? opts.remainingPercent(Math.max(0, Math.round(100 - item.percent)))
      : item.display ?? (item.remaining !== undefined ? opts.remainingCount(item.remaining) : undefined)
    if (value === undefined) return undefined
    const tag = shortTag(item.label)
    return tag ? `${tag} ${value}` : value
  }
  return rankHeadlineItems(provider.items)
    .map(head)
    .filter((v): v is string => Boolean(v))
    .slice(0, 2)
    .join(' · ')
}

