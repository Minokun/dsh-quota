/**
 * Red-badge alert accounting, shared by the floater badge, the panel verdict
 * and every platform card.
 *
 * One definition, three surfaces: the badge total, the header breakdown and a
 * card's own marker must agree, so the count is derived from the same three
 * conditions everywhere — an item at or above the usage threshold, a platform
 * whose query failed, and a platform whose sign-in expired.
 *
 * 已读（ack）只影响「显示」，不改判定的口径：每条告警带一个**条件签名**
 * （usage 用条目的 resetAt，即窗口；failed 用错误文案；login 固定），
 * 用户标为已读后把 key → 签名记进 `ackedAlerts`，签名一致就不再计数；
 * 窗口重置 / 错误文案变化 / 条目重新越阈值时签名变化，自动恢复未读。
 * @module dsh-quota/client/alerts
 */

import type { PanelProvider, QuotaPanelState } from './controller.ts'
import type { TFn } from './locale.ts'
import { THRESHOLD_RECOVER_MARGIN, sameWindow } from './usage-alerts.ts'

/** The slice of the panel snapshot alert accounting reads. */
export type AlertSnapshot = Pick<QuotaPanelState, 'providers' | 'loginAlerts' | 'alertPercent'> & {
  /** 已读告警（alert key → 已读时的条件签名，见 alert-ack.ts）；缺省 = 全部未读。 */
  ackedAlerts?: Record<string, string>
}

/** 告警的种类：查询失败 / 用量越阈值 / 登录失效。 */
export type AlertKind = 'failed' | 'usage' | 'login'

/**
 * 一条告警的身份（与语言无关）：key 标识「哪条告警」，signature 标识
 * 「这一轮的条件」——签名变化即视为新告警，需要重新提醒。
 */
export interface AlertIdentity {
  /** 稳定标识：`failed:<providerId>` / `usage:<providerId>|<item>` / `login:<providerId>`。 */
  key: string
  /** 条件签名：窗口标识或错误文案，变化即变回未读。 */
  signature: string
  kind: AlertKind
  providerId: string
  providerLabel: string
  itemLabel?: string
  percent?: number
}

/** Whether one platform has an outstanding sign-in alert. */
function hasLoginAlert(id: string, snapshot: AlertSnapshot): boolean {
  return snapshot.loginAlerts.some((alert) => alert.id === id)
}

/** Items of one platform at or above the configured alert threshold. */
function overThresholdItems(p: PanelProvider, snapshot: AlertSnapshot) {
  if (p.status !== 'ok') return []
  return p.items.filter((item) => item.percent !== undefined && item.percent >= snapshot.alertPercent)
}

/** Every alert of one platform, read or not (card order, item order). */
function providerIdentities(p: PanelProvider, snapshot: AlertSnapshot): AlertIdentity[] {
  const out: AlertIdentity[] = []
  if (p.status === 'error') {
    out.push({
      key: `failed:${p.id}`,
      signature: `failed:${p.message ?? ''}`,
      kind: 'failed',
      providerId: p.id,
      providerLabel: p.label,
    })
  }
  for (const item of overThresholdItems(p, snapshot)) {
    out.push({
      key: `usage:${p.id}|${item.label}`,
      // 窗口标识：同一窗口内不再重复提醒，跨窗口（resetAt 变）自动恢复未读。
      signature: `usage:${item.resetAt ?? 'static'}`,
      kind: 'usage',
      providerId: p.id,
      providerLabel: p.label,
      itemLabel: item.label,
      percent: item.percent,
    })
  }
  if (hasLoginAlert(p.id, snapshot)) {
    out.push({
      key: `login:${p.id}`,
      signature: 'login',
      kind: 'login',
      providerId: p.id,
      providerLabel: p.label,
    })
  }
  return out
}

/** Every counted alert, read or not (the badge/ack action works on this list). */
export function alertIdentities(snapshot: AlertSnapshot): AlertIdentity[] {
  return snapshot.providers.flatMap((p) => providerIdentities(p, snapshot))
}

const USAGE_SIG_PREFIX = 'usage:'

/**
 * 两个告警条件签名是否指向同一次告警事件：
 * - usage 签名（`usage:<resetAt>`）复用 {@link sameWindow} 的 5 分钟容差，
 *   避免上游 `resetsAt` 的秒级抖动让刚点过「已读」的红点在下一轮轮询复活；
 * - failed / login 按字符串全等（如 401 变 500 属于新问题，必须恢复未读）。
 */
export function sameAlertSignature(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  if (a === b) return true
  if (a.startsWith(USAGE_SIG_PREFIX) && b.startsWith(USAGE_SIG_PREFIX)) {
    return sameWindow(a.slice(USAGE_SIG_PREFIX.length), b.slice(USAGE_SIG_PREFIX.length))
  }
  return false
}

/**
 * 虽未越过 `alertPercent`、但尚未真正恢复的 usage 已读 key 集合。
 *
 * 与 `usage-alerts.ts` 的 `THRESHOLD_RECOVER_MARGIN`（10 个百分点）同口径：
 * 读数在阈值线上下（如 82%~87%）横跳、或上游偶发一轮空窗口/报错时，保留
 * 已读记录，避免下一轮回到阈值以上红点又重新亮起；只有实测百分比跌破
 * `alertPercent - THRESHOLD_RECOVER_MARGIN`（真·充值/重置）或平台移除才释放。
 */
export function retainedUsageAckKeys(snapshot: AlertSnapshot): Set<string> {
  const floor = snapshot.alertPercent - THRESHOLD_RECOVER_MARGIN
  const ackedKeys = Object.keys(snapshot.ackedAlerts ?? {})
  const keep = new Set<string>()
  for (const p of snapshot.providers) {
    const prefix = `usage:${p.id}|`
    if (p.status !== 'ok') {
      for (const key of ackedKeys) {
        if (key.startsWith(prefix)) keep.add(key)
      }
      continue
    }
    const seenLabels = new Set<string>()
    for (const item of p.items) {
      seenLabels.add(item.label)
      if (item.percent === undefined || item.percent >= floor) {
        keep.add(`${prefix}${item.label}`)
      }
    }
    for (const key of ackedKeys) {
      if (key.startsWith(prefix) && !seenLabels.has(key.slice(prefix.length))) {
        keep.add(key)
      }
    }
  }
  return keep
}

/** Whether one alert is still unread (never acked, or the condition changed). */
export function isUnread(snapshot: AlertSnapshot, identity: AlertIdentity): boolean {
  const acked = snapshot.ackedAlerts
  if (acked === undefined) return true
  return !sameAlertSignature(acked[identity.key], identity.signature)
}

/** Render one alert as its display line. */
function lineOf(identity: AlertIdentity, t: TFn): string {
  if (identity.kind === 'failed') return t('alert.failed', { label: identity.providerLabel })
  if (identity.kind === 'login') return t('alert.login', { label: identity.providerLabel })
  return t('alert.usage', { label: identity.providerLabel, item: identity.itemLabel ?? '', percent: Math.round(identity.percent ?? 0) })
}

/** Unread alerts of one platform card, as one display line each. */
export function providerAlertLines(p: PanelProvider, snapshot: AlertSnapshot, t: TFn): string[] {
  return providerIdentities(p, snapshot).filter((a) => isUnread(snapshot, a)).map((a) => lineOf(a, t))
}

/** Unread alerts of one platform card, counted (see {@link providerAlertLines}). */
export function providerAlertCount(p: PanelProvider, snapshot: AlertSnapshot): number {
  return providerIdentities(p, snapshot).filter((a) => isUnread(snapshot, a)).length
}

/** Every unread alert line, in card order (the pill tooltip and header list). */
export function alertLines(snapshot: AlertSnapshot, t: TFn): string[] {
  return alertIdentities(snapshot).filter((a) => isUnread(snapshot, a)).map((a) => lineOf(a, t))
}

/** The badge total: unread query failures + usage at/over threshold + sign-in alerts. */
export function alertCount(snapshot: AlertSnapshot): number {
  return alertIdentities(snapshot).filter((a) => isUnread(snapshot, a)).length
}
