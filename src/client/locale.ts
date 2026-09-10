/**
 * Panel copy: zh-CN / en dictionaries plus a tiny translate() with {param}
 * interpolation. The active language comes from the official locale plugin
 * (`ctx.locale`, followed live) when present, else navigator.language; the
 * quota panel keeps working (Chinese default) on dsh builds without the
 * locale service, so this module has NO hard dependency on it.
 *
 * Host-rendered data (provider item labels, upstream error messages) stays
 * as delivered by the host for now — this table covers panel chrome.
 * @module dsh-quota/client/locale
 */

export type Lang = 'zh' | 'en'

const zh = {
  'pill.defaultName': '会员额度',
  'pill.title.default': '查看各平台会员额度（可拖拽移动）',
  'pill.title.summary': '{from}：{summary}（可拖拽移动）',
  'model.from.session': '会话模型',
  'model.from.default': '默认模型',

  'ring.title.focus': '{label} · {item}：剩 {percent}%（悬停暂停轮播，可拖拽移动）',
  'ring.hint.pause': '悬停暂停轮播，可拖拽移动',

  'panel.title': '会员额度',
  'panel.normalCount': '{ok}/{total} 正常',
  'panel.refresh': '刷新',
  'panel.refreshing': '刷新中…',
  'panel.empty': '还没有可显示的平台——只有能解析到 key 的平台才会出现。在下方「API Key 管理」填入平台 key，或在 DSH 模型设置里配置供应商（key 自动同步）。',
  'panel.footer.refreshedAt': '刷新于 {time}',
  'panel.footer.never': '尚未刷新',
  'mode.toRing': '切换为悬浮环',
  'mode.toPill': '切换为药丸',

  'status.ok': '正常',
  'status.error': '失败',
  'status.missing-key': '未配 Key',
  'status.missing-mcp': '无 MCP',

  'source.env': '环境变量',
  'source.project-env': '项目 .env',
  'source.user-env': '用户环境',
  'source.dsh': 'DSH 凭证',

  'provider.synced': '⇄ 已同步 {ref} · {source}',
  'provider.syncedTitle': '凭证引用 {ref}（{source}）',
  'probe.run': '测',
  'probe.title': '测试连接（返回毫秒延迟）',
  'probe.running': '测活中…',
  'probe.ok': '✓ {ms}ms',
  'probe.fail': '✗ {message}',

  'toast.loginExpired': '⚠️ {label} 登录已失效',
  'toast.retry': '重试',
  'toast.login': '去登录',
  'toast.dismiss': '忽略本次提醒',
  'login.done': '我已完成登录，重试',
  'login.go': '去登录 ↗',

  'item.remaining': '剩{n}',
  'eta.title': '按当前窗口段的平均消耗速率预估',
  'eta.minutes': '约 {n} 分钟后耗尽',
  'eta.hours': '约 {n} 小时后耗尽',
  'eta.days': '约 {n} 天后耗尽',
  'reset.today': '今天 {time} 重置',
  'reset.day': '{date} {time} 重置',

  'summary.remainingPercent': '剩{p}%',
  'summary.remainingCount': '剩{n}',
  'tag.weekly': '周',
  'tag.monthly': '月',

  'keys.title': 'API Key 管理',
  'keys.hint': 'DSH 已添加的 key 会自动同步，一般无需手动填写',
  'keys.note': '手动保存的 key 存于 DSH 凭证域的插件私有引用，删除不影响 DSH 模型配置。',
  'keys.configuredTitle': '当前：{ref}（{source}）',
  'keys.unconfiguredTitle': '未配置',
  'keys.overridePlaceholder': '{ref}，输入可覆盖',
  'keys.save': '存',
  'keys.delete': '删',
  'keys.deleteTitle': '删除面板手动保存的 key',

  'custom.title': '自定义平台',
  'custom.hint': '聚合站 / one-api / new-api，接口匹配内置格式即可',
  'custom.note': 'key 先写进 DSH 凭证域（如 MY_SITE_API_KEY），这里只填引用名；newapi-account 应保存系统访问令牌，而不是模型调用的 sk-* key。',
  'custom.namePlaceholder': '名称（如 我的聚合站）',
  'custom.endpointPlaceholder': '接口地址（https://…，openai-billing 填站点根地址）',
  'custom.keyRefPlaceholder': '凭证引用（如 MY_SITE_API_KEY，先存入 DSH 凭证）',
  'custom.userIdPlaceholder': 'NewAPI 用户 ID（如 123）',
  'custom.quotaPerUnitPlaceholder': '每美元额度点（默认 500000）',
  'custom.add': '添加',
  'custom.remove': '删',

  'error.readStatus': '无法读取插件状态，请刷新页面',
  'error.customRequired': '名称、接口地址、凭证引用都要填',
  'error.newapiUserId': 'NewAPI 用户 ID 必须是正整数',
  'error.newapiQuotaPerUnit': 'NewAPI 每美元额度点必须是正数',
  'error.keyEmpty': 'key 不能为空',
  'error.requestFailed': '插件请求失败（HTTP {status}）',
} as const

export type LocaleKey = keyof typeof zh

const en: Record<LocaleKey, string> = {
  'pill.defaultName': 'Plan Quota',
  'pill.title.default': 'View plan quotas (draggable)',
  'pill.title.summary': '{from}: {summary} (draggable)',
  'model.from.session': 'Session model',
  'model.from.default': 'Default model',

  'ring.title.focus': '{label} · {item}: {percent}% left (hover pauses carousel, draggable)',
  'ring.hint.pause': 'hover pauses carousel, draggable',

  'panel.title': 'Plan Quota',
  'panel.normalCount': '{ok}/{total} OK',
  'panel.refresh': 'Refresh',
  'panel.refreshing': 'Refreshing…',
  'panel.empty': 'No platforms to show yet — only platforms with a resolvable key appear. Add a key under "API Keys" below, or configure a provider in DSH model settings (keys sync automatically).',
  'panel.footer.refreshedAt': 'Refreshed at {time}',
  'panel.footer.never': 'Not refreshed yet',
  'mode.toRing': 'Switch to ring',
  'mode.toPill': 'Switch to pill',

  'status.ok': 'OK',
  'status.error': 'Failed',
  'status.missing-key': 'No key',
  'status.missing-mcp': 'No MCP',

  'source.env': 'env',
  'source.project-env': 'project .env',
  'source.user-env': 'user env',
  'source.dsh': 'DSH credentials',

  'provider.synced': '⇄ synced {ref} · {source}',
  'provider.syncedTitle': 'credential ref {ref} ({source})',
  'probe.run': 'Test',
  'probe.title': 'Test connectivity (reports latency in ms)',
  'probe.running': 'Testing…',
  'probe.ok': '✓ {ms}ms',
  'probe.fail': '✗ {message}',

  'toast.loginExpired': '⚠️ {label} login expired',
  'toast.retry': 'Retry',
  'toast.login': 'Sign in',
  'toast.dismiss': 'Dismiss this reminder',
  'login.done': 'I have signed in, retry',
  'login.go': 'Sign in ↗',

  'item.remaining': '{n} left',
  'eta.title': 'Estimated from the average burn rate of the current window segment',
  'eta.minutes': 'depletes in ~{n} min',
  'eta.hours': 'depletes in ~{n} h',
  'eta.days': 'depletes in ~{n} d',
  'reset.today': 'resets today {time}',
  'reset.day': 'resets {date} {time}',

  'summary.remainingPercent': '{p}% left',
  'summary.remainingCount': '{n} left',
  'tag.weekly': 'wk',
  'tag.monthly': 'mo',

  'keys.title': 'API Keys',
  'keys.hint': 'Keys added in DSH sync automatically — manual entry is rarely needed',
  'keys.note': 'Manually saved keys live under plugin-private refs in the DSH credentials domain; deleting them never touches DSH model routing.',
  'keys.configuredTitle': 'current: {ref} ({source})',
  'keys.unconfiguredTitle': 'not configured',
  'keys.overridePlaceholder': '{ref} — type to override',
  'keys.save': 'Save',
  'keys.delete': 'Del',
  'keys.deleteTitle': 'Delete the key saved manually in the panel',

  'custom.title': 'Custom Platforms',
  'custom.hint': 'aggregator / one-api / new-api sites whose endpoint matches a built-in format',
  'custom.note': 'Store the key in the DSH credentials domain first (e.g. MY_SITE_API_KEY) and only name the ref here; newapi-account expects the system access token, not a model-call sk-* key.',
  'custom.namePlaceholder': 'Name (e.g. My Relay)',
  'custom.endpointPlaceholder': 'Endpoint (https://…, site root for openai-billing)',
  'custom.keyRefPlaceholder': 'Credential ref (e.g. MY_SITE_API_KEY, stored in DSH first)',
  'custom.userIdPlaceholder': 'NewAPI user ID (e.g. 123)',
  'custom.quotaPerUnitPlaceholder': 'quota units per USD (default 500000)',
  'custom.add': 'Add',
  'custom.remove': 'Del',

  'error.readStatus': 'Could not read the plugin state — reload the page',
  'error.customRequired': 'Name, endpoint and credential ref are all required',
  'error.newapiUserId': 'NewAPI user ID must be a positive integer',
  'error.newapiQuotaPerUnit': 'NewAPI quota units per USD must be positive',
  'error.keyEmpty': 'key must not be empty',
  'error.requestFailed': 'Plugin request failed (HTTP {status})',
}

const DICTS: Record<Lang, Record<LocaleKey, string>> = { zh, en }

/** Translate function shape handed to render helpers. */
export type TFn = (key: LocaleKey, params?: Record<string, string | number>) => string

/** Translate one key, interpolating {param} placeholders. */
export function translate(lang: Lang, key: LocaleKey, params?: Record<string, string | number>): string {
  let text = DICTS[lang][key] ?? zh[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v))
  }
  return text
}

/** Browser-derived fallback when the official locale service is absent. */
export function browserLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}
