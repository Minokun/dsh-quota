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
import type { QuotaPanelFace, QuotaPanelState } from './controller.ts'

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

/** Platforms with a key entry row (the direct adapters). */
const KEY_PLATFORMS = [
  { id: 'kimi', label: 'Kimi Code' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'zhipu', label: '智谱' },
]

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

/** Short time label for the pill. */
function shortTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
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
              {state.showKeys && KEY_PLATFORMS.map((kp) => {
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
        title="查看各平台会员额度"
      >
        <span className={`dq-dot ${dotClass(state)}`} />
        <span>会员额度</span>
        {state.refreshedAt && <span className="dq-pill-time">{shortTime(state.refreshedAt)}</span>}
      </button>
    </div>
  )
}
