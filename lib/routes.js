/**
 * Host 侧的 HTTP 路由：给 Web 面板调用（同源、loopback 限定）。
 *
 * 只有面板会用这些路由；Agent 侧走的是工具与 /讲解 命令，两边最终都调用
 * 同一个 ExplainerService 方法（operation 只有一份实现）。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  return parsed !== null && typeof parsed === 'object' ? parsed : {};
}

const isLoopback = (req) => {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};

/** 判断请求是不是浏览器同源的页面请求（防止其它站点跨站调用本机接口）。 */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const sessionIdOf = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/**
 * 注册 /api/dsh-code-notes/* 路由。
 * @param ctx Host context
 * @param service ExplainerService
 */
export function registerRoutes(ctx, service) {
  const webserver = ctx.get('webServer');
  if (webserver === undefined) {
    console.warn('[dsh-code-notes] 未找到 webServer 服务，Web 面板接口未启用');
    return () => {};
  }
  const dispose = webserver.register({
    kind: 'prefix',
    path: '/api/dsh-code-notes',
    handler: async (req, res) => {
      if (!isLoopback(req) || !isSameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机同源访问' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname.replace(/^\/api\/dsh-code-notes/u, '');
      try {
        if (req.method !== 'GET' && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
          return;
        }
        switch (route) {
          case '/history': {
            const sessionId = sessionIdOf(url.searchParams.get('sessionId'));
            sendJson(res, 200, { ok: true, entries: service.history(sessionId), config: service.publicConfig() });
            return;
          }
          case '/explain': {
            const body = await readJsonBody(req);
            const sessionId = sessionIdOf(body.sessionId);
            if (sessionId === undefined) {
              sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
              return;
            }
            const result = await service.explain({
              sessionId,
              instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
              paths: Array.isArray(body.paths) ? body.paths.filter((item) => typeof item === 'string') : undefined
            });
            sendJson(res, result.ok ? 200 : 422, result);
            return;
          }
          case '/write': {
            const body = await readJsonBody(req);
            const sessionId = sessionIdOf(body.sessionId);
            if (sessionId === undefined || typeof body.noteId !== 'string') {
              sendJson(res, 400, { ok: false, error: '缺少 sessionId 或 noteId' });
              return;
            }
            const result = await service.writeNote({ sessionId, noteId: body.noteId });
            sendJson(res, result.ok ? 200 : 422, result);
            return;
          }
          case '/remove': {
            const body = await readJsonBody(req);
            const sessionId = sessionIdOf(body.sessionId);
            if (sessionId === undefined || typeof body.noteId !== 'string') {
              sendJson(res, 400, { ok: false, error: '缺少 sessionId 或 noteId' });
              return;
            }
            sendJson(res, 200, { ok: true, entries: service.remove(sessionId, body.noteId) });
            return;
          }
          case '/settings': {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, config: service.publicConfig() });
              return;
            }
            const body = await readJsonBody(req);
            sendJson(res, 200, { ok: true, config: await service.saveSettings(body.config ?? body) });
            return;
          }
          case '/open': {
            const body = await readJsonBody(req);
            const sessionId = sessionIdOf(body.sessionId);
            const result = typeof body.noteId === 'string' && sessionId !== undefined
              ? await service.openInObsidian({ sessionId, noteId: body.noteId })
              : await service.openVault();
            sendJson(res, result.ok ? 200 : 422, result);
            return;
          }
          case '/selftest': {
            // 自检：报告「插件是否活着、配置是否读对、工具结果能否被解析」，不触网、不调模型。
            sendJson(res, 200, { ok: true, ...service.selfTest() });
            return;
          }
          case '/resolve': {
            const body = await readJsonBody(req);
            const sessionId = sessionIdOf(body.sessionId);
            const route = sessionId === undefined ? undefined : await service.resolveRoute(sessionId);
            sendJson(res, 200, { ok: true, route: route ?? null });
            return;
          }
          default:
            sendJson(res, 404, { ok: false, error: `未知接口 ${route}` });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[dsh-code-notes] ${req.method} ${route} 失败：${message}`);
        sendJson(res, 500, { ok: false, error: message });
      }
    }
  });
  return dispose;
}

/** 解析包内资源路径（patch 与 locale 需要给 GUI 的包详情读）。 */
export function packageRoot() {
  return path.dirname(fileURLToPath(new URL('../index.js', import.meta.url)));
}

/** 读取包内文件（供诊断使用）。 */
export async function readPackageFile(relative) {
  return readFile(path.join(packageRoot(), relative), 'utf8');
}
