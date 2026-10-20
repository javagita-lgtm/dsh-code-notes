/**
 * 发布前的 npm 账号能力体检。
 *
 * npm 发布要求二选一：
 *   ① 账号已开启 2FA（发布时输 OTP）
 *   ② 使用的 granular token 带 bypass_2fa 权限
 * 二者都不满足时，`npm publish` 只会回一个含糊的
 *   403 "Two-factor authentication or granular access token with bypass 2fa enabled is required"
 * 看不出到底缺哪一项。这个脚本用只读接口把两项分别查清楚，并给出可执行结论。
 *
 * 用法：
 *   NPM_TOKEN=npm_xxx node scripts/check-npm-2fa.mjs
 *   node scripts/check-npm-2fa.mjs --token-file ~/.npmrc
 *
 * 退出码：0 = 可以发布；1 = 前置条件不满足（会打印原因）。
 * 不打印 token，任何 token 片段都只输出前 6 位。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';

/** 从各种来源解析 token；返回 undefined 表示没找到。 */
export function resolveToken({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const inline = argv.indexOf('--token-file');
  if (inline >= 0) {
    const file = argv[inline + 1];
    if (file !== undefined) {
      const text = readFileSync(file.startsWith('~') ? path.join(homedir(), file.slice(1)) : file, 'utf8');
      const match = /\/\/registry\.npmjs\.org\/:_authToken=(.+)/u.exec(text);
      if (match !== null) return match[1].trim();
    }
  }
  if (typeof env.NPM_TOKEN === 'string' && env.NPM_TOKEN.trim() !== '') return env.NPM_TOKEN.trim();
  if (typeof env.NODE_AUTH_TOKEN === 'string' && env.NODE_AUTH_TOKEN.trim() !== '') return env.NODE_AUTH_TOKEN.trim();
  try {
    const text = readFileSync(path.join(homedir(), '.npmrc'), 'utf8');
    const match = /\/\/registry\.npmjs\.org\/:_authToken=(.+)/u.exec(text);
    if (match !== null) return match[1].trim();
  } catch {
    // 没有用户级 .npmrc
  }
  return undefined;
}

const mask = (token) => (typeof token === 'string' && token.length > 6 ? `${token.slice(0, 6)}…` : '(空)');

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * 判断能否发布。
 * @returns {{canPublish: boolean, account: string|null, account2fa: boolean|null,
 *            tokenBypass2fa: boolean|null, reason: string}}
 */
export function evaluate({ account2fa, tokenBypass2fa, account }) {
  if (account2fa === true) {
    return {
      canPublish: true,
      account,
      account2fa,
      tokenBypass2fa,
      reason: '账号已开启 2FA：交互式发布可用；CI 无 TTY，仍需 bypass token 或 Trusted Publishing。'
    };
  }
  if (tokenBypass2fa === true) {
    return {
      canPublish: true,
      account,
      account2fa,
      tokenBypass2fa,
      reason: 'token 带 bypass_2fa：CI 可直接发布。'
    };
  }
  return {
    canPublish: false,
    account,
    account2fa,
    tokenBypass2fa,
    reason: '账号未开 2FA 且 token 没有 bypass_2fa —— 这就是 403 的根因。先开账号 2FA，再重建带 Bypass 的 token。'
  };
}

async function main() {
  const token = resolveToken();
  if (token === undefined) {
    console.error('没有找到 npm token（NPM_TOKEN / NODE_AUTH_TOKEN / ~/.npmrc 都没有）');
    process.exitCode = 1;
    return;
  }
  console.log(`token: ${mask(token)}（长度 ${token.length}）`);

  const fetchImpl = globalThis.fetch;
  const user = await getJson(`${REGISTRY}/-/npm/v1/user`, token, fetchImpl);
  if (user.status !== 200) {
    console.error(`读取账号信息失败（HTTP ${user.status}）：token 可能无效或已过期`);
    process.exitCode = 1;
    return;
  }
  const account = typeof user.body?.name === 'string' ? user.body.name : null;
  const account2fa = user.body?.tfa === true;
  console.log(`账号: ${account ?? '(未知)'}  tfa: ${JSON.stringify(user.body?.tfa)}`);

  const tokens = await getJson(`${REGISTRY}/-/npm/v1/tokens`, token, fetchImpl);
  let tokenBypass2fa = null;
  if (tokens.status === 200 && Array.isArray(tokens.body?.objects)) {
    const self = tokens.body.objects.find((entry) => entry.token === mask(token));
    const anyBypass = tokens.body.objects.some((entry) => entry.bypass_2fa === true && entry.revoked === null);
    tokenBypass2fa = self !== undefined && self.bypass_2fa === true ? true : (anyBypass ? null : false);
    console.log(`token 列表: ${tokens.body.objects.length} 个，其中带 bypass_2fa: ${tokens.body.objects.filter((entry) => entry.bypass_2fa === true).length} 个`);
  } else {
    console.log(`无法列出 token（HTTP ${tokens.status}）：granular token 可能没有该权限`);
  }

  const verdict = evaluate({ account2fa, tokenBypass2fa, account });
  console.log(`\n结论: ${verdict.canPublish ? '可以发布' : '不能发布'}`);
  console.log(verdict.reason);
  if (!verdict.canPublish) {
    console.log('\n修复步骤：');
    console.log('  1. 打开 https://www.npmjs.com/settings/~/account → Two-Factor Authentication → Enable');
    console.log('  2. 开启后到 https://www.npmjs.com/settings/~/tokens 新建 Granular Access Token');
    console.log('     - Permissions: Read and write');
    console.log('     - Packages: All packages');
    console.log('     - Bypass two-factor authentication: 勾选（账号开了 2FA 才会生效）');
    console.log('  3. 更新仓库 secret NPM_TOKEN，再重跑发布');
    console.log('  或者：开完 2FA 后直接本地 `npm publish --access public`，按提示输入 OTP。');
    process.exitCode = 1;
  }
}

// 只在「直接 node scripts/check-npm-2fa.mjs」时执行 main；
// 被 test/npm-2fa.mjs import 时只导出纯函数，避免测试触发联网诊断。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  await main();
}
