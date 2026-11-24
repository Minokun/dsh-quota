/**
 * 测速统计的落盘缓存。
 *
 * 为什么和 history.json 分开：history.json 是「限额时序」（配额百分比，按
 * `${providerId}::${label}` 分片、14 天保留）；这里是「每次调用的解码读数」，
 * 形状与生命周期都不一样（模型维度、按调用累计、要留 TTFT 分布）。硬塞进
 * 同一个文件会让两个模块互相写坏对方的结构。
 *
 * 默认 `$DSH_HOME/dsh-quota/speed.json`，可用 `DSH_QUOTA_SPEED_FILE` 覆盖。
 * 只存数值，不含凭据；读坏了一律回退空（采样可以重新积累，绝不因此让插件
 * 起不来）。
 * @module dsh-quota/speed-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelSpeedStats } from './speed-sampler.ts'

/** 文件格式版本（形状不兼容变更时递增）。 */
const FILE_VERSION = 1

/** 一个模型的持久化记录：统计 + 逐次读数（有界）。 */
export interface PersistedModelSpeed {
  stats: ModelSpeedStats
  /** 最近 N 次读数：[epochMs, tps]（只留可测样本，用于面板画点）。 */
  recent: Array<[number, number]>
}

/** 整份缓存：模型 id → 记录。 */
export type PersistedSpeed = Record<string, PersistedModelSpeed>

/** 缓存落盘路径：`$DSH_HOME/dsh-quota/speed.json`（无 DSH_HOME 时退到 ~/.dsh）。 */
export function speedFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.DSH_QUOTA_SPEED_FILE?.trim()
  if (override) return override
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'dsh-quota', 'speed.json')
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 解析落盘内容。任何不认识的行直接丢掉——宁可少一个模型，也不要让一个
 * 半截字段把面板渲染成 NaN。
 * @param text - 文件内容。
 * @returns 解析后的缓存；损坏时返回 {}。
 */
export function parseSpeedFile(text: string): PersistedSpeed {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const raw = (parsed as { speed?: unknown } | null)?.speed ?? parsed
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PersistedSpeed = {}
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const row = value as { stats?: unknown; recent?: unknown }
    const s = (row.stats ?? {}) as Record<string, unknown>
    const n = num(s.n)
    if (n === undefined || n < 0) continue
    const recent: Array<[number, number]> = []
    for (const point of Array.isArray(row.recent) ? row.recent : []) {
      if (!Array.isArray(point) || point.length !== 2) continue
      const [t, v] = point as [unknown, unknown]
      const tt = num(t)
      const vv = num(v)
      if (tt !== undefined && vv !== undefined) recent.push([tt, vv])
    }
    out[model] = {
      stats: {
        n,
        outputTokens: num(s.outputTokens) ?? 0,
        decodeMs: num(s.decodeMs) ?? 0,
        skipped: num(s.skipped) ?? 0,
        ...(num(s.tpsAggregate) === undefined ? {} : { tpsAggregate: num(s.tpsAggregate) }),
        ...(num(s.tpsTypical) === undefined ? {} : { tpsTypical: num(s.tpsTypical) }),
        ...(num(s.tpsMin) === undefined ? {} : { tpsMin: num(s.tpsMin) }),
        ...(num(s.tpsMax) === undefined ? {} : { tpsMax: num(s.tpsMax) }),
        ...(num(s.ttftMedianMs) === undefined ? {} : { ttftMedianMs: num(s.ttftMedianMs) }),
        ...(num(s.bodyTpsMedian) === undefined ? {} : { bodyTpsMedian: num(s.bodyTpsMedian) }),
        ...(num(s.skippedCharsPerSecond) === undefined ? {} : { skippedCharsPerSecond: num(s.skippedCharsPerSecond) }),
        ...(num(s.lastAt) === undefined ? {} : { lastAt: num(s.lastAt) }),
        ...(num(s.lastTps) === undefined ? {} : { lastTps: num(s.lastTps) }),
      },
      recent,
    }
  }
  return out
}

/** 读缓存；文件不存在 / 不可读都当作空。 */
export async function loadSpeedFile(path: string): Promise<PersistedSpeed> {
  try {
    return parseSpeedFile(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

/** 原子写入缓存（临时文件 + rename，避免读到半截 JSON）。 */
export async function saveSpeedFile(path: string, speed: PersistedSpeed): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: FILE_VERSION, speed })}\n`, 'utf8')
  await rename(tmp, path)
}
