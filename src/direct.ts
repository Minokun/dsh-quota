/**
 * Direct HTTP adapters for platforms with official API-key quota endpoints:
 *
 *   kimi     — GET https://api.kimi.com/coding/v1/usages          (KIMI_CODING_API_KEY)
 *   deepseek — GET https://api.deepseek.com/user/balance          (DEEPSEEK_API_KEY)
 *   zhipu    — GET https://api.z.ai/api/monitor/usage/quota/limit (ZAI_CODING_CN_API_KEY)
 *
 * The credential refs mirror the `apiKeyEnv` names DSH's own model providers
 * declare, so a key the user already added to DSH is reused here directly.
 * All endpoints were exercised end-to-end with the real DSH credentials.
 * @module dsh-quota/direct
 */

import type { ProviderSnapshot, QuotaItem } from './config.ts'

/** One direct platform adapter. */
export interface DirectAdapter {
  id: string
  label: string
  /** Credential ref names tried in order (see config.KEY_REFS). */
  keyRefs: string[]
  /** Environment variables tried as fallback. */
  envKeys: string[]
  /** Fetch the snapshot with the resolved key. */
  fetch(key: string, signal?: AbortSignal): Promise<ProviderSnapshot>
}

const UA = 'KimiCLI/1.6'

async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetch(url, { headers, signal })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`)
  }
  return resp.json() as Promise<unknown>
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v)
}

function pct(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined
  return Number(((used / limit) * 100).toFixed(1))
}

// ── Kimi / Moonshot ──────────────────────────────────────────────────────────

async function fetchKimi(apiKey: string, signal?: AbortSignal): Promise<ProviderSnapshot> {
  const raw = await getJson(
    'https://api.kimi.com/coding/v1/usages',
    { Authorization: `Bearer ${apiKey}`, 'User-Agent': UA },
    signal,
  ) as Record<string, unknown>

  const user = (raw.user ?? {}) as Record<string, unknown>
  const membership = (user.membership ?? {}) as Record<string, unknown>
  const usage = (raw.usage ?? {}) as Record<string, unknown>
  const limits = Array.isArray(raw.limits) ? raw.limits as Array<Record<string, unknown>> : []
  const wallet = (raw.boosterWallet ?? null) as Record<string, unknown> | null
  const walletBal = (wallet?.balance ?? {}) as Record<string, unknown>

  const items: QuotaItem[] = [
    {
      label: '周额度',
      used: num(usage.used),
      limit: num(usage.limit),
      remaining: num(usage.remaining),
      percent: pct(num(usage.used), num(usage.limit)),
      resetAt: str(usage.resetTime),
    },
  ]
  for (const l of limits) {
    const detail = (l.detail ?? l) as Record<string, unknown>
    const window = (l.window ?? {}) as Record<string, unknown>
    const duration = num(window.duration) ?? 0
    const unit = str(window.timeUnit) ?? ''
    const minutes = unit.includes('MINUTE') ? duration : unit.includes('HOUR') ? duration * 60 : duration
    items.push({
      label: `${Math.round(minutes)}m 窗口`,
      used: num(detail.used),
      limit: num(detail.limit),
      remaining: num(detail.remaining),
      percent: pct(num(detail.used), num(detail.limit)),
      resetAt: str(detail.resetTime),
    })
  }
  const amountLeft = num(walletBal.amountLeft ?? wallet?.amountLeft)
  if (amountLeft !== undefined) {
    items.push({
      label: '加量包剩余',
      display: amountLeft.toLocaleString('en-US'),
      resetAt: str(walletBal.periodEnd ?? wallet?.periodEnd),
    })
  }
  const parallel = (raw.parallel ?? {}) as Record<string, unknown>
  if (num(parallel.limit) !== undefined) {
    items.push({ label: '并发上限', display: String(parallel.limit) })
  }

  return {
    id: 'kimi',
    label: `Kimi Code · ${str(membership.level) ?? ''}`.replace(' · ', str(membership.level) ? ' · ' : ''),
    status: 'ok',
    via: 'api',
    items,
  }
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────

async function fetchDeepSeek(apiKey: string, signal?: AbortSignal): Promise<ProviderSnapshot> {
  const raw = await getJson(
    'https://api.deepseek.com/user/balance',
    { Authorization: `Bearer ${apiKey}` },
    signal,
  ) as Record<string, unknown>

  const items: QuotaItem[] = []
  const infos = Array.isArray(raw.balance_infos) ? raw.balance_infos as Array<Record<string, unknown>> : []
  for (const info of infos) {
    const currency = str(info.currency) ?? 'CNY'
    items.push({
      label: `${currency} 总余额`,
      display: str(info.total_balance) ?? '',
    })
    items.push({
      label: `${currency} 赠金`,
      display: str(info.granted_balance) ?? '',
    })
    items.push({
      label: `${currency} 充值`,
      display: str(info.topped_up_balance) ?? '',
    })
  }
  if (items.length === 0) items.push({ label: '可用', display: String(raw.is_available ?? '?') })

  return {
    id: 'deepseek',
    label: 'DeepSeek',
    status: 'ok',
    via: 'api',
    items,
  }
}

// ── Zhipu (GLM Coding Plan) ──────────────────────────────────────────────────

/** z.ai limit window unit enum: 1 = days, 3 = hours, 5 = minutes. */
const ZAI_UNITS: Record<number, string> = { 1: '天', 3: '小时', 5: '分钟' }

async function fetchZhipu(apiKey: string, signal?: AbortSignal): Promise<ProviderSnapshot> {
  const raw = await getJson(
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    { Authorization: `Bearer ${apiKey}` },
    signal,
  ) as Record<string, unknown>

  const data = (raw.data ?? raw) as Record<string, unknown>
  const limits = Array.isArray(data.limits) ? data.limits as Array<Record<string, unknown>> : []
  // TOKENS_LIMIT is the Coding Plan's primary 5-hour token window; TIME_LIMIT
  // is the per-minute MCP/tool call rate limit — tokens first.
  const ordered = [...limits].sort((a, b) => {
    const ta = str(a.type)?.includes('TOKEN') ? 0 : 1
    const tb = str(b.type)?.includes('TOKEN') ? 0 : 1
    return ta - tb
  })
  const items: QuotaItem[] = []
  for (const l of ordered) {
    const type = str(l.type) ?? ''
    const unit = ZAI_UNITS[num(l.unit) ?? 0] ?? ''
    const number = num(l.number) ?? 1
    const window = unit ? `${number} ${unit}` : ''
    const usage = num(l.usage)
    const current = num(l.currentValue)
    const remaining = num(l.remaining)
    const percentage = num(l.percentage)
    const resetMs = num(l.nextResetTime)
    const resetAt = resetMs !== undefined ? new Date(resetMs).toISOString() : undefined
    if (type.includes('TOKEN')) {
      // The Coding Plan quota the console page shows; percentage-only.
      items.push({
        label: `Coding Plan 额度（${window}窗口）`,
        percent: percentage,
        display: `已用 ${percentage ?? '?'}%`,
        resetAt,
      })
      continue
    }
    const label = type.includes('TIME') ? `调用限流（${window}窗口）` : (type || '限流')
    // Some limit rows carry only a percentage (no absolute counters).
    if (usage === undefined && current === undefined && remaining === undefined) {
      if (percentage !== undefined) items.push({ label, percent: percentage, display: `已用 ${percentage}%`, resetAt })
      continue
    }
    items.push({
      label,
      used: current,
      limit: usage,
      remaining,
      percent: percentage ?? pct(current, usage),
      resetAt,
    })
  }
  if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(data).slice(0, 120) })

  const level = str(data.level)
  return {
    id: 'zhipu',
    label: `智谱 Coding Plan${level ? ` · ${level}` : ''}`,
    status: 'ok',
    via: 'api',
    items,
  }
}

/** Every direct adapter, tried in panel order. */
export const DIRECT_ADAPTERS: DirectAdapter[] = [
  {
    id: 'kimi',
    label: 'Kimi Code',
    keyRefs: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'],
    envKeys: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'],
    fetch: fetchKimi,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyRefs: ['DEEPSEEK_API_KEY'],
    envKeys: ['DEEPSEEK_API_KEY'],
    fetch: fetchDeepSeek,
  },
  {
    id: 'zhipu',
    label: '智谱 Coding Plan',
    keyRefs: ['ZAI_CODING_CN_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY'],
    envKeys: ['ZAI_CODING_CN_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY'],
    fetch: fetchZhipu,
  },
]
