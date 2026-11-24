/**
 * Multi-vendor pricing catalog, DeepSeek Beijing-time off-peak & statutory
 * holiday schedule, and adaptive CNY (¥) / USD ($) cost formatting.
 *
 * Pure functions, zero Node/DOM dependencies — shared by both the Host event
 * ledger (`session-ledger.ts`) and the Browser fallback estimator.
 * @module dsh-quota/pricing-catalog
 */

import type { UsageBuckets } from './client/pricing.ts'

export type CurrencyCode = 'CNY' | 'USD'

/** Dual-currency exact accumulator so CNY and USD channels never mix via fake FX rates. */
export interface MoneyTotals {
  cny: number
  usd: number
}

export function zeroMoney(): MoneyTotals {
  return { cny: 0, usd: 0 }
}

export function addMoney(a: MoneyTotals, b: MoneyTotals): MoneyTotals {
  return {
    cny: Number((a.cny + b.cny).toFixed(8)),
    usd: Number((a.usd + b.usd).toFixed(8)),
  }
}

export function hasMoney(m: MoneyTotals | undefined): boolean {
  if (!m) return false
  return m.cny > 0 || m.usd > 0
}

/** Per-1M-token rates in a specific native currency. */
export interface PricedTier {
  currency: CurrencyCode
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  family: string
  isOffPeak?: boolean
}

interface CatalogEntry {
  prefix: string
  family: string
  /** Primary native currency & per-1M rates. */
  cny?: { input: number; cacheRead: number; cacheWrite: number; output: number }
  usd?: { input: number; cacheRead: number; cacheWrite: number; output: number }
  /** Supports DeepSeek UTC+8 off-peak 50% discount on official DeepSeek routes. */
  deepseekOffPeak?: boolean
}

/**
 * China statutory public holiday dates (YYYY-MM-DD in Asia/Shanghai, UTC+8)
 * for 2025–2027. Combined with weekends and daily 00:30–08:30 Beijing time for
 * DeepSeek off-peak pricing (zero external network calls).
 */
export const CN_STATUTORY_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025 statutory holidays
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-05', '2025-04-06',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026 statutory holidays
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  // 2027 statutory holidays (baseline)
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
])

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Decompose an epoch-ms timestamp into Beijing time (UTC+8) calendar components. */
export function beijingCalendarOf(epochMs: number): { dateKey: string; dayOfWeek: number; minuteOfDay: number } {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const dayOfWeek = shifted.getUTCDay() // 0 = Sun, 6 = Sat
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return { dateKey: `${String(y)}-${m}-${d}`, dayOfWeek, minuteOfDay }
}

/**
 * Determine whether `epochMs` falls in DeepSeek's 50% off-peak window:
 * - Statutory CN public holidays (all day UTC+8), OR
 * - Saturday / Sunday (all day UTC+8), OR
 * - Workday 00:30–08:30 Beijing time (`[30, 510)` minutes from 00:00 UTC+8).
 */
export function isDeepSeekOffPeak(epochMs: number, extraHolidays?: readonly string[]): boolean {
  const { dateKey, dayOfWeek, minuteOfDay } = beijingCalendarOf(epochMs)
  if (CN_STATUTORY_HOLIDAYS.has(dateKey)) return true
  if (extraHolidays && extraHolidays.includes(dateKey)) return true
  if (dayOfWeek === 0 || dayOfWeek === 6) return true
  return minuteOfDay >= 30 && minuteOfDay < 510
}

/**
 * Built-in reference catalog (verified 2026-10 / 2026-11).
 * - Domestic providers (DeepSeek, Zhipu GLM, Kimi, Volcengine Doubao, Qwen, MiniMax) carry CNY rates;
 *   DeepSeek also carries USD rates when routed via USD gateways.
 * - Anthropic Claude models price `cacheWrite` at 1.25× input and `cacheRead` at 0.1× input.
 */
const CATALOG: readonly CatalogEntry[] = [
  // DeepSeek (CNY official + USD official; 50% off-peak on official DeepSeek routes)
  {
    prefix: 'deepseek-v4-pro',
    family: 'deepseek',
    cny: { input: 4.80, cacheRead: 0.16, cacheWrite: 4.80, output: 14.40 },
    usd: { input: 0.66, cacheRead: 0.022, cacheWrite: 0.66, output: 1.98 },
    deepseekOffPeak: true,
  },
  {
    prefix: 'deepseek-flash',
    family: 'deepseek',
    cny: { input: 2.00, cacheRead: 0.04, cacheWrite: 2.00, output: 8.00 },
    usd: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 },
    deepseekOffPeak: true,
  },
  {
    prefix: 'deepseek-v4-flash',
    family: 'deepseek',
    cny: { input: 2.00, cacheRead: 0.04, cacheWrite: 2.00, output: 8.00 },
    usd: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 },
    deepseekOffPeak: true,
  },
  {
    prefix: 'deepseek-chat',
    family: 'deepseek',
    cny: { input: 2.00, cacheRead: 0.04, cacheWrite: 2.00, output: 8.00 },
    usd: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 },
    deepseekOffPeak: true,
  },
  {
    prefix: 'deepseek-reasoner',
    family: 'deepseek',
    cny: { input: 2.00, cacheRead: 0.04, cacheWrite: 2.00, output: 8.00 },
    usd: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 },
    deepseekOffPeak: true,
  },
  {
    prefix: 'deepseek-r1',
    family: 'deepseek',
    cny: { input: 4.00, cacheRead: 1.00, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.55, cacheRead: 0.14, cacheWrite: 0.55, output: 2.19 },
    deepseekOffPeak: true,
  },
  {
    prefix: 'deepseek-v3',
    family: 'deepseek',
    cny: { input: 2.00, cacheRead: 0.50, cacheWrite: 2.00, output: 8.00 },
    usd: { input: 0.27, cacheRead: 0.07, cacheWrite: 0.27, output: 1.10 },
    deepseekOffPeak: true,
  },

  // Anthropic Claude (USD; cacheWrite = 1.25× input, cacheRead = 0.10× input)
  { prefix: 'claude-opus-4', family: 'anthropic', usd: { input: 15.0, cacheRead: 1.50, cacheWrite: 18.75, output: 75.0 } },
  { prefix: 'claude-4-opus', family: 'anthropic', usd: { input: 15.0, cacheRead: 1.50, cacheWrite: 18.75, output: 75.0 } },
  { prefix: 'claude-sonnet-4', family: 'anthropic', usd: { input: 3.0, cacheRead: 0.30, cacheWrite: 3.75, output: 15.0 } },
  { prefix: 'claude-4-sonnet', family: 'anthropic', usd: { input: 3.0, cacheRead: 0.30, cacheWrite: 3.75, output: 15.0 } },
  { prefix: 'claude-3-7-sonnet', family: 'anthropic', usd: { input: 3.0, cacheRead: 0.30, cacheWrite: 3.75, output: 15.0 } },
  { prefix: 'claude-3.7-sonnet', family: 'anthropic', usd: { input: 3.0, cacheRead: 0.30, cacheWrite: 3.75, output: 15.0 } },
  { prefix: 'claude-3-5-sonnet', family: 'anthropic', usd: { input: 3.0, cacheRead: 0.30, cacheWrite: 3.75, output: 15.0 } },
  { prefix: 'claude-haiku-4', family: 'anthropic', usd: { input: 0.80, cacheRead: 0.08, cacheWrite: 1.00, output: 4.0 } },
  { prefix: 'claude-3-5-haiku', family: 'anthropic', usd: { input: 0.80, cacheRead: 0.08, cacheWrite: 1.00, output: 4.0 } },

  // OpenAI / Codex (USD)
  { prefix: 'gpt-5-mini', family: 'openai', usd: { input: 0.25, cacheRead: 0.025, cacheWrite: 0.25, output: 2.0 } },
  { prefix: 'gpt-5', family: 'openai', usd: { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10.0 } },
  { prefix: 'codex-mini', family: 'openai', usd: { input: 1.50, cacheRead: 0.375, cacheWrite: 1.50, output: 6.0 } },
  { prefix: 'o3-pro', family: 'openai', usd: { input: 20.0, cacheRead: 20.0, cacheWrite: 20.0, output: 80.0 } },
  { prefix: 'o3', family: 'openai', usd: { input: 2.0, cacheRead: 0.50, cacheWrite: 2.0, output: 8.0 } },
  { prefix: 'o4-mini', family: 'openai', usd: { input: 1.10, cacheRead: 0.275, cacheWrite: 1.10, output: 4.40 } },
  { prefix: 'gpt-4.1-mini', family: 'openai', usd: { input: 0.40, cacheRead: 0.10, cacheWrite: 0.40, output: 1.60 } },
  { prefix: 'gpt-4.1-nano', family: 'openai', usd: { input: 0.10, cacheRead: 0.025, cacheWrite: 0.10, output: 0.40 } },
  { prefix: 'gpt-4.1', family: 'openai', usd: { input: 2.0, cacheRead: 0.50, cacheWrite: 2.0, output: 8.0 } },
  { prefix: 'gpt-4o-mini', family: 'openai', usd: { input: 0.15, cacheRead: 0.075, cacheWrite: 0.15, output: 0.60 } },
  { prefix: 'gpt-4o', family: 'openai', usd: { input: 2.50, cacheRead: 1.25, cacheWrite: 2.50, output: 10.0 } },

  // Google Gemini (USD)
  { prefix: 'gemini-4-carbon', family: 'google', usd: { input: 2.00, cacheRead: 0.20, cacheWrite: 2.00, output: 12.0 } },
  { prefix: 'gemini-4-argon', family: 'google', usd: { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10.0 } },
  { prefix: 'gemini-3', family: 'google', usd: { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10.0 } },
  { prefix: 'gemini-2.5-pro', family: 'google', usd: { input: 1.25, cacheRead: 0.31, cacheWrite: 1.25, output: 10.0 } },
  { prefix: 'gemini-2.5-flash', family: 'google', usd: { input: 0.30, cacheRead: 0.075, cacheWrite: 0.30, output: 2.50 } },

  // xAI Grok (USD)
  { prefix: 'grok-4', family: 'xai', usd: { input: 3.0, cacheRead: 0.75, cacheWrite: 3.0, output: 15.0 } },
  { prefix: 'grok-3-mini', family: 'xai', usd: { input: 0.30, cacheRead: 0.075, cacheWrite: 0.30, output: 0.50 } },
  { prefix: 'grok-3', family: 'xai', usd: { input: 3.0, cacheRead: 0.75, cacheWrite: 3.0, output: 15.0 } },

  // Kimi / Moonshot (CNY domestic + USD international)
  {
    prefix: 'kimi-k2.5',
    family: 'kimi',
    cny: { input: 4.00, cacheRead: 1.00, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.15, cacheWrite: 0.60, output: 2.50 },
  },
  {
    prefix: 'kimi-k2',
    family: 'kimi',
    cny: { input: 4.00, cacheRead: 1.00, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.15, cacheWrite: 0.60, output: 2.50 },
  },
  {
    prefix: 'kimi-for-coding',
    family: 'kimi',
    cny: { input: 4.00, cacheRead: 1.00, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.15, cacheWrite: 0.60, output: 2.50 },
  },
  {
    prefix: 'k3',
    family: 'kimi',
    cny: { input: 4.00, cacheRead: 1.00, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.15, cacheWrite: 0.60, output: 2.50 },
  },

  // Zhipu GLM (CNY domestic + USD z.ai international)
  {
    prefix: 'glm-5',
    family: 'zhipu',
    cny: { input: 4.00, cacheRead: 1.00, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.15, cacheWrite: 0.60, output: 2.20 },
  },
  {
    prefix: 'glm-4.7',
    family: 'zhipu',
    cny: { input: 4.00, cacheRead: 0.80, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.11, cacheWrite: 0.60, output: 2.20 },
  },
  {
    prefix: 'glm-4.6',
    family: 'zhipu',
    cny: { input: 3.50, cacheRead: 0.70, cacheWrite: 3.50, output: 14.00 },
    usd: { input: 0.50, cacheRead: 0.10, cacheWrite: 0.50, output: 2.00 },
  },
  {
    prefix: 'glm-4.5-air',
    family: 'zhipu',
    cny: { input: 0.80, cacheRead: 0.16, cacheWrite: 0.80, output: 2.00 },
    usd: { input: 0.20, cacheRead: 0.03, cacheWrite: 0.20, output: 1.10 },
  },
  {
    prefix: 'glm-4.5',
    family: 'zhipu',
    cny: { input: 4.00, cacheRead: 0.80, cacheWrite: 4.00, output: 16.00 },
    usd: { input: 0.60, cacheRead: 0.11, cacheWrite: 0.60, output: 2.20 },
  },

  // Volcengine Doubao / Qwen / MiniMax (CNY)
  { prefix: 'doubao-seed-code', family: 'volcark', cny: { input: 1.20, cacheRead: 0.24, cacheWrite: 1.20, output: 8.00 } },
  { prefix: 'doubao-', family: 'volcark', cny: { input: 0.80, cacheRead: 0.16, cacheWrite: 0.80, output: 2.00 } },
  { prefix: 'qwen3-coder', family: 'qianwen', cny: { input: 4.00, cacheRead: 0.80, cacheWrite: 4.00, output: 16.00 } },
  { prefix: 'qwen-max', family: 'qianwen', cny: { input: 2.40, cacheRead: 0.48, cacheWrite: 2.40, output: 9.60 } },
  { prefix: 'qwen-plus', family: 'qianwen', cny: { input: 0.80, cacheRead: 0.16, cacheWrite: 0.80, output: 2.00 } },
  { prefix: 'minimax-m2', family: 'minimax', cny: { input: 2.10, cacheRead: 0.21, cacheWrite: 2.10, output: 8.40 } },
  { prefix: 'minimax-m1', family: 'minimax', cny: { input: 1.20, cacheRead: 0.12, cacheWrite: 1.20, output: 8.00 } },
]

/**
 * Strip gateway/router path segments (e.g. `magpie-anthropic/agy-cli/claude-sonnet-4-5`
 * or `moonshotai/kimi-k2.5`) to recover the canonical model slug at lookup time.
 */
export function normalizeModelId(rawModel: string): string {
  const trimmed = rawModel.trim().toLowerCase()
  if (!trimmed) return ''
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? trimmed
}

/** Decide whether a provider route bills in USD even when the model family also has CNY rates. */
function prefersUsdRoute(provider: string): boolean {
  const p = provider.trim().toLowerCase()
  return /openrouter|together|fireworks|magpie|zai-global|moonshot-ai|bedrock|vertex|openai|anthropic|google|xai/.test(p)
}

/** Decide whether a provider route represents official DeepSeek (eligible for 50% off-peak). */
function isOfficialDeepSeekRoute(provider: string, family: string): boolean {
  if (family !== 'deepseek') return false
  const p = provider.trim().toLowerCase()
  if (p === '') return true
  if (/openrouter|together|fireworks|siliconflow|volc|ark|bailian|dashscope|nvidia/.test(p)) return false
  return /deepseek/.test(p)
}

/**
 * Resolve the exact per-1M-token price for `(provider, model)` at `timestampMs`.
 * Longest-prefix match on normalized model slug; adaptive currency (`CNY` vs `USD`)
 * based on provider + model family; applies 50% off-peak on official DeepSeek routes.
 */
export function resolvePriceAt(
  provider: string,
  model: string,
  timestampMs: number,
  opts: { extraHolidays?: readonly string[]; preferCurrency?: CurrencyCode } = {},
): PricedTier | undefined {
  const slug = normalizeModelId(model)
  if (!slug) return undefined
  let best: CatalogEntry | undefined
  for (const entry of CATALOG) {
    if (!slug.startsWith(entry.prefix)) continue
    if (best === undefined || entry.prefix.length > best.prefix.length) best = entry
  }
  if (!best) return undefined

  const wantUsd = opts.preferCurrency === 'USD' || (opts.preferCurrency === undefined && prefersUsdRoute(provider))
  let chosenCurrency: CurrencyCode
  let base: { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined
  if (wantUsd && best.usd) {
    chosenCurrency = 'USD'
    base = best.usd
  } else if (best.cny) {
    chosenCurrency = 'CNY'
    base = best.cny
  } else if (best.usd) {
    chosenCurrency = 'USD'
    base = best.usd
  } else {
    return undefined
  }

  const offPeak = Boolean(best.deepseekOffPeak) && isOfficialDeepSeekRoute(provider, best.family) && isDeepSeekOffPeak(timestampMs, opts.extraHolidays)
  const mult = offPeak ? 0.5 : 1
  return {
    currency: chosenCurrency,
    input: base.input * mult,
    cacheRead: base.cacheRead * mult,
    cacheWrite: base.cacheWrite * mult,
    output: base.output * mult,
    family: best.family,
    ...(offPeak ? { isOffPeak: true } : {}),
  }
}

/** Calculate the exact monetary cost of one 4-bucket token usage step at `timestampMs`. */
export function calculateUsageCost(
  provider: string,
  model: string,
  buckets: UsageBuckets,
  timestampMs: number,
  opts: { extraHolidays?: readonly string[]; preferCurrency?: CurrencyCode } = {},
): { totals: MoneyTotals; tier: PricedTier } | undefined {
  const tier = resolvePriceAt(provider, model, timestampMs, opts)
  if (!tier) return undefined
  const amount =
    (buckets.uncachedInputTokens / 1e6) * tier.input
    + (buckets.cacheReadTokens / 1e6) * tier.cacheRead
    + (buckets.cacheWriteTokens / 1e6) * tier.cacheWrite
    + (buckets.outputTokens / 1e6) * tier.output
  const totals = tier.currency === 'CNY' ? { cny: amount, usd: 0 } : { cny: 0, usd: amount }
  return { totals, tier }
}

/** Format a single currency amount (`¥0.0420` / `¥1.85` / `$0.0123` / `$1.85`). */
export function formatCurrencyAmount(currency: CurrencyCode, amount: number): string {
  const sym = currency === 'CNY' ? '¥' : '$'
  if (!Number.isFinite(amount)) return `${sym}—`
  const digits = amount > 0 && amount < 1
    ? (Math.round((amount + Number.EPSILON) * 10000) / 10000).toFixed(4)
    : (Math.round((amount + Number.EPSILON) * 100) / 100).toFixed(2)
  return `${sym}${digits}`
}

/**
 * Format adaptive dual-currency totals:
 * - Pure CNY session/day → `¥X.XX`
 * - Pure USD session/day → `$Y.YY`
 * - Hybrid CNY + USD session/day → `¥X.XX + $Y.YY`
 */
export function formatAdaptiveTotals(totals: MoneyTotals, fallbackCurrency: CurrencyCode = 'CNY'): string {
  const hasCny = totals.cny > 0
  const hasUsd = totals.usd > 0
  if (hasCny && hasUsd) {
    return `${formatCurrencyAmount('CNY', totals.cny)} + ${formatCurrencyAmount('USD', totals.usd)}`
  }
  if (hasCny) return formatCurrencyAmount('CNY', totals.cny)
  if (hasUsd) return formatCurrencyAmount('USD', totals.usd)
  return formatCurrencyAmount(fallbackCurrency, 0)
}

/** Infer native display currency for a `(provider, model)` pair (used for zero-spend placeholders & web_search). */
export function inferNativeCurrency(provider: string, model: string): CurrencyCode {
  const tier = resolvePriceAt(provider, model, Date.now())
  if (tier) return tier.currency
  if (prefersUsdRoute(provider)) return 'USD'
  const p = provider.trim().toLowerCase()
  if (/deepseek|kimi|moonshot|zhipu|bigmodel|glm|volc|ark|qianwen|dashscope|minimax|scnet|siliconflow/.test(p)) {
    return 'CNY'
  }
  return 'USD'
}
