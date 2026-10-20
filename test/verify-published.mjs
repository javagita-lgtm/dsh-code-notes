/**
 * 校验 verify-published 的判定逻辑（不联网）。
 * 运行：node test/verify-published.mjs
 */

import assert from 'node:assert/strict';
import { judge } from '../scripts/verify-published.mjs';

// 全绿：版本存在、latest 指向它、能匿名装
assert.deepEqual(
  judge({ version: '0.2.0', versions: ['0.2.0'], latest: '0.2.0', installOk: true }),
  { ok: true, problems: [] }
);

// 暂存发布留下的占位 latest：必须报错并给出修复命令
const placeholder = judge({ version: '0.2.0', versions: ['0.0.0-stage', '0.2.0'], latest: '0.0.0-stage', installOk: true });
assert.equal(placeholder.ok, false);
assert.match(placeholder.problems.join('\n'), /npm dist-tag add dsh-code-notes@0\.2\.0 latest/u);

// 版本根本没上去
const missing = judge({ version: '0.2.0', versions: ['0.0.0-stage'], latest: '0.0.0-stage', installOk: false });
assert.equal(missing.ok, false);
assert.match(missing.problems.join('\n'), /不在 registry 上/u);

// 安装失败但元数据正常
const installFail = judge({ version: '0.2.0', versions: ['0.2.0'], latest: '0.2.0', installOk: false });
assert.equal(installFail.ok, false);
assert.match(installFail.problems.join('\n'), /匿名安装失败/u);

console.log('PASS  verify-published：占位 latest / 版本缺失 / 安装失败三种异常都能识别');
