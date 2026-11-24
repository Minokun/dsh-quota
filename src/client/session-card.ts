/**
 * 面板第一张卡（「本会话」token 用量与今日三层账本）的纯数据规则。
 *
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/session-card
 */

import type { LocaleKey, TFn } from './locale.ts'
import type { TokenUsageView } from './session-model.ts'
import { formatTokens } from './pricing.ts'
import {
  calculateUsageCost,
  formatAdaptiveTotals,
  hasMoney,
  inferNativeCurrency,
  zeroMoney,
  type MoneyTotals,
} from '../pricing-catalog.ts'
import { normalizeWorkspaceKey, type LedgerWireSnapshot } from '../session-ledger.ts'

/** 本会话卡片里发生变化的桶行（label locale key + token 数）。 */
export interface SessionUsageRow {
  key: Extract<LocaleKey, 'session.card.input' | 'session.card.cacheRead' | 'session.card.cacheWrite' | 'session.card.output'>
  value: number
}

/** 卡片是否渲染：屏幕上有可见会话，或已经拿到用量投影。 */
export function sessionCardVisible(hasVisibleSession: boolean, usage: TokenUsageView | undefined): boolean {
  return hasVisibleSession || usage !== undefined
}

/**
 * 桶行列表。默认返回三行（兼容既有单测与 DeepSeek 零缓存写场景）；
 * 当传入 `{ includeCacheWrite: true }` 且 `cacheWriteTokens > 0`（如 Anthropic Claude）时，
 * 额外显示「缓存写」行。
 */
export function sessionUsageRows(
  usage: TokenUsageView | undefined,
  opts?: { includeCacheWrite?: boolean },
): SessionUsageRow[] {
  if (!usage) return []
  const rows: SessionUsageRow[] = [
    { key: 'session.card.input', value: usage.uncachedInputTokens },
    { key: 'session.card.cacheRead', value: usage.cacheReadTokens },
  ]
  if (opts?.includeCacheWrite === true && usage.cacheWriteTokens > 0) {
    rows.push({ key: 'session.card.cacheWrite', value: usage.cacheWriteTokens })
  }
  rows.push({ key: 'session.card.output', value: usage.outputTokens })
  return rows
}

/**
 * 四桶总量（含缓存写）。缓存写默认不成行显示，但「这个会话到底花没花 token」
 * 必须把它算进去，否则只有缓存写用量的会话会被当成"还没有用量"。
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

export interface DerivedSessionSpendView {
  /** 紧凑金额文本（供收起态 peek 与 composer.dock 窄条使用，如 `¥0.42` / `$0.18`）。 */
  shortCostText: string
  /** 完整金额说明（含 `实记` / `含谷时50%` / `API 等价` / `粗估`）。 */
  fullCostText: string
  /** 三层今日汇总行（`本会话 · 今日此目录 · 今日总计`）。 */
  rollupLine: string
  /** 压缩与联网搜索补充行（有发生时非空）。 */
  extraActivityLine: string
  /** 多模型混用时的分模型明细行（>=2 个模型时非空）。 */
  modelSplitLine: string
  /** 未返回 token usage 的调用次数提示行。 */
  unmeteredLine: string
  /** 优先使用 Host 实记 token（含压缩调用），回退客户端投影。 */
  effectiveUsage: TokenUsageView | undefined
}

/**
 * 综合 Host 侧按事件时刻增量账本（优先）与客户端投影（回退），生成「本会话 + 今日三层」展示视图。
 */
export function deriveSessionSpendView(params: {
  sessionId: string | undefined
  sessionCwd: string | undefined
  activeProvider: string
  activeModel: string
  tokenUsage: TokenUsageView | undefined
  ledger: LedgerWireSnapshot | undefined
  isSubscriptionPlan: boolean
  t: TFn
  now?: number
}): DerivedSessionSpendView {
  const {
    sessionId,
    sessionCwd,
    activeProvider,
    activeModel,
    tokenUsage,
    ledger,
    isSubscriptionPlan,
    t,
    now = Date.now(),
  } = params

  const nativeCurrency = inferNativeCurrency(activeProvider, activeModel)
  const entry = sessionId ? ledger?.sessions?.[sessionId] : undefined
  const hasRecorded = entry !== undefined && (entry.steps > 0 || entry.searchCount > 0 || entry.unmeteredSteps > 0)

  let sessionTotals: MoneyTotals = zeroMoney()
  let shortCostText = ''
  let fullCostText = ''
  let extraActivityLine = ''
  let modelSplitLine = ''
  let unmeteredLine = ''
  const effectiveUsage = hasRecorded && sessionUsageTotal(entry.tokens) > 0 ? entry.tokens : tokenUsage

  if (hasRecorded && hasMoney(entry.totals)) {
    sessionTotals = entry.totals
    shortCostText = formatAdaptiveTotals(entry.totals, nativeCurrency)
    if (isSubscriptionPlan) {
      fullCostText = t('session.card.apiEquivCost', { cost: shortCostText })
    } else {
      const offPeak = entry.offPeakSteps > 0 ? t('session.card.offPeakTag') : ''
      fullCostText = t('session.card.recordedCost', { cost: shortCostText, offPeak })
    }
  } else if (tokenUsage && sessionUsageTotal(tokenUsage) > 0) {
    const est = calculateUsageCost(activeProvider, activeModel, tokenUsage, now)
    if (est && hasMoney(est.totals)) {
      sessionTotals = est.totals
      shortCostText = `≈${formatAdaptiveTotals(est.totals, nativeCurrency)}`
      fullCostText = isSubscriptionPlan
        ? t('session.card.apiEquivCost', { cost: formatAdaptiveTotals(est.totals, nativeCurrency) })
        : t('session.card.roughCost', { cost: formatAdaptiveTotals(est.totals, nativeCurrency) })
    }
  }

  if (hasRecorded) {
    const extraParts: string[] = []
    const compTok = sessionUsageTotal(entry.compactionTokens)
    if (compTok > 0) {
      extraParts.push(t('session.card.compactionLine', {
        tokens: formatTokens(compTok),
        cost: formatAdaptiveTotals(entry.compactionTotals, nativeCurrency),
      }))
    }
    if (entry.searchCount > 0) {
      extraParts.push(t('session.card.searchLine', {
        n: entry.searchCount,
        cost: formatAdaptiveTotals(entry.searchTotals, nativeCurrency),
      }))
    }
    extraActivityLine = extraParts.join(' · ')

    const modelEntries = Object.entries(entry.byModel)
    if (modelEntries.length >= 2) {
      const items = modelEntries
        .sort((a, b) => (b[1].totals.cny + b[1].totals.usd) - (a[1].totals.cny + a[1].totals.usd))
        .slice(0, 4)
        .map(([m, share]) => `${m} ${formatAdaptiveTotals(share.totals, nativeCurrency)}`)
        .join(' · ')
      modelSplitLine = t('session.card.modelSplit', { items })
    }

    if (entry.unmeteredSteps > 0) {
      unmeteredLine = t('session.card.unmetered', { n: entry.unmeteredSteps })
    }
  }

  let rollupLine = ''
  const today = ledger?.today
  if (today && (today.steps > 0 || today.searchCount > 0 || hasMoney(today.totals))) {
    const sessionPart = formatAdaptiveTotals(sessionTotals, nativeCurrency)
    const allPart = formatAdaptiveTotals(today.totals, nativeCurrency)
    const wsKey = normalizeWorkspaceKey(sessionCwd ?? entry?.cwd)
    const wsMoney = wsKey ? today.byWorkspace[wsKey] : undefined
    if (wsKey && wsMoney !== undefined) {
      rollupLine = t('session.card.rollupThree', {
        session: sessionPart,
        workspace: formatAdaptiveTotals(wsMoney, nativeCurrency),
        all: allPart,
      })
    } else {
      rollupLine = t('session.card.rollupTwo', {
        session: sessionPart,
        all: allPart,
      })
    }
  }

  return {
    shortCostText,
    fullCostText,
    rollupLine,
    extraActivityLine,
    modelSplitLine,
    unmeteredLine,
    effectiveUsage,
  }
}
