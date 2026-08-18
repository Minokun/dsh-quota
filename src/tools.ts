/**
 * Agent-facing tool: refresh the multi-platform quota snapshot.
 * @module dsh-quota/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { QuotaControllerFace } from './controller.ts'

export function registerTools(ctx: Context, quota: QuotaControllerFace): void {
  ctx.tools.register(defineTool({
    name: 'quota_refresh',
    description: '刷新并返回所有已配置 AI 平台的额度快照（Kimi Code / DeepSeek / 智谱 Z.AI 通过官方 API 直查，API key 自动取自 DSH 凭证域；智谱 BigModel / 通义千问 / 超算 / TokenRouter / SupaWriter 通过已注册的 MCP 查询）。无参数。',
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
        const v = value as { refreshedAt: string; providers: Array<{ label: string; status: string; message?: string; items: Array<{ label: string; percent?: number; remaining?: number; display?: string }> }> }
        const lines = v.providers.map((p) => {
          const head = `${p.label}: ${p.status}${p.message ? `（${p.message}）` : ''}`
          const rows = p.items.map((i) => {
            const parts = [i.label]
            if (i.percent !== undefined) parts.push(`${i.percent}%`)
            if (i.remaining !== undefined) parts.push(`剩 ${i.remaining}`)
            if (i.display !== undefined) parts.push(i.display)
            return `  - ${parts.join(' | ')}`
          })
          return [head, ...rows].join('\n')
        })
        return [{ type: 'text', text: `各平台额度（刷新于 ${v.refreshedAt}）：\n${lines.join('\n')}` }]
      },
    },
    async execute() {
      const state = await quota.refresh()
      return {
        refreshedAt: state.refreshedAt,
        providers: state.providers.map((p) => ({
          id: p.id,
          label: p.label,
          status: p.status,
          message: p.message,
          via: p.via,
          items: p.items,
        })),
      }
    },
  }))
}
