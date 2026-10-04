import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { llmProvidersOf } from '../src/index.ts'
import { visibleSessionIdOf } from '../src/client/session-model.ts'
import type { SettingsFormsLike } from '../src/state-store.ts'

/** Fake host context exposing only the `llm` directory. */
function ctxWithLlm(llm: unknown): Context {
  return { get: (key: string) => (key === 'llm' ? llm : undefined) } as unknown as Context
}

/** Settings forms stub whose describe() returns the given namespace values. */
function formsWith(values: Record<string, unknown>): SettingsFormsLike {
  return { describe: () => Object.entries(values).map(([ns, value]) => ({ ns, value })) }
}

test('native providers (deepseek-official) are read from their own settings namespace', () => {
  const ctx = ctxWithLlm({
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'kimi-coding', name: 'kimi-coding' },
    ],
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'kimi-coding', displayName: 'Kimi Code', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'kimi-coding'] },
    ],
  })
  const rows = llmProvidersOf(ctx, formsWith({
    'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash' }] },
    'llm-pi-ai': { providers: { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY', baseURL: 'https://api.kimi.com/coding' } } },
  }))
  assert.deepEqual(rows, [
    { id: 'deepseek-official', label: 'DeepSeek', keyRef: 'DEEPSEEK_API_KEY' },
    { id: 'kimi-coding', label: 'Kimi Code', keyRef: 'KIMI_CODING_API_KEY', baseURL: 'https://api.kimi.com/coding' },
  ])
})

test('a route without a declared profile still lists, without a credential ref', () => {
  const ctx = ctxWithLlm({
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
    listConfigurableProviders: () => [
      { provider: 'deepseek-account', displayName: 'DeepSeek 账号', settingsNs: 'llm-deepseek-account', settingsPath: [] },
    ],
  })
  const rows = llmProvidersOf(ctx, formsWith({}))
  assert.deepEqual(rows, [{ id: 'deepseek-account', label: 'DeepSeek 账号' }])
})

test('without the llm service the llm-pi-ai namespace remains the fallback', () => {
  const rows = llmProvidersOf(ctxWithLlm(undefined), formsWith({
    'llm-pi-ai': {
      providers: {
        'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
        'qwen-token-plan-cn': { apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY', baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com' },
      },
    },
  }))
  assert.deepEqual(rows, [
    { id: 'zai-coding-cn', label: 'zai-coding-cn', keyRef: 'ZAI_CODING_CN_API_KEY' },
    { id: 'qwen-token-plan-cn', label: 'qwen-token-plan-cn', keyRef: 'QWEN_TOKEN_PLAN_CN_API_KEY', baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com' },
  ])
})

test('the settings service may arrive late: registered routes still gate platforms', () => {
  const ctx = ctxWithLlm({
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
    ],
  })
  assert.deepEqual(llmProvidersOf(ctx, undefined), [{ id: 'deepseek-official', label: 'DeepSeek' }])
})

test('visible session: the main-view retention row wins over a legacy current id', () => {
  assert.equal(visibleSessionIdOf({
    current: 'stale-session',
    byId: {
      'stale-session': { id: 'stale-session', retainedBy: {} },
      'kimi-session': { id: 'kimi-session', retainedBy: { mainView: 1 } },
    },
  }), 'kimi-session')
})

test('visible session: legacy flat current id (client runtime ≤ 0.1.6) still resolves', () => {
  assert.equal(visibleSessionIdOf({ current: 'kimi-session', byId: {} }), 'kimi-session')
  assert.equal(visibleSessionIdOf({ byId: {} }), undefined)
  assert.equal(visibleSessionIdOf(undefined), undefined)
})
