import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDockSummary,
  nextDisplayMode,
  parseDisplayMode,
  resolveEntryVisibility,
} from '../src/client/dock-logic.ts'

test('displayMode defaults to "both" and cycles both -> dock-only -> floater-only -> both', () => {
  assert.equal(parseDisplayMode(null), 'both')
  assert.equal(parseDisplayMode(undefined), 'both')
  assert.equal(parseDisplayMode('garbage'), 'both')
  assert.equal(nextDisplayMode('both'), 'dock-only')
  assert.equal(nextDisplayMode('dock-only'), 'floater-only')
  assert.equal(nextDisplayMode('floater-only'), 'both')
})

test('anti-lockout fallback: dock-only hides floater on chat page, but auto-restores floater when dockMountCount == 0', () => {
  // Default "both": always shows both
  assert.deepEqual(resolveEntryVisibility('both', 1), { showDock: true, showFloater: true })
  assert.deepEqual(resolveEntryVisibility('both', 0), { showDock: true, showFloater: true })

  // "dock-only" with mounted dock -> hides floater
  assert.deepEqual(resolveEntryVisibility('dock-only', 1), { showDock: true, showFloater: false })

  // "dock-only" on Settings page / missing slot (dockMountCount == 0) -> auto-shows floater so panel is never unreachable!
  assert.deepEqual(resolveEntryVisibility('dock-only', 0), { showDock: true, showFloater: true })

  // "floater-only": hides dock, shows floater
  assert.deepEqual(resolveEntryVisibility('floater-only', 1), { showDock: false, showFloater: true })
})

test('buildDockSummary surfaces tightest window, adaptive cost, pace warning, and full tooltip breakdown', () => {
  const view = buildDockSummary({
    provider: {
      id: 'zhipu',
      label: '智谱',
      status: 'ok',
      items: [
        { label: '5 小时窗口', percent: 12 },
        { label: '周额度', percent: 88, depletesBeforeReset: true },
      ],
    },
    fallbackModelName: 'glm-4.7',
    shortCostText: '¥0.4200',
    rollupLine: '本会话 ¥0.4200 · 今日此目录 ¥1.85 · 今日总计 ¥2.40',
    speedHeadline: 68.4,
    alertPercent: 85,
    totalAlerts: 1,
    lang: 'zh',
  })
  assert.equal(view.dotTone, 'err')
  assert.equal(view.paceWarn, true)
  assert.match(view.primaryText, /智谱 周 剩12%/)
  assert.equal(view.costText, '¥0.4200')
  assert.equal(view.badgeCount, 1)
  assert.match(view.tooltip, /周额度 88% ⚠/)
  assert.match(view.tooltip, /今日总计 ¥2\.40/)
  assert.match(view.tooltip, /68\.4 tok\/s/)
})

test('buildDockSummary degrades cleanly when active model has no matching configured quota card', () => {
  const view = buildDockSummary({
    provider: undefined,
    fallbackModelName: 'deepseek-flash',
    shortCostText: '¥0.0120',
    rollupLine: '',
    alertPercent: 85,
    totalAlerts: 0,
    lang: 'en',
  })
  assert.equal(view.dotTone, 'idle')
  assert.equal(view.primaryText, 'deepseek-flash')
  assert.equal(view.costText, '¥0.0120')
})
