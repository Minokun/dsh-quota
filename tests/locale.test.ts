import assert from 'node:assert/strict'
import test from 'node:test'
import { browserLang, translate, type LocaleKey } from '../src/client/locale.ts'

/** Every key the panel uses, so a missing translation fails loudly. */
const KEYS: LocaleKey[] = [
  'pill.defaultName', 'pill.title.default', 'pill.title.summary',
  'model.from.session', 'model.from.default',
  'ring.title.focus', 'ring.hint.pause',
  'panel.title', 'panel.normalCount', 'panel.alerts', 'panel.refresh', 'panel.refreshing', 'panel.empty',
  'alert.usage', 'alert.failed', 'alert.login', 'alert.list',
  'panel.footer.refreshedAt', 'panel.footer.never', 'mode.toRing', 'mode.toPill',
  'status.ok', 'status.error', 'status.missing-key', 'status.missing-mcp',
  'source.env', 'source.project-env', 'source.user-env', 'source.dsh',
  'provider.synced', 'provider.syncedTitle',
  'probe.run', 'probe.title', 'probe.running', 'probe.ok', 'probe.fail',
  'toast.loginExpired', 'toast.retry', 'toast.login', 'toast.dismiss',
  'login.done', 'login.go',
  'item.remaining', 'eta.title', 'eta.minutes', 'eta.hours', 'eta.days',
  'eta.span.minutes', 'eta.span.hours', 'eta.span.days',
  'usageAlert.threshold', 'usageAlert.eta', 'usageAlert.view',
  'reset.today', 'reset.day',
  'summary.remainingPercent', 'summary.remainingCount', 'tag.weekly', 'tag.monthly',
  'keys.title', 'keys.hint', 'keys.note', 'keys.configuredTitle', 'keys.unconfiguredTitle',
  'keys.overridePlaceholder', 'keys.save', 'keys.delete', 'keys.deleteTitle',
  'custom.title', 'custom.hint', 'custom.note', 'custom.namePlaceholder', 'custom.endpointPlaceholder',
  'custom.keyRefPlaceholder', 'custom.userIdPlaceholder', 'custom.quotaPerUnitPlaceholder',
  'custom.add', 'custom.remove',
  'error.readStatus', 'error.customRequired', 'error.newapiUserId', 'error.newapiQuotaPerUnit',
  'error.keyEmpty', 'error.requestFailed',
]

test('every panel key resolves in both locales and stays Chinese-free in en', () => {
  for (const key of KEYS) {
    const zh = translate('zh', key)
    const en = translate('en', key)
    assert.ok(zh.length > 0, `zh missing ${key}`)
    assert.ok(en.length > 0, `en missing ${key}`)
    assert.notEqual(zh, key, `zh dictionary lacks ${key}`)
    assert.notEqual(en, key, `en dictionary lacks ${key}`)
  }
})

test('en copy does not leak CJK ideographs (brand-free chrome)', () => {
  const offenders = KEYS.filter((key) => /[\u4e00-\u9fff]/.test(translate('en', key)))
  assert.deepEqual(offenders, [])
})

test('translate interpolates {param} placeholders per locale', () => {
  assert.equal(translate('zh', 'panel.normalCount', { ok: 3, total: 5 }), '3/5 平台正常')
  assert.equal(translate('en', 'panel.normalCount', { ok: 3, total: 5 }), '3/5 platforms OK')
  assert.equal(translate('zh', 'alert.usage', { label: 'Kimi', item: '周额度', percent: 89 }), 'Kimi 周额度 已用 89%')
  assert.equal(translate('en', 'panel.alerts', { n: 2 }), '⚠ 2 alerts')
  assert.equal(translate('en', 'eta.hours', { n: '2.3' }), 'depletes in ~2.3 h')
  assert.equal(translate('zh', 'item.remaining', { n: 120 }), '剩120')
})

test('browserLang falls back to en without a shipped Chinese request', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
    assert.equal(browserLang(), 'zh')
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'de-DE' }, configurable: true })
    assert.equal(browserLang(), 'en')
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
