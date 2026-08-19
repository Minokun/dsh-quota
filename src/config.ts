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

/**
 * One platform login flow: when the platform's row fails with a login-ish
 * error (未登录/401/…), the card shows 「去登录」 opening `url`, then offers
 * 重试 which optionally runs `afterLogin` first (e.g. re-sync an MCP server's
 * session cookie from the just-logged-in browser) and then refreshes.
 */
export interface LoginFlow {
  /** Platform id this flow belongs to. */
  id: string
  /** Login page URL. */
  url: string
  /** Open in a CDP-enabled Chrome (debug port) so afterLogin can read cookies. */
  debugChrome?: boolean
  /** Shell command run after the user confirms login, before the refresh. */
  afterLogin?: string
}

/**
 * One user-declared direct-HTTP platform (aggregator, one-api/new-api site,
 * or any provider whose balance endpoint matches a built-in format). Addable
 * from the panel UI or the composition config; persisted in the namespace.
 */
export interface CustomHttpPlatform {
  /** ^[a-z0-9-]+$; collisions with built-in catalog ids are ignored. */
  id: string
  label: string
  /** Balance endpoint URL (https). For openai-billing: the aggregator base URL. */
  endpoint: string
  /** Credential reference (UPPER_SNAKE) holding this platform's API key. */
  keyRef: string
  /** One of direct.FORMATS / CUSTOM_FORMATS. */
  format: string
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
  /** Periodic refresh interval in minutes; 0 disables it (default 5). */
  refreshIntervalMinutes: number
  /** Extra user-declared MCP platforms (default []). */
  mcpPlatforms: CustomMcpPlatform[]
  /** Extra user-declared direct-HTTP platforms (default []). */
  httpPlatforms: CustomHttpPlatform[]
  /** Login flows by platform id (composition-level; overrides built-in URLs). */
  loginFlows: LoginFlow[]
  /** DSH 当前默认模型及其额度摘要（pill 展示；取不到时字段为空）。 */
  currentModel: {
    /** 模型供应商 id，如 kimi-coding。 */
    provider: string
    /** 模型 id，如 k3。 */
    model: string
    /** 匹配到的面板平台 id（未匹配为空）。 */
    platform: string
    /** 一句话额度摘要，如 "周额度 剩68" / "总余额 ¥284.73"。 */
    summary: string
  }
  providers: ProviderSnapshot[]
}

/** Empty current-model summary. */
export const EMPTY_CURRENT_MODEL: Config['currentModel'] = { provider: '', model: '', platform: '', summary: '' }

/** Schema resolving the namespace; defaults double as the composition defaults. */
export const Config: z<Config> = z.object({
  refreshedAt: z.string().default(''),
  refreshing: z.boolean().default(false),
  refreshOnBoot: z.boolean().default(true),
  refreshIntervalMinutes: z.number().default(5),
  mcpPlatforms: z.array(z.object({
    id: z.string(),
    label: z.string(),
    tools: z.array(z.string()),
  })).default([]),
  httpPlatforms: z.array(z.object({
    id: z.string(),
    label: z.string(),
    endpoint: z.string(),
    keyRef: z.string(),
    format: z.string(),
  })).default([]),
  loginFlows: z.array(z.object({
    id: z.string(),
    url: z.string(),
    debugChrome: z.boolean(),
    afterLogin: z.string(),
  })).default([]),
  currentModel: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    platform: z.string().default(''),
    summary: z.string().default(''),
  }).default({ provider: '', model: '', platform: '', summary: '' }),
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
