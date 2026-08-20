/**
 * Panel controller: bridges the plugin's HTTP API (same-origin routes under
 * /plugins/dsh-quota/api) onto the snapshot store; also owns the key-entry
 * drafts for the three direct platforms.
 * @module dsh-quota/client/controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One item row as rendered by the panel. */
export interface PanelItem {
  label: string
  used?: number
  limit?: number
  remaining?: number
  percent?: number
  resetAt?: string
  display?: string
}

/** One platform row as rendered by the panel. */
export interface PanelProvider {
  id: string
  label: string
  status: 'ok' | 'error' | 'missing-key' | 'missing-mcp'
  message?: string
  via?: 'api' | 'mcp'
  /** Credential ref that supplied the key (never the value). */
  keyRef?: string
  /** Source layer of the resolved key. */
  keySource?: string
  items: PanelItem[]
}

/** Key configuration state (never values). */
export interface PanelKeyState {
  [platform: string]: { configured: boolean; source?: string; ref?: string; manual?: boolean }
}

/** One user-declared custom HTTP platform as rendered in the panel. */
export interface CustomPlatform {
  id: string
  label: string
  endpoint: string
  keyRef: string
  format: string
}

/** Draft of the add-custom-platform form. */
export interface CustomDraft {
  label: string
  endpoint: string
  keyRef: string
  format: string
}

/** Structural face of ctx.modelDirectories (avoids a hard type dependency). */
export interface ModelDirectoriesLike {
  directoryFor(sessionId: string): {
    store: {
      getSnapshot(): { current: { provider: string; model: string } | null }
      subscribe(fn: () => void): () => void
    }
  }
}

/** Map a model-provider id onto a quota platform id (mirror of the host side). */
export function platformForProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p.includes('kimi')) return 'kimi'
  if (p.includes('deepseek')) return 'deepseek'
  if (p.includes('zhipu') || p.includes('glm')) return 'zhipu'
  if (p.includes('zai')) return 'zhipu'
  if (p.includes('qwen') || p.includes('dashscope')) return 'qianwen' // 注意：不带 'bailian'——自定义 bailian 供应商常是别人的 key，映射到自己账号的 MCP 行会显示错账号
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

/** One-line quota summary: up to two headline windows joined by " · ". */
export function summarizeItems(provider: PanelProvider | undefined): string {
  if (!provider || provider.status !== 'ok') return ''
  const head = (item: PanelItem): string | undefined => {
    const value = item.percent !== undefined
      ? `剩${Math.max(0, Math.round(100 - item.percent))}%`
      : item.display ?? (item.remaining !== undefined ? `剩${item.remaining}` : undefined)
    if (value === undefined) return undefined
    const tag = shortTag(item.label)
    return tag ? `${tag} ${value}` : value
  }
  const headlines = provider.items.filter((i) => /窗口|周|余额|额度|金额/.test(i.label))
  const parts = (headlines.length > 0 ? headlines : provider.items)
    .map(head)
    .filter((v): v is string => Boolean(v))
    .slice(0, 2)
  return parts.join(' · ')
}

/** What the panel renders. */
export interface QuotaPanelState {
  /** False until the first status read lands. */
  loaded: boolean
  /** True while a refresh round trip is in flight. */
  busy: boolean
  /** Panel open. */
  open: boolean
  refreshedAt: string
  providers: PanelProvider[]
  keys: PanelKeyState
  /** Local form error. */
  formError: string
  /** Key drafts, one input per direct platform. */
  drafts: Record<string, string>
  /** Key save in flight. */
  savingKey: string
  /** Manual key section expanded. */
  showKeys: boolean
  /** User-declared custom HTTP platforms. */
  customPlatforms: CustomPlatform[]
  /** Formats the host offers for custom platforms. */
  formats: string[]
  /** Custom-platform section expanded. */
  showCustom: boolean
  /** Add-platform form draft. */
  customDraft: CustomDraft
  /** Add/remove round trip in flight. */
  savingCustom: boolean
  /** DSH 当前默认模型及额度摘要（pill 兜底展示）。 */
  currentModel: { provider: string; model: string; platform: string; summary: string }
  /** 当前会话实际选用的模型（优先于默认模型展示在 pill）。 */
  sessionModel: { provider: string; model: string } | null
  /** 平台 id → 登录页 URL（登录态失败的平台显示「去登录」）。 */
  loginFlows: Record<string, string>
  /** 已点过「去登录」、等待用户确认的平台 id。 */
  loginPending: string
  /** Key 管理覆盖的直连平台（host 下发）。 */
  keyPlatforms: Array<{ id: string; label: string }>
  /** DSH 模型供应商 id → apiKeyEnv（host 下发，pill 精确对应卡片）。 */
  providerKeyRefs: Record<string, string>
  /** 登录态失效、可一键重登的平台（悬浮球上方提醒条）。 */
  loginAlerts: Array<{ id: string; label: string }>
}

/** The registration-side face the slot entry injects. */
export interface QuotaPanelFace {
  hooks: {
    /** Panel snapshot bound by the renderer as useQuotaPanel. */
    quotaPanel: SnapshotStore<QuotaPanelState>
  }
  toggle(): void
  close(): void
  refresh(): void
  toggleKeys(): void
  editKey(platform: string, value: string): void
  saveKey(platform: string): void
  removeKey(platform: string): void
  toggleCustom(): void
  editCustom(field: keyof CustomDraft, value: string): void
  addCustom(): void
  removeCustom(id: string): void
  /** Follow a session's model selection (called when the visible session changes). */
  watchSession(sessionId: string | undefined): void
  /** Open the platform login page. */
  loginStart(platform: string): void
  /** User confirms login done → host runs the flow hook and refreshes. */
  loginRetry(platform: string): void
  /** Dismiss one login alert until the platform recovers and fails again. */
  dismissLogin(platform: string): void
}

/** Initial snapshot before the first status read. */
const INITIAL: QuotaPanelState = {
  loaded: false,
  busy: false,
  open: false,
  refreshedAt: '',
  providers: [],
  keys: {},
  formError: '',
  drafts: {},
  savingKey: '',
  showKeys: false,
  customPlatforms: [],
  formats: [],
  showCustom: false,
  customDraft: { label: '', endpoint: '', keyRef: '', format: 'openai-billing' },
  savingCustom: false,
  currentModel: { provider: '', model: '', platform: '', summary: '' },
  sessionModel: null,
  loginFlows: {},
  loginPending: '',
  keyPlatforms: [],
  providerKeyRefs: {},
  loginAlerts: [],
}

const API_PREFIX = '/plugins/dsh-quota/api'

/** Opening the panel auto-refreshes when the snapshot is older than this. */
const AUTO_REFRESH_STALE_MS = 5 * 60 * 1000

/** Drives the panel off the plugin's HTTP API. */
/** 登录态失效的错误特征。 */
const LOGINISH = /未登录|未授权|未认证|401|登录|login|unauthorized/i

export class QuotaPanelController {
  private readonly store: SnapshotStore<QuotaPanelState>
  private modelDirs: ModelDirectoriesLike | undefined
  /** 已忽略提醒的平台（恢复后再次失败会重新提醒）。 */
  private readonly dismissedAlerts = new Set<string>()
  private unwatchModel: (() => void) | undefined
  private watchingSession: string | undefined

  constructor() {
    this.store = createSnapshotStore<QuotaPanelState>(INITIAL)
    void this.reload()
  }

  /** Bind ctx.modelDirectories so the pill can follow the visible session's model. */
  bindModelDirectories(dirs: ModelDirectoriesLike | undefined): void {
    this.modelDirs = dirs
  }

  /** Periodic light re-read of the host snapshot (the host refreshes upstreams on its own cadence). */
  pollIfVisible(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (this.store.getSnapshot().busy) return
    void this.reload()
  }

  /** Subscribe to one session's model selection; undefined clears back to the default-model summary. */
  watchSession(sessionId: string | undefined): void {
    if (sessionId === this.watchingSession) return
    this.watchingSession = sessionId
    this.unwatchModel?.()
    this.unwatchModel = undefined
    const dirs = this.modelDirs
    if (!dirs || !sessionId) {
      this.patch({ sessionModel: null })
      return
    }
    let store: { getSnapshot(): { current: { provider: string; model: string } | null }; subscribe(fn: () => void): () => void }
    try {
      store = dirs.directoryFor(sessionId).store
    } catch {
      // Session without Agent-bound model RPCs (e.g. subagent views).
      this.patch({ sessionModel: null })
      return
    }
    const applyCurrent = (): void => this.patch({ sessionModel: store.getSnapshot().current ?? null })
    applyCurrent()
    this.unwatchModel = store.subscribe(applyCurrent)
  }

  /** Build the face the slot registration injects. */
  inject(): QuotaPanelFace {
    return {
      hooks: { quotaPanel: this.store },
      toggle: () => {
        const next = !this.store.getSnapshot().open
        this.patch({ open: next })
        // Show the stored snapshot immediately, then refresh in the
        // background when it is stale — the panel never blocks on the
        // multi-platform round trip.
        if (next) void this.reload().then(() => this.refreshIfStale())
      },
      close: () => this.patch({ open: false }),
      refresh: () => { void this.refresh() },
      toggleKeys: () => this.patch({ showKeys: !this.store.getSnapshot().showKeys }),
      editKey: (platform, value) => this.patch({ drafts: { ...this.store.getSnapshot().drafts, [platform]: value }, formError: '' }),
      saveKey: (platform) => { void this.saveKey(platform) },
      removeKey: (platform) => { void this.removeKey(platform) },
      toggleCustom: () => this.patch({ showCustom: !this.store.getSnapshot().showCustom }),
      editCustom: (field, value) => this.patch({ customDraft: { ...this.store.getSnapshot().customDraft, [field]: value }, formError: '' }),
      addCustom: () => { void this.addCustom() },
      removeCustom: (id) => { void this.removeCustom(id) },
      watchSession: (sessionId) => { this.watchSession(sessionId) },
      loginStart: (platform) => { void this.loginStart(platform) },
      loginRetry: (platform) => { void this.loginRetry(platform) },
      dismissLogin: (platform) => { this.dismissLogin(platform) },
    }
  }

  /** Read the snapshot (initial load, opening the panel). */
  private async reload(): Promise<void> {
    try {
      const state = await request<{ refreshedAt: string; providers: PanelProvider[]; keys: PanelKeyState; httpPlatforms?: CustomPlatform[]; formats?: string[]; currentModel?: QuotaPanelState['currentModel']; loginFlows?: Record<string, string>; keyPlatforms?: Array<{ id: string; label: string }>; providerKeyRefs?: Record<string, string> }>('/status')
      this.store.set({
        ...this.store.getSnapshot(),
        loaded: true,
        refreshedAt: state.refreshedAt,
        providers: state.providers,
        keys: state.keys,
        customPlatforms: state.httpPlatforms ?? [],
        formats: state.formats ?? [],
        loginFlows: state.loginFlows ?? {},
        keyPlatforms: state.keyPlatforms ?? [],
        providerKeyRefs: state.providerKeyRefs ?? {},
        ...(state.currentModel ? { currentModel: state.currentModel } : {}),
      })
      this.updateLoginAlerts(state.providers, state.loginFlows ?? {})
    } catch {
      this.patch({ loaded: true, formError: '无法读取插件状态，请刷新页面' })
    }
  }

  /** Recompute the login-alert list from the latest snapshot. */
  private updateLoginAlerts(providers: PanelProvider[], flows: Record<string, string>): void {
    for (const p of providers) {
      if (p.status === 'ok') this.dismissedAlerts.delete(p.id) // 恢复后清除忽略记录
    }
    const loginAlerts = providers
      .filter((p) => p.status === 'error' && p.message && LOGINISH.test(p.message) && flows[p.id] && !this.dismissedAlerts.has(p.id))
      .map((p) => ({ id: p.id, label: p.label }))
    this.patch({ loginAlerts })
  }

  /** Dismiss one login alert until the platform recovers and fails again. */
  private dismissLogin(platform: string): void {
    this.dismissedAlerts.add(platform)
    this.patch({ loginAlerts: this.store.getSnapshot().loginAlerts.filter((a) => a.id !== platform) })
  }

  /** Open the platform's login page; the button then flips to 重试. */
  private async loginStart(platform: string): Promise<void> {
    try {
      await request('/login', { platform })
      this.patch({ loginPending: platform, formError: '' })
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    }
  }

  /** User confirms login: host runs the flow's afterLogin hook and refreshes. */
  private async loginRetry(platform: string): Promise<void> {
    await this.roundTrip(async () => {
      await request('/login/done', { platform })
      this.patch({ loginPending: '' })
      await this.reload()
    })
  }

  /** Add the custom-platform draft as a new provider row. */
  private async addCustom(): Promise<void> {
    const draft = this.store.getSnapshot().customDraft
    if (!draft.label.trim() || !draft.endpoint.trim() || !draft.keyRef.trim()) {
      this.patch({ formError: '名称、接口地址、凭证引用都要填' })
      return
    }
    // Derive the id from the label: lowercase slug, dash-separated.
    const id = draft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
    this.patch({ savingCustom: true, formError: '' })
    try {
      await request('/platforms', { id, label: draft.label.trim(), endpoint: draft.endpoint.trim(), keyRef: draft.keyRef.trim(), format: draft.format })
      this.patch({ customDraft: { label: '', endpoint: '', keyRef: '', format: this.store.getSnapshot().customDraft.format } })
      await this.reload()
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.patch({ savingCustom: false })
    }
  }

  /** Remove one custom platform. */
  private async removeCustom(id: string): Promise<void> {
    this.patch({ savingCustom: true, formError: '' })
    try {
      await request('/platforms/remove', { id })
      await this.reload()
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.patch({ savingCustom: false })
    }
  }

  /** Refresh when the stored snapshot is stale (called after opening the panel). */
  private async refreshIfStale(): Promise<void> {
    const { refreshedAt, busy } = this.store.getSnapshot()
    if (busy) return
    const age = refreshedAt ? Date.now() - new Date(refreshedAt).getTime() : Number.POSITIVE_INFINITY
    if (Number.isNaN(age) || age > AUTO_REFRESH_STALE_MS) await this.refresh()
  }

  /** Ask the Host to refresh every platform snapshot. */
  private async refresh(): Promise<void> {    await this.roundTrip(async () => {
      const state = await request<{ refreshedAt: string; providers: PanelProvider[] }>('/refresh', {})
      this.store.set({
        ...this.store.getSnapshot(),
        refreshedAt: state.refreshedAt,
        providers: state.providers,
      })
    })
  }

  /** Store one platform key via the host credentials domain. */
  private async saveKey(platform: string): Promise<void> {
    const key = this.store.getSnapshot().drafts[platform] ?? ''
    if (!key.trim()) {
      this.patch({ formError: 'key 不能为空' })
      return
    }
    await this.keyRoundTrip(platform, async () => {
      const result = await request<{ keys: PanelKeyState }>('/keys', { platform, key })
      this.patch({
        keys: result.keys,
        drafts: { ...this.store.getSnapshot().drafts, [platform]: '' },
      })
      await this.refresh()
    })
  }

  /** Remove one platform key via the host credentials domain. */
  private async removeKey(platform: string): Promise<void> {
    await this.keyRoundTrip(platform, async () => {
      const result = await request<{ keys: PanelKeyState }>('/keys/remove', { platform })
      this.patch({ keys: result.keys })
      await this.refresh()
    })
  }

  /** Run one refresh round trip with the busy flag bracketing it. */
  private async roundTrip(operation: () => Promise<void>): Promise<void> {
    this.patch({ busy: true, formError: '' })
    try {
      await operation()
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.patch({ busy: false })
    }
  }

  /** Run one key round trip with the savingKey flag bracketing it. */
  private async keyRoundTrip(platform: string, operation: () => Promise<void>): Promise<void> {
    this.patch({ savingKey: platform, formError: '' })
    try {
      await operation()
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.patch({ savingKey: '' })
    }
  }

  /** Merge a local patch into the snapshot. */
  private patch(patch: Partial<QuotaPanelState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }
}

/** Same-origin JSON call against the plugin API; POSTs carry the CSRF header. */
async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...body !== undefined
      ? {
        headers: { 'content-type': 'application/json', 'x-dsh-quota': '1' },
        body: JSON.stringify(body),
      }
      : {},
  })
  if (!response.ok) throw new Error(`插件请求失败（HTTP ${String(response.status)}）`)
  const data = await response.json() as T & { statusMessage?: string }
  if (body !== undefined && (data as { statusMessage?: string }).statusMessage) {
    throw new Error((data as { statusMessage: string }).statusMessage)
  }
  return data
}
