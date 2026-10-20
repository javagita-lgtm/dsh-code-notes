# 代码讲解笔记（dsh-code-notes）

> 仓库：<https://github.com/javagita-lgtm/dsh-code-notes> · 包名 `@javagita-lgtm/dsh-code-notes`
> 发布到 GitHub Packages 让别人 `pnpm add` 安装的完整步骤见 [`docs/publish-github-packages.md`](docs/publish-github-packages.md)；
> 只想装到另一台机器（拷目录或 tgz）见 [`docs/install-other-machine.md`](docs/install-other-machine.md)。

边编码边讲解：AI 每改一次代码，插件就通过**旁路模型调用**把改动讲成业务逻辑说明，
并同时落成四种 Obsidian 形态：

| 形态 | 文件 | 说明 |
| --- | --- | --- |
| 讲解笔记 | `<vault>/<folder>/<时间>-<标题>.md` | frontmatter + 业务逻辑 + 要点 + 风险 + 原文对照，含 `[[双链]]` |
| 流程图 | 笔记内 ` ```mermaid ` 块 | Obsidian 原生渲染（Mermaid 官方支持） |
| 思维图 | 笔记内 ` ```markmap ` 块 | 装 Markmap 插件即可渲染成可折叠思维树；没装也能当大纲读 |
| 画布 | `<vault>/<folder>/<时间>-<标题>.canvas` | Obsidian 原生 Canvas（JSON），讲解卡 / 文件卡 / 流程卡 / 思维卡 + 连线 |
| 索引 | `<vault>/<folder>/_index.md` | 所有讲解笔记的双链目录，按时间倒序 |

Harness 侧在输入框下方有一个「讲解」入口，展开是内联面板：
讲解历史、业务逻辑 / 调用流程 / 改动差异三个页签、复制 Markdown、写入 vault、用 `obsidian://` 直达。

## 第一次使用

1. 聊天页输入框下方点「✦ 讲解」。
2. 因为还没配置 Obsidian 库目录，面板会直接显示设置表单：
   - **Obsidian 库目录**：选中含 `.obsidian` 文件夹的那个目录（例如 `D:/Notes/MyVault`）
   - **写入子目录**：默认 `CodeNotes`
   - **触发方式**：自动 / 手动
   - **讲解模型**（可选）：留空跟随当前会话模型
3. 点「保存设置」。设置会写回 profile 的 `cordis.patch.yml` 中 `id: code-notes` 这一段，重启不丢。

> 也可以不去面板，直接编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里的 `- id: code-notes` 行。

## 三种触发方式

1. **自动**（默认）：每次 AI 写文件/改文件后，等待 2.5 秒合并成一条讲解，串行生成，不阻塞主任务。
2. **命令**：在输入框发送 `/讲解 [文件路径 或 关注点]`。
3. **工具**：模型在需要留档时调用 `explain_code_change`（可选 `focus` / `files`）。

## 设置项

设置写在 bundle patch 的 `config`（见根目录 `cordis.patch.yml`），面板保存时合并写回 profile 的同一段。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `auto` | `auto` 自动旁路讲解；`manual` 只响应命令/工具 |
| `vaultPath` | `''` | Obsidian 库根目录（含 `.obsidian` 的目录）。**必填**才会落盘，支持 `~` |
| `folder` | `CodeNotes` | vault 下的子目录 |
| `provider` / `model` | `''` | 旁路模型路由；留空依次回退到「当前会话模型 → 宿主默认模型」 |
| `maxFileChars` | `24000` | 单文件最多读多少字符 |
| `maxFilesPerNote` | `6` | 一次讲解最多合并多少个文件 |
| `timeoutMs` | `120000` | 旁路调用超时 |
| `maxOutputTokens` | `4096` | 输出上限 |
| `writeCanvas` | `true` | 是否生成 `.canvas` |
| `linkNotes` | `true` | 是否写 `[[双链]]` |
| `writeIndex` | `true` | 是否维护 `_index.md` |
| `historyLimit` | `40` | 会话内保留的讲解条数（进程内） |

## 自检

面板不出现、或没生成笔记时，先看这几个只读接口（本机、无需登录）：

```text
GET  /api/dsh-code-notes/selftest           # 插件是否活着、版本、解析器、各会话待讲解数
GET  /api/dsh-code-notes/settings           # 当前生效的配置（含 vault 解析结果）
GET  /api/dsh-code-notes/history?sessionId= # 本会话的讲解记录
POST /api/dsh-code-notes/explain            # { sessionId } 立即讲解一次
```

`selftest` 返回的 `version` 用来确认浏览器/Host 跑的是不是你刚装的那一版。
浏览器端还可以在 DevTools 里看 `[data-cn-diag]` 属性，里面是「接口有没有回、配置读到没有」的摘要，
以及控制台里 `client-modules` 的加载失败信息。

## 工作范围

- 只对「看起来像代码/配置」的路径讲解；`node_modules`、`dist`、`.git`、venv 等目录自动跳过。
- vault 里生成的笔记不会被当成代码改动，避免递归讲解。
- 讲解只读取改动文件的**当前正文**与**工具结果里的 before/after**，不额外扫全仓。
- 讲解稿只存在于 Host 内存（按会话），重启后可从 vault 笔记里找回文本。

## 目录

```
index.js             Host 入口：配置、tools/result 捕获、/讲解 命令、explain_code_change 工具、路由
client.js            浏览器半区：输入框下「讲解」入口 + 内联面板 + 内联设置表单
lib/service.js       讲解服务：路由选择、旁路调用、写文件、自检
lib/prompt.js        系统提示、输入组装、JSON 解析
lib/changes.js       工具结果 → 文件改动
lib/obsidian.js      Markdown / Markmap / Canvas / 索引序列化
lib/routes.js        /api/dsh-code-notes/* 本机同源接口
test/*.mjs           纯函数、集成、patch 写回、客户端模块冒烟
```
