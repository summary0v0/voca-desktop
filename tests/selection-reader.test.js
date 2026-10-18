const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSelectionReader, MAX_SELECTION_LENGTH } = require('../src/main/selection-reader');

function fixture(options = {}) {
  const calls = [];
  const reader = createSelectionReader({
    platform: 'win32',
    execFile(file, args, config, callback) {
      const call = { file, args, config, callback, kills: 0 };
      calls.push(call);
      return { kill() { call.kills++; } };
    },
    ...options,
  });
  const answer = (index, text, error = null, stderr = '') => calls[index].callback(error, text, stderr);
  const command = index => Buffer.from(calls[index].args.at(-1), 'base64').toString('utf16le');
  return { reader, calls, answer, command };
}

test('reader launches hidden bounded PowerShell with UTF-16 encoded numeric coordinates', async () => {
  const f = fixture({ timeoutMs: 1700 });
  const result = f.reader.read({ x: -2048, y: 500 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, 'powershell.exe');
  assert.deepEqual(f.calls[0].args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.match(f.command(0), /\} -UsePoint -X -2048 -Y 500$/);
  assert.equal(f.calls[0].config.windowsHide, true);
  assert.equal(f.calls[0].config.timeout, 1700);
  assert.equal(f.calls[0].config.encoding, 'utf8');
  assert.equal(f.calls[0].config.maxBuffer, 64 * 1024);
  f.answer(0, JSON.stringify('selected text'));
  assert.equal(await result, 'selected text');
});

test('reader safely omits point arguments for non-numeric or overflowing coordinates', async t => {
  for (const [name, point] of [
    ['command text', { x: '1; Write-Host injected', y: 2 }],
    ['fractional', { x: 1.1, y: 2 }],
    ['non-finite', { x: Infinity, y: 2 }],
    ['outside Int32', { x: 2147483648, y: -2147483649 }],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      const result = f.reader.read(point);
      assert.ok(f.command(0).endsWith('}'));
      assert.doesNotMatch(f.command(0), /Write-Host injected/);
      f.answer(0, '"safe"');
      assert.equal(await result, 'safe');
    });
  }
});

test('reader preserves Unicode, quotes and line breaks from JSON stdout and tolerates a BOM', async () => {
  const f = fixture();
  const result = f.reader.read();
  const selection = '中文 café "quoted"\n第二行 🐱';
  f.answer(0, '\uFEFF' + JSON.stringify('  ' + selection + '  ') + '\r\n');
  assert.equal(await result, selection);
  assert.doesNotMatch(f.command(0), /café|第二行|quoted/);
});

test('empty, malformed, non-string, and oversized output produce no selection', async t => {
  for (const [name, output] of [
    ['empty', ''],
    ['malformed', 'unexpected warning\n"word"'],
    ['object', '{"text":"word"}'],
    ['null', 'null'],
    ['oversized', JSON.stringify('x'.repeat(MAX_SELECTION_LENGTH + 1))],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      const result = f.reader.read();
      f.answer(0, output);
      assert.equal(await result, '');
    });
  }
});

test('the maximum allowed selection is accepted without truncating its text', async () => {
  const f = fixture();
  const result = f.reader.read();
  const selection = 'x'.repeat(MAX_SELECTION_LENGTH);
  f.answer(0, JSON.stringify(selection));
  assert.equal(await result, selection);
});

test('helper errors and timeouts cannot return partial stdout as a valid selection', async t => {
  for (const code of ['ETIMEDOUT', 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    await t.test(code, async () => {
      const f = fixture();
      const result = f.reader.read();
      f.answer(0, '"partial text"', Object.assign(new Error(code), { code }));
      assert.equal(await result, '');
    });
  }
});

test('a synchronous spawn failure resolves safely instead of rejecting the reader promise', async () => {
  const f = fixture({ execFile() { throw new Error('cannot spawn helper'); } });
  assert.equal(await f.reader.read(), '');
});

test('cancel settles the pending read and terminates the helper; late output is ignored', async () => {
  const f = fixture();
  const result = f.reader.read();
  f.reader.cancel();
  assert.equal(await result, '');
  assert.equal(f.calls[0].kills, 1);
  f.answer(0, '"stale text"');
  f.reader.cancel();
  assert.equal(f.calls[0].kills, 1);
});

test('a newer read supersedes the older helper and receives only its own response', async () => {
  const f = fixture();
  const older = f.reader.read({ x: 10, y: 10 });
  const newer = f.reader.read({ x: 20, y: 20 });
  assert.equal(await older, '');
  assert.equal(f.calls[0].kills, 1);
  f.answer(0, '"obsolete selection"');
  f.answer(1, '"current selection"');
  assert.equal(await newer, 'current selection');
});

test('stop cancels current work and makes all future reads inert', async () => {
  const f = fixture();
  const pending = f.reader.read();
  f.reader.stop();
  assert.equal(await pending, '');
  assert.equal(f.calls[0].kills, 1);
  assert.equal(await f.reader.read(), '');
  assert.equal(f.calls.length, 1);
  f.answer(0, '"text after stop"');
});

test('non-Windows platforms and missing packaged script files do not launch a helper', async () => {
  for (const options of [{ platform: 'linux' }, { scriptPath: path.join(__dirname, 'does-not-exist.ps1') }]) {
    const f = fixture(options);
    assert.equal(await f.reader.read(), '');
    assert.equal(f.calls.length, 0);
  }
});

