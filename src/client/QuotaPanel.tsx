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
import { useEffect } from 'react'
import { platformForProvider, summarizeItems, type QuotaPanelFace, type QuotaPanelState } from './controller.ts'

/** Props the renderer binds for the quota panel. */
export type QuotaPanelProps = PropsRuntime<'shell.overlay'> & InjectFace<QuotaPanelFace>

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

const STATUS_TEXT: Record<string, string> = {
  ok: '正常',
  error: '失败',
  'missing-key': '未配 Key',
  'missing-mcp': '无 MCP',
}

/** Human label for a credential source layer. */
function sourceText(source?: string): string {
  switch (source) {
    case 'env': return '环境变量'
    case 'project-env': return '项目 .env'
    case 'user-env': return '用户环境'
    default: return 'DSH 凭证'
  }
}

/** Bar fill color class from a 0-100 percent. */
function fillClass(percent: number): string {
  if (percent >= 85) return 'dq-item-fill--danger'
  if (percent >= 60) return 'dq-item-fill--warn'
  return 'dq-item-fill--ok'
}

/** Compact reset label, e.g. "8/21 08:23 重置". */
function resetText(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const day = sameDay ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`
  return `${day} ${hh}:${mm} 重置`
}

/** The pill + panel entry. */
export function QuotaPanel(props: QuotaPanelProps) {
  const state = props.useQuotaPanel((snapshot) => snapshot)
  const busy = state.busy
  const okCount = state.providers.filter((p) => p.status === 'ok').length
  const totalCount = state.providers.length

  // Follow the visible session's model: the sessions list standard prop
  // reports the current session id; the controller subscribes to that
  // session's model directory. Falls back to the host's default-model summary.
  const currentSessionId = props.useSessions?.((s) => s.current)
  useEffect(() => {
    props.watchSession(currentSessionId ?? undefined)
  }, [currentSessionId])
  // 先按 apiKeyEnv 精确对应（同平台多号也准），再退回名称模糊匹配。
  const sessionSummary = (() => {
    if (!state.sessionModel) return ''
    const ref = state.providerKeyRefs[state.sessionModel.provider]
    const platformId = platformForProvider(state.sessionModel.provider)
    const row = (ref ? state.providers.find((p) => p.keyRef === ref) : undefined)
      ?? state.providers.find((p) => p.id === platformId || p.id.startsWith(`${platformId}#`))
    return summarizeItems(row)
  })()
  const summary = sessionSummary || state.currentModel.summary
  const modelFrom = state.sessionModel
    ? `会话模型 ${state.sessionModel.provider}/${state.sessionModel.model}`
    : `默认模型 ${state.currentModel.provider}/${state.currentModel.model}`
  // Pill 主文案：当前模型名（会话优先，默认模型兜底，都没有才显示"会员额度"）。
  const modelName = state.sessionModel?.model || state.currentModel.model || ''

  return (
    <div className="dq-root">
      {state.open && (
        <div className="dq-panel">
          <div className="dq-panel-head">
            <span className="dq-panel-title">会员额度</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{totalCount > 0 ? `${okCount}/${totalCount} 正常` : ''}</span>
            <button type="button" className="dq-btn dq-btn--primary" disabled={busy} onClick={() => { props.refresh() }}>
              {busy ? '刷新中…' : '刷新'}
            </button>
            <button type="button" className="dq-btn dq-btn--ghost" onClick={() => { props.close() }}>✕</button>
          </div>
          <div className="dq-panel-body">
            {state.loaded && state.providers.length === 0 && (
              <div className="dq-empty">
                还没有可显示的平台——只有能解析到 key 的平台才会出现。在下方「API Key 管理」填入平台 key，或在 DSH 模型设置里配置供应商（key 自动同步）。
              </div>
            )}
            {state.providers.map((p) => (
              <div key={p.id} className="dq-provider">
                <div className="dq-provider-head">
                  <span className="dq-provider-name">{p.label}</span>
                  {p.via && <span className={`dq-badge ${p.via === 'api' ? 'dq-badge--api' : 'dq-badge--mcp'}`}>{p.via === 'api' ? 'API' : 'MCP'}</span>}
                  <span className={`dq-badge ${badgeClass(p.status)}`}>{STATUS_TEXT[p.status] ?? p.status}</span>
                </div>
                {p.via === 'api' && p.keyRef && (
                  <span className="dq-provider-key" title={`凭证引用 ${p.keyRef}（${sourceText(p.keySource)}）`}>
                    ⇄ 已同步 {p.keyRef} · {sourceText(p.keySource)}
                  </span>
                )}
                {p.message && <span className="dq-provider-msg">{p.message}</span>}
                {(() => {
                  const loginish = p.status === 'error' && Boolean(p.message) && /未登录|未授权|未认证|401|登录|login|unauthorized/i.test(p.message ?? '')
                  if (!loginish || !state.loginFlows[p.id]) return null
                  return state.loginPending === p.id
                    ? <button type="button" className="dq-btn dq-btn--primary dq-login-btn" disabled={busy} onClick={() => { props.loginRetry(p.id) }}>我已完成登录，重试</button>
                    : <button type="button" className="dq-btn dq-login-btn" onClick={() => { props.loginStart(p.id) }}>去登录 ↗</button>
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
                      const reset = resetText(item.resetAt)
                      return (
                        <div key={`${item.label}-${i}`} className="dq-item">
                          <span className="dq-item-label" title={item.label}>{item.label}</span>
                          {percent !== undefined
                            ? <span className="dq-item-bar"><span className={`dq-item-fill ${fillClass(percent)}`} style={{ width: `${String(percent)}%` }} /></span>
                            : <span className="dq-item-bar" style={{ background: 'transparent' }} />}
                          <span className="dq-item-value">
                            {value}
                            {percent !== undefined && item.remaining !== undefined ? ` 剩${item.remaining}` : ''}
                          </span>
                          {reset && <span className="dq-item-reset">{reset}</span>}
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
                API Key 管理
                <span className="dq-keys-hint">DSH 已添加的 key 会自动同步，一般无需手动填写</span>
              </button>
              {state.showKeys && (state.keyPlatforms.length > 0 ? state.keyPlatforms : [{ id: 'kimi', label: 'Kimi Code' }, { id: 'deepseek', label: 'DeepSeek' }, { id: 'zhipu', label: '智谱' }]).map((kp) => {
                const keyInfo = state.keys[kp.id]
                const configured = keyInfo?.configured
                const saving = state.savingKey === kp.id
                return (
                  <div key={kp.id} className="dq-key-row">
                    <label title={configured && keyInfo?.ref ? `当前：${keyInfo.ref}（${sourceText(keyInfo.source)}）` : '未配置'}>
                      {kp.label}
                    </label>
                    <input
                      className="dq-input"
                      type="password"
                      placeholder={configured ? `${keyInfo?.ref ?? '已配置'}，输入可覆盖` : 'sk-...'}
                      value={state.drafts[kp.id] ?? ''}
                      onChange={(e) => { props.editKey(kp.id, e.currentTarget.value) }}
                    />
                    {keyInfo?.manual && (
                      <button type="button" className="dq-btn dq-btn--ghost" disabled={saving} title="删除面板手动保存的 key" onClick={() => { props.removeKey(kp.id) }}>删</button>
                    )}
                    <button
                      type="button"
                      className="dq-btn"
                      disabled={saving || !(state.drafts[kp.id] ?? '').trim()}
                      onClick={() => { props.saveKey(kp.id) }}
                    >
                      {saving ? '…' : '存'}
                    </button>
                  </div>
                )
              })}
               {state.showKeys && (
                 <span className="dq-keys-note">手动保存的 key 存于 DSH 凭证域的插件私有引用，删除不影响 DSH 模型配置。</span>
               )}
             </div>

             <div className="dq-keys">
               <button type="button" className="dq-keys-toggle" onClick={() => { props.toggleCustom() }}>
                 <span className="dq-keys-caret">{state.showCustom ? '▾' : '▸'}</span>
                 自定义平台
                 <span className="dq-keys-hint">聚合站 / one-api / new-api，接口匹配内置格式即可</span>
               </button>
               {state.showCustom && (
                 <>
                   {state.customPlatforms.map((cp) => (
                     <div key={cp.id} className="dq-key-row">
                       <label title={`${cp.endpoint} · ${cp.format}`}>{cp.label}</label>
                       <span className="dq-custom-ref">{cp.keyRef}</span>
                       <button type="button" className="dq-btn dq-btn--ghost" disabled={state.savingCustom} onClick={() => { props.removeCustom(cp.id) }}>删</button>
                     </div>
                   ))}
                   <input className="dq-input" placeholder="名称（如 我的聚合站）" value={state.customDraft.label} onChange={(e) => { props.editCustom('label', e.currentTarget.value) }} />
                   <input className="dq-input" placeholder="接口地址（https://…，openai-billing 填站点根地址）" value={state.customDraft.endpoint} onChange={(e) => { props.editCustom('endpoint', e.currentTarget.value) }} />
                   <input className="dq-input" placeholder="凭证引用（如 MY_SITE_API_KEY，先存入 DSH 凭证）" value={state.customDraft.keyRef} onChange={(e) => { props.editCustom('keyRef', e.currentTarget.value) }} />
                   <div className="dq-key-row">
                     <select className="dq-input" value={state.customDraft.format} onChange={(e) => { props.editCustom('format', e.currentTarget.value) }}>
                       {(state.formats.length > 0 ? state.formats : ['openai-billing']).map((f) => <option key={f} value={f}>{f}</option>)}
                     </select>
                     <button
                       type="button"
                       className="dq-btn dq-btn--primary"
                       disabled={state.savingCustom || !state.customDraft.label.trim() || !state.customDraft.endpoint.trim() || !state.customDraft.keyRef.trim()}
                       onClick={() => { props.addCustom() }}
                     >
                       {state.savingCustom ? '…' : '添加'}
                     </button>
                   </div>
                   <span className="dq-keys-note">key 先写进 DSH 凭证域（如 MY_SITE_API_KEY），这里只填引用名；格式选接口响应对应的解析器。</span>
                 </>
               )}
             </div>
            {state.formError && <div className="dq-provider-msg" style={{ color: '#e74c3c' }}>{state.formError}</div>}
          </div>
          <div className="dq-foot">
            {state.refreshedAt ? `刷新于 ${new Date(state.refreshedAt).toLocaleString('zh-CN')}` : '尚未刷新'}
          </div>
        </div>
      )}
      <button
        type="button"
        className="dq-pill"
        onClick={() => { props.toggle() }}
        title={summary
          ? `${modelFrom}：${summary}`
          : '查看各平台会员额度'}
      >
        <span className={`dq-dot ${dotClass(state)}`} />
        <span className="dq-pill-name">{modelName || '会员额度'}</span>
        {summary && <span className="dq-pill-model">{summary}</span>}
      </button>
    </div>
  )
}
