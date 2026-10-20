# 发布到公共 npmjs 并让别人 `pnpm add` 安装

> 目标形态：包名 `dsh-code-notes`（**不带作用域**），源是 <https://registry.npmjs.org>。
> 这样任何人只要 `pnpm add dsh-code-notes`，**无需 token、无需 .npmrc**。

## 为什么改回不带作用域

GitHub Packages 的 npm 源**强制**作用域包，而且官方文档写明「public 包也需要 token」，
本项目实测匿名 `npm view` 返回 `401 authentication token not provided`。
公共 npmjs 上没有这个限制，代价是：

| | GitHub Packages | 公共 npmjs |
| --- | --- | --- |
| 包名 | 必须 `@javagita-lgtm/dsh-code-notes` | `dsh-code-notes` |
| 安装命令 | 要 `.npmrc` 配 registry + token | `pnpm add dsh-code-notes` |
| 匿名可装 | ❌ | ✅ |
| 代码可见 | 仓库公开即公开 | 包内容公开（本仓库本来就是公开的） |

## 你只差一步：给仓库配 `NPM_TOKEN`

**当前状态（2026-10-20）**：代码已切到 npmjs 配置并推送（`4459450`），标签 `v0.2.0` 已重打，
CI 运行到第 7 步 **`Check npm token` 失败** —— 仓库里还没有 `NPM_TOKEN`，所以包尚未出现在 npmjs
（`https://registry.npmjs.org/dsh-code-notes` 仍是 404）。配好 secret 后重跑即可，无需再改代码。

CI 用的是 npm 官方 token，不是 `GITHUB_TOKEN`（后者只在 GitHub Packages 有效）：

1. 去 <https://www.npmjs.com/settings/~/tokens> 建一个 **Granular Access Token**
   （或 classic **Automation** token）：
   - 权限：`Read and write`
   - 范围：至少覆盖 `dsh-code-notes`
2. 在 <https://github.com/javagita-lgtm/dsh-code-notes/settings/secrets/actions>
   新建仓库 secret，名字必须是 **`NPM_TOKEN`**，值粘贴上面的 token。
3. 重跑发布（任选其一）：
   - Actions 页面 → `publish` → **Run workflow**（已支持 `workflow_dispatch`）
   - 或 `git tag -d v0.2.0 && git tag v0.2.0 && git push --force origin v0.2.0`

> 第一次发布时 npm 会让你确认包名可用；`dsh-code-notes` 在 npmjs 上目前 **404 = 未被占用**（已核对）。

## 发布流程（已自动化）

`.github/workflows/publish.yml` 在推送 `v*` 标签时：

1. `node --check` + 三套冒烟测试（纯函数、客户端模块、集成链路）
2. 校验「标签版本 == package.json 版本」
3. 校验包名不带 `@`，且 `publishConfig.registry` 就是 npmjs（防止误发到别处）
4. `npm publish --provenance --access public`（带 provenance，npm 页面会显示构建来源）

```bash
npm version patch        # 0.2.0 -> 0.2.1，或 minor / major
git push --follow-tags   # 推标签 ⇒ CI 自动发布
```

也可以手动发（本机一次性登录）：

```bash
npm login                # 浏览器授权
npm publish --access public
```

## 别人怎么装

```bash
pnpm add dsh-code-notes
```

**装进 DeepSeek Harness**：`pnpm add` 只把包放进项目，DSH 还需要登记 bundle。
在 DSH 里说：

> 从 npm 安装 `dsh-code-notes`

Agent 会用 `plugin_manager` 的 `install_bundle`（`target: dsh-code-notes`）完成装包与 bundle 选择；
也可以在该 profile 里 `pnpm add dsh-code-notes` 后，把包名加进 profile `package.json` 的
`dsh.profile.bundles`，并补一条 `cordis.patch.yml` 的 `- id: code-notes`（内容抄本仓库同名文件）。

装完刷新页面 → 输入框下方 `✦ 讲解` → 填 Obsidian 库目录。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `403 Two-factor authentication required` | npm 账号开了 2FA 且用 classic token 发布 | 用 **Automation** token 或 granular token |
| `403 You do not have permission to publish` | token 权限不足 / 包名已被他人占用 | 检查 token 范围，或换包名 |
| `E404` 装不到 | 包还没发布成功 | 看 Actions 里 `Publish to npmjs` 日志 |
| `EPUBLISHCONFLICT` | 同版本已存在 | 提版本号 |
| Actions `NPM_TOKEN not found` | 没配仓库 secret | 按上一节配 secret |
| 装上了但 DSH 没显示 | 只 `pnpm add`，没登记 bundle | 见上「装进 DeepSeek Harness」 |

## 从 GitHub Packages 迁过来的历史记录

- `v0.2.0` 曾以 `@javagita-lgtm/dsh-code-notes` 发布到 GitHub Packages（2026-10-20），
  该版本需要 token，现已不推荐使用；公共 npmjs 上会以 `dsh-code-notes` 重新发布。
- GitHub Packages 上的旧包可以保留（无害），也可以到包设置里删除，避免两份入口。
