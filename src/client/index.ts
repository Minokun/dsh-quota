/**
 * dsh-quota plugin, browser half: one entry in the frame-wide `shell.overlay`
 * slot — the bottom-right membership-quota pill and its panel. Talks to the
 * Host half through the plugin's same-origin HTTP routes.
 * @module dsh-quota/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the `shell.overlay` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { QuotaPanel } from './QuotaPanel.tsx'
import { QuotaPanelController, type ModelDirectoriesLike } from './controller.ts'
import { PANEL_CSS, STYLE_TAG_ID } from './styles.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots']

/**
 * Mount the quota pill + panel into the frame-wide overlay layer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), 'dsh-quota: panel styles')

  const controller = new QuotaPanelController()
  // Per-session model selection lives in ctx.modelDirectories (the
  // model-selection plugin); optional — the pill falls back to the host's
  // default-model summary when it is absent.
  const dirs = (ctx as unknown as { get(name: string): unknown }).get('modelDirectories') as ModelDirectoriesLike | undefined
  controller.bindModelDirectories(dirs)

  // The host refreshes quotas on its own cadence (default 5min); the client
  // re-reads the snapshot every minute so the pill/panel pick it up. Cheap
  // same-origin GET, skipped while the page is hidden.
  ctx.effect(() => {
    const t = setInterval(() => { controller.pollIfVisible() }, 60 * 1000)
    return () => clearInterval(t)
  }, 'dsh-quota: status poll')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-quota',
    inject: () => controller.inject(),
  }, QuotaPanel))
}

/** Inject the panel stylesheet; the returned cleanup removes it on unload. */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null) return () => undefined
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-quota'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}
