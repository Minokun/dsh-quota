/**
 * DSH 模型供应商 id → 面板平台 id 的映射（客户端侧，与 Host 侧保持一致）。
 *
 * 单独成模块是为了让纯排序逻辑（panel-order.ts）不依赖 controller.ts 的
 * 运行时依赖（快照 store / React 之外的浏览器设施）——单测可以只加载这张表。
 * @module dsh-quota/client/platform-map
 */

/** Map a model-provider id onto a quota platform id (mirror of the host side). */
export function platformForProvider(provider: string): string {
  const p = provider.toLowerCase()
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
  if (p.includes('opencode')) return 'opencode-go'
  if (p.includes('openai')) return 'openai-admin'
  if (p.includes('anthropic') || p.includes('claude')) return 'anthropic-admin'
  return ''
}
