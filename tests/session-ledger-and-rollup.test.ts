import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  calculateUsageCost,
  formatAdaptiveTotals,
  isDeepSeekOffPeak,
  normalizeModelId,
  resolvePriceAt,
} from '../src/pricing-catalog.ts'
import { SessionCostLedger } from '../src/session-ledger.ts'
import { PassiveSessionLedgerHost } from '../src/session-ledger-host.ts'
import {
  loadDailyRollupFile,
  loadSessionLedgerFile,
  saveDailyRollupFile,
  saveSessionLedgerFile,
} from '../src/session-ledger-store.ts'
import { deriveSessionSpendView, sessionUsageRows } from '../src/client/session-card.ts'
import { translate } from '../src/client/locale.ts'

test('DeepSeek peak / off-peak / weekend / CN statutory holiday boundaries (Asia/Shanghai UTC+8)', () => {
  // 2026-11-25 is Wednesday:
  // 10:30 Beijing time = 02:30 UTC -> PEAK (not off-peak)
  const wedPeak = Date.parse('2026-11-25T02:30:00Z')
  assert.equal(isDeepSeekOffPeak(wedPeak), false)

  // 01:30 Beijing time = 2026-11-24T17:30:00Z -> OFF-PEAK (50%)
  const wedOffPeak = Date.parse('2026-11-24T17:30:00Z')
  assert.equal(isDeepSeekOffPeak(wedOffPeak), true)

  // Saturday 10:30 Beijing time (2026-11-28T02:30:00Z) -> WEEKEND OFF-PEAK (50%)
  const satMorning = Date.parse('2026-11-28T02:30:00Z')
  assert.equal(isDeepSeekOffPeak(satMorning), true)

  // National Day holiday Thursday 2026-10-01 10:30 Beijing time (2026-10-01T02:30:00Z) -> HOLIDAY OFF-PEAK (50%)
  const nationalDay = Date.parse('2026-10-01T02:30:00Z')
  assert.equal(isDeepSeekOffPeak(nationalDay), true)

  // Verify 50% discount applied to DeepSeek official route
  const peakTier = resolvePriceAt('deepseek-official', 'deepseek-v4-pro', wedPeak)!
  const offPeakTier = resolvePriceAt('deepseek-official', 'deepseek-v4-pro', wedOffPeak)!
  assert.equal(peakTier.currency, 'CNY')
  assert.equal(offPeakTier.isOffPeak, true)
  assert.equal(offPeakTier.output, peakTier.output * 0.5)
})

test('model switch invariance: switching to flash or unknown model NEVER rewrites prior step spend', () => {
  const wedPeak = Date.parse('2026-11-25T02:30:00Z')
  const ledger = new SessionCostLedger({ utcOffsetMinutes: 480 })

  // Step 1: 100k output tokens on deepseek-v4-pro (¥14.40/M -> ¥1.44)
  ledger.recordUsageStep({
    dedupKey: 's1#seq:1',
    sessionId: 's1',
    cwd: '/repo/app',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    buckets: { uncachedInputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: wedPeak,
    turn: 1,
    step: 1,
  })
  const afterStep1 = ledger.getSession('s1')!.totals.cny
  assert.ok(Math.abs(afterStep1 - 1.44) < 1e-6)

  // Step 2: switch to deepseek-flash for 10k output tokens (¥8.00/M -> ¥0.08)
  ledger.recordUsageStep({
    dedupKey: 's1#seq:2',
    sessionId: 's1',
    cwd: '/repo/app',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    buckets: { uncachedInputTokens: 0, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: wedPeak + 1000,
    turn: 2,
    step: 1,
  })
  const afterStep2 = ledger.getSession('s1')!.totals.cny
  assert.ok(Math.abs(afterStep2 - 1.52) < 1e-6)

  // Step 3: switch to completely unpriced custom local model -> total remains strictly ¥1.52 (never zeroed!)
  ledger.recordUsageStep({
    dedupKey: 's1#seq:3',
    sessionId: 's1',
    cwd: '/repo/app',
    provider: 'ollama',
    model: 'my-local-llama',
    buckets: { uncachedInputTokens: 50_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: wedPeak + 2000,
    turn: 3,
    step: 1,
  })
  assert.ok(Math.abs(ledger.getSession('s1')!.totals.cny - 1.52) < 1e-6)
  assert.ok(Object.keys(ledger.getSession('s1')!.byModel).length >= 2)
})

test('Anthropic cacheWrite 1.25x pricing, gateway prefix normalization, and cacheWrite UI row', () => {
  assert.equal(normalizeModelId('magpie-anthropic/agy-cli/claude-sonnet-4-5'), 'claude-sonnet-4-5')
  const priced = calculateUsageCost(
    'magpie-anthropic',
    'magpie-anthropic/claude-sonnet-4-5',
    { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0 },
    Date.now(),
  )
  assert.ok(priced)
  assert.equal(priced.tier.currency, 'USD')
  // claude-sonnet-4 input is $3/M, cacheWrite is 1.25x = $3.75/M
  assert.equal(priced.totals.usd, 3.75)

  const rows = sessionUsageRows(
    { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 },
    { includeCacheWrite: true },
  )
  assert.deepEqual(rows.map((r) => r.key), [
    'session.card.input',
    'session.card.cacheRead',
    'session.card.cacheWrite',
    'session.card.output',
  ])
})

test('compaction/summary and web_search events are metered, and fork-inherited events add $0.00', () => {
  const ts = Date.parse('2026-11-25T02:30:00Z')
  const ledger = new SessionCostLedger({ utcOffsetMinutes: 480 })
  const host = new PassiveSessionLedgerHost({ ledger, now: () => ts })

  // Workspace A: Session S1 ($0.10) & S2 ($0.25) on USD route; Workspace B: S3 ($0.40)
  // Using claude-sonnet-4 ($15/M output -> 10k output = $0.15, etc.)
  host.handleSessionEvent(
    { id: 'S1', header: { cwd: '/ws/A' }, isOwnSeq: () => true },
    { seq: 1, time: ts, type: 'model/selection', data: { provider: 'anthropic', model: 'claude-sonnet-4' } },
  )
  host.handleSessionEvent(
    { id: 'S1', header: { cwd: '/ws/A' }, isOwnSeq: () => true },
    { seq: 2, time: ts, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 10_000 } } },
  ) // $0.15

  host.handleSessionEvent(
    { id: 'S2', header: { cwd: '/ws/A' }, isOwnSeq: () => true },
    { seq: 1, time: ts, type: 'model/selection', data: { provider: 'anthropic', model: 'claude-sonnet-4' } },
  )
  host.handleSessionEvent(
    { id: 'S2', header: { cwd: '/ws/A' }, isOwnSeq: () => true },
    { seq: 2, time: ts, type: 'compaction/summary', data: { usage: { inputTokens: 0, outputTokens: 20_000 } } },
  ) // $0.30 compaction
  host.handleSessionEvent(
    { id: 'S2', header: { cwd: '/ws/A' }, isOwnSeq: () => true },
    { seq: 3, time: ts, type: 'tool/call', data: { callId: 'call_1', name: 'web_search', arguments: '{}' } },
  ) // +$0.005 web_search

  host.handleSessionEvent(
    { id: 'S3', header: { cwd: '/ws/B' }, isOwnSeq: () => true },
    { seq: 1, time: ts, type: 'model/selection', data: { provider: 'anthropic', model: 'claude-sonnet-4' } },
  )
  host.handleSessionEvent(
    { id: 'S3', header: { cwd: '/ws/B' }, isOwnSeq: () => true },
    { seq: 2, time: ts, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 40_000 } } },
  ) // $0.60

  const snapBeforeFork = ledger.snapshot(ts)
  const s2Entry = ledger.getSession('S2')!
  assert.equal(s2Entry.searchCount, 1)
  assert.ok(Math.abs(s2Entry.compactionTotals.usd - 0.30) < 1e-6)
  assert.ok(Math.abs(s2Entry.totals.usd - 0.305) < 1e-6)
  // Workspace A = 0.15 + 0.305 = 0.455; All = 0.455 + 0.60 = 1.055
  assert.ok(Math.abs(snapBeforeFork.today.byWorkspace['/ws/A']!.usd - 0.455) < 1e-6)
  assert.ok(Math.abs(snapBeforeFork.today.totals.usd - 1.055) < 1e-6)

  // Fork S2 -> S2-fork: replay inherited events (seq < inheritedEventCount, isOwnSeq = false)
  host.handleSessionEvent(
    { id: 'S2-fork', header: { cwd: '/ws/A', isSeeded: true }, inheritedEventCount: 4, isOwnSeq: (seq) => seq >= 4 },
    { seq: 2, time: ts, type: 'compaction/summary', data: { usage: { inputTokens: 0, outputTokens: 20_000 } } },
  )
  host.handleSessionEvent(
    { id: 'S2-fork', header: { cwd: '/ws/A', isSeeded: true }, inheritedEventCount: 4, isOwnSeq: (seq) => seq >= 4 },
    { seq: 3, time: ts, type: 'tool/call', data: { callId: 'call_1', name: 'web_search', arguments: '{}' } },
  )
  const snapAfterFork = ledger.snapshot(ts)
  assert.equal(ledger.getSession('S2-fork'), undefined)
  assert.ok(Math.abs(snapAfterFork.today.byWorkspace['/ws/A']!.usd - 0.455) < 1e-6)
  assert.ok(Math.abs(snapAfterFork.today.totals.usd - 1.055) < 1e-6)

  // Verify 3-tier UI view rendering
  const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('zh', k, p)
  const view = deriveSessionSpendView({
    sessionId: 'S2',
    sessionCwd: '/ws/A',
    activeProvider: 'anthropic',
    activeModel: 'claude-sonnet-4',
    tokenUsage: undefined,
    ledger: snapAfterFork,
    isSubscriptionPlan: false,
    t,
    now: ts,
  })
  assert.match(view.fullCostText, /\$0\.3050（实记）/)
  assert.match(view.extraActivityLine, /含自动压缩/)
  assert.match(view.extraActivityLine, /联网搜索 ×1/)
  assert.equal(view.rollupLine, '本会话 $0.3050 · 今日此目录 $0.4550 · 今日总计 $1.06')
})

test('midnight rollover, adaptive hybrid ¥ + $ formatting, and 30-day bounded persistence (<32 KiB)', async () => {
  assert.equal(formatAdaptiveTotals({ cny: 1.85, usd: 0.18 }), '¥1.85 + $0.1800')

  const ledger = new SessionCostLedger({ utcOffsetMinutes: 480 })
  // Feed 35 distinct calendar days -> pruned strictly to 30 days
  const baseMs = Date.parse('2026-10-01T04:00:00Z')
  for (let d = 0; d < 35; d += 1) {
    ledger.recordUsageStep({
      dedupKey: `day-${String(d)}`,
      sessionId: `s-${String(d)}`,
      cwd: '/Users/wxk/Desktop/workspace/ai-builder',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      buckets: { uncachedInputTokens: 50_000, outputTokens: 10_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 },
      timestamp: baseMs + d * 86_400_000,
    })
  }

  // Local midnight rollover: 2026-11-24 23:59:59+08:00 vs 2026-11-25 00:00:01+08:00
  const beforeMidnight = Date.parse('2026-11-24T15:59:59Z')
  const afterMidnight = Date.parse('2026-11-24T16:00:01Z')
  ledger.recordUsageStep({
    dedupKey: 'm1',
    sessionId: 'sm',
    cwd: '/ws/m',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    buckets: { uncachedInputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: beforeMidnight,
  })
  assert.equal(ledger.snapshot(afterMidnight).today.steps, 0)
  ledger.recordUsageStep({
    dedupKey: 'm2',
    sessionId: 'sm',
    cwd: '/ws/m',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    buckets: { uncachedInputTokens: 0, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: afterMidnight,
  })
  assert.equal(ledger.snapshot(afterMidnight).today.steps, 1)

  // Atomic disk round-trip & <32 KiB size check
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-ledger-'))
  try {
    const ledgerFile = join(dir, 'session-ledger.json')
    const rollupFile = join(dir, 'daily-rollup.json')
    const exported = ledger.exportState()
    assert.ok(Object.keys(exported.daily).length <= 30)
    await saveSessionLedgerFile(ledgerFile, exported.sessions)
    await saveDailyRollupFile(rollupFile, exported.daily)

    const rollupStat = await stat(rollupFile)
    assert.ok(rollupStat.size < 32 * 1024, `expected <32 KiB, got ${String(rollupStat.size)}`)

    const restored = new SessionCostLedger({ utcOffsetMinutes: 480 })
    restored.hydrate({
      sessions: await loadSessionLedgerFile(ledgerFile),
      daily: await loadDailyRollupFile(rollupFile),
    })
    assert.equal(restored.snapshot(afterMidnight).today.steps, 1)
    assert.deepEqual(restored.getSession('sm')?.totals, ledger.getSession('sm')?.totals)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
