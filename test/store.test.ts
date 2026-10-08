import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, configSchema } from '../src/core/store.js';

test('new stores start empty and preserve existing private configuration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-bridge-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  assert.deepEqual(store.config().bastions, []);
  assert.deepEqual(store.config().assets, []);
  const example = configSchema.parse(JSON.parse(fs.readFileSync('config.example.json', 'utf8')));
  store.saveConfig(example);
  store.savePassword('qizhi', 'test-only-password');
  const configBefore = fs.readFileSync(store.configPath);
  const credentialsBefore = fs.readFileSync(path.join(store.configDir, 'credentials.json'));
  const reopened = new Store(root);
  assert.deepEqual(reopened.config(), example);
  assert.deepEqual(fs.readFileSync(store.configPath), configBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(store.configDir, 'credentials.json')),
    credentialsBefore,
  );
});
