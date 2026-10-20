/**
 * 讲解服务：改动捕获 → 组装输入 → 旁路调模型 → 解释稿 → 落 Obsidian。
 *
 * 三条入口（网页面板、Agent 工具、/讲解 命令）最终都落到这里的同一组方法，
 * 保证「一份操作只有一份实现」。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import { SYSTEM_PROMPT, buildUserPrompt, parseExplainer } from './prompt.js';
import { buildCanvas, noteNameOf, renderIndex, renderMarkdown } from './obsidian.js';
import { languageOf } from './obsidian.js';
import { changesFromToolResult, diffStats } from './changes.js';

const MAX_NOTE_CHARS = 16000;
const MAX_DIFF_CHARS = 6000;

/** 只对「明显是代码/配置」的扩展名做讲解，避免把图片、日志等噪声喂给模型。 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'fs', 'rb', 'php', 'swift', 'scala', 'dart',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'm', 'mm', 'lua', 'r', 'jl', 'ex', 'exs', 'clj', 'zig',
  'sql', 'graphql', 'gql', 'proto', 'sh', 'bash', 'ps1', 'bat', 'cmd',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss', 'less',
  'md', 'mdx', 'txt', 'sol', 'tf', 'dockerfile'
]);

/** 明显不属于业务代码的路径片段（依赖、构建产物、模型自身生成的笔记目录）。 */
const SKIP_SEGMENTS = [
  '/node_modules/', '/.git/', '/dist/', '/build/', '/out/', '/coverage/', '/.next/', '/.nuxt/',
  '/.venv/', '/venv/', '/__pycache__/', '/.cache/', '/target/debug/', '/target/release/'
];

/** 去掉 Windows 长路径前缀，便于和会话 cwd 拼接。 */
function normalizeHostPath(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

/**
 * 把工具给出的路径解析成绝对路径。fs 工具 meta.path 一般是执行世界的绝对路径，
 * 但也可能带 file:// 前缀，这里统一兜底。
 */
function absolutePathOf(value, cwd) {
  let raw = normalizeHostPath(value);
  if (raw.startsWith('file://')) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
      if (/^\/[a-zA-Z]:\//u.test(raw)) raw = raw.slice(1);
    } catch {
      return undefined;
    }
  }
  if (raw === '') return undefined;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd ?? process.cwd(), raw);
  return absolute.replace(/\//gu, path.sep);
}

const isCodePath = (absolute) => {
  const normalized = `/${absolute.replace(/\\/gu, '/')}`;
  const lower = normalized.toLowerCase();
  if (SKIP_SEGMENTS.some((segment) => lower.includes(segment))) return false;
  const base = path.basename(lower);
  if (base === 'dockerfile' || base === 'makefile') return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return CODE_EXTENSIONS.has(ext);
};

/** 供内部与自检使用：该路径是否会被当作代码改动。 */
export { isCodePath };

const toRelative = (absolute, cwd) => {
  const relative = path.relative(cwd ?? absolute, absolute);
  return (relative === '' ? path.basename(absolute) : relative).replace(/\\/gu, '/');
};

const nowIso = () => new Date().toISOString();

const stampOf = (iso) => String(iso).replace(/[-:]/gu, '').replace('T', '-').replace(/\..+$/u, '');

/** 把多段补丁合并成一条，统计总量。 */
function mergePatches(parts) {
  const patch = parts.filter((part) => typeof part === 'string' && part.trim() !== '').join('\n');
  return patch.length > MAX_DIFF_CHARS ? `${patch.slice(0, MAX_DIFF_CHARS)}\n…（diff 已截断）` : patch;
}

/**
 * 讲解服务。
 */
export class ExplainerService {
  /**
   * @param ctx Host context
   * @param options.readConfig 读取合并后的配置
   * @param options.saveConfig 持久化 GUI 设置
   */
  constructor(ctx, options) {
    this.ctx = ctx;
    this.readConfig = options.readConfig;
    this.saveConfig = options.saveConfig;
    /** sessionId → { changes: Map<path, record>, notes: [], running: Set<string> } */
    this.sessions = new Map();
  }

  /** 对外暴露的配置（不含任何密钥）。 */
  publicConfig() {
    const config = this.readConfig();
    return {
      alive: true,
      version: '0.2.0',
      enabled: config.enabled,
      mode: config.mode,
      vaultPath: config.vaultPath ?? '',
      vaultResolved: this.resolveVault(config),
      folder: config.folder,
      provider: config.provider ?? '',
      model: config.model ?? '',
      maxFileChars: config.maxFileChars,
      maxFilesPerNote: config.maxFilesPerNote,
      writeCanvas: config.writeCanvas,
      linkNotes: config.linkNotes,
      writeIndex: config.writeIndex
    };
  }

  /** 进程内自检：不触网、不调模型，只回答「插件是否活着、捕获链路是否通」。 */
  selfTest() {
    const config = this.readConfig();
    const sample = changesFromToolResult('write', { file_path: 'probe.ts' }, {
      isError: false,
      meta: { path: 'probe.ts', operation: 'create', before: null, after: 'export const probe = 1;' }
    });
    const probePath = path.resolve(this.vaultRoot ?? process.cwd(), 'probe.ts');
    return {
      alive: true,
      version: '0.2.0',
      now: new Date().toISOString(),
      config: this.publicConfig(),
      sessions: [...this.sessions.entries()].map(([id, state]) => ({
        sessionId: id,
        pending: state.changes.size,
        notes: state.notes.length,
        autoQueued: state.autoQueued === true
      })),
      probe: {
        parser: sample.length === 1 ? 'ok' : 'no-records',
        codePath: isCodePath(probePath)
      }
    };
  }

  /** 保存 GUI 设置（合并到 patch 行配置）。 */
  async saveSettings(patch) {
    const allowed = ['enabled', 'mode', 'vaultPath', 'folder', 'provider', 'model', 'maxFileChars', 'maxFilesPerNote', 'writeCanvas', 'linkNotes', 'writeIndex'];
    const next = {};
    for (const key of allowed) {
      if (patch !== null && typeof patch === 'object' && Object.hasOwn(patch, key)) next[key] = patch[key];
    }
    await this.saveConfig(next);
    return this.publicConfig();
  }

  /** 会话级状态（惰性创建）。 */
  stateOf(sessionId) {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { changes: new Map(), notes: [], running: new Set() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** 记录一次工具调用带来的文件改动（由 `tools/result` 监听器调用）。 */
  observeToolResult(sessionId, cwd, toolName, args, result) {
    this.observeDetailed(sessionId, cwd, toolName, args, result);
  }

  /**
   * 与 {@link observeToolResult} 相同，但返回每个记录的判定原因，
   * 供 `/api/dsh-code-notes/selftest` 定位「为什么没捕获到」。
   */
  observeDetailed(sessionId, cwd, toolName, args, result) {
    const report = { sessionId, tool: toolName ?? 'unknown', records: [], accepted: [], rejected: [], error: undefined };
    if (!this.readConfig().enabled) {
      report.error = 'disabled';
      return report;
    }
    let records;
    try {
      records = changesFromToolResult(toolName, args, result);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      console.warn(`[dsh-code-notes] 解析 ${toolName} 结果失败：${report.error}`);
      return report;
    }
    report.records = records.map((record) => record.path);
    if (records.length === 0) return report;
    const state = this.stateOf(sessionId);
    const vault = this.resolveVault(this.readConfig());
    for (const record of records) {
      const absolute = absolutePathOf(record.path, cwd);
      if (absolute === undefined) {
        report.rejected.push({ path: record.path, reason: 'unresolved-path' });
        continue;
      }
      if (!isCodePath(absolute)) {
        report.rejected.push({ path: record.path, reason: 'not-code-path' });
        continue;
      }
      // 不要把写进 vault 的笔记本身当成代码改动，否则会自己解释自己。
      if (vault !== undefined && path.resolve(absolute).toLowerCase().startsWith(path.resolve(vault).toLowerCase())) {
        report.rejected.push({ path: record.path, reason: 'inside-vault' });
        continue;
      }
      const relative = toRelative(absolute, cwd);
      const existing = state.changes.get(absolute);
      if (existing === undefined) {
        state.changes.set(absolute, {
          absolute,
          path: relative,
          status: record.status === 'created' ? 'created' : record.status,
          patches: [record.diff],
          added: record.added,
          removed: record.removed,
          seenAt: nowIso()
        });
      } else {
        existing.patches.push(record.diff);
        existing.added += record.added;
        existing.removed += record.removed;
        if (record.status === 'deleted') existing.status = 'deleted';
        existing.seenAt = nowIso();
      }
      report.accepted.push(relative);
    }
    return report;
  }

  /** 当前会话捕获到的改动摘要（给面板展示）。 */
  changesOf(sessionId) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return [];
    return [...state.changes.values()].map((change) => ({
      path: change.path,
      status: change.status,
      added: change.added,
      removed: change.removed,
      seenAt: change.seenAt
    }));
  }

  /** 讲解历史（不含大字段的可选裁剪）。 */
  history(sessionId) {
    if (sessionId === undefined) {
      return [...this.sessions.values()].flatMap((state) => state.notes.map((note) => ({ ...note, explainer: note.explainer })));
    }
    const state = this.sessions.get(sessionId);
    return state === undefined ? [] : state.notes.map((note) => ({ ...note }));
  }

  /** 删除一条讲解（只删会话内记录，不动 vault 文件）。 */
  remove(sessionId, noteId) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return [];
    state.notes = state.notes.filter((note) => note.id !== noteId);
    return state.notes.map((note) => ({ ...note }));
  }

  /** 解析 vault 路径（支持 `~`、以及直接指向 .obsidian 的误配）。 */
  resolveVault(config) {
    const raw = typeof config.vaultPath === 'string' ? config.vaultPath.trim() : '';
    if (raw === '') return undefined;
    let value = raw;
    if (value.startsWith('~')) value = path.join(os.homedir(), value.slice(1));
    return path.resolve(value);
  }

  /** 选择模型路由：配置 → 会话当前模型 → 宿主默认模型。 */
  async resolveRoute(sessionId) {
    const config = this.readConfig();
    const explicit = {
      provider: typeof config.provider === 'string' ? config.provider.trim() : '',
      model: typeof config.model === 'string' ? config.model.trim() : ''
    };
    if (explicit.provider !== '' && explicit.model !== '') return { ...explicit, source: 'config' };
    const routeOf = (candidate) => {
      if (candidate === null || typeof candidate !== 'object') return undefined;
      const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
      const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
      return provider !== '' && model !== '' ? { provider, model } : undefined;
    };
    try {
      const sessions = this.ctx.get('sessions');
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
      const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
      const fromSession = routeOf(header?.config);
      if (fromSession !== undefined) return { ...fromSession, source: 'session' };
    } catch {
      // 读不到会话路由时继续往下兜底
    }
    try {
      const defaults = this.ctx.get('agentDefaultModel');
      const selection = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined;
      const fromDefault = routeOf(selection);
      if (fromDefault !== undefined) return { ...fromDefault, source: 'default' };
    } catch {
      // 同上
    }
    return undefined;
  }

  /** 读取一次改动涉及的文件正文；超长按字符截断。 */
  async readJobFile(change, config) {
    const limit = Math.max(2000, Number(config.maxFileChars) || MAX_NOTE_CHARS);
    if (change.status === 'deleted') {
      return { path: change.path, status: 'deleted', language: languageOf(change.path), content: '', diff: mergePatches(change.patches), added: change.added, removed: change.removed, truncated: false };
    }
    let content = '';
    try {
      content = await readFile(change.absolute, 'utf8');
    } catch (error) {
      content = `（无法读取文件：${error instanceof Error ? error.message : String(error)}）`;
    }
    const truncated = content.length > limit;
    return {
      path: change.path,
      status: change.status,
      language: languageOf(change.path),
      content: truncated ? content.slice(0, limit) : content,
      diff: mergePatches(change.patches),
      added: change.added,
      removed: change.removed,
      truncated
    };
  }

  /** 调模型并解析成解释稿。 */
  async generate(files, options) {
    const llm = this.ctx.get('llm');
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      throw new Error('当前 Host 没有可用的 llm 服务，无法生成讲解');
    }
    const config = this.readConfig();
    const route = await this.resolveRoute(options.sessionId);
    if (route === undefined) {
      throw new Error('无法确定讲解用模型：请在插件设置里成对填写 provider 与 model，或先在当前会话发送一条消息');
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(5000, Number(config.timeoutMs) || 120000);
    const timer = setTimeout(() => controller.abort(new Error('讲解超时')), timeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const prepared = await llm.prepareCall(
        { provider: route.provider, model: route.model },
        controller.signal,
        (controls, model) => {
          const effort = model?.reasoning?.efforts?.[0]?.id;
          return {
            ...controls,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            maxTokens: Math.max(512, Number(config.maxOutputTokens) || 4096)
          };
        }
      );
      const userText = buildUserPrompt({ files, instruction: options.instruction, title: options.title }, options.labels);
      const stream = prepared.stream({
        provider: prepared.config?.provider ?? route.provider,
        model: prepared.config?.model ?? route.model,
        ...(prepared.config?.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.config.reasoningEffort }),
        ...(prepared.config?.maxTokens === undefined ? {} : { maxTokens: prepared.config.maxTokens }),
        ...(prepared.config?.temperature === undefined ? {} : { temperature: prepared.config.temperature }),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        signal: controller.signal
      });
      let output = '';
      let failure;
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') output += chunk.text;
        else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason.failure?.message ?? chunk.reason.kind;
          }
        }
      }
      if (failure !== undefined && output.trim() === '') throw new Error(`模型调用失败：${failure}`);
      if (output.trim() === '') throw new Error('模型返回了空内容');
      return { output, provider: route.provider, model: route.model, routeSource: route.source };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 生成一条讲解。
   * @param options.sessionId 会话 id（面板/命令都会传）
   * @param options.instruction 额外关注点（/讲解 的文字）
   * @param options.paths 指定文件（相对或绝对）；为空则讲解本次捕获的全部改动
   */
  async explain(options) {
    const sessionId = options.sessionId;
    const config = this.readConfig();
    if (!config.enabled) return { ok: false, error: '代码讲解已在插件设置中关闭' };
    const state = this.stateOf(sessionId);
    if (state.running.has('note')) return { ok: false, error: '这次会话已有一条讲解正在生成' };
    const cwd = this.cwdOf(sessionId);
    let candidates = [...state.changes.values()];
    if (Array.isArray(options.paths) && options.paths.length > 0) {
      const wanted = new Set(options.paths.map((item) => absolutePathOf(item, cwd) ?? item));
      candidates = candidates.filter((change) => wanted.has(change.absolute) || options.paths.includes(change.path));
    }
    if (candidates.length === 0) return { ok: false, error: '当前会话还没有捕获到代码改动', code: 'no-changes' };
    // 最近改动的优先，最多 N 个文件
    const limit = Math.max(1, Number(config.maxFilesPerNote) || 6);
    candidates.sort((a, b) => String(b.seenAt).localeCompare(String(a.seenAt)));
    const selected = candidates.slice(0, limit);
    const files = [];
    for (const change of selected) files.push(await this.readJobFile(change, config));

    state.running.add('note');
    const noteId = randomUUID();
    const generatedAt = nowIso();
    try {
      const result = await this.generate(files, {
        sessionId,
        instruction: options.instruction,
        title: path.basename(selected[0].path),
        labels: {}
      });
      const explainer = parseExplainer(result.output, {
        title: files.length === 1 ? `代码讲解 · ${files[0].path}` : `代码讲解 · ${files.length} 个文件`,
        files: files.map((file) => file.path),
        sessionId,
        generatedAt,
        provider: result.provider,
        model: result.model
      });
      explainer.diffs = files.map((file) => ({ path: file.path, added: file.added, removed: file.removed, diff: file.diff }));
      const note = {
        id: noteId,
        sessionId,
        generatedAt,
        title: explainer.title,
        files: explainer.files,
        provider: result.provider,
        model: result.model,
        routeSource: result.routeSource,
        noteName: noteNameOf(explainer.title, stampOf(generatedAt)),
        written: undefined,
        explainer
      };
      state.notes.unshift(note);
      const historyLimit = Math.max(5, Number(config.historyLimit) || 40);
      if (state.notes.length > historyLimit) state.notes.length = historyLimit;
      // 已经解释过的改动不再算「待讲解」
      for (const change of selected) state.changes.delete(change.absolute);

      let writeResult;
      if (this.resolveVault(config) !== undefined) {
        try {
          writeResult = await this.writeNote({ sessionId, noteId });
        } catch (error) {
          writeResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      } else {
        writeResult = { ok: false, code: 'no-vault', error: '未配置 Obsidian 库目录' };
      }
      return { ok: true, note: state.notes.find((item) => item.id === noteId), written: writeResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'generate-failed' };
    } finally {
      state.running.delete('note');
    }
  }

  /** 取得会话工作目录（工具相对路径的基准）。 */
  cwdOf(sessionId) {
    try {
      const workingDirectory = this.ctx.get('workingDirectory');
      const sessions = this.ctx.get('sessions');
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
      if (session !== undefined && typeof workingDirectory?.get === 'function') {
        const value = workingDirectory.get(session);
        if (typeof value === 'string' && value !== '') return value;
      }
    } catch {
      // 继续兜底
    }
    return process.cwd();
  }

  /** 把一条讲解写成 Obsidian 文件（Markdown / Canvas / 索引）。 */
  async writeNote({ sessionId, noteId }) {
    const config = this.readConfig();
    const vault = this.resolveVault(config);
    if (vault === undefined) return { ok: false, code: 'no-vault', error: '尚未配置 Obsidian 库目录（vaultPath）' };
    const state = this.sessions.get(sessionId);
    const note = state?.notes.find((item) => item.id === noteId);
    if (note === undefined) return { ok: false, code: 'not-found', error: '找不到这条讲解记录' };
    const folder = String(config.folder ?? 'CodeNotes').replace(/[\\/]+$/u, '') || 'CodeNotes';
    const dir = path.join(vault, folder);
    await mkdir(dir, { recursive: true });
    const markdown = renderMarkdown(note.explainer, {
      linkNotes: config.linkNotes !== false,
      folder,
      sessionId
    });
    const markdownPath = path.join(dir, `${note.noteName}.md`);
    await writeFile(markdownPath, markdown, 'utf8');
    let canvasPath;
    if (config.writeCanvas !== false) {
      canvasPath = path.join(dir, `${note.noteName}.canvas`);
      await writeFile(canvasPath, `${JSON.stringify(buildCanvas(note.explainer), null, 2)}\n`, 'utf8');
    }
    if (config.writeIndex !== false) {
      const index = renderIndex(state.notes.map((item) => ({
        noteName: item.noteName,
        files: item.files,
        generatedAt: item.generatedAt
      })), folder);
      await writeFile(path.join(dir, '_index.md'), index, 'utf8');
    }
    note.written = { markdown: markdownPath, canvas: canvasPath, at: nowIso() };
    return { ok: true, path: markdownPath, canvas: canvasPath, markdown };
  }

  /** 用系统默认程序打开 vault（Windows 资源管理器/Obsidian 关联）。 */
  async openVault() {
    const vault = this.resolveVault(this.readConfig());
    if (vault === undefined) return { ok: false, error: '尚未配置 Obsidian 库目录' };
    const uri = `obsidian://open?path=${encodeURIComponent(vault)}`;
    try {
      await openExternal(uri, vault);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 打开某条笔记（优先用 obsidian:// 直达文件）。 */
  async openInObsidian({ sessionId, noteId }) {
    const state = this.sessions.get(sessionId);
    const note = state?.notes.find((item) => item.id === noteId);
    const config = this.readConfig();
    const vault = this.resolveVault(config);
    if (note?.written?.markdown === undefined || vault === undefined) return this.openVault();
    const folder = String(config.folder ?? 'CodeNotes').replace(/[\\/]+$/u, '') || 'CodeNotes';
    const relative = `${folder}/${note.noteName}.md`;
    const uri = `obsidian://open?path=${encodeURIComponent(path.join(vault, relative))}`;
    try {
      await openExternal(uri, path.join(vault, relative));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 给工具用的紧凑结果：只回模型真正需要的字段。 */
  toolPayload(note) {
    return {
      title: note.title,
      files: note.files,
      business: note.explainer?.business ?? '',
      keypoints: note.explainer?.keypoints ?? [],
      risks: note.explainer?.risks ?? [],
      mermaid: note.explainer?.mermaid ?? '',
      written: note.written?.markdown ?? null,
      canvas: note.written?.canvas ?? null
    };
  }
}

/** 用系统默认程序打开一个 URI 或路径（后台执行，不阻塞 Host）。 */
async function openExternal(uri, fallbackPath) {
  const { spawn } = await import('node:child_process');
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd.exe' : (platform === 'darwin' ? 'open' : 'xdg-open');
  const args = platform === 'win32' ? ['/c', 'start', '', uri] : [uri];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    setTimeout(() => resolve(), 1500).unref?.();
    void fallbackPath;
  });
}

export { diffStats };
