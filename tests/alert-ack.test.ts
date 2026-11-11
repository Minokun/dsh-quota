import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ackAll, createAlertAckState, deserializeAlertAckState, pruneAcks, serializeAlertAckState } from '../src/client/alert-ack.ts'
import { alertCount, alertIdentities, alertLines, providerAlertCount, type AlertSnapshot } from '../src/client/alerts.ts'
import type { PanelProvider } from '../src/client/controller.ts'
import { translate, type TFn } from '../src/client/locale.ts'

const t: TFn = (key, params) => translate('zh', key, params)

/** One provider row with the fields alert accounting reads. */
function provider(overrides: Partial<PanelProvider> = {}): PanelProvider {
  return { id: 'kimi', label: 'Kimi Code', status: 'ok', items: [], ...overrides }
}

/** Snapshot with the default 85% threshold unless overridden. */
function snapshot(providers: PanelProvider[], ackedAlerts?: Record<string, string>): AlertSnapshot {
  return { providers, loginAlerts: [], alertPercent: 85, ...(ackedAlerts === undefined ? {} : { ackedAlerts }) }
}

test('acking every alert drops the badge total and the lines to zero', () => {
  const state = snapshot([
    provider({ items: [{ label: '周额度', percent: 100, resetAt: '2026-11-14T14:39:28Z' }] }),
    provider({ id: 'zhipu', label: '智谱', status: 'error', message: 'HTTP 401' }),
  ])
  const acked = ackAll(alertIdentities(state))
  assert.equal(Object.keys(acked).length, 2)
  assert.equal(alertCount({ ...state, ackedAlerts: acked }), 0)
  assert.deepEqual(alertLines({ ...state, ackedAlerts: acked }, t), [])
})

test('the per-card count respects the ack as well (no leftover ⚠ on the card)', () => {
  const card = provider({ items: [{ label: '周额度', percent: 92, resetAt: 'w1' }] })
  const state = snapshot([card])
  const acked = ackAll(alertIdentities(state))
  assert.equal(providerAlertCount(card, { ...state, ackedAlerts: acked }), 0)
})

test('a reset window makes the same alert unread again', () => {
  const before = snapshot([provider({ items: [{ label: '周额度', percent: 100, resetAt: 'w1' }] })])
  const acked = ackAll(alertIdentities(before))
  const after = snapshot([provider({ items: [{ label: '周额度', percent: 100, resetAt: 'w2' }] })], acked)
  assert.equal(alertCount(after), 1)
})

test('a different failure message is a new alert', () => {
  const before = snapshot([provider({ status: 'error', message: 'HTTP 401' })])
  const acked = ackAll(alertIdentities(before))
  assert.equal(alertCount(snapshot([provider({ status: 'error', message: 'HTTP 401' })], acked)), 0)
  assert.equal(alertCount(snapshot([provider({ status: 'error', message: 'HTTP 500' })], acked)), 1)
})

test('acking one platform does not silence another', () => {
  const kimi = provider({ id: 'kimi', label: 'Kimi Code', items: [{ label: '周额度', percent: 90, resetAt: 'w1' }] })
  const zhipu = provider({ id: 'zhipu', label: '智谱', status: 'error', message: 'HTTP 500' })
  const state = snapshot([kimi, zhipu])
  const acked = ackAll(alertIdentities(state))
  const only = { 'usage:kimi|周额度': acked['usage:kimi|周额度']! }
  assert.equal(alertCount({ ...state, ackedAlerts: only }), 1)
  assert.deepEqual(alertLines({ ...state, ackedAlerts: only }, t), ['智谱 查询失败'])
})

test('pruneAcks forgets alerts that disappeared, so they come back unread', () => {
  const withAlert = snapshot([provider({ items: [{ label: '周额度', percent: 90, resetAt: 'w1' }] })])
  const acked = ackAll(alertIdentities(withAlert))
  const pruned = pruneAcks(acked, alertIdentities(snapshot([provider({ items: [{ label: '周额度', percent: 40, resetAt: 'w1' }] })])))
  assert.deepEqual(pruned, {})
  // 之后再次越阈值：没有已读记录 → 未读。
  assert.equal(alertCount({ ...withAlert, ackedAlerts: pruned }), 1)
})

test('pruneAcks reports no change when every acked alert is still present', () => {
  const state = snapshot([provider({ items: [{ label: '周额度', percent: 90, resetAt: 'w1' }] })])
  const acked = ackAll(alertIdentities(state))
  assert.equal(pruneAcks(acked, alertIdentities(state)), undefined)
})

test('pruneAcks keeps the old signature, so a changed condition is still unread', () => {
  const before = snapshot([provider({ items: [{ label: '周额度', percent: 90, resetAt: 'w1' }] })])
  const acked = ackAll(alertIdentities(before))
  const after = snapshot([provider({ items: [{ label: '周额度', percent: 90, resetAt: 'w2' }] })])
  const pruned = pruneAcks(acked, alertIdentities(after)) ?? acked
  assert.equal(alertCount({ ...after, ackedAlerts: pruned }), 1)
})

test('the ack state round-trips through localStorage', () => {
  const state = { 'usage:kimi|周额度': 'usage:w1', 'failed:zhipu': 'failed:HTTP 401' }
  assert.deepEqual(deserializeAlertAckState(serializeAlertAckState(state)), state)
})

test('damaged or foreign ack payloads fall back to an empty state', () => {
  assert.equal(deserializeAlertAckState('not json'), undefined)
  assert.equal(deserializeAlertAckState('{"v":2,"acked":{}}'), undefined)
  assert.equal(deserializeAlertAckState('{"v":1,"acked":[]}'), undefined)
  assert.deepEqual(createAlertAckState(), {})
})

test('a clean panel has nothing to ack', () => {
  assert.deepEqual(ackAll(alertIdentities(snapshot([provider({ items: [{ label: '周额度', percent: 12 }] })]))), {})
})
