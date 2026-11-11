/**
 * 面板平台卡片的排序规则，三层依次生效：
 *
 * 1. 用户手动顺序（`providerOrder`，面板「排序」模式下 ▲▼ 调出来的）——命中的
 *    平台按它排；手动顺序里没有的新平台追加在末尾，不会打乱已有排列；
 * 2. 「当前在用」的平台置顶——但用户已经在手动顺序里给这个平台指定了位置时
 *    不再强插，否则手动排好的第一位会被换模型抢走；
 * 3. 其余保持 Host 下发的固定顺序。
 *
 * 排序只在客户端做：模型一换面板立刻重排，不需要刷新 Host 快照；手动顺序
 * 由 Host 存（POST /order），重启后仍在。
 *
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/panel-order
 */

import type { PanelProvider } from './controller.ts'
import { platformForProvider } from './platform-map.ts'

/**
 * 排序用的「平台组 key」：同一平台的多账号卡（`deepseek#DEEPSEEK_B_API_KEY`）
 * 与探活兜底卡（`probe#aihub`）都归到组上，这样多账号加进来、magpie 多线路
 * 变成 `magpie-codex#9625DEB7` 之后，用户排好的位置依然有效。
 */
export function orderKey(id: string): string {
  const bare = id.startsWith('probe#') ? id.slice('probe#'.length) : id
  const hash = bare.indexOf('#')
  return hash === -1 ? bare : bare.slice(0, hash)
}

/**
 * DSH 模型供应商 id → 面板行：先按 apiKeyEnv 精确对应（同平台多号也准），
 * 再退回平台 id 模糊匹配（`kimi` 命中 `kimi#2` 这类多行 id）。
 */
export function providerRowOf(
  providers: readonly PanelProvider[],
  provider: string | undefined,
  providerKeyRefs: Record<string, string>,
): PanelProvider | undefined {
  if (!provider) return undefined
  // apiKeyEnv 精确对应优先，且不要求 provider 能映射到内置平台——自定义平台
  // 的凭证引用同样可能就是这个 provider 的 apiKeyEnv。
  const ref = providerKeyRefs[provider]
  const byRef = ref ? providers.find((p) => p.keyRef === ref) : undefined
  if (byRef) return byRef
  const platformId = platformForProvider(provider)
  if (!platformId) return undefined
  return providers.find((p) => p.id === platformId || p.id.startsWith(`${platformId}#`))
}

/**
 * 把当前在用平台的行提到最前，其余保持原顺序。找不到对应行时原样返回
 * （不排序，也不丢行）；同一平台多号时只提前 apiKeyEnv 精确命中的那一行。
 *
 * `customOrder` 是用户手动排的「平台组 key」序列（见 {@link orderKey}）。
 */
export function orderProviders(
  providers: readonly PanelProvider[],
  activeProvider: string,
  providerKeyRefs: Record<string, string>,
  customOrder: readonly string[] = [],
): PanelProvider[] {
  const ranked = byCustomOrder(providers, customOrder)
  const active = providerRowOf(providers, activeProvider, providerKeyRefs)
  if (!active) return ranked
  // 用户手动排过当前平台 → 尊重他的位置，不再置顶。
  if (customOrder.length > 0 && customOrder.includes(orderKey(active.id))) return ranked
  return [active, ...ranked.filter((p) => p !== active)]
}

/**
 * 按手动顺序重排：命中的按 rank 升序在前，没命中的（新线路/新账号）保持
 * Host 顺序追加在后面。稳定排序——同组多账号行不会被拆开。
 */
function byCustomOrder(providers: readonly PanelProvider[], customOrder: readonly string[]): PanelProvider[] {
  if (customOrder.length === 0) return [...providers]
  const rank = new Map<string, number>()
  customOrder.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index)
  })
  const fallback = customOrder.length
  return providers
    .map((provider, index) => ({ provider, index, rank: rank.get(orderKey(provider.id)) ?? fallback }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.provider)
}
