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

## 你只差一步：给仓库配**勾了 Bypass 2FA** 的 token

**当前状态（2026-10-20 16:50 UTC+8）**：包已上传到一半但被 npm 拒绝，`registry.npmjs.org/dsh-code-notes` 仍是 404。

CI 报错原文：

```
E403 403 Forbidden - PUT https://registry.npmjs.org/dsh-code-notes
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

**这不是权限范围问题，也不是包名问题**（前面的 `Verify` / `Check tag` / `Guard package name` 全绿，
provenance 也签名成功了）。npm 现在的策略是：**发布必须 2FA，或者用勾了「Bypass two-factor authentication」
的 granular token**。你现有的 `NPM_TOKEN` 少了那个勾。

### 重建 token（三处必须全对）

<https://www.npmjs.com/settings/~/tokens> → Generate New Token → **Granular Access Token**：

| 设置项 | 必须的值 | 为什么 |
| --- | --- | --- |
| Permissions | **Read and write** | 只读的发不了 |
| Packages | **All packages** | 首次发布时 `dsh-code-notes` 还不存在，选不到单个包 |
| **Bypass two-factor authentication (2FA)** | **✅ 勾上** | 少了它就是你看到的这个 403 |
| Expiration | 7 天（默认）即可 | 发布完立即删掉/轮换 |

然后把新 token 覆盖到仓库 secret `NPM_TOKEN`（<https://github.com/javagita-lgtm/dsh-code-notes/settings/secrets/actions>），
再重跑：Actions → `publish` → **Run workflow**。

> 我已在工作流里加了前置校验：token 无效会在 `Prepare npm credentials` 直接报「NPM_TOKEN 无效」，
> 不会再走到 publish 才失败；403 时还会打印上面这份对照表。

### 发布成功之后（可选，但推荐）

包能出现在 npmjs 上之后，就可以彻底不用 token 了——配置 **Trusted Publishing（OIDC）**：

1. <https://www.npmjs.com/package/dsh-code-notes/access> → Trusted publishing → Add
2. 填三项，必须与仓库完全一致：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `javagita-lgtm` |
   | Repository | `dsh-code-notes` |
   | Workflow filename | `publish.yml` |

3. 之后**删掉** secret `NPM_TOKEN`，工作流会自动走 OIDC 分支（已内置），不再依赖任何长期密钥。

> npm 不允许用 OIDC **创建**新包，所以第一次必须用 token——这一点工作流里也做了拦截并给出提示。

> `dsh-code-notes` 在 npmjs 上目前仍是 **404 = 未被占用**（已核对）。

## 发布流程（已自动化）

`.github/workflows/publish.yml` 在推送 `v*` 标签（或手动 Run workflow）时：

1. 升级 npm 到最新版（OIDC 需要 ≥ 11.5.1）
2. `node --check` + 四套冒烟测试（纯函数、客户端模块、集成链路、工作流自身）
3. 校验「标签版本 == package.json 版本」
4. 校验包名不带 `@`，且 `publishConfig.registry` 就是 npmjs（防止误发到别处）
5. 探测包是否已存在（决定走 token 还是 OIDC）
6. 有 `NPM_TOKEN` → 先 `npm whoami` 验活，再 `npm publish --provenance --access public`
7. 没 `NPM_TOKEN` 且包已存在 → 走 OIDC Trusted Publishing
8. 没 `NPM_TOKEN` 且包不存在 → 直接报错并提示「首次发布必须用带 Bypass 2FA 的 token」

```bash
npm version patch        # 0.2.0 -> 0.2.1，或 minor / major
git push --follow-tags   # 推标签 ⇒ CI 自动发布
```

也可以手动发（本机已登录、账号已开 2FA 时）：

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
| `403 ... granular access token with bypass 2fa enabled is required` | token 没勾 **Bypass 2FA** | 重建 granular token，勾 Read and write + All packages + Bypass 2FA |
| `403` 但 token 是新建的、也勾了 Bypass | `Packages` 选成了「单个包」，而首次发布时该包不存在 | 改成 **All packages** |
| npm 账号没开 2FA，且不想开 | npm 政策要求发布方有 2FA 或 bypass token | 在 npm 账号开启 2FA，或改用 Trusted Publishing（包首次发布后） |
| `E404` 装不到（刚发完） | npm 对新包有安全扫描，通常几分钟、最长十几分钟才可安装 | 等 5~15 分钟；别重复 publish |
| `EPUBLISHCONFLICT` | 同版本已存在 | 提版本号 |
| `Prepare npm credentials` 报 token 无效 | token 过期/被撤销 | 重建并更新 secret |
| 装上了但 DSH 没显示 | 只 `pnpm add`，没登记 bundle | 见上「装进 DeepSeek Harness」 |

## 从 GitHub Packages 迁过来的历史记录

- `v0.2.0` 曾以 `@javagita-lgtm/dsh-code-notes` 发布到 GitHub Packages（2026-10-20），
  该版本需要 token，现已不推荐使用；公共 npmjs 上会以 `dsh-code-notes` 重新发布。
- GitHub Packages 上的旧包可以保留（无害），也可以到包设置里删除，避免两份入口。
