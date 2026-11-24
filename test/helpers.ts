import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/core/store.js';
import { Manager } from '../src/core/manager.js';
import { Tmux } from '../src/core/tmux.js';
import { shellQuote } from '../src/core/framing.js';

export async function eventually<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  ms = 4000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (predicate(value)) return value;
    await delay(30);
  }
  throw new Error('Timed out waiting for test condition.');
}
export async function localShell(asset = 'local-test', port?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-bridge-test-'));
  const store = new Store(root);
  const terminal = new Tmux();
  const config = store.config();
  config.bastions = [
    { id: 'qizhi', name: 'Test bastion', host: '127.0.0.1', port: 22, username: 'tester' },
  ];
  config.assets = [{ name: asset, ip: '127.0.0.1', username: 'tester', bastion: 'qizhi' }];
  if (port !== undefined) config.port = port;
  store.saveConfig(config);
  const socket = `bastion-bridge-test-${randomUUID().slice(0, 12)}`;
  const binding = await terminal.create(
    socket,
    'fixture',
    `printf 'Connecting to tester@127.0.0.1(local) ...\\n'; exec env PS1=${shellQuote('[tester@local ~]$ ')} bash --noprofile --norc -i`,
  );
  await eventually(
    () => terminal.capture(binding),
    (s) => s.trimEnd().endsWith('[tester@local ~]$'),
  );
  return {
    terminal,
    store,
    root,
    socket,
    cleanup: async () => {
      try {
        await terminal.close({ ...binding, name: asset });
      } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function localFixture() {
  const shell = await localShell();
  const manager = new Manager(shell.store, shell.terminal);
  await manager.importSession('local-test', shell.socket, 'fixture');
  return {
    ...shell,
    manager,
    cleanup: () => {
      manager.dispose();
      return shell.cleanup();
    },
  };
}
