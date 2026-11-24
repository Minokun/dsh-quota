import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CATALOG_EXTRA,
  DIRECT_ADAPTERS,
  FORMATS,
  resolveAdapterUrl,
} from '../src/direct.ts'
import { computeUntrackedCandidates, suggestRelayEndpoint } from '../src/onboarding.ts'
import { platformRefHints } from '../src/controller.ts'

test('suggestRelayEndpoint strips /v1 suffix, preserves subpath prefix, and blocks HTTP/loopback/private IPs', () => {
  assert.equal(suggestRelayEndpoint('https://api.example.com/v1'), 'https://api.example.com/')
  assert.equal(suggestRelayEndpoint('https://gateway.company.com/openai/v1/chat/completions'), 'https://gateway.company.com/openai')

  // Local Ollama / loopback / private IP / non-HTTPS MUST be rejected
  assert.equal(suggestRelayEndpoint('http://127.0.0.1:11434/v1'), undefined)
  assert.equal(suggestRelayEndpoint('https://127.0.0.1:8443/v1'), undefined)
  assert.equal(suggestRelayEndpoint('https://192.168.1.10/v1'), undefined)
  assert.equal(suggestRelayEndpoint('https://localhost:3000/v1'), undefined)
})

test('computeUntrackedCandidates surfaces public HTTPS third-party relays without leaking secrets and ignores Ollama/official/tracked', () => {
  const allDirect = [...DIRECT_ADAPTERS, ...CATALOG_EXTRA]
  const candidates = computeUntrackedCandidates(
    [
      // Official DeepSeek -> already claimed by built-in adapter
      { id: 'deepseek-official', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', keyRef: 'DEEPSEEK_API_KEY' },
      // Local Ollama -> blocked by public HTTPS rule
      { id: 'ollama', label: 'Local Ollama', baseURL: 'http://127.0.0.1:11434/v1', keyRef: 'OLLAMA_KEY' },
      // Untracked third-party NewAPI relay -> SHOULD surface!
      { id: 'my-newapi', label: 'My NewAPI Relay', baseURL: 'https://api.example.com/v1', keyRef: 'MY_NEWAPI_KEY' },
      // Already added custom platform -> skipped
      { id: 'tracked-relay', label: 'Tracked', baseURL: 'https://tracked.example.com/v1', keyRef: 'TRACKED_KEY' },
    ],
    allDirect,
    [{
      id: 'tracked',
      label: 'Tracked',
      endpoint: 'https://tracked.example.com/',
      keyRef: 'TRACKED_KEY',
      format: 'openai-billing',
    }],
  )

  assert.deepEqual(candidates, [{
    id: 'my-newapi',
    label: 'My NewAPI Relay',
    suggestedEndpoint: 'https://api.example.com/',
    keyRef: 'MY_NEWAPI_KEY',
  }])
  assert.equal(JSON.stringify(candidates).includes('sk-'), false)
})

test('every built-in DirectAdapter declares verification ("verified" | "community") and verified formats parse real fixtures', () => {
  const allBuiltin = [...DIRECT_ADAPTERS, ...CATALOG_EXTRA]
  assert.ok(allBuiltin.length >= 18)
  for (const adapter of allBuiltin) {
    assert.ok(
      adapter.verification === 'verified' || adapter.verification === 'community',
      `Adapter ${adapter.id} missing verification tier`,
    )
    assert.ok(adapter.defaultEndpoint && adapter.defaultEndpoint.startsWith('https://'), `Adapter ${adapter.id} missing defaultEndpoint`)
  }

  // Exercise fixture parsers for verified formats to ensure 100% fixture coverage
  const kimiItems = FORMATS['kimi-coding']!({
    usage: { used: 25, limit: 100, remaining: 75, resetTime: '2026-11-26T00:00:00Z' },
    limits: [{ detail: { used: 10, limit: 50, remaining: 40, resetTime: '2026-11-25T08:00:00Z' }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }],
  })
  assert.ok(kimiItems.length >= 2)

  const dsItems = FORMATS['deepseek-balance']!({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '128.50', granted_balance: '0.00', topped_up_balance: '128.50' }],
  })
  assert.equal(dsItems[0]?.remaining, 128.5)

  const orItems = FORMATS['openrouter-credits']!({ data: { total_credits: 50, total_usage: 12.5 } })
  assert.equal(orItems[0]?.remaining, 37.5)

  const sfItems = FORMATS['siliconflow-balance']!({ data: { totalBalance: '88.20', balance: '68.20', chargeBalance: '20.00' } })
  assert.ok(sfItems.length >= 1)

  const msItems = FORMATS['moonshot-balance']!({ data: { total_balance: 42.6, available_balance: 42.6 } })
  assert.equal(msItems[0]?.remaining, 42.6)

  const xaiItems = FORMATS['xai-credits']!({ total: { val: -7240 } })
  assert.equal(xaiItems[0]?.remaining, 72.4)

  const ocItems = FORMATS['opencode-usage']!({
    usage: {
      rolling: { percent: 15, resetsAt: '2026-11-25T06:00:00Z' },
      weekly: { percent: 45, resetsAt: '2026-11-30T00:00:00Z' },
      monthly: { percent: 60, resetsAt: '2026-12-01T00:00:00Z' },
    },
  })
  assert.equal(ocItems.length, 3)
})

test('resolveAdapterUrl supports origin & full-path overrides, enforces strict no-redirect, and blocks all SSRF vectors', async () => {
  // No override -> strict: false
  assert.deepEqual(
    resolveAdapterUrl('https://api.siliconflow.com/v1/user/info', undefined),
    { url: 'https://api.siliconflow.com/v1/user/info', strict: false },
  )

  // Origin-only override -> preserves pathname & query, upgrades strict: true
  assert.deepEqual(
    resolveAdapterUrl('https://api.openai.com/v1/organization/costs?bucket_width=1d', 'https://openai-mirror.example.com'),
    { url: 'https://openai-mirror.example.com/v1/organization/costs?bucket_width=1d', strict: true },
  )

  // Full-path override -> replaces path, upgrades strict: true
  assert.deepEqual(
    resolveAdapterUrl('https://api.siliconflow.com/v1/user/info', 'https://api-mirror.example.com/custom/user/info'),
    { url: 'https://api-mirror.example.com/custom/user/info', strict: true },
  )

  // SSRF vectors MUST be rejected
  for (const bad of [
    'http://api-mirror.example.com/v1/user/info',
    'https://127.0.0.1/v1/user/info',
    'https://192.168.1.1/v1/user/info',
    'https://10.0.0.1/v1/user/info',
    'https://[::1]/v1/user/info',
    'https://localhost/v1/user/info',
    'https://user:pass@api-mirror.example.com/v1/user/info',
    'https://api-mirror.example.com/v1/user/info?token=secret',
  ]) {
    assert.throws(() => resolveAdapterUrl('https://api.siliconflow.com/v1/user/info', bad))
  }

  // Verify adapter.fetch actually sends redirect: 'error' when endpointOverride is set
  const sfAdapter = CATALOG_EXTRA.find((a) => a.id === 'siliconflow')!
  const prevFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedRedirect: RequestRedirect | undefined
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedRedirect = init?.redirect
    return new Response(JSON.stringify({ data: { balance: '66.00' } }), { status: 200 })
  }) as typeof fetch
  try {
    const snap = await sfAdapter.fetch('sk-test', undefined, {
      endpointOverride: 'https://api-mirror.example.com/v1/user/info',
    })
    assert.equal(snap.status, 'ok')
    assert.equal(capturedUrl, 'https://api-mirror.example.com/v1/user/info')
    assert.equal(capturedRedirect, 'error')
  } finally {
    globalThis.fetch = prevFetch
  }

  // Verify platformRefHints syncs overridden origin so mirror DSH provider routes share credentials
  const hints = platformRefHints(
    sfAdapter,
    [{ id: 'siliconflow-mirror', label: 'SF Mirror', baseURL: 'https://api-mirror.example.com/v1', keyRef: 'SF_MIRROR_KEY' }],
    { siliconflow: 'https://api-mirror.example.com' },
  )
  assert.deepEqual(hints, [{ ref: 'SF_MIRROR_KEY', provider: 'siliconflow-mirror' }])
})
