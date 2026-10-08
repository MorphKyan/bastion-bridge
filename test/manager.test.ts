import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { OperationResult } from '../src/shared.js';
import { Manager } from '../src/core/manager.js';
import { localFixture, eventually } from './helpers.js';

test(
  'request deduplication survives caller changes without sharing the live lease',
  { timeout: 10000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const args = {
      asset: 'local-test',
      command: 'sleep 0.3; echo once',
      requestId: 'cross-caller',
      waitMs: 0,
    };
    const first = (await f.manager.executeSubshell(args, 'first-process')) as OperationResult;
    const second = (await f.manager.executeSubshell(args, 'restarted-process')) as OperationResult;
    assert.equal(second.id, first.id);
    assert.equal(second.leaseToken, undefined);
    await assert.rejects(() => f.manager.acquire('local-test', 'other-agent'), {
      code: 'SESSION_BUSY',
    });
    const done = await f.manager.wait(first.id, 3000, first.leaseToken);
    assert.equal(done.output, 'once\n');
    assert.equal(
      ((await f.manager.executeSubshell(args, 'another-process')) as OperationResult).id,
      first.id,
    );
  },
);

test(
  'real tmux exec returns only command output, exit status, isolated environment and deduplicates',
  { timeout: 20000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const run = (command: string, requestId?: string) =>
      f.manager.executeSubshell(
        { asset: 'local-test', command, requestId, waitMs: 3000 },
        'test',
      ) as Promise<OperationResult>;
    let result = await run("printf 'first-中文'; printf ' error' >&2; exit 7", 'one');
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'first-中文 error');
    assert.equal(result.exitCode, 7);
    assert.equal(f.manager.list()[0].lease, undefined);
    const replay = await run("printf 'first-中文'; printf ' error' >&2; exit 7", 'one');
    assert.equal(replay.id, result.id);
    await assert.rejects(() => run('echo wrong', 'one'), { code: 'REQUEST_CONFLICT' });
    await run('cd /; export BASTION_BRIDGE_TEST_VAR=abc; exit 0');
    result = await run('printf "%s" "${BASTION_BRIDGE_TEST_VAR-unset}"');
    assert.equal(result.output, 'unset');
    result = (await f.manager.executeSubshell(
      { asset: 'local-test', command: 'pwd', cwd: '/tmp', waitMs: 3000 },
      'test',
    )) as OperationResult;
    assert.equal(result.output, '/tmp\n');
    result = await run("printf 'next\\n'");
    assert.equal(result.output, 'next\n');
    assert.ok(!result.output.includes('first'));
  },
);
test(
  'concurrent acquire, takeover and stale completion do not release new owner',
  { timeout: 15000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const attempts = await Promise.allSettled([
      f.manager.acquire('local-test', 'one'),
      f.manager.acquire('local-test', 'two'),
    ]);
    assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
    const winner = attempts.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>;
    const token = winner.value.lease.token;
    const pending = (await f.manager.executeSubshell(
      { asset: 'local-test', command: 'sleep 0.3; echo finished', leaseToken: token, waitMs: 0 },
      'one',
    )) as OperationResult;
    const human = await f.manager.takeover('local-test', 'human');
    assert.throws(() => f.manager.renew('local-test', token), { code: 'LEASE_INVALID' });
    const done = await f.manager.wait(pending.id, 3000);
    assert.equal(done.status, 'completed');
    assert.equal(f.manager.list()[0].lease?.owner, 'human');
    assert.equal(f.manager.renew('local-test', human.lease.token).token, human.lease.token);
    await f.manager.release('local-test', human.lease.token);
  },
);
test(
  'long task returns handle and renews with token; expiry interrupts before reuse',
  { timeout: 15000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const pending = (await f.manager.executeSubshell(
      { asset: 'local-test', command: 'sleep 30; echo should-not-run', waitMs: 30 },
      'test',
    )) as OperationResult;
    assert.equal(pending.status, 'running');
    assert.ok(pending.leaseToken);
    assert.equal((await f.manager.wait(pending.id, 0, pending.leaseToken)).status, 'running');
    f.manager.sessions.get('local-test')!.lease!.expiresAt = Date.now() - 1;
    await f.manager.expire();
    assert.equal(f.manager.list()[0].status, 'ready');
    assert.equal(f.manager.list()[0].lease, undefined);
    assert.ok(['interrupted', 'completed'].includes(f.manager.result(pending.id).status));
    assert.ok(!f.manager.result(pending.id).output.includes('should-not-run'));
    const acquired = await f.manager.acquire('local-test', 'next');
    assert.equal(acquired.status, 'acquired');
  },
);
test(
  'large output is paged with explicit truncation and independent reads',
  { timeout: 15000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const output = (await f.manager.executeSubshell(
      { asset: 'local-test', command: 'python3 -c \'print("汉" * 30000)\'', waitMs: 5000 },
      'test',
    )) as OperationResult;
    assert.equal(output.status, 'completed');
    assert.equal(output.truncated, true);
    assert.ok(!output.output.includes('\ufffd'));
    const next = f.manager.result(output.id, output.cursor);
    assert.equal(next.truncated, false);
    assert.equal(output.output + next.output, '汉'.repeat(30000) + '\n');
    assert.equal(f.manager.result(output.id).cursor, output.cursor);
  },
);
test(
  'restart preserves terminal, invalidates leases and marks pending operation unknown',
  { timeout: 15000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const acquired = await f.manager.acquire('local-test', 'test');
    const token = acquired.lease!.token;
    f.manager.dispose();
    const second = new Manager(f.store, f.terminal);
    t.after(() => second.dispose());
    await second.restore();
    assert.equal(second.list()[0].status, 'ready');
    assert.throws(() => second.renew('local-test', token), { code: 'LEASE_INVALID' });
    assert.equal(fs.statSync(f.store.configDir + '/config.json').mode & 0o777, 0o600);
  },
);
test(
  'terminal delta cursor is per caller and normal output cannot trigger password submission',
  { timeout: 15000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const acquired = await f.manager.acquire('local-test', 'test');
    const token = acquired.lease!.token;
    f.store.savePassword('qizhi', 'private-test-secret');
    await f.manager.send('local-test', token, "printf 'Password:'", true);
    await eventually(
      () => f.manager.read('local-test', token, 0),
      (r) => r.output.includes('Password:'),
    );
    const a = f.manager.read('local-test', token, 0);
    const b = f.manager.read('local-test', token, 0);
    assert.equal(a.output, b.output);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(f.manager.list()[0].status, 'ready');
    assert.ok(!(await f.manager.snapshot('local-test')).includes('private-test-secret'));
  },
);
test(
  'batch commands run automatically after a short wait, return per-step output and stop on error',
  { timeout: 15000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const args = {
      asset: 'local-test',
      commands: ['sleep 0.2; echo one', 'echo two; exit 4', 'echo not-run'],
      requestId: 'batch-one',
      waitMs: 10,
    };
    const pending = (await f.manager.executeSubshellBatch(args, 'test')) as OperationResult;
    assert.equal(pending.status, 'running');
    assert.ok(pending.leaseToken);
    const result = await f.manager.wait(pending.id, 3000, pending.leaseToken);
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 4);
    assert.equal(result.results!.length, 2);
    assert.equal(result.results![0].output, 'one\n');
    assert.equal(result.results![1].output, 'two\n');
    assert.ok(!result.output.includes('not-run'));
    assert.equal(f.manager.list()[0].lease, undefined);
    const again = (await f.manager.executeSubshellBatch(args, 'test')) as OperationResult;
    assert.equal(again.id, pending.id);
    assert.equal(again.results!.length, 2);
  },
);
test(
  'retry of a running exec recovers the operation token without executing twice',
  { timeout: 10000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const args = {
      asset: 'local-test',
      command: 'sleep 0.2; echo once',
      requestId: 'running-retry',
      waitMs: 0,
    };
    const a = (await f.manager.executeSubshell(args, 'test')) as OperationResult;
    const b = (await f.manager.executeSubshell(args, 'test')) as OperationResult;
    assert.equal(a.id, b.id);
    assert.equal(a.leaseToken, b.leaseToken);
    const done = await f.manager.wait(b.id, 3000, b.leaseToken);
    assert.equal(done.output, 'once\n');
  },
);
test(
  'terminal Ctrl-C input interrupts a managed exec and cleans up its operation',
  { timeout: 10000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const acquired = await f.manager.takeover('local-test', 'human');
    const pending = (await f.manager.executeSubshell(
      { asset: 'local-test', command: 'sleep 30', leaseToken: acquired.lease.token, waitMs: 20 },
      'web',
    )) as OperationResult;
    await f.manager.send('local-test', acquired.lease.token, '\x03');
    assert.ok(['completed', 'interrupted'].includes(f.manager.result(pending.id).status));
    assert.equal(f.manager.list()[0].status, 'ready');
    await f.manager.release('local-test', acquired.lease.token);
  },
);
test(
  'batch runner does not renew an abandoned owner and cannot run subsequent commands after expiry',
  { timeout: 10000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const pending = (await f.manager.executeSubshellBatch(
      { asset: 'local-test', commands: ['sleep 30', 'echo forbidden-after-expiry'], waitMs: 20 },
      'test',
    )) as OperationResult;
    await eventually(
      () => f.manager.result(pending.id).steps!.length,
      (n) => n === 1,
    );
    f.manager.sessions.get('local-test')!.lease!.expiresAt = Date.now() - 1;
    await f.manager.expire();
    const done = await f.manager.wait(pending.id, 3000);
    assert.ok(['unknown', 'interrupted'].includes(done.status));
    assert.equal(done.steps!.length, 1);
    assert.ok(!done.output.includes('forbidden-after-expiry'));
  },
);
