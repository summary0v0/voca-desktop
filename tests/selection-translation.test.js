const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSelectionTranslationController } = require('../src/main/selection-translation');

const keys = { Ctrl: 1, CtrlRight: 2, C: 3 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function fixture(options = {}) {
  const hook = new EventEmitter();
  const calls = { starts: 0, stops: 0, reads: 0, clipboardReads: 0, icons: [], overlays: [], hides: 0, cancellations: 0 };
  hook.start = () => { calls.starts++; };
  hook.stop = () => { calls.stops++; };
  let clock = 1000, nextTimerId = 1, ownWindowFocused = false;
  const timers = new Map();
  const controller = createSelectionTranslationController({
    hook,
    keys,
    readSelection: () => { calls.reads++; return options.readSelection ? options.readSelection() : Promise.resolve('selected word'); },
    cancelReadSelection: () => { calls.cancellations++; },
    readClipboard: () => { calls.clipboardReads++; return options.clipboard ?? 'copied word'; },
    showIcon: text => calls.icons.push(text),
    hideIcon: () => { calls.hides++; },
    showOverlay: text => calls.overlays.push(text),
    isOwnWindowFocused: () => ownWindowFocused,
    schedule: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, { callback, time: clock + delay });
      return id;
    },
    cancelSchedule: id => timers.delete(id),
    now: () => clock,
    enabled: options.enabled ?? true,
  });

  function advance(milliseconds) {
    const until = clock + milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.time <= until)
        .sort((a, b) => a[1].time - b[1].time)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      clock = timer.time;
      timer.callback();
    }
    clock = until;
  }
  const keydown = keycode => hook.emit('keydown', { keycode });
  const keyup = keycode => hook.emit('keyup', { keycode });
  const drag = () => {
    hook.emit('mousedown', { button: 1, x: 100, y: 100 });
    hook.emit('mouseup', { button: 1, x: 150, y: 100 });
  };
  controller.start();
  return { hook, calls, controller, advance, keydown, keyup, drag, setOwnWindowFocused: value => { ownWindowFocused = value; } };
}

test('drag reads the current selection without reading or copying the clipboard', async () => {
  const f = fixture({ readSelection: async () => '  selection text  ' });
  f.drag();
  f.advance(1000);
  await flushPromises();
  assert.equal(f.calls.reads, 1);
  assert.deepEqual(f.calls.icons, ['selection text']);
  assert.equal(f.calls.clipboardReads, 0);
  assert.deepEqual(f.calls.overlays, []);
});

test('ordinary clicks, unpaired mouseup, and selections inside Voca are ignored', async () => {
  const f = fixture();
  f.hook.emit('mouseup', { button: 1, x: 150, y: 100 });
  f.hook.emit('mousedown', { button: 1, x: 100, y: 100 });
  f.hook.emit('mouseup', { button: 1, x: 105, y: 102 });
  f.setOwnWindowFocused(true);
  f.drag();
  f.advance(1000);
  await flushPromises();
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.clipboardReads, 0);
  assert.deepEqual(f.calls.icons, []);
});

test('disabled selection translation ignores mouse selections and single Ctrl+C', async () => {
  const f = fixture({ enabled: false });
  f.drag();
  f.keydown(keys.Ctrl);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(1000);
  await flushPromises();
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.clipboardReads, 0);
  assert.deepEqual(f.calls.icons, []);
  assert.deepEqual(f.calls.overlays, []);
});

test('disabling immediately hides the icon and rejects an in-flight selection result', async () => {
  const request = deferred();
  const f = fixture({ readSelection: () => request.promise });
  f.drag();
  f.advance(1000);
  assert.equal(f.calls.reads, 1);
  const beforeHides = f.calls.hides;
  f.controller.setEnabled(false);
  assert.ok(f.calls.hides > beforeHides);
  request.resolve('obsolete selection');
  await flushPromises();
  assert.deepEqual(f.calls.icons, []);
  f.controller.setEnabled(true);
  f.drag();
  f.advance(1000);
  await flushPromises();
  assert.deepEqual(f.calls.icons, ['obsolete selection']);
  assert.equal(f.calls.clipboardReads, 0);
});

test('the newest drag wins when asynchronous selection reads finish out of order', async () => {
  const older = deferred(), newer = deferred();
  const requests = [older, newer];
  const f = fixture({ readSelection: () => requests.shift().promise });
  f.drag();
  f.advance(1000);
  f.drag();
  f.advance(1000);
  newer.resolve('new selection');
  await flushPromises();
  older.resolve('old selection');
  await flushPromises();
  assert.deepEqual(f.calls.icons, ['new selection']);
});

test('navigation, app switching, and Ctrl presses invalidate an in-flight selection', async t => {
  for (const [name, keycode] of [['Alt for Alt+Tab', 4], ['Tab', 5], ['arrow navigation', 6], ['Ctrl', keys.Ctrl]]) {
    await t.test(name, async () => {
      const request = deferred();
      const f = fixture({ readSelection: () => request.promise });
      f.drag();
      f.advance(1000);
      assert.equal(f.calls.reads, 1);
      const beforeCancellations = f.calls.cancellations;
      f.keydown(keycode);
      request.resolve('selection from the previous focus');
      await flushPromises();
      assert.ok(f.calls.cancellations > beforeCancellations);
      assert.deepEqual(f.calls.icons, []);
      assert.equal(f.calls.clipboardReads, 0);
    });
  }
});

test('a new mouse gesture hides an old icon before its selection read finishes', async () => {
  const next = deferred();
  let count = 0;
  const f = fixture({ readSelection: () => ++count === 1 ? Promise.resolve('first') : next.promise });
  f.drag();
  f.advance(1000);
  await flushPromises();
  assert.deepEqual(f.calls.icons, ['first']);
  const beforeHides = f.calls.hides;
  f.hook.emit('mousedown', { button: 1, x: 200, y: 100 });
  assert.ok(f.calls.hides > beforeHides);
  f.hook.emit('mouseup', { button: 1, x: 250, y: 100 });
  f.advance(1000);
  next.resolve('second');
  await flushPromises();
  assert.deepEqual(f.calls.icons, ['first', 'second']);
});

test('empty, unsupported, oversized, and failed selection reads never reuse clipboard text', async t => {
  for (const [name, readSelection] of [
    ['empty', async () => '  '],
    ['unsupported', async () => null],
    ['oversized', async () => 'x'.repeat(5001)],
    ['failed', async () => { throw new Error('UI Automation unavailable'); }],
  ]) {
    await t.test(name, async () => {
      const f = fixture({ readSelection });
      f.drag();
      f.advance(1000);
      await flushPromises();
      assert.deepEqual(f.calls.icons, []);
      assert.equal(f.calls.clipboardReads, 0);
      assert.ok(f.calls.hides > 0);
    });
  }
});

test('manual double Ctrl+C translates while automatic selection is disabled', () => {
  const f = fixture({ enabled: false, clipboard: '  deliberate copy  ' });
  f.keydown(keys.CtrlRight);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(50);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(100);
  assert.deepEqual(f.calls.overlays, ['deliberate copy']);
  assert.deepEqual(f.calls.icons, []);
  assert.equal(f.calls.reads, 0);
});

test('holding C does not count key auto-repeat as the second copy', () => {
  const f = fixture();
  f.keydown(keys.Ctrl);
  f.keydown(keys.C);
  f.advance(50);
  f.keydown(keys.C);
  f.advance(50);
  f.keydown(keys.C);
  f.advance(100);
  assert.deepEqual(f.calls.overlays, []);
  assert.deepEqual(f.calls.icons, ['copied word']);
});

test('double Ctrl+C cancels its delayed single-copy icon', () => {
  const f = fixture();
  f.keydown(keys.Ctrl);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(50);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(1000);
  assert.deepEqual(f.calls.icons, []);
  assert.deepEqual(f.calls.overlays, ['copied word']);
});

test('disabling cancels a pending single-copy icon but preserves deliberate double-copy translation', () => {
  const f = fixture();
  f.keydown(keys.Ctrl);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.controller.setEnabled(false);
  f.advance(100);
  assert.deepEqual(f.calls.icons, []);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.controller.setEnabled(false);
  f.advance(100);
  assert.deepEqual(f.calls.overlays, ['copied word']);
});

test('releasing one Ctrl key preserves the other held Ctrl key', () => {
  const f = fixture({ enabled: false });
  f.keydown(keys.Ctrl);
  f.keydown(keys.CtrlRight);
  f.keyup(keys.Ctrl);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(50);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.advance(100);
  assert.deepEqual(f.calls.overlays, ['copied word']);
});

test('stopping removes listeners, cancels pending callbacks, and invalidates in-flight selection', async () => {
  const request = deferred();
  const f = fixture({ readSelection: () => request.promise });
  f.drag();
  f.advance(1000);
  f.keydown(keys.Ctrl);
  f.keydown(keys.C);
  f.keyup(keys.C);
  f.controller.stop();
  request.resolve('result after stop');
  f.advance(1000);
  await flushPromises();
  assert.deepEqual(f.calls.icons, []);
  assert.deepEqual(f.calls.overlays, []);
  for (const event of ['mousedown', 'mouseup', 'keydown', 'keyup']) assert.equal(f.hook.listenerCount(event), 0);
  assert.equal(f.calls.stops, 1);
});
