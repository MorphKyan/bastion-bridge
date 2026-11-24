import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/server.js';
import { Store } from '../src/core/store.js';
import { localFixture } from './helpers.js';
import { rpc, stopDaemon } from '../src/client.js';

const exec = promisify(execFile);
async function cli(root: string, ...args: string[]) {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    env: { ...process.env, BASTION_BRIDGE_HOME: root },
  });
  return JSON.parse(stdout);
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
test('stop waits for shutdown and CLI autostart preserves SSH', { timeout: 15000 }, async (t) => {
  const f = await localFixture();
  f.manager.dispose();
  t.after(f.cleanup);
  const config = f.store.config();
  config.port = await freePort();
  f.store.saveConfig(config);
  const first = await startServer(f.store);
  t.after(() => first.close());
  await stopDaemon(f.store);
  await cli(f.root, 'start');
  try {
    assert.equal((await cli(f.root, 'list'))[0].status, 'ready');
    const result = await cli(f.root, 'subshell-exec', 'local-test', 'echo preserved');
    assert.equal(result.output, 'preserved\n');
    assert.equal(result.exitCode, 0);
  } finally {
    await stopDaemon(f.store);
  }
});
test(
  'HTTP and Unix socket share leases; duplicate daemon refused; MCP executes and returns structured output',
  { timeout: 20000 },
  async (t) => {
    const f = await localFixture();
    f.manager.dispose();
    const config = f.store.config();
    config.port = await freePort();
    f.store.saveConfig(config);
    const server = await startServer(f.store);
    t.after(async () => {
      await server.close();
      await f.cleanup();
    });
    const duplicateStore = new Store(f.root);
    await assert.rejects(() => startServer(duplicateStore), { code: 'DAEMON_RUNNING' });
    const url = `http://127.0.0.1:${config.port}`;
    const state = (await (await fetch(url + '/api/state')).json()) as any;
    assert.equal(state.sessions[0].status, 'ready');
    assert.equal(
      (await fetch(url + '/api/state', { headers: { Origin: 'http://unrelated.example' } })).status,
      403,
    );
    const acquired = await rpc('acquire', { asset: 'local-test' }, 'CLI-test', f.store);
    const busy = await fetch(url + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'subshell_exec',
        args: { asset: 'local-test', command: 'echo denied' },
      }),
    });
    assert.equal(((await busy.json()) as any).error.code, 'SESSION_BUSY');
    await rpc(
      'release',
      { asset: 'local-test', leaseToken: acquired.lease.token },
      'CLI-test',
      f.store,
    );
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp.ts'],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), BASTION_BRIDGE_HOME: f.root },
      stderr: 'pipe',
    });
    await client.connect(transport);
    t.after(() => client.close());
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((x) => x.name).sort(),
      [
        'list',
        'acquire',
        'renew',
        'release',
        'send',
        'key',
        'read',
        'exec',
        'subshell_exec',
        'subshell_batch',
        'operation_wait',
        'operation_read',
      ].sort(),
    );
    for (const action of ['session_acquire', 'exec_batch', 'toString', 'shutdown']) {
      const old = await fetch(url + '/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, args: { asset: 'local-test' } }),
      });
      assert.equal(((await old.json()) as any).error.code, 'UNKNOWN_ACTION');
    }
    const result = await client.callTool({
      name: 'subshell_exec',
      arguments: {
        asset: 'local-test',
        command: "printf 'mcp-result'",
        requestId: 'mcp-one',
        waitMs: 3000,
      },
    });
    assert.equal(result.isError, undefined);
    const output = (result.structuredContent as any).result;
    assert.equal(output.output, 'mcp-result');
    assert.equal(output.exitCode, 0);
    const replay = await client.callTool({
      name: 'subshell_exec',
      arguments: {
        asset: 'local-test',
        command: "printf 'mcp-result'",
        requestId: 'mcp-one',
        waitMs: 0,
      },
    });
    assert.equal((replay.structuredContent as any).result.id, output.id);
    assert.equal((await rpc('list', {}, 'CLI-test', f.store))[0].lease, undefined);
    const missing = await client.callTool({
      name: 'exec',
      arguments: { asset: 'local-test', command: 'echo denied' },
    });
    assert.equal(missing.isError, true);
    const occupied = await client.callTool({
      name: 'acquire',
      arguments: { asset: 'local-test', purpose: '  查看服务日志  ' },
    });
    const leaseToken = (occupied.structuredContent as any).result.lease.token;
    const occupiedState = await (await fetch(url + '/api/state')).json();
    assert.equal(occupiedState.sessions[0].lease.purpose, '查看服务日志');
    assert.equal(occupiedState.sessions[0].lease.token, undefined);
    const persistent = async (command: string, requestId: string) => {
      const result = await client.callTool({
        name: 'exec',
        arguments: { asset: 'local-test', leaseToken, command, requestId, waitMs: 3000 },
      });
      assert.equal(result.isError, undefined);
      return (result.structuredContent as any).result;
    };
    const first = await persistent('MCP_LOCAL=retained; builtin printf first', 'persistent-first');
    assert.equal(first.executionMode, 'session');
    assert.equal(
      (await persistent('MCP_LOCAL=retained; builtin printf first', 'persistent-first')).id,
      first.id,
    );
    assert.equal(
      (await persistent('builtin printf "%s" "$MCP_LOCAL"', 'persistent-next')).output,
      'retained',
    );
    assert.ok((await rpc('list', {}, 'CLI-test', f.store))[0].lease);
    await client.callTool({ name: 'release', arguments: { asset: 'local-test', leaseToken } });
    assert.equal((await rpc('list', {}, 'CLI-test', f.store))[0].lease, undefined);
    const runCli = (...args: string[]) => cli(f.root, ...args);
    const cliLease = (await runCli('acquire', 'local-test')).lease.token;
    assert.equal(
      (await runCli('exec', 'local-test', 'CLI_LOCAL=cli', '--lease', cliLease)).executionMode,
      'session',
    );
    assert.equal(
      (await runCli('exec', 'local-test', 'builtin printf "%s" "$CLI_LOCAL"', '--lease', cliLease))
        .output,
      'cli',
    );
    assert.equal(
      (
        await runCli(
          'subshell-exec',
          'local-test',
          'printf "%s" "${CLI_LOCAL-unset}"',
          '--lease',
          cliLease,
        )
      ).output,
      'unset',
    );
    await runCli('release', 'local-test', '--lease', cliLease);
    await assert.rejects(
      () => runCli('exec', 'local-test', 'echo denied'),
      (e: any) => JSON.parse(e.stderr).error.code === 'LEASE_REQUIRED',
    );
    await assert.rejects(
      () => runCli('exec-batch', 'local-test'),
      (e: any) => JSON.parse(e.stderr).error.code === 'UNKNOWN_COMMAND',
    );
    assert.equal(
      (await runCli('subshell-exec', 'local-test', 'echo isolated')).executionMode,
      'subshell',
    );
    assert.equal((await runCli('list'))[0].lease, undefined);
  },
);
