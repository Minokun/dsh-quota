/**
 * Host-side bridge feeding live DSH `session/event` and `agent/assistant-stream`
 * publications into `SessionCostLedger`.
 *
 * - Guards fork-inherited events via `session.isOwnSeq(event.seq)` so `subagent_fork`
 *   never double-counts parent history.
 * - Captures `assistant/message`, `assistant/attempt` (with `llm/retry-started`
 *   dedup awareness), `compaction/summary`, and `tool/call` (`web_search`).
 * @module dsh-quota/session-ledger-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UsageBuckets } from './client/pricing.ts'
import { SessionCostLedger } from './session-ledger.ts'

interface RawTokenUsage {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

interface SessionLike {
  id?: unknown
  header?: { cwd?: unknown; isSeeded?: unknown }
  inheritedEventCount?: unknown
  isOwnSeq?: (seq: number) => boolean
}

interface SessionEventLike {
  seq?: unknown
  time?: unknown
  type?: unknown
  data?: Record<string, unknown>
}

function extractBuckets(raw: unknown): UsageBuckets | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const u = raw as RawTokenUsage
  const input = typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens) ? Math.max(0, u.inputTokens) : undefined
  const output = typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens) ? Math.max(0, u.outputTokens) : undefined
  if (input === undefined && output === undefined) return undefined
  return {
    uncachedInputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: typeof u.cacheReadTokens === 'number' && Number.isFinite(u.cacheReadTokens) ? Math.max(0, u.cacheReadTokens) : 0,
    cacheWriteTokens: typeof u.cacheWriteTokens === 'number' && Number.isFinite(u.cacheWriteTokens) ? Math.max(0, u.cacheWriteTokens) : 0,
  }
}

function extractStreamUsage(stream: unknown): UsageBuckets | undefined {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const entry = stream[i] as { type?: unknown; usage?: unknown; chunk?: { type?: unknown; usage?: unknown } } | null
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'usage' && entry.usage) {
      const b = extractBuckets(entry.usage)
      if (b) return b
    }
    if (entry.chunk?.type === 'usage' && entry.chunk.usage) {
      const b = extractBuckets(entry.chunk.usage)
      if (b) return b
    }
  }
  return undefined
}

export class PassiveSessionLedgerHost {
  readonly ledger: SessionCostLedger
  private readonly sessionRoutes = new Map<string, { provider: string; model: string }>()
  private readonly sessionCwds = new Map<string, string>()
  private readonly getDefaultRoute: () => { provider: string; model: string } | undefined
  private readonly onDirty: (() => void) | undefined
  private readonly now: () => number

  constructor(opts: {
    ledger?: SessionCostLedger
    getDefaultRoute?: () => { provider: string; model: string } | undefined
    onDirty?: () => void
    now?: () => number
  } = {}) {
    this.ledger = opts.ledger ?? new SessionCostLedger()
    this.getDefaultRoute = opts.getDefaultRoute ?? (() => undefined)
    this.onDirty = opts.onDirty
    this.now = opts.now ?? Date.now
  }

  /** Handle one `session/event` record (exposed for deterministic unit tests). */
  handleSessionEvent(session: SessionLike, event: SessionEventLike): void {
    const sessionId = typeof session.id === 'string' && session.id ? session.id : undefined
    if (!sessionId) return

    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined
    // Fork safety: check both `session.isOwnSeq(seq)` and `inheritedEventCount`.
    let isInherited = false
    if (seq !== undefined) {
      if (typeof session.isOwnSeq === 'function') {
        isInherited = !session.isOwnSeq(seq)
      } else if (typeof session.inheritedEventCount === 'number' && seq < session.inheritedEventCount) {
        isInherited = true
      }
    }

    const headerCwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
    if (headerCwd && !this.sessionCwds.has(sessionId)) {
      this.sessionCwds.set(sessionId, headerCwd)
    }

    const ts = typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0
      ? event.time
      : this.now()
    const data = (event.data ?? {}) as Record<string, unknown>

    if (event.type === 'working-directory/change' && typeof data.cwd === 'string' && data.cwd) {
      this.sessionCwds.set(sessionId, data.cwd)
      if (!isInherited) this.ledger.touchSession(sessionId, data.cwd, ts)
      return
    }

    if (event.type === 'model/selection' || event.type === 'request/context') {
      const provider = typeof data.provider === 'string' ? data.provider : ''
      const model = typeof data.model === 'string' ? data.model : ''
      if (provider || model) {
        const prev = this.sessionRoutes.get(sessionId)
        this.sessionRoutes.set(sessionId, {
          provider: provider || prev?.provider || '',
          model: model || prev?.model || '',
        })
      }
      return
    }

    if (isInherited) return

    if (event.type === 'llm/retry-started') {
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      const step = typeof data.step === 'number' ? data.step : undefined
      if (turn !== undefined && step !== undefined) {
        this.ledger.onRetryStarted(sessionId, turn, step)
      }
      return
    }

    const cwd = this.sessionCwds.get(sessionId) ?? headerCwd
    const route = this.resolveRoute(sessionId, data)
    const dedupKey = seq !== undefined
      ? `${sessionId}#seq:${String(seq)}`
      : `${sessionId}#${String(event.type)}:${String(ts)}`

    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const buckets = extractBuckets(data.usage) ?? extractStreamUsage(data.stream)
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      const step = typeof data.step === 'number' ? data.step : undefined
      if (buckets) {
        const changed = this.ledger.recordUsageStep({
          dedupKey,
          sessionId,
          cwd,
          provider: route.provider,
          model: route.model,
          buckets,
          timestamp: ts,
          kind: 'turn',
          turn,
          step,
        })
        if (changed) this.onDirty?.()
      } else if (event.type === 'assistant/message') {
        const changed = this.ledger.recordUnmeteredStep({
          dedupKey,
          sessionId,
          cwd,
          timestamp: ts,
        })
        if (changed) this.onDirty?.()
      }
      return
    }

    if (event.type === 'compaction/summary') {
      const buckets = extractBuckets(data.usage)
      if (buckets) {
        const changed = this.ledger.recordUsageStep({
          dedupKey,
          sessionId,
          cwd,
          provider: route.provider,
          model: route.model,
          buckets,
          timestamp: ts,
          kind: 'compaction',
        })
        if (changed) this.onDirty?.()
      }
      return
    }

    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      if (name === 'web_search') {
        const callId = typeof data.callId === 'string' && data.callId ? data.callId : dedupKey
        const changed = this.ledger.recordWebSearch({
          dedupKey: `${sessionId}#tool:${callId}`,
          sessionId,
          cwd,
          provider: route.provider,
          model: route.model,
          timestamp: ts,
        })
        if (changed) this.onDirty?.()
      }
    }
  }

  private resolveRoute(sessionId: string, data: Record<string, unknown>): { provider: string; model: string } {
    const msg = data.message as { provider?: unknown; model?: unknown } | undefined
    const msgProvider = typeof msg?.provider === 'string' ? msg.provider : ''
    const msgModel = typeof msg?.model === 'string' ? msg.model : ''
    const tracked = this.sessionRoutes.get(sessionId)
    const fallback = this.getDefaultRoute()
    return {
      provider: msgProvider || tracked?.provider || fallback?.provider || '',
      model: msgModel || tracked?.model || fallback?.model || '',
    }
  }

  /** Subscribe on Host Cordis context; returns clean disposer via `ctx.effect`. */
  install(ctx: Context): void {
    ctx.effect(() => {
      const events = ctx as unknown as {
        on(event: string, listener: (...args: unknown[]) => void, options?: unknown): () => void
      }
      const offSessionCreated = events.on('session/created', (rawSession: unknown) => {
        const s = rawSession as SessionLike | null
        const id = typeof s?.id === 'string' ? s.id : undefined
        const cwd = typeof s?.header?.cwd === 'string' ? s.header.cwd : undefined
        if (id && cwd) this.sessionCwds.set(id, cwd)
      }, { global: true })

      const offSessionEvent = events.on('session/event', (rawSession: unknown, rawEvent: unknown) => {
        if (rawSession && rawEvent && typeof rawSession === 'object' && typeof rawEvent === 'object') {
          this.handleSessionEvent(rawSession as SessionLike, rawEvent as SessionEventLike)
        }
      }, { global: true })

      const offAgentStream = events.on('agent/assistant-stream', (payload: unknown) => {
        const p = payload as { agent?: { id?: unknown; model?: { current?: () => { provider: string; model: string } | undefined } } } | null
        const sid = typeof p?.agent?.id === 'string' ? p.agent.id : undefined
        const cur = p?.agent?.model?.current?.()
        if (sid && cur) {
          this.sessionRoutes.set(sid, { provider: cur.provider, model: cur.model })
        }
      }, { global: true })

      return () => {
        offSessionCreated?.()
        offSessionEvent?.()
        offAgentStream?.()
      }
    }, 'dsh-quota: session cost ledger')
  }
}
