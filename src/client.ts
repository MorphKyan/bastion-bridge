import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './core/store.js';
import { ToolError } from './shared.js';

export async function rpc(
  action: string,
  args: unknown = {},
  owner = 'CLI',
  store = new Store(process.env.AI_TERM_HOME),
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: store.socketPath,
        path: '/rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(text);
            if (result.ok) resolve(result.result);
            else
              reject(new ToolError(result.error.code, result.error.message, result.error.details));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', () => reject(new ToolError('DAEMON_UNAVAILABLE', '后台未运行。')));
    req.setTimeout(70000, () => req.destroy());
    req.end(JSON.stringify({ action, args, owner }));
  });
}
export async function ensureDaemon(store = new Store(process.env.AI_TERM_HOME)) {
  try {
    await rpc('list', {}, 'CLI', store);
    return;
  } catch (e) {
    if (!(e instanceof ToolError) || e.code !== 'DAEMON_UNAVAILABLE') throw e;
  }
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './server.ts' : './server.js', import.meta.url));
  const log = fs.openSync(path.join(store.stateDir, 'daemon.log'), 'a', 0o600);
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), entry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      await rpc('list', {}, 'CLI', store);
      return;
    } catch {}
  }
  throw new ToolError(
    'DAEMON_START_FAILED',
    '后台启动失败，请检查本机私有 daemon.log；可能端口已被占用。',
  );
}
export async function stopDaemon(store = new Store(process.env.AI_TERM_HOME)) {
  const result = await rpc('shutdown', {}, 'CLI', store);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      await rpc('list', {}, 'CLI', store);
    } catch (e) {
      if (e instanceof ToolError && e.code === 'DAEMON_UNAVAILABLE') return result;
      throw e;
    }
  }
  throw new ToolError('STOP_TIMEOUT', '后台停止尚未完成，请检查本机状态。');
}
