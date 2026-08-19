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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Config, CustomHttpPlatform, CustomMcpPlatform, LoginFlow, ProviderSnapshot, QuotaItem } from './config.ts'
import { EMPTY_CURRENT_MODEL, KEY_REFS } from './config.ts'
import { CATALOG_EXTRA, CUSTOM_FORMATS, DIRECT_ADAPTERS, FORMATS, customHttpFetch, type DirectAdapter } from './direct.ts'
import { MCP_ADAPTERS, customAdapter, runMcpAdapter, type McpAdapter } from './mcp.ts'

/** How long one provider may take before it is marked failed. */
const PROVIDER_TIMEOUT_MS = 20000

/** Built-in login pages for the known MCP platforms (config loginFlows override). */
const DEFAULT_LOGIN_URLS: Record<string, string> = {
  scnet: 'https://www.scnet.cn/',
  qianwen: 'https://bailian.console.aliyun.com/',
  bigmodel: 'https://open.bigmodel.cn/',
  tokenrouter: 'https://www.tokenrouter.tech/login',
  supawriter: 'https://supawriter.sevnday.com/',
}

/** CDP port for login flows that need cookie extraction afterwards. */
const LOGIN_CHROME_PORT = 9229

const execFileAsync = promisify(execFile)

/** Open a URL in the default browser (or a CDP-enabled Chrome for cookie flows). */
function openUrl(url: string, debugChrome: boolean): void {
  if (process.platform === 'darwin') {
    if (debugChrome) {
      execFile('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${LOGIN_CHROME_PORT}`, '--user-data-dir=/tmp/dsh-quota-login', url], () => undefined)
      return
    }
    execFile('open', [url], () => undefined)
    return
  }
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => undefined)
    return
  }
  execFile('xdg-open', [url], () => undefined)
}

/** The DSH default-model selection (agent-default-model settings namespace). */
export interface DefaultModelSelection {
  provider: string
  model: string
}

/** Map a model-provider id (llm-pi-ai) onto a quota platform id. */
function platformForProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p.includes('kimi')) return 'kimi'
  if (p.includes('deepseek')) return 'deepseek'
  if (p.includes('zhipu') || p.includes('glm')) return 'zhipu'
  if (p.includes('zai')) return 'zhipu'
  if (p.includes('qwen') || p.includes('dashscope') || p.includes('bailian')) return 'qianwen'
  if (p.includes('moonshot')) return 'moonshot'
  if (p.includes('openrouter')) return 'openrouter'
  if (p.includes('siliconflow')) return 'siliconflow'
  if (p.includes('minimax')) return 'minimax'
  if (p.includes('step')) return 'stepfun'
  if (p.includes('xai') || p.includes('grok')) return 'xai'
  if (p.includes('opencode')) return 'opencode-go'
  return ''
}

/** Compact window tag for the pill: "5 小时窗口"→5h, "周额度"→周, "300m 窗口"→300m. */
function shortTag(label: string): string {
  if (/5\s*小时/.test(label)) return '5h'
  const m = label.match(/(\d+)\s*m\b/)
  if (m) return `${m[1]}m`
  if (/本周|周/.test(label)) return '周'
  if (/月/.test(label)) return '月'
  return ''
}

/** One-line quota summary for the pill: up to two headline windows joined by " · ". */
function summarize(snapshot: ProviderSnapshot): string {
  if (snapshot.status !== 'ok') return ''
  const head = (item: QuotaItem): string | undefined => {
    // 百分比优先（带 %），其次货币/文本 display（自带符号），最后裸计数。
    const value = item.percent !== undefined
      ? `剩${Math.max(0, Math.round(100 - item.percent))}%`
      : item.display ?? (item.remaining !== undefined ? `剩${item.remaining}` : undefined)
    if (value === undefined) return undefined
    const tag = shortTag(item.label)
    return tag ? `${tag} ${value}` : value
  }
  // Coding Plan 有多个窗口（5h/周…）时都显示，最多两条。
  const headlines = snapshot.items.filter((i) => /窗口|周|余额|额度/.test(i.label))
  const parts = (headlines.length > 0 ? headlines : snapshot.items)
    .map(head)
    .filter((v): v is string => Boolean(v))
    .slice(0, 2)
  return parts.join(' · ')
}

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
  /** Platforms the panel's key manager covers (every direct/API-key row). */
  keyPlatforms(): Array<{ id: string; label: string }>
  /** Add one user-declared HTTP platform (persisted in the namespace). */
  addHttpPlatform(platform: CustomHttpPlatform): Promise<void>
  /** Remove one user-declared HTTP platform by id. */
  removeHttpPlatform(id: string): Promise<void>
  /** Login flows known to the panel: platform id → login page URL. */
  loginUrls(): Record<string, string>
  /** Open a platform's login page (CDP-enabled Chrome when the flow needs cookies). */
  loginStart(platform: string): Promise<void>
  /** User confirms login done: run the flow's afterLogin hook, then refresh. */
  loginDone(platform: string): Promise<Config>
}

export class QuotaController implements QuotaControllerFace {
  private readonly ctx: Context
  private readonly getScope: () => SettingsScope<Config> | undefined
  private readonly getCredentials: () => CredentialProvider | undefined
  private readonly getCustomPlatforms: () => CustomMcpPlatform[]
  private readonly getDefaultModel: () => DefaultModelSelection | undefined
  private readonly getProviderKeyRefs: () => Record<string, string>

  constructor(ctx: Context, getScope: () => SettingsScope<Config> | undefined, getCredentials: () => CredentialProvider | undefined, getCustomPlatforms: () => CustomMcpPlatform[] = () => [], getDefaultModel: () => DefaultModelSelection | undefined = () => undefined, getProviderKeyRefs: () => Record<string, string> = () => ({})) {
    this.ctx = ctx
    this.getScope = getScope
    this.getCredentials = getCredentials
    this.getCustomPlatforms = getCustomPlatforms
    this.getDefaultModel = getDefaultModel
    this.getProviderKeyRefs = getProviderKeyRefs
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
    return this.getScope()?.get() ?? { refreshedAt: '', refreshing: false, refreshOnBoot: true, refreshIntervalMinutes: 0, mcpPlatforms: [], httpPlatforms: [], loginFlows: [], providerKeyRefs: {}, currentModel: EMPTY_CURRENT_MODEL, providers: [] }
  }

  /** Patch the settings namespace (no-op without a settings service). */
  private async patch(patch: Partial<Config>): Promise<void> {
    const scope = this.getScope()
    if (scope === undefined) return
    await scope.update(patch)
  }

  /** Custom HTTP platforms as direct adapters (built-in catalog ids win). */
  private customHttpAdapters(): DirectAdapter[] {
    const builtinIds = new Set([...DIRECT_ADAPTERS, ...CATALOG_EXTRA].map((a) => a.id))
    return this.state().httpPlatforms
      .filter((p) => p.id && p.endpoint && !builtinIds.has(p.id))
      .map((p): DirectAdapter => ({
        id: p.id,
        label: p.label,
        keyRefs: [p.keyRef],
        envKeys: [p.keyRef],
        fetch: customHttpFetch(p),
      }))
  }

  /** Every direct adapter: pinned + auto-discovered catalog + user-declared. */
  private allDirectAdapters(): DirectAdapter[] {
    return [...DIRECT_ADAPTERS, ...CATALOG_EXTRA, ...this.customHttpAdapters()]
  }

  /** Refresh every platform; failures are contained per platform. */
  async refresh(): Promise<Config> {
    await this.patch({ refreshing: true })
    const startedAt = new Date().toISOString()
    try {
      const credentials = this.getCredentials()
      const tools = this.ctx.get('tools')

      // One ROW PER RESOLVED REF: two accounts on the same platform (e.g.
      // ZAI_CODING_CN_API_KEY + ZHIPU_API_KEY) render as two cards, and the
      // model→platform correspondence can key on the exact ref.
      const runDirect = async (adapter: DirectAdapter, pinned: boolean): Promise<ProviderSnapshot[]> => {
        const keys: ResolvedKey[] = []
        const seen = new Set<string>()
        for (const ref of [...adapter.keyRefs, ...adapter.envKeys]) {
          if (seen.has(ref)) continue
          seen.add(ref)
          const key = await resolveKey(credentials, [ref], [ref])
          if (key) keys.push(key)
        }
        if (keys.length === 0) {
          if (!pinned) return [] // auto-discovered rows stay hidden without a key
          return [{
            id: adapter.id,
            label: adapter.label,
            status: 'missing-key',
            message: '未找到 API key（DSH 凭证与环境变量均无）',
            via: 'api',
            items: [],
          }]
        }
        const multi = keys.length > 1
        return Promise.all(keys.map(async (key): Promise<ProviderSnapshot> => {
          const id = multi ? `${adapter.id}#${key.ref}` : adapter.id
          try {
            const snapshot = await adapter.fetch(key.value, AbortSignal.timeout(PROVIDER_TIMEOUT_MS))
            return { ...snapshot, id, keyRef: key.ref, keySource: key.source }
          } catch (error) {
            return {
              id,
              label: adapter.label,
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
              via: 'api',
              keyRef: key.ref,
              keySource: key.source,
              items: [],
            }
          }
        }))
      }

      const customHttp = this.customHttpAdapters()

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
        : this.mcpAdapters().map(async (adapter): Promise<ProviderSnapshot> => ({
            id: adapter.id,
            label: adapter.label,
            status: 'missing-mcp',
            message: '工具运行时不可用',
            via: 'mcp',
            items: [],
          }))

      const jobs: Array<Promise<ProviderSnapshot | ProviderSnapshot[]>> = [...directJobs, ...mcpJobs]
      const settled = await Promise.allSettled(jobs)
      // Optional rows stay hidden: unregistered MCP servers never reach the
      // panel; direct jobs yield one row PER RESOLVED REF (multi-account).
      const providers = settled
        .flatMap((s) => {
          if (s.status !== 'fulfilled') {
            return [{
              id: 'unknown',
              label: '未知平台',
              status: 'error' as const,
              message: s.reason instanceof Error ? s.reason.message : String(s.reason),
              items: [],
            }]
          }
          return Array.isArray(s.value) ? s.value : [s.value]
        })
        .filter((p) => p.status !== 'missing-mcp')

      // DSH 模型供应商 id → apiKeyEnv（供 pill 精确对应平台卡片）。
      const providerKeyRefs = this.getProviderKeyRefs()

      // DSH 当前默认模型 → 先按 apiKeyEnv 精确对应卡片（同平台多号也准），
      // 再退回到名称模糊匹配 → 一句话额度摘要（pill 展示）。
      const dm = this.getDefaultModel()
      let currentModel = EMPTY_CURRENT_MODEL
      if (dm?.provider) {
        const platform = platformForProvider(dm.provider)
        const ref = providerKeyRefs[dm.provider]
        const row = (ref ? providers.find((p) => p.keyRef === ref) : undefined)
          ?? (platform ? providers.find((p) => p.id === platform || p.id.startsWith(`${platform}#`)) : undefined)
        currentModel = { provider: dm.provider, model: dm.model, platform: row?.id ?? platform, summary: row ? summarize(row) : '' }
      }

      const state: Config = { ...this.state(), refreshedAt: startedAt, refreshing: false, providers, currentModel, providerKeyRefs }
      await this.patch({ refreshedAt: startedAt, refreshing: false, providers, currentModel, providerKeyRefs })
      return state
    } catch (error) {
      const state: Config = { ...this.state(), refreshedAt: startedAt, refreshing: false }
      await this.patch({ refreshing: false })
      return state
    }
  }

  /** Which ref a manual save for this platform writes to: the pinned three keep plugin-private refs (deleting them can never break DSH model routing); catalog extras and custom platforms write their shared ref so DSH model providers pick the key up too. */
  private writeRefFor(platform: string): string | undefined {
    const priv = KEY_REFS[platform as keyof typeof KEY_REFS]
    if (priv) return priv
    const adapter = this.allDirectAdapters().find((a) => a.id === platform)
    return adapter?.keyRefs[0]
  }

  /** Platforms the panel's key manager covers: every direct (API-key) row. */
  keyPlatforms(): Array<{ id: string; label: string }> {
    return this.allDirectAdapters().map((a) => ({ id: a.id, label: a.label }))
  }

  /** Store one platform key into the credentials domain. */
  async saveKey(platform: string, key: string): Promise<void> {
    const ref = this.writeRefFor(platform)
    if (!ref) throw new Error(`未知平台：${platform}`)
    const trimmed = key.trim()
    if (!trimmed) throw new Error('key 不能为空')
    const credentials = this.getCredentials()
    if (!credentials) throw new Error('凭证服务不可用')
    await credentials.set(credentialRef(ref), trimmed)
  }

  /** Remove one platform key from the credentials domain. */
  async removeKey(platform: string): Promise<void> {
    const ref = this.writeRefFor(platform)
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

  /** Built-in login URLs overridden by config loginFlows. */
  private flows(): Map<string, LoginFlow> {
    const map = new Map<string, LoginFlow>()
    for (const [id, url] of Object.entries(DEFAULT_LOGIN_URLS)) map.set(id, { id, url })
    for (const f of this.state().loginFlows ?? []) {
      if (f.id && f.url) map.set(f.id, f)
    }
    return map
  }

  /** Platform id → login page URL, for the panel's 去登录 button. */
  loginUrls(): Record<string, string> {
    return Object.fromEntries([...this.flows().values()].map((f) => [f.id, f.url]))
  }

  /** Open the platform's login page. */
  async loginStart(platform: string): Promise<void> {
    const flow = this.flows().get(platform)
    if (!flow) throw new Error(`平台 ${platform} 没有配置登录页`)
    openUrl(flow.url, flow.debugChrome === true)
  }

  /** User confirms login: run the optional afterLogin hook, then refresh. */
  async loginDone(platform: string): Promise<Config> {
    const flow = this.flows().get(platform)
    if (flow?.afterLogin) {
      try {
        await execFileAsync('sh', ['-c', flow.afterLogin], { timeout: 60000 })
      } catch (error) {
        this.ctx.logger.warn(`quota: afterLogin for ${platform} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.refresh()
  }

  /** Describe configured keys (never the values): which ref supplies each platform. */
  async keyStatus(): Promise<Record<string, { configured: boolean; source?: string; ref?: string; manual?: boolean }>> {
    const credentials = this.getCredentials()
    const out: Record<string, { configured: boolean; source?: string; ref?: string; manual?: boolean }> = {}
    for (const adapter of this.allDirectAdapters()) {
      const key = await resolveKey(credentials, adapter.keyRefs, adapter.envKeys)
      const privateRef = KEY_REFS[adapter.id as keyof typeof KEY_REFS]
      out[adapter.id] = key
        ? { configured: true, source: key.source, ref: key.ref, manual: key.ref === privateRef && key.source !== 'env' }
        : { configured: false }
    }
    return out
  }
}
