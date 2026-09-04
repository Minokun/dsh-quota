# 发布流程（仅 maintainer）

> 本文档面向仓库维护者。普通用户和贡献者无需关心——npm 包只能由仓库 owner 发布：
> 发版依赖 **tag 推送权限** + npm Trusted Publisher 对 `Minokun/dsh-quota` 仓库的 OIDC 绑定，
> fork 仓库或其他人的 tag 都会被 npm 拒绝。

发版走 **npm Trusted Publishing（GitHub Actions OIDC）**——不需要本地 token 或 2FA 验证码：

```sh
sh scripts/release.sh          # 默认 patch；也可 sh scripts/release.sh minor / 0.9.0
```

流程：`npm version` 升版本并打 tag → 推送触发 `.github/workflows/publish.yml` → CI 里构建（含门禁）→ OIDC 认证发布，自带 SLSA provenance。动作日志见 [Actions](https://github.com/Minokun/dsh-quota/actions)。

绑定配置（一次性，已绑好）：npmjs.com 包设置 → Trusted Publisher → GitHub Actions → `Minokun` / `dsh-quota` / `publish.yml` / 允许 `npm publish`。
