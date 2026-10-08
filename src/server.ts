import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from './core/store.js';
import { Manager } from './core/manager.js';
import { actions, type Action } from './actions.js';
import { ToolError } from './shared.js';

function errorResult(error: unknown) {
  return {
    ok: false,
    error:
      error instanceof ToolError
        ? { code: error.code, message: error.message, details: error.details }
        : { code: 'INVALID_REQUEST', message: '请求参数无效或操作失败，请在本机检查状态。' },
  };
}
async function holdLock(store: Store) {
  const child = spawn(
    'flock',
    [
      '-n',
      path.join(store.stateDir, 'daemon.lock'),
      'sh',
      '-c',
      'printf "locked\\n"; cat >/dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', () => reject(new ToolError('LOCK_UNAVAILABLE', '需要本机 flock 命令。')));
    child.once('exit', () => reject(new ToolError('DAEMON_RUNNING', '同一状态目录已有后台进程。')));
  });
  return child;
}
export async function startServer(store = new Store(process.env.AI_TERM_HOME)) {
  const lock = await holdLock(store);
  const manager = new Manager(store);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const port = store.config().port;
  let closing = false;
  const clients = new Set<http.ServerResponse>();
  const rpc = async (body: any) => {
    try {
      if (!body || typeof body.action !== 'string' || !(body.action in actions))
        throw new ToolError('UNKNOWN_ACTION', '未知调用。');
      if (body.action === 'toString' || !Object.hasOwn(actions, body.action))
        throw new ToolError('UNKNOWN_ACTION', '未知调用。');
      const args = actions[body.action as Action].parse(body.args ?? {});
      return {
        ok: true,
        result: await manager.call(
          body.action,
          args,
          typeof body.owner === 'string' ? body.owner.slice(0, 100) : 'Agent',
        ),
      };
    } catch (e) {
      return errorResult(e);
    }
  };
  const unix = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404);
      res.end();
      return;
    }
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    let body: any;
    try {
      body = JSON.parse(data);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify(errorResult(null)));
      return;
    }
    if (body.action === 'shutdown') {
      res.end(JSON.stringify({ ok: true, result: { stopped: true, sessionsPreserved: true } }));
      setTimeout(() => void close(), 20);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(await rpc(body)));
  });
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (
      (origin && !origins.has(origin)) ||
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (host && ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
    ) {
      reply.code(403).send({ error: 'Only the local application origin is accepted.' });
      return;
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  await app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  app.post('/api/rpc', async (req, reply) => {
    // Browser control does not expose the backend shutdown action.
    const result = await rpc(req.body);
    if (!result.ok) reply.code(400);
    return result;
  });
  app.get('/api/state', () => manager.state());
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify(manager.state())}\n\n`);
    req.raw.on('close', () => clients.delete(res));
  });
  let broadcastTimer: NodeJS.Timeout | undefined;
  manager.on('change', () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      const message = `data: ${JSON.stringify(manager.state())}\n\n`;
      for (const res of clients) {
        if (res.writableLength > 1024 * 1024) {
          res.destroy();
          clients.delete(res);
        } else res.write(message);
      }
    }, 100);
  });
  const keepalive = setInterval(() => {
    for (const res of clients) res.write(':keepalive\n\n');
  }, 15000);
  keepalive.unref();
  app.get('/terminal/:asset', { websocket: true }, (socket, req) => {
    const asset = (req.params as any).asset;
    let subscribed = true;
    let pending = 0;
    let missed = false;
    const visible = (status?: string) =>
      ['ready', 'recovering', 'needs_attention'].includes(status ?? '');
    let wasVisible = visible(manager.list().find((s) => s.asset === asset)?.status);
    const send = (value: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(value));
    };
    const output = (name: string, text: string) => {
      if (name !== asset || !subscribed) return;
      if (socket.bufferedAmount > 1024 * 1024 || pending > 512 * 1024) {
        missed = true;
        return;
      }
      pending += Buffer.byteLength(text);
      send({ type: 'output', text });
    };
    manager.on('output', output);
    const stateChanged = (session?: { asset: string; status: string }) => {
      if (!session || session.asset !== asset) return;
      const nowVisible = visible(session.status);
      if (nowVisible !== wasVisible) {
        wasVisible = nowVisible;
        void manager
          .snapshot(asset)
          .then((text) => send({ type: 'snapshot', text }))
          .catch(() => {});
      }
    };
    manager.on('change', stateChanged);
    void manager
      .snapshot(asset)
      .then((text) => send({ type: 'snapshot', text }))
      .catch(() => {});
    socket.on('message', (data: any) => {
      void (async () => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'ack') {
            if (
              !Number.isInteger(message.bytes) ||
              message.bytes < 0 ||
              message.bytes > 1024 * 1024
            )
              return;
            pending = Math.max(0, pending - message.bytes);
            if (missed && pending < 64 * 1024) {
              missed = false;
              send({
                type: 'snapshot',
                text: await manager.snapshot(asset),
                message: '输出过快，已重新同步终端屏幕。',
              });
            }
            return;
          }
          if (message.type === 'input')
            await manager.call(
              'send',
              actions.send.parse({
                asset,
                leaseToken: message.leaseToken,
                text: message.text,
              }),
            );
          else if (message.type === 'resize')
            await manager.call(
              'resize',
              actions.resize.parse({
                asset,
                leaseToken: message.leaseToken,
                cols: message.cols,
                rows: message.rows,
              }),
            );
        } catch (e) {
          send({ type: 'error', message: e instanceof ToolError ? e.message : '终端输入无效。' });
        }
      })();
    });
    socket.on('close', () => {
      subscribed = false;
      manager.off('output', output);
      manager.off('change', stateChanged);
    });
  });
  const webDir = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? '../dist/web/' : './web/', import.meta.url),
  );
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  app.get('/*', async (req, reply) => {
    const url = req.url.split('?')[0];
    let relative: string;
    try {
      relative = decodeURIComponent(url).replace(/^\/+/, '');
    } catch {
      return reply.code(400).send('Invalid path');
    }
    let target = path.resolve(webDir, relative || 'index.html');
    if (!target.startsWith(path.resolve(webDir) + path.sep))
      return reply.code(404).send('Not found');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile())
      target = path.join(webDir, 'index.html');
    if (!fs.existsSync(target))
      return reply.code(503).send('请先执行 npm run build，或用 npm run web:dev 启动开发网页。');
    reply.type(mime[path.extname(target)] ?? 'application/octet-stream');
    return fs.createReadStream(target);
  });
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(keepalive);
    if (broadcastTimer) clearTimeout(broadcastTimer);
    manager.dispose();
    for (const res of clients) res.end();
    clients.clear();
    await app.close();
    await new Promise<void>((resolve) => unix.close(() => resolve()));
    try {
      fs.unlinkSync(store.socketPath);
    } catch {}
    lock.stdin.end();
    lock.kill();
  }
  try {
    try {
      fs.unlinkSync(store.socketPath);
    } catch {}
    await manager.restore();
    await app.listen({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      unix.once('error', reject);
      unix.listen(store.socketPath, () => {
        fs.chmodSync(store.socketPath, 0o600);
        resolve();
      });
    });
  } catch (e) {
    await close();
    throw e;
  }
  return { manager, app, close };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer()
    .then((server) => {
      process.stdout.write(`AI Term listening at ${server.manager.webUrl()}\n`);
      process.on('SIGINT', () => void server.close());
      process.on('SIGTERM', () => void server.close());
    })
    .catch((e) => {
      process.stderr.write(
        (e instanceof ToolError ? e.message : '后台启动失败，请检查端口、配置和依赖。') + '\n',
      );
      process.exitCode = 1;
    });
}
