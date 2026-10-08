import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Manager } from '../src/core/manager.js';
import { shellQuote } from '../src/core/framing.js';
import type { OperationResult } from '../src/shared.js';
import { localFixture, eventually } from './helpers.js';

async function setup(t: TestContext) {
  const f = await localFixture();
  t.after(f.cleanup);
  const { lease } = await f.manager.acquire('local-test', 'agent');
  const run = (
    command: string,
    options: { cwd?: string; requestId?: string; waitMs?: number } = {},
  ) =>
    f.manager.execute(
      { asset: 'local-test', command, leaseToken: lease.token, waitMs: 3000, ...options },
      'agent',
    ) as Promise<OperationResult>;
  return { ...f, lease, run };
}

test(
  'default exec preserves directory, sourced environment, functions and options across calls and release',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    const work = path.join(f.root, 'work dir');
    fs.mkdirSync(work);
    fs.writeFileSync(
      path.join(work, 'env.sh'),
      'LOCAL_ONLY=local\nexport EXPORTED=shared\nhelper() { builtin printf helper; }\nset -f\n',
    );
    const changed = await f.run('source env.sh', { cwd: work });
    assert.equal(changed.executionMode, 'session');
    assert.equal(changed.exitCode, 0);
    assert.equal((await f.run('pwd')).output, work + '\n');
    assert.equal(
      (await f.run('builtin printf "%s:%s:" "$LOCAL_ONLY" "$EXPORTED"; helper; [[ $- == *f* ]]'))
        .output,
      'local:shared:helper',
    );
    assert.equal(f.manager.list()[0].lease?.owner, 'agent');
    const child = (await f.manager.executeSubshell(
      {
        asset: 'local-test',
        leaseToken: f.lease.token,
        command: 'cd /; export EXPORTED=changed; printf "%s:%s" "${LOCAL_ONLY-unset}" "$EXPORTED"',
        waitMs: 3000,
      },
      'agent',
    )) as OperationResult;
    assert.equal(child.executionMode, 'subshell');
    assert.equal(child.output, 'unset:changed');
    assert.equal(
      (await f.run('builtin printf "%s:%s" "$PWD" "$EXPORTED"')).output,
      work + ':shared',
    );
    const batch = (await f.manager.executeSubshellBatch(
      {
        asset: 'local-test',
        leaseToken: f.lease.token,
        commands: ['export BATCH_ONLY=one', 'printf "%s" "${BATCH_ONLY-unset}"'],
        waitMs: 3000,
      },
      'agent',
    )) as OperationResult;
    assert.equal(batch.executionMode, 'subshell');
    assert.equal(batch.results![1].output, 'unset');
    await f.manager.release('local-test', f.lease.token);
    const next = await f.manager.acquire('local-test', 'next');
    const result = (await f.manager.execute(
      {
        asset: 'local-test',
        leaseToken: next.lease.token,
        command: 'builtin printf "%s:%s" "$PWD" "$LOCAL_ONLY"',
        waitMs: 3000,
      },
      'next',
    )) as OperationResult;
    assert.equal(result.output, work + ':local');
    await f.manager.release('local-test', next.lease.token);
  },
);

test(
  'default exec frames multiline commands and failures even with overridden printf/eval',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    assert.equal(
      (
        await f.run(
          "printf() { builtin printf shadow; }\neval() { builtin printf bad-eval; }\nalias printf='false'\nalias eval='false'\nbuiltin printf 'first-中文\\n'\nfalse",
        )
      ).exitCode,
      1,
    );
    assert.equal((await f.run("builtin printf 'second\\n'")).output, 'second\n');
    const failed = await f.run('builtin printf should-not-run', {
      cwd: path.join(f.root, 'missing'),
    });
    assert.equal(failed.status, 'completed');
    assert.equal(failed.exitCode, 1);
    assert.ok(!failed.output.includes('should-not-run'));
    assert.equal(f.manager.list()[0].status, 'ready');
    assert.equal((await f.run('builtin printf alive')).output, 'alive');
  },
);

test(
  'default exec rejects missing/stale leases and deduplicates without mixing execution modes',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    await assert.rejects(
      () => f.manager.call('exec', { asset: 'local-test', command: 'echo forbidden' }),
      { code: 'LEASE_REQUIRED' },
    );
    await assert.rejects(
      () =>
        f.manager.execute(
          { asset: 'local-test', command: 'echo forbidden', leaseToken: randomUUID() },
          'agent',
        ),
      { code: 'LEASE_INVALID' },
    );
    const command = 'COUNT=$(( ${COUNT:-0} + 1 )); builtin printf "%s" "$COUNT"';
    const first = await f.run(command, { requestId: 'counter' });
    assert.equal(first.output, '1');
    assert.equal((await f.run(command, { requestId: 'counter' })).id, first.id);
    assert.equal((await f.run('builtin printf "%s" "$COUNT"')).output, '1');
    await assert.rejects(
      () =>
        f.manager.executeSubshell(
          { asset: 'local-test', command, leaseToken: f.lease.token, requestId: 'counter' },
          'agent',
        ),
      { code: 'REQUEST_CONFLICT' },
    );
    await assert.rejects(() => f.run('echo changed', { requestId: 'counter' }), {
      code: 'REQUEST_CONFLICT',
    });
    await f.manager.release('local-test', f.lease.token);
    await assert.rejects(() => f.run('echo forbidden'), { code: 'LEASE_INVALID' });
    assert.equal(f.manager.result(first.id).output, '1');
  },
);

test(
  'historical operations without executionMode retain subshell deduplication after restart',
  { timeout: 10000 },
  async (t) => {
    const f = await localFixture();
    t.after(f.cleanup);
    const args = {
      asset: 'local-test',
      command: 'echo historical',
      requestId: 'legacy',
      waitMs: 3000,
    };
    const first = (await f.manager.executeSubshell(args, 'agent')) as OperationResult;
    const saved = f.store.operations().find((o) => o.id === first.id)!;
    delete saved.executionMode;
    f.store.saveOperation(saved);
    f.manager.dispose();
    const restored = new Manager(f.store, f.terminal);
    t.after(() => restored.dispose());
    await restored.restore();
    assert.equal(restored.result(first.id).executionMode, 'subshell');
    assert.equal(((await restored.executeSubshell(args, 'agent')) as OperationResult).id, first.id);
    const { lease } = await restored.acquire('local-test', 'agent');
    await assert.rejects(() => restored.execute({ ...args, leaseToken: lease.token }, 'agent'), {
      code: 'REQUEST_CONFLICT',
    });
  },
);

test(
  'persistent command expiry interrupts before reuse and stale completion retains the new owner',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    const pending = await f.run('sleep 30; echo forbidden-after-expiry', { waitMs: 20 });
    assert.equal(pending.status, 'running');
    assert.equal(pending.leaseToken, f.lease.token);
    f.manager.sessions.get('local-test')!.lease!.expiresAt = Date.now() - 1;
    await f.manager.expire();
    assert.equal(f.manager.list()[0].status, 'ready');
    assert.ok(['completed', 'interrupted'].includes(f.manager.result(pending.id).status));
    assert.ok(!f.manager.result(pending.id).output.includes('forbidden-after-expiry'));
    const next = await f.manager.acquire('local-test', 'next');
    const late = (await f.manager.execute(
      {
        asset: 'local-test',
        leaseToken: next.lease.token,
        command: 'sleep 0.2; echo done',
        waitMs: 0,
      },
      'next',
    )) as OperationResult;
    const human = await f.manager.takeover('local-test', 'human');
    assert.equal((await f.manager.wait(late.id, 3000)).status, 'completed');
    assert.equal(f.manager.renew('local-test', human.lease.token).token, human.lease.token);
    await f.manager.release('local-test', human.lease.token);
  },
);

for (const command of ['exit 7', 'exec sleep 0.2']) {
  test(
    `closing the current Shell with ${command} yields unknown without retry`,
    { timeout: 10000 },
    async (t) => {
      const f = await setup(t);
      const result = await f.run(command, { requestId: 'close-shell' });
      assert.equal(result.status, 'unknown');
      assert.equal(result.exitCode, null);
      assert.equal(f.manager.operations.size, 1);
      assert.equal(f.manager.list()[0].lease, undefined);
      assert.equal(f.manager.result(result.id).status, 'unknown');
    },
  );
}

test(
  'a replacement Shell prompt does not complete an operation; explicit confirmation marks it unknown',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    const args = { requestId: 'replace-shell', waitMs: 100 };
    const result = await f.run('exec bash --noprofile --norc -i', args);
    assert.equal(result.status, 'running');
    await eventually(
      () => f.terminal.capture(f.manager.sessions.get('local-test')!.binding!),
      (s) => s.trimEnd().endsWith('[tester@local ~]$'),
    );
    assert.equal(f.manager.result(result.id).status, 'running');
    await f.manager.confirm('local-test');
    assert.equal(f.manager.result(result.id).status, 'unknown');
    const { lease } = await f.manager.acquire('local-test', 'next');
    const replay = (await f.manager.execute(
      {
        asset: 'local-test',
        command: 'exec bash --noprofile --norc -i',
        leaseToken: lease.token,
        ...args,
      },
      'next',
    )) as OperationResult;
    assert.equal(replay.id, result.id);
    assert.equal(replay.status, 'unknown');
    assert.equal(f.manager.operations.size, 1);
  },
);

test(
  'restart invalidates persistent leases and marks pending operations unknown while retaining Shell state',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    await f.run('PERSISTED=retained');
    const pending = await f.run('sleep 0.2; echo done', { waitMs: 0 });
    f.manager.dispose();
    const restored = new Manager(f.store, f.terminal);
    t.after(() => restored.dispose());
    await restored.restore();
    assert.equal(restored.result(pending.id).status, 'unknown');
    assert.equal(restored.result(pending.id).executionMode, 'session');
    assert.throws(() => restored.renew('local-test', f.lease.token), { code: 'LEASE_INVALID' });
    await eventually(
      () => restored.snapshot('local-test'),
      (s) => s.trimEnd().endsWith('[tester@local ~]$'),
    );
    await restored.confirm('local-test');
    const { lease } = await restored.acquire('local-test', 'next');
    const result = (await restored.execute(
      {
        asset: 'local-test',
        leaseToken: lease.token,
        command: 'builtin printf "%s" "$PERSISTED"',
        waitMs: 3000,
      },
      'next',
    )) as OperationResult;
    assert.equal(result.output, 'retained');
  },
);

test(
  'shutdown during prompt confirmation cannot overwrite an unknown operation with a late completion',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    const capture = f.terminal.capture.bind(f.terminal);
    let confirmReached!: () => void;
    let resumeConfirm!: () => void;
    const reached = new Promise<void>((resolve) => {
      confirmReached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resumeConfirm = resolve;
    });
    t.after(resumeConfirm);
    let held = false;
    f.terminal.capture = async (binding) => {
      const output = await capture(binding);
      if (!held && f.manager.sessions.get('local-test')!.activeJob?.ending) {
        held = true;
        confirmReached();
        await gate;
      }
      return output;
    };
    const pending = await f.run('sleep 0.1; echo done', { waitMs: 0 });
    await reached;
    f.manager.dispose();
    assert.equal(f.manager.result(pending.id).status, 'unknown');
    resumeConfirm();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.manager.result(pending.id).status, 'unknown');
    assert.equal(f.store.operations().find((o) => o.id === pending.id)!.status, 'unknown');
  },
);
