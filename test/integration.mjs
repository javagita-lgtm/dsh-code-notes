/**
 * 集成冒烟：用假的 Host ctx（llm / sessions / fs）跑通
 * 改动捕获 → 生成 → 渲染 → 写 Obsidian 的完整链路，不触网。
 * 运行：node test/integration.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ExplainerService } from '../lib/service.js';

const root = await mkdtemp(path.join(tmpdir(), 'dsh-code-notes-'));
const workspace = path.join(root, 'ws');
const vault = path.join(root, 'vault');
await mkdir(workspace, { recursive: true });
await mkdir(path.join(vault, '.obsidian'), { recursive: true });

const sourceFile = path.join(workspace, 'order.ts');
await writeFile(sourceFile, 'export function next(state: string) {\n  return state === "paid" ? "shipped" : state;\n}\n', 'utf8');

const MODEL_JSON = JSON.stringify({
  title: '订单状态推进',
  business: '把订单从已支付推进到已发货，非法状态原样返回。',
  mermaid: 'flowchart TD\n  A["next()"] --> B{"state == paid?"}\n  B -- 是 --> C["返回 shipped"]\n  B -- 否 --> D["原样返回"]',
  mindmap: [{ label: '订单状态推进', children: [{ label: '输入', children: [{ label: 'state' }] }, { label: '输出', children: [{ label: 'shipped' }] }] }],
  keypoints: ['状态判断集中在一个函数'],
  risks: ['未知状态没有日志'],
  snippets: [{ file: 'order.ts', symbol: 'next', note: '唯一的判定点', code: 'return state === "paid" ? "shipped" : state;' }]
});

const requests = [];
const fakeLlm = {
  async prepareCall(config) {
    requests.push(config);
    return {
      config: { provider: config.provider, model: config.model, maxTokens: 4096 },
      stream(options) {
        assert.match(options.system, /JSON/);
        assert.match(options.messages[0].content[0].text, /order\.ts/);
        return (async function* stream() {
          const mid = Math.floor(MODEL_JSON.length / 2);
          yield { type: 'text-delta', index: 0, text: MODEL_JSON.slice(0, mid) };
          yield { type: 'text-delta', index: 0, text: MODEL_JSON.slice(mid) };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }
    };
  }
};

const sessionId = 'session-test';
const fakeSession = { requestHeader: () => ({ config: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }) };

const fakeCtx = {
  get(name) {
    if (name === 'llm') return fakeLlm;
    if (name === 'sessions') return { get: (id) => (id === sessionId ? fakeSession : undefined) };
    if (name === 'workingDirectory') return { get: () => workspace };
    return undefined;
  }
};

const config = {
  enabled: true,
  mode: 'manual',
  vaultPath: vault,
  folder: 'CodeNotes',
  provider: '',
  model: '',
  maxFileChars: 24000,
  maxFilesPerNote: 6,
  timeoutMs: 30000,
  maxOutputTokens: 4096,
  writeCanvas: true,
  linkNotes: true,
  writeIndex: true,
  historyLimit: 40
};

const saved = [];
const service = new ExplainerService(fakeCtx, {
  readConfig: () => config,
  saveConfig: async (patch) => {
    saved.push(patch);
    Object.assign(config, patch);
  }
});

// 1) 捕获一次 edit（meta 带 hunk）
service.observeToolResult(sessionId, workspace, 'edit', { file_path: 'order.ts' }, {
  isError: false,
  meta: {
    operation: 'update',
    path: 'order.ts',
    diffs: [
      { path: 'order.ts', oldText: 'return state;', newText: 'return state === "paid" ? "shipped" : state;' }
    ]
  }
});
// 2) 噪声路径应被过滤
service.observeToolResult(sessionId, workspace, 'write', { file_path: 'node_modules/x/index.js' }, {
  isError: false,
  meta: { path: path.join(workspace, 'node_modules', 'x', 'index.js'), operation: 'create', before: null, after: 'x' }
});
// 3) vault 内的笔记文件不应被当成代码改动
service.observeToolResult(sessionId, workspace, 'write', { file_path: 'note.md' }, {
  isError: false,
  meta: { path: path.join(vault, 'CodeNotes', 'a.md'), operation: 'create', before: null, after: '# note' }
});

const changes = service.changesOf(sessionId);
assert.equal(changes.length, 1, `应当只捕获 1 个文件，实际 ${JSON.stringify(changes)}`);
assert.equal(changes[0].path, 'order.ts');

const result = await service.explain({ sessionId });
assert.equal(result.ok, true, result.error);
assert.equal(requests[0].provider, 'workbuddy');
assert.equal(result.written.ok, true, result.written.error);

const markdown = await readFile(result.written.path, 'utf8');
assert.ok(markdown.includes('## 调用流程'));
assert.ok(markdown.includes('```mermaid'));
assert.ok(markdown.includes('```markmap'));
assert.ok(markdown.includes('订单状态推进'));
assert.ok(markdown.includes('[[order.ts]]'));

const canvas = JSON.parse(await readFile(result.written.canvas, 'utf8'));
assert.ok(canvas.nodes.length >= 4);
assert.ok(canvas.edges.length >= 2);
const noteNode = canvas.nodes.find((node) => node.id === 'note-file-0');
assert.equal(noteNode.file, 'order.ts');

const index = await readFile(path.join(vault, 'CodeNotes', '_index.md'), 'utf8');
assert.ok(index.includes(result.note.noteName));

// 4) 讲过的改动会被消费，再次讲解应返回 no-changes
const again = await service.explain({ sessionId });
assert.equal(again.ok, false);
assert.equal(again.code, 'no-changes');

// 5) 设置保存走同一入口
const publicConfig = await service.saveSettings({ folder: 'Notes2' });
assert.equal(publicConfig.folder, 'Notes2');
assert.equal(saved.at(-1).folder, 'Notes2');

await rm(root, { recursive: true, force: true });
console.log('PASS  集成链路：捕获 → 生成 → 渲染 → 写入 vault');
console.log('PASS  噪声过滤：node_modules 与 vault 内笔记均被忽略');
console.log('PASS  canvas / index / 双链 结构正确');
console.log('PASS  no-changes 与设置保存');
