/**
 * Panel state store: where the controller's snapshot lives.
 *
 * - 旧版 dsh（≤0.1.5）：settings.register 的命名空间 scope 拥有一切
 *   （base = 组合配置，整体持久化）。
 * - 新版 dsh（≥0.1.6）：组合配置为基底（httpPlatforms 等 volatile 字段读
 *   实时值），运行时快照（refreshedAt/providers/history/…）走内存覆盖层；
 *   面板增删的自定义平台经 settings.update 持久化（只接受 volatile 路径），
 *   成功后从覆盖层移除、改由实时值供读，避免遮蔽其他入口的实时编辑。
 * @module dsh-quota/state-store
 */

import type { Config } from './config.ts'

/** Panel state store consumed by the controller. */
export interface QuotaStateStore {
  get(): Config
  update(patch: Partial<Config>): Promise<void>
}

/** Config fields the panel edits at runtime that must survive a restart. */
export const PERSISTED_KEYS = new Set<keyof Config>(['httpPlatforms'])

/** Structural face of the new (dsh ≥ 0.1.6) settings service. */
export interface SettingsFormsLike {
  describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string; value: unknown }>
  update?: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
}

/** Legacy (dsh ≤ 0.1.5) settings scope face. */
export interface LegacyScopeLike {
  get(): Config
  update(patch: Partial<Config>): Promise<void>
}

export interface StateStoreDeps {
  /** Composition entry config (base layer; volatile fields may be Volatile wrappers). */
  config: Config
  /** Profile entry id of this plugin (the settings.update ns). */
  entryNs: string
  /** Live-read accessors: the settings service arrives after construction. */
  getSettingsForms(): SettingsFormsLike | undefined
  getLegacyScope(): LegacyScopeLike | undefined
  onWarn?(message: string): void
}

/** Unwrap a schemastery Volatile live-config value; plain values pass through. */
export function unwrapVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    try {
      return (value as { get(): unknown }).get()
    } catch { /* fall through to the raw value */ }
  }
  return value
}

/** Build the panel state store (see module doc for the two storage models). */
export function createStateStore(deps: StateStoreDeps): QuotaStateStore {
  let memory: Partial<Config> = {}

  const compositionState = (): Config => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(deps.config as unknown as Record<string, unknown>)) out[key] = unwrapVolatile(value)
    return out as unknown as Config
  }

  return {
    get(): Config {
      const legacy = deps.getLegacyScope()
      if (legacy) return legacy.get()
      return { ...compositionState(), ...memory }
    },
    async update(patch: Partial<Config>): Promise<void> {
      const legacy = deps.getLegacyScope()
      if (legacy) {
        await legacy.update(patch)
        return
      }
      memory = { ...memory, ...patch }
      const persisted: Record<string, unknown> = {}
      for (const key of PERSISTED_KEYS) {
        if (key in patch) persisted[key] = patch[key]
      }
      const forms = deps.getSettingsForms()
      if (Object.keys(persisted).length > 0 && forms?.update) {
        try {
          await forms.update(deps.entryNs, persisted)
          for (const key of Object.keys(persisted)) Reflect.deleteProperty(memory, key)
        } catch (error) {
          deps.onWarn?.(`持久化 ${Object.keys(persisted).join(',')} 失败（本次运行内仍生效）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
