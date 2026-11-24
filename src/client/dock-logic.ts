/**
 * Pure presentation & anti-lockout visibility logic for `QuotaDockBar`
 * (`conversation.composer.dock`) and the floating pill/ring (`shell.overlay`).
 *
 * Zero React / DOM / store dependencies so all state transitions and fallback
 * invariants are directly unit-testable under `node --test`.
 * @module dsh-quota/client/dock-logic
 */

import type { PanelItem, PanelProvider } from './controller.ts'
import { formatProviderSummary, selectHeadlineWindow } from '../window-rank.ts'
import { translate, type Lang } from './locale.ts'

export type EntryDisplayMode = 'both' | 'dock-only' | 'floater-only'

export function parseDisplayMode(raw: string | null | undefined): EntryDisplayMode {
  if (raw === 'dock-only' || raw === 'floater-only' || raw === 'both') return raw
  return 'both'
}

export function nextDisplayMode(current: EntryDisplayMode): EntryDisplayMode {
  if (current === 'both') return 'dock-only'
  if (current === 'dock-only') return 'floater-only'
  return 'both'
}

/**
 * Compute whether the composer dock bar and the overlay floater should render.
 *
 * Anti-lockout rule: if the user selected `dock-only` but no `conversation.composer.dock`
 * instance is currently mounted (e.g. viewing Settings/Plugins, blank page without a
 * session, or an older DSH build without the slot), `showFloater` automatically
 * falls back to `true` so the user is never locked out of opening `QuotaPanel`.
 */
export function resolveEntryVisibility(
  mode: EntryDisplayMode,
  dockMountCount: number,
): { showDock: boolean; showFloater: boolean } {
  if (mode === 'floater-only') {
    return { showDock: false, showFloater: true }
  }
  if (mode === 'dock-only') {
    return { showDock: true, showFloater: dockMountCount <= 0 }
  }
  return { showDock: true, showFloater: true }
}

export interface DockSummaryInput {
  provider: PanelProvider | undefined
  fallbackModelName: string
  shortCostText: string
  rollupLine: string
  speedHeadline?: number
  alertPercent: number
  totalAlerts: number
  lang: Lang
}

export interface DockSummaryView {
  dotTone: 'ok' | 'warn' | 'err' | 'idle'
  primaryText: string
  costText: string
  paceWarn: boolean
  badgeCount: number
  tooltip: string
}

/** Build the compact 1-line readout and hover tooltip for `QuotaDockBar`. */
export function buildDockSummary(input: DockSummaryInput): DockSummaryView {
  const { provider, fallbackModelName, shortCostText, rollupLine, speedHeadline, alertPercent, totalAlerts, lang } = input
  const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate(lang, k, p)

  let dotTone: DockSummaryView['dotTone'] = 'idle'
  let primaryText = ''
  let paceWarn = false
  const tooltipLines: string[] = []

  if (provider) {
    if (provider.status !== 'ok') {
      dotTone = 'err'
      primaryText = `${provider.label} · ${t(`status.${provider.status}` as Parameters<typeof translate>[1])}`
      if (provider.message) tooltipLines.push(`${provider.label}: ${provider.message}`)
    } else {
      const tightest: PanelItem | undefined = selectHeadlineWindow(provider.items)
      const pct = tightest?.percent
      paceWarn = tightest?.depletesBeforeReset === true
      if (pct !== undefined && pct >= alertPercent) dotTone = 'err'
      else if ((pct !== undefined && pct >= 60) || paceWarn) dotTone = 'warn'
      else dotTone = 'ok'

      const summary = formatProviderSummary(provider, {
        weeklyTag: translate(lang, 'tag.weekly'),
        monthlyTag: translate(lang, 'tag.monthly'),
        remainingPercent: (p) => translate(lang, 'summary.remainingPercent', { p }),
        remainingCount: (n) => translate(lang, 'summary.remainingCount', { n }),
      })
      primaryText = summary ? `${provider.label} ${summary}` : provider.label

      const detailItems = provider.items.map((item) => {
        const parts = [item.label]
        if (item.percent !== undefined) parts.push(`${String(Math.round(item.percent))}%`)
        else if (item.display) parts.push(item.display)
        if (item.depletesBeforeReset === true) parts.push('⚠')
        return parts.join(' ')
      })
      if (detailItems.length > 0) tooltipLines.push(`${provider.label}: ${detailItems.join(' · ')}`)
    }
  } else if (fallbackModelName) {
    dotTone = totalAlerts > 0 ? 'warn' : 'idle'
    primaryText = fallbackModelName
  } else {
    dotTone = totalAlerts > 0 ? 'warn' : 'idle'
    primaryText = t('pill.defaultName')
  }

  if (rollupLine) tooltipLines.push(rollupLine)
  if (speedHeadline !== undefined && Number.isFinite(speedHeadline)) {
    const sp = speedHeadline >= 100 ? String(Math.round(speedHeadline)) : speedHeadline.toFixed(1)
    tooltipLines.push(`${t('speed.label')}: ${sp} ${t('speed.unit')}`)
  }
  tooltipLines.push(t('dock.tooltipHint'))

  return {
    dotTone,
    primaryText,
    costText: shortCostText,
    paceWarn,
    badgeCount: totalAlerts,
    tooltip: tooltipLines.join('\n'),
  }
}
