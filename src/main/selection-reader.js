const { execFile: defaultExecFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_SELECTION_LENGTH = 5000;

// Reading the script through Node also works when Electron packages it in app.asar.
// PowerShell itself cannot open a -File path inside an asar archive.
function createSelectionReader({
  execFile = defaultExecFile,
  platform = process.platform,
  scriptPath = path.join(__dirname, 'read-selection.ps1'),
  timeoutMs = 2500,
} = {}) {
  let stopped = false;
  let active = null;
  let script;

  function cancel() {
    const request = active;
    if (!request) return;
    active = null;
    request.resolve('');
    try { request.child?.kill(); } catch {}
  }

  function read({ x, y } = {}) {
    cancel();
    if (stopped || platform !== 'win32') return Promise.resolve('');

    try {
      if (script === undefined) script = fs.readFileSync(scriptPath, 'utf8');
    } catch {
      return Promise.resolve('');
    }

    // Only numeric arguments enter the command. Selected text is returned on
    // stdout; it is never part of a command, clipboard operation, or key event.
    const hasPoint = Number.isInteger(x) && Number.isInteger(y)
      && x >= -2147483648 && x <= 2147483647
      && y >= -2147483648 && y <= 2147483647;
    const args = hasPoint ? ` -UsePoint -X ${x} -Y ${y}` : '';
    const command = `& {\n${script}\n}${args}`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');

    return new Promise((resolve) => {
      const request = { child: null, resolve };
      active = request;
      try {
        request.child = execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', encoded,
        ], {
          windowsHide: true,
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
        }, (error, stdout) => {
          if (active !== request) return;
          active = null;
          if (error) { resolve(''); return; }
          try {
            const text = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
            resolve(typeof text === 'string' && text.length <= MAX_SELECTION_LENGTH ? text.trim() : '');
          } catch {
            resolve('');
          }
        });
      } catch {
        if (active === request) active = null;
        resolve('');
      }
    });
  }

  function stop() {
    stopped = true;
    cancel();
  }

  return { read, cancel, stop };
}

module.exports = { createSelectionReader, MAX_SELECTION_LENGTH };
