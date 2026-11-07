import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Config } from '../src/config.ts'
import { QuotaController, type LlmProviderInfo } from '../src/controller.ts'
import { createStateStore } from '../src/state-store.ts'

/** Balance the stubbed DeepSeek endpoint reports per bearer token. */
const BALANCE: Record<string, string> = {
  'sk-main': '100.00',
  'sk-backup': '2.50',
}

/** Credentials domain stub: ref name → stored key. */
function fakeCredentials(keys: Record<string, string>): CredentialProvider {
  return {
    async resolve(ref: string) {
      const value = keys[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
  } as unknown as CredentialProvider
}

/** Minimal host context: the refresh path only reads `tools` and registers effects. */
function fakeContext(): Context {
  return {
    effect: () => () => undefined,
    get: () => undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as unknown as Context
}

/** Composition base for the state store (every Config field the refresh path reads). */
function baseConfig(): Config {
  return {
    refreshedAt: '',
    refreshing: false,
    refreshOnBoot: false,
    refreshIntervalMinutes: 0,
    mcpPlatforms: [],
    httpPlatforms: [],
    loginFlows: [],
    providerKeyRefs: {},
    history: {},
    alertPercent: 85,
    currentModel: { provider: '', model: '', platform: '', summary: '' },
    providers: [],
  }
}

/** Run one refresh against a stubbed DeepSeek endpoint; always restores globals. */
async function refreshWith(keys: Record<string, string>, providers: LlmProviderInfo[]): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-refresh-'))
  const originalFetch = globalThis.fetch
  const originalHistoryFile = process.env.DSH_QUOTA_HISTORY_FILE
  process.env.DSH_QUOTA_HISTORY_FILE = join(dir, 'history.json')
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('https://api.deepseek.com/user/balance')) {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      const token = auth.replace(/^Bearer\s+/i, '')
      const balance = BALANCE[token] ?? '0.00'
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: balance, granted_balance: '0.00', topped_up_balance: balance }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const store = createStateStore({
      config: baseConfig(),
      entryNs: 'quota',
      getSettingsForms: () => undefined,
      getLegacyScope: () => undefined,
    })
    const controller = new QuotaController(
      fakeContext(),
      store,
      () => fakeCredentials(keys),
      () => [],
      () => undefined,
      () => providers,
    )
    return await controller.refresh()
  } finally {
    globalThis.fetch = originalFetch
    if (originalHistoryFile === undefined) delete process.env.DSH_QUOTA_HISTORY_FILE
    else process.env.DSH_QUOTA_HISTORY_FILE = originalHistoryFile
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

test('refresh: one DeepSeek key keeps the single un-suffixed card (backward compatible)', async () => {
  const state = await refreshWith({ DEEPSEEK_API_KEY: 'sk-main' }, [
    { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
  ])
  const rows = state.providers.filter((p) => p.id.startsWith('deepseek'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, 'deepseek')
  assert.equal(rows[0]?.label, 'DeepSeek')
  assert.equal(rows[0]?.items[0]?.display, '¥100.00')
})

test('refresh: a second provider route on the same platform becomes its own card', async () => {
  const state = await refreshWith(
    { DEEPSEEK_API_KEY: 'sk-main', DEEPSEEK_B_API_KEY: 'sk-backup' },
    [
      { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
      { id: 'deepseek-b', label: 'DeepSeek B', keyRef: 'DEEPSEEK_B_API_KEY', baseURL: 'https://api.deepseek.com/v1' },
    ],
  )
  const rows = state.providers.filter((p) => p.id.startsWith('deepseek'))
  assert.equal(rows.length, 2)

  const byId = new Map(rows.map((row) => [row.id, row]))
  const main = byId.get('deepseek#DEEPSEEK_API_KEY')
  const backup = byId.get('deepseek#DEEPSEEK_B_API_KEY')
  assert.ok(main, 'the official ref keeps its own card')
  assert.ok(backup, 'the second ref gets its own card')

  // Both cards stay labelled, and only the extra route is tagged with its id.
  assert.equal(main?.label, 'DeepSeek')
  assert.equal(backup?.label, 'DeepSeek · deepseek-b')
  // Each card reports ITS account balance — not the other one's.
  assert.equal(main?.items[0]?.display, '¥100.00')
  assert.equal(backup?.items[0]?.display, '¥2.50')
  assert.equal(main?.keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(backup?.keyRef, 'DEEPSEEK_B_API_KEY')

  // The provider→row mapping feeds the pill's "current model" summary.
  assert.deepEqual(state.providerKeyRefs, {
    'deepseek-official': 'DEEPSEEK_API_KEY',
    'deepseek-b': 'DEEPSEEK_B_API_KEY',
  })
})
