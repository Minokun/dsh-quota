/**
 * dsh-quota plugin, Host half: direct API-key adapters (Kimi / DeepSeek /
 * Zhipu) plus MCP fallback adapters (BigModel / Qianwen / Scnet / TokenRouter /
 * SupaWriter), the agent tool, settings-namespace persistence, and the
 * panel-facing HTTP routes. Function-plugin form (named exports only).
 *
 * Keys sync from DSH automatically: the direct adapters resolve the same
 * credential refs DSH's model providers declare, and every committed change
 * in the credentials domain (`credentials/updated`) triggers a refresh.
 * @module dsh-quota
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import { Config, QUOTA_NS } from './config.ts'
import { QuotaController } from './controller.ts'
import { DIRECT_ADAPTERS } from './direct.ts'
import { registerTools } from './tools.ts'
import { registerHttpRoutes } from './http.ts'

export { Config }

export const name = 'quota'
export const inject = ['tools']

/** Delay before the first automatic refresh (lets MCP servers connect). */
const BOOT_REFRESH_DELAY_MS = 5000

/** Debounce for credential-change refreshes (a batch of sets = one refresh). */
const CREDENTIAL_REFRESH_DEBOUNCE_MS = 800

/** Every credential ref the direct adapters consume. */
const KNOWN_REFS = new Set(DIRECT_ADAPTERS.flatMap((a) => [...a.keyRefs, ...a.envKeys]))

/**
 * Mount the plugin: register the refresh tool, persist the snapshot into the
 * `quota` settings namespace, reconcile API keys via the credentials domain,
 * and serve the panel API when a web server exists (headless compositions
 * keep the tool only).
 */
export function apply(ctx: Context, config: Config): void {
  let scope: SettingsScope<Config> | undefined
  const quota = new QuotaController(ctx, () => scope, () => ctx.get('credentials'))
  registerTools(ctx, quota)

  ctx.inject(['settings'], (sctx) => {
    scope = sctx.settings.register(QUOTA_NS as SettingsNamespace, Config, { base: config })
  })

  // Boot refresh after MCP servers have had a chance to connect and sync
  // their tools; harmless when credentials are still missing (platforms show
  // as missing-key / missing-mcp).
  if (config.refreshOnBoot) {
    ctx.inject(['settings'], () => {
      const timer = setTimeout(() => {
        void quota.refresh()
      }, BOOT_REFRESH_DELAY_MS)
      return () => clearTimeout(timer)
    })
  }

  // Optional periodic refresh.
  if (config.refreshIntervalMinutes > 0) {
    ctx.inject(['settings'], () => {
      const timer = setInterval(() => {
        void quota.refresh()
      }, config.refreshIntervalMinutes * 60 * 1000)
      return () => clearInterval(timer)
    })
  }

  // Auto-sync: a key added/changed in DSH (any known ref) refreshes the panel.
  let pending: ReturnType<typeof setTimeout> | undefined
  ctx.on('credentials/updated', (ref) => {
    if (!KNOWN_REFS.has(ref as string)) return
    if (pending !== undefined) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      void quota.refresh()
    }, CREDENTIAL_REFRESH_DEBOUNCE_MS)
  })
  ctx.effect(() => () => {
    if (pending !== undefined) clearTimeout(pending)
  })

  ctx.inject(['webServer'], (sctx) => {
    registerHttpRoutes(sctx, quota)
  })
}
