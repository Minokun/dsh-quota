/**
 * 面板第一张卡（「本会话」token 用量）的纯数据规则。
 *
 * 抽成模块的原因是一次真实回归：卡片渲染原本绑在「四桶之和 > 0」上，于是
 * 只要屏幕上的会话还没跑出用量（新会话、刚 fork 的会话，乃至投影还没下发的
 * 第一帧），面板顶部那条可折叠的 token 记录就整块消失——用户看到的现象就是
 * 「顶上那个 token 记录没了」。现在可见性只取决于「屏幕上有没有会话」，没有
 * 用量数据时给占位文案，而不是把整张卡抽掉。
 *
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/session-card
 */

import type { LocaleKey } from './locale.ts'
import type { TokenUsageView } from './session-model.ts'

/** 本会话卡片里发生变化的桶行（label locale key + token 数）。 */
export interface SessionUsageRow {
  key: Extract<LocaleKey, 'session.card.input' | 'session.card.cacheRead' | 'session.card.output'>
  value: number
}

/** 卡片是否渲染：屏幕上有可见会话，或已经拿到用量投影。 */
export function sessionCardVisible(hasVisibleSession: boolean, usage: TokenUsageView | undefined): boolean {
  return hasVisibleSession || usage !== undefined
}

/**
 * 三个桶行。缓存写恒为 0（DeepSeek 无此计费桶，dsh 投影恒为 0），不再单独
 * 成行——其费用已并入输入侧估算。
 * @param usage - 四桶累计用量；undefined 时返回空数组（调用方渲染占位）。
 */
export function sessionUsageRows(usage: TokenUsageView | undefined): SessionUsageRow[] {
  if (!usage) return []
  return [
    { key: 'session.card.input', value: usage.uncachedInputTokens },
    { key: 'session.card.cacheRead', value: usage.cacheReadTokens },
    { key: 'session.card.output', value: usage.outputTokens },
  ]
}

/**
 * 四桶总量（含缓存写）。缓存写不成行显示，但「这个会话到底花没花 token」
 * 必须把它算进去，否则只有缓存写用量的会话会被当成"还没有用量"。
 * @param usage - 四桶累计用量；undefined 时返回 0。
 */
export function sessionUsageTotal(usage: TokenUsageView | undefined): number {
  if (!usage) return 0
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.outputTokens + usage.cacheWriteTokens
}

/** 卡片展开区的补充说明：无投影时「读取中」，投影全 0 时「还没有用量」。 */
export function sessionCardNote(usage: TokenUsageView | undefined): 'pending' | 'empty' | '' {
  if (!usage) return 'pending'
  return sessionUsageTotal(usage) > 0 ? '' : 'empty'
}
