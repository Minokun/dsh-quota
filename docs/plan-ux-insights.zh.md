# dsh-quota UX 与额度洞察迭代方案

> 2026-09 调研了三个同名 dsh-quota 仓库（Minokun / Francesco502 / Lottle7）及
> awesome-dsh-plugin 生态后的迭代计划。本仓库 = Minokun 版。

## 一、调研结论（借鉴来源）

| 能力 | 来源 | 说明 |
|---|---|---|
| HUD 悬浮环 | Francesco502 | 圆环进度、多平台轮播、悬停暂停、数字平滑动画、贴边微缩 |
| 消耗速率 + 剩余时长预估 | Francesco502 | 本地时序采样 → 近 24h 平均速率 %/h → 预估耗尽时间 |
| 动态小红点告警 | Francesco502 | 多级阈值告警 + 入口红点 Badge 联动 |
| 中英双语 i18n | Lottle7 | 唯一已做双语的同类插件；Francesco502 issue #1 证明海外需求真实存在 |
| OpenAI / Claude 官方平台 | Francesco502 | 已实现 OpenAI Billing / Anthropic / Codex(Wham) 适配器，可参考 |
| 用量台账 + 成本分析 + CSV | Lottle7 | 工程量大，列为远期 |
| 自定义端点安全加固 | Lottle7 | DNS 校验 + TLS 锁定 + 响应上限，防 SSRF |
| 一键测试连接 + 延迟 | Francesco502 | 小功能，体验好 |

## 二、第一阶段（本次迭代）：三大 UX/洞察特性

### 1. 时序采样 → 消耗速率 → 预估剩余时长

- **存储**：`quota` settings 命名空间新增 `history: Record<string, [epochMs, value][]>`，
  key 为 `${providerId}::${itemLabel}`；每次 refresh 采样一次（距上一点 ≥10 分钟才追加），
  保留 14 天、单序列上限 1000 点。
- **计算**（纯函数，独立模块 `src/insights.ts`，可单测）：
  - 只在配额"单调递增段"上算速率——百分比骤降视为窗口重置，丢弃重置前的点；
  - percent 条目：速率 %/h，ETA = (100 − 当前) / 速率；
  - used/limit 条目：速率 单位/h，ETA = remaining / 速率；
  - 采样跨度 <30 分钟或速率 ≤0 不出 ETA。
- **出口**：`QuotaItem` 增加 `burnRatePerHour?` / `etaMinutes?`，面板条目行显示
  「≈3.1%/h · 约 9h 后耗尽」，`quota_refresh` agent 工具同步透出。

### 2. 动态小红点告警 Badge

- 告警源：条目 percent ≥ `alertPercent`（新配置项，默认 85，与进度条红色阈值一致）、
  平台查询失败（status=error）、登录态失效提醒（已有 loginAlerts）。
- 悬浮球/悬浮环右上角挂红点 Badge（带数量），点击照常展开面板定位问题卡片；
  恢复后自动消失，无需手动清除。

### 3. HUD 悬浮环模式

- 悬浮球支持两种形态：**药丸（现状）/ 圆环**，面板头部一键切换，
  `localStorage` 持久化。
- 圆环：SVG 环形进度，中心显示剩余百分比；焦点平台 = 当前会话模型对应平台，
  无对应时每 4 秒在 ok 平台间轮播（悬停暂停）；颜色沿用绿/黄/红三档；
  `stroke-dashoffset` CSS 过渡实现平滑动画。
- **贴边微缩**：拖到屏幕左右边缘（≤12px）时自动收成半隐小条，悬停展开。

### 验证

- `pnpm test`（新增 tests/insights.test.ts：重置检测、速率、ETA、剪枝）
- `pnpm build`（含 client-id 门禁）、`pnpm typecheck`

## 三、后续阶段

- **阶段 2 · i18n ✅ 已完成（0.11.0）**：`src/client/locale.ts` 双语文案表（zh/en，70+ 键），
  跟随官方 `ctx.locale` 服务实时切换、无该服务时按浏览器语言兜底；面板/悬浮球/悬浮环/错误提示/
  时间与 ETA 格式全部本地化，`tests/locale.test.ts` 校验两语言键集一致且 en 文案无中文残留。
  已知边界：host 下发的平台条目名（如「周额度」）与上游报错原文仍为中文（数据面，后续可用结构化
  tag 字段彻底解决）；`tools.ts` 的工具 description 暂保持中文+英文混排。
- **阶段 3 · OpenAI/Claude 适配器 ✅ 已完成（0.12.0）**：OpenAI `/v1/organization/costs`
  （Bearer admin key，`amount.value` 美元）与 Anthropic Admin `/v1/organizations/cost_report`
  （`x-api-key` + `anthropic-version`，金额为「分」已换算）两个目录适配器，展示今日/近 7 天/近 30 天
  消耗；卡片上用 note 说明「Admin API 无余额接口」。目录条目新增 `auth`/`headers`/`buildUrl`/`note`
  能力，为后续同类平台铺路。测试：tests/costs.test.ts（端点 URL、鉴权头、分→美元换算、空桶报错）。
  仍未做：Codex(ChatGPT 订阅额度，需要读 ~/.codex/auth.json 的 OAuth token，属本地凭据型适配器)。
- **阶段 4 · 体验补强 ✅ 已完成（0.13.0）**：卡片「测」按钮一键测活（`/api/probe`，
  毫秒延迟或上游错误，只读）；自定义端点安全加固——`assertPublicHttpsUrl()` 校验公网 HTTPS、
  拒绝内嵌凭据/查询串/内网与保留地址，`getJson()` 拒绝跟随跳转并限制响应 256 KiB。
  测试：tests/security.test.ts（公网/内网/保留地址边界）+ tests/locale.test.ts 覆盖新文案。
  未做（可选）：DNS 解析后二次校验 + TLS 地址锁定（Lottle7 级别），需要 node:https 直连取代 fetch。
- **远期**：用量台账 + CNY 成本分析 + CSV 导出（参考 Lottle7）。

## 四、边界与非目标

- 不做浏览器本地预算管理（Lottle7 路线），与本插件"纯查询快照"定位保持轻量。
- 历史采样只存数值对，不存任何凭据/原文，隐私面不扩大。
