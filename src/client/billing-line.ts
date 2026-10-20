/**
 * 本会话卡片的「计费周期」行：按会话模型所在平台的计费形态给一句话总结。
 * - 窗口型订阅（5h/周/月窗口，带 percent）：本周期已用百分比 + 按当前
 *   消耗速率的耗尽预估（etaMinutes，host 时序采样算出）。
 * - 余额型平台（余额条目）：近 7 天实测消耗（weeklySpent，日历日均 ×7，
 *   与余额同币种；跨度不足 7 天时标注「按 N 天实测折算」）+ 余额预计耗尽
 *   时间（同样按日历日均算，不是活跃小时速率外推）。
 * 纯函数、无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/billing-line
 */

import type { LocaleKey, TFn } from './locale.ts'
import { formatEtaSpan } from './usage-alerts.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** 计费周期行读取的条目字段（PanelItem 的结构子集）。 */
export interface BillingItem {
  label: string
  /** 已用占比（0-100），窗口型条目标记。 */
  percent?: number
  /** 展示串（余额条目带币种符号，如 "¥120.50"）。 */
  display?: string
  /** 余额型条目：按日历日均预计的耗尽分钟数（host 计算）。 */
  etaMinutes?: number
  /** 余额型条目：近 7 天实测消耗（host 按日历日均 ×7 折算）。 */
  weeklySpent?: number
  /** 余额型条目：weeklySpent 用到的实测跨度（毫秒）。 */
  spendWindowMs?: number
}

/** 计费周期行读取的平台字段（PanelProvider 的结构子集）。 */
export interface BillingProvider {
  status: string
  items: BillingItem[]
}

/** 从展示串取币种前缀（"$1.81"→"$"，"¥120"→"¥"），取不到返回空串。 */
function currencyPrefix(display: string | undefined): string {
  const m = display?.match(/^[^\d\s?.-]+/)
  return m ? m[0].trim() : ''
}

/**
 * 拼会话卡片的计费周期行；平台缺失/查询失败/无已知计费形态时返回空串
 * （调用方不渲染该行）。
 * @param provider - 会话模型对应的平台行。
 * @param t - 当前语言的翻译函数。
 */
export function billingLine(provider: BillingProvider | undefined, t: TFn): string {
  if (!provider || provider.status !== 'ok') return ''
  const items = provider.items
  // 计费周期优先级：周 > 月 > 短窗口（5h/300m）——周窗口最能回答
  // 「本周消耗多少 / 什么时候耗尽」。
  const weekly = items.find((i) => i.percent !== undefined && /本周|周/.test(i.label))
  const monthly = items.find((i) => i.percent !== undefined && /月/.test(i.label))
  const windowed = items.find((i) => i.percent !== undefined && /窗口/.test(i.label))
  const cycle = weekly ?? monthly ?? windowed
  if (cycle?.percent !== undefined) {
    const pct = Math.max(0, Math.min(100, Math.round(cycle.percent)))
    const usedKey: LocaleKey = weekly
      ? 'session.card.weekUsed'
      : monthly
        ? 'session.card.monthUsed'
        : 'session.card.windowUsed'
    const parts = [t(usedKey, { percent: pct })]
    if (cycle.etaMinutes !== undefined) {
      parts.push(t('session.card.quotaEta', { eta: formatEtaSpan(cycle.etaMinutes, t) }))
    }
    return parts.join(' · ')
  }
  // 余额型：实测消耗 + 余额耗尽预估（都无则不显示——平台卡片里已有
  // 余额本身，这里只给增量信息）。样本不足 7 天时**不**把日均外推成
  // 「近 7 天」：那会把两天的消耗放大成一周的数字（实测偏差可达 2 倍，
  // 「日均 ¥35」被算成「近 7 天 ¥246」正是这么来的），改为直说
  // 「近 N 天实测 ≈ ¥X（日均 ≈ ¥Y）」——同一个日均，但不再冒充周总额。
  const balance = items.find((i) => /余额|balance/i.test(i.label))
  if (balance) {
    const parts: string[] = []
    const windowMs = balance.spendWindowMs ?? WEEK_MS
    const days = Math.max(1, Math.round(windowMs / DAY_MS))
    if (balance.weeklySpent !== undefined) {
      const prefix = currencyPrefix(balance.display)
      if (days >= 7) {
        parts.push(t('session.card.weekSpent', { amount: `${prefix}${String(balance.weeklySpent)}` }))
      } else {
        const observed = balance.weeklySpent * (windowMs / WEEK_MS)
        const daily = balance.weeklySpent / 7
        parts.push(t('session.card.spentObserved', {
          amount: `${prefix}${observed.toFixed(2)}`,
          days,
          daily: `${prefix}${daily.toFixed(2)}`,
        }))
      }
    }
    if (balance.etaMinutes !== undefined) {
      parts.push(t('session.card.balanceEta', { eta: formatEtaSpan(balance.etaMinutes, t) }))
    }
    return parts.join(' · ')
  }
  return ''
}
