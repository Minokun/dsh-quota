import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../src/config.ts'
import { unwrapVolatile } from '../src/state-store.ts'
import { createAgentToolSync } from '../src/tools.ts'
import { buildDiagnosticReport, classifyQuotaIssue, redactSecrets } from '../src/diagnostics.ts'
import type { QuotaControllerFace } from '../src/controller.ts'

test('Config defaults exposeAgentTool to false so LLM turns pay zero tool-schema tokens by default', () => {
  const resolved = Config({})
  assert.equal(unwrapVolatile(resolved.exposeAgentTool), false)
})

test('createAgentToolSync does NOT register quota_refresh when false, and mounts/disposes dynamically on toggle', () => {
  const registered: string[] = []
  let disposedCount = 0
  const fakeCtx = {
    tools: {
      register(def: { name: string }) {
        registered.push(def.name)
        return () => { disposedCount += 1 }
      },
    },
  } as never
  const fakeQuota = {
    refresh: async () => Config({}),
  } as unknown as QuotaControllerFace

  const sync = createAgentToolSync(fakeCtx, fakeQuota)

  // Default disabled: never calls ctx.tools.register
  sync.sync(false)
  assert.equal(registered.length, 0)

  // Opt-in enabled: registers quota_refresh once (idempotent on repeated true)
  sync.sync(true)
  sync.sync(true)
  assert.deepEqual(registered, ['quota_refresh'])
  assert.equal(disposedCount, 0)

  // Toggled back off: disposes registration cleanly
  sync.sync(false)
  assert.equal(disposedCount, 1)

  // Re-enabled then plugin unloaded
  sync.sync(true)
  assert.equal(registered.length, 2)
  sync.dispose()
  assert.equal(disposedCount, 2)
})

test('redactSecrets scrubs Bearer tokens, sk-* keys, vela_ctrl_*, JWTs, cookies, and home usernames', () => {
  const dirty = [
    'HTTP 401 Invalid Authorization: Bearer sk-1234567890abcdefXYZ',
    'openai key sk-admin-9876543210secret and vela_ctrl_abc1234567',
    'cookie=session_token_value_999; x-api-key: rk-abcdef12345678',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc1234567',
    'url https://alice:hunter2@api.example.com/v1/billing',
    'file /Users/wxk/.dsh/secrets.json',
  ].join(' | ')

  const clean = redactSecrets(dirty)
  assert.equal(clean.includes('1234567890abcdefXYZ'), false)
  assert.equal(clean.includes('9876543210secret'), false)
  assert.equal(clean.includes('abc1234567'), false)
  assert.equal(clean.includes('session_token_value_999'), false)
  assert.equal(clean.includes('hunter2'), false)
  assert.equal(clean.includes('/Users/wxk/'), false)
  assert.ok(clean.includes('~/'))
})

test('classifyQuotaIssue categorizes 401, 403 Admin scope, 404 HTML, timeout, 429, and missing-mcp', () => {
  const c401 = classifyQuotaIssue({
    id: 'deepseek',
    label: 'DeepSeek',
    status: 'error',
    message: 'HTTP 401 Invalid token sk-1234567890abcdef',
  })
  assert.equal(c401.code, 'auth_expired')
  assert.equal(c401.severity, 'fail')
  assert.ok(c401.sanitizedMessage?.includes('sk-***'))
  assert.equal(c401.sanitizedMessage?.includes('1234567890abcdef'), false)

  const c403 = classifyQuotaIssue({
    id: 'openai',
    label: 'OpenAI',
    status: 'error',
    message: 'HTTP 403 Forbidden: insufficient permissions',
  })
  assert.equal(c403.code, 'insufficient_scope')
  assert.match(c403.actionZh, /Admin Key/i)
  assert.match(c403.actionEn, /Admin Key/i)

  const cHtml = classifyQuotaIssue({
    id: 'minimax',
    label: 'MiniMax',
    status: 'error',
    message: '响应不是合法 JSON: <!DOCTYPE html><html>404</html>',
  })
  assert.equal(cHtml.code, 'endpoint_unreachable')

  const cTimeout = classifyQuotaIssue({
    id: 'custom-relay',
    label: 'Relay',
    status: 'ok',
    probeOk: false,
    probeMessage: 'TimeoutError: The operation timed out',
  })
  assert.equal(cTimeout.code, 'endpoint_unreachable')
  assert.equal(cTimeout.severity, 'fail')

  const c429 = classifyQuotaIssue({
    id: 'kimi',
    label: 'Kimi',
    status: 'error',
    message: 'HTTP 429 Too Many Requests',
  })
  assert.equal(c429.code, 'rate_limited')
  assert.equal(c429.severity, 'warn')

  const cMcp = classifyQuotaIssue({
    id: 'bigmodel',
    label: 'BigModel',
    status: 'missing-mcp',
    message: 'MCP not registered',
  })
  assert.equal(cMcp.code, 'mcp_not_configured')
  assert.equal(cMcp.severity, 'warn')
})

test('buildDiagnosticReport outputs PASS X / FAIL Y verdict on line 1 and zero raw secrets in markdown', () => {
  const report = buildDiagnosticReport(
    [
      { id: 'deepseek', label: 'DeepSeek', status: 'ok', keyRef: 'DEEPSEEK_API_KEY' },
      { id: 'kimi', label: 'Kimi Code', status: 'ok', keyRef: 'KIMI_CODING_API_KEY' },
      { id: 'openai', label: 'OpenAI', status: 'error', keyRef: 'OPENAI_ADMIN_KEY', message: 'HTTP 403 key sk-1234567890abcdef rejected' },
    ],
    {
      lang: 'en',
      exposeAgentTool: false,
      skippedRoutes: [{ id: 'my-relay', reasonZh: '跳过', reasonEn: 'Skipped non-official origin' }],
    },
  )
  const firstLine = report.markdown.split('\n')[0]!
  assert.equal(firstLine, 'PASS 2 / FAIL 1')
  assert.equal(report.passCount, 2)
  assert.equal(report.failCount, 1)
  assert.equal(report.markdown.includes('1234567890abcdef'), false)
  assert.ok(report.markdown.includes('[ref=OPENAI_ADMIN_KEY]'))
  assert.ok(report.markdown.includes('route:my-relay'))
})
