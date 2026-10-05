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

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

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
