/**
 * Host 半边的被动测速采集：订阅 `agent/assistant-stream`，把每一路真实
 * 模型流折算成 {模型 → 读数}，供面板在各平台卡片里展示。
 *
 * 事件形状（dsh 0.2.x，见 dsh-agent/src/runtime-types.ts）：
 *   - `start`  ：{ attemptId, revision, turn, step }
 *   - `chunk`  ：{ attemptId, revision, index, time, chunk }   ← time 是 writer 侧真实到达时刻
 *   - `end`    ：{ attemptId, revision, index, outcome }
 *
 * 一次 attempt 从 start 到 end 的全部 chunk 帧喂给 speed-sampler；`usage`
 * chunk（若上游给出）提供 outputTokens。没有 usage 也照样计样本——只是没有
 * token 分母，此时只出字符/秒（面板会标「无 usage」），而不是编一个 tok/s。
 *
 * 为什么不用 `assistant/message` 里压缩后的 stream：那里连续增量被合并成
 * run（time0 + dt），复算时同一批次的多帧间隔为 0，正是 dsh 自己那列 tps
 * 被批式上游坑爆的原因（见 speed-metrics.ts 的模块注释）。
 *
 * **为什么也不直接用 `frame.time`**：实测 Antigravity 这类走网关重放的路径
 * 会把「原始生成时间」原样带过来，首帧的 time 甚至比本步请求发出早了两百多
 * 万毫秒（负 TTFT）。那种时间戳描述的是上游旧的生成过程，不是这条请求在这台
 * 机器上的体感。所以这里一律用**本进程收到帧的时刻**（`now()`）计时——和
 * 用户在屏幕上看到字的时间严格一致。`frame.time` 只作为「帧确实带时间」的
 * 存在性判断，不参与计算。
 * @module dsh-quota/speed-sampler-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { sampleFromFrames, SpeedAccumulator } from './speed-sampler.ts'
import type { TokenFrame } from './speed-metrics.ts'

/** 一个 attempt 的累积状态。 */
interface AttemptState {
  startedAt: number
  model: string
  frames: TokenFrame[]
  outputTokens?: number
}

/** 结构化的 stream chunk 面孔（只读这里用到的字段）。 */
interface ChunkLike {
  type?: unknown
  text?: unknown
  argumentsDelta?: unknown
  name?: unknown
  usage?: { outputTokens?: unknown }
}

/** 一帧 → token 片段（与 speed-collector.frameOfChunk 同口径）。 */
function frameOf(chunk: ChunkLike, time: number): TokenFrame | undefined {
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
    return { time, chars: chunk.text.length, kind: 'text' }
  }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
    return { time, chars: chunk.text.length, kind: 'reasoning' }
  }
  if (chunk.type === 'tool-call-delta') {
    const args = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    const name = typeof chunk.name === 'string' ? chunk.name : ''
    if (args !== '' || name !== '') return { time, chars: args.length + name.length, kind: 'tool' }
  }
  return undefined
}

/** 采集器：把事件流折叠成累加器，并在每个 attempt 结束时调用 onSample。 */
export class PassiveSpeedSampler {
  readonly acc = new SpeedAccumulator()
  private readonly attempts = new Map<string, AttemptState>()

  private readonly onComplete: ((model: string) => void) | undefined
  private readonly now: () => number

  /**
   * @param onComplete - 每次 attempt 结束时回调（用于落盘节流）。
   *
   * 注意：此处显式声明字段而不是构造器参数属性——本仓库的测试用
   * `node --experimental-strip-types`（strip-only）跑，参数属性会在加载期
   * 直接 SyntaxError，并且会顺带炸掉所有 import 本模块的测试。
   */
  constructor(onComplete?: (model: string) => void, now: () => number = Date.now) {
    this.onComplete = onComplete
    this.now = now
  }

  /**
   * 处理一帧。
   * @param frame - `agent/assistant-stream` 的 payload.frame。
   * @param resolveModel - 该 attempt 所属模型（从 agent 现场读，不缓存）。
   */
  handle(frame: { type?: unknown; attemptId?: unknown; chunk?: unknown }, resolveModel: () => string): void {
    const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : undefined
    if (attemptId === undefined) return
    if (frame.type === 'start') {
      this.attempts.set(attemptId, { startedAt: this.now(), model: resolveModel(), frames: [] })
      return
    }
    if (frame.type === 'chunk') {
      const state = this.attempts.get(attemptId)
      if (state === undefined) return
      const chunk = (frame.chunk ?? {}) as ChunkLike
      if (chunk.type === 'usage') {
        const out = chunk.usage?.outputTokens
        if (typeof out === 'number' && out > 0) state.outputTokens = out
        return
      }
      // 一律用本端到达时刻：frame.time 可能是上游重放的历史时间戳（见模块注释）。
      const time = this.now()
      const fragment = frameOf(chunk, time)
      if (fragment !== undefined) state.frames.push(fragment)
      return
    }
    if (frame.type === 'end') {
      const state = this.attempts.get(attemptId)
      this.attempts.delete(attemptId)
      if (state === undefined || state.frames.length === 0) return
      const sample = sampleFromFrames({
        model: state.model,
        startedAt: state.startedAt,
        frames: state.frames,
        ...(state.outputTokens === undefined ? {} : { outputTokens: state.outputTokens }),
      })
      if (sample === undefined) return
      this.acc.record(sample)
      this.onComplete?.(state.model)
    }
  }

  /** 挂到 ctx 上；返回的 disposer 由 ctx.effect 负责。 */
  install(ctx: Context): void {
    ctx.effect(() => {
      const dispose = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        this.handle(frame as never, () => {
          const current = agent.model.current()
          return current === undefined ? 'unknown' : `${current.provider}/${current.model}`
        })
      }, { global: true } as never)
      return () => {
        dispose()
        this.attempts.clear()
      }
    })
  }
}
