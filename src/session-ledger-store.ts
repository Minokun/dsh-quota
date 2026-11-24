/**
 * Atomic JSON persistence for `session-ledger.json` (max 200 LRU sessions) and
 * `daily-rollup.json` (max 30 calendar days, < 32 KiB).
 *
 * Follows `speed-store.ts`: zero SQLite / native bindings, temp-file + rename
 * atomic writes, and defensive parsing that falls back to empty state on corrupt
 * files rather than blocking plugin startup.
 * @module dsh-quota/session-ledger-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UsageBuckets } from './client/pricing.ts'
import type { MoneyTotals } from './pricing-catalog.ts'
import type { DailyRollupBucket, SessionLedgerEntry } from './session-ledger.ts'

const FILE_VERSION = 1

export function sessionLedgerFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.DSH_QUOTA_LEDGER_FILE?.trim()
  if (override) return override
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'dsh-quota', 'session-ledger.json')
}

export function dailyRollupFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.DSH_QUOTA_ROLLUP_FILE?.trim()
  if (override) return override
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'dsh-quota', 'daily-rollup.json')
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

function parseMoney(v: unknown): MoneyTotals {
  if (v === null || typeof v !== 'object') return { cny: 0, usd: 0 }
  const r = v as Record<string, unknown>
  return { cny: num(r.cny), usd: num(r.usd) }
}

function parseBuckets(v: unknown): UsageBuckets {
  if (v === null || typeof v !== 'object') {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }
  const r = v as Record<string, unknown>
  return {
    uncachedInputTokens: num(r.uncachedInputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWriteTokens: num(r.cacheWriteTokens),
  }
}

export function parseSessionLedgerFile(text: string): Record<string, SessionLedgerEntry> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const raw = (parsed as { sessions?: unknown } | null)?.sessions ?? parsed
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SessionLedgerEntry> = {}
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || val === null || typeof val !== 'object') continue
    const r = val as Record<string, unknown>
    const byModel: Record<string, { totals: MoneyTotals; tokens: number }> = {}
    if (r.byModel && typeof r.byModel === 'object' && !Array.isArray(r.byModel)) {
      for (const [m, share] of Object.entries(r.byModel as Record<string, unknown>)) {
        if (!share || typeof share !== 'object') continue
        const sr = share as Record<string, unknown>
        byModel[m] = { totals: parseMoney(sr.totals), tokens: num(sr.tokens) }
      }
    }
    out[id] = {
      sessionId: id,
      ...(typeof r.cwd === 'string' && r.cwd ? { cwd: r.cwd } : {}),
      updatedAt: num(r.updatedAt),
      totals: parseMoney(r.totals),
      compactionTotals: parseMoney(r.compactionTotals),
      searchCount: num(r.searchCount),
      searchTotals: parseMoney(r.searchTotals),
      tokens: parseBuckets(r.tokens),
      compactionTokens: parseBuckets(r.compactionTokens),
      steps: num(r.steps),
      unmeteredSteps: num(r.unmeteredSteps),
      offPeakSteps: num(r.offPeakSteps),
      byModel,
    }
  }
  return out
}

export function parseDailyRollupFile(text: string): Record<string, DailyRollupBucket> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const raw = (parsed as { daily?: unknown } | null)?.daily ?? parsed
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, DailyRollupBucket> = {}
  for (const [dateKey, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || val === null || typeof val !== 'object') continue
    const r = val as Record<string, unknown>
    const byWorkspace: Record<string, MoneyTotals> = {}
    if (r.byWorkspace && typeof r.byWorkspace === 'object' && !Array.isArray(r.byWorkspace)) {
      for (const [ws, m] of Object.entries(r.byWorkspace as Record<string, unknown>)) {
        if (ws) byWorkspace[ws] = parseMoney(m)
      }
    }
    out[dateKey] = {
      date: dateKey,
      totals: parseMoney(r.totals),
      tokens: parseBuckets(r.tokens),
      steps: num(r.steps),
      searchCount: num(r.searchCount),
      byWorkspace,
    }
  }
  return out
}

export async function loadSessionLedgerFile(path: string): Promise<Record<string, SessionLedgerEntry>> {
  try {
    return parseSessionLedgerFile(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

export async function loadDailyRollupFile(path: string): Promise<Record<string, DailyRollupBucket>> {
  try {
    return parseDailyRollupFile(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

export async function saveSessionLedgerFile(path: string, sessions: Record<string, SessionLedgerEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: FILE_VERSION, sessions })}\n`, 'utf8')
  await rename(tmp, path)
}

export async function saveDailyRollupFile(path: string, daily: Record<string, DailyRollupBucket>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: FILE_VERSION, daily })}\n`, 'utf8')
  await rename(tmp, path)
}
