/**
 * Ambient 1-line quota & session spend bar mounted into `conversation.composer.dock`.
 *
 * Shares the singleton `QuotaPanelController` with `QuotaPanel` (zero duplicate
 * polling). Registers its mount lifecycle with the controller so `dock-only`
 * mode knows when a conversation dock is actually on screen and automatically
 * falls back to the floating pill on Settings/non-chat pages.
 * @module dsh-quota/client/QuotaDockBar
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import type { QuotaPanelFace } from './controller.ts'
import { providerRowOf } from './panel-order.ts'
import { alertCount } from './alerts.ts'
import { sessionTokenUsageOf, visibleSessionCwdOf, visibleSessionIdOf } from './session-model.ts'
import { deriveSessionSpendView } from './session-card.ts'
import { cardSpeedsOf } from './speed-line.ts'
import { buildDockSummary, resolveEntryVisibility } from './dock-logic.ts'
import { translate, type TFn } from './locale.ts'

export type QuotaDockBarProps = PropsRuntime<'conversation.composer.dock'> & InjectFace<QuotaPanelFace>

export function QuotaDockBar(props: QuotaDockBarProps) {
  const state = props.useQuotaPanel((s) => s)
  const t: TFn = (key, params) => translate(state.lang, key, params)

  // Track mounted dock instances so `dock-only` hides the overlay pill ONLY while
  // at least one dock bar is actually visible on screen.
  useEffect(() => props.mountDock(), [])

  const sessionFromProp = typeof props.sessionId === 'string' && props.sessionId ? props.sessionId : undefined
  const currentSessionId = sessionFromProp ?? props.useSessions?.(visibleSessionIdOf)
  const currentSessionCwd = props.useSessions?.(visibleSessionCwdOf)
  const tokenUsage = props.useSessions?.(sessionTokenUsageOf)

  useEffect(() => {
    if (currentSessionId) props.watchSession(currentSessionId)
  }, [currentSessionId])

  const { showDock } = resolveEntryVisibility(state.displayMode, state.dockMountCount)
  if (!showDock) return null

  const activeProvider = state.sessionModel?.provider ?? state.currentModel.provider
  const activeModel = state.sessionModel?.model ?? state.currentModel.model
  const matchedProvider = providerRowOf(state.providers, activeProvider, state.providerKeyRefs, activeModel)

  const isSubscriptionPlan = Boolean(
    matchedProvider
    && matchedProvider.status === 'ok'
    && matchedProvider.items.some((i) => i.percent !== undefined)
    && !matchedProvider.items.some((i) => /余额|balance/i.test(i.label)),
  )

  const spendView = deriveSessionSpendView({
    sessionId: currentSessionId,
    sessionCwd: currentSessionCwd ?? undefined,
    activeProvider,
    activeModel,
    tokenUsage,
    ledger: state.ledger,
    isSubscriptionPlan,
    t,
  })

  const activeModelId = activeProvider && activeModel ? `${activeProvider}/${activeModel}` : undefined
  const speeds = matchedProvider
    ? cardSpeedsOf([matchedProvider], state.speed ?? [], state.providerKeyRefs, activeModelId)
    : {}
  const speedHeadline = matchedProvider ? speeds[matchedProvider.id]?.headline : undefined

  const alerts = alertCount(state)
  const dock = buildDockSummary({
    provider: matchedProvider,
    fallbackModelName: activeModel,
    shortCostText: spendView.shortCostText,
    rollupLine: spendView.rollupLine,
    speedHeadline,
    alertPercent: state.alertPercent,
    totalAlerts: alerts,
    lang: state.lang,
  })

  const onClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    if (e.altKey) {
      e.preventDefault()
      props.refresh()
      return
    }
    props.toggle()
  }

  return (
    <button
      type="button"
      data-dsh-quota-trigger="dock"
      className={`dq-dock${state.open ? ' dq-dock--open' : ''}${state.busy ? ' dq-dock--busy' : ''}`}
      title={dock.tooltip}
      onClick={onClick}
    >
      <span className={`dq-dock-dot dq-dot--${dock.dotTone}`} aria-hidden="true" />
      <span className="dq-dock-primary">{dock.primaryText}</span>
      {dock.paceWarn && <span className="dq-dock-pace" aria-hidden="true">⚠</span>}
      {dock.costText && (
        <>
          <span className="dq-dock-sep" aria-hidden="true">·</span>
          <span className="dq-dock-cost">{dock.costText}</span>
        </>
      )}
      {dock.badgeCount > 0 && (
        <span className="dq-dock-alert">{dock.badgeCount > 99 ? '99+' : dock.badgeCount}</span>
      )}
    </button>
  )
}
