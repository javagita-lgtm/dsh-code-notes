/**
 * 改动捕获：从 `tools/result` 的最终结果里认出「哪些文件被改了什么」。
 *
 * 为什么从工具结果而不是事件流拿：
 * - `write` / `edit` 的结果 meta 自带完整的 `before` / `after`（编辑工具是每个 hunk 的
 *   `oldText` / `newText`），比再从磁盘读一遍更准确，也不会被后续改动覆盖。
 * - `tools/result` 是 emit 事件，只观察、不改判定，对主流程零影响。
 *
 * 这里只做纯函数解析，不碰 fs / 会话，方便单测。
 */

/** 编辑器工具名形态：fs 的 edit 与统一 apply_patch。 */
const EDIT_TOOL = 'edit';
const WRITE_TOOL = 'write';
const PATCH_TOOL = 'apply_patch';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 从 fs `edit` 的结果里取 hunk。
 * @returns {{ path: string, oldText: string | null, newText: string }[]}
 */
function hunksOf(meta) {
  if (!isRecord(meta)) return [];
  const diffs = Array.isArray(meta.diffs) ? meta.diffs : [];
  const result = [];
  for (const diff of diffs) {
    if (!isRecord(diff)) continue;
    const path = typeof diff.path === 'string' ? diff.path : undefined;
    const newText = typeof diff.newText === 'string' ? diff.newText : undefined;
    const oldText = diff.oldText === null || typeof diff.oldText === 'string' ? diff.oldText : undefined;
    if (path === undefined || newText === undefined || oldText === undefined) continue;
    result.push({ path, oldText, newText });
  }
  return result;
}

/**
 * 把一次 «旧文本 → 新文本» 的改动渲染成 unified diff 文本（给模型看）。
 * 只做「整段替换」级别的呈现：oldText 的每行标 `-`，newText 的每行标 `+`，
 * 这已经足够说明改了什么，也避免了再引入一个 diff 依赖。
 */
function renderDiff(oldText, newText) {
  const out = [];
  if (typeof oldText === 'string' && oldText !== '') {
    for (const line of oldText.split('\n')) out.push(`- ${line}`);
  }
  if (typeof newText === 'string' && newText !== '') {
    for (const line of newText.split('\n')) out.push(`+ ${line}`);
  }
  return out.join('\n');
}

/** 统计 diff 里的增删行数。 */
export function diffStats(patch) {
  let added = 0;
  let removed = 0;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('+ ')) added += 1;
    else if (line.startsWith('- ')) removed += 1;
  }
  return { added, removed };
}

/**
 * 解析一次工具执行，返回受影响文件的改动记录。
 *
 * 支持三种形态：
 * 1. `write`：meta 里有 `path` 与完整 `before`/`after`（before 为 null 表示新建）。
 * 2. `edit`：meta.diffs 每个 hunk 带 oldText/newText。
 * 3. `apply_patch`：参数用统一补丁语法，按工具参数里的文件段切出路径与增删行。
 *
 * @param name 工具名（wire name）
 * @param args 工具调用参数
 * @param result `tools/result` 的最终结果
 * @returns 每个被改动文件的记录；不是文件写入类工具时返回空数组
 */
export function changesFromToolResult(name, args, result) {
  if (!isRecord(result) || result.isError === true) return [];
  const meta = isRecord(result.meta) ? result.meta : undefined;
  const records = [];

  if (name === WRITE_TOOL) {
    if (meta === undefined || typeof meta.path !== 'string') return [];
    // 拒绝把模型自己的知识库/笔记目录当成代码改动：由调用方按路径过滤，这里只做结构解析。
    const before = typeof meta.before === 'string' ? meta.before : null;
    const after = typeof meta.after === 'string' ? meta.after : '';
    if (meta.operation === 'create' || before === null) {
      const patch = renderDiff('', after);
      records.push({
        path: meta.path,
        status: 'created',
        diff: patch,
        added: after === '' ? 0 : after.split('\n').length,
        removed: 0,
        truncated: false
      });
      return records;
    }
    const patch = renderDiff(before, after);
    const stats = diffStats(patch);
    records.push({
      path: meta.path,
      status: 'updated',
      diff: patch,
      added: stats.added,
      removed: stats.removed,
      truncated: false
    });
    return records;
  }

  if (name === EDIT_TOOL) {
    const hunks = hunksOf(meta);
    if (hunks.length === 0) {
      // 老版本或不带 meta 的回放：退回用调用参数还原改动。
      const path = typeof args?.file_path === 'string' ? args.file_path : undefined;
      if (path === undefined) return [];
      const oldText = typeof args.old_string === 'string' ? args.old_string : '';
      const newText = typeof args.new_string === 'string' ? args.new_string : '';
      const patch = renderDiff(oldText, newText);
      const stats = diffStats(patch);
      return [{ path, status: 'updated', diff: patch, added: stats.added, removed: stats.removed, truncated: false }];
    }
    const byPath = new Map();
    for (const hunk of hunks) {
      const patch = renderDiff(hunk.oldText, hunk.newText);
      const existing = byPath.get(hunk.path);
      if (existing === undefined) {
        byPath.set(hunk.path, { path: hunk.path, status: 'updated', hunks: [patch] });
      } else {
        existing.hunks.push(patch);
      }
    }
    for (const entry of byPath.values()) {
      const patch = entry.hunks.join('\n…\n');
      const stats = diffStats(patch);
      records.push({ path: entry.path, status: 'updated', diff: patch, added: stats.added, removed: stats.removed, truncated: false });
    }
    return records;
  }

  if (name === PATCH_TOOL) {
    const patch = typeof args?.patch === 'string' ? args.patch : (typeof args?.input === 'string' ? args.input : '');
    if (patch.trim() === '') return [];
    return parseUnifiedPatch(patch);
  }

  return [];
}

/**
 * 解析统一补丁（`*** Begin Patch` / `*** Add File:` / `*** Update File:` 之类）的文件段。
 * 只提取路径与该段内的 + / - 行，不做落盘。
 */
export function parseUnifiedPatch(patch) {
  const records = [];
  let current;
  const flush = () => {
    if (current === undefined) return;
    const stats = diffStats(current.lines.join('\n'));
    records.push({
      path: current.path,
      status: current.status,
      diff: current.lines.join('\n'),
      added: stats.added,
      removed: stats.removed,
      truncated: false
    });
    current = undefined;
  };
  for (const line of String(patch).split('\n')) {
    const add = /^\*\*\*\s*Add File:\s*(.+)$/u.exec(line);
    const update = /^\*\*\*\s*Update File:\s*(.+)$/u.exec(line);
    const del = /^\*\*\*\s*Delete File:\s*(.+)$/u.exec(line);
    if (add !== null) {
      flush();
      current = { path: add[1].trim(), status: 'created', lines: [] };
      continue;
    }
    if (update !== null) {
      flush();
      current = { path: update[1].trim(), status: 'updated', lines: [] };
      continue;
    }
    if (del !== null) {
      flush();
      current = { path: del[1].trim(), status: 'deleted', lines: [] };
      continue;
    }
    if (line.startsWith('*** End Patch')) {
      flush();
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) current.lines.push(`+ ${line.slice(1)}`);
    else if (line.startsWith('-')) current.lines.push(`- ${line.slice(1)}`);
  }
  flush();
  return records;
}
