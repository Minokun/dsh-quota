/**
 * DeepSeek 的**账号登录**钱包：与 API key 钱包是两个不同的东西。
 *
 * DSH 里 DeepSeek 有两条并存的路由：
 *   - `deepseek-official` —— API key（`DEEPSEEK_API_KEY`），查
 *     `https://api.deepseek.com/user/balance`，Bearer key；
 *   - `deepseek-account` —— 登录态账号，请求带 `x-dsh-auth-token`，查
 *     `https://platform.deepseek.com/api/v0/users/get_user_summary`。
 *
 * 一个 DeepSeek 账号 = 一个钱包；同一个账号下所有 key 看到的余额相同，
 * 但**别人的 key 看到的是别人账号的钱包**。所以「当前模型走账号路由」时
 * 拿 `DEEPSEEK_API_KEY` 去查余额，答案是另一个账号的数字——这正是面板把
 * 别人 key 的 ¥0.00 当成「我的余额」显示的原因。
 *
 * 这个模块只负责把账号登录态读出来并解析成面板条目；卡片行本身由
 * controller 装配（标签、重试、失败态与 API-key 行走同一套逻辑）。
 * 纯函数与网络分离，便于单测。
 * @module dsh-quota/deepseek-account
 */

import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { QuotaItem } from './config.ts'
import { cny, getJson } from './direct.ts'
import { DEEPSEEK_ACCOUNT_LABEL, DEEPSEEK_ACCOUNT_REF } from './platform-map.ts'

export { DEEPSEEK_ACCOUNT_LABEL, DEEPSEEK_ACCOUNT_REF }

/**
 * 账号钱包查询端点（与 DSH 账号页读余额用的是同一个）。
 */
export const DEEPSEEK_ACCOUNT_ENDPOINT = 'https://platform.deepseek.com/api/v0/users/get_user_summary'

/**
 * 账号登录态在凭证域里的地址：DSH 的 `@deepseek-ai/dsh-deepseek-account`
 * 把捕获到的 grant 写在这里（`{kind:'grant', payload:{token,…}}`）。
 * 只读、永不写回——登录/登出始终归账号插件管。
 */
const ACCOUNT_RECORD = credentialKey('deepseek-account-platform', 'default')

/** 单个钱包在面板里的 `remaining`（元），用于余额 ETA / 近 7 天消耗。 */
export interface AccountWallet {
  currency: string
  total: number
  bonus: number
}

/**
 * Read the signed-in DeepSeek account's grant token.
 *
 * 读不到就是「没登录」，是常态而非错误：账号插件没装、用户没登录、
 * 或者记录形状不是 grant，一律返回 undefined，调用方据此整行隐藏。
 * @param credentials - DSH 凭证服务（不可用时不报错）。
 * @returns 账号 token，或未登录时的 undefined。
 */
export async function readDeepSeekAccountToken(credentials: CredentialProvider | undefined): Promise<string | undefined> {
  if (!credentials) return undefined
  try {
    const record = await credentials.readRecord(ACCOUNT_RECORD)
    if (record === undefined || record.kind !== 'grant') return undefined
    const payload = record.payload as { token?: unknown } | undefined
    const token = typeof payload?.token === 'string' ? payload.token.trim() : ''
    return token === '' ? undefined : token
  } catch {
    // 账本损坏/不可读与「未登录」等价：面板不该因此整轮刷新失败。
    return undefined
  }
}

/** Wallet rows from a platform summary, or throws when the envelope is not one. */
/**
 * Project the platform summary envelope onto panel wallets.
 *
 * 响应形如 `{code:0,data:{biz_code:0,biz_data:{normal_wallets:[…],bonus_wallets:[…]}}}`，
 * 其中 `balance` 是字符串金额。`normal_wallets` 是充值余额、`bonus_wallets`
 * 是赠金，可花的是两者之和。
 * @param body - 平台响应。
 * @returns 每个币种一个钱包；响应不像该信封时抛错（绝不编造 0 元）。
 */
export function parseDeepSeekAccountWallets(body: unknown): AccountWallet[] {
  const envelope = body as { code?: unknown; data?: { biz_code?: unknown; biz_data?: unknown } } | undefined
  if (envelope?.code !== 0) throw new Error('账号响应失败（code≠0）')
  if (envelope.data?.biz_code !== 0) throw new Error('账号响应业务码异常（biz_code≠0）')
  const biz = envelope.data.biz_data as { normal_wallets?: unknown; bonus_wallets?: unknown } | undefined

  const wallets = new Map<string, AccountWallet>()
  const add = (list: unknown, field: 'total' | 'bonus'): void => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      const row = entry as { currency?: unknown; balance?: unknown } | null
      const currency = typeof row?.currency === 'string' && row.currency !== '' ? row.currency : 'CNY'
      const value = Number(row?.balance)
      if (!Number.isFinite(value)) continue
      const wallet = wallets.get(currency) ?? { currency, total: 0, bonus: 0 }
      wallet[field] += value
      wallets.set(currency, wallet)
    }
  }
  add(biz?.normal_wallets, 'total')
  add(biz?.bonus_wallets, 'bonus')
  // bonus_wallets 单独来时 total 还没有算进去：把赠金并进可花总额。
  for (const wallet of wallets.values()) wallet.total += wallet.bonus
  if (wallets.size === 0) throw new Error('账号响应里没有钱包余额')
  return [...wallets.values()]
}

/**
 * Turn account wallets into panel rows: spendable total first (the pill and
 * the balance ETA read it), then the bonus part only when it is non-zero —
 * a zero bonus is noise, and a zero total is still a real reading.
 * @param wallets - parsed wallets.
 * @returns panel items.
 */
export function deepseekAccountItems(wallets: readonly AccountWallet[]): QuotaItem[] {
  const items: QuotaItem[] = []
  for (const wallet of wallets) {
    items.push({ label: `${wallet.currency} 总余额`, display: cny(wallet.total), remaining: wallet.total })
    if (wallet.bonus > 0) items.push({ label: `${wallet.currency} 其中赠送`, display: cny(wallet.bonus) })
  }
  return items
}

/**
 * Query the signed-in account's wallet with its grant token.
 * @param token - 账号 grant token（`x-dsh-auth-token`）。
 * @param signal - 超时/取消。
 * @returns panel items for the account card.
 */
export async function fetchDeepSeekAccountItems(token: string, signal?: AbortSignal): Promise<QuotaItem[]> {
  const body = await getJson(DEEPSEEK_ACCOUNT_ENDPOINT, { 'x-dsh-auth-token': token }, signal)
  return deepseekAccountItems(parseDeepSeekAccountWallets(body))
}
