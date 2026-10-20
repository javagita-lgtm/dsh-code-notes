/**
 * 发布后的可安装性验证（只读、无需 token）。
 *
 * 检查三件事，任何一件不通过都会给出可执行的修复命令：
 *   1. 目标版本确实在 npmjs 上
 *   2. `latest` dist-tag 指向目标版本
 *      —— 暂存发布会先创建一个 `0.0.0-stage` 占位包，若 latest 仍指向它，
 *         `pnpm add dsh-code-notes` 装到的就是占位包而不是真版本
 *   3. 能在干净目录里匿名安装（不读取本机 .npmrc 里的 token）
 *
 * 用法：
 *   node scripts/verify-published.mjs            # 校验 package.json 里的版本
 *   node scripts/verify-published.mjs 0.2.1      # 校验指定版本
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return undefined;
  return response.json();
}

/**
 * 判定一次发布是否「可安装」。
 * @param {{ version: string, versions: string[], latest: string|undefined, installOk: boolean }} input
 */
export function judge({ version, versions, latest, installOk }) {
  const problems = [];
  if (!versions.includes(version)) problems.push(`版本 ${version} 不在 registry 上`);
  if (latest !== version) {
    problems.push(`latest 指向 ${latest ?? '(空)'}，不是 ${version}。修复：npm dist-tag add dsh-code-notes@${version} latest`);
  }
  if (!installOk) problems.push('干净目录里匿名安装失败（检查包是否是 public、tarball 是否可用）');
  return { ok: problems.length === 0, problems };
}

async function anonymousInstallCheck(name, version) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-verify-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'verify-probe', version: '1.0.0', private: true }, null, 2), 'utf8');
    // 用空 userconfig 屏蔽本机 ~/.npmrc，确保是真正的匿名安装
    const emptyRc = path.join(dir, '.npmrc');
    await writeFile(emptyRc, '', 'utf8');
    // Windows 上直接 execFile('npm.cmd') 会 EINVAL，统一经 node 调 npm-cli.js
    const [command, args] = await npmRunner(['install', `${name}@${version}`, '--no-audit', '--no-fund']);
    await run(command, args, {
      cwd: dir,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: emptyRc, NODE_AUTH_TOKEN: '', NPM_TOKEN: '' },
      timeout: 120_000
    });
    const installed = JSON.parse(await readFile(path.join(dir, 'node_modules', name, 'package.json'), 'utf8'));
    return installed.version === version;
  } catch (error) {
    console.error(`安装校验失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 找到当前 npm 的可执行入口，跨平台可用。
 * Windows 上 execFile('npm.cmd') 会 EINVAL，所以优先经 node 直接跑 npm-cli.js；
 * npm 装在 node 旁边时（如 G:\node\node_modules\npm）用相对 node 的路径解析，不依赖 cwd。
 */
async function npmRunner(args) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return [process.execPath, [candidate, ...args]];
    } catch {
      // 试下一个候选
    }
  }
  // 兜底：交给 npm shim（POSIX 下通常可用）
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm', args];
}

async function main() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const target = process.argv[2] ?? pkg.version;
  const name = pkg.name;

  const doc = await fetchJson(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`);
  if (doc === undefined) {
    console.error(`registry 上找不到 ${name}`);
    process.exitCode = 1;
    return;
  }
  const versions = Object.keys(doc.versions ?? {});
  const latest = doc['dist-tags']?.latest;
  console.log(`包: ${name}`);
  console.log(`已发布版本: ${versions.join(', ') || '(无)'}`);
  console.log(`latest: ${latest ?? '(空)'}`);
  if (latest === '0.0.0-stage') {
    console.log('注意：latest 目前是暂存发布的占位版本，安装会拿到空包。');
  }

  const installOk = await anonymousInstallCheck(name, target);
  console.log(`匿名安装 ${target}: ${installOk ? '成功' : '失败'}`);

  const verdict = judge({ version: target, versions, latest, installOk });
  console.log(`\n结论: ${verdict.ok ? '可以放心让用户 pnpm add' : '还不具备安装条件'}`);
  for (const problem of verdict.problems) console.log(`- ${problem}`);
  if (!verdict.ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url.endsWith(path.basename(entry))) {
  await main();
}
