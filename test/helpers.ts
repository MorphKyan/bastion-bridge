import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timed out waiting for test condition.');
}
export async function localFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-term-test-'));
  const store = new Store(root);
  const terminal = new Tmux();
  const config = store.config();
  config.bastions = [
    { id: 'qizhi', name: 'Test bastion', host: '127.0.0.1', port: 22, username: 'tester' },
  ];
  config.assets = [{ name: 'local-test', ip: '127.0.0.1', username: 'tester', bastion: 'qizhi' }];
  store.saveConfig(config);
  const socket = `aitest-${randomUUID().slice(0, 12)}`;
  const binding = await terminal.create(
    socket,
    'fixture',
    `printf 'Connecting to tester@127.0.0.1(local) ...\\n'; exec env PS1=${shellQuote('[tester@local ~]$ ')} bash --noprofile --norc -i`,
  );
  await eventually(
    () => terminal.capture(binding),
    (s) => s.trimEnd().endsWith('[tester@local ~]$'),
  );
  const manager = new Manager(store, terminal);
  await manager.importSession('local-test', socket, 'fixture');
  return {
    manager,
    terminal,
    store,
    root,
    socket,
    cleanup: async () => {
      manager.dispose();
      try {
        await terminal.close({ ...binding, name: 'local-test' });
      } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
