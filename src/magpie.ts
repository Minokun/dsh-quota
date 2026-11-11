/**
 * Magpie 网关额度适配器：把 dsh-magpie-connector 里配置的线路（lines）与
 * 网关的额度卡片（`/magpie/quotas/cards`）接成一个自动发现的额度行。
 *
 * 为什么单独一层：magpie connector 的额度绑定在线路（一条线路 = 一个网关
 * baseUrl + 一套 `MAGPIE_LINE_<ID>_API_KEY` 凭证），与 DSH 的模型供应商
 * 无关；connector 自己把卡片渲染在侧栏，但 dsh-quota 面板看不到。这里直接
 * 读 connector 的设置文件（`$DSH_HOME/plugins/dsh-magpie-connector/
 * settings.json`），逐条线路拿凭证查网关卡片，按 `provider` 聚合成面板行：
 *
 *   - 订阅/套餐卡（kind=subscription|plan）→ 每个 window 一条额度条目
 *     （`used` 是已用百分比，`resetsAt` 是窗口重置时间）；
 *   - 余额卡（kind=balance）或卡上带 `balance` → 追加一条「余额」条目。
 *
 * 与 subscription.ts 同属「自动发现行」：线路有凭证才查询，没有就整行隐藏；
 * 查询结果带 60s TTL 缓存，避免刷新看门狗把网关的「同一张卡 30s 内最多刷新
 * 一次」限流打爆。
 * @module dsh-quota/magpie
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ProviderSnapshot, QuotaItem } from './config.ts'

/** 单次网关请求超时。 */
const MAGPIE_TIMEOUT_MS = 15000

/** 额度卡片结果的 TTL 缓存时长（成功与失败都缓存）。 */
const MAGPIE_TTL_MS = 60000

/** 面板平台 id 前缀：`magpie-<provider>`（provider 为网关卡片上的 owner）。 */
export const MAGPIE_PLATFORM_PREFIX = 'magpie-'

/**
 * 线路凭证引用：与 dsh-magpie-connector 的 `lineCredentialRefs` 完全一致
 * （`MAGPIE_LINE_<线路 id 大写>_…`），这样 connector 里保存的 key 直接复用，
 * quota 面板不需要第二次填写。
 * @param lineId - connector 线路 id（8 位小写十六进制）。
 */
export function magpieLineRefs(lineId: string): { key: string; accessClientId: string; accessClientSecret: string } {
  const upper = lineId.toUpperCase()
  return {
    key: `MAGPIE_LINE_${upper}_API_KEY`,
    accessClientId: `MAGPIE_LINE_${upper}_ACCESS_CLIENT_ID`,
    accessClientSecret: `MAGPIE_LINE_${upper}_ACCESS_CLIENT_SECRET`,
  }
}

/** connector 线路凭证引用的形状（凭证变更事件用它判断要不要刷新）。 */
export const MAGPIE_LINE_REF = /^MAGPIE_LINE_[0-9A-F]{8}_(?:API_KEY|ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET)$/

/** 一条已保存的线路（connector settings.json 的 lines[] 子集）。 */
export interface MagpieLine {
  id: string
  baseUrl: string
  accessMode: 'direct' | 'cloudflare'
}

/** 网关卡片上的一个额度窗口。 */
export interface MagpieWindow {
  name?: string
  /** 已用百分比（0-100）。 */
  used?: number
  resetsAt?: string
  display?: string
  unlimited?: boolean
}

/** 网关返回的一张额度卡片。 */
export interface MagpieCard {
  provider?: string
  name?: string
  plan?: string
  user?: string
  kind?: string
  windows?: MagpieWindow[]
  balance?: string
  until?: string
  renew?: string
  held?: boolean
  readAt?: string
  error?: string
}

// ── 纯工具 ───────────────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

/** 网关余额字符串（"$45.63" / "$-0.79"）里的数字；解析不出就不给 remaining。 */
function money(v: string | undefined): number | undefined {
  if (!v) return undefined
  const m = /-?\d+(?:\.\d+)?/.exec(v.replace(/,/g, ''))
  return m ? num(m[0]) : undefined
}

/**
 * 窗口名 → 面板标签。网关给的是英文窗口名（"5 hours" / "7 days" /
 * "Weekly" / "Credits"），面板其余行用的是「5 小时窗口」「周额度」这类
 * 中文标签，这里对齐，认不出的窗口名原样透出。
 * @param name - 卡片上的 window.name。
 */
export function windowLabel(name: string | undefined): string {
  const raw = (name ?? '').trim()
  const n = raw.toLowerCase()
  if (!n) return '额度'
  if (/^\d+\s*hour/.test(n) || n === 'hourly') {
    const hours = /^(\d+)/.exec(n)?.[1]
    return hours ? `${hours} 小时窗口` : '小时窗口'
  }
  if (/^\d+\s*day/.test(n)) {
    const days = /^(\d+)/.exec(n)?.[1]
    return days === '7' ? '周额度' : `${days ?? ''} 天窗口`
  }
  if (/^(week|weekly|周)/.test(n)) return '周额度'
  if (/^(month|monthly|月)/.test(n)) return '月额度'
  if (/^(day|daily|24 hours|日)/.test(n)) return '日额度'
  // 网关也可能给中文窗口名（"3 天" / "5 小时"）。
  const cn = /^(\d+)\s*(天|小时)/.exec(raw)
  if (cn) return `${cn[1]} ${cn[2]}窗口`
  if (/credit/.test(n)) return '额度'
  return raw
}

/** 卡片行的展示名：`<name>` 或 `<name> · <plan>`（plan 与 name 相同时不重复）。 */
export function cardLabel(card: MagpieCard, provider: string): string {
  const name = card.name ?? provider
  const plan = card.plan?.trim()
  if (!plan || plan.toLowerCase() === name.toLowerCase()) return name
  return `${name} · ${plan}`
}

/** 百分比取两位小数：网关给的是 55.99251846057143 这种长小数。 */
function percentOf(v: unknown): number | undefined {
  const n = num(v)
  if (n === undefined) return undefined
  return Math.round(n * 100) / 100
}

/**
 * 一张卡片 → 面板条目：每个 window 一条（percent = used，resetAt =
 * resetsAt，有 display 就用 display），另加余额条目。
 * @param card - 网关卡片。
 */
export function cardItems(card: MagpieCard): QuotaItem[] {
  const items: QuotaItem[] = []
  for (const w of card.windows ?? []) {
    const percent = percentOf(w.used)
    const resetAt = str(w.resetsAt)
    const display = str(w.display)
    items.push({
      label: windowLabel(w.name),
      ...(percent === undefined ? {} : { percent }),
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(display === undefined ? {} : { display }),
    })
  }
  const balance = card.balance?.trim()
  if (balance) {
    const remaining = money(balance)
    items.push({ label: '余额', display: balance, ...(remaining === undefined ? {} : { remaining }) })
  }
  return items
}

/**
 * 把一张线路的卡片列表聚合成面板行：按 `provider` 合并（同一 provider 的
 * plan 卡 + 余额卡合成一张卡片），provider 首次出现的顺序即行顺序。
 * @param cards - 网关返回的原始卡片。
 * @param lineId - 线路 id（多线路同 provider 时用于区分行 id）。
 * @param multiLine - 是否有多条线路同时在用（true 时行 id 追加 `#线路 id`）。
 * @param keyRef - 该线路的凭证引用（面板显示「已同步」用）。
 * @param keySource - 凭证来源层。
 */
export function rowsFromCards(
  cards: readonly MagpieCard[],
  lineId: string,
  multiLine: boolean,
  keyRef: string,
  keySource: string,
): ProviderSnapshot[] {
  const groups = new Map<string, { label: string; items: QuotaItem[]; message?: string }>()
  for (const card of cards) {
    const provider = (card.provider ?? '').trim().toLowerCase()
    if (!provider) continue
    const group = groups.get(provider) ?? { label: cardLabel(card, provider), items: [] }
    group.items.push(...cardItems(card))
    const error = card.error?.trim()
    if (error && !group.message) group.message = error
    groups.set(provider, group)
  }
  const rows: ProviderSnapshot[] = []
  for (const [provider, group] of groups) {
    rows.push({
      id: `${MAGPIE_PLATFORM_PREFIX}${provider}${multiLine ? `#${lineId}` : ''}`,
      label: group.label,
      status: group.message ? 'error' : 'ok',
      ...(group.message === undefined ? {} : { message: group.message }),
      via: 'api',
      keyRef,
      keySource,
      items: group.items,
    })
  }
  return rows
}

/**
 * connector settings.json 里的线路：只保留有 baseUrl 的条目（空 baseUrl 表示
 * 用户还没填网关地址），accessMode 缺省按 direct 处理（与 connector 一致）。
 * @param value - settings.json 解析结果。
 */
export function parseLines(value: unknown): MagpieLine[] {
  const root = obj(value)
  const list = Array.isArray(root?.lines) ? root.lines as unknown[] : []
  const out: MagpieLine[] = []
  for (const entry of list) {
    const line = obj(entry)
    const id = str(line?.id)
    const baseUrl = str(line?.baseUrl)
    if (!id || !baseUrl) continue
    const accessMode = line?.accessMode === 'cloudflare' ? 'cloudflare' : 'direct'
    out.push({ id, baseUrl: baseUrl.replace(/\/+$/, ''), accessMode })
  }
  return out
}

/**
 * connector settings.json 的位置（`$DSH_HOME/plugins/dsh-magpie-connector/
 * settings.json`），`DSH_MAGPIE_SETTINGS_FILE` 可覆盖（测试 / 迁移用）。
 * @param env - 环境变量（默认 process.env）。
 * @param home - 用户目录（默认 os.homedir()）。
 */
export function magpieSettingsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = env.DSH_MAGPIE_SETTINGS_FILE?.trim()
  if (explicit) return explicit
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'plugins', 'dsh-magpie-connector', 'settings.json')
}

// ── 网关查询 ─────────────────────────────────────────────────────────────────

/** 网关卡片接口的返回体：`{ data: [...], object: "list" }`（也容忍裸数组）。 */
export function cardsOf(value: unknown): MagpieCard[] {
  if (Array.isArray(value)) return value.filter((v): v is MagpieCard => obj(v) !== undefined)
  const list = obj(value)?.data
  return Array.isArray(list) ? list.filter((v): v is MagpieCard => obj(v) !== undefined) : []
}

/** 已解析的线路凭证。 */
export interface MagpieLineAuth {
  key: string
  keySource: string
  accessClientId?: string
  accessClientSecret?: string
}

/**
 * 解析一条线路的凭证：主 key 必须存在（否则该线路整行隐藏）；cloudflare
 * 访问模式还要 CF-Access 的 id/secret，缺了就不发这两条头（网关会自己判）。
 * @param credentials - DSH 凭证域（可为 undefined：只用环境变量）。
 * @param line - 线路。
 */
export async function resolveLineAuth(
  credentials: CredentialProvider | undefined,
  line: MagpieLine,
): Promise<MagpieLineAuth | undefined> {
  const refs = magpieLineRefs(line.id)
  const get = async (ref: string): Promise<{ value: string; source: string } | undefined> => {
    if (credentials) {
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved?.value) return { value: resolved.value, source: resolved.source }
    }
    const fromEnv = process.env[ref]?.trim()
    return fromEnv ? { value: fromEnv, source: 'env' } : undefined
  }
  const key = await get(refs.key)
  if (!key) return undefined
  if (line.accessMode !== 'cloudflare') return { key: key.value, keySource: key.source }
  const accessId = await get(refs.accessClientId)
  const accessSecret = await get(refs.accessClientSecret)
  return {
    key: key.value,
    keySource: key.source,
    ...(accessId === undefined ? {} : { accessClientId: accessId.value }),
    ...(accessSecret === undefined ? {} : { accessClientSecret: accessSecret.value }),
  }
}

/**
 * 查一条线路的额度卡片（`GET <baseUrl>/magpie/quotas/cards`，Bearer 线路 key）。
 * 走 GET 而不是 refresh：connector 自己的侧栏与后台探活已经在按 30s/卡 的
 * 节奏推上游，这里读网关缓存即可，避免重复刷新抢限流额度。
 * @param line - 线路。
 * @param auth - 已解析凭证。
 * @param signal - 可选中止信号（默认 15s 超时）。
 */
export async function fetchLineCards(line: MagpieLine, auth: MagpieLineAuth, signal?: AbortSignal): Promise<MagpieCard[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.key}`,
    accept: 'application/json',
  }
  if (line.accessMode === 'cloudflare' && auth.accessClientId && auth.accessClientSecret) {
    headers['CF-Access-Client-Id'] = auth.accessClientId
    headers['CF-Access-Client-Secret'] = auth.accessClientSecret
  }
  const resp = await fetch(`${line.baseUrl}/magpie/quotas/cards`, {
    headers,
    signal: signal ?? AbortSignal.timeout(MAGPIE_TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`)
  return cardsOf(await resp.json() as unknown)
}

// ── TTL 缓存 + 对外入口 ──────────────────────────────────────────────────────

/**
 * 60s TTL 缓存：成功与失败的行都缓存（失败行也复用，避免看门狗退避补刷
 * 把限流端点打爆）；无凭证（隐藏）不缓存——凭证检测只是本地读取，代价极低。
 * 模块级、单进程事件循环访问，无需加锁。
 */
const cache = new Map<string, { at: number; rows: ProviderSnapshot[] }>()

/** 该面板行 id 是否属于 magpie 适配器。 */
export function isMagpiePlatform(platform: string): boolean {
  return platform.startsWith(MAGPIE_PLATFORM_PREFIX)
}

/**
 * 读取 magpie connector 的线路配置并聚合出面板行：
 * 无线路 / 线路无凭证 → []（整行隐藏，自动发现语义）；
 * 有凭证但查询失败 → 一条 error 行，用户能在面板里看到原因。
 * @param options.credentials - DSH 凭证域（线路 key 从这里解析）。
 */
export async function fetchMagpieRows(options: { credentials?: CredentialProvider }): Promise<ProviderSnapshot[]> {
  let lines: MagpieLine[]
  try {
    lines = parseLines(JSON.parse(await readFile(magpieSettingsPath(), 'utf8') as string))
  } catch {
    return [] // connector 未安装 / 还没配置线路：静默隐藏
  }
  if (lines.length === 0) return []

  const multiLine = lines.length > 1
  const rows: ProviderSnapshot[] = []
  for (const line of lines) {
    const auth = await resolveLineAuth(options.credentials, line)
    if (!auth) continue
    const keyRef = magpieLineRefs(line.id).key
    const cacheKey = `${line.baseUrl}|${line.id}|${auth.keySource}`
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < MAGPIE_TTL_MS) {
      rows.push(...hit.rows)
      continue
    }
    let lineRows: ProviderSnapshot[]
    try {
      lineRows = rowsFromCards(await fetchLineCards(line, auth), line.id, multiLine, keyRef, auth.keySource)
    } catch (error) {
      lineRows = [{
        id: `${MAGPIE_PLATFORM_PREFIX}line-${line.id}`,
        label: 'Magpie 网关',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        via: 'api',
        keyRef,
        keySource: auth.keySource,
        items: [],
      }]
    }
    cache.set(cacheKey, { at: Date.now(), rows: lineRows })
    rows.push(...lineRows)
  }
  // 缓存里的行可能被调用方改写（controller 会补 ETA / 速率），返回副本。
  return rows.map((row) => ({ ...row, items: row.items.map((item) => ({ ...item })) }))
}

/**
 * 探活一条 magpie 行：重新 GET 一次该线路的卡片并计时（只读，不改快照）。
 * @param platform - 面板行 id（`magpie-<provider>`，多线路时带 `#线路 id`）。
 * @param credentials - DSH 凭证域。
 */
export async function probeMagpie(
  platform: string,
  credentials: CredentialProvider | undefined,
): Promise<{ ok: boolean; ms: number; message?: string }> {
  const started = Date.now()
  let lines: MagpieLine[]
  try {
    lines = parseLines(JSON.parse(await readFile(magpieSettingsPath(), 'utf8') as string))
  } catch {
    return { ok: false, ms: 0, message: '未找到 dsh-magpie-connector 的线路配置' }
  }
  const hashAt = platform.lastIndexOf('#')
  const lineId = hashAt >= 0 ? platform.slice(hashAt + 1) : undefined
  const candidates = lineId ? lines.filter((l) => l.id === lineId) : lines
  if (candidates.length === 0) return { ok: false, ms: 0, message: '未找到对应的 magpie 线路' }
  let lastError = '未找到线路凭证'
  for (const line of candidates) {
    const auth = await resolveLineAuth(credentials, line)
    if (!auth) continue
    try {
      await fetchLineCards(line, auth)
      return { ok: true, ms: Date.now() - started }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, ms: Date.now() - started, message: lastError }
}

/** 清空 TTL 缓存（测试用）。 */
export function clearMagpieCache(): void {
  cache.clear()
}
