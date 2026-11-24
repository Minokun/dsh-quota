/**
 * Structured quota diagnostics and secret redaction (pure functions, zero I/O).
 *
 * Shared by the Host (`/plugins/dsh-quota/api/diag`) and the Browser panel so
 * failed cards and one-shot connectivity probes produce a clear PASS / FAIL
 * verdict with actionable next steps, and copied diagnostic reports never leak
 * API keys, cookies, JWTs, or local usernames.
 * @module dsh-quota/diagnostics
 */

export type DiagnosticCategory =
  | 'ok'
  | 'auth_expired'
  | 'insufficient_scope'
  | 'endpoint_unreachable'
  | 'mcp_not_configured'
  | 'missing_key'
  | 'rate_limited'
  | 'unknown_error'

export type DiagnosticSeverity = 'pass' | 'warn' | 'fail'

export interface DiagnosticInput {
  id: string
  label: string
  status: string
  message?: string
  via?: string
  keyRef?: string
  probeMs?: number
  probeOk?: boolean
  probeMessage?: string
}

export interface DiagnosticEntry {
  id: string
  label: string
  keyRef?: string
  code: DiagnosticCategory
  severity: DiagnosticSeverity
  sanitizedMessage?: string
  probeMs?: number
  actionZh: string
  actionEn: string
}

export interface DiagnosticReport {
  /** First-line verdict: strictly begins with `PASS X / FAIL Y`. */
  verdictLine: string
  passCount: number
  warnCount: number
  failCount: number
  entries: DiagnosticEntry[]
  /** Copy-pasteable Markdown block with secrets and local paths scrubbed. */
  markdown: string
}

/**
 * Scrub API keys, Bearer tokens, JWTs, cookies, embedded URL credentials, and
 * home directory usernames from upstream error messages before rendering or
 * copying diagnostics.
 */
export function redactSecrets(raw: string): string {
  if (!raw) return ''
  let s = raw
  // Embedded URL credentials: https://user:pass@host -> https://***@host
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1***@')
  // Authorization: Bearer <token>
  s = s.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 ***')
  // JWT tokens (eyJ... . eyJ... . sig)
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, 'jwt-***')
  // Known key prefixes: sk-*, vela_ctrl_*, AKLT*, rk-*, gsk_*, xai-*
  s = s.replace(/\b(sk-(?:ant-admin01-|admin-|proj-|ant-)?)[A-Za-z0-9_-]{4,}\b/g, 'sk-***')
  s = s.replace(/\b(vela_ctrl_)[A-Za-z0-9_-]{4,}\b/g, '$1***')
  s = s.replace(/\b(AKLT)[A-Za-z0-9_-]{4,}\b/g, '$1***')
  s = s.replace(/\b(gsk_|xai-|rk-)[A-Za-z0-9_-]{6,}\b/g, '$1***')
  // Key/value headers or query params carrying tokens/cookies/secrets
  s = s.replace(/\b(x-api-key|api[_-]?key|access[_-]?token|secret|cookie|set-cookie|x-dsh-auth-token)\s*([:=])\s*([^\s,;'"&]+)/gi, '$1$2***')
  // Home directory paths (/Users/alice/... or /home/alice/... or C:\Users\alice\...)
  s = s.replace(/\/Users\/[^/\s]+\//g, '~/')
  s = s.replace(/\/home\/[^/\s]+\//g, '~/')
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s]+\\/g, '~\\')
  return s
}

/** Classify one platform's snapshot + optional probe result into a deterministic category. */
export function classifyQuotaIssue(input: DiagnosticInput): DiagnosticEntry {
  const effectiveFailed = input.probeOk === false || input.status !== 'ok'
  const rawMsg = (input.probeOk === false && input.probeMessage ? input.probeMessage : input.message) ?? ''
  const sanitized = redactSecrets(rawMsg).trim()
  const baseId = input.id.split('#')[0] ?? input.id

  if (!effectiveFailed) {
    return {
      id: input.id,
      label: input.label,
      ...(input.keyRef ? { keyRef: input.keyRef } : {}),
      ...(input.probeMs !== undefined ? { probeMs: input.probeMs } : {}),
      code: 'ok',
      severity: 'pass',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: '正常',
      actionEn: 'Healthy',
    }
  }

  if (input.status === 'missing-mcp' && input.probeOk !== false) {
    return {
      id: input.id,
      label: input.label,
      code: 'mcp_not_configured',
      severity: 'warn',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: '需在当前 DSH profile 的 cordis.patch.yml 中注册并启用对应 MCP 服务',
      actionEn: 'Register and enable the corresponding MCP server in your DSH profile cordis.patch.yml',
    }
  }

  if (input.status === 'missing-key' && input.probeOk !== false) {
    const isOd = baseId === 'opendesign'
    return {
      id: input.id,
      label: input.label,
      ...(input.keyRef ? { keyRef: input.keyRef } : {}),
      code: 'missing_key',
      severity: 'warn',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: isOd
        ? '请先在 vela CLI 或 Open Design 桌面端完成登录，插件会自动同步登录态'
        : '请在 DSH 模型设置或下方「API Key 管理」中配置对应 API Key',
      actionEn: isOd
        ? 'Sign in via vela CLI or Open Design desktop first; dsh-quota syncs the session automatically'
        : 'Configure the API key in DSH model settings or under "API Keys" below',
    }
  }

  // Rate limited (HTTP 429)
  if (/\bHTTP\s*429\b|rate[\s_-]*limit|too many requests|限流|请求过快/i.test(rawMsg)) {
    return {
      id: input.id,
      label: input.label,
      ...(input.keyRef ? { keyRef: input.keyRef } : {}),
      code: 'rate_limited',
      severity: 'warn',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: '触发上游查询限频（HTTP 429），插件将按指数退避自动补刷，无需手动连点',
      actionEn: 'Upstream rate limit (HTTP 429); dsh-quota backs off and retries automatically',
    }
  }

  // Insufficient scope / Admin key mismatch (HTTP 403 or explicit scope/admin message)
  if (/\bHTTP\s*403\b|forbidden|insufficient|admin[\s_-]*key|organization[\s_-]*admin|权限不足|无权限/i.test(rawMsg)) {
    const needsAdmin = baseId === 'openai' || baseId === 'anthropic' || /openai|anthropic/i.test(baseId)
    return {
      id: input.id,
      label: input.label,
      ...(input.keyRef ? { keyRef: input.keyRef } : {}),
      code: 'insufficient_scope',
      severity: 'fail',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: needsAdmin
        ? '权限不足（HTTP 403）：官方账单接口需要组织级 Admin Key（如 sk-admin-* / sk-ant-admin-*），普通推理 sk-* 无法读取账单'
        : '权限不足（HTTP 403）：当前凭证缺少账单/用量读取权限（如火山 IAM 权限或控制台令牌范围）',
      actionEn: needsAdmin
        ? 'Insufficient scope (HTTP 403): billing endpoints require an Organization Admin Key (sk-admin-* / sk-ant-admin-*), not a standard model key'
        : 'Insufficient scope (HTTP 403): this credential lacks billing/quota read permissions',
    }
  }

  // Auth expired / invalid key (HTTP 401 or login expired)
  if (/\bHTTP\s*401\b|unauthorized|invalid[\s_-]*api[\s_-]*key|authentication|未登录|未授权|未认证|登录已?过期|token.*expired/i.test(rawMsg)) {
    const viaMcp = input.via === 'mcp'
    return {
      id: input.id,
      label: input.label,
      ...(input.keyRef ? { keyRef: input.keyRef } : {}),
      code: 'auth_expired',
      severity: 'fail',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: viaMcp
        ? '登录态已过期：点击卡片上的「去登录」完成续期后再点重试'
        : '鉴权失败（HTTP 401）：API Key 已失效或填错（NewAPI 账户模式需填系统访问令牌而非 sk-*）',
      actionEn: viaMcp
        ? 'Session expired: click "Sign in" on the card to renew cookies, then retry'
        : 'Authentication failed (HTTP 401): API key is invalid or expired (newapi-account requires a system access token, not sk-*)',
    }
  }

  // Endpoint unreachable / HTML response / 404 / DNS / timeout
  if (/\bHTTP\s*(404|502|503|504)\b|不是合法\s*JSON|<!doctype|<html|enotfound|econnrefused|econnreset|etimedout|fetch failed|timed?\s*out|aborterror|network/i.test(rawMsg)) {
    return {
      id: input.id,
      label: input.label,
      ...(input.keyRef ? { keyRef: input.keyRef } : {}),
      code: 'endpoint_unreachable',
      severity: 'fail',
      ...(sanitized ? { sanitizedMessage: sanitized } : {}),
      actionZh: '端点不可达或返回了非 JSON 页面：请检查网络连通性，或通过 endpointOverrides 覆盖迁移后的接口域名',
      actionEn: 'Endpoint unreachable or returned non-JSON HTML: check network access or set endpointOverrides if the vendor migrated hosts',
    }
  }

  return {
    id: input.id,
    label: input.label,
    ...(input.keyRef ? { keyRef: input.keyRef } : {}),
    code: 'unknown_error',
    severity: 'fail',
    ...(sanitized ? { sanitizedMessage: sanitized } : {}),
    actionZh: '上游返回未识别异常：可点卡片右上「测」复核，或复制脱敏自检报告提交反馈',
    actionEn: 'Unrecognized upstream error: click "Test" on the card or copy the redacted report to file an issue',
  }
}

/** Build a full diagnostic summary + copyable redacted Markdown report. */
export function buildDiagnosticReport(
  providers: readonly DiagnosticInput[],
  opts: { lang?: 'zh' | 'en'; exposeAgentTool?: boolean; skippedRoutes?: ReadonlyArray<{ id: string; reasonZh: string; reasonEn: string }> } = {},
): DiagnosticReport {
  const lang = opts.lang ?? 'zh'
  const entries = providers.map(classifyQuotaIssue)
  const passCount = entries.filter((e) => e.severity === 'pass').length
  const warnCount = entries.filter((e) => e.severity === 'warn').length
  const failCount = entries.filter((e) => e.severity === 'fail').length

  const verdictLine = warnCount > 0
    ? `PASS ${String(passCount)} / FAIL ${String(failCount)} / WARN ${String(warnCount)}`
    : `PASS ${String(passCount)} / FAIL ${String(failCount)}`

  const lines: string[] = [
    verdictLine,
    `- agentTool(quota_refresh): ${opts.exposeAgentTool === true ? 'enabled' : 'disabled (default)'}`,
  ]
  for (const e of entries) {
    const tag = e.severity.toUpperCase()
    const refPart = e.keyRef ? ` [ref=${redactSecrets(e.keyRef)}]` : ''
    const msPart = e.probeMs !== undefined ? ` (${String(e.probeMs)}ms)` : ''
    const action = lang === 'en' ? e.actionEn : e.actionZh
    const detail = e.sanitizedMessage ? ` — ${e.sanitizedMessage.slice(0, 140)}` : ''
    lines.push(`- [${tag}] ${e.id} (${e.code})${refPart}${msPart}: ${action}${detail}`)
  }
  for (const s of opts.skippedRoutes ?? []) {
    lines.push(`- [INFO] route:${s.id}: ${lang === 'en' ? s.reasonEn : s.reasonZh}`)
  }

  return {
    verdictLine,
    passCount,
    warnCount,
    failCount,
    entries,
    markdown: lines.join('\n'),
  }
}
