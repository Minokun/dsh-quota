/**
 * Resolve the visible session from the framework's `useSessions` snapshot
 * (`SessionListState`), used by the pill to follow the session's model.
 *
 * The shape moved between client runtimes: `dsh ≤ 0.1.6` carried a flat
 * `current: SessionId`, `dsh ≥ 0.1.7` dropped it and marks the session on
 * screen by retention (`byId[*].retainedBy.mainView > 0` — the same rule the
 * shipped `DocumentTitle` uses). Reading only `current` left the pill pinned
 * to the deployment default model on 0.1.7.
 * @module dsh-quota/client/session-model
 */

/** One `SessionListState` row, structurally typed (no runtime dependency). */
interface SessionRowLike {
  id?: unknown
  retainedBy?: Record<string, number> | undefined
}

/** Snapshot fields this resolver reads; both are optional across versions. */
interface SessionsSnapshotLike {
  current?: unknown
  byId?: Record<string, SessionRowLike | undefined> | undefined
}

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
