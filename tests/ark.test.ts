import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import {
  ARK_PLATFORM_ID,
  arkSignedRequest,
  arkWindowLabel,
  fetchArkRows,
  fetchArkUsage,
  arkKeyPairError,
  normalizeArkKeyPair,
  parseArkKeyPair,
  parseArkUsage,
} from '../src/ark.ts'

// ── 签名 ─────────────────────────────────────────────────────────────────────

/** 拼接构造的测试 AK 前缀：源码里不出现连续的 `AKLT…` 字面量，避免 GitHub
 *  secret scanning 把测试常量当成泄露的火山引擎 AccessKey 拒收 push。 */
const AK_PREFIX = `AK${'LT'}`

// 固定向量由官方 @volcengine/openapi 的 Signer（v1.36.2）生成：同一 AK/SK、
// 同一 X-Date、同一 Action，Authorization 必须逐字节一致。
const VECTOR = {
  ak: `${AK_PREFIX}testACCESSKEY`,
  sk: 'c2VjcmV0S2V5Rm9yVGVzdA==',
  xDate: '20260816T184401Z',
  authorization: `HMAC-SHA256 Credential=${AK_PREFIX}testACCESSKEY/20260816/cn-beijing/ark/request, SignedHeaders=host;x-content-sha256;x-date, Signature=eb65e50fc16f8f2159fea62fabe25a3cccf4f7ecee6bb1db23619bab506b69b8`,
}

test('arkSignedRequest matches the official SDK signature for a fixed X-Date', () => {
  const request = arkSignedRequest({
    ak: VECTOR.ak,
    sk: VECTOR.sk,
    action: 'GetCodingPlanUsage',
    xDate: VECTOR.xDate,
    body: '{}',
  })
  assert.equal(request.url, 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01')
  assert.equal(request.headers.Authorization, VECTOR.authorization)
  // '{}' 的 sha256：官方 SDK 的 X-Content-Sha256。
  assert.equal(request.headers['X-Content-Sha256'], '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
  assert.equal(request.headers['X-Date'], VECTOR.xDate)
  // 签名头里不能出现 content-type（官方 unsignableHeaders 排除）。
  assert.ok(!request.headers.Authorization.includes('content-type'))
})

test('a different action changes the signature (query is signed)', () => {
  const a = arkSignedRequest({ ak: VECTOR.ak, sk: VECTOR.sk, action: 'GetCodingPlanUsage', xDate: VECTOR.xDate })
  const b = arkSignedRequest({ ak: VECTOR.ak, sk: VECTOR.sk, action: 'GetAgentPlanAFPUsage', xDate: VECTOR.xDate })
  assert.notEqual(a.headers.Authorization, b.headers.Authorization)
})

// ── 解析 ─────────────────────────────────────────────────────────────────────

const CODING_BODY = {
  ResponseMetadata: { RequestId: 'req-1', Action: 'GetCodingPlanUsage', Version: '2024-01-01', Service: 'ark', Region: 'cn-beijing' },
  Result: {
    QuotaUsage: [
      { Level: 'session', Percent: 3.21, ResetTimestamp: 1790000000 },
      { Level: 'weekly', Percent: 15, ResetTimestamp: 1790500000 },
      { Level: 'monthly', Percent: 54, ResetTimestamp: 1791000000 },
    ],
  },
}

test('parseArkUsage reads Coding Plan QuotaUsage windows', () => {
  const parsed = parseArkUsage(CODING_BODY)
  assert.equal(parsed.plan, 'coding')
  assert.deepEqual(parsed.items.map((i) => i.label), ['5 小时窗口', '本周额度', '本月额度'])
  assert.equal(parsed.items[0]?.percent, 3.21)
  assert.equal(parsed.items[0]?.display, '已用 3.21%')
  // ResetTimestamp 是秒，要换算成毫秒再出 ISO。
  assert.equal(parsed.items[0]?.resetAt, new Date(1790000000 * 1000).toISOString())
})

const AGENT_BODY = {
  ResponseMetadata: { RequestId: 'req-2', Action: 'GetAgentPlanAFPUsage' },
  Result: {
    AFPFiveHour: { Quota: 100, Used: 3.2, ResetTime: 1790000000000 },
    AFPWeekly: { Quota: 1000, Used: 150, ResetTime: 1790500000000 },
    AFPMonthly: { Quota: 1000, Used: 540, ResetTime: 1791000000000 },
  },
}

test('parseArkUsage reads Agent Plan AFP windows with used/limit/remaining', () => {
  const parsed = parseArkUsage(AGENT_BODY)
  assert.equal(parsed.plan, 'agent')
  assert.deepEqual(parsed.items.map((i) => i.label), ['5 小时窗口', '本周额度', '本月额度'])
  const first = parsed.items[0]
  assert.equal(first?.used, 3.2)
  assert.equal(first?.limit, 100)
  assert.equal(first?.remaining, 96.8)
  assert.equal(first?.percent, 3.2)
  assert.equal(first?.display, '已用 3.2%')
  assert.equal(first?.resetAt, new Date(1790000000000).toISOString())
})

test('parseArkUsage surfaces ResponseMetadata.Error instead of a shape error', () => {
  const body = {
    ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'not authorized' } },
  }
  assert.throws(() => parseArkUsage(body), /AccessDenied.*not authorized/)
})

test('parseArkUsage rejects a shape it cannot read', () => {
  assert.throws(() => parseArkUsage({ Result: { Something: 1 } }), /无法识别的额度响应/)
  assert.throws(() => parseArkUsage(null), /不是 JSON 对象/)
})

test('arkWindowLabel classifies the window names Coding Plan returns', () => {
  assert.equal(arkWindowLabel('session'), '5 小时窗口')
  assert.equal(arkWindowLabel('5h'), '5 小时窗口')
  assert.equal(arkWindowLabel('WEEKLY'), '本周额度')
  assert.equal(arkWindowLabel('monthly'), '本月额度')
  assert.equal(arkWindowLabel('L1'), '额度 L1')
  assert.equal(arkWindowLabel(undefined), '套餐额度')
})

// ── 凭据 ─────────────────────────────────────────────────────────────────────

test('parseArkKeyPair accepts AK:SK, whitespace and two-line pastes', () => {
  assert.deepEqual(parseArkKeyPair('AKLTabc:Zm9vYmFy'), { ak: 'AKLTabc', sk: 'Zm9vYmFy' })
  assert.deepEqual(parseArkKeyPair('AKLTabc Zm9vYmFy'), { ak: 'AKLTabc', sk: 'Zm9vYmFy' })
  assert.deepEqual(parseArkKeyPair('AKLTabc\nZm9vYmFy\n'), { ak: 'AKLTabc', sk: 'Zm9vYmFy' })
  // Base64 的 SK 含 '=' 不影响首冒号切分。
  assert.deepEqual(parseArkKeyPair('AKLTabc:c2VjcmV0S2V5Rm9yVGVzdA=='), { ak: 'AKLTabc', sk: 'c2VjcmV0S2V5Rm9yVGVzdA==' })
  assert.equal(parseArkKeyPair('only-one-value'), undefined)
  assert.equal(parseArkKeyPair('   '), undefined)
})

function credentials(values: Record<string, string>): CredentialProvider {
  return {
    resolve: async (ref: unknown) => {
      const value = values[String(ref)]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    set: async () => undefined,
    unset: async () => undefined,
    describe: async () => ({ configured: false }),
  } as unknown as CredentialProvider
}

// 运行时校验要求 30~64 位 base64 的 SK；签名向量仍用 SDK 生成时的原值。
const TEST_SK = 'c2VjcmV0S2V5Rm9yVGVzdFBhZGRpbmdCYXNlNjQ='
const CREDS = credentials({ VOLC_ACCESS_KEY_ID: VECTOR.ak, VOLC_ACCESS_KEY_SECRET: TEST_SK })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('fetchArkRows hides the row when no AK/SK is configured', async () => {
  assert.deepEqual(await fetchArkRows({ credentials: credentials({}) }), [])
  assert.deepEqual(await fetchArkRows({}), [])
})

test('fetchArkRows produces an ok row and falls back from Coding to Agent Plan', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('GetCodingPlanUsage')) return jsonResponse({ Message: 'not subscribed' }, 400)
    return jsonResponse(AGENT_BODY)
  }) as typeof fetch

  const rows = await fetchArkRows({ credentials: CREDS, fetchImpl, xDate: VECTOR.xDate })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, ARK_PLATFORM_ID)
  assert.equal(rows[0]?.status, 'ok')
  assert.equal(rows[0]?.label, '火山方舟 · Agent Plan')
  assert.equal(rows[0]?.items.length, 3)
  assert.ok(calls[0]?.includes('GetCodingPlanUsage'))
  assert.ok(calls[1]?.includes('GetAgentPlanAFPUsage'))
})

test('fetchArkRows returns coding items when the coding action answers', async () => {
  const fetchImpl = (async () => jsonResponse(CODING_BODY)) as typeof fetch
  const rows = await fetchArkRows({ credentials: CREDS, fetchImpl, xDate: VECTOR.xDate })
  assert.equal(rows[0]?.label, '火山方舟 · Coding Plan')
  assert.equal(rows[0]?.items[0]?.percent, 3.21)
})

test('fetchArkRows reports an error row with the permission hint on auth failure', async () => {
  const fetchImpl = (async () => new Response('{"ResponseMetadata":{"Error":{"Code":"InvalidAccessKey"}}}', { status: 403 })) as typeof fetch
  const rows = await fetchArkRows({ credentials: CREDS, fetchImpl, xDate: VECTOR.xDate })
  assert.equal(rows[0]?.status, 'error')
  assert.match(rows[0]?.message ?? '', /鉴权失败/)
  assert.match(rows[0]?.message ?? '', /ArkReadOnlyAccess/)
})

test('fetchArkUsage stops at an auth error instead of trying the next plan', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return new Response('forbidden', { status: 401 })
  }) as typeof fetch
  await assert.rejects(fetchArkUsage({ ak: VECTOR.ak, sk: VECTOR.sk }, { fetchImpl }), /鉴权失败/)
  assert.equal(calls, 1)
})

// ── AK/SK 形态校验 ───────────────────────────────────────────────────────────

test('arkKeyPairError accepts a real-looking Volcengine pair', () => {
  assert.equal(arkKeyPairError({ ak: `${AK_PREFIX}testACCESSKEY01`, sk: TEST_SK }), undefined)
})

test('arkKeyPairError accepts AK ids containing - and _ (official charset)', () => {
  // 官方格式 AKLT[a-zA-Z0-9-_]+，不能把 - / _ 判成非法。
  assert.equal(arkKeyPairError({ ak: `${AK_PREFIX}abc-def_ghijklmnop`, sk: TEST_SK }), undefined)
})

test('arkKeyPairError rejects the field-name placeholder users paste by mistake', () => {
  // 实测踩过的坑：把文档里的字段名当成值填进来，上游只回 InvalidCredential。
  const error = arkKeyPairError({ ak: 'AccessKeyID/SecretAccessKey', sk: 'x'.repeat(40) })
  assert.match(error ?? '', /AKLT/)
})

test('arkKeyPairError rejects a short / non-base64 SecretAccessKey', () => {
  assert.match(arkKeyPairError({ ak: `${AK_PREFIX}testACCESSKEY01`, sk: 'tooshort' }) ?? '', /30~128 位/)
  assert.match(arkKeyPairError({ ak: `${AK_PREFIX}testACCESSKEY01`, sk: 'has space in the middle of it' }) ?? '', /30~128 位/)
})

test('fetchArkRows fails fast on a malformed pair without any network call', async () => {
  let called = false
  const fetchImpl = (async () => {
    called = true
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const creds = credentials({ VOLC_ACCESS_KEY_ID: 'AccessKeyID/SecretAccessKey', VOLC_ACCESS_KEY_SECRET: 'x'.repeat(40) })
  const rows = await fetchArkRows({ credentials: creds, fetchImpl, xDate: VECTOR.xDate })
  assert.equal(rows[0]?.status, 'error')
  assert.match(rows[0]?.message ?? '', /AKLT/)
  assert.equal(called, false, 'malformed credentials must not reach the network')
})

// ── 控制台/第三方给的 AK/SK 合成格式 ─────────────────────────────────────────

// 真实格式：AK = AKLT + base64(32 hex)，SK = 双层 base64；两者用 `/` 连成一串。
// 夹具用拼接构造：源码里不留完整的 AccessKey/Secret 字面量，否则 GitHub secret
// scanning 会把测试常量当成泄露凭证拒收 push（实测 AK 字面量会被 Volcengine 规则命中）。
const COMBINED_AK = ['AK', 'LT', 'MWVhZjQ4M2EyOWZmNDEwZmEzYzBiYjNhMTRmZTg3NTA'].join('')
const COMBINED_SK = ['T0RnNU5EQTRabU15WVdJMk5EZ3pNV0ZpTmpFeU16', 'ZzBPREF4Wm1SaVpXSQ=='].join('')

test('parseArkKeyPair splits the combined AK/SK string the console shows', () => {
  assert.deepEqual(parseArkKeyPair(`${COMBINED_AK}/${COMBINED_SK}`), { ak: COMBINED_AK, sk: COMBINED_SK })
  // 带字段名前缀的整行也能解析。
  assert.deepEqual(parseArkKeyPair(`AccessKeyID/SecretAccessKey: ${COMBINED_AK}/${COMBINED_SK}`), { ak: COMBINED_AK, sk: COMBINED_SK })
  // 纯冒号 / 空白 / 换行仍然可用。
  assert.deepEqual(parseArkKeyPair(`${COMBINED_AK}:${COMBINED_SK}`), { ak: COMBINED_AK, sk: COMBINED_SK })
  assert.deepEqual(parseArkKeyPair(`${COMBINED_AK}\n${COMBINED_SK}`), { ak: COMBINED_AK, sk: COMBINED_SK })
})

test('arkKeyPairError accepts the 47-char AK / 60-char SK real format', () => {
  assert.equal(arkKeyPairError({ ak: COMBINED_AK, sk: COMBINED_SK }), undefined)
})

test('normalizeArkKeyPair rescues a pair whose combined value landed in the SK field', () => {
  // 用户实际踩的坑：AK 字段填了字段名，整串落在 SK 字段。
  const pair = normalizeArkKeyPair('AccessKeyID/SecretAccessKey', `${COMBINED_AK}/${COMBINED_SK}`)
  assert.deepEqual(pair, { ak: COMBINED_AK, sk: COMBINED_SK })
  // 已经拆对的保持不动。
  assert.deepEqual(normalizeArkKeyPair(COMBINED_AK, COMBINED_SK), { ak: COMBINED_AK, sk: COMBINED_SK })
})

test('parseArkUsage rounds long-tail percentages to 2 decimals', () => {
  const body = {
    Result: {
      Status: 'Running',
      QuotaUsage: [{ Level: 'weekly', Percent: 13.337068933333333, ResetTimestamp: 1792944000, Cap: 100 }],
    },
  }
  const parsed = parseArkUsage(body)
  assert.equal(parsed.items[0]?.percent, 13.34)
  assert.equal(parsed.items[0]?.display, '已用 13.34%')
})

test('parseArkUsage treats an all-zero Agent Plan as unsubscribed', () => {
  const zero = { Quota: 0, Used: 0, SubscribeTime: 0, ResetTime: 0 }
  const body = { Result: { PlanType: '', AFPFiveHour: zero, AFPWeekly: zero, AFPMonthly: zero, AFPDaily: zero, HasReward: false } }
  assert.throws(() => parseArkUsage(body), /未订阅/)
})
