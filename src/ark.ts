/**
 * 火山方舟（Volcengine Ark）额度适配器。
 *
 * 为什么单独一层：DSH 里 `ark` 供应商的 `ARK_API_KEY`（`ark-…`）是**推理
 * key**，只能调模型，没有任何额度查询接口——拿它去查只能探活。套餐用量在
 * 火山引擎**控制面 OpenAPI** 上，必须用 AccessKey ID / SecretAccessKey
 * （AK/SK）做 HMAC-SHA256 V4 签名调 `open.volcengineapi.com`
 * （region=cn-beijing、service=ark、Version=2024-01-01）：
 *
 *   - Coding Plan：`Action=GetCodingPlanUsage` → `Result.QuotaUsage[]`
 *     （`Level` 窗口名 / `Percent` 已用百分比 / `ResetTimestamp` 秒）；
 *   - Agent Plan：`Action=GetAgentPlanAFPUsage` → `Result.AFP*`
 *     （`Quota` / `Used` / `ResetTime`）。
 *
 * 所以本模块不是 DirectAdapter（那套是「一个 Bearer key 一次 GET」），而是
 * 与 subscription.ts 同类的「自动发现行」：本地解析到 AK/SK 才查询，没有
 * 就整行隐藏，交给 controller 的 `/models` 探活兜底（同一个平台 id
 * `volcark`，行存在时探活自动跳过，不会出现两行）。
 *
 * 签名实现对齐官方 `@volcengine/openapi` 的 Signer：只签
 * `host;x-content-sha256;x-date`（content-type 在官方 unsignableHeaders
 * 里，签了反而有风险），CanonicalRequest 里 canonical headers 与
 * signed headers 之间保留空行。
 * @module dsh-quota/ark
 */

import { createHash, createHmac } from 'node:crypto'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ProviderSnapshot, QuotaItem } from './config.ts'

/** 面板平台 id：额度行与 `/models` 探活兜底行共用，保证不会重复。 */
export const ARK_PLATFORM_ID = 'volcark'

/** 平台展示名（限额行会拼上套餐类型后缀）。 */
export const ARK_LABEL = '火山方舟'

/**
 * 主写入引用：面板「存」把 AK / SK 分别写到这两个 ref（与火山引擎官方
 * SDK 的环境变量名一致），其余为历史别名 / 兼容常见写法。
 */
export const ARK_AK_REFS: readonly string[] = [
  'VOLC_ACCESS_KEY_ID',
  'VOLC_ARK_ACCESS_KEY_ID',
  'VOLC_ACCESS_KEY',
  'ARK_ACCESS_KEY_ID',
]
export const ARK_SK_REFS: readonly string[] = [
  'VOLC_ACCESS_KEY_SECRET',
  'VOLC_ARK_ACCESS_KEY_SECRET',
  'VOLC_SECRET_KEY',
  'ARK_ACCESS_KEY_SECRET',
]

/** 所有可能承载 AK/SK 的引用（凭证变更时触发刷新的白名单）。 */
export const ARK_REFS: readonly string[] = [...ARK_AK_REFS, ...ARK_SK_REFS]

const ARK_HOST = 'open.volcengineapi.com'
const ARK_API_VERSION = '2024-01-01'
const ARK_REGION = 'cn-beijing'
const ARK_SERVICE = 'ark'
/** 查询结果 TTL：失败看门狗 30s~4min 补刷，别把 OpenAPI 打爆。 */
const ARK_TTL_MS = 60_000
const ARK_TIMEOUT_MS = 12_000

/** 套餐 → 候选 Action（响应结构不同，按顺序试到能解析为止）。 */
const PLAN_ACTIONS = {
  coding: ['GetCodingPlanUsage'],
  agent: ['GetAgentPlanAFPUsage', 'GetAFPUsage'],
} as const
type ArkPlan = keyof typeof PLAN_ACTIONS

// ── 纯工具 ───────────────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function round1(value: number): number {
  return Number(value.toFixed(1))
}

/** 百分比保留两位小数（与控制台一致；上游会是 13.337068933… 这种长尾）。 */
function round2(value: number): number {
  return Number(value.toFixed(2))
}

/** `yyyyMMdd'T'HHmmss'Z'`（UTC，官方 X-Date 格式）。 */
export function arkXDate(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getUTCFullYear())}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
}

/**
 * 重置时间归一化成 ISO：秒级（<1e12）先乘 1000，毫秒级直接用。
 */
function resetIso(v: unknown): string | undefined {
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

// ── 签名 ─────────────────────────────────────────────────────────────────────

/** 一次 OpenAPI 请求的签名结果（headers 不含 Host——fetch 不允许手写）。 */
export interface ArkSignedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Volcengine OpenAPI V4 签名（HMAC-SHA256）。与官方 SDK 等价；`xDate` 可注入
 * 以便单测拿固定向量比对。
 */
export function arkSignedRequest(input: { ak: string; sk: string; action: string; xDate?: string; body?: string }): ArkSignedRequest {
  const body = input.body ?? '{}'
  const xDate = input.xDate ?? arkXDate(new Date())
  const params: Record<string, string> = { Action: input.action, Version: ARK_API_VERSION }
  const query = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&')

  const bodyHash = sha256Hex(body)
  const headerValues: Record<string, string> = {
    host: ARK_HOST,
    'x-content-sha256': bodyHash,
    'x-date': xDate,
  }
  // 官方 unsignableHeaders 排除 content-type / content-length / user-agent /
  // authorization，这里只剩这三个（已按字典序）。
  const signedHeaders = Object.keys(headerValues).sort().join(';')
  const canonicalHeaders = Object.keys(headerValues)
    .sort()
    .map((key) => `${key}:${headerValues[key] ?? ''}`)
    .join('\n')

  const canonicalRequest = [
    'POST',
    '/',
    query,
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join('\n')

  const scope = `${xDate.slice(0, 8)}/${ARK_REGION}/${ARK_SERVICE}/request`
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(input.sk, xDate.slice(0, 8))
  const kRegion = hmac(kDate, ARK_REGION)
  const kService = hmac(kRegion, ARK_SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    url: `https://${ARK_HOST}/?${query}`,
    headers: {
      'content-type': 'application/json',
      'X-Date': xDate,
      'X-Content-Sha256': bodyHash,
      Authorization: `HMAC-SHA256 Credential=${input.ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  }
}

// ── 响应解析 ─────────────────────────────────────────────────────────────────

/** 窗口名归一化：Coding Plan 的 `Level` 上游含义未公开，按字样归类。 */
export function arkWindowLabel(raw: unknown): string {
  const text = raw === null || raw === undefined ? '' : String(raw).trim()
  const low = text.toLowerCase()
  if (/5\s*h|5\s*小时|session|会话/.test(low)) return '5 小时窗口'
  if (/week|周/.test(low)) return '本周额度'
  if (/month|月/.test(low)) return '本月额度'
  return text ? `额度 ${text}` : '套餐额度'
}

/** 解析结果：套餐类型 + 面板条目。 */
export interface ArkParseResult {
  plan: ArkPlan
  items: QuotaItem[]
}

/**
 * 解析 OpenAPI 响应，同时兼容两种套餐形态：
 * - Coding Plan：`Result.QuotaUsage[]`（`Level` / `Percent` / `ResetTimestamp`）；
 * - Agent Plan：`Result.AFPFiveHour` / `AFPWeekly` / `AFPMonthly`
 *   （`Quota` / `Used` / `ResetTime`）。
 *
 * `ResponseMetadata.Error` 先说清楚（权限/未订阅都是它），解析不出来再抛。
 */
export function parseArkUsage(payload: unknown): ArkParseResult {
  const root = obj(payload)
  if (!root) throw new Error('响应不是 JSON 对象')

  const meta = obj(root.ResponseMetadata)
  const error = obj(meta?.Error)
  if (error) {
    const code = String(error.Code ?? 'UnknownError')
    const message = String(error.Message ?? '')
    throw new Error(`火山方舟 OpenAPI 错误 ${code}: ${message}`)
  }

  const result = obj(root.Result) ?? root

  const quotaUsage = Array.isArray(result.QuotaUsage) ? result.QuotaUsage : []
  if (quotaUsage.length > 0) {
    const items: QuotaItem[] = []
    for (const entry of quotaUsage) {
      const row = obj(entry)
      if (!row) continue
      const percent = round2(num(row.Percent) ?? 0)
      items.push({
        label: arkWindowLabel(row.Level),
        percent,
        display: `已用 ${percent}%`,
        resetAt: resetIso(row.ResetTimestamp),
      })
    }
    if (items.length > 0) return { plan: 'coding', items }
  }

  const windows: Array<[string, string]> = [
    ['5 小时窗口', 'AFPFiveHour'],
    ['本周额度', 'AFPWeekly'],
    ['本月额度', 'AFPMonthly'],
  ]
  const agentItems: QuotaItem[] = []
  let sawAgentWindow = false
  for (const [label, key] of windows) {
    const window = obj(result[key])
    if (!window) continue
    sawAgentWindow = true
    const quota = num(window.Quota)
    const used = num(window.Used)
    if (quota === undefined || quota <= 0) continue // 未订阅的窗口 Quota=0，不要渲染成 0/0
    const percent = used !== undefined ? round1((used / quota) * 100) : undefined
    agentItems.push({
      label,
      ...used === undefined ? {} : { used },
      limit: quota,
      ...used === undefined ? {} : { remaining: Math.max(0, quota - used) },
      ...percent === undefined ? {} : { percent },
      ...percent === undefined ? {} : { display: `已用 ${percent}%` },
      resetAt: resetIso(window.ResetTime),
    })
  }
  if (agentItems.length > 0) return { plan: 'agent', items: agentItems }

  throw new Error(sawAgentWindow
    ? 'Agent Plan 未订阅（各窗口额度均为 0）'
    : '无法识别的额度响应（既无 Result.QuotaUsage，也无 Result.AFP* 窗口）')
}

// ── 凭据解析 ─────────────────────────────────────────────────────────────────

interface ResolvedValue {
  value: string
  ref: string
  source: string
}

/** 按顺序解析第一个可用值：DSH 凭证域优先，其次进程环境变量。 */
async function resolveFirst(credentials: CredentialProvider | undefined, refs: readonly string[]): Promise<ResolvedValue | undefined> {
  if (credentials) {
    for (const ref of refs) {
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved?.value) return { value: resolved.value.trim(), ref, source: resolved.source }
    }
  }
  for (const ref of refs) {
    const value = process.env[ref]?.trim()
    if (value) return { value, ref, source: 'env' }
  }
  return undefined
}

/** 一对 AK/SK 及其来源。 */
export interface ArkKeyPair {
  ak: string
  sk: string
  akRef: string
  skRef: string
  source: string
}

/** 解析 AK/SK；任一缺失返回 undefined（该平台本轮隐藏）。 */
export async function resolveArkKeyPair(credentials: CredentialProvider | undefined): Promise<ArkKeyPair | undefined> {
  const ak = await resolveFirst(credentials, ARK_AK_REFS)
  if (!ak) return undefined
  const sk = await resolveFirst(credentials, ARK_SK_REFS)
  if (!sk) return undefined
  // 已存错的拆分（AK 字段是字段名、整串落在 SK 字段）在这里自动救回。
  const pair = normalizeArkKeyPair(ak.value, sk.value)
  return { ak: pair.ak, sk: pair.sk, akRef: ak.ref, skRef: sk.ref, source: ak.source }
}

/**
 * AK/SK 形态校验：火山引擎 IAM AccessKey ID 以 `AKLT` 开头（官方格式
 * `AKLT[a-zA-Z0-9-_]+`，总长 20~32），SecretAccessKey 是 40 位左右的
 * base64。返回错误文案，形态正常返回 undefined。
 *
 * 这层校验是为了拦住「把字段名/示例文本粘进来」的输入：否则请求会带着
 * 一个格式合法的签名打到 OpenAPI，上游只回 `InvalidCredential`
 * （CodeN 100025），用户完全看不出是自己贴错了。
 */
export function arkKeyPairError(pair: { ak: string; sk: string }): string | undefined {
  const ak = pair.ak.trim()
  const sk = pair.sk.trim()
  if (!/^AKLT[A-Za-z0-9_-]{8,56}$/.test(ak)) {
    const weird = /[^0-9A-Za-z_-]/.test(ak) ? '、含非字母数字字符' : ''
    return `AccessKey ID 应以 AKLT 开头（当前 ${ak.length} 位${weird}）：请从 IAM 控制台复制真实的 AccessKey ID，不要填字段名或示例文本`
  }
  if (!/^[0-9A-Za-z+/=]{30,128}$/.test(sk)) {
    return `SecretAccessKey 应是 30~128 位 base64 字符串（当前 ${sk.length} 位）：创建 AccessKey 时只显示一次，请重新复制`
  }
  return undefined
}

/**
 * 把「AK/SK 合成一整串」拆开：AK 的字符集是 `[A-Za-z0-9_-]`（不含 `/`），
 * 而 SK 是 base64（可以含 `/`），所以按**第一个 `/`** 切，左段以 `AKLT`
 * 开头才算命中。AK/SK 各自字段里粘了整串都能救回来——常见事故：AK 字段
 * 填了字段名 `AccessKeyID/SecretAccessKey`，整串却落在 SK 字段里。
 */
export function normalizeArkKeyPair(ak: string, sk: string): { ak: string; sk: string } {
  const splitCombined = (value: string): { ak: string; sk: string } | undefined => {
    const text = value.trim()
    const at = text.indexOf('AKLT')
    if (at < 0) return undefined
    const body = text.slice(at)
    const slash = body.indexOf('/')
    if (slash <= 0) return undefined
    const left = body.slice(0, slash).trim()
    const right = body.slice(slash + 1).trim()
    return /^AKLT[A-Za-z0-9_-]+$/.test(left) && right ? { ak: left, sk: right } : undefined
  }
  return splitCombined(ak) ?? splitCombined(sk) ?? { ak: ak.trim(), sk: sk.trim() }
}

/**
 * 面板「API Key 管理」里的 AK/SK 输入解析。常见几种粘贴方式都认：
 * - `AK:SK` / `AK SK` / 两行粘贴；
 * - 控制台/第三方直接给的合成串 `AKLT…/SecretAccessKey==`；
 * - 带字段名前缀的整行 `AccessKeyID/SecretAccessKey: AKLT…/…`。
 * AK（`[A-Za-z0-9_-]`）不含 `:` `/` 与空白，天然是分隔符。
 */
export function parseArkKeyPair(raw: string): { ak: string; sk: string } | undefined {
  const text = raw.trim().replace(/^["']|["']$/g, '')
  if (!text) return undefined
  const at = text.indexOf('AKLT')
  const body = at >= 0 ? text.slice(at) : text
  // 找到 AK 后，紧跟的第一个 `:` `/` 逗号或空白就是分隔符（之后整段都算 SK）。
  const match = body.match(/^(AKLT[A-Za-z0-9_-]+)[\s:/,]+([\s\S]+)$/)
  if (match) {
    const sk = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
    return sk ? { ak: match[1] ?? '', sk } : undefined
  }
  const colon = body.indexOf(':')
  const parts = colon > 0 ? [body.slice(0, colon), body.slice(colon + 1)] : body.split(/\s+/).filter(Boolean)
  const ak = parts[0]?.trim()
  const sk = parts[1]?.trim()
  return ak && sk ? { ak, sk } : undefined
}

// ── OpenAPI 查询 ─────────────────────────────────────────────────────────────

/** 鉴权失败（401/403 / 签名错）：换 Action 重试没有意义，直接上抛。 */
class ArkAuthError extends Error {}

/** 查询依赖（测试注入 fetch 与固定签名时间）。 */
export interface ArkFetchOptions {
  fetchImpl?: typeof fetch
  xDate?: string
  signal?: AbortSignal
}

/**
 * 依次尝试 Coding Plan → Agent Plan 的 Action，返回第一个能解析的结果。
 * 网络/HTTP/结构错误逐个收集，全部失败时一次性抛出。
 */
export async function fetchArkUsage(pair: Pick<ArkKeyPair, 'ak' | 'sk'>, options: ArkFetchOptions = {}): Promise<ArkParseResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const errors: string[] = []
  for (const plan of ['coding', 'agent'] as const) {
    for (const action of PLAN_ACTIONS[plan]) {
      try {
        const request = arkSignedRequest({
          ak: pair.ak,
          sk: pair.sk,
          action,
          ...options.xDate === undefined ? {} : { xDate: options.xDate },
        })
        const response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: options.signal ?? AbortSignal.timeout(ARK_TIMEOUT_MS),
        })
        const text = await response.text()
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new ArkAuthError(`鉴权失败 HTTP ${response.status}：${text.slice(0, 200)}`)
          }
          errors.push(`${action}: HTTP ${response.status} ${text.slice(0, 200)}`)
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          errors.push(`${action}: 响应不是合法 JSON`)
          continue
        }
        return parseArkUsage(parsed)
      } catch (error) {
        if (error instanceof ArkAuthError) throw error
        // 超时/中止说明网络本身有问题，换 Action 只会再等一轮，直接上抛。
        const name = error instanceof Error ? error.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') throw error
        errors.push(`${action}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  throw new Error(`火山方舟额度查询失败（${errors.join('；')}）`)
}

// ── 面板行 ───────────────────────────────────────────────────────────────────

interface CachedRow {
  at: number
  row: ProviderSnapshot
}

const ROW_CACHE_TTL_MS = ARK_TTL_MS
const rowCache = new Map<string, CachedRow>()

/** 查询依赖：凭据服务 + 测试注入点。 */
export interface ArkRowsDeps {
  credentials?: CredentialProvider
  fetchImpl?: typeof fetch
  now?: () => number
  xDate?: string
}

/**
 * 产出一行火山方舟额度（有 AK/SK 时）。无 AK/SK → 空数组（整行隐藏，
 * 面板交给 `/models` 探活兜底显示「在线」）。查询结果（成功与失败）走
 * 60s TTL 缓存，避免失败补刷把 OpenAPI 打爆；测试注入了 fetch/now 时
 * 不读缓存。
 */
export async function fetchArkRows(deps: ArkRowsDeps = {}): Promise<ProviderSnapshot[]> {
  const pair = await resolveArkKeyPair(deps.credentials)
  if (!pair) return []

  // 形态不对就别浪费一次网络往返（上游只会回 InvalidCredential）。
  const pairError = arkKeyPairError(pair)
  if (pairError) {
    return [{
      id: ARK_PLATFORM_ID,
      label: ARK_LABEL,
      status: 'error',
      via: 'api',
      keyRef: pair.akRef,
      keySource: pair.source,
      message: `${pairError}；AK/SK 需具备 ArkReadOnlyAccess 只读权限（ARK_API_KEY 不能查额度）`,
      items: [],
    }]
  }

  const cacheable = deps.fetchImpl === undefined && deps.now === undefined
  const cacheKey = sha256Hex(`${pair.ak}\u0000${pair.sk}`).slice(0, 24)
  const now = deps.now?.() ?? Date.now()
  if (cacheable) {
    const hit = rowCache.get(cacheKey)
    if (hit && now - hit.at < ROW_CACHE_TTL_MS) return [hit.row]
  }

  let row: ProviderSnapshot
  try {
    const parsed = await fetchArkUsage(pair, {
      ...deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
      ...deps.xDate === undefined ? {} : { xDate: deps.xDate },
    })
    row = {
      id: ARK_PLATFORM_ID,
      label: `${ARK_LABEL} · ${parsed.plan === 'coding' ? 'Coding Plan' : 'Agent Plan'}`,
      status: 'ok',
      via: 'api',
      keyRef: pair.akRef,
      keySource: pair.source,
      items: parsed.items,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    row = {
      id: ARK_PLATFORM_ID,
      label: ARK_LABEL,
      status: 'error',
      via: 'api',
      keyRef: pair.akRef,
      keySource: pair.source,
      message: `${message}；AK/SK 需具备 ArkReadOnlyAccess 只读权限（ARK_API_KEY 不能查额度）`,
      items: [],
    }
  }
  if (cacheable) rowCache.set(cacheKey, { at: now, row })
  return [row]
}
