import assert from 'node:assert/strict'
import test from 'node:test'
import { ARK_PLATFORM_ID, platformForProvider } from '../src/platform-map.ts'
// The browser half's re-export: orderProviders resolves through this path.
import { platformForProvider as clientPlatformForProvider } from '../src/client/platform-map.ts'
// The host half's re-export: the refresh path resolves through this path.
import { platformForProvider as hostPlatformForProvider } from '../src/controller.ts'

test('ark maps onto the 火山方舟 quota row (the regression that broke panel ordering)', () => {
  // 面板里的火山方舟行 id 是 volcark；供应商 id 是 ark。客户端曾经没有这条
  // 规则，于是「当前在用平台置顶」认不出这张卡，顺序看起来没生效。
  assert.equal(platformForProvider('ark'), ARK_PLATFORM_ID)
  assert.equal(platformForProvider('ARK'), ARK_PLATFORM_ID)
  assert.equal(platformForProvider('volcengine'), ARK_PLATFORM_ID)
  assert.equal(platformForProvider('doubao'), ARK_PLATFORM_ID)
})

test('the host and browser halves resolve every provider identically', () => {
  // 两份手抄副本是这次 bug 的根因：Host 有 ark 规则、客户端没有。任何新增
  // 供应商都必须同时出现在两边，这条用例把「两边一致」钉死。
  const ids = [
    'kimi-coding', 'deepseek-official', 'deepseek-b', 'zai-coding-cn', 'glm-5.3', 'bigmodel',
    'qwen3.8', 'dashscope', 'scnet', 'tokenrouter', 'moonshot', 'openrouter', 'siliconflow',
    'minimax', 'stepfun', 'xai', 'grok-4', 'opendesign', 'opendesign-responses', 'opencode-go',
    'openai', 'anthropic', 'claude-sonnet', 'ark', 'volcengine', 'doubao', 'strata', 'bailian',
    '', 'unknown-provider',
  ]
  for (const id of ids) {
    assert.equal(clientPlatformForProvider(id), hostPlatformForProvider(id), `diverged on "${id}"`)
    assert.equal(clientPlatformForProvider(id), platformForProvider(id), `re-export drifted on "${id}"`)
  }
})

test('platformForProvider keeps the fuzzy rules it already had', () => {
  assert.equal(platformForProvider('kimi-coding'), 'kimi')
  assert.equal(platformForProvider('deepseek-official'), 'deepseek')
  assert.equal(platformForProvider('zai-coding-cn'), 'zhipu')
  assert.equal(platformForProvider('opendesign'), 'opendesign')
  assert.equal(platformForProvider('qwen3.8'), 'qianwen')
  // 精确 id 才认 ark：别的平台 id 里含 'ark' 不能被误伤。
  assert.equal(platformForProvider('dark-horse'), '')
  assert.equal(platformForProvider('star'), '')
})
