/**
 * Event-time incremental session cost ledger + 3-tier daily rollup
 * (`Session` / `Today · Workspace` / `Today · All`).
 *
 * Pure state machine (zero Node/Cordis I/O) shared with tests and the browser
 * wire view:
 * 1. Every LLM step is priced at its completion timestamp with the exact model
 *    active on that step — switching models later NEVER retroactively alters
 *    earlier steps.
 * 2. Counts context compaction (`compaction/summary`) and built-in `web_search`
 *    calls alongside regular turns.
 * 3. Fork-safe by construction: inherited events (`isInherited === true`) and
 *    duplicate event keys are ignored so `subagent_fork` never inflates session
 *    or daily totals.
 * @module dsh-quota/session-ledger
 */

import type { UsageBuckets } from './client/pricing.ts'
import {
  addMoney,
  calculateUsageCost,
  inferNativeCurrency,
  zeroMoney,
  type CurrencyCode,
  type MoneyTotals,
} from './pricing-catalog.ts'

/** Cap in-memory / persisted session entries (LRU by updatedAt). */
export const MAX_LEDGER_SESSIONS = 200
/** Cap persisted daily rollup buckets (~30 calendar days, < 32 KiB on disk). */
export const MAX_ROLLUP_DAYS = 30
/** Bounded idempotence ring buffer for event deduplication. */
const MAX_SEEN_KEYS = 2000

/** Default estimated cost per built-in `web_search` invocation (~$0.005 or ¥0.035). */
export const DEFAULT_WEB_SEARCH_USD = 0.005
export const DEFAULT_WEB_SEARCH_CNY = 0.035

export function zeroUsageBuckets(): UsageBuckets {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

export function addUsageBuckets(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

export function subUsageBuckets(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: Math.max(0, a.uncachedInputTokens - b.uncachedInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
    cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
  }
}

/** Format an epoch timestamp as `YYYY-MM-DD` in local machine time (or explicit UTC offset minutes). */
export function localDateKey(epochMs: number, utcOffsetMinutes?: number): string {
  if (utcOffsetMinutes !== undefined) {
    const shifted = new Date(epochMs + utcOffsetMinutes * 60_000)
    const y = shifted.getUTCFullYear()
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
    const d = String(shifted.getUTCDate()).padStart(2, '0')
    return `${String(y)}-${m}-${d}`
  }
  const d = new Date(epochMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${String(y)}-${m}-${day}`
}

/** Normalize a workspace path key (strips trailing slashes except root `/`). */
export function normalizeWorkspaceKey(cwd: string | undefined): string {
  if (!cwd) return ''
  const trimmed = cwd.trim().replace(/\\/g, '/')
  if (!trimmed) return ''
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

export interface ModelShareEntry {
  totals: MoneyTotals
  tokens: number
}

export interface SessionLedgerEntry {
  sessionId: string
  cwd?: string
  updatedAt: number
  totals: MoneyTotals
  compactionTotals: MoneyTotals
  searchCount: number
  searchTotals: MoneyTotals
  tokens: UsageBuckets
  compactionTokens: UsageBuckets
  steps: number
  unmeteredSteps: number
  offPeakSteps: number
  byModel: Record<string, ModelShareEntry>
}

export interface DailyRollupBucket {
  date: string
  totals: MoneyTotals
  tokens: UsageBuckets
  steps: number
  searchCount: number
  byWorkspace: Record<string, MoneyTotals>
}

export interface LedgerWireSnapshot {
  sessions: Record<string, SessionLedgerEntry>
  today: DailyRollupBucket
  recentDays: Array<{ date: string; totals: MoneyTotals }>
}

export interface UsageStepEvent {
  dedupKey: string
  sessionId: string
  cwd?: string
  provider: string
  model: string
  buckets: UsageBuckets
  timestamp: number
  kind?: 'turn' | 'compaction'
  isInherited?: boolean
  turn?: number
  step?: number
  preferCurrency?: CurrencyCode
}

export interface WebSearchStepEvent {
  dedupKey: string
  sessionId: string
  cwd?: string
  provider: string
  model?: string
  timestamp: number
  isInherited?: boolean
  /** Override per-search unit cost; set to 0 to disable search cost estimation. */
  unitCost?: number
}

/** Pure incremental session & daily cost ledger. */
export class SessionCostLedger {
  private readonly sessions = new Map<string, SessionLedgerEntry>()
  private readonly daily = new Map<string, DailyRollupBucket>()
  private readonly seenKeys = new Set<string>()
  private readonly seenOrder: string[] = []
  /** Tracks last settled `(turn, step)` usage per session so `assistant/attempt` + `assistant/message` on the same attempt don't double-count. */
  private readonly lastTurnStep = new Map<string, { turn: number; step: number; buckets: UsageBuckets; totals: MoneyTotals }>()
  private readonly utcOffsetMinutes: number | undefined

  constructor(opts: { utcOffsetMinutes?: number } = {}) {
    this.utcOffsetMinutes = opts.utcOffsetMinutes
  }

  private markSeen(key: string): boolean {
    if (!key) return true
    if (this.seenKeys.has(key)) return false
    this.seenKeys.add(key)
    this.seenOrder.push(key)
    while (this.seenOrder.length > MAX_SEEN_KEYS) {
      const oldest = this.seenOrder.shift()
      if (oldest !== undefined) this.seenKeys.delete(oldest)
    }
    return true
  }

  /** Reset same-step replacement guard when `llm/retry-started` announces a genuine retry. */
  onRetryStarted(sessionId: string, turn: number, step: number): void {
    const last = this.lastTurnStep.get(sessionId)
    if (last && last.turn === turn && last.step === step) {
      this.lastTurnStep.delete(sessionId)
    }
  }

  /** Update a session's known workspace directory without recording spend. */
  touchSession(sessionId: string, cwd: string | undefined, timestamp: number): void {
    const normCwd = normalizeWorkspaceKey(cwd)
    if (!normCwd) return
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.cwd = normCwd
      existing.updatedAt = Math.max(existing.updatedAt, timestamp)
    } else {
      this.ensureSession(sessionId, normCwd, timestamp)
    }
  }

  private ensureSession(sessionId: string, cwd: string | undefined, timestamp: number): SessionLedgerEntry {
    let entry = this.sessions.get(sessionId)
    const normCwd = normalizeWorkspaceKey(cwd)
    if (!entry) {
      entry = {
        sessionId,
        ...(normCwd ? { cwd: normCwd } : {}),
        updatedAt: timestamp,
        totals: zeroMoney(),
        compactionTotals: zeroMoney(),
        searchCount: 0,
        searchTotals: zeroMoney(),
        tokens: zeroUsageBuckets(),
        compactionTokens: zeroUsageBuckets(),
        steps: 0,
        unmeteredSteps: 0,
        offPeakSteps: 0,
        byModel: {},
      }
      this.sessions.set(sessionId, entry)
      this.pruneSessions()
    } else {
      if (normCwd) entry.cwd = normCwd
      entry.updatedAt = Math.max(entry.updatedAt, timestamp)
    }
    return entry
  }

  private ensureDay(dateKey: string): DailyRollupBucket {
    let bucket = this.daily.get(dateKey)
    if (!bucket) {
      bucket = {
        date: dateKey,
        totals: zeroMoney(),
        tokens: zeroUsageBuckets(),
        steps: 0,
        searchCount: 0,
        byWorkspace: {},
      }
      this.daily.set(dateKey, bucket)
      this.pruneDays()
    }
    return bucket
  }

  private pruneSessions(): void {
    if (this.sessions.size <= MAX_LEDGER_SESSIONS) return
    const sorted = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    while (this.sessions.size > MAX_LEDGER_SESSIONS && sorted.length > 0) {
      const victim = sorted.shift()
      if (victim) {
        this.sessions.delete(victim.sessionId)
        this.lastTurnStep.delete(victim.sessionId)
      }
    }
  }

  private pruneDays(): void {
    if (this.daily.size <= MAX_ROLLUP_DAYS) return
    const keys = [...this.daily.keys()].sort()
    while (keys.length > MAX_ROLLUP_DAYS) {
      const oldest = keys.shift()
      if (oldest) this.daily.delete(oldest)
    }
  }

  /** Record one completed LLM call (or compaction summary) at its completion timestamp. */
  recordUsageStep(ev: UsageStepEvent): boolean {
    // Fork guard: inherited events never count as new model spend.
    if (ev.isInherited === true) return false
    if (!this.markSeen(ev.dedupKey)) return false

    const totalTok =
      ev.buckets.uncachedInputTokens
      + ev.buckets.outputTokens
      + ev.buckets.cacheReadTokens
      + ev.buckets.cacheWriteTokens
    if (totalTok <= 0) return false

    let effectiveBuckets = ev.buckets
    const priced = calculateUsageCost(ev.provider, ev.model, ev.buckets, ev.timestamp, {
      preferCurrency: ev.preferCurrency,
    })
    let deltaTotals = priced ? priced.totals : zeroMoney()

    // Deduplicate assistant/attempt followed by assistant/message for the same (turn, step)
    if (ev.kind !== 'compaction' && ev.turn !== undefined && ev.step !== undefined) {
      const prev = this.lastTurnStep.get(ev.sessionId)
      if (prev && prev.turn === ev.turn && prev.step === ev.step) {
        effectiveBuckets = subUsageBuckets(ev.buckets, prev.buckets)
        deltaTotals = {
          cny: Math.max(0, Number((deltaTotals.cny - prev.totals.cny).toFixed(8))),
          usd: Math.max(0, Number((deltaTotals.usd - prev.totals.usd).toFixed(8))),
        }
        const diffTok =
          effectiveBuckets.uncachedInputTokens
          + effectiveBuckets.outputTokens
          + effectiveBuckets.cacheReadTokens
          + effectiveBuckets.cacheWriteTokens
        if (diffTok === 0 && deltaTotals.cny === 0 && deltaTotals.usd === 0) {
          return false
        }
      }
      this.lastTurnStep.set(ev.sessionId, {
        turn: ev.turn,
        step: ev.step,
        buckets: ev.buckets,
        totals: priced ? priced.totals : zeroMoney(),
      })
    }

    const session = this.ensureSession(ev.sessionId, ev.cwd, ev.timestamp)
    session.tokens = addUsageBuckets(session.tokens, effectiveBuckets)
    session.totals = addMoney(session.totals, deltaTotals)
    session.steps += 1
    if (priced?.tier.isOffPeak) session.offPeakSteps += 1

    if (ev.kind === 'compaction') {
      session.compactionTokens = addUsageBuckets(session.compactionTokens, effectiveBuckets)
      session.compactionTotals = addMoney(session.compactionTotals, deltaTotals)
    }

    const modelKey = ev.model.trim() || 'unknown'
    const prevModel = session.byModel[modelKey] ?? { totals: zeroMoney(), tokens: 0 }
    const stepTok =
      effectiveBuckets.uncachedInputTokens
      + effectiveBuckets.outputTokens
      + effectiveBuckets.cacheReadTokens
      + effectiveBuckets.cacheWriteTokens
    session.byModel[modelKey] = {
      totals: addMoney(prevModel.totals, deltaTotals),
      tokens: prevModel.tokens + stepTok,
    }

    // Update 3-tier daily rollup
    const dayKey = localDateKey(ev.timestamp, this.utcOffsetMinutes)
    const day = this.ensureDay(dayKey)
    day.totals = addMoney(day.totals, deltaTotals)
    day.tokens = addUsageBuckets(day.tokens, effectiveBuckets)
    day.steps += 1
    const wsKey = session.cwd
    if (wsKey) {
      day.byWorkspace[wsKey] = addMoney(day.byWorkspace[wsKey] ?? zeroMoney(), deltaTotals)
    }
    return true
  }

  /** Record a completed model step where the upstream omitted token usage. */
  recordUnmeteredStep(ev: { dedupKey: string; sessionId: string; cwd?: string; timestamp: number; isInherited?: boolean }): boolean {
    if (ev.isInherited === true) return false
    if (!this.markSeen(ev.dedupKey)) return false
    const session = this.ensureSession(ev.sessionId, ev.cwd, ev.timestamp)
    session.unmeteredSteps += 1
    return true
  }

  /** Record a built-in `web_search` tool invocation. */
  recordWebSearch(ev: WebSearchStepEvent): boolean {
    if (ev.isInherited === true) return false
    if (!this.markSeen(ev.dedupKey)) return false

    const currency = inferNativeCurrency(ev.provider, ev.model ?? '')
    const unit = ev.unitCost !== undefined
      ? Math.max(0, ev.unitCost)
      : currency === 'CNY'
        ? DEFAULT_WEB_SEARCH_CNY
        : DEFAULT_WEB_SEARCH_USD
    const delta: MoneyTotals = currency === 'CNY' ? { cny: unit, usd: 0 } : { cny: 0, usd: unit }

    const session = this.ensureSession(ev.sessionId, ev.cwd, ev.timestamp)
    session.searchCount += 1
    session.searchTotals = addMoney(session.searchTotals, delta)
    session.totals = addMoney(session.totals, delta)

    const dayKey = localDateKey(ev.timestamp, this.utcOffsetMinutes)
    const day = this.ensureDay(dayKey)
    day.searchCount += 1
    day.totals = addMoney(day.totals, delta)
    if (session.cwd) {
      day.byWorkspace[session.cwd] = addMoney(day.byWorkspace[session.cwd] ?? zeroMoney(), delta)
    }
    return true
  }

  /** Read one session's ledger entry, if recorded. */
  getSession(sessionId: string): SessionLedgerEntry | undefined {
    return this.sessions.get(sessionId)
  }

  /** Export persisted state for `session-ledger.json` and `daily-rollup.json`. */
  exportState(): { sessions: Record<string, SessionLedgerEntry>; daily: Record<string, DailyRollupBucket> } {
    this.pruneSessions()
    this.pruneDays()
    return {
      sessions: Object.fromEntries(this.sessions.entries()),
      daily: Object.fromEntries(this.daily.entries()),
    }
  }

  /** Hydrate persisted state from disk without overwriting newer live records. */
  hydrate(saved: { sessions?: Record<string, SessionLedgerEntry>; daily?: Record<string, DailyRollupBucket> }): void {
    for (const [id, s] of Object.entries(saved.sessions ?? {})) {
      const live = this.sessions.get(id)
      if (!live) {
        this.sessions.set(id, structuredClone(s))
      } else {
        // Merge persisted baseline beneath in-memory increments collected during boot
        live.totals = addMoney(s.totals, live.totals)
        live.compactionTotals = addMoney(s.compactionTotals, live.compactionTotals)
        live.searchCount += s.searchCount
        live.searchTotals = addMoney(s.searchTotals, live.searchTotals)
        live.tokens = addUsageBuckets(s.tokens, live.tokens)
        live.compactionTokens = addUsageBuckets(s.compactionTokens, live.compactionTokens)
        live.steps += s.steps
        live.unmeteredSteps += s.unmeteredSteps
        live.offPeakSteps += s.offPeakSteps
        if (!live.cwd && s.cwd) live.cwd = s.cwd
        for (const [m, share] of Object.entries(s.byModel ?? {})) {
          const cur = live.byModel[m] ?? { totals: zeroMoney(), tokens: 0 }
          live.byModel[m] = { totals: addMoney(share.totals, cur.totals), tokens: share.tokens + cur.tokens }
        }
      }
    }
    for (const [dateKey, d] of Object.entries(saved.daily ?? {})) {
      const live = this.daily.get(dateKey)
      if (!live) {
        this.daily.set(dateKey, structuredClone(d))
      } else {
        live.totals = addMoney(d.totals, live.totals)
        live.tokens = addUsageBuckets(d.tokens, live.tokens)
        live.steps += d.steps
        live.searchCount += d.searchCount
        for (const [ws, m] of Object.entries(d.byWorkspace ?? {})) {
          live.byWorkspace[ws] = addMoney(m, live.byWorkspace[ws] ?? zeroMoney())
        }
      }
    }
    this.pruneSessions()
    this.pruneDays()
  }

  /** Build the compact wire snapshot served on `/plugins/dsh-quota/api/status`. */
  snapshot(now: number = Date.now()): LedgerWireSnapshot {
    const todayKey = localDateKey(now, this.utcOffsetMinutes)
    const today = this.daily.get(todayKey) ?? {
      date: todayKey,
      totals: zeroMoney(),
      tokens: zeroUsageBuckets(),
      steps: 0,
      searchCount: 0,
      byWorkspace: {},
    }
    const recentDays = [...this.daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-7)
      .map((d) => ({ date: d.date, totals: d.totals }))
    return {
      sessions: Object.fromEntries(this.sessions.entries()),
      today,
      recentDays,
    }
  }
}
