/**
 * Plugin configuration and the `quota` settings namespace: the last quota
 * snapshot the panel renders. API keys never live here — they are addressed
 * through the DSH credentials domain (preferred) or process environment.
 * @module dsh-quota/config
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace shared by the Host half and the browser panel. */
export const QUOTA_NS = 'quota'

/**
 * Plugin-private credential references — the refs a manual save in the panel
 * writes to (and remove deletes). Resolution in controller.ts tries DSH's own
 * shared refs first (the `apiKeyEnv` names model providers declare, e.g.
 * KIMI_CODING_API_KEY) and only falls back to these private refs, so a key
 * added in DSH syncs here automatically while deleting a panel-saved key can
 * never break DSH model routing.
 */
export const KEY_REFS = {
  kimi: 'KIMI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
} as const

/** One line of quota numbers shown in the panel. */
export interface QuotaItem {
  /** Human label, e.g. "周额度" / "余额" / "RPM". */
  label: string
  used?: number
  limit?: number
  remaining?: number
  /** used / limit, 0-100. */
  percent?: number
  /** ISO timestamp of the window reset. */
  resetAt?: string
  /** Free-form display string (money, tokens, raw counts). */
  display?: string
}

/** How the snapshot was obtained. */
export type ProviderVia = 'api' | 'mcp'

/** One user-declared MCP platform: quota tools registered elsewhere in DSH. */
export interface CustomMcpPlatform {
  /** Unique id; ids colliding with built-in platforms are ignored. */
  id: string
  label: string
  /** MCP tool names called in order (e.g. "mcp__mysite__my_quota"). */
  tools: string[]
}

/** One platform row in the panel. */
export interface ProviderSnapshot {
  id: string
  label: string
  /** ok | error | missing-key | missing-mcp */
  status: 'ok' | 'error' | 'missing-key' | 'missing-mcp'
  /** Human-readable failure detail. */
  message?: string
  via?: ProviderVia
  /** Credential ref that supplied the key (direct platforms, never the value). */
  keyRef?: string
  /** Source layer of the resolved key (env / file / project-env / user-env). */
  keySource?: string
  items: QuotaItem[]
}

/** The whole panel state. */
export interface Config {
  /** ISO timestamp of the last refresh attempt (successful or not). */
  refreshedAt: string
  /** True while a refresh round trip is in flight. */
  refreshing: boolean
  /** Refresh once shortly after boot (default true). */
  refreshOnBoot: boolean
  /** Periodic refresh interval in minutes; 0 disables it (default 0). */
  refreshIntervalMinutes: number
  /** Extra user-declared MCP platforms (default []). */
  mcpPlatforms: CustomMcpPlatform[]
  providers: ProviderSnapshot[]
}

/** Schema resolving the namespace; defaults double as the composition defaults. */
export const Config: z<Config> = z.object({
  refreshedAt: z.string().default(''),
  refreshing: z.boolean().default(false),
  refreshOnBoot: z.boolean().default(true),
  refreshIntervalMinutes: z.number().default(0),
  mcpPlatforms: z.array(z.object({
    id: z.string(),
    label: z.string(),
    tools: z.array(z.string()),
  })).default([]),
  providers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.union(['ok', 'error', 'missing-key', 'missing-mcp'] as const).default('error'),
    message: z.string(),
    via: z.union(['api', 'mcp'] as const),
    keyRef: z.string(),
    keySource: z.string(),
    items: z.array(z.object({
      label: z.string(),
      used: z.number(),
      limit: z.number(),
      remaining: z.number(),
      percent: z.number(),
      resetAt: z.string(),
      display: z.string(),
    })).default([]),
  })).default([]),
}) as z<Config>
