/**
 * 面板平台卡片的排序规则，两层依次生效（不再把当前在用模型自动顶到最前）：
 *
 * 1. 用户拖拽自定义顺序（`providerOrder`，按卡片精确 `id` 记录；向后兼容旧版
 *    平台组 key）——命中的卡片按自定义顺序排；未记录的新卡片按默认顺序追加在末尾；
 *    暂时隐藏的旧卡片保留在 `providerOrder` 里，恢复后自动回到原位。
 * 2. 默认顺序严格对齐 DSH 模型选择框（`orderModelProviders` 口径）：
 *    `deepseek-account` 第一 → `deepseek-official` 第二 → 其余按模型目录里
 *    供应商出现的顺序；本机 Magpie 网关的多张子卡（`magpie#<owner>`）按网关组内
 *    模型首次出现的 owner 顺序排列；不在模型列表里的纯额度卡排在最后。
 *
 * 当前在用卡片不再跳位，仅由 {@link providerRowOf} 识别后在原位置展示「在用」标记。
 *
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/panel-order
 */

import type { ModelCatalogGroupLike, PanelProvider } from './controller.ts'
import { MAGPIE_PLATFORM_ID, platformForProvider } from './platform-map.ts'

/**
 * 平台组 key：剥掉 `probe#` 前缀与凭证/线路后缀（本机 Magpie 保留 `magpie#<provider>`，
 * 仅剥 `/<user>`）。用于向后兼容旧版按组落盘的 `providerOrder` 以及默认平台级归属匹配。
 */
export function orderKey(id: string): string {
  const bare = id.startsWith('probe#') ? id.slice('probe#'.length) : id
  if (bare.startsWith(`${MAGPIE_PLATFORM_ID}#`)) {
    const slash = bare.indexOf('/', MAGPIE_PLATFORM_ID.length + 1)
    return slash === -1 ? bare : bare.slice(0, slash)
  }
  const hash = bare.indexOf('#')
  return hash === -1 ? bare : bare.slice(0, hash)
}

/**
 * DSH 模型供应商 id → 面板行：先按 Magpie 模型前缀认领，再按 apiKeyEnv 精确对应
 * （同平台多号也准），最后退回平台 id 匹配。供悬浮球摘要与原位「在用」高亮共用。
 */
export function providerRowOf(
  providers: readonly PanelProvider[],
  provider: string | undefined,
  providerKeyRefs: Record<string, string>,
  model?: string,
): PanelProvider | undefined {
  if (!provider) return undefined
  const platformId = platformForProvider(provider)
  if (platformId === MAGPIE_PLATFORM_ID) {
    const owner = model?.split('/')[0]?.trim().toLowerCase()
    if (owner) {
      const hit = providers.find((p) => p.id === `${MAGPIE_PLATFORM_ID}#${owner}` || p.id.startsWith(`${MAGPIE_PLATFORM_ID}#${owner}/`))
      if (hit) return hit
    }
  }
  const ref = providerKeyRefs[provider]
  const byRef = ref ? providers.find((p) => p.keyRef === ref) : undefined
  if (byRef) return byRef
  if (!platformId) return undefined
  return providers.find((p) => p.id === platformId || p.id.startsWith(`${platformId}#`))
}

/**
 * 按 DSH 模型选择框顺序排列默认卡片顺序：
 * `deepseek-account` (0) → `deepseek-official` (1) → 其余目录分组保序；
 * Magpie 网关组内按 `models` 首次出现的 `<owner>/` 前缀细分各子卡次序；
 * `catalogGroups` 尚未加载时保持 Host 下发的基线顺序（Host 已按同口径排好）。
 */
export function defaultOrderProviders(
  providers: readonly PanelProvider[],
  catalogGroups: readonly ModelCatalogGroupLike[] = [],
  providerKeyRefs: Record<string, string> = {},
): PanelProvider[] {
  if (catalogGroups.length === 0 || providers.length < 2) return [...providers]
  const tier = (id: string): number => (id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2)
  const sortedGroups = [...catalogGroups].sort((a, b) => tier(a.id) - tier(b.id))

  const refRank = new Map<string, number>()
  const idRank = new Map<string, number>()
  const platformRank = new Map<string, number>()
  const magpieOwnerRank = new Map<string, number>()
  let magpieFallbackRank: number | undefined
  let slot = 0

  for (const group of sortedGroups) {
    const platform = platformForProvider(group.id)
    if (platform === MAGPIE_PLATFORM_ID) {
      for (const m of group.models ?? []) {
        const owner = m.id.split('/')[0]?.trim().toLowerCase()
        if (owner && !magpieOwnerRank.has(owner)) {
          magpieOwnerRank.set(owner, slot++)
        }
      }
      if (magpieFallbackRank === undefined) magpieFallbackRank = slot++
      continue
    }
    const ref = providerKeyRefs[group.id]
    if (ref && !refRank.has(ref)) refRank.set(ref, slot)
    const probeId = `probe#${group.id}`
    if (!idRank.has(probeId)) idRank.set(probeId, slot)
    if (platform && !platformRank.has(platform)) platformRank.set(platform, slot)
    slot += 1
  }

  const fallback = slot
  const rankOf = (p: PanelProvider): number => {
    if (p.id.startsWith(`${MAGPIE_PLATFORM_ID}#`)) {
      const owner = p.id.slice(MAGPIE_PLATFORM_ID.length + 1).split('/')[0]?.toLowerCase() ?? ''
      return magpieOwnerRank.get(owner) ?? magpieFallbackRank ?? fallback
    }
    if (p.keyRef !== undefined) {
      const byRef = refRank.get(p.keyRef)
      if (byRef !== undefined) return byRef
    }
    const byId = idRank.get(p.id)
    if (byId !== undefined) return byId
    const base = p.id.startsWith('probe#') ? p.id : orderKey(p.id)
    return platformRank.get(base) ?? fallback
  }

  return providers
    .map((provider, index) => ({ provider, index, rank: rankOf(provider) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.provider)
}

/**
 * 最终面板卡片排序：先算 DSH 模型默认顺序，再叠加用户自定义拖拽顺序。
 * 切换当前会话模型不会改变卡片位置。
 */
export function orderProviders(
  providers: readonly PanelProvider[],
  customOrder: readonly string[] = [],
  catalogGroups: readonly ModelCatalogGroupLike[] = [],
  providerKeyRefs: Record<string, string> = {},
): PanelProvider[] {
  const baseline = defaultOrderProviders(providers, catalogGroups, providerKeyRefs)
  return byCustomOrder(baseline, customOrder)
}

/**
 * 按自定义顺序重排：优先匹配精确卡片 `id`（逐卡独立排序），未命中时回退匹配
 * 旧版 `orderKey(id)` 组名（平滑兼容历史配置），仍未命中的新卡片保持默认相对顺序追加在末尾。
 */
function byCustomOrder(providers: readonly PanelProvider[], customOrder: readonly string[]): PanelProvider[] {
  if (customOrder.length === 0) return [...providers]
  const rank = new Map<string, number>()
  customOrder.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index)
  })
  const fallback = customOrder.length
  return providers
    .map((provider, index) => ({
      provider,
      index,
      rank: rank.get(provider.id) ?? rank.get(orderKey(provider.id)) ?? fallback,
    }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.provider)
}

/**
 * 拖拽重排的纯数组移位：把 `fromIndex` 处的元素移到 `toIndex`（越界或原位时返回原副本）。
 */
export function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items]
  if (
    fromIndex < 0
    || fromIndex >= next.length
    || toIndex < 0
    || toIndex >= next.length
    || fromIndex === toIndex
  ) {
    return next
  }
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved!)
  return next
}
