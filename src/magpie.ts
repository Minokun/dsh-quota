/**
 * Magpie 网关额度适配器。
 *
 * Magpie 是本机的 AI 网关（托盘程序，默认监听 127.0.0.1:3425），把用户所有
 * 的订阅、Coding Plan 与余额账号收在自己后面，统一成 OpenAI / Anthropic
 * 兼容接口。它自带一套只读额度接口，其中 `GET /v1/magpie/quotas` 一个请求
 * 就返回全部账号的额度卡片（回环口免鉴权，网关自己做了 30s 去重读取）。
 *
 * 为什么不做成 DirectAdapter：那套契约是「一个 Bearer key、一次 GET、一个
 * 平台一行」；而这里**一次 GET 出多行**（本机接了几个账号就有几行），并且
 * 端点是 http://127.0.0.1，走「自定义 HTTP 平台」会被 assertPublicHttpsUrl
 * 的 https + 内网校验直接拒掉。所以本模块与 subscription.ts / ark.ts 同类：
 * 自动发现的多行适配器，没有 magpie 就整行隐藏。
 *
 * 行的身份约定（与 platform-map 配套）：id 形如 `magpie#<provider>`，同一
 * provider 多账号时 `magpie#<provider>/<user>`；这样
 *   - `matchedRow()` 认得出「该供应商已有额度行」，不再补一条「在线」探活行；
 *   - `providerRowOf()` 靠 `magpie#` 前缀就能认领「当前在用」的卡片置顶。
 * @module dsh-quota/magpie
 */

import type { ProviderSnapshot, QuotaItem } from './config.ts'
import { MAGPIE_PLATFORM_ID } from './platform-map.ts'

export { MAGPIE_PLATFORM_ID }

/** 面板行名（多行共用前缀，账号区分靠后面的 provider 名）。 */
export const MAGPIE_LABEL = 'Magpie'

/** 默认网关地址；`MAGPIE_URL` 覆盖（自定义端口 / 远端只读网关）。 */
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425'

/** 额度接口路径（GET，回环口免鉴权）。 */
export const MAGPIE_QUOTAS_PATH = '/v1/magpie/quotas'

/** 用量接口路径（GET，按供应商/模型记账，纯 API-key 供应商只在这里有数据）。 */
export const MAGPIE_USAGE_PATH = '/v1/magpie/usage'

/** 查询超时：本地回环口，慢到这个份上就是没起来。 */
const MAGPIE_TIMEOUT_MS = 8000

/** 结果 TTL：失败看门狗 30s~4min 补刷，网关自己也有 30s 去重，别叠加打。 */
const MAGPIE_TTL_MS = 60_000

// ── 纯工具 ───────────────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function pct(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined
  return Number(((used / limit) * 100).toFixed(1))
}

/** 网关地址：`MAGPIE_URL` 优先，末尾斜杠去掉。 */
export function magpieBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MAGPIE_URL?.trim() || DEFAULT_MAGPIE_URL).replace(/\/+$/, '')
}

/**
 * 窗口名 → 面板标签。网关原生写英文（`5 hours` / `7 days` / `MCP · Month`
 * / `Extra usage`），这里换成与其它平台一致的叫法——顺带让
 * `summarize()` 的 `/窗口|周|余额|额度|金额|消耗/` 命中，pill 才有一条摘要。
 * @param name - 网关给的窗口名（可能缺失）。
 * @returns 中文标签；认不出的原样返回（宁可显示原名也别吞掉）。
 */
export function magpieWindowLabel(name: string | undefined): string {
  if (!name) return '额度'
  const hours = name.match(/(\d+)\s*hours?/i)
  if (hours?.[1]) return `${hours[1]} 小时窗口`
  const days = name.match(/(\d+)\s*days?/i)
  if (days?.[1]) return `${days[1]} 天窗口`
  const weeks = name.match(/(\d+)\s*weeks?/i)
  if (weeks?.[1]) return `${weeks[1]} 周窗口`
  if (/mcp/i.test(name) && /month/i.test(name)) return 'MCP 月度额度'
  if (/extra\s*usage/i.test(name)) return '额外额度'
  return name
}

/** 货币单位 → 符号（认不出就保留单位本身）。 */
function moneySymbol(unit: string | undefined): string {
  if (unit === 'CNY') return '¥'
  if (unit === 'USD') return '$'
  return unit ? `${unit} ` : ''
}

/**
 * 一条额度窗口 → 一条面板条目。
 *
 * 形状很杂，三条道按顺序判：
 *  1. **余额道**：窗口带 `unit` + `balance`（如 Kimi 的 `Extra usage`，
 *     `unit: CNY, balance: 0`）→ 显示金额，不再画进度条；
 *  2. **计数道**：带 `display` 且有 `limit`（如 `MCP · Month` 的
 *     `0 / 1000` + `limit: 1000`）→ `display` 是权威读数，`used` 在这里
 *     仍是百分比，只拿来画条；
 *  3. **百分比道**：`used` 就是「已用 %」（与 `remaining` 互补为 100）。
 *     这条必须用 `已用 N%` 的文案——写成 `percent` 后面板自己会画条，
 *     而 `summarize()` 会反算成「剩 100-N%」，与 `remaining` 重复。
 * @param w - 网关的一张窗口。
 * @returns 面板条目，永远是同一形状，调用方无需再分支。
 */
export function magpieWindowItem(w: Record<string, unknown>): QuotaItem {
  const label = magpieWindowLabel(str(w.name))
  const resetAt = str(w.resetsAt)

  const unit = str(w.unit)
  const balance = num(w.balance)
  if (unit !== undefined && balance !== undefined) {
    return { label, display: `${moneySymbol(unit)}${balance}`, remaining: balance, ...(resetAt ? { resetAt } : {}) }
  }

  const usedPercent = num(w.used)
  const remainingPercent = num(w.remaining)
  const limit = num(w.limit)
  const display = str(w.display)
  if (limit !== undefined && display !== undefined) {
    return {
      label,
      ...(usedPercent === undefined ? {} : { percent: usedPercent }),
      display,
      ...(resetAt ? { resetAt } : {}),
    }
  }

  const percent = usedPercent ?? (remainingPercent !== undefined ? Number((100 - remainingPercent).toFixed(2)) : undefined)
  return {
    label,
    ...(percent === undefined ? {} : { percent }),
    ...(percent === undefined ? {} : { display: `已用 ${percent}%` }),
    ...(resetAt ? { resetAt } : {}),
  }
}

/** 一行卡片的灰色注释：账号、有效期、续费状态。 */
function magpieNote(cards: Array<Record<string, unknown>>): string | undefined {
  const parts: string[] = []
  const user = cards.map((c) => str(c.user)).find(Boolean)
  if (user) parts.push(`账号 ${user}`)
  const until = cards.map((c) => str(c.until)).find(Boolean)
  if (until) {
    // 只留日期：ISO 时间戳整段塞进注释会把行挤满。
    const day = until.slice(0, 10)
    parts.push(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `有效期至 ${day}` : `有效期至 ${until}`)
  }
  if (cards.some((c) => str(c.renew) === 'off')) parts.push('不自动续费')
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** 一个 provider 名 + 可选的账号后缀 → 行 id。 */
function rowId(provider: string, user?: string): string {
  const slug = user?.trim().toLowerCase().replace(/[^a-z0-9@._-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `${MAGPIE_PLATFORM_ID}#${provider}/${slug}` : `${MAGPIE_PLATFORM_ID}#${provider}`
}

/**
 * 把 `/v1/magpie/quotas` 的 `data[]` 翻译成面板行。
 *
 * 分组规则：一个 provider 一行；同一 provider 出现多个 `user`（挂了两个
 * Claude 号之类）时按账号拆成多行。`kind: 'balance'` 的卡片不自成一行——
 * 它只是同一账号的余额（智谱会同时给 plan 卡和 balance 卡）。没有任何窗口
 * 也没有余额的卡片直接丢掉（Gemini 未登录时就是 `windows: []` 的空卡）。
 * @param body - 接口原始 JSON。
 * @returns 面板行（可能为空数组：网关在线但一个账号都没接）。
 */
export function parseMagpieQuotas(body: unknown): ProviderSnapshot[] {
  const data = (obj(body)?.data)
  if (!Array.isArray(data)) throw new Error('magpie: 响应缺少 data[] 数组')

  /** provider → 该 provider 的所有卡片，保持网关给的顺序。 */
  const byProvider = new Map<string, Array<Record<string, unknown>>>()
  for (const raw of data) {
    const card = obj(raw)
    if (!card) continue
    const provider = str(card.provider)
    if (!provider) continue
    const list = byProvider.get(provider)
    if (list) list.push(card)
    else byProvider.set(provider, [card])
  }

  const rows: ProviderSnapshot[] = []
  for (const [provider, cards] of byProvider) {
    const name = cards.map((c) => str(c.name)).find(Boolean) ?? provider
    const plan = cards.map((c) => str(c.plan)).find(Boolean)
    const label = plan ? `${MAGPIE_LABEL} · ${name} · ${plan}` : `${MAGPIE_LABEL} · ${name}`

    const windowCards = cards.filter((c) => Array.isArray(c.windows) && c.windows.length > 0 && str(c.kind) !== 'balance')
    const balanceCards = cards.filter((c) => str(c.kind) === 'balance')
    const balanceItems: QuotaItem[] = []
    for (const c of balanceCards) {
      const amount = str(c.balance)
      if (amount !== undefined) balanceItems.push({ label: '账户余额', display: amount })
    }

    // 没窗口也没余额：空卡（未登录 / 已关闭），不占面板。
    if (windowCards.length === 0) {
      if (balanceItems.length === 0) continue
      const message = magpieNote(cards)
      rows.push({
        id: rowId(provider),
        label,
        status: 'ok',
        via: 'api',
        ...(message ? { message } : {}),
        items: balanceItems,
      })
      continue
    }

    // 只有同一 provider 挂了多个账号才按账号拆行；单账号行不带 user 后缀，
    // 这样 id 不会随账号邮箱变化而漂移（id 一漂，面板历史与置顶就断了）。
    const users = [...new Set(windowCards.map((c) => str(c.user)).filter((u): u is string => Boolean(u)))]
    const splitByUser = users.length > 1
    const groups = splitByUser
      ? users.map((u) => ({ user: u, cards: windowCards.filter((c) => str(c.user) === u) }))
      : [{ user: undefined, cards: windowCards }]

    for (const [index, group] of groups.entries()) {
      const items: QuotaItem[] = []
      for (const card of group.cards) {
        for (const w of card.windows as unknown[]) {
          const win = obj(w)
          if (win) items.push(magpieWindowItem(win))
        }
      }
      // 余额卡没有 user，只在单账号行（或多账号的第一行）上挂一次。
      if (index === 0) items.push(...balanceItems)
      if (items.length === 0) continue
      const message = magpieNote([...group.cards, ...(index === 0 ? balanceCards : [])])
      rows.push({
        id: rowId(provider, group.user),
        label,
        status: 'ok',
        via: 'api',
        ...(message ? { message } : {}),
        items,
      })
    }
  }
  return rows
}

/**
 * 按模型 id 挑出该模型所属 account 的行（`codex/gpt-5.6-terra` → `magpie#codex`）。
 *
 * 为什么需要：magpie 的所有行共用同一个凭证引用（`MAGPIE_GATEWAY_KEY`），
 * 面板「当前在用」按 apiKeyEnv 精确定位到的是一个多行共用的 ref，只会随便
 * 命中本机的第一行。模型 id 自带 provider 前缀，用它认领才准。
 * @param rows - 面板行。
 * @param model - 当前模型 id（`<provider>/<model>`）。
 * @returns 命中的行，没有则 undefined。
 */
export function magpieRowForModel(rows: readonly ProviderSnapshot[], model: string): ProviderSnapshot | undefined {
  const provider = model.split('/')[0]?.trim().toLowerCase()
  if (!provider) return undefined
  return rows.find((r) => r.id === `${MAGPIE_PLATFORM_ID}#${provider}` || r.id.startsWith(`${MAGPIE_PLATFORM_ID}#${provider}/`))
}

// ── 用量记账（纯 API-key 供应商只有这一份数据） ───────────────────────────────

/** 用量查询窗口：与面板其它平台的「近 30 天」口径一致。 */
const MAGPIE_USAGE_PERIOD = '30d'

/** 一行用量记账：供应商 id → 调用次数与花费（USD）。 */
export interface MagpieSpend {
  provider: string
  calls: number
  cost: number
}

/**
 * 从 `/v1/magpie/usage` 的响应里按供应商汇总花费。
 *
 * 为什么需要：magpie 只对**订阅 / 套餐 / 余额**账号出额度卡，纯 API-key
 * 供应商（sidrune 这类）在 `/v1/magpie/quotas` 里根本没有卡片——可它恰恰
 * 是花钱的那个。用量接口按 `provider` 记账，是这类账号唯一可显示的信息。
 * @param body - 接口原始 JSON。
 * @returns 按花费降序的汇总行。
 */
export function parseMagpieSpend(body: unknown): MagpieSpend[] {
  const root = obj(body)
  if (!root) return []
  const sumInto = (buckets: Map<string, MagpieSpend>, provider: string | undefined, calls: number | undefined, cost: number | undefined): void => {
    if (!provider) return
    const key = provider.toLowerCase()
    const prev = buckets.get(key) ?? { provider, calls: 0, cost: 0 }
    buckets.set(key, { provider: prev.provider, calls: prev.calls + (calls ?? 0), cost: prev.cost + (cost ?? 0) })
  }

  // models[] 是每家的真实明细（订阅账号也在这里），providerKeys[] 只列带
  // key 的供应商且口径更准（含开销）。所以以 models 累加打底，再用
  // providerKeys 覆盖同一供应商——只靠任一单边都会漏行：只用 providerKeys
  // 会丢掉 codex 这类订阅账号，只用 models 会丢掉 key 侧的记账差异。
  const fromModels = new Map<string, MagpieSpend>()
  if (Array.isArray(root.models)) {
    for (const raw of root.models) {
      const row = obj(raw)
      if (row) sumInto(fromModels, str(row.provider), num(row.calls), num(row.cost))
    }
  }
  const authoritative = new Map<string, MagpieSpend>()
  if (Array.isArray(root.providerKeys)) {
    for (const raw of root.providerKeys) {
      const row = obj(raw)
      if (row) sumInto(authoritative, str(row.provider), num(row.calls), num(row.cost))
    }
  }

  const merged = new Map<string, MagpieSpend>(fromModels)
  for (const [key, spend] of authoritative) merged.set(key, spend)
  return [...merged.values()]
    .filter((s) => s.calls > 0 || s.cost > 0)
    .sort((a, b) => b.cost - a.cost)
}

/** 花费显示：小额保留更多位，避免整天显示「$0.00」。 */
function spendDisplay(cost: number): string {
  if (cost === 0) return '$0'
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/** 一行用量记账 → 面板条目。 */
function spendItem(spend: MagpieSpend): QuotaItem {
  return {
    label: '近 30 天消耗',
    display: `${spendDisplay(spend.cost)} · ${spend.calls.toLocaleString('en-US')} 次`,
  }
}

/** 面板行 id 里取出 provider（`magpie#codex` / `magpie#claude/a@x.com`）。 */
function providerOfRowId(id: string): string | undefined {
  const rest = id.startsWith(`${MAGPIE_PLATFORM_ID}#`) ? id.slice(MAGPIE_PLATFORM_ID.length + 1) : undefined
  return rest?.split('/')[0]?.trim().toLowerCase() || undefined
}

/**
 * 把花费并进额度行：同供应商的额度行追加一条「近 30 天消耗」；只用过、
 * 但没有额度卡的供应商（纯 API-key）单独成行——否则它在面板上完全不可见。
 * @param rows - 额度行（原地追加条目）。
 * @param spends - 按供应商汇总的花费。
 * @returns 合并后的行（新数组，额度行对象被就地补条目）。
 */
export function mergeMagpieSpend(rows: ProviderSnapshot[], spends: readonly MagpieSpend[]): ProviderSnapshot[] {
  const covered = new Set<string>()
  for (const row of rows) {
    const provider = providerOfRowId(row.id)
    if (!provider) continue
    const spend = spends.find((s) => s.provider.toLowerCase() === provider)
    if (!spend) continue
    covered.add(provider)
    row.items.push(spendItem(spend))
  }
  const extra: ProviderSnapshot[] = []
  for (const spend of spends) {
    const provider = spend.provider.toLowerCase()
    if (covered.has(provider)) continue
    extra.push({
      id: `${MAGPIE_PLATFORM_ID}#${provider}`,
      label: `${MAGPIE_LABEL} · ${spend.provider}`,
      status: 'ok',
      via: 'api',
      message: '按量计费的 API key 账号：无额度窗口，只有用量记账',
      items: [spendItem(spend)],
    })
  }
  return [...rows, ...extra]
}

// ── 与内置订阅行的去重 ───────────────────────────────────────────────────────

/**
 * 内置订阅行（subscription.ts）id → magpie 侧对应的 provider id。
 *
 * 两边读的是同一份登录态：`~/.codex/auth.json` 既被 subscription.ts 直连
 * `chatgpt.com` 使用，也被 magpie 收进自己的账号池。magpie 带代理、带账号
 * 轮换与 token 续期，直连那条在需要代理的网络里只会红一片，所以 magpie 有
 * 该账号的额度行时，内置行让位。
 */
const SUBSCRIPTION_TO_MAGPIE_PROVIDER: Record<string, string> = {
  codex: 'codex',
  'claude-code': 'claude',
}

/**
 * 去掉与 magpie 行重复的内置订阅行。
 *
 * 只在 magpie 那行**查到了额度**时才丢：magpie 没运行 / 没接该账号 / 该行
 * 失败时，内置订阅行仍是唯一来源，必须留着。这样「装了 magpie」不会让
 * 面板凭空少一张卡，只是把重复且更脆的那张换掉。
 * @param subscriptionRows - subscription.ts 产出的行。
 * @param magpieRows - magpie.ts 产出的行。
 * @returns 过滤后的订阅行。
 */
export function dropDuplicateSubscriptionRows(
  subscriptionRows: readonly ProviderSnapshot[],
  magpieRows: readonly ProviderSnapshot[],
): ProviderSnapshot[] {
  const replaced = new Set<string>()
  for (const row of magpieRows) {
    if (row.status !== 'ok' || row.items.length === 0) continue
    const provider = providerOfRowId(row.id)
    if (provider) replaced.add(provider)
  }
  return subscriptionRows.filter((row) => {
    const provider = SUBSCRIPTION_TO_MAGPIE_PROVIDER[row.id]
    // 只替换成功过的账号；magpie 那行失败时保留内置行（它对失败原因说得更准）。
    return !(provider && replaced.has(provider))
  })
}

// ── 网络 ─────────────────────────────────────────────────────────────────────

export interface MagpieRowsDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  env?: NodeJS.ProcessEnv
  baseUrl?: string
}

/** 结果缓存（成功与失败都缓存，避免补刷把网关打爆）。 */
let cached: { at: number; rows: ProviderSnapshot[] } | undefined

/**
 * GET 一个网关端点并解析 JSON。
 * @param fetchImpl - fetch 实现（测试可注入）。
 * @param url - 完整 URL。
 * @returns 解析后的 JSON。
 */
async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(MAGPIE_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`)
  return await resp.json() as unknown
}

/**
 * 查询本机 Magpie 网关的额度行（额度卡 + 用量记账）。
 *
 * 自动发现语义：网关没运行 / 连不上 / 没有账号 → 空数组，面板整行隐藏
 * （此时 DSH 模型供应商的 `/models` 探活照旧给一条「在线」兜底）。两个请求
 * 并行发；用量失败只是少几条花费，不影响额度行。注入 fetch/now 时（测试）
 * 不读写模块级缓存。
 * @param deps - 可注入的 fetch / 时钟 / 环境变量 / 网关地址。
 * @returns 面板行。
 */
export async function fetchMagpieRows(deps: MagpieRowsDeps = {}): Promise<ProviderSnapshot[]> {
  const base = (deps.baseUrl ?? magpieBaseUrl(deps.env ?? process.env)).replace(/\/+$/, '')
  const cacheable = deps.fetchImpl === undefined && deps.now === undefined
  const now = deps.now?.() ?? Date.now()
  if (cacheable && cached !== undefined && now - cached.at < MAGPIE_TTL_MS) return cached.rows

  const fetchImpl = deps.fetchImpl ?? fetch
  const [quotas, spend] = await Promise.allSettled([
    getJson(fetchImpl, `${base}${MAGPIE_QUOTAS_PATH}`),
    getJson(fetchImpl, `${base}${MAGPIE_USAGE_PATH}?period=${MAGPIE_USAGE_PERIOD}`),
  ])

  let rows: ProviderSnapshot[] = []
  if (quotas.status === 'fulfilled') {
    try {
      rows = parseMagpieQuotas(quotas.value)
    } catch {
      rows = []
    }
    if (spend.status === 'fulfilled') rows = mergeMagpieSpend(rows, parseMagpieSpend(spend.value))
  }
  // 连不上 = 网关没开，属于常态：返回空数组（整行隐藏，交给探活兜底），
  // 不要把「magpie 没运行」渲染成一张红色错误卡。
  if (cacheable) cached = { at: now, rows }
  return rows
}

/** 清掉结果缓存（测试与「用户点了刷新」时用）。 */
export function clearMagpieCache(): void {
  cached = undefined
}
