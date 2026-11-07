/**
 * MCP fallback adapters: platforms without an API-key quota endpoint are read
 * through the DSH-registered MCP servers (`mcp__<serverName>__<toolName>` on
 * ctx.tools). Each adapter parses the tool's canonical JSON result leniently —
 * unknown shapes surface the raw JSON instead of crashing the refresh.
 * @module dsh-quota/mcp
 */

import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ProviderSnapshot, QuotaItem } from './config.ts'

/** Thin wrapper over ctx.tools.execute for one MCP tool. */
export type ToolExec = (name: string, args?: Record<string, unknown>) => Promise<unknown>

/** One MCP tool call's outcome, normalized across `ctx.tools.execute` generations. */
export interface ToolCallOutcome {
  isError: boolean
  /** Canonical JSON value of a successful call. */
  value?: unknown
  /** Upstream failure message of a failed call. */
  message?: string
}

/** `ctx.tools.execute` as whichever DSH generation the host ships (see {@link callTool}). */
type LooseToolRuntime = { execute(input: unknown): Promise<unknown> }

/**
 * Whether this tool runtime takes a whole batch instead of a single call.
 *
 * DSH 0.2.2 replaced `execute({callId,name,arguments})` with
 * `execute({calls,signal,...})` and moved dispatch behind a selected executor;
 * the legacy single-call shape now reaches the batch scheduler, which reads
 * `input.calls.map` and rejects with `ToolBatchExecutionError`
 * ("Tool batch execution failed") before any tool body runs — that was the
 * BigModel row's error after the 0.2.2 upgrade. The batch-only executor seam
 * (`selectExecutor`/`definitions`, both introduced with that split) is the
 * discriminator; 0.2.1 exposes neither.
 * @param tools - the host tool runtime.
 * @returns true when `execute` expects a `{ calls, signal }` batch input.
 */
export function batchExecuteCapable(tools: LooseToolRuntime): boolean {
  const probe = tools as unknown as Record<string, unknown>
  return typeof probe.selectExecutor === 'function' || typeof probe.definitions === 'function'
}

/**
 * Run one tool call through either runtime generation and normalize the result.
 * The batch shape carries raw model-style arguments (`arguments` is JSON text),
 * so the call is encoded as a one-block batch; the legacy shape takes parsed
 * arguments and resolves to one result object.
 * @param tools - the host tool runtime.
 * @param name - public `mcp__<server>__<tool>` name.
 * @param args - parsed tool arguments.
 * @param signal - cancellation/deadline for the call.
 * @returns the normalized outcome; unknown-tool failures still reject so
 *   {@link runMcpAdapter} can tell "server not registered" from a query error.
 */
export async function callTool(
  tools: LooseToolRuntime,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolCallOutcome> {
  if (batchExecuteCapable(tools)) {
    const batch = (await tools.execute({
      calls: [{ type: 'tool-call', id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
      signal,
    })) as { results?: Array<{ result?: { isError?: boolean; value?: unknown; error?: { message?: unknown } } }> }
    const result = batch?.results?.[0]?.result
    if (result === undefined) throw new Error(`tool runtime returned no result for "${name}"`)
    if (result.isError === true) {
      return { isError: true, message: typeof result.error?.message === 'string' ? result.error.message : String(result.error?.message ?? 'error') }
    }
    return { isError: false, value: result.value }
  }
  const outcome = (await tools.execute({
    callId: crypto.randomUUID(),
    name,
    arguments: args,
    signal,
  })) as { isError?: boolean; value?: unknown; error?: { message?: unknown } }
  if (outcome?.isError === true) {
    return { isError: true, message: typeof outcome.error?.message === 'string' ? outcome.error.message : String(outcome.error?.message ?? 'error') }
  }
  return { isError: false, value: outcome?.value }
}

/** One MCP-backed platform adapter. */
export interface McpAdapter {
  id: string
  label: string
  /** Tool calls, tried in order (all contribute items when they succeed). */
  calls: Array<{ name: string; args?: Record<string, unknown> }>
  /** Project the tool results into quota items. */
  parse(results: Array<{ name: string; value: unknown }>): QuotaItem[]
}

/** MCP server names an adapter reads through (`mcp__<server>__<tool>`). */
export function mcpServerNames(adapter: McpAdapter): string[] {
  const names = new Set<string>()
  for (const call of adapter.calls) {
    const parts = call.name.split('__')
    if (parts.length >= 3 && parts[0] === 'mcp' && parts[1]) names.add(parts[1])
  }
  return [...names]
}

/**
 * Keep only the adapters whose MCP server the DSH composition declares.
 *
 * `configured` comes from the loader entry tree (see dsh-config.ts). It is
 * `undefined` when that service is unavailable, in which case every adapter
 * is kept and the tool registry alone decides (previous behaviour). An empty
 * set means DSH declares no MCP servers at all: every MCP platform is
 * skipped, so the panel shows no phantom rows for servers the harness is not
 * configured to run.
 */
export function selectConfiguredAdapters(adapters: McpAdapter[], configured: Set<string> | undefined): McpAdapter[] {
  if (configured === undefined) return adapters
  return adapters.filter((a) => mcpServerNames(a).some((name) => configured.has(name)))
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

/**
 * Unwrap an MCP tool envelope: `tools.execute` returns the raw MCP result
 * (`{ content: [{ type: 'text', text: '<json>' }] }`), while the adapters
 * parse the business JSON inside the text payload.
 */
function unwrap(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return value
  const content = (value as Record<string, unknown>).content
  if (!Array.isArray(content)) return value
  const texts: string[] = []
  for (const c of content) {
    if (c === null || typeof c !== 'object' || (c as Record<string, unknown>).type !== 'text') return value
    texts.push(String((c as Record<string, unknown>).text ?? ''))
  }
  const joined = texts.join('\n').trim()
  try {
    return JSON.parse(joined)
  } catch {
    return joined
  }
}

function walk(obj: unknown, pred: (v: unknown) => boolean): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  const visit = (v: unknown): void => {
    if (v === null || v === undefined || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (pred(v)) out.push(v)
    if (Array.isArray(v)) {
      for (const item of v) visit(item)
    } else {
      for (const key of Object.keys(v as Record<string, unknown>)) visit((v as Record<string, unknown>)[key])
    }
  }
  visit(obj)
  return out
}

/** Find the first object that looks like a quota row: has remaining+limit or used+limit. */
function quotaRows(obj: unknown): Array<Record<string, unknown>> {
  return walk(obj, (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    const has = (...keys: string[]): boolean => keys.some((k) => o[k] !== undefined && o[k] !== null)
    return (has('remaining', 'remaining_amount') && has('limit', 'limit_amount')) ||
      (has('used', 'used_amount') && has('limit', 'limit_amount'))
  }).map((v) => v as Record<string, unknown>)
}

/** Build one item from a row-like object. */
function rowItem(o: Record<string, unknown>, label: string): QuotaItem {
  const used = num(o.used ?? o.used_amount)
  const limit = num(o.limit ?? o.limit_amount)
  const remainingRaw = o.remaining ?? o.remaining_amount
  const remaining = remainingRaw !== undefined && remainingRaw !== null ? num(remainingRaw) : (used !== undefined && limit !== undefined ? limit - used : undefined)
  return {
    label,
    used,
    limit,
    remaining,
    percent: pct(used, limit),
    resetAt: str(o.resetTime ?? o.reset_at ?? o.nextResetTime),
  }
}

/** Grab a named amount (money) from the result tree. */
function moneyItem(obj: unknown, label: string, keys: string[]): QuotaItem | null {
  const hit = walk(obj, (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    return keys.some((k) => o[k] !== undefined && o[k] !== null)
  })[0] as Record<string, unknown> | undefined
  if (!hit) return null
  const value = keys.map((k) => hit[k]).find((v) => v !== undefined && v !== null)
  return { label, display: String(value) }
}

// ── BigModel (智谱开放平台账户) ───────────────────────────────────────────────

/**
 * Coding-plan entitlement for the BigModel account row: `valid` is the console's
 * `"<start> - <end>"` span string, so keep the latest end date per product.
 * Returns nothing when the account holds no subscription.
 */
function bigmodelSubscriptions(value: unknown): QuotaItem[] {
  const seen = new Map<string, { end?: string; status?: string }>()
  for (const row of walk(value, (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    return typeof o.productName === 'string' && o.valid !== undefined
  }) as Array<Record<string, unknown>>) {
    const name = str(row.productName) ?? '订阅'
    const span = str(row.valid) ?? ''
    // `valid` looks like "2027-03-28 10:00:00-2028-03-28 10:00:00": the last
    // date in the span is the end of the paid period.
    const dates = span.match(/\d{4}-\d{2}-\d{2}/g) ?? []
    const end = dates.length >= 2 ? dates[dates.length - 1] : undefined
    const prev = seen.get(name)
    if (!prev || (end !== undefined && (prev.end === undefined || end > prev.end))) {
      seen.set(name, { end, status: str(row.status) })
    }
  }
  const items: QuotaItem[] = []
  for (const [name, { end, status }] of seen) {
    const active = status === undefined || /VALID|生效/i.test(status)
    items.push({
      label: name,
      display: active ? (end ? `生效中 · 至 ${end}` : '生效中') : `已结束${end ? ` · 原至 ${end}` : ''}`,
    })
  }
  return items
}

const bigmodel: McpAdapter = {
  id: 'bigmodel',
  label: '智谱 BigModel',
  calls: [
    // Subscription entitlement first: it is the informative row, the balance
    // alone reads as "nothing changed" when the account happens to hold ¥0.
    { name: 'mcp__bigmodel__bm_subscription_list', args: { pageSize: 9999, pageNum: 1 } },
    { name: 'mcp__bigmodel__bm_account_set', args: {} },
  ],
  parse(results) {
    const items: QuotaItem[] = []
    for (const { name, value } of results) {
      if (name.endsWith('bm_subscription_list')) {
        items.push(...bigmodelSubscriptions(value))
        continue
      }
      const info = walk(value, (v) => {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
        const o = v as Record<string, unknown>
        return o.balance !== undefined && o.customerName !== undefined
      })[0] as Record<string, unknown> | undefined
      const balance = num(info?.balance)
      if (balance !== undefined) items.push({ label: '账户余额', display: `¥${balance}` })
      const customer = str(info?.customerName)
      if (customer) items.push({ label: '账户', display: customer })
    }
    if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(results).slice(0, 200) })
    return items
  },
}

// ── Qianwen / Bailian ────────────────────────────────────────────────────────

const qianwen: McpAdapter = {
  id: 'qianwen',
  label: '通义千问 (百炼)',
  calls: [
    { name: 'mcp__qianwenai__qw_coding_plan', args: {} },
    { name: 'mcp__qianwenai__qw_token_plan_instances', args: {} },
    { name: 'mcp__qianwenai__qw_available_amount', args: {} },
  ],
  parse(results) {
    const items: QuotaItem[] = []
    for (const { name, value } of results) {
      // Coding Plan 控制台 RPC：实例状态 + 5h/周/月配额窗口。
      if (name.includes('coding_plan')) {
        const data = ((value as Record<string, unknown>)?.data ?? value) as Record<string, unknown>
        const infos = Array.isArray(data.codingPlanInstanceInfos) ? data.codingPlanInstanceInfos as Array<Record<string, unknown>> : []
        const inst = infos[0]
        if (inst) {
          const status = str(inst.status)
          const name_ = str(inst.instanceName) ?? 'Coding Plan'
          const endMs = num(inst.instanceEndTime)
          items.push({
            label: name_,
            display: status === 'VALID' ? `生效中（剩 ${num(inst.remainingDays) ?? '?'} 天）` : (status === 'INVALID' ? '已过期' : status ?? ''),
            resetAt: status === 'VALID' && endMs !== undefined ? new Date(endMs).toISOString() : undefined,
          })
        }
        const quota = (data.codingPlanQuotaInfo ?? {}) as Record<string, unknown>
        const window_ = (usedKey: string, totalKey: string, resetKey: string, label: string): void => {
          const used = num(quota[usedKey])
          const total = num(quota[totalKey])
          if (used === undefined && total === undefined) return
          items.push({
            label,
            used,
            limit: total,
            remaining: used !== undefined && total !== undefined ? total - used : undefined,
            percent: pct(used, total),
            resetAt: (() => { const ms = num(quota[resetKey]); return ms !== undefined ? new Date(ms).toISOString() : undefined })(),
          })
        }
        window_('per5HourUsedQuota', 'per5HourTotalQuota', 'per5HourQuotaNextRefreshTime', '5 小时窗口')
        window_('perWeekUsedQuota', 'perWeekTotalQuota', 'perWeekQuotaNextRefreshTime', '本周窗口')
        window_('perBillMonthUsedQuota', 'perBillMonthTotalQuota', 'perBillMonthQuotaNextRefreshTime', '本月窗口')
        continue
      }
      const rows = quotaRows(value)
      if (rows.length > 0) {
        for (const r of rows.slice(0, 3)) items.push(rowItem(r, 'Token 套餐'))
        continue
      }
      const amount = moneyItem(value, '可用金额', ['AvailableAmount', 'available_amount'])
      if (amount) items.push({ ...amount, display: `¥${amount.display}` })
      const end = walk(value, (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && (v as Record<string, unknown>).EndTime !== undefined)[0] as Record<string, unknown> | undefined
      if (end && str(end.EndTime)) items.push({ label: 'Token 套餐到期', resetAt: str(end.EndTime) })
    }
    if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(results).slice(0, 200) })
    return items
  },
}

// ── Scnet (超算互联网) ───────────────────────────────────────────────────────

const scnet: McpAdapter = {
  id: 'scnet',
  label: '超算互联网 (scnet)',
  calls: [
    { name: 'mcp__scnet__scnet_tokenplan_usage', args: {} },
    { name: 'mcp__scnet__scnet_balance', args: {} },
  ],
  parse(results) {
    const items: QuotaItem[] = []
    for (const { value } of results) {
      const rows = quotaRows(value)
      if (rows.length > 0) {
        for (const r of rows.slice(0, 4)) items.push(rowItem(r, 'Token 套餐'))
        continue
      }
      const bal = moneyItem(value, '充值余额', ['balance', 'availableAmount', 'availableBalance', 'usableAmount'])
      if (bal) items.push(bal)
      const spec = moneyItem(value, '专项金额', ['specialAmount', 'specialBalance', 'specificAmount'])
      if (spec) items.push(spec)
    }
    if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(results).slice(0, 200) })
    return items
  },
}

// ── TokenRouter ──────────────────────────────────────────────────────────────

const tokenrouter: McpAdapter = {
  id: 'tokenrouter',
  label: 'TokenRouter',
  calls: [{ name: 'mcp__tokenrouter__tr_user', args: {} }],
  parse(results) {
    const items: QuotaItem[] = []
    for (const { value } of results) {
      const rows = quotaRows(value)
      if (rows.length > 0) {
        for (const r of rows.slice(0, 3)) items.push(rowItem(r, '配额'))
        continue
      }
      // new-api UserSelf: { data: { quota, used_quota, group } }, 500000 points = $1.
      // quota is the REMAINING points, so the bar's total = used + remaining.
      const raw = value as Record<string, unknown>
      const direct = (raw.data ?? raw) as Record<string, unknown>
      const quota = num(direct.quota ?? direct.remaining_quota)
      const used = num(direct.used_quota)
      if (quota !== undefined && used !== undefined) {
        const usedD = used / 500000
        const remD = quota / 500000
        const totalD = usedD + remD
        items.push({
          label: '额度 (USD)',
          percent: pct(usedD, totalD),
          display: `$${usedD.toFixed(0)} / $${totalD.toFixed(0)}（剩 $${remD.toFixed(0)}）`,
        })
      } else if (quota !== undefined) {
        items.push({ label: '额度余额', display: `$${(quota / 500000).toFixed(2)}` })
      }
      const group = str(direct.group)
      if (group) items.push({ label: '分组', display: group })
      const bal = moneyItem(value, '钱包余额', ['wallet_balance', 'balance'])
      if (bal) items.push(bal)
    }
    if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(results).slice(0, 200) })
    return items
  },
}

// ── SupaWriter ───────────────────────────────────────────────────────────────

const supawriter: McpAdapter = {
  id: 'supawriter',
  label: 'SupaWriter',
  calls: [{ name: 'mcp__supawriter__sw_status', args: {} }],
  parse(results) {
    const items: QuotaItem[] = []
    for (const { value } of results) {
      const direct = value as Record<string, unknown>
      if (direct.loggedIn === false) {
        items.push({ label: '登录态', display: '未登录' })
        continue
      }
      const dashboard = (direct.dashboard ?? {}) as Record<string, unknown>
      // `/subscription/quota` is the authoritative monthly figure the site's
      // workbench shows; `/dashboard`'s own quota_used/quota_total is legacy.
      const quota = (direct.quota ?? {}) as Record<string, unknown>
      const used = num(quota.plan_used ?? dashboard.quota_used ?? dashboard.monthly_articles)
      const total = num(quota.plan_quota ?? dashboard.quota_total)
      if (total !== undefined) {
        items.push({
          label: '月度文章额度',
          used,
          limit: total,
          remaining: used !== undefined ? total - used : undefined,
          percent: pct(used, total),
        })
      }
      const user = (direct.user ?? {}) as Record<string, unknown>
      const tier = str(user.membership_tier ?? direct.membershipTier ?? direct.tier)
      if (tier) items.push({ label: '会员', display: tier })
      const pack = num(dashboard.packRemaining ?? dashboard.pack_remaining)
      if (pack !== undefined) items.push({ label: '加购包剩余', display: String(pack) })
    }
    if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(results).slice(0, 200) })
    return items
  },
}

/** Every MCP-backed adapter, tried in panel order. */
export const MCP_ADAPTERS: McpAdapter[] = [bigmodel, qianwen, scnet, tokenrouter, supawriter]

/**
 * Generic projection for user-declared platforms: quota-shaped rows first
 * (anything with remaining/limit or used/limit), then a balance-like number,
 * else the raw JSON snippet. Enough for most `mcp__*__*quota*` tools without
 * a hand-written parser.
 */
export function genericParse(results: Array<{ name: string; value: unknown }>): QuotaItem[] {
  const items: QuotaItem[] = []
  for (const { value } of results) {
    const rows = quotaRows(value)
    if (rows.length > 0) {
      for (const r of rows.slice(0, 4)) items.push(rowItem(r, '配额'))
      continue
    }
    const bal = moneyItem(value, '余额/额度', [
      'balance', 'availableAmount', 'availableBalance', 'available_balance',
      'total_balance', 'remaining', 'remainingQuota', 'quota',
    ])
    if (bal) items.push(bal)
  }
  if (items.length === 0) items.push({ label: '原始返回', display: JSON.stringify(results).slice(0, 200) })
  return items
}

/** Build an MCP adapter from a user-declared platform (composition config). */
export function customAdapter(platform: { id: string; label: string; tools: string[] }): McpAdapter {
  return {
    id: platform.id,
    label: platform.label,
    calls: platform.tools.map((name) => ({ name })),
    parse: genericParse,
  }
}

/**
 * Run one adapter's tool calls through ctx.tools and parse the results.
 * @param tools - the host tool runtime.
 * @param adapter - the platform adapter.
 * @returns the provider snapshot; status distinguishes missing tools.
 */
export async function runMcpAdapter(tools: ToolRuntime, adapter: McpAdapter): Promise<ProviderSnapshot> {
  const results: Array<{ name: string; value: unknown }> = []
  let firstError: string | undefined
  let unknownCount = 0

  for (const call of adapter.calls) {
    try {
      const outcome = await callTool(tools as LooseToolRuntime, call.name, call.args ?? {}, AbortSignal.timeout(20000))
      if (outcome.isError) {
        const message = outcome.message ?? 'error'
        if (/not found|unknown tool|no tool|unregistered/i.test(message)) {
          unknownCount++
          continue // 单个工具不存在只跳过（旧版 MCP 少工具时其余工具仍可用）
        }
        if (!firstError) firstError = message
        continue
      }
      results.push({ name: call.name, value: unwrap(outcome.value) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found|unknown tool|no tool|unregistered/i.test(message)) {
        unknownCount++
        continue
      }
      if (!firstError) firstError = message
    }
  }

  // 所有工具都不存在 = MCP 服务器没注册（行隐藏）；部分不存在则静默降级。
  if (unknownCount === adapter.calls.length && results.length === 0) {
    return {
      id: adapter.id,
      label: adapter.label,
      status: 'missing-mcp',
      message: '未注册对应 MCP 服务器（mcp__* 工具不可用）',
      via: 'mcp',
      items: [],
    }
  }
  if (results.length === 0) {
    return {
      id: adapter.id,
      label: adapter.label,
      status: 'error',
      message: firstError ?? '无可用查询结果',
      via: 'mcp',
      items: [],
    }
  }
  return {
    id: adapter.id,
    label: adapter.label,
    status: 'ok',
    via: 'mcp',
    items: adapter.parse(results),
  }
}
