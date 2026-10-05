/**
 * The quota pill + panel, mounted into the frame-wide `shell.overlay` slot:
 * a bottom-right "会员额度" pill that toggles a panel listing every platform's
 * plan quota (direct API-key platforms first, MCP fallback platforms after).
 *
 * API keys sync from DSH automatically — the panel only surfaces which
 * credential ref supplied each platform; manual entry stays available behind
 * a collapsed section for platforms DSH does not know about.
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `shell.overlay` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { platformForProvider, summarizeItems, type PanelItem, type PanelProvider, type QuotaPanelFace, type QuotaPanelState } from './controller.ts'
import { visibleSessionIdOf } from './session-model.ts'
import { translate, type LocaleKey, type TFn } from './locale.ts'

/** Props the renderer binds for the quota panel. */
export type QuotaPanelProps = PropsRuntime<'shell.overlay'> & InjectFace<QuotaPanelFace>

/** localStorage key for the user-dragged pill position. */
const POS_KEY = 'dsh-quota:pill-pos'
/** Pointer travel below this many px still counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 5
/** Viewport margin kept around the pill while dragging/clamping. */
const POS_MARGIN = 4

/**
 * Pill top-left plus its measured size. The size lets both anchor modes
 * (left/top when the panel drops below, right/bottom when it rises above)
 * keep the pill pinned at the exact same spot while dragging.
 */
interface PillPos { x: number; y: number; w: number; h: number }

/** Keep the pill fully inside the viewport. */
function clampPillPos(p: PillPos): PillPos {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    ...p,
    x: Math.min(Math.max(p.x, POS_MARGIN), Math.max(POS_MARGIN, vw - p.w - POS_MARGIN)),
    y: Math.min(Math.max(p.y, POS_MARGIN), Math.max(POS_MARGIN, vh - p.h - POS_MARGIN)),
  }
}

/** Read the stored pill position; a missing/corrupt entry falls back to the default corner. */
function loadPillPos(): PillPos | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<PillPos>
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      return clampPillPos({ x: p.x, y: p.y, w: p.w ?? 160, h: p.h ?? 36 })
    }
  } catch { /* corrupted entry — fall back to the default corner */ }
  return null
}

/** Pill dot color from the provider status set. */
function dotClass(state: QuotaPanelState): string {
  if (state.providers.length === 0) return 'dq-dot--idle'
  if (state.providers.some((p) => p.status === 'ok')) {
    return state.providers.some((p) => p.status !== 'ok') ? 'dq-dot--warn' : 'dq-dot--ok'
  }
  return 'dq-dot--err'
}

function badgeClass(status: string): string {
  switch (status) {
    case 'ok': return 'dq-badge--ok'
    case 'missing-key': return 'dq-badge--missing-key'
    case 'missing-mcp': return 'dq-badge--missing-mcp'
    default: return 'dq-badge--error'
  }
}

/** Human label for a credential source layer. */
function sourceText(source: string | undefined, t: TFn): string {
  switch (source) {
    case 'env': return t('source.env')
    case 'project-env': return t('source.project-env')
    case 'user-env': return t('source.user-env')
    default: return t('source.dsh')
  }
}

/** Bar fill color class from a 0-100 percent. */
function fillClass(percent: number): string {
  if (percent >= 85) return 'dq-item-fill--danger'
  if (percent >= 60) return 'dq-item-fill--warn'
  return 'dq-item-fill--ok'
}

/** Compact reset label, e.g. "8/21 08:23 重置" / "resets 8/21 08:23". */
function resetText(iso: string | undefined, t: TFn): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const time = `${hh}:${mm}`
  return sameDay
    ? t('reset.today', { time })
    : t('reset.day', { date: `${d.getMonth() + 1}/${d.getDate()}`, time })
}

/** Compact ETA label, e.g. "约 45 分钟后耗尽" / "depletes in ~2.3 h". */
function etaText(minutes: number, t: TFn): string {
  if (minutes < 60) return t('eta.minutes', { n: minutes })
  if (minutes < 60 * 24) return t('eta.hours', { n: (minutes / 60).toFixed(1) })
  return t('eta.days', { n: (minutes / 1440).toFixed(1) })
}

/** 红点告警数量：查询失败的平台 + 用量越阈值的条目 + 登录失效提醒。 */
function alertCount(state: QuotaPanelState): number {
  const over = state.providers
    .filter((p) => p.status === 'ok')
    .reduce((n, p) => n + p.items.filter((i) => i.percent !== undefined && i.percent >= state.alertPercent).length, 0)
  const failed = state.providers.filter((p) => p.status === 'error').length
  return over + failed + state.loginAlerts.length
}

/**
 * The badge counts three different things, so spell them out: the panel header
 * and the pill tooltip list one line per counted alert. Without this, "2" sat
 * beside a "7/7 正常" verdict that only reports query health.
 */
function alertDetails(state: QuotaPanelState, t: TFn): string[] {
  const rows: string[] = []
  for (const p of state.providers) {
    if (p.status === 'error') rows.push(t('alert.failed', { label: p.label }))
    for (const i of p.items) {
      if (i.percent !== undefined && i.percent >= state.alertPercent) {
        rows.push(t('alert.usage', { label: p.label, item: i.label, percent: Math.round(i.percent) }))
      }
    }
  }
  for (const a of state.loginAlerts) rows.push(t('alert.login', { label: a.label }))
  return rows
}

/** localStorage key for the floater shape: 药丸 pill / 悬浮环 ring. */
const MODE_KEY = 'dsh-quota:pill-mode'
type FloaterMode = 'pill' | 'ring'

function loadMode(): FloaterMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'ring' ? 'ring' : 'pill'
  } catch { return 'pill' }
}

/** The headline percent item of a provider card (5h/周 window preferred). */
function headlineItem(p: PanelProvider): PanelItem | undefined {
  const withPct = p.items.filter((i) => i.percent !== undefined)
  return withPct.find((i) => /窗口|周/.test(i.label)) ?? withPct[0]
}

/** Ring geometry (SVG viewBox 46×46). */
const RING_R = 19.5
const RING_C = 2 * Math.PI * RING_R
/** Carousel dwell per provider while the ring cycles. */
const RING_CAROUSEL_MS = 4000

/** The pill + panel entry. */
export function QuotaPanel(props: QuotaPanelProps) {
  const state = props.useQuotaPanel((snapshot) => snapshot)
  const t: TFn = (key, params) => translate(state.lang, key, params)
  const busy = state.busy
  const okCount = state.providers.filter((p) => p.status === 'ok').length
  const totalCount = state.providers.length

  // Follow the visible session's model. `useSessions` exposes the session
  // LIST, and the visible session is the row the main view retains
  // (`retainedBy.mainView`) — client runtimes ≤ 0.1.6 also carried a flat
  // `current` id, which 0.1.7 dropped. Reading only `current` (as before) left
  // this null forever on 0.1.7, so the pill froze on the deployment default
  // model — and since a session's model switch also saves that default, it
  // never came back. Falls back to the host default-model summary.
  const currentSessionId = props.useSessions?.(visibleSessionIdOf)
  useEffect(() => {
    props.watchSession(currentSessionId ?? undefined)
  }, [currentSessionId])
  // 先按 apiKeyEnv 精确对应（同平台多号也准），再退回名称模糊匹配。
  const rowFor = (provider: string): PanelProvider | undefined => {
    const ref = state.providerKeyRefs[provider]
    const platformId = platformForProvider(provider)
    return (ref ? state.providers.find((p) => p.keyRef === ref) : undefined)
      ?? state.providers.find((p) => p.id === platformId || p.id.startsWith(`${platformId}#`))
  }
  const sessionSummary = state.sessionModel ? summarizeItems(rowFor(state.sessionModel.provider), state.lang) : ''
  // 默认模型的摘要同样在本地按当前语言拼（host 下发的 summary 文案固定中文）。
  const defaultSummary = summarizeItems(rowFor(state.currentModel.provider), state.lang)
  const summary = sessionSummary || defaultSummary || state.currentModel.summary
  const modelFrom = state.sessionModel
    ? `${t('model.from.session')} ${state.sessionModel.provider}/${state.sessionModel.model}`
    : `${t('model.from.default')} ${state.currentModel.provider}/${state.currentModel.model}`
  // Pill 主文案：当前模型名（会话优先，默认模型兜底，都没有才显示"会员额度"）。
  const modelName = state.sessionModel?.model || state.currentModel.model || ''

  // 红点 = 用量越阈值条目 + 查询失败平台 + 登录失效提醒；面板头部与悬浮球
  // tooltip 都把它拆开讲清楚，避免与「N/N 平台正常」混淆。
  const alerts = alertCount(state)
  const alertLines = alertDetails(state, t)
  const tooltip = summary ? t('pill.title.summary', { from: modelFrom, summary }) : t('pill.title.default')

  // ── 悬浮球形态（药丸/悬浮环）+ 红点告警 ─────────────────────────
  const [mode, setMode] = useState<FloaterMode>(() => (typeof window === 'undefined' ? 'pill' : loadMode()))
  const toggleMode = (): void => {
    const next: FloaterMode = mode === 'pill' ? 'ring' : 'pill'
    setMode(next)
    try { window.localStorage.setItem(MODE_KEY, next) } catch { /* private mode */ }
  }

  // 悬浮环焦点平台：优先跟随当前会话模型对应的卡片；无对应时在 ok 且
  // 有百分比条目的平台间轮播（悬停暂停）。
  const ringCandidates = state.providers.filter((p) => p.status === 'ok' && headlineItem(p) !== undefined)
  const sessionPlatformId = state.sessionModel
    ? (state.providers.find((p) => p.keyRef === state.providerKeyRefs[state.sessionModel!.provider])?.id
      ?? platformForProvider(state.sessionModel.provider))
    : ''
  const sessionIdx = ringCandidates.findIndex((p) => p.id === sessionPlatformId || p.id.startsWith(`${sessionPlatformId}#`))
  const [carouselIdx, setCarouselIdx] = useState(0)
  const [ringHover, setRingHover] = useState(false)
  useEffect(() => {
    if (mode !== 'ring' || ringHover || ringCandidates.length < 2) return
    const t = setInterval(() => { setCarouselIdx((i) => i + 1) }, RING_CAROUSEL_MS)
    return () => clearInterval(t)
  }, [mode, ringHover, ringCandidates.length])
  const ringFocus = ringCandidates[sessionIdx >= 0 ? sessionIdx : carouselIdx % Math.max(1, ringCandidates.length)]
  const ringItem = ringFocus ? headlineItem(ringFocus) : undefined
  const ringPercent = ringItem?.percent // 已用占比
  const ringRemaining = ringPercent !== undefined ? Math.max(0, Math.min(100, 100 - ringPercent)) : undefined

  // ── 可拖拽悬浮球 ────────────────────────────────────────────────
  // pos 为 null 时走 CSS 默认右下角；一旦拖动过就记录小球左上角坐标
  // （localStorage 持久化），之后用内联样式定位。小球在上半屏时面板
  // 向下展开（pill 渲染在最前、left/top 锚定），下半屏时向上展开
  // （pill 渲染在最后、right/bottom 锚定），两种锚定都保证小球不动。
  const [pos, setPos] = useState<PillPos | null>(() => (typeof window === 'undefined' ? null : loadPillPos()))
  const [dragging, setDragging] = useState(false)
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    base: PillPos
    latest: PillPos
    moved: boolean
  } | null>(null)
  /** Drag end still fires a click on the pill — swallow exactly one. */
  const suppressClickRef = useRef(false)

  // Re-measure the pill after mount and on viewport resize, so a stale
  // stored size (model-name length changed) never pushes it off-screen.
  useEffect(() => {
    const measure = (): void => {
      const rect = pillRef.current?.getBoundingClientRect()
      if (!rect) return
      setPos((p) => (p ? clampPillPos({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }) : p))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [])

  const onPillPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const base: PillPos = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, base, latest: base, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPillPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    d.moved = true
    setDragging(true)
    const next = clampPillPos({ ...d.base, x: d.base.x + dx, y: d.base.y + dy })
    d.latest = next
    setPos(next)
  }

  const onPillPointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (d.moved) {
      suppressClickRef.current = true
      try { window.localStorage.setItem(POS_KEY, JSON.stringify(d.latest)) } catch { /* private mode */ }
    }
  }

  // 上半屏 → 面板向下展开（pill 最前 + left/top 锚定）；下半屏（含默认
  // 位置）→ 面板向上展开（pill 最后 + right/bottom 锚定）。
  const flip = pos !== null && pos.y < window.innerHeight / 2
  const rootStyle: CSSProperties | undefined = pos === null
    ? undefined
    : flip
      // flip 模式下必须左对齐：根元素宽度由更宽的面板撑开，右对齐会把
      // 小球推离拖拽落点。
      ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto', alignItems: 'flex-start' }
      : { right: window.innerWidth - pos.x - pos.w, bottom: window.innerHeight - pos.y - pos.h }

  // 贴边微缩：拖到屏幕左右边缘时收成半隐小条（面板展开时不缩）。
  const edge = pos !== null && !state.open
    ? pos.x <= 12 ? 'l' : pos.x + pos.w >= window.innerWidth - 12 ? 'r' : ''
    : ''

  // 点击面板外部自动收起：面板打开时在 document 捕获阶段监听 pointerdown，
  // 目标落在根元素（悬浮球 + 面板 + toast）之外就关闭。悬浮球在根元素内，
  // 其 click 切换逻辑不受影响。
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!state.open) return
    const onDown = (e: PointerEvent): void => {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) props.close()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('pointerdown', onDown, true) }
  }, [state.open])

  // 红点告警 Badge（两种形态共用）。
  const badge = alerts > 0 && <span className="dq-alert">{alerts > 99 ? '99+' : alerts}</span>

  const dragHandlers = {
    onPointerDown: onPillPointerDown,
    onPointerMove: onPillPointerMove,
    onPointerUp: onPillPointerUp,
    onPointerCancel: onPillPointerUp,
    onClick: () => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      props.toggle()
    },
  }

  const pill = (
    <button
      ref={pillRef}
      type="button"
      className={`dq-pill${dragging ? ' dq-pill--dragging' : ''}${edge ? ` dq-floater--edge-${edge}` : ''}`}
      // DOM 顺序固定为最后（面板向上展开）；flip 时用 flex order 把小球
      // 视觉移到最前（面板向下展开），避免跨中线拖拽时 DOM 重挂导致
      // pointer capture 丢失。
      style={flip ? { order: -1 } : undefined}
      {...dragHandlers}
      title={alertLines.length > 0 ? `${tooltip}\n${t('alert.list', { alerts: alertLines.join(' · ') })}` : tooltip}
    >
      <span className={`dq-dot ${dotClass(state)}`} />
      <span className="dq-pill-name">{modelName || t('pill.defaultName')}</span>
      {summary && <span className="dq-pill-model">{summary}</span>}
      {badge}
    </button>
  )

  const ring = (
    <button
      ref={pillRef}
      type="button"
      className={`dq-ring${dragging ? ' dq-pill--dragging' : ''}${edge ? ` dq-floater--edge-${edge}` : ''}`}
      style={flip ? { order: -1 } : undefined}
      {...dragHandlers}
      onPointerEnter={() => { setRingHover(true) }}
      onPointerLeave={() => { setRingHover(false) }}
      title={ringFocus && ringItem
        ? t('ring.title.focus', { label: ringFocus.label, item: ringItem.label, percent: Math.round(ringRemaining ?? 0) })
        : t('pill.title.default')}
    >
      <svg viewBox="0 0 46 46" className="dq-ring-svg" aria-hidden="true">
        <circle className="dq-ring-track" cx="23" cy="23" r={RING_R} />
        {ringRemaining !== undefined && (
          <circle
            className={`dq-ring-arc ${ringPercent !== undefined && ringPercent >= 85 ? 'dq-ring-arc--danger' : ringPercent !== undefined && ringPercent >= 60 ? 'dq-ring-arc--warn' : 'dq-ring-arc--ok'}`}
            cx="23" cy="23" r={RING_R}
            transform="rotate(-90 23 23)"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - ringRemaining / 100)}
          />
        )}
      </svg>
      <span className="dq-ring-text">{ringRemaining !== undefined ? `${String(Math.round(ringRemaining))}%` : '—'}</span>
      {badge}
    </button>
  )

  const floater = mode === 'ring' ? ring : pill

  return (
    <div ref={rootRef} className="dq-root" style={rootStyle}>
      {state.loginAlerts.map((a) => (
        <div key={a.id} className="dq-toast" role="alert">
          <span className="dq-toast-text">{t('toast.loginExpired', { label: a.label })}</span>
          {state.loginPending === a.id
            ? <button type="button" className="dq-btn dq-btn--primary" disabled={busy} onClick={() => { props.loginRetry(a.id) }}>{t('toast.retry')}</button>
            : <button type="button" className="dq-btn dq-btn--primary" onClick={() => { props.loginStart(a.id) }}>{t('toast.login')}</button>}
          <button type="button" className="dq-btn dq-btn--ghost" title={t('toast.dismiss')} onClick={() => { props.dismissLogin(a.id) }}>✕</button>
        </div>
      ))}
      {state.open && (
        <div className="dq-panel">
          <div className="dq-panel-head">
            <span className="dq-panel-title">{t('panel.title')}</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{totalCount > 0 ? t('panel.normalCount', { ok: okCount, total: totalCount }) : ''}</span>
            {alerts > 0 && (
              <span className="dq-panel-alert" title={alertLines.join('\n')}>{t('panel.alerts', { n: alerts })}</span>
            )}
            <button type="button" className="dq-btn dq-btn--ghost" title={mode === 'pill' ? t('mode.toRing') : t('mode.toPill')} onClick={toggleMode}>
              {mode === 'pill' ? '◯' : '▬'}
            </button>
            <button type="button" className="dq-btn dq-btn--primary" disabled={busy} onClick={() => { props.refresh() }}>
              {busy ? t('panel.refreshing') : t('panel.refresh')}
            </button>
            <button type="button" className="dq-btn dq-btn--ghost" onClick={() => { props.close() }}>✕</button>
          </div>
          <div className="dq-panel-body">
            {state.loaded && state.providers.length === 0 && (
              <div className="dq-empty">{t('panel.empty')}</div>
            )}
            {state.providers.map((p) => (
              <div key={p.id} className="dq-provider">
                <div className="dq-provider-head">
                  <span className="dq-provider-name">{p.label}</span>
                  {p.via && <span className={`dq-badge ${p.via === 'api' ? 'dq-badge--api' : 'dq-badge--mcp'}`}>{p.via === 'api' ? 'API' : 'MCP'}</span>}
                  <span className={`dq-badge ${badgeClass(p.status)}`}>{t(`status.${p.status}` as LocaleKey)}</span>
                  <button
                    type="button"
                    className="dq-btn dq-btn--ghost dq-probe"
                    disabled={busy || state.probing === p.id}
                    title={t('probe.title')}
                    onClick={() => { props.probe(p.id) }}
                  >
                    {state.probing === p.id ? '…' : t('probe.run')}
                  </button>
                </div>
                {state.probeResults[p.id] && (
                  <span className={`dq-probe-result ${state.probeResults[p.id]!.ok ? 'dq-probe-result--ok' : 'dq-probe-result--err'}`}>
                    {state.probeResults[p.id]!.ok
                      ? t('probe.ok', { ms: state.probeResults[p.id]!.ms })
                      : t('probe.fail', { message: state.probeResults[p.id]!.message ?? '' })}
                  </span>
                )}
                {p.via === 'api' && p.keyRef && (
                  <span className="dq-provider-key" title={t('provider.syncedTitle', { ref: p.keyRef, source: sourceText(p.keySource, t) })}>
                    {t('provider.synced', { ref: p.keyRef, source: sourceText(p.keySource, t) })}
                  </span>
                )}
                {p.message && <span className="dq-provider-msg">{p.message}</span>}
                {(() => {
                  const loginish = p.status === 'error' && Boolean(p.message) && /未登录|未授权|未认证|401|登录|login|unauthorized/i.test(p.message ?? '')
                  if (!loginish || !state.loginFlows[p.id]) return null
                  return state.loginPending === p.id
                    ? <button type="button" className="dq-btn dq-btn--primary dq-login-btn" disabled={busy} onClick={() => { props.loginRetry(p.id) }}>{t('login.done')}</button>
                    : <button type="button" className="dq-btn dq-login-btn" onClick={() => { props.loginStart(p.id) }}>{t('login.go')}</button>
                })()}
                {p.items.length > 0 && (
                  <div className="dq-items">
                    {p.items.map((item, i) => {
                      const percent = item.percent !== undefined ? Math.max(0, Math.min(100, item.percent)) : undefined
                      const value = item.display ?? (
                        item.used !== undefined || item.limit !== undefined
                          ? `${item.used ?? '?'} / ${item.limit ?? '?'}`
                          : ''
                      )
                      const reset = resetText(item.resetAt, t)
                      return (
                        <div key={`${item.label}-${i}`} className="dq-item">
                          <span className="dq-item-label" title={item.label}>{item.label}</span>
                          {percent !== undefined
                            ? <span className="dq-item-bar"><span className={`dq-item-fill ${fillClass(percent)}`} style={{ width: `${String(percent)}%` }} /></span>
                            : <span className="dq-item-bar" style={{ background: 'transparent' }} />}
                          <span className="dq-item-value">
                            {value}
                            {percent !== undefined && item.remaining !== undefined ? ` ${t('item.remaining', { n: item.remaining })}` : ''}
                          </span>
                          {reset && <span className="dq-item-reset">{reset}</span>}
                          {item.etaMinutes !== undefined && (
                            <span className="dq-item-eta" title={t('eta.title')}>
                              {item.burnRatePerHour !== undefined ? `≈${item.burnRatePerHour}/h · ` : ''}{etaText(item.etaMinutes, t)}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}

            <div className="dq-keys">
              <button type="button" className="dq-keys-toggle" onClick={() => { props.toggleKeys() }}>
                <span className="dq-keys-caret">{state.showKeys ? '▾' : '▸'}</span>
                {t('keys.title')}
                <span className="dq-keys-hint">{t('keys.hint')}</span>
              </button>
              {state.showKeys && (state.keyPlatforms.length > 0 ? state.keyPlatforms : [{ id: 'kimi', label: 'Kimi Code' }, { id: 'deepseek', label: 'DeepSeek' }, { id: 'zhipu', label: '智谱' }]).map((kp) => {
                const keyInfo = state.keys[kp.id]
                const configured = keyInfo?.configured
                const saving = state.savingKey === kp.id
                return (
                  <div key={kp.id} className="dq-key-row">
                    <label title={configured && keyInfo?.ref ? t('keys.configuredTitle', { ref: keyInfo.ref, source: sourceText(keyInfo.source, t) }) : t('keys.unconfiguredTitle')}>
                      {kp.label}
                    </label>
                    <input
                      className="dq-input"
                      type="password"
                      placeholder={configured ? t('keys.overridePlaceholder', { ref: keyInfo?.ref ?? '' }) : 'sk-...'}
                      value={state.drafts[kp.id] ?? ''}
                      onChange={(e) => { props.editKey(kp.id, e.currentTarget.value) }}
                    />
                    {keyInfo?.manual && (
                      <button type="button" className="dq-btn dq-btn--ghost" disabled={saving} title={t('keys.deleteTitle')} onClick={() => { props.removeKey(kp.id) }}>{t('keys.delete')}</button>
                    )}
                    <button
                      type="button"
                      className="dq-btn"
                      disabled={saving || !(state.drafts[kp.id] ?? '').trim()}
                      onClick={() => { props.saveKey(kp.id) }}
                    >
                      {saving ? '…' : t('keys.save')}
                    </button>
                  </div>
                )
              })}
               {state.showKeys && (
                 <span className="dq-keys-note">{t('keys.note')}</span>
               )}
             </div>

             <div className="dq-keys">
               <button type="button" className="dq-keys-toggle" onClick={() => { props.toggleCustom() }}>
                 <span className="dq-keys-caret">{state.showCustom ? '▾' : '▸'}</span>
                 {t('custom.title')}
                 <span className="dq-keys-hint">{t('custom.hint')}</span>
               </button>
               {state.showCustom && (
                 <>
                   {state.customPlatforms.map((cp) => (
                     <div key={cp.id} className="dq-key-row">
                       <label title={`${cp.endpoint} · ${cp.format}`}>{cp.label}</label>
                       <span className="dq-custom-ref">{cp.keyRef}</span>
                       <button type="button" className="dq-btn dq-btn--ghost" disabled={state.savingCustom} onClick={() => { props.removeCustom(cp.id) }}>{t('custom.remove')}</button>
                     </div>
                   ))}
                   <input className="dq-input" placeholder={t('custom.namePlaceholder')} value={state.customDraft.label} onChange={(e) => { props.editCustom('label', e.currentTarget.value) }} />
                   <input className="dq-input" placeholder={t('custom.endpointPlaceholder')} value={state.customDraft.endpoint} onChange={(e) => { props.editCustom('endpoint', e.currentTarget.value) }} />
                   <input className="dq-input" placeholder={t('custom.keyRefPlaceholder')} value={state.customDraft.keyRef} onChange={(e) => { props.editCustom('keyRef', e.currentTarget.value) }} />
                   {state.customDraft.format === 'newapi-account' && (
                     <>
                       <input className="dq-input" inputMode="numeric" placeholder={t('custom.userIdPlaceholder')} value={state.customDraft.userId} onChange={(e) => { props.editCustom('userId', e.currentTarget.value) }} />
                       <input className="dq-input" inputMode="numeric" placeholder={t('custom.quotaPerUnitPlaceholder')} value={state.customDraft.quotaPerUnit} onChange={(e) => { props.editCustom('quotaPerUnit', e.currentTarget.value) }} />
                     </>
                   )}
                   <div className="dq-key-row">
                     <select className="dq-input" value={state.customDraft.format} onChange={(e) => { props.editCustom('format', e.currentTarget.value) }}>
                       {(state.formats.length > 0 ? state.formats : ['openai-billing']).map((f) => <option key={f} value={f}>{f}</option>)}
                     </select>
                     <button
                       type="button"
                       className="dq-btn dq-btn--primary"
                       disabled={state.savingCustom || !state.customDraft.label.trim() || !state.customDraft.endpoint.trim() || !state.customDraft.keyRef.trim() || (state.customDraft.format === 'newapi-account' && (!/^[1-9]\d*$/.test(state.customDraft.userId.trim()) || !(Number(state.customDraft.quotaPerUnit) > 0)))}
                       onClick={() => { props.addCustom() }}
                     >
                       {state.savingCustom ? '…' : t('custom.add')}
                     </button>
                   </div>
                   <span className="dq-keys-note">{t('custom.note')}</span>
                 </>
               )}
             </div>
            {state.formError && <div className="dq-provider-msg" style={{ color: '#e74c3c' }}>{state.formError}</div>}
          </div>
          <div className="dq-foot">
            {state.refreshedAt
              ? t('panel.footer.refreshedAt', { time: new Date(state.refreshedAt).toLocaleString(state.lang === 'zh' ? 'zh-CN' : 'en-US') })
              : t('panel.footer.never')}
          </div>
        </div>
      )}
      {floater}
    </div>
  )
}
