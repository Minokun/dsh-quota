import assert from 'node:assert/strict'
import test from 'node:test'
import { billingLine, type BillingProvider } from '../src/client/billing-line.ts'
import { translate, type Lang, type LocaleKey } from '../src/client/locale.ts'

const DAY = 24 * 60 * 60 * 1000
const WEEK = 7 * DAY

const t = (lang: Lang) => (key: LocaleKey, params?: Record<string, string | number>) => translate(lang, key, params)

function provider(items: BillingProvider['items'], status = 'ok'): BillingProvider {
  return { status, items }
}

test('billingLine: weekly window shows week usage plus depletion ETA', () => {
  const line = billingLine(provider([
    { label: '5 小时窗口', percent: 30 },
    { label: '本周窗口', percent: 62, etaMinutes: 1500 },
  ]), t('zh'))
  assert.equal(line, '本周已用 62% · 按当前速率预计 约 1.0 天 后耗尽')
})

test('billingLine: falls back to monthly, then short window', () => {
  assert.equal(billingLine(provider([{ label: '本月额度', percent: 41 }]), t('zh')), '本月已用 41%')
  assert.equal(billingLine(provider([{ label: '300m 窗口', percent: 55, etaMinutes: 45 }]), t('zh')), '本窗口已用 55% · 按当前速率预计 约 45 分钟 后耗尽')
})

test('billingLine: balance platform shows 7-day spend and balance ETA', () => {
  const line = billingLine(provider([
    { label: '余额', display: '¥96.00', weeklySpent: 20.16, etaMinutes: 4800, spendWindowMs: WEEK },
  ]), t('zh'))
  assert.equal(line, '近 7 天消耗 ≈ ¥20.16 · 余额预计 约 3.3 天 后耗尽')
})

test('billingLine: a sub-week window reports observed spend plus the daily rate, never a fake 7-day total', () => {
  const line = billingLine(provider([
    { label: '余额', display: '¥96.00', weeklySpent: 20.16, spendWindowMs: 3 * DAY },
  ]), t('zh'))
  // 3 天实测 8.64（日均 2.88）——不是把日均放大成「近 7 天 20.16」。
  assert.equal(line, '近 3 天实测 ≈ ¥8.64（日均 ≈ ¥2.88）')
})

test('billingLine: only a full-week sample window may claim a 7-day total', () => {
  const line = billingLine(provider([
    { label: '余额', display: '¥96.00', weeklySpent: 20.16, spendWindowMs: 7 * DAY },
  ]), t('zh'))
  assert.equal(line, '近 7 天消耗 ≈ ¥20.16')
})

test('billingLine: balance without a rate yet renders nothing (no fake numbers)', () => {
  assert.equal(billingLine(provider([{ label: '余额', display: '¥96.00' }]), t('zh')), '')
})

test('billingLine: failed/missing provider renders nothing', () => {
  assert.equal(billingLine(undefined, t('zh')), '')
  assert.equal(billingLine(provider([{ label: '周额度', percent: 10 }], 'error'), t('zh')), '')
})

test('billingLine: english copy', () => {
  const line = billingLine(provider([
    { label: '余额', display: '$12.00', weeklySpent: 8.4, etaMinutes: 600, spendWindowMs: WEEK },
  ]), t('en'))
  assert.equal(line, '≈ $8.4 over the last 7 days · balance depletes in ~10.0 h')
})
