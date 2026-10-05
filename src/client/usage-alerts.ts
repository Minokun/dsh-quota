/**
 * 用量提醒状态机（纯逻辑，无 React / DOM 依赖，可单测）：
 * 从悬浮球冒出的「即将见底 / 预计耗尽」toast 的触发规则都在这里——
 * **每个条目在每个额度窗口内最多提醒一次**：
 * - threshold：条目已用百分比到达阈值时提醒一次；同窗口内无论继续涨
 *   多少都不再提醒，直到窗口重置（resetAt 变化，或数值回落到阈值以下
 *   后再次跨越）才允许下一次提醒。
 * - eta：按当前速率预计 30 分钟内耗尽时提醒一次，同一窗口只一次；
 *   回升到 60 分钟以上（或条目消失）后重置。
 * 状态由调用方持久化（localStorage），因此刷新页面不会重新弹一遍。
 * evaluateUsageAlerts 是纯函数：不改传入参数，返回新 state。
 * @module dsh-quota/client/usage-alerts
 */

import type { TFn } from './locale.ts'

/** 用量提醒状态机的内存态（由调用方持有并持久化，evaluate 返回新实例）。 */
export interface UsageAlertState {
  /** key → 最近一次观测到的百分比（用于识别「回落到阈值以下」的重置）。 */
  lastPercent: Map<string, number>
  /** key → 已提醒过的窗口标识（resetAt ?? 'static'）：同窗口不重复提醒。 */
  shown: Map<string, string>
  /** `${key}@${windowId}` 已提醒过 eta 的窗口。 */
  firedEta: Set<string>
}

/** 一条从悬浮球冒出的用量提醒 toast。 */
export interface UsageAlert {
  /** `${providerId}::${itemLabel}`。 */
  key: string
  kind: 'threshold' | 'eta'
  providerId: string
  providerLabel: string
  itemLabel: string
  percent?: number
  etaMinutes?: number
  /** 触发时间戳（controller 记录，用于可见列表的自动收起）。 */
  at?: number
}

/** evaluate 入参里每个平台的形状（PanelProvider 的结构子集）。 */
export interface UsageAlertProvider {
  id: string
  label: string
  status: string
  items: Array<{ label: string; percent?: number; etaMinutes?: number; resetAt?: string }>
}

/** eta 提醒的触发线：按当前速率预计在此分钟数内耗尽就提醒。 */
export const ETA_ALERT_MINUTES = 30
/** eta 提醒的恢复线：回升到超过此分钟数视为本窗口已缓解。 */
export const ETA_RECOVER_MINUTES = 60

/** 窗口标识：条目的 resetAt（同一窗口内不变、跨窗口必变），缺省 'static'。 */
function windowIdOf(item: { resetAt?: string }): string {
  return item.resetAt ?? 'static'
}

/** 新建一份空白用量提醒状态。 */
export function createUsageAlertState(): UsageAlertState {
  return { lastPercent: new Map(), shown: new Map(), firedEta: new Set() }
}

/**
 * 按最新平台行评估用量提醒（纯函数：不改 providers / state）。
 * 只返回**本轮新触发**的提醒；可见列表的保留/清除由调用方管理
 * （提醒记录已写入 state.shown，同窗口不会再次触发）。
 * @param providers - 最新平台行（只有 status === 'ok' 的参与评估）。
 * @param alertPercent - 用量占比提醒阈值（0-100）。
 * @param state - 上一轮的状态机。
 * @returns 本轮新触发的提醒 + 推进后的新 state。
 */
export function evaluateUsageAlerts(
  providers: UsageAlertProvider[],
  alertPercent: number,
  state: UsageAlertState,
): { alerts: UsageAlert[]; state: UsageAlertState } {
  const lastPercent = new Map(state.lastPercent)
  const shown = new Map(state.shown)
  const firedEta = new Set(state.firedEta)
  const alerts: UsageAlert[] = []
  const seen = new Set<string>()
  for (const p of providers) {
    if (p.status !== 'ok') continue // 查询失败的平台数据不可信，不评估
    for (const item of p.items) {
      const key = `${p.id}::${item.label}`
      seen.add(key)
      const windowId = windowIdOf(item)
      if (item.percent !== undefined) {
        const pct = item.percent
        if (pct < alertPercent) {
          // 回落到阈值以下：视为窗口已重置，清掉提醒记录，
          // 之后再次跨越允许下一次提醒。
          shown.delete(key)
        } else if (shown.get(key) !== windowId) {
          // 新窗口内的首次超标（或首次观测即超标）：提醒一次并记录窗口。
          alerts.push({ key, kind: 'threshold', providerId: p.id, providerLabel: p.label, itemLabel: item.label, percent: pct })
          shown.set(key, windowId)
        }
        lastPercent.set(key, pct)
      }
      const etaKey = `${key}@${windowId}`
      if (item.etaMinutes !== undefined) {
        if (item.etaMinutes <= ETA_ALERT_MINUTES) {
          // 预计 30 分钟内耗尽：每个窗口只提醒一次。
          if (!firedEta.has(etaKey)) {
            alerts.push({ key, kind: 'eta', providerId: p.id, providerLabel: p.label, itemLabel: item.label, etaMinutes: item.etaMinutes })
            firedEta.add(etaKey)
          }
        } else if (item.etaMinutes > ETA_RECOVER_MINUTES) {
          // 回升到 60 分钟以上：窗口缓解，清掉该条目所有窗口的已发标记。
          for (const k of [...firedEta]) if (k.startsWith(`${key}@`)) firedEta.delete(k)
        }
      }
    }
  }
  // 条目消失：清理三张表，让条目再次出现时按新窗口处理。
  for (const key of [...lastPercent.keys()]) if (!seen.has(key)) lastPercent.delete(key)
  for (const key of [...shown.keys()]) if (!seen.has(key)) shown.delete(key)
  for (const etaKey of [...firedEta]) if (!seen.has(etaKey.slice(0, etaKey.indexOf('@')))) firedEta.delete(etaKey)
  return { alerts, state: { lastPercent, shown, firedEta } }
}

/**
 * 序列化提醒状态供 localStorage 持久化（Map/Set → JSON 数组）。
 * @param state - 待持久化的状态。
 * @returns JSON 字符串。
 */
export function serializeUsageAlertState(state: UsageAlertState): string {
  return JSON.stringify({
    v: 1,
    lastPercent: [...state.lastPercent.entries()],
    shown: [...state.shown.entries()],
    firedEta: [...state.firedEta],
  })
}

/**
 * 反序列化持久化的提醒状态；格式不符 / 损坏时返回 undefined（回退空白状态）。
 * @param json - localStorage 里读出的字符串。
 * @returns 状态，或 undefined。
 */
export function deserializeUsageAlertState(json: string): UsageAlertState | undefined {
  try {
    const raw = JSON.parse(json) as {
      v?: unknown
      lastPercent?: unknown
      shown?: unknown
      firedEta?: unknown
    }
    if (raw?.v !== 1) return undefined
    const entries = (value: unknown): Array<[string, unknown]> => (Array.isArray(value) ? value.filter((e): e is [string, unknown] => Array.isArray(e) && typeof e[0] === 'string') : [])
    const state = createUsageAlertState()
    for (const [k, v] of entries(raw.lastPercent)) if (typeof v === 'number') state.lastPercent.set(k, v)
    for (const [k, v] of entries(raw.shown)) if (typeof v === 'string') state.shown.set(k, v)
    if (Array.isArray(raw.firedEta)) for (const k of raw.firedEta) if (typeof k === 'string') state.firedEta.add(k)
    return state
  } catch {
    return undefined
  }
}

/**
 * 把分钟数格式化为与面板 eta.minutes / eta.hours / eta.days 同粒度的时长片段
 * （如「约 45 分钟」/「~2.3 h」），供用量提醒 toast 的 {eta} 插槽复用。
 * @param minutes - 预计耗尽的分钟数。
 * @param t - 当前语言的翻译函数。
 */
export function formatEtaSpan(minutes: number, t: TFn): string {
  if (minutes < 60) return t('eta.span.minutes', { n: minutes })
  if (minutes < 60 * 24) return t('eta.span.hours', { n: (minutes / 60).toFixed(1) })
  return t('eta.span.days', { n: (minutes / 1440).toFixed(1) })
}
