/**
 * 用量告警状态机（纯逻辑，无 React / 运行时依赖，可单测）：
 * 从悬浮球冒出的「即将见底 / 预计耗尽」toast 的触发规则都在这里——
 * threshold 条目从 < alertPercent 跨到 >= alertPercent 时触发一次
 * （首次观测已超标也算一次），dismiss 后需再涨 ≥5 个百分点才重新告警，
 * 窗口重置（回落到阈值以下）后再次跨越会重新告警；eta 条目按当前速率
 * 预计 30 分钟内耗尽时触发一次，回升到 60 分钟以上（或条目消失）后重置。
 * evaluateUsageAlerts 是纯函数：不改传入参数，返回新 state。
 * @module dsh-quota/client/usage-alerts
 */

import type { TFn } from './locale.ts'

/** 用量告警状态机的内存态（由调用方持有，evaluate 返回新实例）。 */
export interface UsageAlertState {
  /** key → 最近一次观测到的百分比。 */
  lastPercent: Map<string, number>
  /** 本窗口已发过 eta 告警的 key。 */
  firedEta: Set<string>
  /** key → dismiss 时的百分比（再涨 ≥5 个百分点才重新告警）。 */
  dismissedAt: Map<string, number>
}

/** 一条从悬浮球冒出的用量告警 toast。 */
export interface UsageAlert {
  /** `${providerId}::${itemLabel}`。 */
  key: string
  kind: 'threshold' | 'eta'
  providerId: string
  providerLabel: string
  itemLabel: string
  percent?: number
  etaMinutes?: number
}

/** evaluate 入参里每个平台的形状（PanelProvider 的结构子集）。 */
export interface UsageAlertProvider {
  id: string
  label: string
  status: string
  items: Array<{ label: string; percent?: number; etaMinutes?: number }>
}

/** eta 告警的触发线：按当前速率预计在此分钟数内耗尽就提醒。 */
export const ETA_ALERT_MINUTES = 30
/** eta 告警的恢复线：回升到超过此分钟数视为本窗口已缓解。 */
export const ETA_RECOVER_MINUTES = 60
/** dismiss 后需比 dismiss 时的百分比再涨多少个百分点才重新告警。 */
export const RE_FIRE_AFTER_DISMISS_PERCENT = 5

/** 新建一份空白用量告警状态。 */
export function createUsageAlertState(): UsageAlertState {
  return { lastPercent: new Map(), firedEta: new Set(), dismissedAt: new Map() }
}

/**
 * 按最新平台行评估用量告警（纯函数：不改 providers / dismissed / state）。
 * @param providers - 最新平台行（只有 status === 'ok' 的参与评估）。
 * @param alertPercent - 用量占比告警阈值（0-100）。
 * @param dismissed - 调用方记录的已忽略 key 集合。
 * @param state - 上一轮的状态机。
 * @returns 本轮新触发的告警 + 推进后的新 state。
 */
export function evaluateUsageAlerts(
  providers: UsageAlertProvider[],
  alertPercent: number,
  dismissed: Set<string>,
  state: UsageAlertState,
): { alerts: UsageAlert[]; state: UsageAlertState } {
  const lastPercent = new Map(state.lastPercent)
  const firedEta = new Set(state.firedEta)
  const dismissedAt = new Map(state.dismissedAt)
  const alerts: UsageAlert[] = []
  const seen = new Set<string>()
  for (const p of providers) {
    if (p.status !== 'ok') continue // 查询失败的平台数据不可信，不评估
    for (const item of p.items) {
      const key = `${p.id}::${item.label}`
      seen.add(key)
      // 调用方已解除忽略的 key（恢复 / 重置 / 条目消失）顺带清掉 dismissedAt。
      if (!dismissed.has(key)) dismissedAt.delete(key)
      const at = dismissedAt.get(key)
      if (item.percent !== undefined) {
        const pct = item.percent
        const prev = state.lastPercent.get(key)
        if (pct < alertPercent) {
          // 回落到阈值以下：视为新窗口，解除 dismiss 抑制。
          dismissedAt.delete(key)
        } else if (at !== undefined && pct >= at + RE_FIRE_AFTER_DISMISS_PERCENT) {
          // dismiss 后又涨了 ≥5 个百分点：重新告警一次，并解除抑制。
          alerts.push({ key, kind: 'threshold', providerId: p.id, providerLabel: p.label, itemLabel: item.label, percent: pct })
          dismissedAt.delete(key)
        } else if (at === undefined) {
          // 首次观测已超标（prev 为空）或从 < 阈值跨到 >= 阈值时触发一次。
          const crossed = prev === undefined || (prev < alertPercent && pct >= alertPercent)
          if (crossed) alerts.push({ key, kind: 'threshold', providerId: p.id, providerLabel: p.label, itemLabel: item.label, percent: pct })
        }
        lastPercent.set(key, pct)
      }
      if (item.etaMinutes !== undefined) {
        if (item.etaMinutes <= ETA_ALERT_MINUTES) {
          // 预计 30 分钟内耗尽：每个窗口只告警一次。
          if (!firedEta.has(key)) {
            alerts.push({ key, kind: 'eta', providerId: p.id, providerLabel: p.label, itemLabel: item.label, etaMinutes: item.etaMinutes })
            firedEta.add(key)
          }
        } else if (item.etaMinutes > ETA_RECOVER_MINUTES) {
          // 回升到 60 分钟以上：窗口缓解，重置已发标记。
          firedEta.delete(key)
        }
      }
    }
  }
  // 条目消失：清理三张表，让条目再次出现时按首次观测处理。
  for (const key of [...lastPercent.keys()]) if (!seen.has(key)) lastPercent.delete(key)
  for (const key of [...firedEta]) if (!seen.has(key)) firedEta.delete(key)
  for (const key of [...dismissedAt.keys()]) if (!seen.has(key)) dismissedAt.delete(key)
  return { alerts, state: { lastPercent, firedEta, dismissedAt } }
}

/**
 * 把分钟数格式化为与面板 eta.minutes / eta.hours / eta.days 同粒度的时长片段
 * （如「约 45 分钟」/「~2.3 h」），供用量告警 toast 的 {eta} 插槽复用。
 * @param minutes - 预计耗尽的分钟数。
 * @param t - 当前语言的翻译函数。
 */
export function formatEtaSpan(minutes: number, t: TFn): string {
  if (minutes < 60) return t('eta.span.minutes', { n: minutes })
  if (minutes < 60 * 24) return t('eta.span.hours', { n: (minutes / 60).toFixed(1) })
  return t('eta.span.days', { n: (minutes / 1440).toFixed(1) })
}
