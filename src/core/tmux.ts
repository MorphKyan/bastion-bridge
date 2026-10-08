import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Binding } from '../shared.js';
import { ToolError } from '../shared.js';
import { decodeTmuxBytes } from './framing.js';

const exec = promisify(execFile);
export interface TerminalBridge extends EventEmitter {
  readonly ready: Promise<void>;
  close(): void;
}
export interface Terminal {
  create(socket: string, name: string, command: string): Promise<Binding>;
  exists(binding: Binding): Promise<boolean>;
  capture(binding: Binding): Promise<string>;
  send(binding: Binding, text: string, submit?: boolean): Promise<void>;
  key(binding: Binding, key: string): Promise<void>;
  resize(binding: Binding, cols: number, rows: number): Promise<void>;
  close(binding: Binding): Promise<void>;
  rename(binding: Binding, name: string): Promise<Binding>;
  list(socket: string): Promise<Binding[]>;
  bridge(binding: Binding): TerminalBridge;
}
export class Tmux implements Terminal {
  private async run(socket: string, args: string[]): Promise<string> {
    try {
      return (await exec('tmux', ['-L', socket, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    } catch {
      throw new ToolError('TERMINAL_ERROR', 'The tmux terminal is unavailable.');
    }
  }
  async create(socket: string, name: string, command: string): Promise<Binding> {
    const pane = (
      await this.run(socket, [
        'new-session',
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-s',
        name,
        '-x',
        '120',
        '-y',
        '35',
        command,
      ])
    ).trim();
    return { asset: name, socket, name, pane };
  }
  async exists(b: Binding) {
    try {
      await this.run(b.socket, ['display-message', '-p', '-t', b.pane, '#{pane_id}']);
      return true;
    } catch {
      return false;
    }
  }
  async capture(b: Binding) {
    return this.run(b.socket, ['capture-pane', '-p', '-t', b.pane, '-S', '-1000']);
  }
  async send(b: Binding, text: string, submit = false) {
    const buffer = `bastion-bridge-${randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tmux', ['-L', b.socket, 'load-buffer', '-b', buffer, '-'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', () =>
        reject(new ToolError('TERMINAL_ERROR', 'Cannot send terminal input.')),
      );
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new ToolError('TERMINAL_ERROR', 'Cannot send terminal input.')),
      );
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    });
    try {
      await this.run(b.socket, ['paste-buffer', '-d', '-b', buffer, '-t', b.pane]);
    } finally {
      try {
        await this.run(b.socket, ['delete-buffer', '-b', buffer]);
      } catch {}
    }
    if (submit) await this.key(b, 'Enter');
  }
  async key(b: Binding, key: string) {
    const keys: Record<string, string> = {
      'Ctrl-C': 'C-c',
      'Ctrl-D': 'C-d',
      'Ctrl-Z': 'C-z',
      'Ctrl-L': 'C-l',
      Enter: 'Enter',
      Tab: 'Tab',
      Escape: 'Escape',
      Up: 'Up',
      Down: 'Down',
      Left: 'Left',
      Right: 'Right',
      Backspace: 'BSpace',
      'C-c': 'C-c',
      'C-d': 'C-d',
    };
    if (!keys[key]) throw new ToolError('INVALID_KEY', 'Unsupported control key.');
    await this.run(b.socket, ['send-keys', '-t', b.pane, keys[key]]);
  }
  async resize(b: Binding, cols: number, rows: number) {
    await this.run(b.socket, [
      'resize-window',
      '-t',
      b.pane,
      '-x',
      String(cols),
      '-y',
      String(rows),
    ]);
  }
  async close(b: Binding) {
    await this.run(b.socket, ['kill-session', '-t', `${b.name}:`]);
  }
  async rename(b: Binding, name: string) {
    await this.run(b.socket, ['rename-session', '-t', `${b.name}:`, name]);
    return { ...b, name };
  }
  async list(socket: string): Promise<Binding[]> {
    try {
      return (await this.run(socket, ['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}']))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, pane] = line.split('\t');
          return { asset: name, socket, name, pane };
        });
    } catch {
      return [];
    }
  }
  bridge(b: Binding): TerminalBridge {
    return new ControlBridge(b);
  }
}
class ControlBridge extends EventEmitter implements TerminalBridge {
  readonly ready: Promise<void>;
  private child;
  private pending = Buffer.alloc(0);
  private decoder = new StringDecoder('utf8');
  private closing = false;
  constructor(b: Binding) {
    super();
    // Native control mode supplies original pane bytes without renderer wrapping.
    this.child = spawn('tmux', ['-L', b.socket, '-C', 'attach-session', '-t', `${b.name}:`], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let readyResolve!: () => void;
    this.ready = new Promise<void>((resolve) => (readyResolve = resolve));
    const readyPrefix = Buffer.from('%end ');
    const outputPrefix = Buffer.from(`%output ${b.pane} `);
    this.child.stdout.on('data', (data: Buffer) => {
      this.pending = Buffer.concat([this.pending, data]);
      let end: number;
      while ((end = this.pending.indexOf(10)) !== -1) {
        const line = this.pending.subarray(0, end);
        this.pending = this.pending.subarray(end + 1);
        if (line.subarray(0, readyPrefix.length).equals(readyPrefix)) readyResolve();
        if (line.subarray(0, outputPrefix.length).equals(outputPrefix))
          this.emit(
            'data',
            this.decoder.write(decodeTmuxBytes(line.subarray(outputPrefix.length))),
          );
      }
      if (this.pending.length > 16 * 1024 * 1024) {
        this.emit('lost', 'Terminal control stream exceeded its buffer.');
        this.close();
      }
    });
    this.child.on('error', () => this.emit('lost', 'Terminal bridge could not start.'));
    this.child.on('exit', () => {
      if (!this.closing) this.emit('lost', 'Terminal bridge disconnected.');
    });
  }
  close() {
    this.closing = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

export async function scanHost(
  host: string,
  port: number,
): Promise<{ keys: string; fingerprints: string[] }> {
  try {
    const { stdout } = await exec('ssh-keyscan', ['-T', '5', '-p', String(port), host], {
      maxBuffer: 64 * 1024,
    });
    const lines = stdout.split('\n').filter((l) => l && !l.startsWith('#'));
    const fingerprints: string[] = [];
    for (const line of lines) {
      const fp = await new Promise<string>((resolve, reject) => {
        const p = spawn('ssh-keygen', ['-lf', '-', '-E', 'sha256'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        let result = '';
        p.stdout.on('data', (x) => (result += x));
        p.on('error', reject);
        p.on('exit', (code) =>
          code === 0
            ? resolve(result.trim().split(/\s+/)[1])
            : reject(new Error('key scan failed')),
        );
        p.stdin.end(line + '\n');
      });
      fingerprints.push(fp);
    }
    if (!lines.length) throw new Error();
    return { keys: lines.join('\n') + '\n', fingerprints };
  } catch {
    throw new ToolError(
      'SSH_UNREACHABLE',
      'Cannot read the SSH host keys. Check connectivity and port.',
    );
  }
}
export function saveTrustedKeys(file: string, host: string, port: number, keys: string) {
  const keyHost = port === 22 ? host : `[${host}]:${port}`;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {}
  const kept = existing.split('\n').filter((l) => l && l.split(/\s+/)[0] !== keyHost);
  fs.writeFileSync(file, [...kept, keys.trim()].join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
