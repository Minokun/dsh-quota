/**
 * Stylesheet for the quota pill + panel. Consumes the shell's alias tokens
 * with local fallbacks, scoped under .dq- to avoid collisions.
 * @module dsh-quota/client/styles
 */

export const STYLE_TAG_ID = 'dsh-quota/panel'

export const PANEL_CSS = `
.dq-root { position: fixed; right: 16px; bottom: 16px; z-index: 9999; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; font-family: inherit; }
.dq-pill {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
  padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 500;
  background: var(--dsw-alias-bg-layer-2, rgba(20, 20, 28, 0.92)); color: var(--dsw-alias-label-primary, #eee);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  transition: transform 0.12s ease, border-color 0.12s ease;
}
.dq-pill:hover { transform: translateY(-1px); border-color: var(--dsw-alias-brand-primary, #5b6cff); }
.dq-pill .dq-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dq-dot--ok { background: #3ddc84; box-shadow: 0 0 6px rgba(61, 220, 132, 0.7); }
.dq-dot--warn { background: #f5a623; box-shadow: 0 0 6px rgba(245, 166, 35, 0.7); }
.dq-dot--err { background: #e74c3c; box-shadow: 0 0 6px rgba(231, 76, 60, 0.7); }
.dq-dot--idle { background: #888; }
.dq-pill .dq-pill-model {
  font-size: 11px; font-weight: 600; max-width: 150px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding: 1px 8px; border-radius: 999px;
  background: rgba(91, 108, 255, 0.14); color: var(--dsw-alias-brand-primary, #5b6cff);
}

.dq-panel {
  width: 340px; max-height: min(64vh, 600px); overflow-y: auto; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2, rgba(22, 22, 30, 0.97)); color: var(--dsw-alias-label-primary, #eee);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  display: flex; flex-direction: column;
}
.dq-panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2)); position: sticky; top: 0; background: inherit; border-radius: 14px 14px 0 0; }
.dq-panel-title { font-weight: 600; font-size: 14px; flex: 1; }
.dq-btn {
  padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 500; border: none; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15)); color: var(--dsw-alias-label-primary, #eee);
}
.dq-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.25)); }
.dq-btn:disabled { opacity: 0.55; cursor: not-allowed; }
/* Do NOT use --dsw-alias-button-primary-fill here: it is a NEUTRAL token
   (near-black in light mode, near-white in dark mode), so with white text the
   button becomes unreadable in dark mode. A real blue works in both themes. */
.dq-btn--primary { background: var(--dsw-static-blue-500, #3b82f6); color: #fff; }
.dq-btn--primary:hover:not(:disabled) { background: var(--dsw-static-blue-600, #2563eb); }
.dq-btn--ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); }
.dq-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1)); }

.dq-panel-body { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
.dq-provider { border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.dq-provider-head { display: flex; align-items: center; gap: 8px; }
.dq-provider-name { font-weight: 600; font-size: 13px; flex: 1; }
.dq-badge { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.dq-badge--ok { background: rgba(61, 220, 132, 0.16); color: #3ddc84; }
.dq-badge--error { background: rgba(231, 76, 60, 0.14); color: #e74c3c; }
.dq-badge--missing-key { background: rgba(245, 166, 35, 0.14); color: #f5a623; }
.dq-badge--missing-mcp { background: rgba(155, 89, 255, 0.14); color: #9b59ff; }
.dq-badge--api { background: rgba(91, 108, 255, 0.14); color: #5b6cff; }
.dq-badge--mcp { background: rgba(0, 180, 216, 0.14); color: #00b4d8; }
.dq-provider-msg { font-size: 11px; color: var(--dsw-alias-label-secondary, #999); word-break: break-all; }
.dq-provider-key {
  font-size: 10px; color: var(--dsw-alias-label-tertiary, #777);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dq-items { display: flex; flex-direction: column; gap: 5px; }
.dq-item { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.dq-item-label { width: 96px; flex: none; color: var(--dsw-alias-label-secondary, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dq-item-bar { flex: 1; min-width: 40px; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(128, 128, 128, 0.22); }
/* display: block is required — the fill is an empty <span>, so as an inline
   box it collapses to zero width/height and the bar never paints. */
.dq-item-fill { display: block; height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.dq-item-fill--ok { background: linear-gradient(90deg, #3ddc84, #00b4d8); }
.dq-item-fill--warn { background: linear-gradient(90deg, #f5a623, #f7ce46); }
.dq-item-fill--danger { background: linear-gradient(90deg, #e74c3c, #ff7b54); }
.dq-item-value { flex: none; text-align: right; color: var(--dsw-alias-label-secondary, #999); font-variant-numeric: tabular-nums; font-size: 11px; }
.dq-item-reset { width: 100%; font-size: 10px; color: var(--dsw-alias-label-tertiary, #777); text-align: right; margin-top: -3px; }

.dq-keys { border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2)); padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.dq-keys-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #999);
}
.dq-keys-toggle:hover { color: var(--dsw-alias-label-primary, #eee); }
.dq-keys-caret { width: 10px; flex: none; }
.dq-keys-hint { flex: 1; font-size: 10px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #777); text-align: right; }
.dq-keys-note { font-size: 10px; color: var(--dsw-alias-label-tertiary, #777); }
.dq-key-row { display: flex; align-items: center; gap: 6px; }
.dq-key-row label { width: 76px; flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #999); }
.dq-input {
  flex: 1; padding: 6px 8px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); outline: none;
}
.dq-input:focus { border-color: var(--dsw-alias-brand-primary, #5b6cff); }
.dq-foot { font-size: 11px; color: var(--dsw-alias-label-tertiary, #777); text-align: center; padding: 2px 0 4px; }

/* Custom-platform section extras (select + ref label). */
.dq-custom-ref { flex: 1; font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-tertiary, #777); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
select.dq-input { appearance: auto; cursor: pointer; }
`
