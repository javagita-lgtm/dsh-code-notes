# 发布到 GitHub Packages 并让别人 `pnpm add` 安装

> 目标形态：包名 `@javagita-lgtm/dsh-code-notes`，源指向 GitHub Packages。
> 仓库：<https://github.com/javagita-lgtm/dsh-code-notes>（已确认为 public 仓库）
> 公开仓库 + 公开包 ⇒ 任何人无需 token 即可安装；私有仓库 ⇒ 安装者需要自己的 GitHub token。

本仓库已备好这些文件，你只需要替换占位符并执行几步：

| 文件 | 作用 |
| --- | --- |
| `package.json` | 已去掉 `private`，名字是作用域包，`publishConfig.registry` 指向 GitHub Packages |
| `.github/workflows/publish.yml` | 打 `v*` 标签 ⇒ 自动校验 + 发布 |
| `.gitignore` / `.npmignore` / `LICENSE` | 仓库与发布包的干净边界、许可证 |

## 0. 先理解三个概念（这决定别人能不能直接装）

- **作用域包（scoped package）**：`@用户名/包名`。GitHub Packages 的 npm 源**强制**要作用域，
  所以不能叫 `dsh-code-notes`，只能叫 `@javagita-lgtm/dsh-code-notes`。
- **公开 / 私有包（visibility）**：GitHub Packages 的 npm 包分两种。与**公开仓库**关联、且发布为公开的包，
  匿名可下载；只在私有仓库里发布的包，下载者必须用有 `read:packages` 权限的 token 登录。
- **registry 覆盖**：作用域包默认会被 npm 当成「该去 npmjs 找」的包，所以安装方要告诉 pnpm
  「`@javagita-lgtm` 这个作用域走 GitHub Packages」，否则会 404。

## 1. 一次性准备（发布者）

1. 公开仓库已经建好：`javagita-lgtm/dsh-code-notes`（默认分支 `main`，当前为空仓库）。
2. 在仓库根目录推首次提交并打标签：

```bash
git init
git add .
git commit -m "feat: dsh-code-notes 0.2.0"
git branch -M main
git remote add origin https://github.com/javagita-lgtm/dsh-code-notes.git
git push -u origin main
git tag v0.2.0
git push origin v0.2.0
```

推送标签后，Actions 会跑 `node --check` + 三套测试 + 版本号校验，然后
`npm publish` 到 GitHub Packages（用内置的 `GITHUB_TOKEN`，不需要另建 secret）。

**手动发布**（不想用 CI，或 Actions 被策略禁用时）：

```bash
# 1) 建一个 classic token，勾选 write:packages（会自动带上 read:packages）
# 2) 写入本机 ~/.npmrc（不要写进仓库！）
#    //npm.pkg.github.com/:_authToken=<TOKEN>
npm publish
```

> 注意：发布前确认包已关联到仓库（`package.json` 的 `repository` 字段已填），
> 否则包里标签和仓库对不上、无法设成公开。

## 2. 别人怎么装（写进你的 README 首发说明）

**公开仓库 + 公开包（推荐给使用者）**

```bash
# ① 告诉 pnpm/npm：这个作用域走 GitHub Packages
cat >> ~/.npmrc <<'EOF'
@javagita-lgtm:registry=https://npm.pkg.github.com
EOF

# ② 安装
pnpm add @javagita-lgtm/dsh-code-notes
```

**私有仓库 / 私有包（每个安装者都要 token）**

```bash
# 建 classic token，勾 read:packages
cat >> ~/.npmrc <<'EOF'
@javagita-lgtm:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<安装者自己的 TOKEN>
EOF

pnpm add @javagita-lgtm/dsh-code-notes
```

Windows 上 `~/.npmrc` 就是 `%USERPROFILE%\.npmrc`。

## 3. 装进 DeepSeek Harness

这个包是一个 **bundle**（带 `cordis.patch.yml`），`pnpm add` 到项目里也不会自动出现在 DSH 插件列表。
两种落地方式：

- **推荐**：在 DSH 里对 Agent 说「从 npm 安装 `@javagita-lgtm/dsh-code-notes`，源是 GitHub Packages」，
  它会用 `plugin_manager` 的 `install_bundle`（`target` 填包名，必要时给 `registry`）完成登记、装包、选 bundle。
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
| `401 Unauthorized` | 私有包没 token / token 缺 `read:packages` | 补 token 或改公开包 |
| `npm publish` 报 `ENEEDAUTH` | 本机没登录 | 写 `~/.npmrc` 或用 CI |
| `npm publish` 报 403 + `scope not found` | 包名作用域与登录账号不一致 | 包名必须是 `@登录账号/xxx` |
| `npm publish` 报 E403 权限 | token 缺 `write:packages` | 重建 token 勾上 |
| `EPUBLISHCONFLICT` | 同版本已存在 | 提版本号 |
| 装上了但 DSH 没显示 | 只做了 `pnpm add`，没登记 bundle | 见第 3 步 |
| Actions 不跑 | 组织策略禁用了 workflow | 改手动发布 |
