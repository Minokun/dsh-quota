/**
 * Zero-config onboarding candidate detection: identifies DSH model providers
 * pointing to third-party public HTTPS relays (e.g. NewAPI / OneAPI gateways)
 * that are not yet tracked by any built-in quota adapter or custom HTTP card.
 *
 * Pure read-only metadata analysis:
 * - NEVER reads or exposes secret API key values (only `keyRef` names);
 * - NEVER sends unsolicited network requests to third-party relays;
 * - Rejects non-HTTPS / loopback / private-IP routes (e.g. local Ollama) via
 *   `assertPublicHttpsUrl` so users are never invited to add a blocked URL.
 * @module dsh-quota/onboarding
 */

import type { CustomHttpPlatform } from './config.ts'
import { assertPublicHttpsUrl, type DirectAdapter } from './direct.ts'
import { platformForProvider } from './platform-map.ts'

export interface CandidateProviderInput {
  id: string
  label: string
  keyRef?: string
  baseURL?: string
}

export interface CandidatePlatform {
  id: string
  label: string
  /** Normalized HTTPS root / prefix URL with trailing `/v1` stripped. */
  suggestedEndpoint: string
  /** Credential ref name in DSH (never the secret value). */
  keyRef: string
}

/**
 * Convert a model provider `baseURL` (e.g. `https://api.example.com/v1` or
 * `https://gateway.company.com/openai/v1`) into a clean `suggestedEndpoint`
 * validated by `assertPublicHttpsUrl`. Returns `undefined` when non-HTTPS or
 * private/loopback.
 */
export function suggestRelayEndpoint(rawBaseUrl: string): string | undefined {
  const trimmed = rawBaseUrl.trim()
  if (!trimmed) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  parsed.search = ''
  parsed.hash = ''
  // Strip trailing `/v1` or `/v1/...` while keeping business subpath prefixes (e.g. `/openai`).
  const strippedPath = parsed.pathname.replace(/\/v1(?:\/.*)?$/i, '').replace(/\/+$/, '')
  parsed.pathname = strippedPath || '/'
  try {
    return assertPublicHttpsUrl(parsed.toString())
  } catch {
    return undefined
  }
}

/**
 * Compute untracked public-HTTPS DSH model providers eligible for 2-click
 * onboarding as custom quota cards.
 */
export function computeUntrackedCandidates(
  llmProviders: readonly CandidateProviderInput[],
  directAdapters: readonly DirectAdapter[],
  httpPlatforms: readonly CustomHttpPlatform[],
  endpointOverrides: Record<string, string> = {},
): CandidatePlatform[] {
  const builtinRefs = new Set<string>()
  const adapterById = new Map<string, DirectAdapter>()
  for (const a of directAdapters) {
    adapterById.set(a.id, a)
    for (const r of a.keyRefs) builtinRefs.add(r)
    for (const r of a.envKeys) builtinRefs.add(r)
  }

  const trackedRefs = new Set<string>()
  const trackedOrigins = new Set<string>()
  for (const hp of httpPlatforms) {
    if (hp.keyRef) trackedRefs.add(hp.keyRef)
    try {
      trackedOrigins.add(new URL(hp.endpoint).origin)
    } catch { /* ignore */ }
  }

  const out: CandidatePlatform[] = []
  const seenRefs = new Set<string>()

  for (const lp of llmProviders) {
    const id = lp.id.trim()
    const keyRef = lp.keyRef?.trim() ?? ''
    const baseURL = lp.baseURL?.trim() ?? ''
    if (!id || !keyRef || !baseURL) continue
    if (!/^[A-Z][A-Z0-9_]*$/.test(keyRef)) continue
    if (seenRefs.has(keyRef)) continue

    // Skip local Magpie gateway routes (handled by magpie.ts) and Volcengine Ark
    if (id === 'magpie' || id.startsWith('magpie-') || keyRef === 'MAGPIE_GATEWAY_KEY') continue
    if (platformForProvider(id) === 'volcark') continue

    const suggestedEndpoint = suggestRelayEndpoint(baseURL)
    if (!suggestedEndpoint) continue
    const candidateOrigin = new URL(suggestedEndpoint).origin

    // Skip if already tracked in custom httpPlatforms (by ref or origin)
    if (trackedRefs.has(keyRef) || trackedOrigins.has(candidateOrigin)) continue

    // Check whether a built-in DirectAdapter already claims this route:
    // - If keyRef is a built-in ref AND candidateOrigin matches official/overridden origin, it's already a built-in card.
    const mappedPlatform = platformForProvider(id)
    const mappedAdapter = mappedPlatform ? adapterById.get(mappedPlatform) : undefined
    if (mappedAdapter) {
      const allowedOrigins = new Set(mappedAdapter.origins ?? [])
      const ov = endpointOverrides[mappedAdapter.id]
      if (ov) {
        try { allowedOrigins.add(new URL(ov).origin) } catch { /* ignore */ }
      }
      if (allowedOrigins.size === 0 || allowedOrigins.has(candidateOrigin)) {
        continue
      }
    } else if (builtinRefs.has(keyRef)) {
      // Built-in ref used with an unmapped provider pointing to an official origin
      const anyOfficialOriginMatch = directAdapters.some((a) => (a.origins ?? []).includes(candidateOrigin))
      if (anyOfficialOriginMatch) continue
    }

    seenRefs.add(keyRef)
    out.push({
      id,
      label: lp.label.trim() || id,
      suggestedEndpoint,
      keyRef,
    })
  }

  return out
}
