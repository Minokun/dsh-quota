/**
 * Panel controller: bridges the plugin's HTTP API (same-origin routes under
 * /plugins/dsh-quota/api) onto the snapshot store; also owns the key-entry
 * drafts for the three direct platforms.
 * @module dsh-quota/client/controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ackAll, deserializeAlertAckState, pruneAcks, serializeAlertAckState, type AlertAckState } from './alert-ack.ts'
import { alertIdentities, retainedUsageAckKeys } from './alerts.ts'
import { browserLang, translate, type Lang } from './locale.ts'
import { trendValues } from './sparkline.ts'
import { createUsageAlertState, deserializeUsageAlertState, evaluateUsageAlerts, serializeUsageAlertState, type UsageAlert, type UsageAlertState } from './usage-alerts.ts'
import { formatProviderSummary } from '../window-rank.ts'
import { nextDisplayMode, parseDisplayMode, type EntryDisplayMode } from './dock-logic.ts'

/** One item row as rendered by the panel. */
export interface PanelItem {
  label: string
  used?: number
  limit?: number
  remaining?: number
  percent?: number
  resetAt?: string
  display?: string
  /** 当前窗口段的平均消耗速率（%/h 或单位/h，host 按时序采样计算）。 */
  burnRatePerHour?: number
  /** 按当前速率预估的耗尽时间（分钟）。 */
  etaMinutes?: number
  /** 按当前配速是否会在窗口重置前耗尽（true = 超速撞墙预警）。 */
  depletesBeforeReset?: boolean
  /** 余额型条目：近 7 天实测消耗（日历日均 ×7；不足 7 天按已观测跨度折算，与余额同币种）。 */
  weeklySpent?: number
  /** 余额型条目：weeklySpent 用到的实测跨度（毫秒）。 */
  spendWindowMs?: number
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
  userId?: string
  quotaPerUnit?: number
}

/** Draft of the add-custom-platform form. */
export interface CustomDraft {
  label: string
  endpoint: string
  keyRef: string
  format: string
  userId: string
  quotaPerUnit: string
}

/** DSH 模型目录里的一个供应商分组（结构子集，用于对齐默认卡片顺序）。 */
export interface ModelCatalogGroupLike {
  readonly id: string
  readonly models?: ReadonlyArray<{ readonly id: string }>
}

/** One session's model directory (structural face of the model-selection plugin's ModelDirectory). */
export interface ModelDirectoryLike {
  store: {
    getSnapshot(): {
      current: { provider: string; model: string } | null
      groups?: readonly ModelCatalogGroupLike[]
      status?: string
    }
    subscribe(fn: () => void): () => void
  }
  /** Pulls the session's advisory directory (current included) from the host. */
  load?(): Promise<unknown>
}

/** Structural face of ctx.modelDirectories (avoids a hard type dependency). */
export interface ModelDirectoriesLike {
  directoryFor(sessionId: string): ModelDirectoryLike
}

/** Map a model-provider id onto a quota platform id (mirror of the host side). */
export { platformForProvider } from './platform-map.ts'

/** One-line quota summary: up to two headline windows joined by " · ". */
export function summarizeItems(provider: PanelProvider | undefined, lang: Lang = 'zh'): string {
  return formatProviderSummary(provider, {
    weeklyTag: translate(lang, 'tag.weekly'),
    monthlyTag: translate(lang, 'tag.monthly'),
    remainingPercent: (p) => translate(lang, 'summary.remainingPercent', { p }),
    remainingCount: (n) => translate(lang, 'summary.remainingCount', { n }),
  })
}

/** What the panel renders. */
import type { ModelSpeedSummary } from '../speed-sampler.ts'
import type { LedgerWireSnapshot } from '../session-ledger.ts'
import type { CandidatePlatform } from '../onboarding.ts'
import type { VerificationTier } from '../direct.ts'

export interface QuotaPanelState {
  /** False until the first status read lands. */
  loaded: boolean
  /** True while a refresh round trip is in flight. */
  busy: boolean
  /** Panel open. */
  open: boolean
  refreshedAt: string
  providers: PanelProvider[]
  /** 各额度条目最近的已用百分比序列（`${providerId}::${itemLabel}` → 升序采样），供 sparkline。 */
  trends: Record<string, number[]>
  /**
   * 逐模型测速结论（Host 被动采样自真实对话流）。认领到卡片由 speed-line.ts
   * 负责；旧版 Host 不返回该字段时按空数组处理（卡片不显示测速行）。
   */
  speed?: ModelSpeedSummary[]
  /** Host 侧按时刻计价的会话账本与今日三层汇总快照。 */
  ledger?: LedgerWireSnapshot
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
  keyPlatforms: Array<{ id: string; label: string; verification?: VerificationTier; defaultEndpoint?: string }>
  /** 未纳管的 DSH 公网 HTTPS 模型供应商路由候选（供零配置一键预填）。 */
  candidates: CandidatePlatform[]
  /** 用户在本地点击「忽略」过的候选 id 集合。 */
  ignoredCandidates: string[]
  /** DSH 模型供应商 id → apiKeyEnv（host 下发，pill 精确对应卡片）。 */
  providerKeyRefs: Record<string, string>
  /** 用户拖拽保存的面板卡片顺序（卡片 id 序列，见 panel-order.ts；空 = 跟随 DSH 模型顺序）。 */
  providerOrder: string[]
  /** DSH 模型选择器已加载的分组列表（细化 Magpie 等网关内部子卡默认顺序）。 */
  catalogGroups: ModelCatalogGroupLike[]
  /** 登录态失效、可一键重登的平台（悬浮球上方提醒条）。 */
  loginAlerts: Array<{ id: string; label: string }>
  /** 用量告警（悬浮球 toast：越阈值跨越 + 预计耗尽，见 usage-alerts.ts）。 */
  usageAlerts: UsageAlert[]
  /** 用量占比告警阈值（host 下发，默认 85）。 */
  alertPercent: number
  /** 已读告警（alert key → 已读时的条件签名，见 alert-ack.ts）：命中的不再计入红点。 */
  ackedAlerts: AlertAckState
  /** 正在测活的平台 id。 */
  probing: string
  /** 平台 id → 最近一次测活结果（延迟/错误）。 */
  probeResults: Record<string, { ok: boolean; ms: number; message?: string }>
  /** 是否向 Agent 暴露 `quota_refresh` 工具（默认 false）。 */
  exposeAgentTool: boolean
  /** 自检与设置抽屉是否展开。 */
  showDiag: boolean
  /** 最近一次复制脱敏报告的成功反馈标记。 */
  diagCopied: boolean
  /** 入口显示模式：both（默认）| dock-only | floater-only。 */
  displayMode: EntryDisplayMode
  /** 当前屏幕上已挂载的 composer.dock 窄条实例数（用于非会话页自动兜底浮球）。 */
  dockMountCount: number
  /** 面板文案语言（跟随 DSH locale 服务，服务缺失时按浏览器语言）。 */
  lang: Lang
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
  /** Dismiss one usage toast until its percent climbs ≥5 points or the window resets. */
  dismissUsageAlert(key: string): void
  /** Run a one-shot connectivity probe for one platform card. */
  probe(platform: string): void
  /** Persist the manual card order (平台组 key 序列，见 panel-order.ts). */
  setProviderOrder(order: string[]): void
  /** 把当前红点告警全部标为已读（条件不变就不再计数，窗口重置后自动恢复）。 */
  ackAlerts(): void
  /** 展开/收起自检与设置折叠区。 */
  toggleDiag(): void
  /** 切换是否向 Agent 暴露 `quota_refresh` 工具。 */
  setExposeAgentTool(enabled: boolean): void
  /** 拉取并复制脱敏自检报告到剪贴板。 */
  copyDiagnostics(): void
  /** 循环切换入口展示位置（both → dock-only → floater-only）。 */
  cycleDisplayMode(): void
  /** 注册一个已挂载的 composer.dock 窄条实例，返回卸载清理函数。 */
  mountDock(): () => void
  /** 将检测到的 DSH 供应商路由一键预填到自定义平台草稿并展开保存区。 */
  prefillCandidate(candidate: CandidatePlatform): void
  /** 忽略某个候选路由（持久化在 localStorage）。 */
  ignoreCandidate(id: string): void
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
  customDraft: { label: '', endpoint: '', keyRef: '', format: 'openai-billing', userId: '', quotaPerUnit: '500000' },
  savingCustom: false,
  currentModel: { provider: '', model: '', platform: '', summary: '' },
  sessionModel: null,
  loginFlows: {},
  loginPending: '',
  keyPlatforms: [],
  candidates: [],
  ignoredCandidates: loadIgnoredCandidates(),
  providerKeyRefs: {},
  providerOrder: [],
  catalogGroups: [],
  loginAlerts: [],
  usageAlerts: [],
  trends: {},
  alertPercent: 85,
  ackedAlerts: loadAlertAcks(),
  probing: '',
  probeResults: {},
  exposeAgentTool: false,
  showDiag: false,
  diagCopied: false,
  displayMode: loadDisplayMode(),
  dockMountCount: 0,
  lang: browserLang(),
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
  /** 用量提醒状态机（每窗口一次的规则 + 持久化，见 usage-alerts.ts）。 */
  private usageState: UsageAlertState = loadUsageAlertState()
  private unwatchModel: (() => void) | undefined
  private unwatchLocale: (() => void) | undefined
  private watchingSession: string | undefined

  constructor() {
    this.store = createSnapshotStore<QuotaPanelState>(INITIAL)
    void this.reload()
  }

  /** Current UI language (for client-generated error copy). */
  private lang(): Lang {
    return this.store.getSnapshot().lang
  }

  /**
   * Follow the official locale service when it exists: its active locale
   * drives the panel copy and every switch repaints. Structural face — the
   * plugin still works (browser-derived language) on builds without it.
   */
  bindLocale(service: { getSnapshot(): { active?: string }; subscribe(fn: () => void): () => void } | undefined): void {
    this.unwatchLocale?.()
    this.unwatchLocale = undefined
    if (!service) return
    const apply = (): void => {
      const active = service.getSnapshot().active
      this.patch({ lang: active === 'en' ? 'en' : 'zh' })
    }
    apply()
    this.unwatchLocale = service.subscribe(apply)
  }

  /** Bind ctx.modelDirectories so the pill can follow the visible session's model. */
  bindModelDirectories(dirs: ModelDirectoriesLike | undefined): void {
    this.modelDirs = dirs
    // Calls that arrived before the service was bound bailed out early;
    // re-run the watch now that the directory resolver is available.
    const sid = this.watchingSession
    this.watchingSession = undefined
    if (sid !== undefined) this.watchSession(sid)
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
    let directory: ModelDirectoryLike
    try {
      directory = dirs.directoryFor(sessionId)
    } catch {
      // Session without Agent-bound model RPCs (e.g. subagent views).
      this.patch({ sessionModel: null })
      return
    }
    const store = directory.store
    const applyCurrent = (): void => {
      const snap = store.getSnapshot()
      this.patch({
        sessionModel: snap.current ?? null,
        ...(snap.groups && snap.groups.length > 0 ? { catalogGroups: [...snap.groups] } : {}),
      })
    }
    applyCurrent()
    // A directory we resolved first never had its entries opened, so its
    // store still sits at idle/current:null — pull the selection ourselves.
    const snap = store.getSnapshot()
    if ((snap.current === null || !snap.groups || snap.groups.length === 0) && snap.status === 'idle' && typeof directory.load === 'function') {
      directory.load().catch(() => undefined)
    }
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
      dismissUsageAlert: (key) => { this.dismissUsageAlert(key) },
      probe: (platform) => { void this.probe(platform) },
      setProviderOrder: (order) => { void this.setProviderOrder(order) },
      ackAlerts: () => { this.ackAlerts() },
      toggleDiag: () => this.patch({ showDiag: !this.store.getSnapshot().showDiag }),
      setExposeAgentTool: (enabled) => { void this.setExposeAgentTool(enabled) },
      copyDiagnostics: () => { void this.copyDiagnostics() },
      cycleDisplayMode: () => {
        const next = nextDisplayMode(this.store.getSnapshot().displayMode)
        saveDisplayMode(next)
        this.patch({ displayMode: next })
      },
      mountDock: () => {
        this.patch({ dockMountCount: this.store.getSnapshot().dockMountCount + 1 })
        return () => {
          this.patch({ dockMountCount: Math.max(0, this.store.getSnapshot().dockMountCount - 1) })
        }
      },
      prefillCandidate: (candidate) => {
        const snap = this.store.getSnapshot()
        this.patch({
          showCustom: true,
          formError: '',
          customDraft: {
            ...snap.customDraft,
            label: candidate.label,
            endpoint: candidate.suggestedEndpoint,
            keyRef: candidate.keyRef,
            format: snap.customDraft.format || 'openai-billing',
          },
        })
      },
      ignoreCandidate: (id) => {
        const next = [...new Set([...this.store.getSnapshot().ignoredCandidates, id])]
        saveIgnoredCandidates(next)
        this.patch({ ignoredCandidates: next })
      },
    }
  }

  /** Read the snapshot (initial load, opening the panel). */
  private async reload(): Promise<void> {
    try {
      const state = await request<{ refreshedAt: string; providers: PanelProvider[]; keys: PanelKeyState; httpPlatforms?: CustomPlatform[]; formats?: string[]; currentModel?: QuotaPanelState['currentModel']; loginFlows?: Record<string, string>; keyPlatforms?: Array<{ id: string; label: string; verification?: VerificationTier; defaultEndpoint?: string }>; candidates?: CandidatePlatform[]; providerKeyRefs?: Record<string, string>; providerOrder?: string[]; alertPercent?: number; exposeAgentTool?: boolean; history?: Record<string, unknown>; speed?: ModelSpeedSummary[]; ledger?: LedgerWireSnapshot }>('/status', undefined, this.lang())
      // /status 本就携带 history（host 时序采样），这里裁成每条目最近 30 个
      // 采样值存入 trends，供面板条目的 sparkline 使用。
      const trends: Record<string, number[]> = {}
      for (const [key, row] of Object.entries(state.history ?? {})) {
        const values = trendValues(row)
        if (values.length > 0) trends[key] = values
      }
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
        candidates: state.candidates ?? [],
        providerKeyRefs: state.providerKeyRefs ?? {},
        providerOrder: state.providerOrder ?? [],
        alertPercent: state.alertPercent ?? 85,
        exposeAgentTool: state.exposeAgentTool === true,
        trends,
        // 被动测速：旧版 Host 不返回该字段 → 空数组，卡片不显示测速行。
        speed: state.speed ?? [],
        ...(state.ledger ? { ledger: state.ledger } : {}),
        ...(state.currentModel ? { currentModel: state.currentModel } : {}),
      })
      this.updateLoginAlerts(state.providers, state.loginFlows ?? {})
      this.updateUsageAlerts(state.providers, state.alertPercent ?? 85)
      this.pruneAlertAcks()
    } catch {
      this.patch({ loaded: true, formError: translate(this.lang(), 'error.readStatus') })
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

  /** Recompute the usage toasts from the latest provider rows (crossing + ETA rules). */
  private updateUsageAlerts(providers: PanelProvider[], alertPercent: number): void {
    const snap = this.store.getSnapshot()
    const { alerts: fired, state } = evaluateUsageAlerts(providers, alertPercent, this.usageState)
    this.usageState = state
    saveUsageAlertState(this.usageState)
    // 可见列表：本轮新触发的 + 仍在条件中的旧提醒（同 key+kind 去重），
    // 超过 TTL 的自动收起——提醒记录已在 state.shown，不会重新弹。
    const active = new Map(snap.usageAlerts.map((a) => [`${a.key}|${a.kind}`, a]))
    const now = Date.now()
    for (const a of fired) active.set(`${a.key}|${a.kind}`, { ...a, at: now })
    const itemOf = (a: { providerId: string; itemLabel: string }): { percent?: number; etaMinutes?: number } | undefined =>
      providers.find((p) => p.id === a.providerId && p.status === 'ok')?.items.find((i) => i.label === a.itemLabel)
    for (const [id, a] of [...active]) {
      const item = itemOf(a)
      if (item === undefined) { active.delete(id); continue } // 平台失败或条目消失
      if (a.kind === 'threshold' && (item.percent === undefined || item.percent < alertPercent)) active.delete(id)
      if (a.kind === 'eta' && (item.etaMinutes === undefined || item.etaMinutes > 60)) active.delete(id)
      if ((a.at ?? 0) !== 0 && now - (a.at ?? now) > ALERT_VISIBLE_MS) active.delete(id) // 自动收起
    }
    this.patch({ usageAlerts: [...active.values()] })
  }

  /** Dismiss one usage toast: the window stays marked shown, so it cannot re-fire. */
  private dismissUsageAlert(key: string): void {
    const snap = this.store.getSnapshot()
    this.patch({ usageAlerts: snap.usageAlerts.filter((a) => a.key !== key) })
  }

  /** 把当前红点告警全部标为已读；条件不变就不再计入红点。 */
  private ackAlerts(): void {
    const snap = this.store.getSnapshot()
    const next = ackAll(alertIdentities(snap), snap.ackedAlerts, retainedUsageAckKeys(snap))
    saveAlertAcks(next)
    this.patch({ ackedAlerts: next })
  }

  /**
   * 清掉已经消失的告警的已读记录：告警真正恢复（平台恢复 / 额度明显回落 / 窗口
   * 重置）后再出现时重新变回未读。没有变化则不写盘、不重渲染。
   */
  private pruneAlertAcks(): void {
    const snap = this.store.getSnapshot()
    const next = pruneAcks(snap.ackedAlerts, alertIdentities(snap), retainedUsageAckKeys(snap))
    if (next === undefined) return
    saveAlertAcks(next)
    this.patch({ ackedAlerts: next })
  }

  /** One-shot connectivity probe: latency on success, upstream error on failure. */
  private async probe(platform: string): Promise<void> {
    this.patch({ probing: platform })
    try {
      const result = await request<{ ok: boolean; ms: number; message?: string }>('/probe', { platform }, this.lang())
      this.patch({ probeResults: { ...this.store.getSnapshot().probeResults, [platform]: result } })
    } catch (error) {
      this.patch({
        probeResults: {
          ...this.store.getSnapshot().probeResults,
          [platform]: { ok: false, ms: 0, message: error instanceof Error ? error.message : String(error) },
        },
      })
    } finally {
      this.patch({ probing: '' })
    }
  }

  /**
   * 手动排序：先乐观更新本地快照（面板立刻重排），再 POST /order 落盘；
   * 失败回退到上一份顺序并把错误挂在 formError 上。
   */
  private async setProviderOrder(order: string[]): Promise<void> {
    const previous = this.store.getSnapshot().providerOrder
    this.patch({ providerOrder: order, formError: '' })
    try {
      const result = await request<{ ok?: boolean; providerOrder?: string[] }>('/order', { order }, this.lang())
      if (result.providerOrder) this.patch({ providerOrder: result.providerOrder })
    } catch (error) {
      this.patch({
        providerOrder: previous,
        formError: error instanceof Error && error.message
          ? error.message
          : translate(this.lang(), 'error.saveOrder'),
      })
    }
  }

  /** Open the platform's login page; the button then flips to 重试. */
  private async loginStart(platform: string): Promise<void> {
    try {
      await request('/login', { platform }, this.lang())
      this.patch({ loginPending: platform, formError: '' })
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    }
  }

  /** User confirms login: host runs the flow's afterLogin hook and refreshes. */
  private async loginRetry(platform: string): Promise<void> {
    await this.roundTrip(async () => {
      await request('/login/done', { platform }, this.lang())
      this.patch({ loginPending: '' })
      await this.reload()
    })
  }

  /** Add the custom-platform draft as a new provider row. */
  private async addCustom(): Promise<void> {
    const draft = this.store.getSnapshot().customDraft
    if (!draft.label.trim() || !draft.endpoint.trim() || !draft.keyRef.trim()) {
      this.patch({ formError: translate(this.lang(), 'error.customRequired') })
      return
    }
    const isNewApiAccount = draft.format === 'newapi-account'
    const quotaPerUnit = Number(draft.quotaPerUnit)
    if (isNewApiAccount && !/^[1-9]\d*$/.test(draft.userId.trim())) {
      this.patch({ formError: translate(this.lang(), 'error.newapiUserId') })
      return
    }
    if (isNewApiAccount && (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0)) {
      this.patch({ formError: translate(this.lang(), 'error.newapiQuotaPerUnit') })
      return
    }
    // Derive the id from the label: lowercase slug, dash-separated.
    const id = draft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
    this.patch({ savingCustom: true, formError: '' })
    try {
      // NewAPI account fields go only with the format that consumes them.
      await request('/platforms', {
        id,
        label: draft.label.trim(),
        endpoint: draft.endpoint.trim(),
        keyRef: draft.keyRef.trim(),
        format: draft.format,
        ...(isNewApiAccount ? { userId: draft.userId.trim(), quotaPerUnit } : {}),
      }, this.lang())
      this.patch({ customDraft: { label: '', endpoint: '', keyRef: '', format: this.store.getSnapshot().customDraft.format, userId: '', quotaPerUnit: '500000' } })
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
      await request('/platforms/remove', { id }, this.lang())
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
      const state = await request<{ refreshedAt: string; providers: PanelProvider[] }>('/refresh', {}, this.lang())
      this.store.set({
        ...this.store.getSnapshot(),
        refreshedAt: state.refreshedAt,
        providers: state.providers,
      })
      this.updateUsageAlerts(state.providers, this.store.getSnapshot().alertPercent)
      this.pruneAlertAcks()
    })
  }

  /** Store one platform key via the host credentials domain. */
  private async saveKey(platform: string): Promise<void> {
    const key = this.store.getSnapshot().drafts[platform] ?? ''
    if (!key.trim()) {
      this.patch({ formError: translate(this.lang(), 'error.keyEmpty') })
      return
    }
    await this.keyRoundTrip(platform, async () => {
      const result = await request<{ keys: PanelKeyState }>('/keys', { platform, key }, this.lang())
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
      const result = await request<{ keys: PanelKeyState }>('/keys/remove', { platform }, this.lang())
      this.patch({ keys: result.keys })
      await this.refresh()
    })
  }

  /** Toggle `exposeAgentTool` via CSRF-protected `/settings`. */
  private async setExposeAgentTool(enabled: boolean): Promise<void> {
    const prev = this.store.getSnapshot().exposeAgentTool
    this.patch({ exposeAgentTool: enabled, formError: '' })
    try {
      const res = await request<{ exposeAgentTool?: boolean }>('/settings', { exposeAgentTool: enabled }, this.lang())
      this.patch({ exposeAgentTool: res.exposeAgentTool === true })
    } catch (error) {
      this.patch({ exposeAgentTool: prev, formError: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Fetch `/diag` (with fallback to local report) and copy redacted Markdown to clipboard. */
  private async copyDiagnostics(): Promise<void> {
    try {
      const lang = this.lang()
      const res = await request<{ markdown?: string }>(`/diag?lang=${lang}`, undefined, lang)
      const text = res.markdown ?? ''
      if (text && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      }
      this.patch({ diagCopied: true })
      setTimeout(() => { this.patch({ diagCopied: false }) }, 2000)
    } catch (error) {
      this.patch({ formError: error instanceof Error ? error.message : String(error) })
    }
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
async function request<T>(path: string, body: Record<string, unknown> | undefined, lang: Lang): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...body !== undefined
      ? {
        headers: { 'content-type': 'application/json', 'x-dsh-quota': '1' },
        body: JSON.stringify(body),
      }
      : {},
  })
  if (!response.ok) throw new Error(translate(lang, 'error.requestFailed', { status: response.status }))
  const data = await response.json() as T & { statusMessage?: string }
  if (body !== undefined && (data as { statusMessage?: string }).statusMessage) {
    throw new Error((data as { statusMessage: string }).statusMessage)
  }
  return data
}

/** localStorage key for the once-per-window usage-alert state. */
const USAGE_ALERT_STORE_KEY = 'dsh-quota:usage-alerts'
/** localStorage key for the acked (read) alerts — the red badge stays quiet. */
const ALERT_ACK_STORE_KEY = 'dsh-quota:alert-acks'
/** localStorage key for entry placement (both | dock-only | floater-only). */
const DISPLAY_MODE_STORE_KEY = 'dsh-quota:display-mode'

function loadDisplayMode(): EntryDisplayMode {
  try {
    return parseDisplayMode(window.localStorage.getItem(DISPLAY_MODE_STORE_KEY))
  } catch {
    return 'both'
  }
}

function saveDisplayMode(mode: EntryDisplayMode): void {
  try {
    window.localStorage.setItem(DISPLAY_MODE_STORE_KEY, mode)
  } catch { /* private mode */ }
}

const IGNORED_CANDIDATES_STORE_KEY = 'dsh-quota:ignored-candidates'

function loadIgnoredCandidates(): string[] {
  try {
    const raw = window.localStorage.getItem(IGNORED_CANDIDATES_STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveIgnoredCandidates(ids: string[]): void {
  try {
    window.localStorage.setItem(IGNORED_CANDIDATES_STORE_KEY, JSON.stringify(ids.slice(0, 100)))
  } catch { /* private mode */ }
}
/** 用量提醒 toast 的自动收起时长：条件仍满足也收起（不会重弹，窗口内只提醒一次）。 */
const ALERT_VISIBLE_MS = 10 * 60 * 1000

/** 读持久化的提醒状态；不可用 / 损坏时回退空白状态（每窗口重新提醒一次也无妨）。 */
function loadUsageAlertState(): UsageAlertState {
  try {
    const raw = window.localStorage.getItem(USAGE_ALERT_STORE_KEY)
    if (raw === null) return createUsageAlertState()
    return deserializeUsageAlertState(raw) ?? createUsageAlertState()
  } catch {
    return createUsageAlertState() // 隐私模式等 localStorage 不可用
  }
}

/** 把提醒状态写回 localStorage（失败静默：本次运行内规则仍生效）。 */
function saveUsageAlertState(state: UsageAlertState): void {
  try {
    window.localStorage.setItem(USAGE_ALERT_STORE_KEY, serializeUsageAlertState(state))
  } catch { /* 隐私模式等 localStorage 不可用 */ }
}

/** 读持久化的已读告警；不可用 / 损坏时回退空白状态（最坏情况多显示一次红点）。 */
function loadAlertAcks(): AlertAckState {
  try {
    const raw = window.localStorage.getItem(ALERT_ACK_STORE_KEY)
    return raw === null ? {} : (deserializeAlertAckState(raw) ?? {})
  } catch {
    return {} // 隐私模式等 localStorage 不可用
  }
}

/** 把已读告警写回 localStorage（失败静默：本次运行内仍然生效）。 */
function saveAlertAcks(state: AlertAckState): void {
  try {
    window.localStorage.setItem(ALERT_ACK_STORE_KEY, serializeAlertAckState(state))
  } catch { /* 隐私模式等 localStorage 不可用 */ }
}
