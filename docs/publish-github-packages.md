# 发布到 GitHub Packages 并让别人 `pnpm add` 安装

> 目标形态：包名 `@javagita-lgtm/dsh-code-notes`，源指向 GitHub Packages。
> 仓库：<https://github.com/javagita-lgtm/dsh-code-notes>（已确认为 public 仓库）
> **实测结论：即使包关联公开仓库，匿名安装仍会 401**（`authentication token not provided`）。
> GitHub 官方文档明确写着「You need an access token to publish, install, and delete private, internal,
> **and public** packages」——所以**每个安装者都必须有一个带 `read:packages` 的 classic token**。
> 这一点与本项目最初的设想不同，按下面的步骤操作即可。

本仓库已备好这些文件，你只需要替换占位符并执行几步：

| 文件 | 作用 |
| --- | --- |
| `package.json` | 已去掉 `private`，名字是作用域包，`publishConfig.registry` 指向 GitHub Packages |
| `.github/workflows/publish.yml` | 打 `v*` 标签 ⇒ 自动校验 + 发布 |
| `.gitignore` / `.npmignore` / `LICENSE` | 仓库与发布包的干净边界、许可证 |

## 0. 先理解三个概念（这决定别人能不能直接装）

- **作用域包（scoped package）**：`@用户名/包名`。GitHub Packages 的 npm 源**强制**要作用域，
  所以不能叫 `dsh-code-notes`，只能叫 `@javagita-lgtm/dsh-code-notes`。
- **可见性不等于免登录**：首次发布默认 private；即便你把它改成 public、或让它继承公开仓库权限，
  **安装仍然需要 token**。官方原话：「You need an access token to publish, install, and delete
  private, internal, and public packages」。本项目已实测复现：匿名 `npm view` 返回
  `401 authentication token not provided`。
- **registry 覆盖**：作用域包默认会被 npm 当成「该去 npmjs 找」的包，所以安装方要告诉 pnpm
  「`@javagita-lgtm` 这个作用域走 GitHub Packages」，否则会 404。
- **想「一条命令、无需 token」安装**：GitHub Packages 做不到，这是平台限制。
  那种体验只有公共 npmjs 能给，需要改回**不带作用域**的名字（如 `dsh-code-notes`，该名在 npmjs 尚未被占用）。

## 1. 已经完成的步骤（2026-10-20）

| 步骤 | 结果 |
| --- | --- |
| 仓库 | `javagita-lgtm/dsh-code-notes`，public，默认分支 `main` |
| 首次提交 | `b7f04fd` + 2 个文档提交，已推送 `main` |
| 包元数据 | `package.json` 改为 `@javagita-lgtm/dsh-code-notes`，填好 repository / homepage / bugs |
| 发布 | 打标签 `v0.2.0` → Actions `publish` 全绿（Verify / Check tag / Publish 均 success） |
| 线上包 | <https://github.com/users/javagita-lgtm/packages/npm/package/dsh-code-notes> |

后续发新版：

```bash
npm version patch        # 或 minor / major
git push --follow-tags   # 标签推送 ⇒ CI 自动发布
```

**手动发布**（不想用 CI，或 Actions 被策略禁用时）：

```bash
# 1) 建一个 classic token，勾选 write:packages（会自动带上 read:packages）
# 2) 写入本机 ~/.npmrc（不要写进仓库！）
#    //npm.pkg.github.com/:_authToken=<TOKEN>
npm publish
```

> 注意：发布前确认包已关联到仓库（`package.json` 的 `repository` 字段已填），
> 否则包里标签和仓库对不上、无法设成公开。

## 2. 别人怎么装

> 实测：**GitHub Packages 不支持匿名安装**，两种可见性都需要 token。
> 安装者必须先建一个 classic token（勾 `read:packages`），再往下走。

```bash
# ① 建 classic token：GitHub → Settings → Developer settings → Personal access tokens (classic)
#    勾选 read:packages（想自己发布再加 write:packages）

# ② 写入本机 ~/.npmrc（不要提交进仓库）
cat >> ~/.npmrc <<'EOF'
@javagita-lgtm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<安装者自己的 TOKEN>
EOF

# ③ 安装
pnpm add @javagita-lgtm/dsh-code-notes
```

Windows 上 `~/.npmrc` 就是 `%USERPROFILE%\.npmrc`。
token 只给「这个作用域 + 这个 host」用，不会泄露到 npmjs 的请求里。

**替代方案：不想让每个使用者建 token**
把包改回不带作用域的名字发布到公共 npmjs（如 `dsh-code-notes`，npmjs 上尚未被占用），
安装就变成 `pnpm add dsh-code-notes`。代价是名字无法体现作者、且要重新配置 `publishConfig` 与 CI。

## 3. 装进 DeepSeek Harness

这个包是一个 **bundle**（带 `cordis.patch.yml`），`pnpm add` 到项目里也不会自动出现在 DSH 插件列表。
两种落地方式：

- **推荐**：在 DSH 里对 Agent 说「从 GitHub Packages 安装 `@javagita-lgtm/dsh-code-notes`」，
  它会用 `plugin_manager` 的 `install_bundle`（`target` 填包名，必要时给 `registry`）完成登记、装包、选 bundle。
  > 前提：该 DSH 进程能读到本机 `~/.npmrc` 里的 token。
- 手动：在该 DSH profile 里 `pnpm add @javagita-lgtm/dsh-code-notes`，把包名加进 profile `package.json` 的
  `dsh.profile.bundles`，再补一条 `cordis.patch.yml` 的 `- id: code-notes` 行（内容可直接抄本目录同名文件）。

装完刷新页面 → 输入框下方 `✦ 讲解` → 填 Obsidian 库目录。

## 4. 升级版本

`npm publish` 不允许覆盖已存在的版本号，所以每次发布都要提版本：

```bash
npm version patch   # 0.2.0 -> 0.2.1（修 bug）
npm version minor   # 0.2.0 -> 0.3.0（加功能）
git push --follow-tags
```

标签推送后 CI 会校验「标签 == package.json version」，不一致直接失败——这正是为了防止「发了 v0.2.1
但包里还是 0.2.0」这种事。

## 5. 排错对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `404 Not Found - GET @javagita-lgtm/dsh-code-notes` | 没配作用域 registry | 第 2 步的 `@javagita-lgtm:registry=...` |
| `401 authentication token not provided` | GitHub Packages 一律要 token（**public 包也要**） | 第 2 步加 `_authToken`；这是平台限制，不是配置错 |
| `npm publish` 报 `ENEEDAUTH` | 本机没登录 | 写 `~/.npmrc` 或用 CI |
| `npm publish` 报 403 + `scope not found` | 包名作用域与登录账号不一致 | 包名必须是 `@登录账号/xxx` |
| `npm publish` 报 E403 权限 | token 缺 `write:packages` | 重建 token 勾上 |
| `EPUBLISHCONFLICT` | 同版本已存在 | 提版本号 |
| 装上了但 DSH 没显示 | 只做了 `pnpm add`，没登记 bundle | 见第 3 步 |
| Actions 不跑 | 组织策略禁用了 workflow | 改手动发布 |
