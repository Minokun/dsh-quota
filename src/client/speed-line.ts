/**
 * 卡片上的测速读数：把 Host 采到的 {模型 → 统计} 排他认领到唯一归属的平台卡片。
 *
 * 与悬浮球摘要的 `providerRowOf` 不同，测速绝不跨子卡或跨账号兜底：三段式
 * Magpie 模型（`<magpieProvider>/<owner>/<model>`）只认领 `magpie#<owner>`，同平台多账号
 * 按真实 `providerKeyRefs` 严格隔离，未实际调用过的卡片保持空白。
 *
 * 显示口径（面板上只出现这三档，别的都是噪音）：
 *   - `stream`  ：有可测样本 → 报 **总吞吐**（Σtoken/Σ解码）为主数字，
 *                 次要行给「典型 / TTFT / 体感」；
 *   - `batched` ：只有批式样本 → 明确写「批式投递·不可测」，绝不印一个数字；
 *   - `none`    ：还没有样本 → 不占位置（卡片上什么都不出现）。
 *
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/speed-line
 */

import type { PanelProvider } from './controller.ts'
import { DEEPSEEK_ACCOUNT_REF, MAGPIE_PLATFORM_ID, platformForProvider } from './platform-map.ts'
import type { ModelSpeedSummary } from '../speed-sampler.ts'

/** 卡片上的一行读数（已格式化好，渲染层只管排版）。 */
export interface CardSpeedView {
  model: string
  kind: 'stream' | 'batched'
  /** 主数字：总吞吐（tok/s），只有 stream 档有。 */
  headline?: number
  /** 次要读数：典型值 / TTFT（毫秒）/ 体感值。 */
  typical?: number
  ttftMs?: number
  bodyTps?: number
  /** 样本数与被丢弃数。 */
  n: number
  skipped: number
  /** 批式档的字符/秒（解释「上游一次吐完」）。 */
  charsPerSecond?: number
}

/**
 * 为一条模型测速记录寻找它唯一归属的面板卡片。
 *
 * 与悬浮球摘要的 `providerRowOf` 不同，测速是「该上游/该账号实测出来的物理吞吐」，
 * 绝不能跨子卡或跨账号兜底——没配额度卡或没用过的账号必须保持空白，绝不借用兄弟卡读数：
 *
 * 1. Host 采集的 `model` 形如 `<dshProvider>/<innerModel>`（如
 *    `magpie-anthropic/agy-cli/gemini-4-carbon`、`deepseek-account/deepseek-flash`、
 *    `opendesign/deepseek-v4.1-flash`）：按首个 `/` 拆出 `dshProvider` 与 `innerModel`。
 * 2. 若 `dshProvider` 属于 Magpie 本机网关（`magpie` / `magpie-anthropic` / `magpie-responses`）：
 *    取 `innerModel` 的 `<owner>/` 前缀，**只匹配** `magpie#<owner>`（或 `/user` 多号变体），
 *    绝不退回其它 `magpie#*` 卡片。
 * 3. 兼容不带网关前缀的简写 `<magpieOwner>/<model>`（首段非独立供应商且命中 `magpie#<head>`）。
 * 4. 独立供应商：先按 `providerKeyRefs[dshProvider]` 精确对应卡片 `keyRef`（同平台多账号隔离），
 *    次选 `probe#<dshProvider>`，最后回退平台映射（兼容 OpenDesign / 火山方舟推理 key 与控制面 key
 *    不同名），但排除登录态合成 ref 及已被其它 DSH 路由声明占用的 `keyRef`。
 */
export function ownerCardOfModel(
  providers: readonly PanelProvider[],
  model: string,
  providerKeyRefs: Record<string, string> = {},
): PanelProvider | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash >= model.length - 1) return undefined
  const head = model.slice(0, slash)
  const tail = model.slice(slash + 1)
  const headLower = head.trim().toLowerCase()
  const platformId = platformForProvider(head)

  // 1) Magpie 网关路由：`<magpieProvider>/<owner>/<upstreamModel>` —— 严格按 `<owner>` 认领。
  if (platformId === MAGPIE_PLATFORM_ID) {
    const innerSlash = tail.indexOf('/')
    if (innerSlash <= 0) return undefined
    const owner = tail.slice(0, innerSlash).trim().toLowerCase()
    if (!owner) return undefined
    return providers.find(
      (p) => p.id === `${MAGPIE_PLATFORM_ID}#${owner}` || p.id.startsWith(`${MAGPIE_PLATFORM_ID}#${owner}/`),
    )
  }

  // 2) 简写兼容：`<magpieOwner>/<upstreamModel>`（不带 `magpie-*/` 前缀）。
  if (
    !providerKeyRefs[head]
    && !providers.some((p) => p.id === headLower || p.id === `probe#${head}`)
  ) {
    const magpieShorthand = providers.find(
      (p) => p.id === `${MAGPIE_PLATFORM_ID}#${headLower}` || p.id.startsWith(`${MAGPIE_PLATFORM_ID}#${headLower}/`),
    )
    if (magpieShorthand) return magpieShorthand
  }

  // 3) DeepSeek 登录态账号路由永远只对应账号钱包卡，绝不串到 API Key 卡。
  if (headLower === 'deepseek-account') {
    return providers.find((p) => p.keyRef === DEEPSEEK_ACCOUNT_REF)
  }

  // 4) 独立供应商：优先按 DSH `providerKeyRefs`（apiKeyEnv）精确认领。
  const ref = providerKeyRefs[head]
  if (ref) {
    const byRef = providers.find((p) => p.keyRef === ref)
    if (byRef) return byRef
  }

  // 5) 探活兜底卡：`probe#<dshProvider>`。
  const byProbe = providers.find((p) => p.id === `probe#${head}`)
  if (byProbe) return byProbe

  // 6) 平台映射回退（如 OpenDesign / 火山方舟控制面 keyRef 与推理 keyRef 不同），
  //    但绝不侵占登录态账号卡或已被其它 DSH 路由绑定的兄弟卡。
  if (!platformId) return undefined
  const otherRefs = new Set(
    Object.entries(providerKeyRefs)
      .filter(([id]) => id !== head)
      .map(([, r]) => r),
  )
  return providers.find((p) =>
    (p.id === platformId || p.id.startsWith(`${platformId}#`))
    && p.keyRef !== DEEPSEEK_ACCOUNT_REF
    && (p.keyRef === undefined || p.keyRef === ref || !otherRefs.has(p.keyRef)),
  )
}

/**
 * 一次性为整块面板的全部卡片分配测速视图：每条模型测速记录最多归属一张卡片，
 * 杜绝多卡争抢同一模型读数。
 */
export function cardSpeedsOf(
  providers: readonly PanelProvider[],
  summaries: readonly ModelSpeedSummary[],
  providerKeyRefs: Record<string, string> = {},
  currentModel?: string,
): Record<string, CardSpeedView | undefined> {
  const out: Record<string, CardSpeedView | undefined> = {}
  if (providers.length === 0 || summaries.length === 0) return out

  const byCard = new Map<string, ModelSpeedSummary[]>()
  for (const s of summaries) {
    if (s.kind === 'none') continue
    const owner = ownerCardOfModel(providers, s.model, providerKeyRefs)
    if (!owner) continue
    let list = byCard.get(owner.id)
    if (!list) {
      list = []
      byCard.set(owner.id, list)
    }
    list.push(s)
  }

  for (const [cardId, candidates] of byCard) {
    const exact = currentModel ? candidates.find((s) => s.model === currentModel) : undefined
    if (exact) {
      out[cardId] = viewOf(exact)
      continue
    }
    const sorted = [...candidates].sort((a, b) =>
      (b.n > 0 ? 1 : 0) - (a.n > 0 ? 1 : 0)
      || b.n - a.n
      || b.skipped - a.skipped,
    )
    if (sorted[0]) out[cardId] = viewOf(sorted[0])
  }
  return out
}

/**
 * 为单张卡片挑出它该显示的读数（全量面板渲染请优先用 {@link cardSpeedsOf}）。
 *
 * @param provider - 目标面板卡片。
 * @param summaries - Host 下发的逐模型结论。
 * @param providerKeyRefs - DSH 供应商 id → `apiKeyEnv` 的映射（`state.providerKeyRefs`）。
 * @param currentModel - 当前会话/默认模型（`<provider>/<model>`），优先认领它。
 * @param allProviders - 面板全部卡片（用于多卡排他归属；缺省仅含 `provider` 自身）。
 * @returns 卡片读数；没有样本时 undefined（卡片不渲染该行）。
 */
export function cardSpeedOf(
  provider: PanelProvider,
  summaries: readonly ModelSpeedSummary[],
  providerKeyRefs: Record<string, string> = {},
  currentModel?: string,
  allProviders: readonly PanelProvider[] = [provider],
): CardSpeedView | undefined {
  return cardSpeedsOf(allProviders, summaries, providerKeyRefs, currentModel)[provider.id]
}

/** 结论 → 渲染用视图。 */
function viewOf(s: ModelSpeedSummary): CardSpeedView {
  if (s.kind === 'batched') {
    return { model: s.model, kind: 'batched', n: 0, skipped: s.skipped }
  }
  return {
    model: s.model,
    kind: 'stream',
    ...(s.tpsAggregate === undefined ? {} : { headline: round1(s.tpsAggregate) }),
    ...(s.tpsTypical === undefined ? {} : { typical: round1(s.tpsTypical) }),
    ...(s.ttftMedianMs === undefined ? {} : { ttftMs: Math.round(s.ttftMedianMs) }),
    ...(s.bodyTpsMedian === undefined ? {} : { bodyTps: round1(s.bodyTpsMedian) }),
    n: s.n,
    skipped: s.skipped,
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/**
 * 主数字的速度档位（给主数字上色用）：正常/偏慢/极慢。
 * 阈值取自本机实测分布（真实的流式速度多落在 60~400 tok/s；>1000 基本意味着
 * 分母又被批式上游吃掉了）。
 * @param tps - 总吞吐。
 * @returns 'fast' | 'mid' | 'slow'。
 */
export function speedTone(tps: number | undefined): 'fast' | 'mid' | 'slow' | undefined {
  if (tps === undefined || !Number.isFinite(tps)) return undefined
  if (tps >= 200) return 'fast'
  if (tps >= 80) return 'mid'
  return 'slow'
}
