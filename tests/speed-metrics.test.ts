import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MIN_DECODE_MS,
  MIN_DELTA_FRAMES,
  compareWithDsh,
  fromMagpieModelRow,
  sampleOf,
  summarize,
  timingOf,
  weightedMedian,
  type TokenFrame,
} from '../src/speed-metrics.ts'

/** 等距吐字：frames 个帧，每帧间隔 gapMs。 */
function stream(count: number, gapMs: number, startAt = 1_000): TokenFrame[] {
  return Array.from({ length: count }, (_, i) => ({ time: startAt + i * gapMs, chars: 4, kind: 'text' as const }))
}

// ── 计时口径 ─────────────────────────────────────────────────────────────────

test('ttft 从请求发出算，decode 只覆盖首帧到末帧', () => {
  // 请求 0ms 发出，首帧 800ms 到达（思考静默），之后 10 帧 × 100ms。
  const frames = stream(11, 100, 800)
  const timing = timingOf(0, frames)
  assert.ok(timing)
  assert.equal(timing.ttftMs, 800)
  assert.equal(timing.decodeMs, 1000)
  assert.equal(timing.bodyMs, 1800)
  assert.equal(timing.frames, 11)
})

test('空 token 流没有计时（不能编出一个 0）', () => {
  assert.equal(timingOf(0, []), undefined)
})

test('首末同帧时 decode 为 0 且 body 不倒退', () => {
  const timing = timingOf(0, [{ time: 500, chars: 3, kind: 'text' }])
  assert.ok(timing)
  assert.equal(timing.decodeMs, 0)
  assert.equal(timing.bodyMs, 500)
})

// ── 丢弃门槛：这正是 dsh 出错的地方 ───────────────────────────────────────────

test('批式上游（一次吐完）不给 tps，而不是给无穷大', () => {
  // 217 token 在 37ms 内整段吐出——dsh 会把它渲染成 5865 tok/s。
  const frames = stream(3, 15, 1_000)
  const sample = sampleOf({ model: 'agy-cli/claude-opus-5-5', startedAt: 900, frames, outputTokens: 217, source: 'dsh' })
  assert.ok(sample)
  assert.equal(sample.tps, undefined)
  assert.equal(sample.bodyTps, undefined)
  assert.ok(sample.timing.decodeMs < MIN_DECODE_MS)
})

test('增量帧太少也不给 tps（精度不够）', () => {
  const frames = stream(MIN_DELTA_FRAMES - 1, 400, 1_000)
  const sample = sampleOf({ model: 'agy-cli/gemini-4-neon', startedAt: 0, frames, outputTokens: 900, source: 'probe' })
  assert.ok(sample)
  assert.equal(sample.tps, undefined)
})

test('合格流才出 tps，且与输出 token 成正比', () => {
  const frames = stream(21, 100, 2_000) // decode = 2000ms
  const a = sampleOf({ model: 'm', startedAt: 0, frames, outputTokens: 400, source: 'probe' })
  const b = sampleOf({ model: 'm', startedAt: 0, frames, outputTokens: 800, source: 'probe' })
  assert.equal(a?.tps, 200)
  assert.equal(b?.tps, 400)
  assert.equal(a?.bodyTps, 400 / 4) // body = 4000ms
})

test('没有 usage 时留 undefined，但仍报字符/秒', () => {
  const frames = stream(21, 100, 0) // 84 chars / 2s
  const sample = sampleOf({ model: 'm', startedAt: 0, frames, outputTokens: undefined, source: 'probe' })
  assert.ok(sample)
  assert.equal(sample.tps, undefined)
  assert.equal(sample.outputTokens, undefined)
  assert.equal(sample.charsPerSecond, 42)
})

// ── 汇总 ─────────────────────────────────────────────────────────────────────

test('加权中位：权重大的样本说了算', () => {
  const w = weightedMedian([
    { value: 100, weight: 10 },
    { value: 9000, weight: 1 },
    { value: 120, weight: 10 },
  ])
  assert.equal(w, 120)
  assert.equal(weightedMedian([]), undefined)
  assert.equal(weightedMedian([{ value: 5, weight: 0 }]), undefined)
})

test('summarize 同时给「典型」与「总吞吐」，聚合值不被短样本拉爆', () => {
  const long = sampleOf({ model: 'm', startedAt: 0, frames: stream(51, 100, 0), outputTokens: 1000, source: 'probe' })! // 1000/5000 = 200
  const short = sampleOf({ model: 'm', startedAt: 0, frames: stream(11, 100, 0), outputTokens: 1200, source: 'probe' })! // 1200/1000 = 1200
  const s = summarize([long, short])
  assert.equal(s.n, 2)
  assert.equal(s.tpsMin, 200)
  assert.equal(s.tpsMax, 1200)
  // 加权中位由 decode 更长的 long 主导
  assert.equal(s.tpsWMedian, 200)
  // 聚合 = 2200 / 6s
  assert.equal(Math.round(s.tpsAggregate!), Math.round(2200 / 6))
  assert.equal(s.outputTokens, 2200)
})

test('summarize 忽略不可测样本，空集返回 n=0', () => {
  const batch = sampleOf({ model: 'm', startedAt: 0, frames: stream(2, 10, 0), outputTokens: 500, source: 'dsh' })!
  assert.equal(summarize([batch]).n, 0)
  assert.deepEqual(summarize([]), { n: 0, outputTokens: 0, decodeMs: 0 })
})

// ── 与 dsh 口径的对账 ────────────────────────────────────────────────────────

test('compareWithDsh 复现 dsh 虚高：批式短步被抬高', () => {
  // 首帧 1000，末帧 1037，message 落在 1037（同一毫秒收尾）
  const cmp = compareWithDsh({ startedAt: 0, firstTokenTime: 1000, lastTokenTime: 1037, messageTime: 1037, outputTokens: 217 })
  assert.equal(Math.round(cmp.realTps!), Math.round(217 / 0.037))
  assert.deepEqual(compareWithDsh({ startedAt: 0, firstTokenTime: 1000, messageTime: 1037, outputTokens: 217 }), {})
})

test('compareWithDsh 在流式长回答上倍率接近 1', () => {
  const cmp = compareWithDsh({ startedAt: 0, firstTokenTime: 2000, lastTokenTime: 12000, messageTime: 12100, outputTokens: 1000 })
  assert.equal(cmp.realTps, 100)
  assert.equal(Math.round(cmp.implTps!), 99) // 收尾那 100ms 只稀释 1%
  assert.ok(Math.abs(cmp.inflation! - 1) < 0.02)
})

// ── Magpie 网关记账换算 ──────────────────────────────────────────────────────

test('fromMagpieModelRow 用 decode_out/decode_ms，并报出覆盖率', () => {
  // 真机读数：agy-cli/gemini-4-neon 30 天
  const row = {
    id: 'agy-cli/gemini-4-neon',
    calls: 767,
    timed: 765,
    decode_n: 27,
    ttft_ms: 11_577_036,
    decode_ms: 394_638,
    decode_out: 46_305,
    output: 730_630,
  }
  const r = fromMagpieModelRow(row)
  assert.equal(r.id, 'agy-cli/gemini-4-neon')
  assert.equal(Math.round(r.tps!), 117) // 46305 / 394.638s
  assert.equal(Math.round(r.naiveTps!), 1851) // 全量 output / 同一分母 —— 虚高 16 倍
  assert.equal(r.coverage, 0.035) // 27/765：这个「速度」只覆盖 3.5% 的调用
  assert.equal(Math.round(r.ttftMs!), 15_133) // 11.58e6 / 765
})

test('fromMagpieModelRow 对未记解码的行不编数字', () => {
  assert.deepEqual(fromMagpieModelRow({ id: 'x/y', calls: 5 }), { id: 'x/y', calls: 5 })
})
