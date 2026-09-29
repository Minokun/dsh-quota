/**
 * dsh-quota plugin, Host half: direct API-key adapters (Kimi / DeepSeek /
 * Zhipu) plus MCP fallback adapters (BigModel / Qianwen / Scnet / TokenRouter /
 * SupaWriter), the agent tool, settings-namespace persistence, and the
 * panel-facing HTTP routes. Function-plugin form (named exports only).
 *
 * Keys sync from DSH automatically: the direct adapters resolve the same
 * credential refs DSH's model providers declare, and every committed change
 * in the credentials domain (`credentials/updated` on dsh ≤0.1.4;
 * `credentials/reference-updated` / `credentials/record-updated` on 0.1.5+)
 * triggers a refresh.
 * @module dsh-quota
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import { Config, QUOTA_NS } from './config.ts'
import { QuotaController } from './controller.ts'
import { ALL_DIRECT_REFS } from './direct.ts'
import { configuredMcpServers } from './dsh-config.ts'
import { createStateStore, type SettingsFormsLike } from './state-store.ts'
import { registerTools } from './tools.ts'
import { registerHttpRoutes } from './http.ts'

export { Config }

export const name = 'quota'
export const inject = ['tools']

/** Delay before the first automatic refresh (lets MCP servers connect). */
const BOOT_REFRESH_DELAY_MS = 5000

/** Debounce for credential-change refreshes (a batch of sets = one refresh). */
const CREDENTIAL_REFRESH_DEBOUNCE_MS = 800

/** Every credential ref the built-in direct catalog may consume. */
const KNOWN_REFS = new Set(ALL_DIRECT_REFS)

/** Structural face of the legacy (dsh ≤ 0.1.5) settings service. */
interface LegacySettingsLike {
  register?: (ns: SettingsNamespace, schema: unknown, options: { base: Config }) => SettingsScope<Config>
}

/**
 * Mount the plugin: register the refresh tool, keep the panel snapshot in the
 * state store (composition config base + runtime overlay; legacy settings
 * namespace on old dsh), reconcile API keys via the credentials domain, and
 * serve the panel API when a web server exists (headless compositions keep
 * the tool only).
 */
export function apply(ctx: Context, config: Config): void {
  let legacyScope: SettingsScope<Config> | undefined
  let settingsForms: SettingsFormsLike | undefined
  let settingsSvc: (SettingsFormsLike & LegacySettingsLike) | undefined
  const entryId = (ctx as unknown as { fiber?: { entry?: { options?: { id?: unknown } } } }).fiber?.entry?.options?.id

  const store = createStateStore({
    config,
    entryNs: typeof entryId === 'string' && entryId ? entryId : QUOTA_NS,
    getSettingsForms: () => settingsForms,
    getLegacyScope: () => legacyScope,
    onWarn: (message) => { ctx.logger.warn(`quota: ${message}`) },
  })

  const quota = new QuotaController(
    ctx,
    store,
    () => ctx.get('credentials'),
    () => config.mcpPlatforms ?? [],
    () => {
      // agent-default-model namespace: { provider, model } — read live per refresh.
      const d = settingsSvc?.describe?.().find((x) => x.ns === 'agent-default-model')
      const v = d?.value as { provider?: unknown; model?: unknown } | undefined
      return typeof v?.provider === 'string' && typeof v?.model === 'string'
        ? { provider: v.provider, model: v.model }
        : undefined
    },
    () => {
      // llm-pi-ai namespace: providers.<id> → { apiKeyEnv, baseURL, displayName }
      // — the model→platform correspondence keys on the exact credential ref,
      // and unmatched providers get a liveness probe row.
      const d = settingsSvc?.describe?.().find((x) => x.ns === 'llm-pi-ai')
      const providers = (d?.value as { providers?: Record<string, { apiKeyEnv?: unknown; baseURL?: unknown; displayName?: unknown }> } | undefined)?.providers
      if (!providers || typeof providers !== 'object') return []
      const out: Array<{ id: string; label: string; keyRef?: string; baseURL?: string }> = []
      for (const [id, p] of Object.entries(providers)) {
        out.push({
          id,
          label: typeof p?.displayName === 'string' && p.displayName ? p.displayName : id,
          ...(typeof p?.apiKeyEnv === 'string' && p.apiKeyEnv ? { keyRef: p.apiKeyEnv } : {}),
          ...(typeof p?.baseURL === 'string' && p.baseURL ? { baseURL: p.baseURL } : {}),
        })
      }
      return out
    },
    // DSH 系统配置（profile composition 的 loader 条目）是"哪些 MCP 平台存在"
    // 的唯一依据：只有 composition 里声明了 dsh-mcp-client 的 serverName，
    // 对应平台才会被查询；loader 服务不可用时返回 undefined，退回工具注册表探测。
    () => configuredMcpServers(ctx),
  )
  registerTools(ctx, quota)

  ctx.inject(['settings'], (sctx) => {
    const svc = sctx.settings as unknown as SettingsFormsLike & LegacySettingsLike
    settingsSvc = svc
    if (typeof svc?.update === 'function') settingsForms = svc
    // 旧版 dsh（≤0.1.5）：settings.register 存在时注册命名空间 scope；新版
    // 该 API 已移除，静默落到「组合配置 + 内存覆盖层」。
    try {
      if (typeof svc?.register === 'function') legacyScope = svc.register(QUOTA_NS as SettingsNamespace, Config, { base: config })
    } catch (error) {
      ctx.logger.warn(`quota: legacy settings namespace unavailable, runtime state stays in memory: ${error instanceof Error ? error.message : String(error)}`)
    }
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

  // Auto-sync: a key added/changed in DSH (any known ref, including custom
  // platforms' keyRefs) refreshes the panel. dsh ≤0.1.4 emitted one
  // `credentials/updated` event; 0.1.5 splits it into
  // `credentials/reference-updated` (per ref) and `credentials/record-updated`
  // (per record key) — subscribe to all of them; names the running dsh does
  // not emit simply never fire.
  let pending: ReturnType<typeof setTimeout> | undefined
  const onCredentialTouched = (ref: unknown): void => {
    const custom = quota.state().httpPlatforms.some((p) => p.keyRef === (ref as string))
    if (!KNOWN_REFS.has(ref as string) && !custom) return
    if (pending !== undefined) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      void quota.refresh()
    }, CREDENTIAL_REFRESH_DEBOUNCE_MS)
  }
  const CREDENTIAL_EVENTS: readonly string[] = [
    'credentials/updated',
    'credentials/reference-updated',
    'credentials/record-updated',
  ]
  for (const event of CREDENTIAL_EVENTS) ctx.on(event as 'credentials/updated', onCredentialTouched)
  ctx.effect(() => () => {
    if (pending !== undefined) clearTimeout(pending)
  })

  ctx.inject(['webServer'], (sctx) => {
    registerHttpRoutes(sctx, quota)
  })
}
