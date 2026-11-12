/**
 * DSH 模型供应商 id → 面板平台 id 的唯一一张映射表，Host 与浏览器两半共用。
 *
 * 为什么必须共用：浏览器侧要拿「当前会话在用的模型」去认领它对应的额度卡片
 * 并置顶（client/panel-order.ts），Host 侧要拿同一套规则决定哪些平台该查询、
 * 当前默认模型对应哪一行。这两份规则曾经各存一份副本，于是火山方舟只在 Host
 * 那份里登记（`ark → volcark`），浏览器那份没有——会话模型是 `ark` 时客户端
 * 认不出 `volcark` 卡片，置顶逻辑静默失效（面板顺序看起来"没生效"）。
 *
 * 零依赖纯函数（连 ARK_PLATFORM_ID 都在本文件里定义）：浏览器 bundle 会把本
 * 模块整个内联，绝不能拖进 ark.ts 的 node:crypto。
 * @module dsh-quota/platform-map
 */

/** 火山方舟在面板里的平台 id（额度行与 `/models` 探活兜底行共用）。 */
export const ARK_PLATFORM_ID = 'volcark'

/**
 * Magpie 本机网关在面板里的平台 id。额度行 id 是 `magpie#<provider>`
 * （同一 provider 多账号再带 `/user` 后缀），所以认领时按前缀匹配。
 */
export const MAGPIE_PLATFORM_ID = 'magpie'

/**
 * Map a model-provider id onto a quota platform id.
 * @param provider - DSH 模型供应商 id（不区分大小写）。
 * @returns 面板平台 id；没有对应平台时返回空串。
 */
export function platformForProvider(provider: string): string {
  const p = provider.toLowerCase()
  // Magpie 放在最前：它的供应商 id 是 `magpie` / `magpie-anthropic` /
  // `magpie-responses`，后两个含 'anthropic'，会被下面的官方 Admin 映射
  // 抢先命中，于是把本机网关错认成 Anthropic 组织账号。
  if (p.includes('magpie')) return MAGPIE_PLATFORM_ID
  if (p.includes('kimi')) return 'kimi'
  if (p.includes('deepseek')) return 'deepseek'
  if (p.includes('zhipu') || p.includes('glm')) return 'zhipu'
  if (p.includes('zai')) return 'zhipu'
  if (p.includes('bigmodel')) return 'bigmodel'
  if (p.includes('qwen') || p.includes('dashscope')) return 'qianwen' // 注意：不带 'bailian'——自定义 bailian 供应商常是别人的 key，映射到自己账号的 MCP 行会显示错账号
  if (p.includes('scnet')) return 'scnet'
  if (p.includes('tokenrouter')) return 'tokenrouter'
  if (p.includes('moonshot')) return 'moonshot'
  if (p.includes('openrouter')) return 'openrouter'
  if (p.includes('siliconflow')) return 'siliconflow'
  if (p.includes('minimax')) return 'minimax'
  if (p.includes('step')) return 'stepfun'
  if (p.includes('xai') || p.includes('grok')) return 'xai'
  if (p.includes('opendesign') || p.includes('open-design')) return 'opendesign'
  if (p.includes('opencode')) return 'opencode-go'
  if (p.includes('openai')) return 'openai-admin'
  if (p.includes('anthropic') || p.includes('claude')) return 'anthropic-admin'
  // 火山方舟：供应商 id 就是 ark（另有 volcengine / doubao 等常见写法）；别把
  // 'ark' 写成 includes 匹配——会误伤其它含 ark 的 id。
  if (p === 'ark' || p.includes('volc') || p.includes('doubao')) return ARK_PLATFORM_ID
  return ''
}
