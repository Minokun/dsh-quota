/**
 * DSH system configuration, read at runtime.
 *
 * The plugin's source of truth for WHICH platforms exist is the DSH
 * composition (the profile's `cordis.yml` / `cordis.patch.yml` entry tree),
 * not a project-local `.mcp.json` file and not merely "some tool with a
 * matching name happens to be registered". The cordis loader publishes that
 * tree as the `loader` service, so the Host half can ask it which
 * `@deepseek-ai/dsh-mcp-client` entries DSH is actually configured to run.
 *
 * When the loader service is unreachable (older builds), callers fall back to
 * the previous tool-registry probing — this module never throws.
 * @module dsh-quota/dsh-config
 */

/** The module specifier DSH's MCP bridge is declared under in compositions. */
const MCP_CLIENT_SPECIFIER = 'dsh-mcp-client'

/** Structural face of one loader entry (cordis-plugin-loader). */
export interface LoaderEntryLike {
  options?: { name?: unknown; config?: unknown }
  /** Effective disabled state (getter on real entries, plain flag on fixtures). */
  disabled?: unknown
}

/** Structural face of the cordis loader service. */
export interface LoaderLike {
  entries?: () => Iterable<LoaderEntryLike>
}

/** True when this entry mounts an MCP client bridge (accepts versioned/relative specifiers). */
function isMcpClientEntry(entry: LoaderEntryLike): boolean {
  const name = entry.options?.name
  return typeof name === 'string' && name.includes(MCP_CLIENT_SPECIFIER)
}

/** The `serverName` an mcp-client entry declares ('' when malformed). */
function serverNameOf(entry: LoaderEntryLike): string {
  const config = entry.options?.config
  if (config === null || typeof config !== 'object') return ''
  const serverName = (config as { serverName?: unknown }).serverName
  return typeof serverName === 'string' ? serverName.trim() : ''
}

/**
 * Collect the MCP serverNames a set of loader entries declares, skipping
 * disabled entries and non-mcp-client plugins.
 * @param entries - loader entries (any iterable).
 * @returns the configured server names.
 */
export function mcpServersFromEntries(entries: Iterable<LoaderEntryLike>): Set<string> {
  const names = new Set<string>()
  for (const entry of entries) {
    let disabled: unknown
    try {
      disabled = entry.disabled
    } catch {
      disabled = entry.options !== undefined && (entry.options as { disabled?: unknown }).disabled === true
    }
    if (disabled === true) continue
    if (!isMcpClientEntry(entry)) continue
    const name = serverNameOf(entry)
    if (name) names.add(name)
  }
  return names
}

/**
 * MCP serverNames the DSH composition declares, or `undefined` when the
 * loader service is unavailable (caller should then fall back to probing the
 * tool registry).
 * @param ctx - any object exposing cordis' `get(serviceName)`.
 */
export function configuredMcpServers(ctx: { get(name: string): unknown }): Set<string> | undefined {
  try {
    const loader = ctx.get('loader') as LoaderLike | undefined
    if (typeof loader?.entries !== 'function') return undefined
    return mcpServersFromEntries(loader.entries())
  } catch {
    return undefined
  }
}
