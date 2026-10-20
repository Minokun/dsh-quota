/**
 * 面板平台卡片的排序规则：当前正在使用的模型所在平台排在最前（紧跟面板
 * 第一行的「本会话用量」卡片），其余平台保持 Host 下发的固定顺序。
 *
 * 「当前在用」由 DSH 的模型选择决定——可见会话选中的模型优先，没有会话
 * 选择时退回默认模型的 provider。排序只在客户端做：模型一换面板立刻重排，
 * 不需要刷新 Host 快照。
 *
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/panel-order
 */

import type { PanelProvider } from './controller.ts'
import { platformForProvider } from './platform-map.ts'

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
 */
export function orderProviders(
  providers: readonly PanelProvider[],
  activeProvider: string,
  providerKeyRefs: Record<string, string>,
): PanelProvider[] {
  const active = providerRowOf(providers, activeProvider, providerKeyRefs)
  if (!active) return [...providers]
  return [active, ...providers.filter((p) => p !== active)]
}
