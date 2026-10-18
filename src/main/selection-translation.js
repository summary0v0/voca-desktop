// Keep automatic selection reads separate from deliberate clipboard shortcuts.
function createSelectionTranslationController({
  hook, keys, readSelection, readClipboard, showIcon, hideIcon, showOverlay,
  isOwnWindowFocused = () => false, cancelReadSelection = () => {},
  schedule = setTimeout, cancelSchedule = clearTimeout, now = Date.now,
  enabled = true,
}) {
  let active = false;
  let generation = 0;
  let mouseStart = null;
  let automaticTimer = null;
  let manualTimer = null;
  let lastCopyTime = null;
  let cDown = false;
  const ctrlKeys = new Set();

  function validText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length <= 5000 ? text : '';
  }

  function invalidateSelection() {
    generation += 1;
    mouseStart = null;
    cancelReadSelection();
    if (automaticTimer !== null) cancelSchedule(automaticTimer);
    automaticTimer = null;
  }

  function onMouseDown(event) {
    if (!active || event.button !== 1) return;
    invalidateSelection();
    // A click on the floating icon must reach its renderer before it is hidden.
    if (!enabled || isOwnWindowFocused(event)) return;
    hideIcon();
    mouseStart = { x: event.x, y: event.y };
  }

  async function onMouseUp(event) {
    if (!active || !enabled || event.button !== 1 || !mouseStart) return;
    const start = mouseStart;
    mouseStart = null;
    if (Math.hypot(event.x - start.x, event.y - start.y) < 15 || isOwnWindowFocused(event)) return;
    const request = generation;
    try {
      const text = validText(await readSelection({ x: event.x, y: event.y }));
      if (active && enabled && generation === request && !isOwnWindowFocused(event)) {
        if (text) showIcon(text);
        else hideIcon();
      }
    } catch {
      if (active && generation === request) hideIcon();
    }
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.keycode === keys.Ctrl || event.keycode === keys.CtrlRight) {
      invalidateSelection();
      ctrlKeys.add(event.keycode);
      return;
    }
    if (event.keycode !== keys.C || !ctrlKeys.size) {
      invalidateSelection();
      hideIcon();
      lastCopyTime = null;
      return;
    }
    if (cDown) return;
    cDown = true;
    // User copy takes precedence over an in-flight automatic selection read.
    invalidateSelection();
    const time = now();
    if (lastCopyTime !== null && time - lastCopyTime > 0 && time - lastCopyTime < 600) {
      lastCopyTime = null;
      hideIcon();
      if (manualTimer !== null) cancelSchedule(manualTimer);
      manualTimer = schedule(() => {
        manualTimer = null;
        if (!active) return;
        const text = validText(readClipboard());
        if (text) showOverlay(text);
      }, 100);
    } else {
      lastCopyTime = time;
      if (!enabled) return;
      const request = generation;
      automaticTimer = schedule(() => {
        automaticTimer = null;
        if (!active || !enabled || generation !== request) return;
        const text = validText(readClipboard());
        if (text) showIcon(text);
      }, 100);
    }
  }

  function onKeyUp(event) {
    ctrlKeys.delete(event.keycode);
    if (event.keycode === keys.C) cDown = false;
  }

  const listeners = { mousedown: onMouseDown, mouseup: onMouseUp, keydown: onKeyDown, keyup: onKeyUp };
  return {
    start() {
      if (active) return;
      active = true;
      for (const [event, listener] of Object.entries(listeners)) hook.on(event, listener);
      try { hook.start(); } catch (error) { this.stop(); throw error; }
    },
    setEnabled(value) {
      enabled = value !== false;
      invalidateSelection();
      if (!enabled) hideIcon();
    },
    stop() {
      if (!active) return;
      active = false;
      invalidateSelection();
      if (manualTimer !== null) cancelSchedule(manualTimer);
      manualTimer = null;
      lastCopyTime = null;
      cDown = false;
      ctrlKeys.clear();
      for (const [event, listener] of Object.entries(listeners)) hook.removeListener(event, listener);
      hook.stop();
      hideIcon();
    },
  };
}

module.exports = { createSelectionTranslationController };
