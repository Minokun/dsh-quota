/**
 * 时序样本的落盘缓存。
 *
 * 新版 dsh（≥0.1.6）的 settings 运行时快照只活在内存里（只持久化 volatile
 * 字段），进程一重启 `history` 就清零——「近 7 天实测消耗 / 日均」永远凑不
 * 满一天，面板只能给出基于几十分钟样本的错数字。这里把采样序列单独写成
 * 一个小 JSON 文件（默认 `$DSH_HOME/dsh-quota/history.json`，可用
 * `DSH_QUOTA_HISTORY_FILE` 覆盖），启动后第一次刷新读回并与内存合并。
 *
 * 只存 [epochMs, 数值] 对，不含任何凭据；路径可由 env 覆盖便于测试。
 * @module dsh-quota/history-file
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HistoryMap, Sample } from './insights.ts'

/** 文件格式版本（形状不兼容变更时递增）。 */
const FILE_VERSION = 1

/** 缓存落盘路径：`$DSH_HOME/dsh-quota/history.json`（无 DSH_HOME 时退到 ~/.dsh）。 */
export function historyFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.DSH_QUOTA_HISTORY_FILE?.trim()
  if (override) return override
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'dsh-quota', 'history.json')
}

/**
 * 解析落盘内容；损坏/未知形状一律回退空历史（绝不抛错，采样缓存丢了可以
 * 重新积累）。兼容裸 history 映射（旧版没有 envelope）。
 */
export function parseHistoryFile(text: string): HistoryMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const raw = (parsed as { history?: unknown } | null)?.history ?? parsed
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: HistoryMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const points: Sample[] = []
    for (const point of value) {
      if (!Array.isArray(point) || point.length !== 2) continue
      const [t, v] = point as [unknown, unknown]
      if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(t) || !Number.isFinite(v)) continue
      points.push([t, v])
    }
    if (points.length > 0) out[key] = points
  }
  return out
}

/** 读缓存；文件不存在 / 不可读都当作空历史。 */
export async function loadHistoryFile(path: string): Promise<HistoryMap> {
  try {
    return parseHistoryFile(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

/** 原子写入缓存（临时文件 + rename，避免读到半截 JSON）。 */
export async function saveHistoryFile(path: string, history: HistoryMap): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: FILE_VERSION, history })}\n`, 'utf8')
  await rename(tmp, path)
}
