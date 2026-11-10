/**
 * Direct HTTP adapters: a built-in provider CATALOG plus a format registry.
 *
 *   - Every built-in platform is auto-discovered: a row renders only when one
 *     of its credential refs resolves (DSH credentials domain or environment).
 *     No key → no row. One row PER RESOLVED REF (multi-account supported).
 *   - Users can add their own platforms (aggregators, one-api/new-api sites)
 *     through the panel or the `httpPlatforms` composition config by reusing
 *     a format from FORMATS; custom rows stay pinned even without a key so
 *     the missing credential is visible.
 *
 * Catalog endpoints and response shapes follow the research verified by
 * CodexBar (docs/zai.md) and dsh-quota-panel (MIT) — window semantics for the
 * z.ai quota API included (from the z.ai frontend source): TOKENS_LIMIT
 * unit=3 is the N-hour session window, unit=6 is the weekly window, and
 * TIME_LIMIT is the monthly search/MCP-tool lane (its usageDetails are
 * search-prime / web-reader / zread). The Coding Plan meters credits, so the
 * same windows may arrive as CREDIT_LIMIT instead.
 * @module dsh-quota/direct
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CustomHttpPlatform, ProviderSnapshot, QuotaItem } from './config.ts'

/** One direct platform adapter. */
export interface DirectAdapter {
  id: string
  label: string
  /** Credential ref names tried in order (DSH providers' apiKeyEnv first). */
  keyRefs: string[]
  /** Environment variables tried as fallback. */
  envKeys: string[]
  /**
   * Official endpoint origin(s). A custom DSH model provider that maps onto
   * this platform contributes its own credential ref as an extra account card
   * only when its `baseURL` shares one of these origins — a third-party
   * OpenAI/DeepSeek-compatible gateway must not be queried against the
   * official balance endpoint with the gateway's key.
   */
  origins?: string[]
  /**
   * Whether same-platform DSH model providers may contribute extra credential
   * refs (multi-account cards). Defaults to true; org-admin endpoints
   * (OpenAI/Anthropic Admin keys) set it to false — a normal model-provider
   * key is not an admin key and would only produce a 401 card.
   */
  extraRefsFromProviders?: boolean
  /** Fetch the snapshot with the resolved key. */
  fetch(key: string, signal?: AbortSignal): Promise<ProviderSnapshot>
}

const UA = 'KimiCLI/1.6'

/** Custom-platform responses are capped at this many bytes (SSRF/DoS hygiene). */
export const CUSTOM_RESPONSE_MAX_BYTES = 256 * 1024

/**
 * GET + JSON with a response cap. Built-in catalog endpoints keep the
 * platform default (redirects followed, 1 MiB cap); user-declared custom
 * platforms pass `strict`, which refuses redirects — a public endpoint that
 * 302s to an internal address would otherwise defeat the host check — and
 * applies the tighter 256 KiB cap.
 */
async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal, opts: { strict?: boolean } = {}): Promise<unknown> {
  const maxBytes = opts.strict === true ? CUSTOM_RESPONSE_MAX_BYTES : 1024 * 1024
  const resp = await fetch(url, { headers, signal, ...(opts.strict === true ? { redirect: 'error' as const } : {}) })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`)
  }
  const text = await resp.text()
  if (text.length > maxBytes) throw new Error(`响应超过 ${String(Math.round(maxBytes / 1024))} KiB 上限`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('响应不是合法 JSON')
  }
}

/**
 * Reject custom-platform endpoints that could be used to probe the local
 * network: non-HTTPS, embedded credentials, query/fragment components, and
 * loopback / private / link-local / unique-local hosts (by name or IP
 * literal). The check runs at configuration time; getJson then refuses
 * redirects so a public host cannot hop to an internal one at fetch time.
 * @param raw - the user-supplied endpoint URL.
 * @returns the normalized URL string.
 */
export function assertPublicHttpsUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('接口地址不是合法 URL')
  }
  if (url.protocol !== 'https:') throw new Error('接口地址必须是 https URL')
  if (url.username || url.password) throw new Error('接口地址不能内嵌用户名/密码')
  if (url.search || url.hash) throw new Error('接口地址不能带查询参数或 # 片段')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blockedNames = ['localhost', 'metadata.google.internal', 'metadata.goog']
  if (blockedNames.includes(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`接口地址不能指向内网主机（${host}）`)
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    const priv = a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    if (priv) throw new Error(`接口地址不能指向内网/保留地址（${host}）`)
  } else if (host.includes(':')) {
    const v6 = host
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('::ffff:127.')) {
      throw new Error(`接口地址不能指向内网/保留地址（${host}）`)
    }
  }
  return url.toString()
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

const OPENAI_BILLING_CENTS_PER_DOLLAR = 100
const NEWAPI_UNLIMITED_HARD_LIMIT = 100_000_000
const DEFAULT_NEWAPI_QUOTA_PER_UNIT = 500_000

function usd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
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
 * the z.ai frontend source: TOKENS_LIMIT unit=3 = the N-hour session window
 * (number = hours, typically 5), TOKENS_LIMIT unit=6 = the weekly window;
 * TIME_LIMIT = monthly search/MCP-tool lane (its usageDetails are
 * search-prime / web-reader / zread). Do NOT infer the window from
 * unit*number ordering — unit=6/number=1 (week) sorts below unit=3/number=5
 * (5h) and the two rows end up swapped.
 *
 * Upstream also serves the same windows as CREDIT_LIMIT — the Coding Plan
 * meters credits instead of tokens — with the same usage/currentValue/
 * remaining fields, so both types map to the same rows.
 */
const zaiCoding: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  if (num(raw.code) !== undefined && num(raw.code) !== 200) throw new Error(`upstream code ${String(raw.code)}: ${str(raw.msg) ?? 'unknown'}`)
  const data = (raw.data ?? raw) as Record<string, unknown>
  const limits = Array.isArray(data.limits) ? data.limits as Array<Record<string, unknown>> : []
  if (limits.length === 0) throw new Error('data.limits is empty')
  const tokens = limits.filter((l) => {
    const type = str(l.type)
    return type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT'
  })
  const time = limits.find((l) => str(l.type) === 'TIME_LIMIT')
  const items: QuotaItem[] = []
  const tokenItem = (l: Record<string, unknown>, label: string): void => {
    const percentage = num(l.percentage)
    const used = num(l.currentValue)
    const limit = num(l.usage)
    // percentage 优先；缺失时用 currentValue/usage 兜底。display 必须跟着同一个
    // 值走，否则会出现进度条 76% 而文字写「已用 ?%」的自相矛盾渲染。
    const percent = percentage ?? pct(used, limit)
    items.push({
      label,
      used,
      limit,
      remaining: num(l.remaining) ?? (used !== undefined && limit !== undefined ? limit - used : undefined),
      percent,
      display: `已用 ${percentage !== undefined ? percentage : percent !== undefined ? Math.round(percent) : '?'}%`,
      resetAt: isoFromMs(l.nextResetTime),
    })
  }
  // unit 语义（z.ai 前端源码）：3 = 小时窗（number 为小时数），6 = 周窗。
  const hourly = tokens.filter((l) => num(l.unit) === 3)
  const weekly = tokens.filter((l) => num(l.unit) === 6)
  const known = new Set([...hourly, ...weekly])
  for (const l of hourly) tokenItem(l, `${num(l.number) ?? 5} 小时窗口`)
  for (const l of weekly) tokenItem(l, '本周窗口')
  // 未知 unit 的兜底：按 unit*number 时长排序，给通用标签。
  tokens
    .filter((l) => !known.has(l))
    .sort((a, b) => (num(a.unit) ?? 0) * (num(a.number) ?? 1) - (num(b.unit) ?? 0) * (num(b.number) ?? 1))
    .forEach((l, i) => { tokenItem(l, i === 0 && hourly.length === 0 ? '5 小时窗口' : `Token 窗口 ${i + 1}`) })
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
  if (items.length === 0) throw new Error('no TOKENS_LIMIT / CREDIT_LIMIT / TIME_LIMIT entries')
  return items
}

const kimiCoding: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const usage = (raw.usage ?? {}) as Record<string, unknown>
  const limits = Array.isArray(raw.limits) ? raw.limits as Array<Record<string, unknown>> : []
  const wallet = (raw.boosterWallet ?? null) as Record<string, unknown> | null
  const walletBal = (wallet?.balance ?? {}) as Record<string, unknown>

  // Right after a window reset the API omits `used` (it reports limit +
  // remaining only) — derive it so the row never degrades to "? / 100".
  const quota = (u: Record<string, unknown>): Pick<QuotaItem, 'used' | 'limit' | 'remaining' | 'percent'> => {
    const limit = num(u.limit)
    const remaining = num(u.remaining)
    const used = num(u.used) ?? (limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined)
    return { used, limit, remaining, percent: pct(used, limit) }
  }

  const items: QuotaItem[] = [
    {
      label: '周额度',
      ...quota(usage),
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
      ...quota(detail),
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
    const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
    items.push({ label: `${currency} 总余额`, display: `${sym}${str(info.total_balance) ?? '?'}`, remaining: num(info.total_balance) })
    // total = 充值 + 赠金：赠金为 0 时「充值」必然等于「总余额」，拆开只是
    // 噪音；只有赠金非零才显示构成明细。
    const granted = num(info.granted_balance) ?? 0
    if (granted !== 0) {
      items.push({ label: `${currency} 其中充值`, display: `${sym}${str(info.topped_up_balance) ?? '?'}` })
      items.push({ label: `${currency} 其中赠金`, display: `${sym}${str(info.granted_balance) ?? '?'}` })
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
    { label: '余额', display: `$${(credits - usage).toFixed(2)}`, remaining: credits - usage },
    { label: '累计已用', display: `$${usage.toFixed(2)} / $${credits.toFixed(2)}` },
  ]
}

const siliconflowBalance: FormatParser = (body) => {
  const data = (body as Record<string, unknown>).data as Record<string, unknown> | undefined
  const balance = num(data?.balance)
  if (balance === undefined) throw new Error('missing data.balance')
  const items: QuotaItem[] = [{ label: '余额', display: `¥${balance}`, remaining: balance }]
  if (num(data?.chargeBalance) !== undefined) items.push({ label: '充值', display: `¥${num(data?.chargeBalance)}` })
  if (num(data?.totalUsage) !== undefined) items.push({ label: '累计用量', display: `¥${num(data?.totalUsage)}` })
  return items
}

const moonshotBalance: FormatParser = (body) => {
  const data = (body as Record<string, unknown>).data as Record<string, unknown> | undefined
  const balance = num(data?.total_balance)
  if (balance === undefined) throw new Error('missing data.total_balance')
  return [{ label: '余额', display: `¥${balance}`, remaining: balance }]
}

const stepfunAccounts: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const balance = num(raw.balance)
  if (balance === undefined) throw new Error('missing balance')
  const items: QuotaItem[] = [{ label: '余额', display: `¥${balance}`, remaining: balance }]
  if (num(raw.total_cash_balance) !== undefined) items.push({ label: '现金', display: `¥${num(raw.total_cash_balance)}` })
  if (num(raw.total_voucher_balance) !== undefined) items.push({ label: '赠金', display: `¥${num(raw.total_voucher_balance)}` })
  return items
}

const xaiCredits: FormatParser = (body) => {
  const total = ((body as Record<string, unknown>).total ?? {}) as Record<string, unknown>
  const cents = num(total.val)
  if (cents === undefined) throw new Error('missing total.val')
  return [{ label: '余额', display: `$${(Math.abs(cents) / 100).toFixed(2)}`, remaining: Math.abs(cents) / 100 }]
}

/**
 * MiniMax `token_plan/remains`: one `model_remains` entry per model, each
 * carrying a 5-hour window (`current_interval_*`) AND a weekly window
 * (`current_weekly_*`). Both windows report the REMAINING percentage
 * (`*_remaining_percent`); the count fields (`*_total_count` /
 * `*_usage_count`) are 0 on current builds, so the percentage is the only
 * usable source there. `*_end_time` is the window reset timestamp.
 */
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
  /** First present numeric field, skipping null/undefined like `??` does. */
  const firstNum = (m: Record<string, unknown>, keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = m[k]
      if (v === null || v === undefined) continue
      const n = num(v)
      if (n !== undefined) return n
    }
    return undefined
  }
  const windowItem = (m: Record<string, unknown>, spec: { label: string; percent: string; total: string; remaining: string[]; reset: string[] }): QuotaItem | undefined => {
    const resetAt = toIso(spec.reset.map((k) => m[k]).find((v) => v !== null && v !== undefined))
    const rawPct = m[spec.percent]
    const pctRemaining = rawPct === null || rawPct === undefined ? undefined : num(rawPct)
    if (pctRemaining !== undefined) {
      const usedPct = Math.min(100, Math.max(0, 100 - pctRemaining))
      return { label: spec.label, percent: usedPct, display: `已用 ${Math.round(usedPct)}%`, resetAt }
    }
    // Some builds report remaining via *_usage_count (upstream quirk).
    const total = num(m[spec.total])
    const remaining = firstNum(m, spec.remaining)
    if (total !== undefined && total > 0 && remaining !== undefined) {
      const used = total - remaining
      return { label: spec.label, used, limit: total, remaining, percent: pct(used, total), resetAt }
    }
    return undefined
  }
  const interval = { label: '5h 窗口', percent: 'current_interval_remaining_percent', total: 'current_interval_total_count', remaining: ['current_interval_remaining_count', 'current_interval_remains_count', 'current_interval_usage_count'], reset: ['end_time', 'remains_time'] }
  const weekly = { label: '本周窗口', percent: 'current_weekly_remaining_percent', total: 'current_weekly_total_count', remaining: ['current_weekly_remaining_count', 'current_weekly_remains_count', 'current_weekly_usage_count'], reset: ['weekly_end_time', 'weekly_remains_time'] }
  for (const m of remains) {
    const items = [windowItem(m, interval), windowItem(m, weekly)].filter((x): x is QuotaItem => x !== undefined)
    if (items.length > 0) return items
  }
  throw new Error('no usable current_interval / current_weekly fields in model_remains')
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

/** DeepInfra: prepaid funds come back as a NEGATIVE stripe_balance. */
const deepinfraBilling: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const stripeBalance = num(raw.stripe_balance)
  if (stripeBalance === undefined) throw new Error('missing stripe_balance')
  const items: QuotaItem[] = []
  // negative = 预付余额（转正显示）；positive = 欠费
  if (stripeBalance < 0) items.push({ label: '预付余额', display: `$${(-stripeBalance).toFixed(2)}`, remaining: -stripeBalance })
  else if (stripeBalance > 0) items.push({ label: '待付欠费', display: `$${stripeBalance.toFixed(2)}` })
  else items.push({ label: '预付余额', display: '$0.00' })
  const limit = num(raw.spending_limit ?? raw.spend_limit)
  if (limit !== undefined && limit > 0) items.push({ label: '消费上限', display: `$${limit}` })
  if (raw.suspended === true) items.push({ label: '状态', display: `已暂停${str(raw.suspension_reason) ? `：${str(raw.suspension_reason)}` : ''}` })
  return items
}

/** Venice: DIEM（平台积分）与 USD 双余额。 */
const veniceBalance: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const data = (raw.data ?? raw) as Record<string, unknown>
  const items: QuotaItem[] = []
  const diem = num(data.diem ?? data.DIEM ?? (data.balances as Record<string, unknown> | undefined)?.diem)
  const usd = num(data.usd ?? data.USD ?? (data.balances as Record<string, unknown> | undefined)?.usd)
  if (usd !== undefined) items.push({ label: 'USD 余额', display: `$${usd.toFixed(2)}`, remaining: usd })
  if (diem !== undefined) items.push({ label: 'DIEM 余额', display: String(diem) })
  if (items.length === 0) throw new Error('missing usd/diem balance')
  return items
}

/** NeuralWatt: 订阅 kWh 用量窗口 + 预付 USD 余额。 */
const neuralwattQuota: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const data = (raw.data ?? raw) as Record<string, unknown>
  const items: QuotaItem[] = []
  const used = num(data.kwh_used)
  const included = num(data.kwh_included)
  if (used !== undefined && included !== undefined && included > 0) {
    items.push({ label: '订阅 kWh', used, limit: included, remaining: included - used, percent: pct(used, included) })
  }
  const prepaid = num(data.prepaid_usd ?? data.credit_balance_usd ?? data.balance_usd)
  if (prepaid !== undefined) items.push({ label: '预付余额', display: `$${prepaid.toFixed(2)}`, remaining: prepaid })
  const spent = num(data.spent_usd)
  const keyLimit = num(data.limit_usd)
  if (spent !== undefined && keyLimit !== undefined && keyLimit > 0) {
    items.push({ label: '本 key 消费', used: spent, limit: keyLimit, remaining: keyLimit - spent, percent: pct(spent, keyLimit) })
  }
  if (items.length === 0) throw new Error('missing quota fields')
  return items
}

/**
 * OpenAI Admin API cost buckets (`/v1/organization/costs`, bucket_width=1d).
 * Amounts are USD floats at `results[].amount.value`; buckets ascend and may
 * be empty. Requires an organization Admin key (`sk-admin-…`) — a normal
 * project key cannot read this endpoint.
 */
const openaiCosts: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const buckets = (Array.isArray(raw.data) ? raw.data : []) as Array<Record<string, unknown>>
  if (buckets.length === 0) throw new Error('no cost buckets returned (does this key have Admin API access?)')
  const sum = (from: number): number => buckets
    .filter((b) => (num(b.start_time) ?? 0) >= from)
    .reduce((total, b) => total + ((Array.isArray(b.results) ? b.results : []) as Array<Record<string, unknown>>)
      .reduce((s, r) => s + (num((r.amount as Record<string, unknown> | undefined)?.value) ?? 0), 0), 0)
  const nowSec = Math.floor(Date.now() / 1000)
  const today = (num(buckets[buckets.length - 1]!.start_time) ?? 0)
  return [
    { label: '今日消耗', display: `$${sum(today).toFixed(2)}` },
    { label: '近 7 天消耗', display: `$${sum(nowSec - 7 * 86400).toFixed(2)}` },
    { label: '近 30 天消耗', display: `$${sum(nowSec - 30 * 86400).toFixed(2)}` },
  ]
}

/**
 * Anthropic Admin API cost report (`/v1/organizations/cost_report`). Amounts
 * arrive as decimal STRINGS in the lowest currency unit (cents): "123.45"
 * USD means $1.2345. Requires an Admin API key (sk-ant-admin…) — workspace
 * keys are rejected upstream.
 */
const anthropicCosts: FormatParser = (body) => {
  const raw = body as Record<string, unknown>
  const buckets = (Array.isArray(raw.data) ? raw.data : []) as Array<Record<string, unknown>>
  if (buckets.length === 0) throw new Error('no cost buckets returned (does this key have Admin API access?)')
  const sum = (from: number): number => buckets
    .filter((b) => Date.parse(str(b.starting_at) ?? '') >= from)
    .reduce((total, b) => total + ((Array.isArray(b.results) ? b.results : []) as Array<Record<string, unknown>>)
      .reduce((s, r) => s + (Number(str(r.amount) ?? 0) || 0) / 100, 0), 0)
  const today = Date.parse(str(buckets[buckets.length - 1]!.starting_at) ?? '')
  const dayStart = Number.isNaN(today) ? Date.now() : today
  return [
    { label: '今日消耗', display: `$${sum(dayStart).toFixed(2)}` },
    { label: '近 7 天消耗', display: `$${sum(Date.now() - 7 * 86400_000).toFixed(2)}` },
    { label: '近 30 天消耗', display: `$${sum(Date.now() - 30 * 86400_000).toFixed(2)}` },
  ]
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
  'deepinfra-billing': deepinfraBilling,
  'venice-balance': veniceBalance,
  'neuralwatt-quota': neuralwattQuota,
  'openai-costs': openaiCosts,
  'anthropic-costs': anthropicCosts,
}

/** Formats offered in the panel for user-declared custom HTTP platforms. */
export const CUSTOM_FORMATS = ['openai-billing', 'newapi-account', 'deepseek-balance', 'moonshot-balance', 'siliconflow-balance', 'openrouter-credits', 'stepfun-accounts', 'xai-credits'] as const

// ── Catalog ──────────────────────────────────────────────────────────────────

interface CatalogEntry {
  id: string
  label: string
  keyRefs: string[]
  endpoint: string
  format: string
  /** Suffix resolved from the response (e.g. plan level). */
  planOf?: (body: unknown) => string | undefined
  /** How the key is presented: `Authorization: Bearer` (default) or `x-api-key`. */
  auth?: 'bearer' | 'x-api-key'
  /** Extra request headers (e.g. anthropic-version). */
  headers?: Record<string, string>
  /** Full URL builder for endpoints that need query parameters. */
  buildUrl?: (now: number) => string
  /** Gray note rendered under the card head (e.g. what the API cannot report). */
  note?: string
  /** Opt out of extra account cards from same-platform DSH providers (admin-only endpoints). */
  adminOnly?: boolean
}

function catalogFetch(entry: CatalogEntry): (key: string, signal?: AbortSignal) => Promise<ProviderSnapshot> {
  const parser = FORMATS[entry.format]
  if (!parser) throw new Error(`unknown format ${entry.format}`)
  return async (key, signal) => {
    const headers: Record<string, string> = entry.auth === 'x-api-key'
      ? { 'x-api-key': key, ...entry.headers }
      : { Authorization: `Bearer ${key}`, ...entry.headers }
    if (entry.format === 'kimi-coding') headers['User-Agent'] = UA
    const url = entry.buildUrl ? entry.buildUrl(Date.now()) : entry.endpoint
    const body = await getJson(url, headers, signal)
    const items = parser(body)
    const plan = entry.planOf?.(body)
    return {
      id: entry.id,
      label: plan ? `${entry.label} · ${plan}` : entry.label,
      status: 'ok',
      via: 'api',
      ...(entry.note ? { message: entry.note } : {}),
      items,
    }
  }
}

// ── 智谱：API key 能查的「账户余额」 ────────────────────────────────────────
//
// 智谱把控制台接口和自己的开放 API 混在同一个 /api/biz/* 命名空间下，但权限
// 不一样（2026-10 实测，`ZAI_CODING_CN_API_KEY` 标准 API key）：
//   - GET /api/biz/account/query-customer-account-report  → 200，余额/充值/赠送/
//     累计消费/冻结；Bearer key 即可
//   - GET /api/biz/customer/accountSet、/api/biz/customer/getCustomerInfo → 403
//     `APIKey not allow access`（控制台 JWT 专用，所以 MCP 那行才要登录态）
// 也就是说「余额」完全不需要浏览器登录，一条 GET 就行。

const ZHIPU_ACCOUNT_REPORT_URL = 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report'

/** CNY 金额：两位小数、去掉多余的 0（0 → ¥0、214.908478 → ¥214.91）。 */
function cny(v: number): string {
  const rounded = Math.round(v * 100) / 100
  return `¥${rounded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/**
 * 把 account-report 响应整理成面板行：可用余额（退回 balance）+ 累计消费
 * （+ 今日消费，仅当上游给了非零值）。上游余额为 0 时也照实显示 ¥0 ——
 * 「没充值」是有效信息，不该被藏起来。
 * @param body - `{code, msg, data:{balance, availableBalance, totalSpendAmount, …}}`
 *   或已经解开外壳的 data 本体。
 * @returns 面板条目；字段都对不上时返回空数组。
 */
export function zhipuAccountItems(body: unknown): QuotaItem[] {
  const raw = body as Record<string, unknown> | null | undefined
  if (raw === null || raw === undefined || typeof raw !== 'object') return []
  const data = (raw.data !== null && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>
  const items: QuotaItem[] = []
  const balance = num(data.availableBalance) ?? num(data.balance)
  if (balance !== undefined) items.push({ label: '账户余额', display: cny(balance) })
  const spent = num(data.totalSpendAmount)
  if (spent !== undefined) items.push({ label: '累计消费', display: cny(spent) })
  const today = num(data.todaySpendAmount)
  if (today !== undefined && today > 0) items.push({ label: '今日消费', display: cny(today) })
  return items
}

/** 智谱账户余额行（读取失败时由 {@link withExtraItems} 静默跳过）。 */
async function zhipuAccountRows(key: string, signal?: AbortSignal): Promise<QuotaItem[]> {
  const body = await getJson(ZHIPU_ACCOUNT_REPORT_URL, { Authorization: `Bearer ${key}`, accept: 'application/json, text/plain, */*' }, signal)
  return zhipuAccountItems(body)
}

/**
 * 给适配器挂一组「可选附加行」：主查询（配额窗口）先跑，附加查询（余额等）
 * 失败只是少几行，绝不会把整张卡变成 error。
 * @param base - 原适配器（自带 fetch）。
 * @param extra - 追加条目的查询；抛错即忽略。
 * @returns 合并后的适配器。
 */
export function withExtraItems(base: DirectAdapter, extra: (key: string, signal?: AbortSignal) => Promise<QuotaItem[]>): DirectAdapter {
  return {
    ...base,
    async fetch(key, signal) {
      const snapshot = await base.fetch(key, signal)
      try {
        snapshot.items = [...snapshot.items, ...(await extra(key, signal))]
      } catch {
        /* 附加信息是锦上添花：403 / 超时 / 形状变化都不影响主行 */
      }
      return snapshot
    },
  }
}

// ── OpenDesign（open-design.ai / Vela）───────────────────────────────────────
//
// OpenDesign（下称 OD）有两个平面，key 不能混用：
//   - 控制面 https://amr-api.open-design.ai/api/v1 ← 套餐 / 钱包 / 额度窗口，
//     只认 `vela_ctrl_…`（由 vela CLI 设备授权签发，任何网页都不印这个 key）
//   - 模型面 https://amr-link.open-design.ai/v1   ← 只做推理，认 `sk-amr-…`
// 推理 key 打控制面一律 401，所以「模型面查额度」这条路根本不存在 —— 这正是
// 社区插件 dsh-od-quota 必须单独存在、而 DSH 里 opendesign 供应商只能探活的
// 原因。额度必须走控制面，且要先知道 workspaceId（个人账号查
// /workspaces/current 即可）。
//
// 端点（2026-11 实测，本机真实账户）：
//   GET /workspaces/current                        → workspaceId / role
//   GET /workspaces/{id}/billing/preflight          → codingPlan.windows[] + balanceUsd
//   GET /workspaces/{id}/wallet/balance             → balanceUsd（与 preflight 一致）
//   GET /billing/summary                            → creditsPerUsd / 累计消费 / 套餐
// 注意 /billing/coding-plan-usage 对 control key 返回 401 —— 别照抄 dsh-cost-meter
// 文档里的那个端点，preflight 才是能用的（dsh-od-quota 也用 preflight）。

/** OD 控制面根。模型面是另一个 host，刻意分开。 */
const OPENDESIGN_CONSOLE = 'https://amr-api.open-design.ai/api/v1'

/** 额度以 credits 计；控制面自报 creditsPerUsd=10000，查到前先按它折算。 */
const OPENDESIGN_FALLBACK_CREDITS_PER_USD = 10_000

/** 凭证引用名：控制面 key。模型供应商配的 `OPENDESIGN_API_KEY` 是推理 key，不是它。 */
const OPENDESIGN_CONTROL_REF = 'OPENDESIGN_CONTROL_KEY'

/**
 * vela（Open Design 桌面版 / CLI）把登录态存在这里。
 *
 * 查 OD 额度**必须先登录 Open Design**：控制面 key `vela_ctrl_…` 只由 vela 的
 * 设备授权签发，任何网页都不显示它。与其让用户在面板里手抄这把 key（还会在
 * 重新登录后失效），不如直接复用它——这个文件就是"我已经登录了 OD"的凭据。
 */
/** 登录态文件路径：每次调用现算，不在模块加载时固化（HOME 变了也能读对）。 */
function opendesignVelaConfigPath(): string {
  return join(homedir(), '.amr', 'config.json')
}

/**
 * 读 vela 登录态里的 controlKey（`profiles.<profile>.controlKey`）。
 *
 * 只读、不写回、不缓存：每次刷新都重新读，所以用户在 Open Design 里换了账号
 * 或重新登录后，面板下一次刷新就跟上，不需要任何手动同步。
 * @param profile - vela 的 profile 名，默认 `prod`。
 * @returns key 文本，或 `undefined`（没装 vela / 没登录 / 文件形状变了）。
 */
export function opendesignVelaControlKey(profile = 'prod'): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(opendesignVelaConfigPath(), 'utf8')) as Record<string, unknown>
    const profiles = (raw.profiles ?? {}) as Record<string, unknown>
    const entry = (profiles[profile] ?? {}) as Record<string, unknown>
    const key = entry.controlKey
    return typeof key === 'string' && key.trim().length > 0 ? key.trim() : undefined
  } catch {
    return undefined
  }
}

/** 千分位整数（credits 值通常上万，裸数字不可读）。 */
function thousands(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/** durationSeconds → 面板标签。窗口按长度升序排，与 zai 的既有约定一致。 */
function opendesignWindowLabel(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400} 天窗口`
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 小时窗口`
  return `${Math.round(seconds / 60)} 分钟窗口`
}

/**
 * `codingPlan.windows[]` → 面板行。
 *
 * 每个窗口各自独立（anchored_recurring，7 天窗从订阅起算），**绝不相加**、
 * 也不合并成「共 N credits」——套餐可能存在并行窗口，相加会虚高。
 * @param plan - preflight 响应里的 `codingPlan` 本体。
 * @param creditsPerUsd - credits → USD 的折算率。
 */
export function opendesignPlanItems(plan: unknown, creditsPerUsd: number): QuotaItem[] {
  const raw = (plan !== null && typeof plan === 'object' ? plan : {}) as Record<string, unknown>
  const rows = Array.isArray(raw.windows) ? raw.windows as Array<Record<string, unknown>> : []
  const items: QuotaItem[] = []
  for (const row of rows.slice().sort((a, b) => (num(a.durationSeconds) ?? 0) - (num(b.durationSeconds) ?? 0))) {
    const duration = num(row.durationSeconds)
    const used = num(row.usedCredits)
    const limit = num(row.limitCredits)
    const remaining = num(row.remainingCredits)
      ?? (used !== undefined && limit !== undefined ? limit - used : undefined)
    if (duration === undefined || limit === undefined || limit <= 0) continue
    const left = remaining ?? 0
    items.push({
      label: opendesignWindowLabel(duration),
      used,
      limit,
      remaining,
      percent: pct(used, limit),
      resetAt: str(row.resetsAt),
      display: `剩 ${thousands(left)} / ${thousands(limit)} credits (${opendesignUsdText(left / creditsPerUsd)})`,
    })
  }
  return items
}

/**
 * 控制面 GET，把 HTTP 状态码翻译成能直接照着修的中文错误。
 *
 * 401 的最常见原因是把 `sk-amr-…` 推理 key 填到了这里：面板如果只说
 * 「HTTP 401 unauthenticated」，用户永远猜不到要换一种 key。
 */
async function opendesignGet(path: string, headers: Record<string, string>, signal: AbortSignal | undefined, label: string): Promise<unknown> {
  try {
    return await getJson(`${OPENDESIGN_CONSOLE}${path}`, headers, signal)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const status = num(/^HTTP (\d+)/.exec(text)?.[1])
    if (status === 401) throw new Error(`${label} 401：额度查询只认 vela_ctrl_… 控制面 key；sk-amr-… 推理 key 没有这个权限（在 Open Design 里登录后由 vela CLI 签发）`)
    if (status === 403) throw new Error(`${label} 403：该账号没有查看额度的权限`)
    if (status === 404) throw new Error(`${label} 404：workspace 不存在，或这个 key 属于另一个工作空间`)
    if (status === 429) throw new Error(`${label} 429：请求过于频繁`)
    throw new Error(`${label} 失败：${text}`)
  }
}

/** 面板行里的金额：负数（欠费）也照实显示，不加括号不加色。 */
function opendesignUsdText(v: number): string {
  const body = Math.abs(v).toFixed(2)
  return v < 0 ? `-$${body}` : `$${body}`
}

/**
 * OpenDesign 额度查询：解析 workspace → 读 preflight → 可选读 summary。
 *
 * 钱包余额取 preflight 的 `balanceUsd`（与控制面 /wallet/balance 和 vela CLI
 * 一致）；`/billing/summary` 的 `balanceUsd` 在同一账户上报 0.0000，是另一套
 * 口径，不要用它当余额。summary 只用来补累计消费这些纯统计字段。
 */
export async function fetchOpendesignSnapshot(key: string, signal?: AbortSignal): Promise<ProviderSnapshot> {
  // vela 登录态里的 key 永远优先：用户重新登录 OD 后 controlKey 可能轮换，宿主
  // 侧的同步（controller.syncOpendesignKey）负责把它写回凭证域，这里再兜一层，
  // 免得凭证服务写失败时面板一直用旧 key 撞 401。
  const fromVela = opendesignVelaControlKey()
  const credential = fromVela ?? key
  const headers = { Authorization: `Bearer ${credential}` }
  // 多工作空间的逃生口：控制面 /workspaces/current 只给「当前」工作空间，
  // 团队账号下想盯另一个 workspace 时用环境变量钉住，省掉一次解析请求。
  const pinned = process.env.OPENDESIGN_WORKSPACE_ID?.trim() ?? ''
  let workspace = pinned
  if (workspace.length === 0) {
    const current = await opendesignGet('/workspaces/current', headers, signal, 'workspaces/current')
    const currentBody = (current ?? {}) as Record<string, unknown>
    workspace = str(currentBody.activeWorkspaceId) ?? str(currentBody.workspaceId) ?? ''
    if (workspace.length === 0) throw new Error('该 key 没有可读的工作空间（workspaces/current 没返回 workspaceId）')
  }

  const preflight = (await opendesignGet(
    `/workspaces/${encodeURIComponent(workspace)}/billing/preflight`,
    headers,
    signal,
    'billing/preflight',
  ) ?? {}) as Record<string, unknown>

  // summary 是锦上添花：拿不到只是少几行统计，不该把整张卡变成 error。
  let summary: Record<string, unknown> | undefined
  try {
    const body = await opendesignGet('/billing/summary', headers, signal, 'billing/summary')
    if (body !== null && typeof body === 'object') summary = body as Record<string, unknown>
  } catch {
    /* ignore */
  }

  const reportedRate = num(summary?.creditsPerUsd)
  const creditsPerUsd = reportedRate !== undefined && reportedRate > 0 ? reportedRate : OPENDESIGN_FALLBACK_CREDITS_PER_USD

  const plan = preflight.codingPlan
  const items = opendesignPlanItems(plan, creditsPerUsd)

  const balance = num(preflight.balanceUsd) ?? num(summary?.balanceUsd)
  if (balance !== undefined) {
    items.push({ label: '钱包余额', display: opendesignUsdText(balance), remaining: balance })
  }

  const consumed = num(summary?.totalConsumedUsd)
  if (consumed !== undefined) {
    const calls = num(summary?.usageCount)
    items.push({
      label: '累计消费',
      display: `${opendesignUsdText(consumed)}${calls !== undefined ? ` · ${thousands(calls)} 次调用` : ''}`,
    })
  }

  // eligible=false 是明确事实（没有 Design Plan，全按钱包计费），要说明而不是
  // 显示成「没有额度窗口」这种像故障的样子。
  const eligible = (plan as Record<string, unknown> | undefined)?.eligible
  if (items.length === 0) {
    throw new Error(eligible === false
      ? '该账号没有 Design Plan 额度，调用按钱包余额计费'
      : '控制面没有返回任何额度窗口或余额')
  }

  const tier = str((plan as Record<string, unknown> | undefined)?.tier)
  const funding = str(preflight.funding)
  const notes: string[] = [`workspace ${workspace}`]
  if (funding !== undefined) notes.push(`计费来源 ${funding}`)
  // 让面板说清这把 key 是哪儿来的：复用 OD 登录态还是 DSH 凭证域里手填的。
  notes.push(fromVela !== undefined ? '凭证复用 Open Design 登录态' : '凭证来自 DSH 凭证域')
  return {
    id: 'opendesign',
    label: tier !== undefined && tier.length > 0 ? `OpenDesign · ${tier}` : 'OpenDesign',
    status: 'ok',
    via: 'api',
    message: notes.join(' · '),
    items,
  }
}

/** Origin of a catalog endpoint, or `undefined` when it is not a parseable URL. */
function endpointOrigin(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).origin
  } catch {
    return undefined
  }
}

function entry(e: CatalogEntry): DirectAdapter {
  const origin = endpointOrigin(e.endpoint)
  return {
    id: e.id,
    label: e.label,
    keyRefs: e.keyRefs,
    envKeys: e.keyRefs,
    ...(origin === undefined ? {} : { origins: [origin] }),
    ...(e.adminOnly === true ? { extraRefsFromProviders: false } : {}),
    fetch: catalogFetch(e),
  }
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
 * The three primary platforms (Kimi / DeepSeek / Zhipu CN). Like every
 * built-in they render only when a credential ref resolves; what makes them
 * special is the panel's key manager can store PLUGIN-PRIVATE keys for them
 * (see config.KEY_REFS), deletable without touching DSH model routing.
 */
export const DIRECT_ADAPTERS: DirectAdapter[] = [
  entry({ id: 'kimi', label: 'Kimi Code', keyRefs: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'], endpoint: 'https://api.kimi.com/coding/v1/usages', format: 'kimi-coding', planOf: kimiPlanOf }),
  entry({ id: 'deepseek', label: 'DeepSeek', keyRefs: ['DEEPSEEK_API_KEY'], endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' }),
  // 配额窗口（Coding Plan）+ 账户余额/累计消费（标准 API key 同样可查）。
  withExtraItems(
    entry({ id: 'zhipu', label: '智谱 Coding Plan', keyRefs: ['ZAI_CODING_CN_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY'], endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', format: 'zai-coding', planOf: zaiPlanOf }),
    zhipuAccountRows,
  ),
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
  entry({ id: 'deepinfra', label: 'DeepInfra', keyRefs: ['DEEPINFRA_API_KEY', 'DEEPINFRA_TOKEN'], endpoint: 'https://api.deepinfra.com/payment/checklist?compute_owed=true', format: 'deepinfra-billing' }),
  entry({ id: 'venice', label: 'Venice', keyRefs: ['VENICE_API_KEY', 'VENICE_KEY'], endpoint: 'https://api.venice.ai/api/v1/billing/balance', format: 'venice-balance' }),
  entry({ id: 'neuralwatt', label: 'NeuralWatt', keyRefs: ['NEURALWATT_API_KEY'], endpoint: 'https://api.neuralwatt.com/v1/quota', format: 'neuralwatt-quota' }),
  // OpenDesign（open-design.ai / Vela）：见文件上方那一段注释。keyRefs 是
  // 控制面 key，不是模型供应商配置里那个 OPENDESIGN_API_KEY（推理 key）——
  // 两者权限完全不同，填错只会得到 401。`extraRefsFromProviders: false`
  // 也是同一个理由：DSH 的 opendesign 供应商声明的 apiKeyEnv 是推理 key，
  // 让它作为「额外账号卡」参与查询只会多出一张 401 的卡。
  {
    id: 'opendesign',
    label: 'OpenDesign',
    keyRefs: ['OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY'],
    envKeys: ['OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY'],
    extraRefsFromProviders: false,
    fetch: fetchOpendesignSnapshot,
  },
  // 国外官方平台：需要组织级 Admin key（普通 sk-* / 项目 key 会被上游拒绝），
  // 只能拿到用量/成本，拿不到余额——卡片上用 note 明确说明。
  entry({
    id: 'openai-admin',
    label: 'OpenAI Platform',
    keyRefs: ['OPENAI_ADMIN_KEY'],
    endpoint: 'https://api.openai.com/v1/organization/costs',
    format: 'openai-costs',
    adminOnly: true,
    note: 'Admin API：仅用量/成本，余额见 OpenAI 后台',
    buildUrl: (now) => `https://api.openai.com/v1/organization/costs?start_time=${String(Math.floor(now / 1000) - 30 * 86400)}&bucket_width=1d&limit=31`,
  }),
  entry({
    id: 'anthropic-admin',
    label: 'Anthropic Claude',
    keyRefs: ['ANTHROPIC_ADMIN_KEY'],
    endpoint: 'https://api.anthropic.com/v1/organizations/cost_report',
    format: 'anthropic-costs',
    auth: 'x-api-key',
    headers: { 'anthropic-version': '2023-06-01', 'User-Agent': UA },
    adminOnly: true,
    note: 'Admin API：仅用量/成本（无余额接口）',
    buildUrl: (now) => `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${new Date(now - 30 * 86400_000).toISOString()}&bucket_width=1d&limit=31`,
  }),
]

/** Every credential ref the direct side may consume (for change watching). */
export const ALL_DIRECT_REFS: string[] = [...new Set([...DIRECT_ADAPTERS, ...CATALOG_EXTRA].flatMap((a) => [...a.keyRefs, ...a.envKeys]))]

/** Fetch shape for one user-declared custom HTTP platform. */
export function customHttpFetch(platform: CustomHttpPlatform): (key: string, signal?: AbortSignal) => Promise<ProviderSnapshot> {
  if (platform.format === 'openai-billing') {
    return async (key, signal) => {
      const base = platform.endpoint.replace(/\/+$/, '')
      const headers = { Authorization: `Bearer ${key}` }
      const sub = await getJson(`${base}/v1/dashboard/billing/subscription`, headers, signal, { strict: true }) as Record<string, unknown>
      const usage = await getJson(`${base}/v1/dashboard/billing/usage`, headers, signal, { strict: true }) as Record<string, unknown>
      const limit = num(sub.hard_limit_usd)
      const usedCents = num(usage.total_usage)
      if (limit === undefined || usedCents === undefined) throw new Error('openai-billing: missing hard_limit_usd / total_usage')
      // The legacy OpenAI-compatible billing contract reports total_usage in
      // cents while hard_limit_usd is in dollars. NewAPI uses 100000000 as
      // the hard-limit sentinel for an unlimited token.
      const used = usedCents / OPENAI_BILLING_CENTS_PER_DOLLAR
      const unlimited = limit >= NEWAPI_UNLIMITED_HARD_LIMIT
      const remaining = Math.max(0, limit - used)
      return {
        id: platform.id,
        label: platform.label,
        status: 'ok',
        via: 'api',
        items: unlimited
          ? [{ label: '额度 (USD)', display: `已用 $${usd(used)} · 无限额度` }]
          : [{
              label: '额度 (USD)',
              used,
              limit,
              // The panel appends 剩{remaining} itself whenever percent and
              // remaining are both set — keep it out of display to avoid
              // rendering the remaining amount twice.
              remaining,
              percent: pct(used, limit),
              display: `$${usd(used)} / $${usd(limit)}`,
            }],
      }
    }
  }
  if (platform.format === 'newapi-account') {
    return async (key, signal) => {
      const userId = platform.userId?.trim() ?? ''
      if (!/^[1-9]\d*$/.test(userId)) throw new Error('newapi-account: userId must be a positive integer')
      const quotaPerUnit = platform.quotaPerUnit ?? DEFAULT_NEWAPI_QUOTA_PER_UNIT
      if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('newapi-account: quotaPerUnit must be positive')
      const base = platform.endpoint.replace(/\/+$/, '')
      const body = await getJson(`${base}/api/user/self`, {
        Authorization: `Bearer ${key}`,
        'New-Api-User': userId,
      }, signal, { strict: true }) as Record<string, unknown>
      if (body.success === false) throw new Error(`newapi-account: ${str(body.message) ?? 'request failed'}`)
      const data = (body.data ?? body) as Record<string, unknown>
      const balanceQuota = num(data.quota)
      const usedQuota = num(data.used_quota)
      if (balanceQuota === undefined && usedQuota === undefined) throw new Error('newapi-account: missing data.quota / data.used_quota')
      const items: QuotaItem[] = []
      if (balanceQuota !== undefined) items.push({ label: '账户余额 (USD)', display: `$${usd(balanceQuota / quotaPerUnit)}` })
      if (usedQuota !== undefined) items.push({ label: '累计已用 (USD)', display: `$${usd(usedQuota / quotaPerUnit)}` })
      return { id: platform.id, label: platform.label, status: 'ok', via: 'api', items }
    }
  }
  const parser = FORMATS[platform.format]
  if (!parser) throw new Error(`unknown format ${platform.format}`)
  return async (key, signal) => {
    const body = await getJson(platform.endpoint, { Authorization: `Bearer ${key}` }, signal, { strict: true })
    return { id: platform.id, label: platform.label, status: 'ok', via: 'api', items: parser(body) }
  }
}
