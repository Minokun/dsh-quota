import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SpeedAccumulator, toModelSpeedSummary, sampleFromFrames } from '../src/speed-sampler.ts'
import { parseSpeedFile, saveSpeedFile, loadSpeedFile } from '../src/speed-store.ts'
import type { TokenFrame } from '../src/speed-metrics.ts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 流式样本：n 帧，每帧 gapMs。 */
function stream(n: number, gapMs: number, startAt = 1_000): TokenFrame[] {
  return Array.from({ length: n }, (_, i) => ({ time: startAt + i * gapMs, chars: 3, kind: 'text' as const }))
}

function sample(model: string, tokens: number, frames: TokenFrame[], startedAt = 0) {
  const s = sampleFromFrames({ model, startedAt, frames, outputTokens: tokens })
  assert.ok(s, 'sample must exist')
  return s
}

// ── 累加器 ───────────────────────────────────────────────────────────────────

test('可测样本进入统计，并给出典型/总吞吐/host 三个不同的数', () => {
  const acc = new SpeedAccumulator()
  // decode 1000ms / 400 tok → 400 tps；ttft 300ms
  const frames = stream(11, 100, 300)
  assert.equal(acc.record(sample('agy-cli/gemini-4-neon', 400, frames)), true)
  const stats = acc.statsOf('agy-cli/gemini-4-neon')
  assert.ok(stats)
  assert.equal(stats.n, 1)
  assert.equal(stats.skipped, 0)
  assert.equal(stats.tpsAggregate, 400)
  assert.equal(stats.tpsTypical, 400)
  assert.equal(stats.ttftMedianMs, 300)
  assert.equal(stats.lastTps, 400)
  // body = 1300ms → 307 tps（体感比解码慢，这才是用户看到的）
  assert.equal(Math.round(stats.bodyTpsMedian!), 308)
})

test('批式样本只计 skipped，绝不污染 tok/s', () => {
  const acc = new SpeedAccumulator()
  // 3 帧 15ms：批式，样本没有 tps
  const batch = stream(3, 15, 1_000)
  assert.equal(acc.record(sample('agy-cli/claude-opus-5-5', 217, batch, 900)), false)
  const stats = acc.statsOf('agy-cli/claude-opus-5-5')
  assert.ok(stats)
  assert.equal(stats.n, 0)
  assert.equal(stats.skipped, 1)
  assert.equal(stats.tpsAggregate, undefined)
  assert.equal(stats.tpsTypical, undefined)
  // 没通过门槛的样本连字符/秒都不报（perf 窗口太短，报了也是假精度），
  // 但仍记下 skipped 次数，面板据此说「批式投递，不可测」。
  assert.equal(stats.skippedCharsPerSecond, undefined)
})

test('典型值被长解码主导，不会被一次离谱的短样本带飞', () => {
  const acc = new SpeedAccumulator()
  acc.record(sample('m', 1000, stream(51, 100, 0))) // 1000/5000ms = 200 tps
  acc.record(sample('m', 1200, stream(11, 100, 0))) // 1200/1000ms = 1200 tps
  const stats = acc.statsOf('m')!
  assert.equal(stats.n, 2)
  assert.equal(stats.tpsTypical, 200) // 权重按 decode 毫秒：5000 > 1000
  assert.equal(Math.round(stats.tpsAggregate!), 367) // 2200/6000ms
})

test('tpsMin/tpsMax 要 3 个样本才给，避免一两次数值吓人', () => {
  const acc = new SpeedAccumulator()
  acc.record(sample('m', 200, stream(11, 100, 0)))
  assert.equal(acc.statsOf('m')!.tpsMin, undefined)
  acc.record(sample('m', 300, stream(11, 100, 0)))
  acc.record(sample('m', 400, stream(11, 100, 0)))
  assert.equal(acc.statsOf('m')!.tpsMin, 200)
  assert.equal(acc.statsOf('m')!.tpsMax, 400)
})

test('无 usage 的样本不给 tps（不编 token 分母）', () => {
  const acc = new SpeedAccumulator()
  const s = sampleFromFrames({ model: 'm', startedAt: 0, frames: stream(11, 100, 0) })
  assert.ok(s)
  assert.equal(s.tps, undefined)
  assert.equal(acc.record(s), false)
  assert.equal(acc.statsOf('m')!.skipped, 1)
})

test('all() 按可测样本数排序，空模型不出现在面板', () => {
  const acc = new SpeedAccumulator()
  acc.record(sample('a', 300, stream(11, 100, 0)))
  acc.record(sample('a', 300, stream(11, 100, 0)))
  acc.record(sample('b', 300, stream(11, 100, 0)))
  const all = acc.all()
  assert.deepEqual(all.map((r) => r.model), ['a', 'b'])
  assert.equal(acc.statsOf('zzz'), undefined)
})

test('环形缓冲有界（不会因为长会话无限增长）', () => {
  const acc = new SpeedAccumulator()
  for (let i = 0; i < 200; i++) acc.record(sample('m', 200 + i, stream(11, 100, 0)))
  const stats = acc.statsOf('m')!
  assert.equal(stats.n, 200)
  // 只保留最近 40 次读数：第 161~200 次 → 360..399 tok / 1s
  assert.equal(stats.tpsMin, 360)
  assert.equal(stats.tpsMax, 399)
})

// ── 结论映射 ─────────────────────────────────────────────────────────────────

test('toModelSpeedSummary 区分 stream / batched / none', () => {
  assert.deepEqual(toModelSpeedSummary('m', undefined), { model: 'm', n: 0, skipped: 0, kind: 'none' })
  assert.deepEqual(
    toModelSpeedSummary('m', { n: 0, outputTokens: 0, decodeMs: 0, skipped: 3 }),
    { model: 'm', n: 0, skipped: 3, kind: 'batched' },
  )
  const s = toModelSpeedSummary('m', { n: 2, outputTokens: 800, decodeMs: 2000, skipped: 1, tpsAggregate: 400 })
  assert.equal(s.kind, 'stream')
  assert.equal(s.tpsAggregate, 400)
  assert.equal(s.skipped, 1)
})

// ── 落盘 ─────────────────────────────────────────────────────────────────────

test('落盘往返：统计与最近读数都能读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-speed-'))
  const path = join(dir, 'speed.json')
  const acc = new SpeedAccumulator()
  acc.record(sample('agy-cli/gemini-4-neon', 400, stream(11, 100, 300)))
  const stats = acc.statsOf('agy-cli/gemini-4-neon')!
  await saveSpeedFile(path, { 'agy-cli/gemini-4-neon': { stats, recent: [[Date.now(), 400]] } })
  const back = await loadSpeedFile(path)
  assert.equal(back['agy-cli/gemini-4-neon']?.stats.n, 1)
  assert.equal(back['agy-cli/gemini-4-neon']?.stats.tpsAggregate, 400)
  assert.equal(back['agy-cli/gemini-4-neon']?.recent.length, 1)
})

test('损坏/异形文件回退空而不是抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-speed-'))
  const bad = join(dir, 'bad.json')
  await writeFile(bad, '{not json', 'utf8')
  assert.deepEqual(await loadSpeedFile(bad), {})
  assert.deepEqual(parseSpeedFile('[1,2,3]'), {})
  assert.deepEqual(parseSpeedFile('{"speed":{"m":{"stats":{"n":"x"}}}}'), {})
  // 缺 n 的模型直接丢弃，不渲染 NaN
  assert.deepEqual(parseSpeedFile('{"speed":{"m":{"stats":{}}}}'), {})
  // 未知字段被忽略，未知模型仍然保留
  const one = parseSpeedFile('{"speed":{"m":{"stats":{"n":1,"bogus":9},"recent":[[1,2],[3,"x"]]}}}')
  assert.equal(one.m?.stats.n, 1)
  assert.deepEqual(one.m?.recent, [[1, 2]])
})
