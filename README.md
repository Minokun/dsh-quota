# dsh-quota

DeepSeek Harness 插件：右下角「会员额度」悬浮球 + 面板，一眼看清各 AI 平台的套餐额度与余额。


## 功能

- **点开即更新**：打开面板时数据超过 5 分钟自动后台刷新；也可手动点「刷新」
- **进度条可视化**：用量占比彩色进度条（<60% 绿 / 60–85% 黄 / >85% 红），带重置时间
- **Key 自动同步**：直连平台的 API key 直接读 DSH 凭证域（与模型配置同一批 `apiKeyEnv` 引用）——DSH 里加过 key 就不用手动再填；凭证变更自动触发刷新
- **手动 Key 兜底**：面板里可手动保存 key（存于 DSH 凭证域的插件私有引用，删除不影响 DSH 模型配置）

## 支持的平台

| 平台 | 方式 | 内容 |
| --- | --- | --- |
| Kimi Code | 官方 API（`KIMI_CODING_API_KEY`） | 周额度 / 5h 窗口 / 加量包 / 并发 |
| DeepSeek | 官方 API（`DEEPSEEK_API_KEY`） | 余额、赠金、充值 |
| 智谱 Coding Plan | 官方 API（`ZAI_CODING_CN_API_KEY`） | 5 小时 token 窗口、调用限流 |
| 智谱 BigModel | MCP（`mcp__bigmodel__*`） | 账户余额 |
| 通义千问（百炼） | MCP（`mcp__qianwenai__*`） | Token 套餐、可用金额 |
| 超算互联网 | MCP（`mcp__scnet__*`） | 充值余额、专项金额 |
| TokenRouter | MCP（`mcp__tokenrouter__*`） | 额度消耗进度 |
| SupaWriter | MCP（`mcp__supawriter__*`） | 月度文章额度 |

直连平台 key 缺失时显示「未配 Key」；**MCP 平台是纯可选扩展**——它们通过你在 DSH 里另行注册的 `mcp__bigmodel__*` / `mcp__qianwenai__*` / `mcp__scnet__*` / `mcp__tokenrouter__*` / `mcp__supawriter__*` 工具取数（本仓库不包含这些 MCP 服务器）。某个 MCP 没注册时对应平台自动隐藏，注册了就会自动出现，互不干扰。

## 安装

```sh
dsh plugin --profile web add dsh-quota
```

或打开 **设置 → 插件市场**，搜索 `dsh-quota` 一键安装。

## 配置（可选）

在 composition 里给条目加 config：

```yaml
- id: quota
  config:
    refreshOnBoot: true          # 启动后自动刷新一次（默认 true）
    refreshIntervalMinutes: 30   # 定时刷新间隔，0 关闭（默认 0）
```

## 开发

```sh
pnpm install
pnpm build        # 构建 host + client，含 client-id 一致性门禁
pnpm typecheck
sh scripts/reload.sh   # 构建；Host 改动重启 dsh 生效，界面改动刷新页面生效
```

## License

MIT
