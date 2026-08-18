# 扩展 dsh-quota：接入新平台的三条路线

dsh-quota 把"支持更多平台"分成三层，按平台的接口形态选择最轻的一条：

```
L0 内置目录（零配置）   key 在 DSH 凭证域/环境变量里能解析 → 自动出现
L1 自定义 HTTP 平台     有余额/额度 API（Bearer key 鉴权）→ 面板或 config 添加
L2 MCP 平台             只有网页 Cookie 会话 → 做个 MCP 服务器 → config 接入
```

---

## L0：内置目录自动发现（无需任何操作）

每次刷新都会探测内置供应商目录：**某个平台声明的凭证引用（`XXX_API_KEY`）只要能在 DSH 凭证域或环境变量里解析出来，该平台就自动出现在面板上**；key 删掉，平台随之消失。

内置目录（除三大钉住平台外）：Z.AI Coding、Moonshot、OpenRouter、SiliconFlow（国际/国内）、MiniMax Coding（国际/国内）、StepFun、xAI、OpenCode Go。

所以"加平台"最常见的情形其实是：**在 DSH 的模型配置里加了供应商（或把 key 写进凭证域），面板下一刷就有了。**

> 没有凭据枚举 API 这件事是 DSH 的设计（凭证域只按引用解析），所以目录探测是"逐个引用尝试 resolve"，key 值永远不出 Host 进程。

## L1：自定义 HTTP 平台（有余额 API 的平台）

平台有"Bearer key 查询余额/额度"的接口？两种加法：

### 面板里点几下（推荐）

右下角 pill → 面板底部 **「自定义平台」**：

1. 先把 key 写入 DSH 凭证域（比如 `MY_SITE_API_KEY`）——在「API Key 管理」里随便一个平台存一次，或手动编辑 `~/.dsh/.credentials.yaml`
2. 填：名称、接口地址（https）、凭证引用名（`MY_SITE_API_KEY`）、格式（接口响应对应的解析器）
3. 点「添加」——立即刷新出现新卡片；保存在 DSH 设置里，重启不丢

### composition config（适合批量/分发）

```yaml
- id: quota
  config:
    httpPlatforms:
      - id: my-hub
        label: 我的聚合站
        endpoint: https://hub.example.com      # openai-billing 填站点根地址
        keyRef: MY_HUB_API_KEY
        format: openai-billing
```

### 内置格式（format）一览

| format | 适用 | 端点约定 |
| --- | --- | --- |
| `openai-billing` | one-api / new-api 系聚合站 | 站点根地址，自动调 `/v1/dashboard/billing/subscription` + `/usage` |
| `deepseek-balance` | `balance_infos[]` 形响应 | DeepSeek 官方及兼容站 |
| `moonshot-balance` | `data.total_balance` 形 | Moonshot 及兼容站 |
| `siliconflow-balance` | `data.balance` 形 | SiliconFlow 及兼容站 |
| `openrouter-credits` | `data.total_credits/total_usage` 形 | OpenRouter 及兼容站 |
| `stepfun-accounts` | `balance` 形（含现金/赠金） | StepFun 及兼容站 |
| `xai-credits` | `total.val`（美分）形 | xAI 及兼容站 |

响应形态对不上任何格式 → 该平台在官方提供兼容端点前接不了，走 L2 或提 issue。

## L2：MCP 平台（只有网页 Cookie 会话的平台）

通义百炼控制台、超算互联网这类平台**没有 API-key 查询端点**，余额只在登录后的网页接口里。路线：

1. **抓包**：浏览器登录平台后台，DevTools 导出 HAR
2. **生成 MCP**：用 DSH 的 har-to-mcp 技能（`dsh-har-to-mcp`）把 HAR 逆向成 MCP 服务器，暴露一个如 `mcp__mysite__my_quota` 的工具
3. **注册**：把 MCP 服务器加进 profile 的 `cordis.patch.yml`（`@deepseek-ai/dsh-mcp-client` 条目）
4. **接入面板**：

```yaml
- id: quota
  config:
    mcpPlatforms:
      - id: mysite
        label: 我的平台
        tools: ['mcp__mysite__my_quota']   # 按序调用，可多个
```

通用解析器自动识别 `used/limit/remaining` 形的配额行和 `balance` 形余额；识别不了就显示原始返回摘要。MCP 未注册时该行自动隐藏，不打扰别人。

> Cookie 会话会过期（各站几天到一个月不等），过期后平台行显示失败，重新登录/更新会话即恢复。这也是这类平台不适合做成内置直连的原因。

## 想让我们内置某个平台？

提 [issue](https://github.com/Minokun/dsh-quota/issues)，附上：

1. provider id（`^[a-z0-9-]+$`，如 `together`）
2. 用标准 API key 查余额/额度的公开端点（如 `GET https://api.provider.com/v1/user/info`，Bearer 认证）；贴一段响应 JSON 更好

目录接入只需要：一个可解析的凭证引用名、一个端点、一个响应格式。

## 致谢

L0 目录的端点与窗口语义调研参考了 [CodexBar](https://github.com/steipete/CodexBar)（docs/zai.md 等）与 [dsh-quota-panel](https://github.com/wenzetan/dsh-quota-panel)（MIT）——后者是同类插件，专注纯 API-key 供应商；dsh-quota 的差异在于额外的 MCP 路线（覆盖 Cookie 会话平台）、`quota_refresh` agent 工具和面板内即时添加平台。
