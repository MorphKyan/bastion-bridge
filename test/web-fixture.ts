import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { Tmux } from '../src/core/tmux.js';
import { startServer } from '../src/server.js';
import { eventually } from './helpers.js';
import { shellQuote } from '../src/core/framing.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-term-web-'));
const store = new Store(root);
const config = store.config();
config.bastions = [
  { id: 'qizhi', name: 'Test bastion', host: '127.0.0.1', port: 22, username: 'tester' },
];
config.port = 8766;
config.assets = [{ name: 'demo', ip: '127.0.0.1', username: 'tester', bastion: 'qizhi' }];
store.saveConfig(config);
const terminal = new Tmux();
const socket = `aiweb-${randomUUID().slice(0, 8)}`;
const binding = await terminal.create(
  socket,
  'fixture',
  `printf 'Connecting to tester@127.0.0.1(local) ...\\n'; exec env PS1=${shellQuote('[tester@local ~]$ ')} bash --noprofile --norc -i`,
);
await eventually(
  () => terminal.capture(binding),
  (s) => s.trimEnd().endsWith('[tester@local ~]$'),
);
const server = await startServer(store);
await server.manager.importSession('demo', socket, 'fixture');
console.log('Browser fixture ready.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  try {
    await terminal.close({ ...binding, name: 'demo' });
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
