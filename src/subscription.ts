/**
 * 订阅制平台额度适配器：Claude Code（Anthropic OAuth）与 Codex（ChatGPT
 * 订阅）。这两家的额度绑定订阅登录而非 API key，与 DSH 的模型供应商配置
 * 无关，因此**不受 activePlatformGate 门槛限制**——自动发现语义：本地有
 * 登录凭证就显示，没有就整行隐藏。
 *
 * 两个端点自身都有限流（Anthropic 明确 429），而失败看门狗会以 30s~4min
 * 的退避节奏补刷：所有查询结果（成功与失败）走模块级 60s TTL 缓存兜底，
 * 缓存命中直接复用上次的行，避免把上游打爆。单进程事件循环，缓存无需
 * 加锁。
 * @module dsh-quota/subscription
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderSnapshot, QuotaItem } from './config.ts'

const execFileAsync = promisify(execFile)

/** 单次订阅端点请求超时。 */
const SUBSCRIPTION_TIMEOUT_MS = 10000

/** 订阅查询结果（成功与失败）的 TTL 缓存时长。 */
const SUBSCRIPTION_TTL_MS = 60000

// ── 纯工具 ───────────────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : (v === null || v === undefined ? undefined : String(v))
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

// ── Claude Code（Anthropic OAuth）────────────────────────────────────────────

/**
 * 从 Claude Code 凭证 JSON 中提取 `claudeAiOauth.accessToken`（纯函数，
 * 供测试直接使用）。只有 mcpOAuth（无 claudeAiOauth）或字段为空时视为
 * 未登录，返回 undefined。
 */
export function extractClaudeCodeToken(json: unknown): string | undefined {
  const oauth = obj(obj(json)?.claudeAiOauth)
  const token = oauth?.accessToken
  return typeof token === 'string' && token ? token : undefined
}

/** macOS Keychain 里 Claude Code 凭证条目的服务名。 */
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * macOS：从 Keychain 读取 Claude Code 凭证 JSON 并提取 accessToken。
 * 命令失败 / JSON 解析失败 / 无 claudeAiOauth 一律返回 undefined。
 */
async function claudeTokenFromKeychain(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'])
    return extractClaudeCodeToken(JSON.parse(stdout) as unknown)
  } catch {
    return undefined
  }
}

/** 凭证 JSON 文件路径：`{CLAUDE_CONFIG_DIR || ~/.claude}/.credentials.json`。 */
function claudeCredentialsPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  return join(dir, '.credentials.json')
}

/**
 * 解析 Claude Code 的 OAuth access token：两个来源都试，任一命中即用——
 * ① macOS Keychain（`security find-generic-password`）；
 * ② `{CLAUDE_CONFIG_DIR || ~/.claude}/.credentials.json`（Linux/Windows 主路径，
 *   macOS 上作为 Keychain 的兜底）。
 * 都拿不到 → undefined（该平台本轮隐藏）。
 */
export async function resolveClaudeCodeToken(): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    const fromKeychain = await claudeTokenFromKeychain()
    if (fromKeychain) return fromKeychain
  }
  try {
    const text = await readFile(claudeCredentialsPath(process.env, homedir()), 'utf8')
    return extractClaudeCodeToken(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/**
 * 解析 Anthropic OAuth 用量响应（纯函数）：
 * - 优先 legacy 扁平桶 `five_hour` / `seven_day`（`utilization` 为 0-100
 *   的**已用**百分比，可为 null——null 桶按 0% 处理，Enterprise 常态）；
 * - 无扁平桶时回退 `limits[]`（kind: session / weekly_all / weekly_scoped），
 *   忽略 `percent=0 且 resets_at 为 null 且无 scope` 的占位项；
 * - `extra_usage` 金额单位为**美分**，换算成美元展示，不带 percent；
 * - 整体解析不出任何字段 → items 为空并说明响应无法识别。
 */
export function parseClaudeCodeUsage(body: unknown): { items: QuotaItem[]; message?: string } {
  const raw = obj(body)
  if (!raw) return { items: [], message: '响应无法识别（非 JSON 对象）' }
  const items: QuotaItem[] = []

  const flat = (bucket: unknown, label: string): void => {
    if (obj(bucket) === undefined) return
    const b = bucket as Record<string, unknown>
    items.push({
      label,
      // utilization 为已用百分比；null（Enterprise 常态）按 0% 处理。
      percent: num(b.utilization) ?? 0,
      ...(str(b.resets_at) ? { resetAt: str(b.resets_at) } : {}),
    })
  }
  flat(raw.five_hour, '5 小时窗口')
  flat(raw.seven_day, '周额度')

  if (items.length === 0 && Array.isArray(raw.limits)) {
    for (const entry of raw.limits) {
      const l = obj(entry)
      if (!l) continue
      const kind = str(l.kind)
      const percent = num(l.percent)
      const resetsAt = str(l.resets_at)
      const scope = obj(l.scope)
      // 占位项：0% 且无重置时间且无 scope —— 忽略。
      if ((percent ?? 0) === 0 && !resetsAt && !scope) continue
      const label = kind === 'session'
        ? '5 小时窗口'
        : kind === 'weekly_all'
          ? '周额度'
          : kind === 'weekly_scoped'
            ? `周额度 · ${str(obj(scope?.model)?.display_name) ?? '未知模型'}`
            : undefined
      if (!label) continue
      items.push({
        label,
        percent: percent ?? 0,
        ...(resetsAt ? { resetAt: resetsAt } : {}),
      })
    }
  }

  const extra = obj(raw.extra_usage)
  if (extra) {
    const usedCents = num(extra.used_credits)
    const limitCents = num(extra.monthly_limit)
    if (usedCents !== undefined) {
      const currency = str(extra.currency) ?? 'USD'
      items.push({
        label: '本月花费',
        display: limitCents !== undefined
          ? `${(usedCents / 100).toFixed(2)} ${currency} / ${(limitCents / 100).toFixed(2)}`
          : `${(usedCents / 100).toFixed(2)} ${currency}`,
      })
    }
  }

  if (items.length === 0) return { items: [], message: '响应无法识别（未找到 five_hour/seven_day/limits/extra_usage 字段）' }
  return { items }
}

/** Anthropic OAuth 用量端点（需 Bearer token + oauth beta 头）。 */
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/**
 * 查询 Claude Code 订阅用量并组装面板行。无凭证 → undefined（整行隐藏）。
 * 网络失败/非 2xx → error 行（message 带上游状态）。
 */
async function fetchClaudeCodeRow(): Promise<ProviderSnapshot | undefined> {
  const token = await resolveClaudeCodeToken()
  if (!token) return undefined
  const fail = (message: string): ProviderSnapshot => ({ id: 'claude-code', label: 'Claude Code', status: 'error', message, via: 'api', items: [] })
  let resp: Response
  try {
    resp = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (!resp.ok) return fail(`HTTP ${String(resp.status)}`)
  let body: unknown
  try {
    body = await resp.json() as unknown
  } catch {
    return fail('响应不是合法 JSON')
  }
  const { items, message } = parseClaudeCodeUsage(body)
  return {
    id: 'claude-code',
    label: 'Claude Code',
    status: 'ok',
    via: 'api',
    ...(message ? { message } : {}),
    items,
  }
}

// ── Codex（ChatGPT 订阅）─────────────────────────────────────────────────────

/** Codex 登录凭证三元组（auth.json 的 tokens 摘要）。 */
export interface CodexAuth {
  accessToken: string
  accountId: string
  refreshToken: string
  /** 命中的 auth.json 路径（刷新后写回该文件）。 */
  path: string
}

/**
 * 从 auth.json 内容提取 `tokens` 三元组（纯函数，供测试直接使用）。
 * 仅当 access_token / account_id / refresh_token 均为非空字符串才启用；
 * 只有 OPENAI_API_KEY 之类（无 tokens）不算已登录 → undefined。
 */
export function extractCodexAuth(json: unknown, path = ''): CodexAuth | undefined {
  const tokens = obj(obj(json)?.tokens)
  if (!tokens) return undefined
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : ''
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : ''
  if (!accessToken || !accountId || !refreshToken) return undefined
  return { accessToken, accountId, refreshToken, path }
}

/** auth.json 候选路径：`{CODEX_HOME || ~/.codex}/auth.json`，CODEX_HOME 未设再试 `~/.config/codex/auth.json`。 */
export function codexAuthPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const paths = [join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json')]
  if (!env.CODEX_HOME?.trim()) paths.push(join(home, '.config', 'codex', 'auth.json'))
  return paths
}

/**
 * 解析 Codex 登录凭证：按候选路径读 auth.json，第一份带完整 tokens 的
 * 生效；都不存在/不完整 → undefined（该平台本轮隐藏）。
 */
export async function resolveCodexAuth(): Promise<CodexAuth | undefined> {
  for (const path of codexAuthPaths(process.env, homedir())) {
    try {
      const text = await readFile(path, 'utf8')
      const auth = extractCodexAuth(JSON.parse(text) as unknown, path)
      if (auth) return auth
    } catch {
      // 文件不存在 / JSON 损坏 → 试下一个候选路径。
    }
  }
  return undefined
}

/**
 * 解析 Codex 用量响应（纯函数）：
 * - `rate_limit.primary_window` → 「5 小时窗口」，`used_percent` 为已用
 *   百分比，`reset_at` 为 epoch 秒（×1000 转 ISO）；
 * - `rate_limit.secondary_window` → 「本周窗口」，同上；
 * - `plan_type` 拼进 message（如 'ChatGPT Plus'）；
 * - `credits` 有 `has_credits` 时给「Credits」条目（unlimited → '无限'），
 *   不带 percent。所有字段均可缺失。
 */
export function parseCodexUsage(body: unknown): { items: QuotaItem[]; message?: string } {
  const raw = obj(body)
  if (!raw) return { items: [], message: '响应无法识别（非 JSON 对象）' }
  const items: QuotaItem[] = []
  const rateLimit = obj(raw.rate_limit)

  const window = (w: unknown, label: string): void => {
    const win = obj(w)
    if (!win) return
    const percent = num(win.used_percent)
    const resetSec = num(win.reset_at)
    items.push({
      label,
      ...(percent !== undefined ? { percent } : {}),
      ...(resetSec !== undefined && resetSec > 0 ? { resetAt: new Date(resetSec * 1000).toISOString() } : {}),
    })
  }
  window(rateLimit?.primary_window, '5 小时窗口')
  window(rateLimit?.secondary_window, '本周窗口')

  const messages: string[] = []
  const planType = str(raw.plan_type)
  if (planType) messages.push(planType)

  const credits = obj(raw.credits)
  if (credits && credits.has_credits !== undefined) {
    items.push({
      label: 'Credits',
      display: credits.unlimited === true ? '无限' : (str(credits.balance) ?? '?'),
    })
  }

  if (items.length === 0 && messages.length === 0) {
    return { items: [], message: '响应无法识别（未找到 rate_limit/plan_type/credits 字段）' }
  }
  return { items, ...(messages.length > 0 ? { message: messages.join(' · ') } : {}) }
}

/** Codex 用量端点（需 Bearer + ChatGPT-Account-Id）。 */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** OAuth 刷新端点与公开 client_id（Codex CLI 同款）。 */
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/**
 * 用 refresh_token 换新 tokens 并**写回 auth.json**（保留其它字段、
 * tokens 内字段增量覆盖、last_refresh 更新为当前 ISO）。失败返回
 * undefined（调用方降级为「需重新登录」）。
 */
async function refreshCodexTokens(auth: CodexAuth): Promise<CodexAuth | undefined> {
  let resp: Response
  try {
    resp = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!resp.ok) return undefined
  const granted = obj(await resp.json().catch(() => undefined))
  if (!granted) return undefined
  const accessToken = typeof granted.access_token === 'string' ? granted.access_token : ''
  if (!accessToken) return undefined
  const refreshToken = typeof granted.refresh_token === 'string' && granted.refresh_token ? granted.refresh_token : auth.refreshToken
  const accountId = typeof granted.account_id === 'string' && granted.account_id ? granted.account_id : auth.accountId

  // 写回：以磁盘上最新内容为底，保留其它字段，只覆盖 tokens 与 last_refresh。
  let disk: Record<string, unknown> = {}
  try {
    disk = obj(JSON.parse(await readFile(auth.path, 'utf8') as string)) ?? {}
  } catch {
    // 文件被删/损坏：以仅含 tokens 的新对象落盘。
  }
  const next: Record<string, unknown> = {
    ...disk,
    tokens: { ...(obj(disk.tokens) ?? {}), access_token: accessToken, refresh_token: refreshToken, account_id: accountId },
    last_refresh: new Date().toISOString(),
  }
  try {
    await writeFile(auth.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // 写回失败（只读目录等）不影响本轮：内存里仍用新 token 继续。
  }
  return { ...auth, accessToken, refreshToken, accountId }
}

/**
 * 查询 Codex 订阅用量并组装面板行。无凭证 → undefined（整行隐藏）。
 * 401/403 时刷新一次 token 并重试；刷新失败 → error 行「需重新登录 Codex」。
 */
async function fetchCodexRow(): Promise<ProviderSnapshot | undefined> {
  const auth = await resolveCodexAuth()
  if (!auth) return undefined
  const fail = (message: string): ProviderSnapshot => ({ id: 'codex', label: 'Codex', status: 'error', message, via: 'api', items: [] })

  const usageHeaders = (a: CodexAuth): Record<string, string> => ({
    Authorization: `Bearer ${a.accessToken}`,
    'ChatGPT-Account-Id': a.accountId,
    Accept: 'application/json',
  })

  let resp: Response
  try {
    resp = await fetch(CODEX_USAGE_URL, { headers: usageHeaders(auth), signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS) })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  // 401/403：access token 过期 → 刷新一次再用新 token 重试。
  if (resp.status === 401 || resp.status === 403) {
    const refreshed = await refreshCodexTokens(auth)
    if (!refreshed) return fail('需重新登录 Codex')
    try {
      resp = await fetch(CODEX_USAGE_URL, { headers: usageHeaders(refreshed), signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS) })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
  if (!resp.ok) return fail(`HTTP ${String(resp.status)}`)
  let body: unknown
  try {
    body = await resp.json() as unknown
  } catch {
    return fail('响应不是合法 JSON')
  }
  const { items, message } = parseCodexUsage(body)
  return {
    id: 'codex',
    label: 'Codex',
    status: 'ok',
    via: 'api',
    ...(message ? { message } : {}),
    items,
  }
}

// ── TTL 缓存 + 对外入口 ──────────────────────────────────────────────────────

/**
 * 60s TTL 缓存：成功与失败的行都缓存（error 行也复用，避免看门狗退避
 * 补刷把限流端点打爆）；无凭证（隐藏）不缓存——凭证检测只是本地文件/
 * Keychain 读取，代价极低，登录后下一轮立即出现。模块级、单进程事件
 * 循环访问，无需加锁。
 */
const cache = new Map<string, { at: number; row: ProviderSnapshot }>()

async function cachedRow(id: string, fetcher: () => Promise<ProviderSnapshot | undefined>): Promise<ProviderSnapshot | undefined> {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < SUBSCRIPTION_TTL_MS) return hit.row
  let row: ProviderSnapshot | undefined
  try {
    row = await fetcher()
  } catch (error) {
    row = { id, label: id, status: 'error', message: error instanceof Error ? error.message : String(error), via: 'api', items: [] }
  }
  if (row) cache.set(id, { at: Date.now(), row })
  return row
}

/**
 * 刷新所有订阅制平台（Claude Code / Codex）的面板行：
 * 有凭证 → ok/error 行；无凭证 → 整行隐藏（返回数组不含该项）。
 * 60s TTL 缓存兜底，由 controller.doRefresh 在 direct/mcp 之外调用，
 * 不走 activePlatformGate 门槛。
 */
export async function fetchSubscriptionRows(): Promise<ProviderSnapshot[]> {
  const rows = await Promise.all([
    cachedRow('claude-code', fetchClaudeCodeRow),
    cachedRow('codex', fetchCodexRow),
  ])
  return rows.filter((r): r is ProviderSnapshot => r !== undefined)
}
