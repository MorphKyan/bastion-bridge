import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/core/store.js';
import { Manager } from '../src/core/manager.js';
import type { Binding } from '../src/shared.js';
import type { Terminal, TerminalBridge } from '../src/core/tmux.js';
import { eventually } from './helpers.js';

test('slow authentication does not treat an unchanged prompt as rejection', async (t) => {
  const f = await fixture(t);
  f.gateway.authDelay = 300;
  await f.manager.ensure('one');
  await new Promise((r) => setTimeout(r, 230));
  assert.equal(f.manager.list()[0].status, 'connecting');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('one', '123456');
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(f.manager.list()[0].status, 'connecting');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'ready',
  );
});

test('account selection ignores an older menu retained in terminal scrollback', async (t) => {
  const f = await fixture(t, true);
  const c = f.store.config();
  c.assets[0].username = 'olduser';
  f.store.saveConfig(c);
  await f.manager.ensure('one');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('one', '123456');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'needs_username',
  );
  assert.deepEqual(f.manager.list()[0].accounts, ['appuser', 'serviceuser']);
  assert.ok(!f.gateway.inputs.some((i) => i.text === 'olduser'));
});

class FakeBridge extends EventEmitter implements TerminalBridge {
  ready = Promise.resolve();
  close() {}
}
class Gateway implements Terminal {
  screens = new Map<string, string>();
  bridges = new Map<string, FakeBridge>();
  inputs: { name: string; text: string }[] = [];
  ignoreInterrupt = false;
  authDelay = 0;
  constructor(readonly usernameMenu = false) {}
  update(b: Binding, text: string) {
    this.screens.set(b.name, text);
    this.bridges.get(b.name)?.emit('data', text + '\r\n');
  }
  async create(socket: string, name: string) {
    const b = { asset: name, socket, name, pane: name };
    this.screens.set(name, '(test@127.0.0.1) Password:');
    return b;
  }
  async exists(b: Binding) {
    return this.screens.has(b.name);
  }
  async capture(b: Binding) {
    return this.screens.get(b.name)!;
  }
  async send(b: Binding, text: string) {
    this.inputs.push({ name: b.name, text });
    const current = this.screens.get(b.name)!;
    if (current.endsWith(') Password:')) {
      if (this.authDelay) {
        this.update(b, current + '\n');
        setTimeout(() => this.update(b, '2nd Password:'), this.authDelay);
      } else this.update(b, '2nd Password:');
    } else if (current.endsWith('2nd Password:')) {
      const next =
        text === '000000' ? 'Invalid verification code\n2nd Password:' : '请选择目标资产：';
      if (this.authDelay) {
        this.update(b, current + '\n');
        setTimeout(() => this.update(b, next), this.authDelay);
      } else this.update(b, next);
    } else if (current.endsWith('请选择目标资产：'))
      this.update(
        b,
        this.usernameMenu
          ? '登录账号列表\n 1: * olduser\n请选择登录账号：olduser\n旧会话结束\n登录账号列表\n 1: * appuser\n 2: * serviceuser\n请选择登录账号：'
          : '[tester@local ~]$',
      );
    else if (current.endsWith('请选择登录账号：')) this.update(b, `[${text}@local ~]$`);
    else this.update(b, '[tester@local ~]$ ' + text);
  }
  async key(b: Binding) {
    if (!this.ignoreInterrupt) this.update(b, '[tester@local ~]$');
  }
  async resize() {}
  async close(b: Binding) {
    this.screens.delete(b.name);
  }
  async rename(b: Binding, name: string) {
    return { ...b, name };
  }
  async list() {
    return [];
  }
  bridge(b: Binding) {
    const bridge = new FakeBridge();
    this.bridges.set(b.name, bridge);
    return bridge;
  }
}
async function fixture(t: any, menu = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-bridge-login-'));
  const store = new Store(root);
  const gateway = new Gateway(menu);
  const c = store.config();
  c.bastions = [
    {
      id: 'qizhi',
      name: 'Test bastion',
      host: '127.0.0.1',
      port: 22,
      username: 'test',
      fingerprint: 'SHA256:testkey',
    },
  ];
  c.assets = [
    { name: 'one', ip: '127.0.0.1', username: menu ? 'serviceuser' : 'tester', bastion: 'qizhi' },
    { name: 'two', ip: '127.0.0.2', username: menu ? 'serviceuser' : 'tester', bastion: 'qizhi' },
  ];
  store.saveConfig(c);
  store.savePassword('qizhi', 'test-only-password');
  const manager = new Manager(store, gateway, async () => ({
    fingerprints: ['SHA256:testkey'],
    keys: '127.0.0.1 ssh-rsa TESTKEY\n',
  }));
  t.after(() => {
    manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, store, gateway };
}
test('direct IP login skips username selection; code is not persisted', async (t) => {
  const f = await fixture(t);
  await f.manager.ensure('one');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('one', '123456');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'ready',
  );
  assert.deepEqual(
    f.gateway.inputs.map((i) => i.text),
    ['test-only-password', '123456', '127.0.0.1'],
  );
  assert.ok(!JSON.stringify(f.manager.state()).includes('test-only-password'));
  assert.ok(!JSON.stringify(f.store.bindings()).includes('123456'));
  assert.equal(fs.statSync(f.store.configDir + '/credentials.json').mode & 0o777, 0o600);
});
test('username menu selects configured username; missing name waits for explicit choice', async (t) => {
  const f = await fixture(t, true);
  await f.manager.ensure('one');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('one', '123456');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'ready',
  );
  assert.equal(f.gateway.inputs.at(-1)!.text, 'serviceuser');
  const config = f.store.config();
  config.assets[1].username = undefined;
  f.store.saveConfig(config);
  await f.manager.ensure('two');
  await eventually(
    () => f.manager.list()[1].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('two', '654321');
  await eventually(
    () => f.manager.list()[1].status,
    (s) => s === 'needs_username',
  );
  assert.deepEqual(f.manager.list()[1].accounts, ['appuser', 'serviceuser']);
  await f.manager.selectUsername('two', 'serviceuser');
  await eventually(
    () => f.manager.list()[1].status,
    (s) => s === 'ready',
  );
  assert.equal(f.store.config().assets[1].username, 'serviceuser');
});
test('serial login requires distinct manual challenges and code retry stays at current asset', async (t) => {
  const f = await fixture(t);
  const batch = await f.manager.startBatch(['two', 'one']);
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  assert.equal(f.gateway.screens.has('two'), false);
  await f.manager.submitCode('one', '000000');
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  assert.equal(batch.index, 0);
  await f.manager.submitCode('one', '123456');
  await eventually(
    () => f.manager.list()[1].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('two', '654321');
  await eventually(
    () => batch.status,
    (s) => s === 'completed',
  );
  assert.equal(batch.results.length, 2);
});
test(
  'failed interruption blocks reuse instead of letting another owner in',
  { timeout: 8000 },
  async (t) => {
    const f = await fixture(t);
    await f.manager.ensure('one');
    await eventually(
      () => f.manager.list()[0].status,
      (s) => s === 'waiting_code',
    );
    await f.manager.submitCode('one', '123456');
    await eventually(
      () => f.manager.list()[0].status,
      (s) => s === 'ready',
    );
    const lease = await f.manager.acquire('one', 'test');
    await f.manager.send('one', lease.lease!.token, 'ignores-interrupt', true);
    f.gateway.ignoreInterrupt = true;
    f.manager.sessions.get('one')!.lease!.expiresAt = Date.now() - 1;
    await f.manager.expire();
    assert.equal(f.manager.list()[0].status, 'needs_attention');
    assert.equal((await f.manager.acquire('one', 'next')).status, 'needs_attention');
  },
);
test('temporary password stays in memory and remembered password is editable', async (t) => {
  const f = await fixture(t);
  await f.manager.credentials('qizhi', 'temporary-test-password', 'test', false);
  assert.equal(f.store.password('qizhi'), undefined);
  await f.manager.credentials('qizhi', 'replacement-test-password', 'test', true);
  assert.equal(f.store.password('qizhi'), 'replacement-test-password');
});
test('unconfigured username pauses a login batch; skip and cancel preserve completed connections', async (t) => {
  const f = await fixture(t, true);
  const c = f.store.config();
  c.assets[0].username = undefined;
  f.store.saveConfig(c);
  const b = await f.manager.startBatch(['one', 'two']);
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('one', '123456');
  await eventually(
    () => b.status,
    (s) => s === 'paused',
  );
  assert.equal(b.index, 0);
  await f.manager.batchAction(b.id, 'skip');
  await eventually(
    () => f.manager.list()[1].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.submitCode('two', '654321');
  await eventually(
    () => b.status,
    (s) => s === 'completed',
  );
  assert.equal(f.manager.list()[1].status, 'ready');
  const next = await f.manager.startBatch(['one']);
  await eventually(
    () => f.manager.list()[0].status,
    (s) => s === 'waiting_code',
  );
  await f.manager.batchAction(next.id, 'cancel');
  assert.equal(next.status, 'cancelled');
  assert.equal(f.manager.list()[1].status, 'ready');
});
