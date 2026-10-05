import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertCount, alertLines, providerAlertCount, providerAlertLines, type AlertSnapshot } from '../src/client/alerts.ts'
import type { PanelProvider } from '../src/client/controller.ts'
import { translate, type TFn } from '../src/client/locale.ts'

const t: TFn = (key, params) => translate('zh', key, params)

/** One provider row with the fields alert accounting reads. */
function provider(overrides: Partial<PanelProvider> = {}): PanelProvider {
  return { id: 'kimi', label: 'Kimi Code', status: 'ok', items: [], ...overrides }
}

/** Snapshot with the default 85% threshold unless overridden. */
function snapshot(providers: PanelProvider[], loginAlerts: AlertSnapshot['loginAlerts'] = [], alertPercent = 85): AlertSnapshot {
  return { providers, loginAlerts, alertPercent }
}

test('usage at or above the threshold counts, below it does not', () => {
  const state = snapshot([provider({
    items: [
      { label: '周额度', percent: 85 },
      { label: '300m 窗口', percent: 89 },
      { label: '未越阈值', percent: 84.9 },
      { label: '无数值', display: '¥10' },
    ],
  })])
  assert.equal(alertCount(state), 2)
  assert.deepEqual(alertLines(state, t), ['Kimi Code 周额度 已用 85%', 'Kimi Code 300m 窗口 已用 89%'])
})

test('a configured threshold moves the line, independent of the 85% color band', () => {
  const items = [{ label: '5 小时窗口', percent: 72 }]
  assert.equal(alertCount(snapshot([provider({ items })])), 0)
  assert.equal(alertCount(snapshot([provider({ items })], [], 70)), 1)
  assert.equal(alertLines(snapshot([provider({ items })], [], 70), t)[0], 'Kimi Code 5 小时窗口 已用 72%')
})

test('failed platforms and expired sign-ins count once each, and appear on their own card', () => {
  const failed = provider({ id: 'zhipu', label: '智谱', status: 'error', message: 'HTTP 401' })
  const expiring = provider({ id: 'qianwen', label: '通义千问', status: 'error', message: '未登录' })
  const state = snapshot([failed, expiring], [{ id: 'qianwen', label: '通义千问' }])
  assert.equal(alertCount(state), 3)
  assert.deepEqual(providerAlertLines(failed, state, t), ['智谱 查询失败'])
  assert.deepEqual(providerAlertLines(expiring, state, t), ['通义千问 查询失败', '通义千问 登录失效'])
  assert.equal(providerAlertCount(expiring, state), 2)
})

test('a failed platform contributes no usage alerts (its items are empty)', () => {
  const failed = provider({ status: 'error', items: [{ label: '周额度', percent: 99 }] })
  assert.equal(alertCount(snapshot([failed])), 1)
  assert.deepEqual(alertLines(snapshot([failed]), t), ['Kimi Code 查询失败'])
})

test('the badge total is exactly the sum of the per-card counts (and of the lines)', () => {
  const state = snapshot([
    provider({ id: 'kimi', label: 'Kimi Code', items: [{ label: '周额度', percent: 89 }, { label: '300m 窗口', percent: 95 }] }),
    provider({ id: 'zhipu', label: '智谱', status: 'error', message: 'HTTP 500' }),
    provider({ id: 'qianwen', label: '通义千问', items: [{ label: 'Coding Plan', percent: 10 }] }),
  ], [{ id: 'qianwen', label: '通义千问' }])
  const perCard = state.providers.reduce((n, p) => n + providerAlertCount(p, state), 0)
  assert.equal(alertCount(state), perCard)
  assert.equal(alertLines(state, t).length, perCard)
  assert.equal(perCard, 4)
})

test('a clean panel reports nothing', () => {
  assert.equal(alertCount(snapshot([provider({ items: [{ label: '周额度', percent: 12 }] })])), 0)
})
