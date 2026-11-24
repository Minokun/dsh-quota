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

/**
 * Credentials domain stub: ref name → stored key, plus the DeepSeek account
 * grant record the signed-in session leaves behind
 * (`deepseek-account-platform/default`, `{kind:'grant', payload:{token}}`).
 */
function fakeCredentials(keys: Record<string, string>, accountToken?: string): CredentialProvider {
  return {
    async resolve(ref: string) {
      const value = keys[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async readRecord(key: string) {
      if (accountToken === undefined || key !== 'deepseek-account-platform/default') return undefined
      return { kind: 'grant', payload: { version: 1, token: accountToken, issuer: 'https://platform.deepseek.com' } }
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
    providerOrder: [],
    providerKeyRefs: {},
    history: {},
    alertPercent: 85,
    currentModel: { provider: '', model: '', platform: '', summary: '' },
    providers: [],
  }
}

/**
 * Balance the stubbed DeepSeek account-grant endpoint reports for one token
 * (the wallet behind a real sign-in — a different wallet from any API key).
 */
const ACCOUNT_BALANCE: Record<string, { normal: string; bonus: string }> = {
  'tok-mine': { normal: '2230.1191582500000000', bonus: '0' },
}

/** Run one refresh against a stubbed DeepSeek endpoint; always restores globals. */
async function refreshWith(
  keys: Record<string, string>,
  providers: LlmProviderInfo[],
  options: { accountToken?: string; defaultModel?: { provider: string; model: string } } = {},
): Promise<Config> {
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
    // The signed-in account's wallet, read with the account grant instead of a key.
    if (String(input).startsWith('https://platform.deepseek.com/api/v0/users/get_user_summary')) {
      const token = new Headers(init?.headers).get('x-dsh-auth-token') ?? ''
      const wallet = ACCOUNT_BALANCE[token]
      if (wallet === undefined) return new Response('', { status: 401 })
      return new Response(JSON.stringify({
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            normal_wallets: [{ currency: 'CNY', balance: wallet.normal, token_estimation: '0' }],
            bonus_wallets: [{ currency: 'CNY', balance: wallet.bonus, token_estimation: '0' }],
          },
        },
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
      () => fakeCredentials(keys, options.accountToken),
      () => [],
      () => options.defaultModel,
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

test('refresh: the signed-in DeepSeek account reports ITS wallet, not an unrelated key\'s zero balance', async () => {
  // Reproduces the reported bug: a second person's `DEEPSEEK_API_KEY` sits in
  // the credential store, the user is signed in to their own account, and the
  // selected model is served by the account route — yet the panel showed the
  // other key's ¥0.00 as if it were the account balance.
  const state = await refreshWith(
    { DEEPSEEK_API_KEY: 'sk-someone-else' },
    [
      { id: 'deepseek-account', label: 'DeepSeek Account' },
      { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
    ],
    { accountToken: 'tok-mine', defaultModel: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  )
  const rows = state.providers.filter((p) => p.id.startsWith('deepseek'))

  // The account wallet becomes its own card, and it comes first so the
  // current-model claim resolves to it.
  const account = rows[0]
  assert.equal(account?.id, 'deepseek#DEEPSEEK_ACCOUNT')
  assert.equal(account?.label, 'DeepSeek · 账号')
  assert.equal(account?.status, 'ok')
  assert.equal(account?.items[0]?.display, '¥2,230.12')
  assert.equal(account?.items[0]?.remaining, 2230.11915825)

  // The other person's key keeps its own, distinctly labelled card.
  const keyRow = rows.find((row) => row.id === 'deepseek#DEEPSEEK_API_KEY')
  assert.ok(keyRow, 'the API-key wallet stays visible as its own card')
  assert.equal(keyRow.label, 'DeepSeek · DEEPSEEK_API_KEY')
  assert.equal(keyRow.items[0]?.display, '¥0.00')

  // Exactly two rows: the account card must not shadow or duplicate the key card.
  assert.equal(rows.length, 2)

  // The provider→row mapping lets the panel claim the account card for the
  // account route instead of falling back to whichever DeepSeek row is first.
  assert.equal(state.providerKeyRefs['deepseek-account'], 'DEEPSEEK_ACCOUNT')
  assert.equal(state.providerKeyRefs['deepseek-official'], 'DEEPSEEK_API_KEY')

  // The pill's one-line summary now reflects the account wallet.
  assert.equal(state.currentModel.platform, 'deepseek#DEEPSEEK_ACCOUNT')
  assert.match(state.currentModel.summary, /2,230\.12/)
})

test('refresh: an account card that cannot read its wallet fails loudly instead of showing zero', async () => {
  const state = await refreshWith(
    { DEEPSEEK_API_KEY: 'sk-main' },
    [
      { id: 'deepseek-account', label: 'DeepSeek Account' },
      { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
    ],
    // Token the stub does not recognise → HTTP 401 from the platform.
    { accountToken: 'tok-expired' },
  )
  const rows = state.providers.filter((p) => p.id.startsWith('deepseek'))
  const account = rows.find((row) => row.id === 'deepseek#DEEPSEEK_ACCOUNT')
  assert.ok(account, 'the account card still renders')
  assert.equal(account.status, 'error')
  assert.equal(account.items.length, 0, 'a failed read never fabricates a zero balance')
  assert.match(account.message ?? '', /登录|401/)
})

test('refresh: without a stored account grant no account card appears (backward compatible)', async () => {
  const state = await refreshWith({ DEEPSEEK_API_KEY: 'sk-main' }, [
    { id: 'deepseek-account', label: 'DeepSeek Account' },
    { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
  ])
  const rows = state.providers.filter((p) => p.id.startsWith('deepseek'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, 'deepseek')
  assert.equal(rows[0]?.label, 'DeepSeek')
  assert.equal(state.providerKeyRefs['deepseek-account'], undefined)
})
