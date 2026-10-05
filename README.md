# dsh-quota

DeepSeek Harness 插件：右下角「会员额度」悬浮球 + 面板，一眼看清各 AI 平台的套餐额度与余额。

![面板特写](https://raw.githubusercontent.com/Minokun/dsh-quota/main/docs/screenshot-panel.png)

<details>
<summary>📸 整页效果（悬浮球在右下角）</summary>

![整页效果](https://raw.githubusercontent.com/Minokun/dsh-quota/main/docs/screenshot-full.png)

</details>

**截图里都是什么：**

- **右下角的「会员额度」悬浮球**：圆点表示整体状态（绿 = 全部正常 / 黄 = 部分异常 / 红 = 全部失败），旁边是上次刷新时间；点击展开/收起面板，打开时数据超过 5 分钟会自动后台刷新；**按住可拖拽到屏幕任意位置**（位置自动记住，拖到上半屏时面板改为向下展开）
- **每个平台一张卡片**：右上两个徽标——`API` = 官方 API 直查（key 自动同步自 DSH 凭证域，下方灰色小字显示用的是哪个凭证引用，例如 `⇄ 已同步 KIMI_CODING_API_KEY · DSH 凭证`），`MCP` = 通过已注册的 MCP 服务器查询；`正常` / `失败` / `未配 Key` 是本次查询状态
- **彩色进度条**：用量占比（<60% 绿 / 60–85% 黄 / >85% 红），右侧是 `已用 / 上限 剩xx`，下方小字是额度窗口的重置时间
- **头部「刷新」按钮**：立即重新查询所有平台；面板底部「API Key 管理」折叠区可手动补 key（一般不需要——DSH 里加过的 key 会自动同步过来）

## 功能

- **定时自动更新**：默认每 5 分钟刷新一次（`refreshIntervalMinutes` 可调）；打开面板时数据超过 5 分钟也会自动补刷；手动「刷新」随时可用
- **进度条可视化**：用量占比彩色进度条（<60% 绿 / 60–85% 黄 / >85% 红），带重置时间
- **配置哪些显示哪些**：只有 key 能解析（或 MCP 已注册）的平台才显示，没配置的平台不占面板
- **Key 自动同步**：直连平台的 API key 直接读 DSH 凭证域（与模型配置同一批 `apiKeyEnv` 引用）——DSH 里加过 key 就不用手动再填；凭证变更自动触发刷新
- **手动 Key 兜底**：面板里可手动保存 key（存于 DSH 凭证域的插件私有引用，删除不影响 DSH 模型配置）
- **消耗速率与剩余时长预估**：本地时序采样（≥10 分钟一个点、保留 14 天），在当前配额窗口段上计算平均消耗速率（%/h），条目下方给出「约 x 小时后耗尽」预估；窗口重置自动截断分段，不会跨重置算出错误速率；`quota_refresh` 工具同步透出
- **一键测活**：每张卡片右上「测」按钮当场重跑该平台的查询，返回毫秒延迟（`✓ 320ms`）或上游原始错误；只读探测，不改动快照
- **自定义端点安全校验**：接口地址必须是公网 HTTPS——拒绝内嵌用户名/密码、查询参数、`localhost`/`.local`/`.internal` 与回环/私有/链路本地/保留地址（含 IPv4/IPv6 字面量）；请求拒绝跟随 3xx 跳转、响应超过 256 KiB 直接失败，避免自定义平台被用来探测内网
- **中英双语界面**：面板文案跟随 DSH 的语言设置（`ctx.locale` 服务）实时切换，缺失该服务时按浏览器语言自动判定；药丸/悬浮环/面板/错误提示/时间格式全部本地化（en 文案不含中文字符，有单测把关）
- **红点告警 Badge**：悬浮球/悬浮环右上角红点计数——查询失败的平台 + 用量占比 ≥ `alertPercent`（默认 85，可配置）的条目 + 登录失效提醒，恢复后自动消失
- **HUD 悬浮环模式**：面板头部一键在「药丸 / 悬浮环」之间切换（localStorage 记住）；悬浮环显示剩余额度环形进度（绿/黄/红三档、平滑动画），焦点跟随当前会话模型，无对应时每 4 秒轮播各平台（悬停暂停）；拖到屏幕左右边缘自动贴边微缩、悬停展开

## 支持的平台

**钉住平台**（始终显示，缺 key 时提示）：Kimi Code、DeepSeek、智谱 Coding Plan。

**自动发现平台**（key 在 DSH 凭证域/环境变量能解析就自动出现，否则隐藏）：Z.AI Coding、Moonshot、OpenRouter、SiliconFlow（国际/国内）、MiniMax Coding（国际/国内）、StepFun、xAI、OpenCode Go、DeepInfra、Venice、NeuralWatt、**OpenAI Platform**、**Anthropic Claude**。面板「API Key 管理」覆盖全部直连平台——填 key 即接入（写入 DSH 凭证域，模型配置也能用）。

**国外官方平台（用量/成本口径）**：OpenAI 走组织 Admin API `/v1/organization/costs`（凭证引用 `OPENAI_ADMIN_KEY`，即 `sk-admin-…`），Anthropic 走 Admin `cost_report`（凭证引用 `ANTHROPIC_ADMIN_KEY`，即 `sk-ant-admin…`，请求带 `anthropic-version`、金额单位是「分」已自动换算）。两家都**没有余额查询接口**，卡片展示「今日 / 近 7 天 / 近 30 天消耗」，并在卡片上注明；普通 `sk-*` / 项目 key 会被上游拒绝，不是插件的问题。

**MCP 平台**（纯可选扩展，通过另行注册的 `mcp__*` 工具取数；本仓库不包含这些 MCP 服务器）：智谱 BigModel、通义千问（百炼）、超算互联网、TokenRouter、SupaWriter。没注册时对应平台自动隐藏。

**平台来源以 DSH 系统配置为准**：MCP 平台行只在 **DSH composition（profile 的 `cordis.yml` / `cordis.patch.yml`）声明了对应的 `@deepseek-ai/dsh-mcp-client` 条目**时才创建——Host 半边通过 cordis loader 服务读取真实的 entry 树，而不是看项目里的 `.mcp.json`、也不是"恰好存在同名工具"；composition 里删掉条目（并重启 dsh）后，对应平台立即从面板消失。loader 服务不可用的旧版本上自动退回"工具注册表探测"。

**自定义平台**：有余额 API 的平台（聚合站 / one-api / new-api…）在面板底部「自定义平台」直接添加，或在 config 里声明 `httpPlatforms` / `mcpPlatforms` —— 详见 **[docs/extending.md](docs/extending.md)**（含"如何把网页 Cookie 平台做成 MCP 接入"的完整指南）。

NewAPI 有两种口径：`openai-billing` 使用模型 `sk-*` key 查询该 key 的额度；`newapi-account` 使用个人设置里的系统访问令牌与用户 ID 查询 `/api/user/self`，显示整个账号的余额和累计用量。

## 安装

```sh
dsh plugin --profile web add dsh-quota
```

或打开 **设置 → 插件市场**，搜索 `dsh-quota` 一键安装。

> **版本要求**：`0.8.0+` 需要 dsh `0.1.2-alpha.1` 及以上（浏览器端模块表改用
> `@deepseek-ai/dsh-client-store` platform seed）。仍在用旧版 dsh（`0.1.0-rc` 系列）
> 请锁定 `dsh-quota@0.7.x`。

## 配置（可选）

在 composition 里给条目加 config：

```yaml
- id: quota
  config:
    refreshOnBoot: true          # 启动后自动刷新一次（默认 true）
    refreshIntervalMinutes: 30   # 定时刷新间隔，0 关闭（默认 0）
    alertPercent: 85             # 用量占比告警阈值（红点计数，默认 85）
```

### 接入你自己的 MCP 平台

除了上述内置平台，composition 里声明 `mcpPlatforms` 即可把任何已注册的 `mcp__*` 额度工具接进面板（通用解析：自动识别 used/limit/remaining 形的配额行与 balance 形余额；未注册时该行自动隐藏）：

```yaml
- id: quota
  config:
    mcpPlatforms:
      - id: mysite
        label: 我的平台
        tools: ['mcp__mysite__my_quota']   # 按序调用，可多个
```

## 开发

```sh
pnpm install
pnpm link-harness # 把类型/依赖对齐到本机已安装的 dsh（见下）
pnpm build        # 构建 host + client，含 client-id 一致性门禁
pnpm typecheck
sh scripts/reload.sh   # 构建；Host 改动重启 dsh 生效，界面改动刷新页面生效
```

`pnpm link-harness` 默认从**本机已安装的 dsh**（`npm root -g`，或 `DSH_INSTALL=<dsh 目录>`）
软链 `node_modules/@deepseek-ai/*`，让 `typecheck`/`build` 与运行时解析同一份代码。
改 dsh 源码时才用 `sh scripts/link-harness.sh --harness [checkout 路径]` 切到工作树构建。
两者都没有时回退到仓库内 `vendor/`（schemastery / cordis / dsh-client-store）。

## 交流群

扫码加入 QQ 交流群，一起反馈问题、分享用法、共建插件——欢迎一起来建设！

<img src="https://raw.githubusercontent.com/Minokun/dsh-quota/main/docs/qq-qrcode.jpg" alt="QQ 交流群二维码" width="240" />

## License

MIT
