/**
 * 告警已读（ack）状态的纯逻辑：
 * - `ackAll`：把当前所有告警记为已读（key → 条件签名），并顺手丢掉
 *   已经不再存在的告警；签名的意义见 alerts.ts。
 * - `pruneAcks`：只清掉「本轮已经不存在」的已读记录，其余保持原样——
 *   这样告警消失后再次出现（新窗口 / 新错误）会重新变回未读。
 * - `serialize` / `deserialize`：localStorage 持久化，刷新页面不再弹红点。
 * 状态由调用方（client/controller.ts）持有并落盘，与 usage-alerts.ts 同构。
 * @module dsh-quota/client/alert-ack
 */

import type { AlertIdentity } from './alerts.ts'

/** 已读告警：alert key → 已读时的条件签名。 */
export type AlertAckState = Record<string, string>

/** 空白状态（从未点过「已读」）。 */
export function createAlertAckState(): AlertAckState {
  return {}
}

/**
 * 把当前所有告警标为已读：返回只含现存告警的新状态。
 * @param identities - 当前全部告警（含已读的，见 alertIdentities）。
 * @returns 新的已读状态。
 */
export function ackAll(identities: AlertIdentity[]): AlertAckState {
  const next: AlertAckState = {}
  for (const identity of identities) next[identity.key] = identity.signature
  return next
}

/**
 * 清掉本轮已不存在的已读记录（告警消失 → 下次出现要重新提醒）。
 * @param state - 上一份已读状态。
 * @param identities - 当前全部告警。
 * @returns 清理后的状态；没有变化时返回 undefined（调用方据此省掉一次写盘 / 渲染）。
 */
export function pruneAcks(state: AlertAckState, identities: AlertIdentity[]): AlertAckState | undefined {
  const live = new Set(identities.map((a) => a.key))
  const next: AlertAckState = {}
  let changed = false
  for (const [key, signature] of Object.entries(state)) {
    if (live.has(key)) next[key] = signature
    else changed = true
  }
  return changed ? next : undefined
}

/** 序列化为 localStorage 字符串。 */
export function serializeAlertAckState(state: AlertAckState): string {
  return JSON.stringify({ v: 1, acked: state })
}

/**
 * 反序列化已读状态；格式不符 / 损坏时返回 undefined（回退空白状态，
 * 最坏情况是再显示一次红点，不会丢数据）。
 * @param json - localStorage 里读出的字符串。
 */
export function deserializeAlertAckState(json: string): AlertAckState | undefined {
  try {
    const raw = JSON.parse(json) as { v?: unknown; acked?: unknown }
    if (raw?.v !== 1 || raw.acked === null || typeof raw.acked !== 'object' || Array.isArray(raw.acked)) return undefined
    const state: AlertAckState = {}
    for (const [key, value] of Object.entries(raw.acked as Record<string, unknown>)) {
      if (typeof value === 'string') state[key] = value
    }
    return state
  } catch {
    return undefined
  }
}
