/**
 * Red-badge alert accounting, shared by the floater badge, the panel verdict
 * and every platform card.
 *
 * One definition, three surfaces: the badge total, the header breakdown and a
 * card's own marker must agree, so the count is derived from the same three
 * conditions everywhere — an item at or above the usage threshold, a platform
 * whose query failed, and a platform whose sign-in expired.
 * @module dsh-quota/client/alerts
 */

import type { PanelProvider, QuotaPanelState } from './controller.ts'
import type { TFn } from './locale.ts'

/** The slice of the panel snapshot alert accounting reads. */
export type AlertSnapshot = Pick<QuotaPanelState, 'providers' | 'loginAlerts' | 'alertPercent'>

/** Whether one platform has an outstanding sign-in alert. */
function hasLoginAlert(id: string, snapshot: AlertSnapshot): boolean {
  return snapshot.loginAlerts.some((alert) => alert.id === id)
}

/** Items of one platform at or above the configured alert threshold. */
function overThresholdItems(p: PanelProvider, snapshot: AlertSnapshot) {
  if (p.status !== 'ok') return []
  return p.items.filter((item) => item.percent !== undefined && item.percent >= snapshot.alertPercent)
}

/**
 * Alerts attributable to one platform card, as one display line each.
 * @param p - the platform card row.
 * @param snapshot - panel snapshot (threshold, sign-in alerts).
 * @param t - translator for the active language.
 * @returns one line per counted alert, empty when the card is clean.
 */
export function providerAlertLines(p: PanelProvider, snapshot: AlertSnapshot, t: TFn): string[] {
  const lines: string[] = []
  if (p.status === 'error') lines.push(t('alert.failed', { label: p.label }))
  for (const item of overThresholdItems(p, snapshot)) {
    lines.push(t('alert.usage', { label: p.label, item: item.label, percent: Math.round(item.percent ?? 0) }))
  }
  if (hasLoginAlert(p.id, snapshot)) lines.push(t('alert.login', { label: p.label }))
  return lines
}

/** Alerts attributable to one platform card, counted (see {@link providerAlertLines}). */
export function providerAlertCount(p: PanelProvider, snapshot: AlertSnapshot): number {
  return (p.status === 'error' ? 1 : 0)
    + overThresholdItems(p, snapshot).length
    + (hasLoginAlert(p.id, snapshot) ? 1 : 0)
}

/** Every counted alert line, in card order (the pill tooltip and header list). */
export function alertLines(snapshot: AlertSnapshot, t: TFn): string[] {
  return snapshot.providers.flatMap((p) => providerAlertLines(p, snapshot, t))
}

/** The badge total: query failures + usage at/over threshold + sign-in alerts. */
export function alertCount(snapshot: AlertSnapshot): number {
  return snapshot.providers.reduce((n, p) => n + providerAlertCount(p, snapshot), 0)
}
