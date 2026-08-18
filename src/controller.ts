/**
 * QuotaController: refresh all platform snapshots (direct API-key adapters +
 * MCP fallback adapters) and persist the result into the `quota` settings
 * namespace for the browser panel. API keys are read from the DSH credentials
 * domain (falling back to process environment), so the panel never handles
 * secrets.
 * @module dsh-quota/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Config, CustomHttpPlatform, CustomMcpPlatform, ProviderSnapshot } from './config.ts'
import { KEY_REFS } from './config.ts'
import { CATALOG_EXTRA, CUSTOM_FORMATS, DIRECT_ADAPTERS, FORMATS, customHttpFetch, type DirectAdapter } from './direct.ts'
import { MCP_ADAPTERS, customAdapter, runMcpAdapter, type McpAdapter } from './mcp.ts'

/** How long one provider may take before it is marked failed. */
const PROVIDER_TIMEOUT_MS = 20000

/** One resolved API key and where it came from. */
export interface ResolvedKey {
  value: string
  /** The credential ref / env var name that supplied the value. */
  ref: string
  /** Source layer (file / env / project-env / user-env). */
  source: string
}

/**
 * Read a platform's API key: every credential ref in order (these mirror the
 * `apiKeyEnv` names DSH's model providers use, so keys already added to DSH
 * are picked up automatically), then the process environment.
 */
async function resolveKey(credentials: CredentialProvider | undefined, refs: string[], envKeys: string[]): Promise<ResolvedKey | undefined> {
  if (credentials) {
    for (const ref of refs) {
      if (!ref) continue
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved?.value) return { value: resolved.value, ref, source: resolved.source }
    }
  }
  for (const envKey of envKeys) {
    const v = process.env[envKey]?.trim()
    if (v) return { value: v, ref: envKey, source: 'env' }
  }
  return undefined
}

/** The face the HTTP layer and the agent tool share. */
export interface QuotaControllerFace {
  /** Current panel state from the settings namespace. */
  state(): Config
  /** Refresh every platform snapshot; returns the new state. */
  refresh(): Promise<Config>
  /** Store one platform API key into the credentials domain. */
  saveKey(platform: string, key: string): Promise<void>
  /** Remove one platform API key from the credentials domain. */
  removeKey(platform: string): Promise<void>
  /** Describe configured keys (never the values): which ref supplies each platform. */
  keyStatus(): Promise<Record<string, { configured: boolean; source?: string; ref?: string; manual?: boolean }>>
  /** Add one user-declared HTTP platform (persisted in the namespace). */
  addHttpPlatform(platform: CustomHttpPlatform): Promise<void>
  /** Remove one user-declared HTTP platform by id. */
  removeHttpPlatform(id: string): Promise<void>
}

export class QuotaController implements QuotaControllerFace {
  private readonly ctx: Context
  private readonly getScope: () => SettingsScope<Config> | undefined
  private readonly getCredentials: () => CredentialProvider | undefined
  private readonly getCustomPlatforms: () => CustomMcpPlatform[]

  constructor(ctx: Context, getScope: () => SettingsScope<Config> | undefined, getCredentials: () => CredentialProvider | undefined, getCustomPlatforms: () => CustomMcpPlatform[] = () => []) {
    this.ctx = ctx
    this.getScope = getScope
    this.getCredentials = getCredentials
    this.getCustomPlatforms = getCustomPlatforms
  }

  /** Built-in MCP adapters plus user-declared ones (id collisions ignored). */
  private mcpAdapters(): McpAdapter[] {
    const builtinIds = new Set(MCP_ADAPTERS.map((a) => a.id))
    const custom = this.getCustomPlatforms()
      .filter((p) => p.id && p.label && p.tools.length > 0 && !builtinIds.has(p.id))
      .map(customAdapter)
    return [...MCP_ADAPTERS, ...custom]
  }

  /** Current panel state (composition defaults before first refresh). */
  state(): Config {
    return this.getScope()?.get() ?? { refreshedAt: '', refreshing: false, refreshOnBoot: true, refreshIntervalMinutes: 0, mcpPlatforms: [], httpPlatforms: [], providers: [] }
  }

  /** Patch the settings namespace (no-op without a settings service). */
  private async patch(patch: Partial<Config>): Promise<void> {
    const scope = this.getScope()
    if (scope === undefined) return
    await scope.update(patch)
  }

  /** Refresh every platform; failures are contained per platform. */
  async refresh(): Promise<Config> {
    await this.patch({ refreshing: true })
    const startedAt = new Date().toISOString()
    try {
      const credentials = this.getCredentials()
      const tools = this.ctx.get('tools')

      const runDirect = async (adapter: DirectAdapter, pinned: boolean): Promise<ProviderSnapshot | null> => {
        const key = await resolveKey(credentials, adapter.keyRefs, adapter.envKeys)
        if (!key) {
          if (!pinned) return null // auto-discovered rows stay hidden without a key
          return {
            id: adapter.id,
            label: adapter.label,
            status: 'missing-key',
            message: '未找到 API key（DSH 凭证与环境变量均无）',
            via: 'api',
            items: [],
          }
        }
        try {
          const snapshot = await adapter.fetch(key.value, AbortSignal.timeout(PROVIDER_TIMEOUT_MS))
          return { ...snapshot, keyRef: key.ref, keySource: key.source }
        } catch (error) {
          return {
            id: adapter.id,
            label: adapter.label,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
            via: 'api',
            keyRef: key.ref,
            keySource: key.source,
            items: [],
          }
        }
      }

      // User-declared HTTP platforms from the namespace (panel-added) merged
      // over the composition config; built-in catalog ids win over customs.
      const builtinIds = new Set([...DIRECT_ADAPTERS, ...CATALOG_EXTRA].map((a) => a.id))
      const customHttp = this.state().httpPlatforms
        .filter((p) => !builtinIds.has(p.id))
        .map((p): DirectAdapter => ({
          id: p.id,
          label: p.label,
          keyRefs: [p.keyRef],
          envKeys: [p.keyRef],
          fetch: customHttpFetch(p),
        }))

      const directJobs = [
        ...DIRECT_ADAPTERS.map((a) => runDirect(a, true)),
        ...CATALOG_EXTRA.map((a) => runDirect(a, false)),
        ...customHttp.map((a) => runDirect(a, true)),
      ]

      const mcpJobs = tools
        ? this.mcpAdapters().map(async (adapter) => {
            try {
              return await runMcpAdapter(tools as ToolRuntime, adapter)
            } catch (error) {
              return {
                id: adapter.id,
                label: adapter.label,
                status: 'error' as const,
                message: error instanceof Error ? error.message : String(error),
                via: 'mcp' as const,
                items: [],
              }
            }
          })
        : this.mcpAdapters().map((adapter): ProviderSnapshot => ({
            id: adapter.id,
            label: adapter.label,
            status: 'missing-mcp',
            message: '工具运行时不可用',
            via: 'mcp',
            items: [],
          }))

      const settled = await Promise.allSettled([...directJobs, ...mcpJobs])
      // Optional rows stay hidden: unregistered MCP servers and undiscovered
      // catalog platforms (null) never reach the panel.
      const providers = settled
        .map((s) => (s.status === 'fulfilled' ? s.value : {
          id: 'unknown',
          label: '未知平台',
          status: 'error' as const,
          message: s.reason instanceof Error ? s.reason.message : String(s.reason),
          items: [],
        }))
        .filter((p): p is ProviderSnapshot => p !== null && p.status !== 'missing-mcp')

      const state: Config = { ...this.state(), refreshedAt: startedAt, refreshing: false, providers }
      await this.patch({ refreshedAt: startedAt, refreshing: false, providers })
      return state
    } catch (error) {
      const state: Config = { ...this.state(), refreshedAt: startedAt, refreshing: false }
      await this.patch({ refreshing: false })
      return state
    }
  }

  /** Store one platform key into the credentials domain. */
  async saveKey(platform: string, key: string): Promise<void> {
    const ref = KEY_REFS[platform as keyof typeof KEY_REFS]
    if (!ref) throw new Error(`未知平台：${platform}`)
    const trimmed = key.trim()
    if (!trimmed) throw new Error('key 不能为空')
    const credentials = this.getCredentials()
    if (!credentials) throw new Error('凭证服务不可用')
    await credentials.set(credentialRef(ref), trimmed)
  }

  /** Remove one platform key from the credentials domain. */
  async removeKey(platform: string): Promise<void> {
    const ref = KEY_REFS[platform as keyof typeof KEY_REFS]
    if (!ref) throw new Error(`未知平台：${platform}`)
    const credentials = this.getCredentials()
    if (!credentials) return
    await credentials.unset(credentialRef(ref))
  }

  /** Validate and persist one user-declared HTTP platform. */
  async addHttpPlatform(platform: CustomHttpPlatform): Promise<void> {
    const id = (platform.id ?? '').trim()
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('id 只能含小写字母、数字、连字符')
    const label = (platform.label ?? '').trim()
    if (!label) throw new Error('名称不能为空')
    const endpoint = (platform.endpoint ?? '').trim()
    if (!/^https:\/\/.+/.test(endpoint)) throw new Error('接口地址必须是 https URL')
    const keyRef = (platform.keyRef ?? '').trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(keyRef)) throw new Error('凭证引用必须是大写下划线命名（如 MY_PLATFORM_API_KEY）')
    const format = (platform.format ?? '').trim()
    if (format !== 'openai-billing' && !FORMATS[format]) throw new Error(`未知格式：${format}`)
    if (!(CUSTOM_FORMATS as readonly string[]).includes(format)) throw new Error(`格式 ${format} 不适用于自定义平台`)
    const builtinIds = new Set([...DIRECT_ADAPTERS, ...CATALOG_EXTRA].map((a) => a.id))
    if (builtinIds.has(id)) throw new Error(`id ${id} 与内置平台重复`)
    const current = this.state().httpPlatforms
    if (current.some((p) => p.id === id)) throw new Error(`id ${id} 已存在`)
    await this.patch({ httpPlatforms: [...current, { id, label, endpoint, keyRef, format }] })
    await this.refresh()
  }

  /** Remove one user-declared HTTP platform by id. */
  async removeHttpPlatform(id: string): Promise<void> {
    await this.patch({ httpPlatforms: this.state().httpPlatforms.filter((p) => p.id !== id) })
    await this.refresh()
  }

  /** Describe configured keys (never the values): which ref supplies each platform. */
  async keyStatus(): Promise<Record<string, { configured: boolean; source?: string; ref?: string; manual?: boolean }>> {
    const credentials = this.getCredentials()
    const out: Record<string, { configured: boolean; source?: string; ref?: string; manual?: boolean }> = {}
    for (const adapter of DIRECT_ADAPTERS) {
      const key = await resolveKey(credentials, adapter.keyRefs, adapter.envKeys)
      const privateRef = KEY_REFS[adapter.id as keyof typeof KEY_REFS]
      out[adapter.id] = key
        ? { configured: true, source: key.source, ref: key.ref, manual: key.ref === privateRef && key.source !== 'env' }
        : { configured: false }
    }
    return out
  }
}
