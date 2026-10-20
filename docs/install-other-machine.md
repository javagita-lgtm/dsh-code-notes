# 跨机器安装 dsh-code-notes

目标：在**另一台电脑**上把「代码讲解 → Obsidian」插件装进它自己的 DeepSeek Harness，
行为一致、配置项一致。

一台机器上，插件由三部分组成，缺一不可：

| 组成 | 在哪 | 为什么需要 |
| --- | --- | --- |
| 插件包 | `~/.dsh/profiles/<profile>/node_modules/dsh-code-notes` | Host 半区（捕获改动、调模型、写文件）与浏览器半区（讲解面板）都在包里 |
| bundle 登记 | 该 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`） | 让 Loader 知道要加载这个包 |
| patch 行 | 该 profile 的 `cordis.patch.yml` 里的 `- id: code-notes` | 开启插件并保存它的设置（vault 路径等） |

有两种运法：**放进源码目录**（最省事，推荐）或**用压缩包安装**（对方只拿到一个 tgz，Git / 源码都不需要）。

---

## 方案 A（推荐）：把源码目录拷到新机器，按路径安装

1. 复制整个目录 `G:\study\diy-pl`（不含 `dist/`、`node_modules/` 也可以，包里没有运行时依赖）。
   建议放到新机器的固定位置，例如 `D:\dsh-plugins\diy-pl`。
2. 在新机器上打开一个 DSH 会话，对 Agent 说：

   > 把这个目录安装成当前 profile 的插件：`D:\dsh-plugins\diy-pl`
   > （Agent 会调用 `plugin_manager` 的 `install_bundle`，参数 `target` 就是这个绝对路径）

   或者自己在插件市场「从本地目录安装」里选这个目录。
3. 装完刷新页面，输入框下方会出现 `✦ 讲解`；点开后填 **Obsidian 库目录** → 保存。

这种方式对源码目录是 **link**（软链），以后你在该目录里更新代码，重启 DSH 就是新版本。

---

## 方案 B：用压缩包安装（只需要一个 37 KB 的 tgz）

源码目录里执行 `npm pack --pack-destination dist` 即可生成
`dist/dsh-code-notes-0.2.0.tgz`（14 个文件，含 LICENSE）。
> 包已发布到公共 npmjs 之后，最省事的是直接 `pnpm add dsh-code-notes`
> （见 [`publish-to-npm.md`](publish-to-npm.md)）；下面这条是离线/内网场景的备选。

1. 把 tgz 拷到新机器，例如 `D:\dsh-plugins\dsh-code-notes-0.2.0.tgz`。
2. 对 Agent 说：

   > 用 plugin_manager 安装 `D:\dsh-plugins\dsh-code-notes-0.2.0.tgz`
   > （`action: install_bundle`，`target` 填这个 tgz 的绝对路径）

   如果是 npm 风格安装，等价的命令行等价物是
   `pnpm add <tgz 路径>` + 把包名加进 bundle 列表，但**优先让 plugin_manager 做**，
   它会同时处理登记与 bundle 选择。
3. 因为这是 **copy** 安装（不是 link），以后升级要重新用新的 tgz 安装 / 覆盖。

> 包发布到公共 npmjs 之后，也可以直接 `pnpm add dsh-code-notes`：
> 详见 [`publish-to-npm.md`](publish-to-npm.md)。

---

## 装完之后的检查（两边都要做的三步）

1. 刷新页面，找到 `✦ 讲解` 按钮。
2. 在浏览器里打开（本机、无需登录）：
   `http://127.0.0.1:<端口>/api/dsh-code-notes/selftest`
   看到 `"alive": true, "version": "0.2.0", "probe": {"parser":"ok","codePath":true}` 就说明 Host 半区正常。
3. 点开面板填 **Obsidian 库目录**（含 `.obsidian` 的那个文件夹）→ 保存。
   保存结果会写进新机器 profile 的 `cordis.patch.yml`。

新机器如果要自动生成笔记，还需要：
- 至少配好一个聊天模型（设置 → 模型），插件默认跟随「当前会话模型」；
- 想让成本更低，可在面板「讲解模型」里固定成便宜的组合。

---

## 可能的坑

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板不出现 | 先刷新页面；再在控制台搜 `client-modules`，加载失败会点名包名 |
| `selftest` 404 | Host 半区没激活：确认 profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-code-notes` |
| 新机器已装旧版本 | link 安装：在源码目录改完 → 重启 DSH；tgz 安装：重新装新 tgz |
| 笔记没写进 Obsidian | `selftest` 里看 `config.vaultPath` / `vaultResolved` 是否为空；面板设置里补上 |
| 完全不想联网 | 模型调用是插件唯一的出网行为；笔记落盘、Markdown/Mermaid/Markmap/Canvas 全在本机完成 |
