# 发布到公共 npmjs 并让别人 `pnpm add` 安装

> 目标：包名 `dsh-code-notes`（不带作用域），源 <https://registry.npmjs.org>
> —— 任何人 `pnpm add dsh-code-notes`，**无需 token、无需 .npmrc**。

## 根因已定位（2026-10-20，本地 + CI 都是同一个）

本地 `npm login`（账号 `hansdeemo`）后执行 `npm publish` 仍然 403，并被真实接口确认：

```
账号  hansdeemo
tfa   false          ← 账号没有开启 2FA
token publish_token  ← bypass_2fa: false
```

```
403 Forbidden - PUT https://registry.npmjs.org/dsh-code-notes
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

**结论：这是账号级问题，与仓库、代码、token 内容都无关。**
npm 的规则是二选一，你现在 **两项都不满足**：

| 条件 | 你的状态 |
| --- | --- |
| 账号已开启 2FA（发布时输 OTP） | ❌ `tfa: false` |
| token 带 `bypass_2fa`（CI 免 OTP） | ❌ `bypass_2fa: false` |

而且两个是**依赖关系**：账号没开 2FA 时，token 上的「Bypass two-factor authentication」勾选根本不会生效。
所以「换个 token 再试」永远解决不了，必须先开账号 2FA。

随时可以用仓库里的体检脚本自查（只读、不打印 token）：

```bash
node scripts/check-npm-2fa.mjs      # 读 NPM_TOKEN 或 ~/.npmrc
```

## 修复步骤（先做第 1 步，其余才生效）

1. **开启账号 2FA**：<https://www.npmjs.com/settings/~/account> → Two-Factor Authentication → Enable
   （用任意 TOTP App，如 1Password / Authy / 微软验证器）
2. 开启后二选一：
   - **本地发布**：`npm publish --access public`，按提示输入 OTP（最省事，推荐先做一次）
   - **CI 发布**：<https://www.npmjs.com/settings/~/tokens> 新建 Granular Access Token，
     `Read and write` + `All packages` + **勾 Bypass 2FA**，然后更新仓库 secret `NPM_TOKEN`
3. 包第一次出现后，配置 Trusted Publishing 彻底摆脱 token：
   <https://www.npmjs.com/package/dsh-code-notes/access> → Trusted publishing → Add
   - Organization or user: `javagita-lgtm`
   - Repository: `dsh-code-notes`
   - Workflow filename: `publish.yml`
4. 删掉仓库 secret `NPM_TOKEN`（工作流会自动走 OIDC）

## 临时替代通道：暂存发布（已验证可用）

npm 12 的 `npm stage publish` 允许在没有 2FA 的情况下把版本推进待批准队列，
已在本次实测成功（stag id `8e737970…`，状态从 `validating` → `staged`）：

```bash
npm i -g npm@12
npm stage publish --access public
npm stage list
```

但**批准这一步（`npm stage approve <id>`）仍然需要 2FA**：现在调用会返回
`404 staged version not found`（服务端在缺 OTP 时给出的其实是「你看不到这个对象」）。
所以开完账号 2FA 后，这条通道也可以用来「CI 暂存 + 你在网页批准」：

- Actions → `publish` → Run workflow → `strategy: staged`

## 当前待办

- [ ] 账号 `hansdeemo` 开启 2FA
- [ ] 本地 `npm publish --access public` 完成首次发布（或配置 Bypass token 后跑 CI）
- [ ] 配置 Trusted Publishing，删除 `NPM_TOKEN`
- [ ] 发布后验证：干净目录 `pnpm add dsh-code-notes` 能匿名装上

## 方案 A：本地交互发布一次（开完 2FA 后最快）

CI 不需要处理 2FA，你在终端里输一次 OTP 就行。**发布过一次之后**，包就存在了，
后续就能交给 Trusted Publishing（OIDC）自动发布。

```bash
# 1) 本机登录（浏览器授权）
npm login

# 2) 确认账号
npm whoami

# 3) 在仓库根目录发布（会提示输入一次性验证码 OTP）
npm publish --access public
```

> 如果本机 `npm whoami` 也报 401/403，说明是账号层面的问题，先修账号 2FA：
> <https://www.npmjs.com/settings/~/account> → Two-Factor Authentication → Enable。
> 开了 2FA 之后 https://www.npmjs.com/settings/~/tokens 里的 token 才会有 Bypass 选项。

发布成功后立刻：

```bash
# 4) 配置 Trusted Publishing，从此 CI 不需要任何 token
#    https://www.npmjs.com/package/dsh-code-notes/access → Trusted publishing → Add
#      Organization or user : javagita-lgtm
#      Repository           : dsh-code-notes
#      Workflow filename     : publish.yml
# 5) 删掉仓库 secret NPM_TOKEN（可选，但推荐）
```

之后推 `v*` 标签，CI 会自动走 OIDC 分支（工作流已内置）。

## 方案 B：继续用 token（需要账号已开 2FA）

<https://www.npmjs.com/settings/~/tokens> → Generate New Token → **Granular Access Token**：

| 设置项 | 值 |
| --- | --- |
| Permissions | **Read and write** |
| Packages | **All packages**（首次发布时包还不存在，选不到单个包） |
| **Bypass two-factor authentication (2FA)** | **✅ 勾**（账号没开 2FA 时这个勾不生效） |
| Expiration | 7 天即可 |

更新仓库 secret `NPM_TOKEN`（新建 token ≠ 更新 secret，务必确认覆盖成功），
然后 Actions → `publish` → **Run workflow** → `strategy: token`。

## 方案 C：暂存发布（CI 只 stage，网页用 2FA 批准）

npm 2026 年推出的 staged publishing 专为「CI 无法交互 2FA」设计：
CI 把版本推进待批准队列，维护者在 npm 网页点一下批准。

- Actions → `publish` → **Run workflow** → `strategy: staged`
- 然后到 `https://www.npmjs.com/package/dsh-code-notes` 用 2FA 批准这一版

> 该能力需要较新的 npm CLI；工作流里已经 `npm install -g npm@latest`，
> 若仍提示不支持，说明当前 runner 的 npm 还没带上 `npm stage` 子命令。

## 工作流的四种发布方式

`.github/workflows/publish.yml` 支持 `workflow_dispatch` 选 `strategy`：

| strategy | 行为 |
| --- | --- |
| `auto`（默认） | 有 `NPM_TOKEN` 就用 token；没有且包已存在则走 OIDC |
| `token` | 强制用 `NPM_TOKEN` |
| `oidc` | 强制 Trusted Publishing（包必须已存在） |
| `staged` | 暂存发布，等网页 2FA 批准 |
| `dry-run` | 只 `npm publish --dry-run`，校验打包内容 |

每次运行都会：`node --check` + 四套冒烟测试 → 版本/标签一致性 → 包名与 registry 守卫 →
注册表状态探测 → 凭据验活（不打印 token）→ 发布。

## 别人怎么装（发布成功后）

```bash
pnpm add dsh-code-notes
```

**装进 DeepSeek Harness**：在 DSH 里说「从 npm 安装 `dsh-code-notes`」，
`plugin_manager` 的 `install_bundle` 会完成装包与 bundle 选择；
也可手动 `pnpm add dsh-code-notes` 后把包名加进 profile `package.json` 的 `dsh.profile.bundles`，
并补一条 `cordis.patch.yml` 的 `- id: code-notes`。

装完刷新页面 → 输入框下方 `✦ 讲解` → 填 Obsidian 库目录。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `403 ...bypass 2fa enabled is required`（token 全新、也勾了 Bypass） | **npm 账号本身没开 2FA**，Bypass 标记不生效 | 先开账号 2FA，或走方案 A 本地交互发布 |
| `403` 且 token 是新建的 | secret 没真正更新 | 到仓库 Secrets 页面确认更新时间，改完重跑 |
| `Packages` 选成了单个包 | 首次发布时该包不存在，选不到 | 改成 **All packages** |
| `E404` 装不到（刚发完） | npm 对新包有安全扫描，几分钟到十几分钟 | 等 5~15 分钟，别重复 publish |
| `EPUBLISHCONFLICT` | 同版本已存在 | 提版本号 |
| `Prepare npm credentials` 报 token 无效 | token 过期/撤销/粘贴错 | 重建并更新 secret |
| 装上了但 DSH 没显示 | 只 `pnpm add`，没登记 bundle | 见上「装进 DeepSeek Harness」 |

## 背景：为什么不是 GitHub Packages

`@javagita-lgtm/dsh-code-notes` 曾在 2026-10-20 发布到 GitHub Packages，
但 GitHub Packages 的 npm 源**即使是 public 包也强制 token**（匿名 `npm view` 返回 401，
官方文档确认）。为了做到「一条命令、无需 token」，才改成公共 npmjs + 不带作用域的包名。
GitHub Packages 上的旧包可以保留，也可以到包设置里删除，避免两套入口。
