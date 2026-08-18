/**
 * Direct HTTP adapters: a built-in provider CATALOG plus a format registry.
 *
 *   - PINNED platforms (Kimi / DeepSeek / Zhipu) always render a row, showing
 *     "missing-key" when no credential resolves — they are the onboarding
 *     surface for the panel's key manager.
 *   - CATALOG_EXTRA platforms are auto-discovered: the first credential ref
 *     that resolves wins the row; when nothing resolves the platform stays
 *     hidden. Add a key in DSH and the platform appears on the next refresh.
 *   - Users can add their own platforms (aggregators, one-api/new-api sites)
 *     through the panel or the `httpPlatforms` composition config by reusing
 *     a format from FORMATS.
 *
 * Catalog endpoints and response shapes follow the research verified by
 * CodexBar (docs/zai.md) and dsh-quota-panel (MIT) — window semantics for the
 * z.ai quota API included: the SHORTEST TOKENS_LIMIT is the 5-hour session
 * window, the LONGEST is the weekly window, and TIME_LIMIT is the monthly
 * search/MCP-tool lane (its usageDetails are search-prime / web-reader / zread).
 * @module dsh-quota/direct
 */

import type { ProviderSnapshot, QuotaItem } from './config.ts'

/** One direct platform adapter. */
export interface DirectAdapter {
  id: string
  label: string
  /** Credential ref names tried in order (DSH providers' apiKeyEnv first). */
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

function isoFromMs(v: unknown): string | undefined {
  const n = num(v)
  return n !== undefined ? new Date(n).toISOString() : undefined
}

// ── Format registry ──────────────────────────────────────────────────────────

/** A format turns one upstream JSON body into panel items. */
export type FormatParser = (body: unknown) => QuotaItem[]

/**
 * z.ai quota API (GLM Coding Plan / Z.AI / ZhiPu GLM). Window semantics per
 * CodexBar's mapping: shortest TOKENS_LIMIT = 5h session window, longest =
 * weekly; TIME_LIMIT = monthly search/MCP-tool lane.
 */
const zaiCoding: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  if (num(raw.code) !== undefined && num(raw.code) !== 200) throw new Error(`upstream code ${String(raw.code)}: ${str(raw.msg) ?? 'unknown'}`)
  const data = (raw.data ?? raw) as Record<string, unknown>
  const limits = Array.isArray(data.limits) ? data.limits as Array<Record<string, unknown>> : []
  if (limits.length === 0) throw new Error('data.limits is empty')
  const tokens = limits
    .filter((l) => str(l.type) === 'TOKENS_LIMIT')
    .sort((a, b) => (num(a.unit) ?? 0) * (num(a.number) ?? 1) - (num(b.unit) ?? 0) * (num(b.number) ?? 1))
  const time = limits.find((l) => str(l.type) === 'TIME_LIMIT')
  const items: QuotaItem[] = []
  const tokenItem = (l: Record<string, unknown>, label: string): void => {
    const percentage = num(l.percentage)
    items.push({
      label,
      percent: percentage,
      display: `已用 ${percentage ?? '?'}%`,
      resetAt: isoFromMs(l.nextResetTime),
    })
  }
  if (tokens.length > 0) tokenItem(tokens[0], '5 小时窗口')
  if (tokens.length > 1) tokenItem(tokens[tokens.length - 1], '本周窗口')
  if (time) {
    const used = num(time.currentValue)
    const limit = num(time.usage)
    items.push({
      label: '搜索/工具额度',
      used,
      limit,
      remaining: num(time.remaining) ?? (used !== undefined && limit !== undefined ? limit - used : undefined),
      percent: pct(used, limit) ?? num(time.percentage),
      resetAt: isoFromMs(time.nextResetTime),
    })
  }
  if (items.length === 0) throw new Error('no TOKENS_LIMIT / TIME_LIMIT entries')
  return items
}

const kimiCoding: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
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
  return items
}

const deepseekBalance: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const items: QuotaItem[] = []
  const infos = Array.isArray(raw.balance_infos) ? raw.balance_infos as Array<Record<string, unknown>> : []
  for (const info of infos) {
    const currency = str(info.currency) ?? 'CNY'
    items.push({ label: `${currency} 总余额`, display: str(info.total_balance) ?? '' })
    // total = 充值 + 赠金：赠金为 0 时「充值」必然等于「总余额」，拆开只是
    // 噪音；只有赠金非零才显示构成明细。
    const granted = num(info.granted_balance) ?? 0
    if (granted !== 0) {
      items.push({ label: `${currency} 其中充值`, display: str(info.topped_up_balance) ?? '' })
      items.push({ label: `${currency} 其中赠金`, display: str(info.granted_balance) ?? '' })
    }
  }
  if (items.length === 0) items.push({ label: '可用', display: String(raw.is_available ?? '?') })
  return items
}

const openrouterCredits: FormatParser = (body) => {
  const data = (body as Record<string, unknown>).data as Record<string, unknown> | undefined
  const credits = num(data?.total_credits)
  const usage = num(data?.total_usage)
  if (credits === undefined || usage === undefined) throw new Error('missing data.total_credits / data.total_usage')
  return [
    { label: '余额', display: `$${(credits - usage).toFixed(2)}` },
    { label: '累计已用', display: `$${usage.toFixed(2)} / $${credits.toFixed(2)}` },
  ]
}

const siliconflowBalance: FormatParser = (body) => {
  const data = (body as Record<string, unknown>).data as Record<string, unknown> | undefined
  const balance = num(data?.balance)
  if (balance === undefined) throw new Error('missing data.balance')
  const items: QuotaItem[] = [{ label: '余额', display: `¥${balance}` }]
  if (num(data?.chargeBalance) !== undefined) items.push({ label: '充值', display: `¥${num(data?.chargeBalance)}` })
  if (num(data?.totalUsage) !== undefined) items.push({ label: '累计用量', display: `¥${num(data?.totalUsage)}` })
  return items
}

const moonshotBalance: FormatParser = (body) => {
  const data = (body as Record<string, unknown>).data as Record<string, unknown> | undefined
  const balance = num(data?.total_balance)
  if (balance === undefined) throw new Error('missing data.total_balance')
  return [{ label: '余额', display: `¥${balance}` }]
}

const stepfunAccounts: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const balance = num(raw.balance)
  if (balance === undefined) throw new Error('missing balance')
  const items: QuotaItem[] = [{ label: '余额', display: `¥${balance}` }]
  if (num(raw.total_cash_balance) !== undefined) items.push({ label: '现金', display: `¥${num(raw.total_cash_balance)}` })
  if (num(raw.total_voucher_balance) !== undefined) items.push({ label: '赠金', display: `¥${num(raw.total_voucher_balance)}` })
  return items
}

const xaiCredits: FormatParser = (body) => {
  const total = ((body as Record<string, unknown>).total ?? {}) as Record<string, unknown>
  const cents = num(total.val)
  if (cents === undefined) throw new Error('missing total.val')
  return [{ label: '余额', display: `$${(Math.abs(cents) / 100).toFixed(2)}` }]
}

const minimaxRemains: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const status = num((raw.base_resp as Record<string, unknown> | undefined)?.status_code)
  if (status !== undefined && status !== 0) throw new Error(`upstream status ${status}: ${str((raw.base_resp as Record<string, unknown> | undefined)?.status_msg) ?? 'unknown'}`)
  const remains = Array.isArray(raw.model_remains) ? raw.model_remains as Array<Record<string, unknown>> : []
  if (remains.length === 0) throw new Error('model_remains is empty')
  const toIso = (v: unknown): string | undefined => {
    const n = num(v)
    if (n !== undefined) return new Date(n > 1e12 ? n : n * 1000).toISOString()
    return str(v)
  }
  for (const m of remains) {
    const total = num(m.current_interval_total_count)
    const resetAt = toIso(m.end_time ?? m.remains_time)
    const pctRemaining = num(m.current_interval_remaining_percent)
    if (pctRemaining !== undefined) {
      const usedPct = Math.min(100, Math.max(0, 100 - pctRemaining))
      return [{ label: '5h 窗口', percent: usedPct, display: `已用 ${Math.round(usedPct)}%`, resetAt }]
    }
    // Some builds report remaining via current_interval_usage_count (upstream quirk).
    const remaining = num(m.current_interval_remaining_count ?? m.current_interval_remains_count ?? m.current_interval_usage_count)
    if (total !== undefined && total > 0 && remaining !== undefined) {
      const used = total - remaining
      return [{ label: '5h 窗口', used, limit: total, remaining, percent: pct(used, total), resetAt }]
    }
  }
  throw new Error('no usable current_interval fields in model_remains')
}

const opencodeUsage: FormatParser = (body) => {
  const usage = ((body as Record<string, unknown>).usage ?? {}) as Record<string, unknown>
  const pick = (key: string, label: string): QuotaItem => {
    const u = (usage[key] ?? {}) as Record<string, unknown>
    const percent = num(u.percent)
    if (percent === undefined) throw new Error(`missing usage.${key}.percent`)
    return { label, percent, display: `已用 ${percent}%`, resetAt: str(u.resetsAt) }
  }
  return [pick('rolling', '5h 窗口'), pick('weekly', '本周窗口'), pick('monthly', '本月窗口')]
}

/** Quota formats reusable by catalog entries and user-declared platforms. */
export const FORMATS: Record<string, FormatParser> = {
  'kimi-coding': kimiCoding,
  'deepseek-balance': deepseekBalance,
  'zai-coding': zaiCoding,
  'openrouter-credits': openrouterCredits,
  'siliconflow-balance': siliconflowBalance,
  'moonshot-balance': moonshotBalance,
  'stepfun-accounts': stepfunAccounts,
  'xai-credits': xaiCredits,
  'minimax-remains': minimaxRemains,
  'opencode-usage': opencodeUsage,
}

/** Formats offered in the panel for user-declared custom HTTP platforms. */
export const CUSTOM_FORMATS = ['openai-billing', 'deepseek-balance', 'moonshot-balance', 'siliconflow-balance', 'openrouter-credits', 'stepfun-accounts', 'xai-credits'] as const

// ── Catalog ──────────────────────────────────────────────────────────────────

interface CatalogEntry {
  id: string
  label: string
  keyRefs: string[]
  endpoint: string
  format: string
  /** Suffix resolved from the response (e.g. plan level). */
  planOf?: (body: unknown) => string | undefined
}

function catalogFetch(entry: CatalogEntry): (key: string, signal?: AbortSignal) => Promise<ProviderSnapshot> {
  const parser = FORMATS[entry.format]
  if (!parser) throw new Error(`unknown format ${entry.format}`)
  return async (key, signal) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
    if (entry.format === 'kimi-coding') headers['User-Agent'] = UA
    const body = await getJson(entry.endpoint, headers, signal)
    const items = parser(body)
    const plan = entry.planOf?.(body)
    return {
      id: entry.id,
      label: plan ? `${entry.label} · ${plan}` : entry.label,
      status: 'ok',
      via: 'api',
      items,
    }
  }
}

function entry(e: CatalogEntry): DirectAdapter {
  return { id: e.id, label: e.label, keyRefs: e.keyRefs, envKeys: e.keyRefs, fetch: catalogFetch(e) }
}

const zaiPlanOf = (body: unknown): string | undefined => {
  const data = ((body as Record<string, unknown>).data ?? {}) as Record<string, unknown>
  return str(data.planName ?? data.plan ?? data.plan_type ?? data.packageName ?? data.level)
}

const kimiPlanOf = (body: unknown): string | undefined => {
  const user = ((body as Record<string, unknown>).user ?? {}) as Record<string, unknown>
  const membership = (user.membership ?? {}) as Record<string, unknown>
  return str(membership.level)
}

/**
 * Pinned platforms: always rendered, "missing-key" when unconfigured. These
 * are the three the panel's key manager can store credentials for.
 */
export const DIRECT_ADAPTERS: DirectAdapter[] = [
  entry({ id: 'kimi', label: 'Kimi Code', keyRefs: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'], endpoint: 'https://api.kimi.com/coding/v1/usages', format: 'kimi-coding', planOf: kimiPlanOf }),
  entry({ id: 'deepseek', label: 'DeepSeek', keyRefs: ['DEEPSEEK_API_KEY'], endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' }),
  entry({ id: 'zhipu', label: '智谱 Coding Plan', keyRefs: ['ZAI_CODING_CN_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY'], endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', format: 'zai-coding', planOf: zaiPlanOf }),
]

/**
 * Auto-discovered platforms: hidden until one of their credential refs
 * resolves (DSH credentials domain or environment), then they join the panel.
 */
export const CATALOG_EXTRA: DirectAdapter[] = [
  entry({ id: 'zai', label: 'Z.AI Coding', keyRefs: ['ZAI_API_KEY'], endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit', format: 'zai-coding', planOf: zaiPlanOf }),
  entry({ id: 'moonshot', label: 'Moonshot', keyRefs: ['MOONSHOT_API_KEY'], endpoint: 'https://api.moonshot.cn/v1/users/me/balance', format: 'moonshot-balance' }),
  entry({ id: 'openrouter', label: 'OpenRouter', keyRefs: ['OPENROUTER_API_KEY'], endpoint: 'https://openrouter.ai/api/v1/credits', format: 'openrouter-credits' }),
  entry({ id: 'siliconflow', label: 'SiliconFlow', keyRefs: ['SILICONFLOW_API_KEY'], endpoint: 'https://api.siliconflow.com/v1/user/info', format: 'siliconflow-balance' }),
  entry({ id: 'siliconflow-cn', label: 'SiliconFlow CN', keyRefs: ['SILICONFLOW_CN_API_KEY'], endpoint: 'https://api.siliconflow.cn/v1/user/info', format: 'siliconflow-balance' }),
  entry({ id: 'minimax', label: 'MiniMax Coding', keyRefs: ['MINIMAX_API_KEY'], endpoint: 'https://www.minimax.io/v1/token_plan/remains', format: 'minimax-remains' }),
  entry({ id: 'minimax-cn', label: 'MiniMax Coding CN', keyRefs: ['MINIMAX_CN_API_KEY'], endpoint: 'https://api.minimaxi.com/v1/token_plan/remains', format: 'minimax-remains' }),
  entry({ id: 'stepfun', label: 'StepFun', keyRefs: ['STEP_API_KEY', 'STEPFUN_API_KEY'], endpoint: 'https://api.stepfun.com/v1/accounts', format: 'stepfun-accounts' }),
  entry({ id: 'xai', label: 'xAI', keyRefs: ['XAI_API_KEY'], endpoint: 'https://api.x.ai/v1/billing/credits', format: 'xai-credits' }),
  entry({ id: 'opencode-go', label: 'OpenCode Go', keyRefs: ['OPENCODE_GO_API_KEY'], endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage' }),
]

/** Every credential ref the direct side may consume (for change watching). */
export const ALL_DIRECT_REFS: string[] = [...new Set([...DIRECT_ADAPTERS, ...CATALOG_EXTRA].flatMap((a) => [...a.keyRefs, ...a.envKeys]))]

/** Fetch shape for one user-declared custom HTTP platform. */
export function customHttpFetch(platform: { id: string; label: string; endpoint: string; format: string }): (key: string, signal?: AbortSignal) => Promise<ProviderSnapshot> {
  if (platform.format === 'openai-billing') {
    return async (key, signal) => {
      const base = platform.endpoint.replace(/\/+$/, '')
      const headers = { Authorization: `Bearer ${key}` }
      const sub = await getJson(`${base}/v1/dashboard/billing/subscription`, headers, signal) as Record<string, unknown>
      const usage = await getJson(`${base}/v1/dashboard/billing/usage`, headers, signal) as Record<string, unknown>
      const limit = num(sub.hard_limit_usd)
      const used = num(usage.total_usage)
      if (limit === undefined || used === undefined) throw new Error('openai-billing: missing hard_limit_usd / total_usage')
      return {
        id: platform.id,
        label: platform.label,
        status: 'ok',
        via: 'api',
        items: [{
          label: '额度 (USD)',
          percent: pct(used, limit),
          display: `$${used.toFixed(2)} / $${limit.toFixed(2)}（剩 $${(limit - used).toFixed(2)}）`,
        }],
      }
    }
  }
  const parser = FORMATS[platform.format]
  if (!parser) throw new Error(`unknown format ${platform.format}`)
  return async (key, signal) => {
    const body = await getJson(platform.endpoint, { Authorization: `Bearer ${key}` }, signal)
    return { id: platform.id, label: platform.label, status: 'ok', via: 'api', items: parser(body) }
  }
}
