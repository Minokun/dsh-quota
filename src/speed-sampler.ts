/**
 * 被动测速采样器：把真实对话里每一路模型流变成每模型的逐次读数。
 *
 * 为什么要被动而不是主动探测：主动探测要花钱、要等 TTFT（Antigravity 一次
 * 7~15s），而且测的是「此刻这一次」；真实会话里本来就有上百次调用，把它们
 * 的时间戳留下就是最贴近用户体感的样本，代价为 0。
 *
 * 数据源选 **`agent/assistant-stream` 的 chunk 帧**而不是 `assistant/message`
 * 里压缩后的 stream：前者带 writer 侧真实到达时间（`frame.time`）且是逐帧的，
 * 后者会把连续增量打包成 run（`time0` + `dt` 队列），复算时容易把同一批次的
 * 多个增量算成 0ms 间隔——dsh 自己那列 tps 就是被批式上游坑在这里。
 *
 * 三条硬规矩（全部在 speed-metrics.ts 里单测过）：
 *   1. 只认携带内容的增量；usage/block-start/finish 不是 token。
 *   2. 增量 < 4 帧 或 decode < 250ms → 判为「批式上游·不可测」，只记次数，
 *      绝不参与 tps 汇总（否则就是 2000 tok/s 那种假数字）。
 *   3. 存活时长超过阈值就摊薄：一次读数占 {value, weight}，而不是把
 *      `{ caught: n, skipped: n, ... }` 整个结构按引用改几百份。
 * @module dsh-quota/speed-sampler
 */

import { sampleOf, type SpeedSample, type TokenFrame } from './speed-metrics.ts'

/** 一次调用在写日志时的用途：它所属的模型、以及是否失败/中断。 */
export interface SamplerIdentity {
  model: string
  startedAt: number
}

/** 单个模型的累计统计（面板卡片上显示的就是它）。 */
export interface ModelSpeedStats {
  /** 真正可测（流式且 decode 够长）的调用数。 */
  n: number
  /** outputTokens 之和（只计可测调用）。 */
  outputTokens: number
  /** decode 毫秒之和（只计可测调用）。 */
  decodeMs: number
  /** Σoutput / Σdecode：总吞吐（可测调用的整体速度）。 */
  tpsAggregate?: number
  /** 逐次读数的加权中位数：每次调用「典型」有多快。 */
  tpsTypical?: number
  /** 最小/最大单次读数（只在样本足够时给，避免一次性尖刺主导）。 */
  tpsMin?: number
  tpsMax?: number
  /** TTFT 中位（毫秒，首帧内容 − 请求发出）。 */
  ttftMedianMs?: number
  /** 整条回完的中位速度：outputTokens /（首帧 → 末帧 + 前面的静默）。 */
  bodyTpsMedian?: number
  /** 被丢弃的调用数（批式/过短）。 */
  skipped: number
  /** 被丢弃调用里「批式投递」的字符/秒中位，用来解释「为什么不可测」。 */
  skippedCharsPerSecond?: number
  /** 最近一次可测读数。 */
  lastAt?: number
  lastTps?: number
}

/** 结论：卡片上给用户看的一句话（由 toModelSpeedSummary 生成）。 */
export interface ModelSpeedSummary {
  model: string
  n: number
  skipped: number
  /** 'stream' 正常流式 / 'batched' 只有批式样本 / 'none' 还没样本。 */
  kind: 'stream' | 'batched' | 'none'
  tpsAggregate?: number
  tpsTypical?: number
  ttftMedianMs?: number
  bodyTpsMedian?: number
  lastTps?: number
  lastAt?: number
}

/** 逐次读数的有界环形缓冲（面板只画最近 N 次）。 */
export const RECENT_READINGS = 40

/**
 * 逐模型采样的累加器。纯内存 + 纯函数式写入，可单测；持久化由
 * {@link SpeedStore} 负责（见 speed-store.ts）。
 */
export class SpeedAccumulator {
  private readonly byModelMap = new Map<string, {
    stats: ModelSpeedStats
    /** 用于算加权中位的逐次读数（有界）。 */
    readings: Array<{ tps: number; weight: number; ttftMs?: number; bodyTps?: number }>
    skippedCps: number[]
    seen: number
  }>()

  /**
   * 记一次调用。
   * @param sample - sampleOf() 的产物（tps 为空表示不可测）。
   * @returns 本次是否计入可测统计。
   */
  record(sample: SpeedSample): boolean {
    const entry = this.entry(sample.model)
    entry.seen += 1
    const measurable = sample.tps !== undefined && sample.tps > 0 && sample.timing.decodeMs > 0
    if (!measurable) {
      entry.stats.skipped += 1
      if (sample.charsPerSecond > 0) {
        entry.skippedCps.push(sample.charsPerSecond)
        if (entry.skippedCps.length > RECENT_READINGS * 2) entry.skippedCps.shift()
      }
      return false
    }
    const stats = entry.stats
    stats.n += 1
    stats.outputTokens += sample.outputTokens ?? 0
    stats.decodeMs += sample.timing.decodeMs
    stats.lastAt = sample.at
    stats.lastTps = sample.tps
    entry.readings.push({
      tps: sample.tps!,
      weight: sample.timing.decodeMs,
      ...(sample.timing.ttftMs === undefined ? {} : { ttftMs: sample.timing.ttftMs }),
      ...(sample.bodyTps === undefined ? {} : { bodyTps: sample.bodyTps }),
    })
    if (entry.readings.length > RECENT_READINGS) entry.readings.shift()
    return true
  }

  /** 某个模型的当前统计（不存在时 undefined）。 */
  statsOf(model: string): ModelSpeedStats | undefined {
    const entry = this.byModelMap.get(model)
    return entry === undefined ? undefined : this.snapshot(model, entry)
  }

  /** 全部模型的当前统计（按可测样本数降序）。 */
  all(): Array<{ model: string; stats: ModelSpeedStats }> {
    const out: Array<{ model: string; stats: ModelSpeedStats }> = []
    for (const model of this.byModelMap.keys()) {
      const stats = this.statsOf(model)
      if (stats !== undefined && (stats.n > 0 || stats.skipped > 0)) out.push({ model, stats })
    }
    return out.sort((a, b) => b.stats.n - a.stats.n || (b.stats.lastAt ?? 0) - (a.stats.lastAt ?? 0))
  }

  /**
   * 从上次落盘的缓存恢复（进程重启后不至于从零累计）。
   *
   * 只恢复**累计统计**保存的那份数字，不重放逐次读数：重放会让加权中位被
   * 已经算过一遍的老样本重复加权。已在内存里的模型取较大者，避免把本次
   * 进程新采的样本覆盖掉。
   * @param saved - speed-store 读回的内容。
   * @returns 实际合并的模型数。
   */
  hydrate(saved: Record<string, { stats: ModelSpeedStats }>): number {
    let merged = 0
    for (const [model, row] of Object.entries(saved)) {
      const existing = this.byModelMap.get(model)
      if (existing === undefined) {
        this.byModelMap.set(model, { stats: { ...row.stats }, readings: [], skippedCps: [], seen: row.stats.n + row.stats.skipped })
        merged += 1
        continue
      }
      // 本地已有样本：保留本地（它的 tpsTypical 来自真实读数），只补齐次数。
      const stats = existing.stats
      stats.n = Math.max(stats.n, row.stats.n)
      stats.skipped = Math.max(stats.skipped, row.stats.skipped)
      stats.outputTokens = Math.max(stats.outputTokens, row.stats.outputTokens)
      stats.decodeMs = Math.max(stats.decodeMs, row.stats.decodeMs)
      if (stats.lastAt === undefined || (row.stats.lastAt ?? 0) > stats.lastAt) {
        stats.lastAt = row.stats.lastAt
        stats.lastTps = row.stats.lastTps
      }
      merged += 1
    }
    return merged
  }

  /** 清空（测试/重置）。 */
  clear(): void {
    this.byModelMap.clear()
  }

  private entry(model: string) {
    let entry = this.byModelMap.get(model)
    if (entry === undefined) {
      entry = { stats: { n: 0, outputTokens: 0, decodeMs: 0, skipped: 0 }, readings: [], skippedCps: [], seen: 0 }
      this.byModelMap.set(model, entry)
    }
    return entry
  }

  private snapshot(model: string, entry: ReturnType<SpeedAccumulator['entry']>): ModelSpeedStats {
    const stats = { ...entry.stats }
    if (entry.readings.length > 0) {
      stats.tpsTypical = weighted(entry.readings.map((r) => ({ value: r.tps, weight: r.weight })))
      stats.tpsAggregate = stats.decodeMs > 0 ? stats.outputTokens / (stats.decodeMs / 1000) : undefined
      const tps = entry.readings.map((r) => r.tps)
      if (tps.length >= 3) {
        stats.tpsMin = Math.min(...tps)
        stats.tpsMax = Math.max(...tps)
      }
      stats.ttftMedianMs = median(entry.readings.map((r) => r.ttftMs).filter((v): v is number => typeof v === 'number'))
      stats.bodyTpsMedian = median(entry.readings.map((r) => r.bodyTps).filter((v): v is number => typeof v === 'number'))
    }
    if (entry.skippedCps.length > 0) {
      const cps = [...entry.skippedCps].sort((a, b) => a - b)
      stats.skippedCharsPerSecond = cps[cps.length >> 1]
    }
    return stats
  }
}

/** 中位数（空集 undefined）。 */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : ((s[mid - 1]! + s[mid]!) / 2)
}

/** 加权中位（权重 ≤0 的样本忽略）。 */
function weighted(values: ReadonlyArray<{ value: number; weight: number }>): number | undefined {
  const usable = values.filter((v) => Number.isFinite(v.value) && Number.isFinite(v.weight) && v.weight > 0)
  if (usable.length === 0) return undefined
  const total = usable.reduce((sum, v) => sum + v.weight, 0)
  const sorted = [...usable].sort((a, b) => a.value - b.value)
  let acc = 0
  for (const v of sorted) {
    acc += v.weight
    if (acc >= total / 2) return v.value
  }
  return sorted[sorted.length - 1]!.value
}

/**
 * 面板用的一句话结论。
 * @param model - 模型 id。
 * @param stats - 统计；undefined 表示还没样本。
 * @returns 结论；`kind: 'batched'` 时只报被丢弃的批式字符/秒。
 */
export function toModelSpeedSummary(model: string, stats: ModelSpeedStats | undefined): ModelSpeedSummary {
  if (stats === undefined || (stats.n === 0 && stats.skipped === 0)) {
    return { model, n: 0, skipped: 0, kind: 'none' }
  }
  if (stats.n === 0) {
    return { model, n: 0, skipped: stats.skipped, kind: 'batched' }
  }
  return {
    model,
    n: stats.n,
    skipped: stats.skipped,
    kind: 'stream',
    ...(stats.tpsAggregate === undefined ? {} : { tpsAggregate: stats.tpsAggregate }),
    ...(stats.tpsTypical === undefined ? {} : { tpsTypical: stats.tpsTypical }),
    ...(stats.ttftMedianMs === undefined ? {} : { ttftMedianMs: stats.ttftMedianMs }),
    ...(stats.bodyTpsMedian === undefined ? {} : { bodyTpsMedian: stats.bodyTpsMedian }),
    ...(stats.lastTps === undefined ? {} : { lastTps: stats.lastTps }),
    ...(stats.lastAt === undefined ? {} : { lastAt: stats.lastAt }),
  }
}

/** 由帧与调用身份构造一次真实会话样本（`source: 'dsh'`）。 */
export function sampleFromFrames(input: {
  model: string
  startedAt: number
  frames: readonly TokenFrame[]
  outputTokens?: number
}): SpeedSample | undefined {
  return sampleOf({ ...input, source: 'dsh' })
}
