import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandFrame,
  makeCommand,
  decodeTmuxBytes,
  cleanOutput,
  shellQuote,
  OutputCleaner,
} from '../src/core/framing.js';
import { Redactor } from '../src/core/redactor.js';

for (const mode of ['session', 'subshell'] as const) {
  test(`frames exclude history and echoed source in ${mode} mode, including every split position`, () => {
    const f = makeCommand("printf 'hello\\n'", '/tmp/a b', mode);
    assert.ok(!f.line.includes(f.begin));
    assert.ok(!f.line.includes(f.end));
    const input = `old output\r\n$ ${f.line}\r\n\r\n${f.begin}\r\nhello\r\n\r\n${f.end}:7\r\n$ `;
    for (let split = 0; split < input.length; split++) {
      let output = '';
      let exit: number | undefined;
      const frame = new CommandFrame(
        f.begin,
        f.end,
        (s) => (output += s),
        (c) => (exit = c),
      );
      frame.push(input.slice(0, split));
      frame.push(input.slice(split));
      assert.equal(output, 'hello\r\n');
      assert.equal(exit, 7);
    }
  });
}
test('control mode octal decoding preserves Unicode and control bytes', () => {
  assert.equal(
    decodeTmuxBytes(Buffer.from('中文\\015\\012\\033[31m\\134')).toString(),
    '中文\r\n\x1b[31m\\',
  );
  assert.equal(cleanOutput('\x1b[31m中文\x1b[0m\r\n'), '中文\n');
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
test('streaming redaction catches secrets across arbitrary chunks', () => {
  for (let split = 0; split <= 24; split++) {
    const redact = new Redactor(() => ['private-test-secret']);
    const text = 'a private-test-secret b';
    assert.equal(
      redact.push(text.slice(0, split)) + redact.push(text.slice(split)) + redact.flush(),
      'a [REDACTED] b',
    );
  }
});
test('output cleaning retains ANSI state across chunks', () => {
  const input = 'a\x1b[31m红色\x1b[0m\x1b]0;hidden title\x07b\r\n';
  for (let split = 0; split < input.length; split++) {
    const cleaner = new OutputCleaner();
    assert.equal(
      cleaner.push(input.slice(0, split)) + cleaner.push(input.slice(split)),
      'a红色b\n',
    );
  }
});
