/**
 * 本会话 token 用量的成本估算（纯客户端、纯函数，无网络请求）。
 *
 * 内置一张按模型 id 前缀匹配的价格表（每百万 token、USD、峰时价——
 * DeepSeek 官方峰/谷分时计价，谷时为峰时一半，这里按峰时估算偏保守）。
 * 价格来源（抓取于 2026-10-05）：
 *   - Models & Pricing: https://api-docs.deepseek.com/quick_start/pricing
 *   - Change Log（deepseek-chat/reasoner 别名与 v4-flash 的路由说明）:
 *     https://api-docs.deepseek.com/updates
 *
 * DeepSeek 计费只分「缓存命中 / 缓存未命中（输入）/ 输出」三档；缓存写
 * token 计入未命中输入侧计费，因此表内 cacheWrite 价 = input 价。
 * 智谱 glm / kimi 未能可靠核实官方单价，宁缺毋滥，暂不收录——匹配不到
 * 价格的模型只显示 token 计数，不显示金额。
 * @module dsh-quota/client/pricing
 */

/** 四桶用量（与 dsh tokenUsage 投影的 wire view 同形）。 */
export interface UsageBuckets {
  /** 未命中缓存的输入 token。 */
  uncachedInputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 缓存命中读 token。 */
  cacheReadTokens: number
  /** 缓存写 token。 */
  cacheWriteTokens: number
}

/** 一个模型档位的单价（每百万 token、USD）；四桶价齐全才可估金额。 */
export interface ModelPrice {
  /** 未命中缓存的输入单价。 */
  input: number
  /** 缓存命中读单价。 */
  cacheRead: number
  /** 缓存写单价（DeepSeek 按输入价计）。 */
  cacheWrite: number
  /** 输出单价。 */
  output: number
}

/** 价格表条目：模型 id 前缀 + 该前缀的单价。 */
interface PriceEntry {
  /** 模型 id 前缀（大小写不敏感）。 */
  prefix: string
  /** 该前缀模型的单价。 */
  price: ModelPrice
}

/**
 * 内置价格表。来源：DeepSeek 官方定价页（2026-10-05 抓取，峰时价）：
 * - deepseek-flash（V4.1-Flash）：cache hit $0.006 / miss $0.30 / out $1.20
 * - deepseek-v4-pro（V4-Pro-0813）：cache hit $0.022 / miss $0.66 / out $1.98
 * 别名说明（见 Change Log）：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`
 * 已改由 V4.1-Flash 提供并按 Flash 价计费；`deepseek-chat` / `deepseek-reasoner`
 * 曾分别指向 v4-flash 的非思考/思考模式（2026-07-24 停用），同样按 Flash 价估算。
 */
const PRICE_TABLE: readonly PriceEntry[] = [
  { prefix: 'deepseek-v4-pro', price: { input: 0.66, cacheRead: 0.022, cacheWrite: 0.66, output: 1.98 } },
  { prefix: 'deepseek-flash', price: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 } },
  { prefix: 'deepseek-v4-flash', price: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 } },
  { prefix: 'deepseek-v4-flash-vision-exp', price: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 } },
  { prefix: 'deepseek-chat', price: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 } },
  { prefix: 'deepseek-reasoner', price: { input: 0.30, cacheRead: 0.006, cacheWrite: 0.30, output: 1.20 } },
]

/**
 * 按模型 id 查单价：最长前缀优先匹配（如 `deepseek-v4-pro-0813` 命中
 * `deepseek-v4-pro` 而不是更短的 `deepseek-`），大小写不敏感。
 * @param modelId - 模型 id（如 `deepseek-flash`）。
 * @returns 匹配到的单价，未收录返回 undefined。
 */
export function lookupModelPrice(modelId: string): ModelPrice | undefined {
  const id = modelId.trim().toLowerCase()
  let best: PriceEntry | undefined
  for (const entry of PRICE_TABLE) {
    if (!id.startsWith(entry.prefix)) continue
    if (best === undefined || entry.prefix.length > best.prefix.length) best = entry
  }
  return best?.price
}

/**
 * 估算一次会话用量的成本（USD）。四桶分别计价后求和；只有价格表命中
 * （四桶单价齐全）才返回金额，否则 undefined（调用方只显示 token）。
 * @param modelId - 会话当前模型 id。
 * @param buckets - 四桶累计 token 数。
 * @returns `{ usd }` 估算金额，或 undefined。
 */
export function estimateSessionCost(modelId: string, buckets: UsageBuckets): { usd: number } | undefined {
  const price = lookupModelPrice(modelId)
  if (!price) return undefined
  const usd =
    (buckets.uncachedInputTokens / 1e6) * price.input
    + (buckets.cacheReadTokens / 1e6) * price.cacheRead
    + (buckets.cacheWriteTokens / 1e6) * price.cacheWrite
    + (buckets.outputTokens / 1e6) * price.output
  return { usd }
}

/**
 * token 数的 k/M 紧凑格式（如 950 / 12.3k / 1.2M）。
 * @param n - token 数。
 * @returns 紧凑字符串。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    // 两位有效时带 1 位小数（12.3k），更大取整（999k）。
    return `${k < 100 ? String(Math.round(k * 10) / 10) : String(Math.round(k))}k`
  }
  const m = n / 1_000_000
  return `${m < 100 ? String(Math.round(m * 10) / 10) : String(Math.round(m))}M`
}

/**
 * 金额显示：<$1 保留 4 位小数（如 0.0123），更大保留 2 位（如 1.81）。
 * @param usd - 金额（USD）。
 * @returns 形如 `0.0123` / `1.81` 的字符串（不含货币符，由文案拼接）。
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—'
  return usd < 1 ? usd.toFixed(4) : usd.toFixed(2)
}
