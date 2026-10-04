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
import { QuotaController, type LlmProviderInfo } from './controller.ts'
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

/** Structural face of the host `llm` service's provider directory. */
interface LlmDirectoryLike {
  listProviders?(): Array<{ id: string; name?: string }>
  listConfigurableProviders?(): Array<{
    provider: string
    displayName?: string
    settingsNs: string
    settingsPath?: readonly string[]
  }>
}

/** Walk a settings path (e.g. `['providers', 'kimi-coding']`) into a descriptor value. */
function atPath(value: unknown, path: readonly string[]): unknown {
  let node: unknown = value
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Volatile profile fields the panel needs: credential ref, endpoint, display label. */
function profileFacts(profile: unknown): { keyRef?: string; baseURL?: string; label?: string } {
  if (profile === null || typeof profile !== 'object') return {}
  const row = profile as Record<string, unknown>
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
  const keyRef = text(row.apiKeyEnv)
  const baseURL = text(row.baseURL)
  const label = text(row.displayName) ?? text(row.name)
  return {
    ...keyRef === undefined ? {} : { keyRef },
    ...baseURL === undefined ? {} : { baseURL },
    ...label === undefined ? {} : { label },
  }
}

/**
 * Model providers DSH actually serves, with their credential refs.
 *
 * `ctx.llm` is the authority: `listProviders()` is every route with a
 * registered adapter — pi-ai gateways and native families such as
 * `deepseek-official` alike — and `listConfigurableProviders()` says which
 * settings namespace + path holds each route's volatile profile, where
 * `apiKeyEnv` / `baseURL` live. Reading one hardcoded namespace (as before)
 * missed every native provider, so a DeepSeek session resolved no quota row.
 * Without the llm service (older dsh, headless composition) the previous
 * llm-pi-ai-only read stays as the fallback.
 * @param ctx - host plugin context.
 * @param settings - live settings forms (undefined before the service mounts).
 * @returns provider rows keyed by their model-provider id.
 */
export function llmProvidersOf(ctx: Context, settings: SettingsFormsLike | undefined): LlmProviderInfo[] {
  const values = new Map<string, unknown>((settings?.describe?.() ?? []).map((d) => [d.ns, d.value]))
  const llm = ctx.get('llm') as LlmDirectoryLike | undefined
  const configurable = llm?.listConfigurableProviders?.() ?? []
  const byProvider = new Map(configurable.map((entry) => [entry.provider, entry]))
  const out: LlmProviderInfo[] = []
  const seen = new Set<string>()
  const take = (id: string, profile: unknown, fallbackLabel?: string): void => {
    if (!id || seen.has(id)) return
    seen.add(id)
    const facts = profileFacts(profile)
    out.push({
      id,
      label: facts.label ?? fallbackLabel ?? id,
      ...facts.keyRef === undefined ? {} : { keyRef: facts.keyRef },
      ...facts.baseURL === undefined ? {} : { baseURL: facts.baseURL },
    })
  }

  for (const row of llm?.listProviders?.() ?? []) {
    const entry = byProvider.get(row.id)
    take(row.id, entry ? atPath(values.get(entry.settingsNs), entry.settingsPath ?? []) : undefined, entry?.displayName ?? row.name)
  }
  if (out.length > 0) return out

  // Fallback: no llm registry — the llm-pi-ai namespace is the only window
  // onto configured routes.
  const configured = (values.get('llm-pi-ai') as { providers?: Record<string, unknown> } | undefined)?.providers
  for (const [id, profile] of Object.entries(configured ?? {})) take(id, profile)
  return out
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
    () => llmProvidersOf(ctx, settingsForms),
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
