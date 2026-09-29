import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { createStateStore, unwrapVolatile, type LegacyScopeLike, type SettingsFormsLike } from '../src/state-store.ts'

/** Minimal composition config (schema defaults shape). */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    refreshedAt: '',
    refreshing: false,
    refreshOnBoot: true,
    refreshIntervalMinutes: 5,
    mcpPlatforms: [],
    httpPlatforms: [],
    loginFlows: [{ id: 'scnet', url: 'https://www.scnet.cn/' }],
    providerKeyRefs: {},
    history: {},
    alertPercent: 85,
    currentModel: { provider: '', model: '', platform: '', summary: '' },
    providers: [],
    ...overrides,
  }
}

test('composition config flows through the store (loginFlows included)', () => {
  const store = createStateStore({
    config: baseConfig(),
    entryNs: 'quota',
    getSettingsForms: () => undefined,
    getLegacyScope: () => undefined,
  })
  const state = store.get()
  assert.equal(state.refreshIntervalMinutes, 5)
  assert.equal(state.loginFlows.length, 1)
  assert.equal(state.loginFlows[0]!.id, 'scnet')
})

test('runtime patches land in the memory overlay and survive later reads', async () => {
  const store = createStateStore({
    config: baseConfig(),
    entryNs: 'quota',
    getSettingsForms: () => undefined,
    getLegacyScope: () => undefined,
  })
  assert.equal(store.get().refreshedAt, '')
  await store.update({ refreshedAt: '2026-09-29T00:00:00.000Z', providers: [{ id: 'kimi', label: 'Kimi Code', status: 'ok', via: 'api', items: [] }] })
  const state = store.get()
  assert.equal(state.refreshedAt, '2026-09-29T00:00:00.000Z')
  assert.equal(state.providers.length, 1)
  // Composition base still visible under the overlay.
  assert.equal(state.refreshIntervalMinutes, 5)
})

test('unwrapVolatile reads Volatile wrappers and passes plain values through', () => {
  assert.equal(unwrapVolatile({ get: () => [1, 2] }).length, 2)
  assert.equal(unwrapVolatile(42), 42)
  assert.equal(unwrapVolatile(null), null)
  assert.equal(unwrapVolatile({ get: 'not-a-function' }).get, 'not-a-function')
})

test('volatile config fields read the live value, not a snapshot', () => {
  let live: string[] = ['a']
  const config = baseConfig()
  ;(config as unknown as Record<string, unknown>).httpPlatforms = { get: () => live }
  const store = createStateStore({
    config,
    entryNs: 'quota',
    getSettingsForms: () => undefined,
    getLegacyScope: () => undefined,
  })
  assert.deepEqual(store.get().httpPlatforms as unknown as string[], ['a'])
  live = ['a', 'b']
  assert.deepEqual(store.get().httpPlatforms as unknown as string[], ['a', 'b'])
})

test('persisted keys go through settings.update and leave the memory overlay', async () => {
  const updates: Array<[string, Record<string, unknown>]> = []
  const forms: SettingsFormsLike = { update: async (ns, patch) => { updates.push([ns, patch as Record<string, unknown>]) } }
  let live: Array<{ id: string }> = []
  const config = baseConfig()
  ;(config as unknown as Record<string, unknown>).httpPlatforms = { get: () => live }
  const store = createStateStore({
    config,
    entryNs: 'quota',
    getSettingsForms: () => forms,
    getLegacyScope: () => undefined,
  })
  const added = [{ id: 'my-platform' }]
  await store.update({ httpPlatforms: added as never, refreshedAt: 't1' })
  assert.equal(updates.length, 1)
  assert.equal(updates[0]![0], 'quota')
  assert.deepEqual(updates[0]![1], { httpPlatforms: added })
  // Runtime keys stay in memory; persisted keys fall back to the live volatile read.
  assert.equal(store.get().refreshedAt, 't1')
  live = added
  assert.equal(store.get().httpPlatforms, added)
})

test('persist failure keeps the value in memory and warns', async () => {
  const warnings: string[] = []
  const forms: SettingsFormsLike = { update: async () => { throw new Error('No configurable plugin entry "quota"') } }
  const store = createStateStore({
    config: baseConfig(),
    entryNs: 'quota',
    getSettingsForms: () => forms,
    getLegacyScope: () => undefined,
    onWarn: (m) => { warnings.push(m) },
  })
  await store.update({ httpPlatforms: [{ id: 'x' }] as never })
  assert.equal(warnings.length, 1)
  assert.deepEqual(store.get().httpPlatforms as unknown as Array<{ id: string }>, [{ id: 'x' }])
})

test('legacy scope owns get/update entirely when present', async () => {
  let value = baseConfig({ refreshedAt: 'legacy' })
  const calls: Array<Partial<Config>> = []
  const legacy: LegacyScopeLike = {
    get: () => value,
    update: async (patch) => { calls.push(patch); value = { ...value, ...patch } },
  }
  const store = createStateStore({
    config: baseConfig(),
    entryNs: 'quota',
    getSettingsForms: () => undefined,
    getLegacyScope: () => legacy,
  })
  assert.equal(store.get().refreshedAt, 'legacy')
  await store.update({ refreshedAt: 't2', httpPlatforms: [{ id: 'y' }] as never })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.refreshedAt, 't2')
  assert.equal(store.get().refreshedAt, 't2')
})
