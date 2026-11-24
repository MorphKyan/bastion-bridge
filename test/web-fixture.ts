import { startServer } from '../src/server.js';
import { localShell } from './helpers.js';

const { store, socket, cleanup } = await localShell('demo', 8766);
const server = await startServer(store);
await server.manager.importSession('demo', socket, 'fixture');
console.log('Browser fixture ready.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    await cleanup();
  }
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
