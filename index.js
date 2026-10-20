/**
 * Host 半区：Cordis 插件入口。
 *
 * 职责：
 * 1. 读取/合并配置（cordis.patch.yml 的 config + GUI 写入的同名 id 覆盖）。
 * 2. 监听 `tools/result`，捕获 AI 每次改动的文件。
 * 3. 提供 `/讲解` 命令、`explain_code_change` 工具、`/api/dsh-code-notes/*` 面板接口。
 * 4. 渲染侧边栏「讲解」面板所需的 Client 模块（见 client.js）。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ExplainerService } from './lib/service.js';
import { registerRoutes } from './lib/routes.js';

const PATCH_ID = 'code-notes';
const PROFILE_PATCH = 'cordis.patch.yml';

/** 配置默认值（与 cordis.patch.yml 里的注释一致）。 */
const DEFAULTS = {
  enabled: true,
  mode: 'auto',
  vaultPath: '',
  folder: 'CodeNotes',
  provider: '',
  model: '',
  maxFileChars: 24000,
  maxFilesPerNote: 6,
  timeoutMs: 120000,
  maxOutputTokens: 4096,
  writeCanvas: true,
  linkNotes: true,
  writeIndex: true,
  historyLimit: 40
};

const MODES = new Set(['auto', 'manual']);

/** 合并并校验配置：非法值一律回落到默认值，避免一条坏配置让插件挂掉。 */
function pickConfig(raw) {
  const config = { ...DEFAULTS };
  if (raw !== null && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(raw, key) && raw[key] !== undefined && raw[key] !== null) {
        config[key] = raw[key];
      }
    }
  }
  config.enabled = config.enabled !== false;
  config.mode = MODES.has(config.mode) ? config.mode : DEFAULTS.mode;
  config.folder = typeof config.folder === 'string' && config.folder.trim() !== '' ? config.folder.trim() : DEFAULTS.folder;
  config.vaultPath = typeof config.vaultPath === 'string' ? config.vaultPath.trim() : DEFAULTS.vaultPath;
  config.provider = typeof config.provider === 'string' ? config.provider.trim() : '';
  config.model = typeof config.model === 'string' ? config.model.trim() : '';
  config.maxFileChars = Math.max(2000, Math.min(200000, Number(config.maxFileChars) || DEFAULTS.maxFileChars));
  config.maxFilesPerNote = Math.max(1, Math.min(20, Number(config.maxFilesPerNote) || DEFAULTS.maxFilesPerNote));
  config.timeoutMs = Math.max(5000, Math.min(600000, Number(config.timeoutMs) || DEFAULTS.timeoutMs));
  config.maxOutputTokens = Math.max(512, Math.min(32000, Number(config.maxOutputTokens) || DEFAULTS.maxOutputTokens));
  config.writeCanvas = config.writeCanvas !== false;
  config.linkNotes = config.linkNotes !== false;
  config.writeIndex = config.writeIndex !== false;
  config.historyLimit = Math.max(5, Math.min(200, Number(config.historyLimit) || DEFAULTS.historyLimit));
  return config;
}

/** 找到 profile 目录下可写的 patch 文件。 */
async function locatePatchFile() {
  const explicit = process.env.DSH_PROFILE_DIR;
  const candidates = [];
  if (typeof explicit === 'string' && explicit !== '') candidates.push(path.join(explicit, PROFILE_PATCH));
  const home = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE;
  if (typeof home === 'string' && typeof profile === 'string' && home !== '' && profile !== '') {
    candidates.push(path.join(home, 'profiles', profile, PROFILE_PATCH));
  }
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // 试下一个候选
    }
  }
  return undefined;
}

/**
 * 把设置写回 profile 的 cordis.patch.yml：只改 `id: code-notes` 那一行的 config 子键，
 * 保留用户在文件里写的注释与其他条目。找不到该条目时返回 false（设置仅在本次运行生效）。
 */
async function persistSettings(values) {
  const file = await locatePatchFile();
  if (file === undefined) return false;
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*['"]?${PATCH_ID}['"]?\\s*$`, 'u').test(line));
  if (start < 0) return false;
  const indentOf = (line) => (/^\s*/u.exec(line) ?? [''])[0].length;
  const base = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      end += 1;
      continue;
    }
    if (indentOf(line) <= base) break;
    end += 1;
  }
  let configIndex = -1;
  let configIndent = 0;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*config:\s*$/u.test(lines[index])) {
      configIndex = index;
      configIndent = indentOf(lines[index]);
      break;
    }
  }
  const render = (key, value) => {
    const indent = ' '.repeat(configIndex < 0 ? base + 4 : configIndent + 2);
    if (typeof value === 'boolean' || typeof value === 'number') return `${indent}${key}: ${value}`;
    return `${indent}${key}: '${String(value).replace(/'/gu, "''")}'`;
  };
  if (configIndex < 0) {
    const insertAt = start + 1;
    lines.splice(insertAt, 0, `${' '.repeat(base + 2)}config:`);
    const rendered = Object.entries(values).map(([key, value]) => render(key, value));
    lines.splice(insertAt + 1, 0, ...rendered);
  } else {
    for (const [key, value] of Object.entries(values)) {
      const pattern = new RegExp(`^\\s*${key}:`, 'u');
      let replaced = false;
      for (let index = configIndex + 1; index < end; index += 1) {
        if (indentOf(lines[index]) <= configIndent) continue;
        if (pattern.test(lines[index])) {
          lines[index] = render(key, value);
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        lines.splice(configIndex + 1, 0, render(key, value));
        end += 1;
      }
    }
  }
  await writeFile(file, lines.join('\n'), 'utf8');
  return true;
}

/** Cordis 插件入口。 */
export function apply(ctx, config = {}) {
  const base = pickConfig(config);
  const overrides = {};

  const readConfig = () => pickConfig({ ...base, ...overrides });

  const saveConfig = async (patch) => {
    const accepted = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(patch, key) && patch[key] !== undefined) accepted[key] = patch[key];
    }
    Object.assign(overrides, accepted);
    try {
      const written = await persistSettings(accepted);
      if (!written) {
        console.warn('[dsh-code-notes] 未能在 profile 的 cordis.patch.yml 中定位 id: code-notes，设置仅在本次运行生效');
      }
    } catch (error) {
      console.warn(`[dsh-code-notes] 保存设置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const service = new ExplainerService(ctx, { readConfig, saveConfig });

  // 1) 捕获文件改动（只观察，不改变工具判定）
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    try {
      const sessionId = exec?.agent?.session?.id ?? exec?.sessionId;
      if (typeof sessionId !== 'string') return;
      const cwd = typeof exec?.cwd === 'string' && exec.cwd !== '' ? exec.cwd : service.cwdOf(sessionId);
      service.observeToolResult(sessionId, cwd, exec?.name, exec?.arguments, result);
      if (readConfig().mode !== 'auto') return;
      if (result?.isError === true) return;
      // 自动模式：改动先攒一批，延迟 2.5 秒后合并成一条讲解，避免每个文件都打一次模型。
      scheduleAutoExplain(ctx, service, readConfig, sessionId);
    } catch (error) {
      console.warn(`[dsh-code-notes] 捕获改动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }), 'dsh-code-notes: tools/result');

  // 2) /讲解 命令
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: '讲解',
      description: '代码讲解：/讲解 [文件或关注点] —— 把本次改动用旁路模型讲一遍，并写入 Obsidian 笔记',
      input: { hint: '可选：文件路径，或想重点讲解的方面（留空则讲本次捕获的全部改动）' },
      recordInput: false,
      async handler(invocation) {
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
        const sessionId = invocation.agent?.session?.id;
        if (typeof sessionId !== 'string') return { kind: 'error', text: '当前没有可用的会话上下文' };
        const result = await service.explain({
          sessionId,
          instruction: raw === '' ? undefined : raw,
          paths: looksLikePaths(raw) ? raw.split(/[\s,，、]+/u).filter((item) => item !== '') : undefined
        });
        if (!result.ok) {
          if (result.code === 'no-changes') {
            return { kind: 'error', text: '当前会话还没有捕获到代码改动；先让 AI 修改代码，或改用工具 explain_code_change 指定文件。' };
          }
          return { kind: 'error', text: `讲解失败：${result.error}` };
        }
        const note = result.note;
        const written = result.written?.ok === true ? `已写入 ${result.written.path}` : `未写入 Obsidian：${result.written?.error ?? '未知原因'}`;
        return {
          kind: 'success',
          text: `已完成讲解《${note.title}》（${note.files.join('、')}）\n${written}`
        };
      }
    }), 'dsh-code-notes: /讲解');
  });

  // 3) Agent 工具：让模型可以主动请求讲解
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'explain_code_change',
      description: '把本次会话中的代码改动（或指定文件）讲成业务逻辑说明，并写入 Obsidian（笔记 + Mermaid 流程图 + Markmap 思维图 + Canvas）。用户问「讲讲这段代码」「这次改动做了什么」或希望留档时调用。',
      parameters: {
        focus: {
          type: 'string',
          description: '可选：希望重点讲解的方面，例如「错误处理路径」「与鉴权的交互」。'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：只讲解这些文件（相对工作目录或绝对路径）。省略则讲解本次捕获的全部改动。'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            title: { type: 'string' },
            business: { type: 'string' },
            keypoints: { type: 'array', items: { type: 'string' } },
            risks: { type: 'array', items: { type: 'string' } },
            files: { type: 'array', items: { type: 'string' } },
            notePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            canvasPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            error: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: renderToolText(value) }]
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id ?? exec?.sessionId;
        if (typeof sessionId !== 'string') {
          return { ok: false, error: '没有会话上下文，无法读取改动' };
        }
        const result = await service.explain({
          sessionId,
          instruction: typeof args?.focus === 'string' && args.focus.trim() !== '' ? args.focus : undefined,
          paths: Array.isArray(args?.files) && args.files.length > 0 ? args.files : undefined
        });
        if (!result.ok) {
          return { ok: false, error: result.code === 'no-changes' ? '当前会话没有捕获到代码改动' : result.error };
        }
        const payload = service.toolPayload(result.note);
        return {
          ok: true,
          title: payload.title,
          business: payload.business,
          keypoints: payload.keypoints,
          risks: payload.risks,
          files: payload.files,
          notePath: payload.written ?? null,
          canvasPath: payload.canvas ?? null
        };
      }
    }), 'dsh-code-notes: tool');
  });

  // 4) 面板接口
  ctx.effect(() => registerRoutes(ctx, service), 'dsh-code-notes: routes');

  return service;
}

/** `/讲解 a.ts b.ts` 这种纯路径形式的输入，转成文件过滤条件；否则当作「关注点」。 */
function looksLikePaths(raw) {
  if (raw === '') return false;
  return raw.split(/[\s,，、]+/u).every((token) => /[\\/.]/u.test(token) || /\.(ts|tsx|js|jsx|py|go|rs|java|vue|md|json|ya?ml)$/iu.test(token));
}

function renderToolText(value) {
  if (value?.ok !== true) return `讲解未生成：${value?.error ?? '未知原因'}`;
  const lines = [`已生成讲解《${value.title}》`, ''];
  if (typeof value.business === 'string' && value.business !== '') {
    lines.push('业务逻辑：', value.business, '');
  }
  if (Array.isArray(value.keypoints) && value.keypoints.length > 0) {
    lines.push('要点：', ...value.keypoints.map((item) => `- ${item}`), '');
  }
  if (Array.isArray(value.risks) && value.risks.length > 0) {
    lines.push('风险：', ...value.risks.map((item) => `- ${item}`), '');
  }
  if (value.notePath !== null && value.notePath !== undefined) lines.push(`笔记：${value.notePath}`);
  if (value.canvasPath !== null && value.canvasPath !== undefined) lines.push(`画布：${value.canvasPath}`);
  return lines.join('\n');
}

/** 自动模式：同一会话串行排队一次讲解（不打断主任务，失败只记日志）。 */
function scheduleAutoExplain(ctx, service, readConfig, sessionId) {
  const state = service.stateOf(sessionId);
  if (state.autoQueued === true) return;
  state.autoQueued = true;
  const timer = setTimeout(async () => {
    state.autoQueued = false;
    const config = readConfig();
    if (config.mode !== 'auto') return;
    try {
      const result = await service.explain({ sessionId });
      if (!result.ok && result.code !== 'no-changes') {
        console.info(`[dsh-code-notes] 自动讲解未生成：${result.error}`);
      }
    } catch (error) {
      console.warn(`[dsh-code-notes] 自动讲解异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }, 2500);
  timer.unref?.();
  ctx.effect(() => () => {
    clearTimeout(timer);
    state.autoQueued = false;
  }, 'dsh-code-notes: auto timer');
}

export const name = 'code-notes';
export const inject = ['tools'];
