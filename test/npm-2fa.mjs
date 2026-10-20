/**
 * 校验 check-npm-2fa 的判定逻辑（不联网）。
 * 运行：node test/npm-2fa.mjs
 */

import assert from 'node:assert/strict';
import { evaluate, resolveToken } from '../scripts/check-npm-2fa.mjs';

// 真实 403 的两种成因都要被判成「不能发布」
const blocked = evaluate({ account2fa: false, tokenBypass2fa: false, account: 'demo' });
assert.equal(blocked.canPublish, false);
assert.match(blocked.reason, /账号未开 2FA/u);

// 账号开了 2FA：交互式发布可行
assert.equal(evaluate({ account2fa: true, tokenBypass2fa: false, account: 'demo' }).canPublish, true);

// token 带 bypass：CI 可行
assert.equal(evaluate({ account2fa: false, tokenBypass2fa: true, account: 'demo' }).canPublish, true);

// token 未知（granular token 可能读不到 /-/npm/v1/tokens）时不误判为可发布
const unknown = evaluate({ account2fa: false, tokenBypass2fa: null, account: 'demo' });
assert.equal(unknown.canPublish, false);

// token 解析优先级：env 覆盖 .npmrc
const fromEnv = resolveToken({ env: { NPM_TOKEN: 'npm_envtoken' }, argv: [] });
assert.equal(fromEnv, 'npm_envtoken');

console.log('PASS  npm 2FA 体检：判定逻辑覆盖账号 2FA / bypass token / 未知三种情形');
