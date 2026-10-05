/**
 * Resolve the visible session from the framework's `useSessions` snapshot
 * (`SessionListState`), used by the pill to follow the session's model.
 *
 * The shape moved between client runtimes: `dsh ≤ 0.1.6-alpha.1` carried a flat
 * `current: SessionId`, and `dsh ≥ 0.1.6-alpha.2` (commit 6830e1460d) dropped it
 * for retention — `byId[*].retainedBy.mainView > 0`, the same rule the shipped
 * `DocumentTitle` uses. Reading only `current` pinned the pill to the deployment
 * default model on every runtime since, which is the bug this resolver fixes.
 * @module dsh-quota/client/session-model
 */

import type { SessionListState, SessionProjectionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * dsh token-meter 服务注册的 `tokenUsage` 会话投影 wire view（结构化类型，
 * 字段名核实自 dsh-token-meter/lib/types/usage-projection.d.ts 的
 * `viewSchema`：扁平四桶，每桶一个 number）。
 */
export interface TokenUsageView {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** One `SessionListState` row, structurally typed (no runtime dependency). */
interface SessionRowLike {
  id?: unknown
  retainedBy?: Record<string, number | undefined> | undefined
}

/** Snapshot fields this resolver reads; both are optional across versions. */
interface SessionsSnapshotLike {
  current?: unknown
  byId?: Record<string, SessionRowLike | undefined> | undefined
}

/** Assertion helper: the argument must resolve to `true`, or typecheck fails. */
type Assert<T extends true> = T
type RealById = SessionListState['byId']
type RealRow = RealById[keyof RealById]

/**
 * Compile-time canary: pin the real snapshot fields this resolver reads, so a
 * future rename in `SessionListState` fails `pnpm typecheck` instead of
 * silently degrading the pill to the deployment default model.
 */
export type SessionSnapshotCanary = [
  RealRow['id'],
  RealRow['retainedBy'],
  Assert<RealRow extends SessionRowLike ? true : false>,
]

/** `projectionsBySession` 行的真实类型，用于钉住投影快照的外层形状。 */
type RealProjections = SessionListState['projectionsBySession']
type RealProjectionRow = RealProjections[keyof RealProjections]

/**
 * Compile-time canary：钉住投影读取路径的字段名（`projectionsBySession`
 * 与其行的 `values`），未来 dsh 改名时 `pnpm typecheck` 直接失败，而不是
 * 让本会话卡片静默消失。
 */
export type TokenUsageCanary = [
  Assert<RealProjectionRow extends { readonly values: unknown } ? true : false>,
  Assert<RealProjectionRow extends SessionProjectionSnapshot ? true : false>,
]

/**
 * Pick the session id the main view currently retains.
 * @param snapshot - the `useSessions` store snapshot.
 * @returns the visible session id, or undefined when no session is on screen.
 */
export function visibleSessionIdOf(snapshot: unknown): string | undefined {
  const s = snapshot as SessionsSnapshotLike | null | undefined
  const main = Object.values(s?.byId ?? {}).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)
  if (typeof main?.id === 'string' && main.id) return main.id
  return typeof s?.current === 'string' && s.current ? s.current : undefined
}

/** 投影快照行里本 selector 读取的字段（`values.tokenUsage`），跨版本可选。 */
interface ProjectionsSnapshotLike extends SessionsSnapshotLike {
  projectionsBySession?: Record<string, { values?: { tokenUsage?: TokenUsageView } | undefined } | undefined>
}

/**
 * 读取可见会话的 `tokenUsage` 投影（四桶累计用量）。返回 values.tokenUsage
 * 对象本身（引用稳定，适合 useSessions 的 selector）。
 * @param snapshot - the `useSessions` store snapshot.
 * @returns 四桶快照；无可见会话或尚未发布投影时 undefined。
 */
export function sessionTokenUsageOf(snapshot: unknown): TokenUsageView | undefined {
  const id = visibleSessionIdOf(snapshot)
  if (!id) return undefined
  const s = snapshot as ProjectionsSnapshotLike | null | undefined
  return s?.projectionsBySession?.[id]?.values?.tokenUsage
}
