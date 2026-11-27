import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Config } from '../src/config.ts'
import { QuotaController, livenessRequest, type LlmProviderInfo } from '../src/controller.ts'
import { createStateStore } from '../src/state-store.ts'

// A custom Anthropic-protocol route (api: anthropic-messages) has no quota row,
// so the panel shows a liveness card for it. Its model list lives at
// <base>/v1/models behind x-api-key — <base>/models with a bearer token is a 404.

test('livenessRequest: anthropic-messages uses /v1/models with x-api-key', () => {
  assert.deepEqual(livenessRequest('https://api.anthropic.com', 'k', 'anthropic-messages'), {
    url: 'https://api.anthropic.com/v1/models',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  })
  // A gateway base that already ends in /v1 (or a trailing slash) is not doubled.
  assert.equal(livenessRequest('https://gw.example/anthropic/v1/', 'k', 'anthropic-messages').url, 'https://gw.example/anthropic/v1/models')
  assert.equal(livenessRequest('https://api.commandcode.ai/provider', 'k', 'anthropic-messages').url, 'https://api.commandcode.ai/provider/v1/models')
})

test('livenessRequest: other protocols keep <base>/models with a bearer token', () => {
  assert.deepEqual(livenessRequest('https://api.example.com/v1/', 'k'), {
    url: 'https://api.example.com/v1/models',
    headers: { Authorization: 'Bearer k' },
  })
  assert.equal(livenessRequest('https://api.example.com/v1', 'k', 'openai-completions').headers.Authorization, 'Bearer k')
})

function fakeCredentials(keys: Record<string, string>): CredentialProvider {
  return {
    async resolve(ref: string) {
      const value = keys[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async readRecord() { return undefined },
  } as unknown as CredentialProvider
}

function fakeContext(): Context {
  return {
    effect: () => () => undefined,
    get: () => undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as unknown as Context
}

function baseConfig(): Config {
  return {
    refreshedAt: '', refreshing: false, refreshOnBoot: false, refreshIntervalMinutes: 0,
    mcpPlatforms: [], httpPlatforms: [], loginFlows: [], providerOrder: [], providerKeyRefs: {},
    history: {}, alertPercent: 85, currentModel: { provider: '', model: '', platform: '', summary: '' }, providers: [],
  }
}

const ANTHROPIC_2: LlmProviderInfo = {
  id: 'anthropic-2', label: 'Anthropic API (2)', keyRef: 'ANTHROPIC_API_KEY_2',
  baseURL: 'https://api.anthropic.com', api: 'anthropic-messages',
}

/** Stub fetch: only the Anthropic-protocol model list with the right key answers 200. */
async function withAnthropicStub<T>(run: (controller: QuotaController) => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-probe-'))
  const originalFetch = globalThis.fetch
  const originalHistoryFile = process.env.DSH_QUOTA_HISTORY_FILE
  process.env.DSH_QUOTA_HISTORY_FILE = join(dir, 'history.json')
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    const headers = new Headers(init?.headers)
    const ok = url === 'https://api.anthropic.com/v1/models' && headers.get('x-api-key') === 'sk-ant-2' && headers.get('anthropic-version') !== null
    return new Response(ok ? '{"data":[]}' : '', { status: ok ? 200 : 404 })
  }) as typeof fetch
  try {
    const store = createStateStore({ config: baseConfig(), entryNs: 'quota', getSettingsForms: () => undefined, getLegacyScope: () => undefined })
    const controller = new QuotaController(fakeContext(), store, () => fakeCredentials({ ANTHROPIC_API_KEY_2: 'sk-ant-2' }), () => [], () => undefined, () => [ANTHROPIC_2])
    return { result: await run(controller), urls }
  } finally {
    globalThis.fetch = originalFetch
    if (originalHistoryFile === undefined) delete process.env.DSH_QUOTA_HISTORY_FILE
    else process.env.DSH_QUOTA_HISTORY_FILE = originalHistoryFile
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

test('refresh: an anthropic-messages provider without a quota row probes /v1/models and shows online', async () => {
  const { result: state, urls } = await withAnthropicStub((c) => c.refresh())
  const row = state.providers.find((p) => p.id === 'probe#anthropic-2')
  assert.ok(row, 'liveness card exists')
  assert.equal(row.status, 'ok', `card is online, not "探测失败 HTTP 404": ${row.message ?? ''}`)
  assert.ok(urls.includes('https://api.anthropic.com/v1/models'))
  assert.ok(!urls.includes('https://api.anthropic.com/models'), 'never probes the OpenAI-style path for an Anthropic route')
})

test('probe: the Test button re-runs the liveness probe for a probe# card instead of throwing', async () => {
  const { result } = await withAnthropicStub((c) => c.probe('probe#anthropic-2'))
  assert.equal(result.ok, true, result.message ?? '')
  const missing = await withAnthropicStub((c) => c.probe('probe#not-configured'))
  assert.equal(missing.result.ok, false)
})
