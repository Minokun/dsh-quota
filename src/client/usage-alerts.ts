/**
 * 用量提醒状态机（纯逻辑，无 React / DOM 依赖，可单测）：
 * 从悬浮球冒出的「即将见底 / 预计耗尽」toast 的触发规则都在这里——
 * **每个条目在每个额度窗口内最多提醒一次**：
 * - threshold：条目已用百分比到达阈值时提醒一次；同窗口内无论继续涨
 *   多少都不再提醒，直到窗口重置（resetAt 变化，或数值回落到阈值以下
 *   后再次跨越）才允许下一次提醒。
 * - eta：按当前速率预计 30 分钟内耗尽时提醒一次，同一窗口只一次；
 *   回升到 60 分钟以上后重置。
 * 状态由调用方持久化（localStorage），因此刷新页面不会重新弹一遍。
 * evaluateUsageAlerts 是纯函数：不改传入参数，返回新 state。
 *
 * 两条抗抖动约束（改动前请先看对应单测）：
 * 1. **窗口身份按容差比较，不按字符串全等** —— 这是「总是弹出来」的真凶。
 *    上游网关给的 `resetsAt` 有秒级抖动（实测同一张 Codex 30 天窗口在
 *    `…16:47:11+08:00` 与 `…:12` 之间跳），字符串全等会把同一个窗口当成
 *    两个，于是同一个 100% 的窗口每抖一次弹一次。用真实历史回放：
 *    不抖动时旧逻辑弹 1 次，抖动时弹 344 次；修复后恒为 1 次。
 *    见 {@link sameWindow}。
 * 2. **条目暂时消失不清提醒记录**。网关偶尔一轮返回空（账号额度刷新失败
 *    时那张卡连 `windows` 都没有），条目在面板上闪没一会儿又回来。旧实现
 *    「条目消失 = 清空三张表」会因此把已提醒记录抹掉，回来时按新窗口再弹
 *    一次。现在只有 `lastPercent`（纯记账）随条目消失清理。
 *    （注：这条是防御性修复，不是本仓库日志里那次误弹的成因——历史采样受
 *    10 分钟节流，条目「缺样本」不等于「条目消失」。）
 * @module dsh-quota/client/usage-alerts
 */

import type { TFn } from './locale.ts'

/** 用量提醒状态机的内存态（由调用方持有并持久化，evaluate 返回新实例）。 */
export interface UsageAlertState {
  /** key → 最近一次观测到的百分比（用于识别「回落到阈值以下」的重置）。 */
  lastPercent: Map<string, number>
  /** key → 已提醒过的窗口标识（resetAt ?? 'static'）：同窗口不重复提醒。 */
  shown: Map<string, string>
  /** key → 已提醒过 eta 的窗口标识：同窗口不重复提醒。 */
  firedEta: Map<string, string>
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

/**
 * 两个 `resetAt` 相差多少以内算同一个窗口。
 *
 * 上游的 `resetsAt` 每次读都会被重新算一遍，秒级抖动实测存在（同一张
 * Codex 30 天窗口同时观测到 `…16:47:11+08:00` 和 `…16:47:12+08:00`）。
 * 取 5 分钟：比抖动大方得多，又远小于最短的真实额度窗口（5 小时），
 * 不会把相邻两个窗口误并成一个。
 */
export const WINDOW_SAME_MS = 5 * 60 * 1000

/** 窗口标识：条目的 resetAt（同一窗口内不变、跨窗口必变），缺省 'static'。 */
function windowIdOf(item: { resetAt?: string }): string {
  return item.resetAt ?? 'static'
}

/** 解析窗口标识里的时间；'static' / 认不出的字符串返回 undefined。 */
function windowTimeOf(id: string): number | undefined {
  const t = Date.parse(id)
  return Number.isNaN(t) ? undefined : t
}

/**
 * 两个窗口标识是否指向**同一个**额度窗口。
 *
 * 字符串全等的判定会被上游的秒级抖动击穿（同一窗口 `…:11` → `…:12` 就
 * 被当成新窗口，于是同一个 100% 的窗口每抖一次弹一次），所以这里对可解析
 * 成时间的两端按 {@link WINDOW_SAME_MS} 容差比较；不可解析的（'static' 或
 * 裸名字）退回全等。
 * @param a - 已记录的窗口标识。
 * @param b - 本轮观测到的窗口标识。
 * @returns 是否同一窗口。
 */
export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  const ia = a ?? 'static'
  const ib = b ?? 'static'
  if (ia === ib) return true
  const ta = windowTimeOf(ia)
  const tb = windowTimeOf(ib)
  if (ta === undefined || tb === undefined) return false
  return Math.abs(ta - tb) <= WINDOW_SAME_MS
}

/** 新建一份空白用量提醒状态。 */
export function createUsageAlertState(): UsageAlertState {
  return { lastPercent: new Map(), shown: new Map(), firedEta: new Map() }
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
  const firedEta = new Map(state.firedEta)
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
        } else if (!shown.has(key) || !sameWindow(shown.get(key), windowId)) {
          // 新窗口内的首次超标（或首次观测即超标）：提醒一次并记录窗口。
          // 注意 has() 必须单独判：shown 里没有这条时 sameWindow(undefined,
          // 'static') 会返回 true，把它当成「同窗口」就再也不提醒了。
          alerts.push({ key, kind: 'threshold', providerId: p.id, providerLabel: p.label, itemLabel: item.label, percent: pct })
          shown.set(key, windowId)
        } else if (shown.get(key) !== windowId) {
          // 同一窗口、resetAt 只是抖了一下：把基准挪到最新值。否则抖动
          // 单向累积（每次 +1s）迟早会超出容差，又被当成新窗口。
          shown.set(key, windowId)
        }
        lastPercent.set(key, pct)
      }
      if (item.etaMinutes !== undefined) {
        if (item.etaMinutes <= ETA_ALERT_MINUTES) {
          // 预计 30 分钟内耗尽：每个窗口只提醒一次。
          if (!firedEta.has(key) || !sameWindow(firedEta.get(key), windowId)) {
            alerts.push({ key, kind: 'eta', providerId: p.id, providerLabel: p.label, itemLabel: item.label, etaMinutes: item.etaMinutes })
            firedEta.set(key, windowId)
          } else if (firedEta.get(key) !== windowId) {
            firedEta.set(key, windowId) // 同窗口的 resetAt 抖动：更新基准
          }
        } else if (item.etaMinutes > ETA_RECOVER_MINUTES) {
          // 回升到 60 分钟以上：窗口缓解，清掉该条目的已发标记。
          firedEta.delete(key)
        }
      }
    }
  }
  // 条目本轮消失**只**清理纯记账的 lastPercent。shown / firedEta 必须留着：
  // 网关偶发一轮空（卡闪没），条目回来时窗口并没变，清了就会再弹一次。
  // 两张表都以条目 key 为键，条目彻底消失也只是留一条不会被读到的记录，
  // 不会无限增长。
  for (const key of [...lastPercent.keys()]) if (!seen.has(key)) lastPercent.delete(key)
  return { alerts, state: { lastPercent, shown, firedEta } }
}

/**
 * 序列化提醒状态供 localStorage 持久化（Map/Set → JSON 数组）。
 * @param state - 待持久化的状态。
 * @returns JSON 字符串。
 */
export function serializeUsageAlertState(state: UsageAlertState): string {
  return JSON.stringify({
    v: 2,
    lastPercent: [...state.lastPercent.entries()],
    shown: [...state.shown.entries()],
    firedEta: [...state.firedEta.entries()],
  })
}

/**
 * 反序列化持久化的提醒状态；格式不符 / 损坏时返回 undefined（回退空白状态）。
 *
 * 兼容 v1：旧格式的 firedEta 是 `` `${key}@${windowId}` `` 字符串数组，
 * 按最后一个 '@' 拆回 key / 窗口（窗口标识是 ISO 时间或 'static'，本身
 * 不含 '@'，而 key 里的 `magpie#codex/a@b.com` 含 '@'，所以必须从右边拆）。
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
    if (raw?.v !== 1 && raw?.v !== 2) return undefined
    const entries = (value: unknown): Array<[string, unknown]> => (Array.isArray(value) ? value.filter((e): e is [string, unknown] => Array.isArray(e) && typeof e[0] === 'string') : [])
    const state = createUsageAlertState()
    for (const [k, v] of entries(raw.lastPercent)) if (typeof v === 'number') state.lastPercent.set(k, v)
    for (const [k, v] of entries(raw.shown)) if (typeof v === 'string') state.shown.set(k, v)
    if (Array.isArray(raw.firedEta)) {
      for (const entry of raw.firedEta) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          state.firedEta.set(entry[0], entry[1]) // v2: [key, windowId]
        } else if (typeof entry === 'string') {
          const cut = entry.lastIndexOf('@') // v1: `${key}@${windowId}`
          if (cut > 0) state.firedEta.set(entry.slice(0, cut), entry.slice(cut + 1))
        }
      }
    }
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
