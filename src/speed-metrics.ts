/**
 * 模型测速的纯函数层：把「一次流式响应的事件时间戳」折成可信的 tok/s。
 *
 * 为什么单独一层：dsh 自带的 Statistics 表里那一列 `tps` 用的是
 * `outputTokens / (assistant/message 时间 − 第一个 ≥300ms 的关键 chunk 时间)`。
 * 分母里混进了三类与解码无关的耗时——网关排队/思考那段静默、整条消息的收尾
 * （最后一个 token 到 message 事件）、以及任何夹在流中的非 token 帧——而分子是
 * **全量** outputTokens。于是短输出会被抬高几倍到几十倍：一个 217 token、
 * 解码只占 37ms 的步被渲染成 5865 tok/s，正是「Antigravity 一直 2000+」的来源。
 *
 * 本模块的口径（每一段都必须能追溯到具体时间戳）：
 *   - 只把**携带内容的增量**算作 token：text-delta / reasoning-delta / tool-call-delta
 *     （含 argumentsDelta 或 name）。usage、block-start、finish 等不算。
 *   - ttft  = 首帧内容 − 请求发出
 *   - decode = 末帧内容 − 首帧内容          ← 真正在吐字的墙钟区间
 *   - tps   = outputTokens / decode
 *   - body  = outputTokens / (末帧内容 − 请求发出)   ← 用户体感的「整条回完」速度
 *
 * 两条守则（缺了就会重蹈 dsh 的覆辙）：
 *   1. 增量少于 {@link MIN_DELTA_FRAMES} 或 span 短于 {@link MIN_DECODE_MS} 的样本
 *      直接丢弃——批式/缓冲式上游一次吐完时，span≈0 会把 tps 推到无穷大。
 *   2. 汇总只用**加权中位**：aggregate（Σoutput/Σdecode）被长回答主导，
 *      plain median 忽略回答长度，两者都会误导；加权中位让「每次调用典型有多快」
 *      和「一共吐了多少字多快」同时成立。
 * @module dsh-quota/speed-metrics
 */

/** 一个 token 片段：到达时刻 + 携带的字符数 + 种类。 */
export interface TokenFrame {
  /** epoch 毫秒（上游/网关时间戳，缺省时才退回收到时刻）。 */
  time: number
  chars: number
  kind: 'text' | 'reasoning' | 'tool'
}

/** 一次流式响应的计时。 */
export interface CallTiming {
  /** 请求发出 → 首帧内容（毫秒）；无 token 时为 undefined。 */
  ttftMs?: number
  /** 首帧内容 → 末帧内容（毫秒）。 */
  decodeMs: number
  /** 首帧 → 末帧之间到达的增量帧数。 */
  frames: number
  /** 请求发出 → 末帧内容（毫秒）。 */
  bodyMs: number
}

/** 一次样本：一次调用（或一个会话步）的可信测速读数。 */
export interface SpeedSample {
  /** epoch 毫秒（末帧时间）。 */
  at: number
  /** 模型 id（`agy-cli/gemini-4-neon` 这类 `<provider>/<model>`）。 */
  model: string
  /** 输出 token（上游 usage 读数，缺失时为 undefined）。 */
  outputTokens?: number
  timing: CallTiming
  /** outputTokens / decode。 */
  tps?: number
  /** outputTokens / body。 */
  bodyTps?: number
  /** 每秒字符数：没有 usage 时的退路（token 数未知，但字符数一定可信）。 */
  charsPerSecond: number
  /** 采样来源：`dsh` = 本会话流；`probe` = 主动探测。 */
  source: 'dsh' | 'probe'
}

/** 丢弃门槛：增量帧少于这个数就不是「流式」，一分钱精度都没有。 */
export const MIN_DELTA_FRAMES = 4
/** 丢弃门槛：decode 区间短于这个值，计时误差（连接复用、调度抖动）会主导结果。 */
export const MIN_DECODE_MS = 250
/** dsh 的 firstTokenTime 用的就是 300ms 这个门槛（见 stats-fold.ts），这里显式对齐以便复算。 */
export const DSH_FIRST_TOKEN_GATE_MS = 300

/** 汇总统计。 */
export interface SpeedSummary {
  n: number
  /** 加权中位：按 decode 毫秒加权。 */
  tpsWMedian?: number
  /** Σoutput / Σdecode：长回答主导的「总吞吐」。 */
  tpsAggregate?: number
  /** 最小/最大单次 tps。 */
  tpsMin?: number
  tpsMax?: number
  /** ttft 中位（毫秒）。 */
  ttftMedianMs?: number
  /** 样本总输出 token。 */
  outputTokens: number
  /** Σdecode 毫秒。 */
  decodeMs: number
  /** 字符/秒加权中位。 */
  charsPerSecondMedian?: number
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : ((s[mid - 1]! + s[mid]!) / 2)
}

/**
 * 加权中位：权重通常用 decode 毫秒（越长的解码区间越可信）。
 * @param values - 取值与权重（同长度；权重 ≤0 的样本被忽略）。
 * @returns 加权中位，空集为 undefined。
 */
export function weightedMedian(values: readonly { value: number; weight: number }[]): number | undefined {
  const usable = values.filter((v) => finite(v.value) && finite(v.weight) && v.weight > 0)
  if (usable.length === 0) return undefined
  const total = usable.reduce((sum, v) => sum + v.weight, 0)
  const target = total / 2
  const sorted = [...usable].sort((a, b) => a.value - b.value)
  let acc = 0
  for (const v of sorted) {
    acc += v.weight
    if (acc >= target) return v.value
  }
  return sorted[sorted.length - 1]!.value
}

/**
 * 由「请求发出时刻 + 首帧/末帧时刻 + 输出 token」算出计时。
 * @param startedAt - 请求发出（epoch 毫秒）。
 * @param frames - 按到达顺序排好的 token 片段。
 * @returns 计时；没有 token 帧时 undefined。
 */
export function timingOf(startedAt: number, frames: readonly TokenFrame[]): CallTiming | undefined {
  const timed = frames.filter((f) => finite(f.time))
  if (timed.length === 0) return undefined
  const first = timed[0]!
  const last = timed[timed.length - 1]!
  const decodeMs = Math.max(0, last.time - first.time)
  const bodyMs = Math.max(decodeMs, last.time - startedAt)
  return {
    ttftMs: Math.max(0, first.time - startedAt),
    decodeMs,
    frames: timed.length,
    bodyMs,
  }
}

/**
 * 一次调用的完整读数。样本不合格时 tps 为 undefined（但仍返回字符/秒，
 * 让「上游是批式吐出」这件事在面板上可见，而不是变成一条 0 或无穷大）。
 * @param input - 模型、起点、帧、输出 token、来源。
 * @returns 样本；连 token 帧都没有时 undefined。
 */
export function sampleOf(input: {
  model: string
  startedAt: number
  frames: readonly TokenFrame[]
  outputTokens?: number
  source: SpeedSample['source']
}): SpeedSample | undefined {
  const timing = timingOf(input.startedAt, input.frames)
  if (timing === undefined) return undefined
  const chars = input.frames.reduce((sum, f) => sum + f.chars, 0)
  const out = finite(input.outputTokens) ? input.outputTokens : undefined
  const measurable = timing.frames >= MIN_DELTA_FRAMES && timing.decodeMs >= MIN_DECODE_MS
  const tps = measurable && out !== undefined && out > 0 ? out / (timing.decodeMs / 1000) : undefined
  const bodyTps = measurable && out !== undefined && out > 0 ? out / (timing.bodyMs / 1000) : undefined
  return {
    at: input.frames[input.frames.length - 1]?.time ?? input.startedAt,
    model: input.model,
    ...(out === undefined ? {} : { outputTokens: out }),
    timing,
    ...(tps === undefined ? {} : { tps }),
    ...(bodyTps === undefined ? {} : { bodyTps }),
    charsPerSecond: measurable && chars > 0 ? chars / (timing.decodeMs / 1000) : 0,
    source: input.source,
  }
}

/**
 * 汇总一组样本（同模型同来源）。
 * @param samples - 已合格的样本。
 * @returns 统计；空集返回 n=0。
 */
export function summarize(samples: readonly SpeedSample[]): SpeedSummary {
  const usable = samples.filter((s) => finite(s.tps) && s.tps > 0 && s.timing.decodeMs > 0)
  if (usable.length === 0) {
    return { n: 0, outputTokens: 0, decodeMs: 0 }
  }
  const tpsList = usable.map((s) => s.tps!)
  const outSum = usable.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0)
  const decSum = usable.reduce((sum, s) => sum + s.timing.decodeMs, 0)
  const ttfts = usable.map((s) => s.timing.ttftMs).filter(finite)
  const cps = usable
    .filter((s) => s.charsPerSecond > 0)
    .map((s) => ({ value: s.charsPerSecond, weight: s.timing.decodeMs }))
  return {
    n: usable.length,
    tpsWMedian: weightedMedian(usable.map((s) => ({ value: s.tps!, weight: s.timing.decodeMs }))),
    tpsAggregate: decSum > 0 && outSum > 0 ? outSum / (decSum / 1000) : undefined,
    tpsMin: Math.min(...tpsList),
    tpsMax: Math.max(...tpsList),
    ttftMedianMs: median(ttfts),
    outputTokens: outSum,
    decodeMs: decSum,
    charsPerSecondMedian: weightedMedian(cps),
  }
}

/** 一次 readout 的对账（复算 dsh 的口径与正确口径的差）。 */
export interface ImplComparison {
  /** dsh 表里的算法：output / (message 时刻 − 首个 ≥300ms 的关键 chunk)。 */
  implTps?: number
  implMs?: number
  /** 正确算法：output / (末帧内容 − 首帧内容)。 */
  realTps?: number
  realMs?: number
  /** 虚高倍数（impl / real）；<1.05 时视为一致。 */
  inflation?: number
}

/**
 * 用同一份时间戳复算 dsh 的 tps，与正确口径对比——这是「dsh 表格为什么不对」的
 * 可复核证据，也是面板上「dsh 口径 · 虚高 N 倍」那一行的数据来源。
 * @param input - 输出 token、请求发出/首帧/末帧/message 四个时刻。
 * @returns 两种口径与其倍率；缺少必要时刻时字段缺失。
 */
export function compareWithDsh(input: {
  startedAt: number
  firstTokenTime?: number
  lastTokenTime?: number
  messageTime?: number
  outputTokens?: number
}): ImplComparison {
  const out = input.outputTokens
  const first = input.firstTokenTime
  const last = input.lastTokenTime
  if (!finite(out) || out <= 0 || !finite(first) || !finite(last)) return {}
  const realMs = last - first
  const realTps = realMs > 0 ? out / (realMs / 1000) : undefined
  const message = input.messageTime
  const implMs = finite(message) && message > first ? message - first : undefined
  const implTps = implMs !== undefined && implMs > 0 ? out / (implMs / 1000) : undefined
  const inflation = implTps !== undefined && realTps !== undefined && realTps > 0 ? implTps / realTps : undefined
  return {
    ...(implTps === undefined ? {} : { implTps }),
    ...(implMs === undefined ? {} : { implMs }),
    ...(realTps === undefined ? {} : { realTps }),
    ...(realMs > 0 ? { realMs } : {}),
    ...(inflation === undefined ? {} : { inflation: Number(inflation.toFixed(2)) }),
  }
}

/**
 * 换算 Magpie `/v1/magpie/usage` 的模型行。网关自己也记 ttft/decode，
 * 但它的 `output` 是**包含未计入 decode 的调用**的全量输出（`decode_out` 只覆盖
 * `decode_n` 次），所以 Σoutput/Σdecode 会虚高；正确做法是用 `decode_out/decode_ms`，
 * 并报出覆盖率 `decode_n/calls`。
 * @param row - `models[]` 里的一行。
 * @returns 读数；网关未记解码时 tps 缺失。
 */
export function fromMagpieModelRow(row: Record<string, unknown>): {
  id?: string
  calls?: number
  timed?: number
  decodeN?: number
  /** decode_n 相对 calls 的覆盖率（0..1）。 */
  coverage?: number
  ttftMs?: number
  tps?: number
  /** 用全量 output 除以 decode_ms 的错误口径——保留它只为展示偏差。 */
  naiveTps?: number
} {
  const num = (v: unknown): number | undefined => (finite(v) ? v : undefined)
  const calls = num(row.calls)
  const timed = num(row.timed)
  const decodeN = num(row.decode_n)
  const ttft = num(row.ttft_ms)
  const decodeMs = num(row.decode_ms)
  const decodeOut = num(row.decode_out)
  const output = num(row.output)
  const tps = decodeMs !== undefined && decodeMs > 0 && decodeOut !== undefined ? decodeOut / (decodeMs / 1000) : undefined
  const naiveTps = decodeMs !== undefined && decodeMs > 0 && output !== undefined ? output / (decodeMs / 1000) : undefined
  return {
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    ...(calls === undefined ? {} : { calls }),
    ...(timed === undefined ? {} : { timed }),
    ...(decodeN === undefined ? {} : { decodeN }),
    ...(decodeN !== undefined && timed !== undefined && timed > 0 ? { coverage: Number((decodeN / timed).toFixed(3)) } : {}),
    ...(ttft !== undefined && timed !== undefined && timed > 0 ? { ttftMs: ttft / timed } : {}),
    ...(tps === undefined ? {} : { tps }),
    ...(naiveTps === undefined ? {} : { naiveTps }),
  }
}
