/**
 * Agent-facing tool: refresh the multi-platform quota snapshot.
 *
 * Opt-in since v0.15 (`exposeAgentTool: false` by default) so everyday coding
 * turns pay zero tool-schema context tokens unless the user explicitly enables
 * Agent access (e.g. for scheduled quota checks).
 * @module dsh-quota/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { QuotaControllerFace } from './controller.ts'
import { jsonSafe } from './json-safe.ts'

/** Register `quota_refresh` once and return its disposer. */
export function registerTools(ctx: Context, quota: QuotaControllerFace): () => void {
  const dispose = ctx.tools.register(defineTool({
    name: 'quota_refresh',
    description: '刷新并返回已配置 AI 平台的额度快照（直连官方 API + 已注册 MCP 查询）。无参数。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          refreshedAt: { type: 'string' },
          providers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                status: { type: 'string' },
                message: { type: 'string' },
                via: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      used: { type: 'number' },
                      limit: { type: 'number' },
                      remaining: { type: 'number' },
                      percent: { type: 'number' },
                      resetAt: { type: 'string' },
                      display: { type: 'string' },
                      burnRatePerHour: { type: 'number' },
                      etaMinutes: { type: 'number' },
                      depletesBeforeReset: { type: 'boolean' },
                      weeklySpent: { type: 'number' },
                      spendWindowMs: { type: 'number' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as {
          refreshedAt: string
          providers: Array<{
            label: string
            status: string
            message?: string
            items: Array<{
              label: string
              percent?: number
              remaining?: number
              display?: string
              burnRatePerHour?: number
              etaMinutes?: number
              depletesBeforeReset?: boolean
              weeklySpent?: number
              spendWindowMs?: number
            }>
          }>
        }
        const etaText = (minutes: number): string => {
          if (minutes < 60) return `约 ${String(minutes)} 分钟后耗尽`
          if (minutes < 60 * 24) return `约 ${(minutes / 60).toFixed(1)} 小时后耗尽`
          return `约 ${(minutes / 1440).toFixed(1)} 天后耗尽`
        }
        const lines = v.providers.map((p) => {
          const head = `${p.label}: ${p.status}${p.message ? `（${p.message}）` : ''}`
          const rows = p.items.map((i) => {
            const parts = [i.label]
            if (i.percent !== undefined) parts.push(`${i.percent}%`)
            if (i.remaining !== undefined) parts.push(`剩 ${i.remaining}`)
            if (i.display !== undefined) parts.push(i.display)
            if (i.burnRatePerHour !== undefined) parts.push(`消耗 ${i.burnRatePerHour}/h`)
            if (i.weeklySpent !== undefined) {
              const days = i.spendWindowMs === undefined ? 7 : Math.max(1, Math.round(i.spendWindowMs / 86400000))
              parts.push(days >= 7 ? `近 7 天≈${i.weeklySpent}` : `近 7 天≈${i.weeklySpent}（按 ${days} 天实测折算）`)
            }
            if (i.etaMinutes !== undefined && i.depletesBeforeReset !== false) parts.push(etaText(i.etaMinutes))
            if (i.depletesBeforeReset === true) parts.push('⚠按当前配速将在重置前耗尽')
            return `  - ${parts.join(' | ')}`
          })
          return [head, ...rows].join('\n')
        })
        return [{ type: 'text', text: `各平台额度（刷新于 ${v.refreshedAt}）：\n${lines.join('\n')}` }]
      },
    },
    async execute() {
      const state = await quota.refresh()
      return jsonSafe({
        refreshedAt: state.refreshedAt,
        providers: state.providers.map((p) => ({
          id: p.id,
          label: p.label,
          status: p.status,
          message: p.message,
          via: p.via,
          items: p.items,
        })),
      })
    },
  }))
  return typeof dispose === 'function' ? dispose : () => undefined
}

/**
 * Synchronize `quota_refresh` tool registration with `exposeAgentTool`.
 * Does NOT call `ctx.tools.register` while disabled; dynamically registers or
 * disposes on runtime toggle without restarting DSH.
 */
export function createAgentToolSync(ctx: Context, quota: QuotaControllerFace): { sync(enabled: boolean): void; dispose(): void } {
  let currentDispose: (() => void) | undefined
  const sync = (enabled: boolean): void => {
    if (enabled && currentDispose === undefined) {
      currentDispose = registerTools(ctx, quota)
    } else if (!enabled && currentDispose !== undefined) {
      const off = currentDispose
      currentDispose = undefined
      off()
    }
  }
  return {
    sync,
    dispose: () => {
      if (currentDispose !== undefined) {
        const off = currentDispose
        currentDispose = undefined
        off()
      }
    },
  }
}
