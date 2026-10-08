import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { ExecutionMode } from '../shared.js';

export function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
export function cleanOutput(s: string): string {
  return stripVTControlCharacters(s)
    .replaceAll('\r\n', '\n')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
export class OutputCleaner {
  private state: 'text' | 'esc' | 'csi' | 'string' | 'stringEsc' | 'charset' = 'text';
  push(text: string) {
    let output = '';
    for (const char of text) {
      if (this.state === 'text') {
        if (char === '\x1b') this.state = 'esc';
        else if (char === '\n' || char === '\t' || (char.charCodeAt(0) >= 32 && char !== '\x7f'))
          output += char;
      } else if (this.state === 'esc') {
        this.state =
          char === '['
            ? 'csi'
            : [']', 'P', '^', '_'].includes(char)
              ? 'string'
              : ['(', ')', '*', '+', '-', '.', '/'].includes(char)
                ? 'charset'
                : 'text';
      } else if (this.state === 'csi') {
        if (char >= '@' && char <= '~') this.state = 'text';
      } else if (this.state === 'string') {
        if (char === '\x07') this.state = 'text';
        else if (char === '\x1b') this.state = 'stringEsc';
      } else if (this.state === 'stringEsc') this.state = char === '\\' ? 'text' : 'string';
      else this.state = 'text';
    }
    return output;
  }
}
export function makeCommand(command: string, cwd?: string, mode: ExecutionMode = 'session') {
  const nonce = randomBytes(16).toString('hex');
  const begin = `__BASTION_BRIDGE_BEGIN_${nonce}__`;
  const end = `__BASTION_BRIDGE_END_${nonce}__`;
  const execution =
    mode === 'session'
      ? `${cwd ? `builtin cd -- ${shellQuote(cwd)} && ` : ''}builtin eval -- ${shellQuote(command)}`
      : `command bash -c ${shellQuote(cwd ? `cd -- ${shellQuote(cwd)} || exit $?\n${command}` : command)}`;
  // Split the sentinel in the source so terminal echo cannot match the real sentinel.
  const line = `builtin printf '\\n%s%s\\n' '__BASTION_BRIDGE_BEGIN_' '${nonce}__'; ${execution}; builtin printf '\\n%s%s:%s\\n' '__BASTION_BRIDGE_END_' '${nonce}__' "$?"`;
  return { begin, end, line };
}
export class CommandFrame {
  private pending = '';
  private readonly beginPattern: RegExp;
  private readonly endPattern: RegExp;
  started = false;
  ended = false;
  constructor(
    readonly begin: string,
    readonly end: string,
    private output: (s: string) => void,
    private complete: (code: number) => void,
  ) {
    this.beginPattern = new RegExp(`(?:^|\\r?\\n)${begin}\\r?\\n`);
    this.endPattern = new RegExp(`\\r?\\n${end}:(\\d{1,3})\\r?\\n`);
  }
  push(data: string) {
    if (this.ended) return;
    this.pending += data;
    if (!this.started) {
      const match = this.beginPattern.exec(this.pending);
      if (!match) {
        this.pending = this.pending.slice(-(this.begin.length + 6));
        return;
      }
      this.pending = this.pending.slice(match.index + match[0].length);
      this.started = true;
    }
    const finish = this.endPattern.exec(this.pending);
    if (finish) {
      this.output(this.pending.slice(0, finish.index));
      this.pending = '';
      this.ended = true;
      this.complete(Number(finish[1]));
      return;
    }
    const keep = this.end.length + 16;
    if (this.pending.length > keep) {
      this.output(this.pending.slice(0, -keep));
      this.pending = this.pending.slice(-keep);
    }
  }
  flush() {
    if (this.started && !this.ended) this.output(this.pending);
    this.pending = '';
  }
}

export function decodeTmuxBytes(data: Buffer): Buffer {
  const bytes = Buffer.allocUnsafe(data.length);
  let length = 0;
  for (let i = 0; i < data.length; i++) {
    if (
      data[i] === 92 &&
      i + 3 < data.length &&
      data[i + 1] >= 48 &&
      data[i + 1] <= 55 &&
      data[i + 2] >= 48 &&
      data[i + 2] <= 55 &&
      data[i + 3] >= 48 &&
      data[i + 3] <= 55
    ) {
      bytes[length++] = ((data[i + 1] - 48) << 6) | ((data[i + 2] - 48) << 3) | (data[i + 3] - 48);
      i += 3;
    } else bytes[length++] = data[i];
  }
  return bytes.subarray(0, length);
}
