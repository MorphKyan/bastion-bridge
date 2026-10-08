#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { rpc, ensureDaemon, stopDaemon } from './client.js';
import { startServer } from './server.js';
import { ToolError } from './shared.js';

const help = `bastion bridge — 本机堡垒机会话工具
  bastion-bridge serve                         前台运行（停止后 SSH 保留）
  bastion-bridge start | stop | web | status
  bastion-bridge exec ASSET 'COMMAND' --lease TOKEN [--cwd DIR] [--request-id ID] [--wait-ms 30000]
  bastion-bridge subshell-exec ASSET 'COMMAND' [--cwd DIR] [--lease TOKEN] [--request-id ID]
  bastion-bridge subshell-batch ASSET --commands-file FILE [--lease TOKEN] [--request-id ID]
  bastion-bridge list
  bastion-bridge acquire | connect | reconnect | takeover | release | renew | close | confirm ASSET [--lease TOKEN]
  bastion-bridge send ASSET 'TEXT' --lease TOKEN [--submit]
  bastion-bridge key ASSET Ctrl-C --lease TOKEN
  bastion-bridge read ASSET --lease TOKEN [--cursor N]
  bastion-bridge wait OPERATION [--lease TOKEN] [--wait-ms 30000]
  bastion-bridge result OPERATION [--cursor N]
  bastion-bridge import ASSET --socket TMUX_SOCKET --name TMUX_SESSION
  bastion-bridge credentials --bastion ID --username NAME --password-file PRIVATE_FILE
  bastion-bridge code ASSET --code-file PRIVATE_FILE
  bastion-bridge config [--config-file FILE]
  bastion-bridge call ACTION [--args-file FILE]

输出均为 JSON。密码/验证码只能由私有文件读取，不提供命令行明文参数。
默认流程：acquire → exec（当前 Bash 环境持续保留）→ release（保留 SSH 和环境）。
高级操作：subshell-exec/subshell-batch 使用独立子 Shell，可自动申请和释放占用。
BASTION_BRIDGE_HOME 可指定独立配置/状态目录；默认使用 XDG 目录。`;
async function main() {
  const { positionals: p, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      cwd: { type: 'string' },
      lease: { type: 'string' },
      'request-id': { type: 'string' },
      'wait-ms': { type: 'string' },
      cursor: { type: 'string' },
      socket: { type: 'string' },
      name: { type: 'string' },
      username: { type: 'string' },
      bastion: { type: 'string' },
      'password-file': { type: 'string' },
      'code-file': { type: 'string' },
      'config-file': { type: 'string' },
      'args-file': { type: 'string' },
      'commands-file': { type: 'string' },
      submit: { type: 'boolean' },
    },
  });
  const command = p[0];
  if (!command || v.help) {
    process.stdout.write(help + '\n');
    return;
  }
  if (command === 'serve') {
    const server = await startServer();
    process.stdout.write(`bastion bridge: ${server.manager.webUrl()}\n`);
    process.on('SIGINT', () => void server.close());
    process.on('SIGTERM', () => void server.close());
    return;
  }
  if (command === 'stop') {
    process.stdout.write(JSON.stringify(await stopDaemon()) + '\n');
    return;
  }
  await ensureDaemon();
  const asset = p[1];
  const leaseToken = v.lease;
  const waitMs = v['wait-ms'] ? Number(v['wait-ms']) : undefined;
  let action: string;
  let args: any = {};
  if (command === 'start' || command === 'web') {
    const state = await rpc('state');
    process.stdout.write(JSON.stringify({ webUrl: state.webUrl }) + '\n');
    return;
  }
  if (command === 'status') action = 'state';
  else if (command === 'list') action = 'list';
  else if (command === 'exec' || command === 'subshell-exec') {
    action = command === 'exec' ? 'exec' : 'subshell_exec';
    if (command === 'exec' && !leaseToken)
      throw new ToolError('LEASE_REQUIRED', '请先 acquire 并传入 --lease TOKEN。');
    args = { asset, command: p[2], cwd: v.cwd, leaseToken, requestId: v['request-id'], waitMs };
  } else if (command === 'subshell-batch') {
    action = 'subshell_batch';
    args = {
      asset,
      commands: JSON.parse(fs.readFileSync(v['commands-file']!, 'utf8')),
      cwd: v.cwd,
      leaseToken,
      requestId: v['request-id'],
      waitMs,
    };
  } else if (
    [
      'acquire',
      'connect',
      'reconnect',
      'takeover',
      'release',
      'renew',
      'close',
      'confirm',
    ].includes(command)
  ) {
    action = command;
    args = { asset, leaseToken };
  } else if (command === 'send') {
    action = 'send';
    args = { asset, leaseToken, text: p[2], submit: v.submit };
  } else if (command === 'key') {
    action = 'key';
    args = { asset, leaseToken, key: p[2] };
  } else if (command === 'read') {
    action = 'read';
    args = { asset, leaseToken, cursor: v.cursor ? Number(v.cursor) : undefined };
  } else if (command === 'wait' || command === 'result') {
    action = command === 'wait' ? 'operation_wait' : 'operation_read';
    args = {
      operationId: p[1],
      leaseToken,
      waitMs,
      cursor: v.cursor ? Number(v.cursor) : undefined,
    };
  } else if (command === 'import') {
    action = 'import';
    args = { asset, socket: v.socket, name: v.name };
  } else if (command === 'credentials') {
    action = 'credentials_save';
    args = {
      bastion: v.bastion,
      username: v.username,
      password: v['password-file']
        ? fs.readFileSync(v['password-file'], 'utf8').replace(/[\r\n]+$/, '')
        : undefined,
    };
  } else if (command === 'code') {
    action = 'code';
    args = { asset, code: fs.readFileSync(v['code-file']!, 'utf8').trim() };
  } else if (command === 'config') {
    action = v['config-file'] ? 'config_save' : 'state';
    args = v['config-file']
      ? { config: JSON.parse(fs.readFileSync(v['config-file'], 'utf8')) }
      : {};
  } else if (command === 'call') {
    action = p[1];
    args = v['args-file'] ? JSON.parse(fs.readFileSync(v['args-file'], 'utf8')) : {};
  } else throw new ToolError('UNKNOWN_COMMAND', '未知命令，使用 --help 查看。');
  const result = await rpc(action, args);
  process.stdout.write(
    JSON.stringify(command === 'config' && !v['config-file'] ? result.config : result, null, 2) +
      '\n',
  );
}
main().catch((e) => {
  process.stderr.write(
    JSON.stringify({
      error:
        e instanceof ToolError
          ? { code: e.code, message: e.message, details: e.details }
          : { code: 'CLI_ERROR', message: '参数、私有文件或本机配置无效，请使用 --help 检查。' },
    }) + '\n',
  );
  process.exitCode = 1;
});
