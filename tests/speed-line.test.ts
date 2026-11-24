import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardSpeedOf, cardSpeedsOf, speedTone } from '../src/client/speed-line.ts'
import type { PanelProvider } from '../src/client/controller.ts'
import type { ModelSpeedSummary } from '../src/speed-sampler.ts'

function card(id: string, label = id, keyRef?: string): PanelProvider {
  return {
    id,
    label,
    status: 'ok',
    via: 'api',
    ...(keyRef === undefined ? {} : { keyRef }),
    items: [{ label: '5 小时窗口', percent: 20, display: '已用 20%' }],
  } as unknown as PanelProvider
}

function summary(model: string, over: Partial<ModelSpeedSummary> = {}): ModelSpeedSummary {
  return { model, n: 10, skipped: 0, kind: 'stream', tpsAggregate: 120, ...over }
}

test('magpie 行认领自己 provider 前缀的模型', () => {
  const view = cardSpeedOf(card('magpie#agy-cli', 'Magpie · Antigravity'), [summary('agy-cli/gemini-4-neon')])
  assert.ok(view)
  assert.equal(view.kind, 'stream')
  assert.equal(view.headline, 120)
})

test('一张卡上多个模型时，取样本最多的那个（不是列表第一个）', () => {
  const view = cardSpeedOf(card('magpie#agy-cli', 'Magpie · Antigravity'), [
    summary('agy-cli/gemini-4-hydrogen', { n: 2, tpsAggregate: 300 }),
    summary('agy-cli/gemini-4-carbon', { n: 54, tpsAggregate: 104 }),
    summary('agy-cli/gemini-4-neon', { n: 20, tpsAggregate: 134 }),
  ])
  assert.equal(view?.model, 'agy-cli/gemini-4-carbon')
  assert.equal(view?.headline, 104)
})

test('当前会话模型优先显示在它的卡上', () => {
  const view = cardSpeedOf(
    card('magpie#agy-cli', 'Magpie · Antigravity'),
    [summary('agy-cli/gemini-4-carbon', { n: 54, tpsAggregate: 104 }), summary('agy-cli/gemini-4-neon', { n: 2, tpsAggregate: 134 })],
    {},
    'agy-cli/gemini-4-neon',
  )
  assert.equal(view?.model, 'agy-cli/gemini-4-neon')
})

test('别的平台的模型不会串到这张卡上', () => {
  const view = cardSpeedOf(card('kimi', 'Kimi Code'), [summary('agy-cli/gemini-4-neon')])
  assert.equal(view, undefined)
})

test('只有批式样本时明确报 batched，绝不印一个假的速度', () => {
  const view = cardSpeedOf(card('magpie#agy-cli', 'Magpie · Antigravity'), [
    summary('agy-cli/claude-opus-5-5', { n: 0, skipped: 113, kind: 'batched', tpsAggregate: undefined }),
  ])
  assert.ok(view)
  assert.equal(view.kind, 'batched')
  assert.equal(view.headline, undefined)
  assert.equal(view.skipped, 113)
})

test('还没有样本的模型不占位置', () => {
  assert.equal(cardSpeedOf(card('kimi', 'Kimi Code'), [summary('x/y', { kind: 'none', n: 0 })]), undefined)
  assert.equal(cardSpeedOf(card('kimi', 'Kimi Code'), []), undefined)
})

test('secondary 读数只带存在的那些字段（不渲染 undefined）', () => {
  const view = cardSpeedOf(card('magpie#agy-cli'), [summary('agy-cli/gemini-4-neon', {
    tpsTypical: 133.74, ttftMedianMs: undefined, bodyTpsMedian: 61.2,
  })])
  assert.ok(view)
  assert.equal(view.typical, 133.7)
  assert.equal(view.ttftMs, undefined)
  assert.equal(view.bodyTps, 61.2)
  assert.ok(!('ttftMs' in view) || view.ttftMs === undefined)
})

test('速度档位阈值', () => {
  assert.equal(speedTone(250), 'fast')
  assert.equal(speedTone(200), 'fast')
  assert.equal(speedTone(120), 'mid')
  assert.equal(speedTone(80), 'mid')
  assert.equal(speedTone(79.9), 'slow')
  assert.equal(speedTone(undefined), undefined)
})

test('真实 DSH 三段式 Magpie 模型 id 只归属对应子卡，未使用的 Magpie 卡片绝不串台显示 103 tok/s', () => {
  const cards = [
    card('magpie#workbuddy', 'Magpie · WorkBuddy · Free plan'),
    card('magpie#devin', 'Magpie · Devin'),
    card('magpie#agy-cli', 'Magpie · Antigravity (local agy CLI)'),
    card('magpie#sidrune', 'Magpie · sidrune'),
    card('magpie#codex', 'Magpie · codex'),
    card('magpie#open-design', 'Magpie · open-design'),
    card('magpie#kimi-work', 'Magpie · kimi-work'),
  ]
  const summaries = [
    summary('magpie-anthropic/agy-cli/gemini-4-carbon', { n: 14, skipped: 702, tpsAggregate: 103.26 }),
    summary('magpie-anthropic/devin/claude-opus-5-5', { n: 8, skipped: 5, tpsAggregate: 186.36 }),
    summary('magpie-anthropic/agy-cli/gemini-4-hydrogen', { n: 2, skipped: 149, tpsAggregate: 405.33 }),
  ]
  const speeds = cardSpeedsOf(cards, summaries, { 'magpie-anthropic': 'MAGPIE_API_KEY' })

  assert.equal(speeds['magpie#agy-cli']?.headline, 103.3)
  assert.equal(speeds['magpie#agy-cli']?.model, 'magpie-anthropic/agy-cli/gemini-4-carbon')
  assert.equal(speeds['magpie#devin']?.headline, 186.4)
  assert.equal(speeds['magpie#devin']?.model, 'magpie-anthropic/devin/claude-opus-5-5')
  // 没用过的卡片必须保持 undefined，绝不能被 agy-cli 的 103 污染
  assert.equal(speeds['magpie#workbuddy'], undefined)
  assert.equal(speeds['magpie#sidrune'], undefined)
  assert.equal(speeds['magpie#codex'], undefined)
  assert.equal(speeds['magpie#open-design'], undefined)
  assert.equal(speeds['magpie#kimi-work'], undefined)
})

test('同平台多账号（DeepSeek 账号钱包 vs 别人的 API Key）严格隔离，未使用账号不显示速度', () => {
  const accountCard = card('deepseek#account', 'DeepSeek · 账号', 'DEEPSEEK_ACCOUNT')
  const keyCard = card('deepseek', 'DeepSeek · DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY')
  const refs = {
    'deepseek-account': 'DEEPSEEK_ACCOUNT',
    'deepseek-official': 'DEEPSEEK_API_KEY',
  }
  const summaries = [summary('deepseek-account/deepseek-flash', { n: 225, tpsAggregate: 229.1 })]
  const speeds = cardSpeedsOf([accountCard, keyCard], summaries, refs)

  assert.equal(speeds['deepseek#account']?.headline, 229.1)
  assert.equal(speeds['deepseek'], undefined)

  // 即使账号钱包卡因退出登录暂时不在面板上，其历史测速也绝不能落到 API Key 卡上
  const keyOnly = cardSpeedsOf([keyCard], summaries, { 'deepseek-official': 'DEEPSEEK_API_KEY' })
  assert.equal(keyOnly['deepseek'], undefined)
})

test('独立平台与同名 Magpie 子卡并存时不互串，控制面不同名 keyRef 仍正常归属', () => {
  const cards = [
    card('opendesign', 'OpenDesign · plus', 'OPENDESIGN_CONTROL_KEY'),
    card('magpie#open-design', 'Magpie · open-design'),
    card('volcark', '火山方舟 · Coding Plan', 'ARK_ACCESS_KEY_ID'),
    card('probe#bailian-coding', 'qwen3.8-flash-next', 'BAILIAN_CODING_API_KEY'),
  ]
  const refs = {
    opendesign: 'OPENDESIGN_API_KEY',
    ark: 'ARK_API_KEY',
    'bailian-coding': 'BAILIAN_CODING_API_KEY',
  }
  const summaries = [
    summary('opendesign/deepseek-v4.1-flash', { n: 157, tpsAggregate: 267.6 }),
    summary('ark/doubao-seed-2.0-code', { n: 12, tpsAggregate: 88.4 }),
  ]
  const speeds = cardSpeedsOf(cards, summaries, refs)

  assert.equal(speeds['opendesign']?.headline, 267.6)
  assert.equal(speeds['magpie#open-design'], undefined)
  assert.equal(speeds['volcark']?.headline, 88.4)
  assert.equal(speeds['probe#bailian-coding'], undefined)
})

test('同一张卡既有可测流式模型又有纯批式模型时，默认优先展示可测流式速度', () => {
  const agyCard = card('magpie#agy-cli', 'Magpie · Antigravity')
  const summaries = [
    summary('magpie-anthropic/agy-cli/claude-opus-5-5', { n: 0, skipped: 500, kind: 'batched', tpsAggregate: undefined }),
    summary('magpie-anthropic/agy-cli/gemini-4-carbon', { n: 14, skipped: 20, tpsAggregate: 103.3 }),
  ]
  const speeds = cardSpeedsOf([agyCard], summaries)
  assert.equal(speeds['magpie#agy-cli']?.kind, 'stream')
  assert.equal(speeds['magpie#agy-cli']?.headline, 103.3)

  // 若当前会话正在用那个纯批式模型，则如实提示当前模型是批式
  const activeBatched = cardSpeedsOf([agyCard], summaries, {}, 'magpie-anthropic/agy-cli/claude-opus-5-5')
  assert.equal(activeBatched['magpie#agy-cli']?.kind, 'batched')
})
