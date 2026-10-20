/**
 * patch 写回测试：验证设置能安全地合并回 profile 的 cordis.patch.yml，
 * 且不破坏注释、其他条目与缩进。
 * 运行：node test/patch-persist.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'dsh-code-notes-patch-'));
const profile = path.join(root, 'profile');
await mkdir(profile, { recursive: true });
const patchFile = path.join(profile, 'cordis.patch.yml');
const original = [
  '# profile patch',
  '- id: locale',
  '  name: "@deepseek-ai/dsh-client-locale"',
  '  config:',
  '    preference: zh',
  '- insert:',
  '    - id: code-notes',
  '      name: dsh-code-notes',
  '      config:',
  '        enabled: true',
  '        vaultPath: ""',
  '        folder: CodeNotes',
  '# 末尾注释',
  ''
].join('\n');
await writeFile(patchFile, original, 'utf8');

process.env.DSH_PROFILE_DIR = profile;
const mod = await import('../index.js');

const config = { vaultPath: path.join(root, 'vault'), folder: 'My Notes', writeCanvas: false };
const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  on: () => () => {},
  inject: () => () => {},
  get: () => undefined
};

const service = mod.apply(ctx, config);
await service.saveSettings({ vaultPath: config.vaultPath, folder: 'My Notes', writeCanvas: false });

const text = await readFile(patchFile, 'utf8');
assert.ok(text.includes('# profile patch'), '顶部注释应保留');
assert.ok(text.includes('# 末尾注释'), '末尾注释应保留');
assert.ok(text.includes('preference: zh'), '其他条目应保留');
assert.ok(text.includes("vaultPath: '"), 'vaultPath 应被写入');
assert.ok(text.includes("folder: 'My Notes'"), '含空格的 folder 应用引号包裹');
assert.ok(text.includes('writeCanvas: false'), '布尔值不加引号');
assert.ok(text.includes('enabled: true'), '未改动的键保持原值');

// 合并后的配置必须能被下一次读取（同一个 patch 行）
const reloaded = mod.apply(ctx, config);
const view = reloaded.publicConfig();
assert.equal(view.vaultResolved, path.resolve(config.vaultPath));

await rm(root, { recursive: true, force: true });
console.log('PASS  patch 写回：保留注释与其他条目，键值类型正确');
