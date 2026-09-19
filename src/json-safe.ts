/**
 * Lossless-JSON sanitizer for tool return values.
 *
 * The harness validates every tool body with a strict lossless-JSON walk: an
 * `undefined` own property, a non-finite number, or `-0` rejects the whole
 * value ("value is not lossless JSON"), because a `JSON.stringify` round trip
 * would silently drop or change it. Optional quota fields (`message`,
 * `remaining`, `resetAt`, …) are naturally `undefined` when the upstream API
 * does not return them, so they must be *omitted* rather than carried as
 * `undefined`.
 *
 * Payloads are expected to be plain JSON records and arrays; a class instance
 * is walked as its own enumerable properties like `JSON.stringify` would.
 * @module dsh-quota/json-safe
 */

/** Whether a value survives a JSON round trip as itself. */
function carriable(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  return true
}

/**
 * Recursively drop what JSON cannot carry without loss: `undefined`,
 * non-finite numbers (`NaN`, `±Infinity`) and `-0`. Object properties are
 * omitted; array entries are dropped (the array stays dense) — the shape the
 * strict check requires.
 * @param value - candidate value (typically a tool return payload).
 * @returns an equal value that survives the harness lossless-JSON check.
 */
export function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) if (carriable(item)) out.push(jsonSafe(item))
    return out as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (!carriable(item)) continue
      out[key] = jsonSafe(item)
    }
    return out as unknown as T
  }
  return carriable(value) ? value : (undefined as unknown as T)
}
