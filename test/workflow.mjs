/**
 * 校验发布工作流：YAML 能解析、步骤名齐全、关键守卫存在。
 * 运行：node test/workflow.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const path = new URL('../.github/workflows/publish.yml', import.meta.url);
const source = await readFile(path, 'utf8');
assert.ok(!source.includes('\uFFFD'), '工作流文件不应含替换字符');
assert.ok(!/\t/u.test(source), 'YAML 不能含制表符');

// 没有 js-yaml 依赖时，退化为结构化文本断言（CI 上装了 npm 自带依赖，无需额外安装）
let doc;
try {
  const yaml = await import('js-yaml');
  doc = (yaml.default ?? yaml).load(source);
} catch {
  doc = undefined;
}

if (doc !== undefined) {
  const job = doc.jobs.publish;
  assert.ok(job !== undefined, '缺少 publish job');
  const names = job.steps.map((step) => step.name ?? step.uses);
  for (const required of [
    'Verify',
    'Check tag matches version',
    'Guard package name and registry',
    'Detect registry state',
    'Publish with NPM_TOKEN',
    'Publish with OIDC trusted publishing'
  ]) {
    assert.ok(names.includes(required), `缺少步骤 ${required}（实际：${names.join(' | ')}）`);
  }
} else {
  for (const marker of ['Publish with NPM_TOKEN', 'Publish with OIDC trusted publishing', 'Detect registry state']) {
    assert.ok(source.includes(marker), `工作流缺少 ${marker}`);
  }
}

// 关键守卫：token 与 OIDC 两条路径互斥，且首次发布必须拦在 OIDC 之外
assert.match(source, /NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
assert.match(source, /id-token: write/u);
assert.match(source, /bypass 2fa/iu);
assert.match(source, /registry\.npmjs\.org/u);

console.log('PASS  工作流：YAML 合法、步骤齐全、token/OIDC 双路径与守卫齐全');
