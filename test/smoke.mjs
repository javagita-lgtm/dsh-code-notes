/**
 * 脱离 Host 的冒烟测试：只测纯函数（提示词解析、改动捕获、Obsidian 序列化）。
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { parseExplainer, buildUserPrompt } from '../lib/prompt.js';
import { changesFromToolResult, parseUnifiedPatch, diffStats } from '../lib/changes.js';
import { renderMarkdown, buildCanvas, buildMarkmap, renderIndex, noteNameOf, cleanMermaid } from '../lib/obsidian.js';

const checks = [];
const test = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error });
  }
};

test('parseExplainer: 正常 JSON（带围栏）', () => {
  const raw = '```json\n{"title":"订单状态机","business":"把订单状态收敛到一处","mermaid":"flowchart TD\\n  A --> B","mindmap":[{"label":"订单","children":[{"label":"状态"}]}],"keypoints":["集中判定"],"risks":["并发"],"snippets":[{"file":"a.ts","symbol":"next","code":"return 1;"}]}\n```';
  const explainer = parseExplainer(raw, { files: ['a.ts'], generatedAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(explainer.fallback, false);
  assert.equal(explainer.title, '订单状态机');
  assert.equal(explainer.files[0], 'a.ts');
  assert.equal(explainer.mindmap[0].children[0].label, '状态');
  assert.equal(explainer.snippets[0].code, 'return 1;');
});

test('parseExplainer: JSON 前后夹杂说明文字', () => {
  const raw = '好的，下面是结果：{"title":"A","business":"B"} 以上。';
  const explainer = parseExplainer(raw, {});
  assert.equal(explainer.title, 'A');
  assert.equal(explainer.business, 'B');
});

test('parseExplainer: 完全不是 JSON 时退回纯文本', () => {
  const explainer = parseExplainer('随便一段说明文字', { files: ['x.py'], title: '兜底标题' });
  assert.equal(explainer.fallback, true);
  assert.equal(explainer.business, '随便一段说明文字');
  assert.equal(explainer.title, '兜底标题');
});

test('buildUserPrompt: 包含文件正文与 diff', () => {
  const text = buildUserPrompt({
    instruction: '重点看错误处理',
    files: [{ path: 'src/a.ts', status: 'updated', language: 'ts', content: 'export const a = 1;', diff: '+ export const a = 1;', added: 1, removed: 0, truncated: false }]
  }, {});
  assert.ok(text.includes('重点看错误处理'));
  assert.ok(text.includes('export const a = 1;'));
  assert.ok(text.includes('```diff'));
});

test('changesFromToolResult: write 新建文件', () => {
  const records = changesFromToolResult('write', { file_path: 'a.ts' }, {
    isError: false,
    meta: { path: 'G:\\ws\\a.ts', operation: 'create', before: null, after: 'line1\nline2' }
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'created');
  assert.equal(records[0].added, 2);
});

test('changesFromToolResult: edit 多 hunk 合并', () => {
  const records = changesFromToolResult('edit', { file_path: 'b.ts' }, {
    isError: false,
    meta: {
      operation: 'update',
      path: 'G:\\ws\\b.ts',
      diffs: [
        { path: 'G:\\ws\\b.ts', oldText: 'a', newText: 'b' },
        { path: 'G:\\ws\\b.ts', oldText: 'c', newText: 'd' }
      ]
    }
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].added, 2);
  assert.equal(records[0].removed, 2);
  assert.ok(records[0].diff.includes('…'));
});

test('changesFromToolResult: 失败结果被忽略', () => {
  assert.deepEqual(changesFromToolResult('write', {}, { isError: true }), []);
  assert.deepEqual(changesFromToolResult('read', {}, { isError: false, meta: {} }), []);
});

test('parseUnifiedPatch: 多文件补丁', () => {
  const patch = ['*** Begin Patch', '*** Add File: new.ts', '+ export const x = 1;', '*** Update File: old.ts', '@@', '- const a = 1;', '+ const a = 2;', '*** End Patch'].join('\n');
  const records = parseUnifiedPatch(patch);
  assert.equal(records.length, 2);
  assert.equal(records[0].path, 'new.ts');
  assert.equal(records[1].added, 1);
  assert.equal(records[1].removed, 1);
});

test('diffStats', () => {
  assert.deepEqual(diffStats('+ a\n+ b\n- c'), { added: 2, removed: 1 });
});

test('renderMarkdown: frontmatter / mermaid / markmap / 双链', () => {
  const explainer = {
    title: '订单状态机',
    files: ['src/order.ts'],
    business: '业务说明',
    mermaid: 'flowchart TD\n  A --> B',
    mindmap: [{ label: '订单', children: [{ label: '状态' }] }],
    keypoints: ['要点一'],
    risks: ['风险一'],
    snippets: [{ file: 'src/order.ts', symbol: 'next', note: '推进状态', code: 'return 1;' }],
    generatedAt: '2026-10-20T08:30:00.000Z',
    sessionId: 's1'
  };
  const markdown = renderMarkdown(explainer, { linkNotes: true });
  assert.ok(markdown.startsWith('---\n'));
  assert.ok(markdown.includes('```mermaid'));
  assert.ok(markdown.includes('```markmap'));
  assert.ok(markdown.includes('[[src/order.ts]]'));
  assert.ok(markdown.includes('## 原文对照'));
  assert.ok(markdown.includes('```ts'));
});

test('renderMarkdown: linkNotes=false 时不写死链', () => {
  const markdown = renderMarkdown({ title: 't', files: ['a/b.py'], business: 'x', generatedAt: '2026-10-20T00:00:00.000Z' }, { linkNotes: false });
  assert.ok(!markdown.includes('[[a/b.py]]'));
  assert.ok(markdown.includes('`a/b.py`'));
});

test('buildMarkmap: 层级正确', () => {
  const text = buildMarkmap({ title: '根', mindmap: [{ label: 'A', children: [{ label: 'B' }] }] });
  assert.equal(text, '# 根\n- A\n  - B');
});

test('cleanMermaid: 非 mermaid 文本降级为流程图', () => {
  const flow = cleanMermaid('第一步\n第二步', '主题');
  assert.ok(flow.startsWith('flowchart TD'));
  assert.ok(flow.includes('第一步'));
});

test('buildCanvas: 节点与边结构合法', () => {
  const canvas = buildCanvas({ title: 'T', business: '说明', files: ['a.ts'], mermaid: 'flowchart TD\n A-->B', mindmap: [{ label: 'A' }] });
  assert.ok(Array.isArray(canvas.nodes) && canvas.nodes.length >= 4);
  assert.ok(canvas.edges.length >= 2);
  for (const edge of canvas.edges) {
    assert.ok(canvas.nodes.some((node) => node.id === edge.fromNode));
    assert.ok(canvas.nodes.some((node) => node.id === edge.toNode));
  }
});

test('renderIndex / noteNameOf', () => {
  const index = renderIndex([{ noteName: '20261020-1200-订单', files: ['a.ts'], generatedAt: '2026-10-20T04:00:00.000Z' }], 'CodeNotes');
  assert.ok(index.includes('[[20261020-1200-订单]]'));
  assert.equal(noteNameOf('a/b:c*d', '20261020-1200'), '20261020-1200-a b c d');
});

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`);
  if (!check.ok) console.log(check.error);
}
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
