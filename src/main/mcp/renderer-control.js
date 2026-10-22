'use strict';
/**
 * Main -> renderer command channel. Capture lives in the renderer, so MCP recording tools
 * must ask the renderer to run the same actions the buttons run. Commands are a fixed
 * allowlist (see app.js handleMcpCommand); arbitrary JS is never evaluated.
 */
const crypto = require('crypto');

function createRendererControl({ ipcMain, getWindow, timeoutMs = 60000, logger = console }) {
  const pending = new Map();
  let ready = false;
  let readyResolve = null;
  let readyPromise = new Promise((resolve) => { readyResolve = resolve; });

  function resetReady() {
    ready = false;
    readyResolve = null;
    readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  }

  function markReady() {
    ready = true;
    if (readyResolve) {
      readyResolve();
      readyResolve = null;
    }
  }

  function waitReady(ms = 10000) {
    if (ready) return Promise.resolve();
    return Promise.race([
      readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('susurroLive UI is still starting; retry in a moment')), ms)),
    ]);
  }

  function rejectAll(reason) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function reset(reason = 'renderer restarted') {
    resetReady();
    rejectAll(reason);
  }

  function call(op, args = {}, ms = timeoutMs) {
    return (async () => {
      await waitReady(Math.min(ms, 15000));
      const win = getWindow();
      if (!win || win.isDestroyed()) throw new Error('susurroLive window is not available');
      const id = crypto.randomUUID();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`renderer command "${op}" timed out`));
        }, ms);
        pending.set(id, { resolve, reject, timer, op });
        win.webContents.send('evt:mcpCommand', { id, op, args });
      });
    })();
  }

  ipcMain.on('mcp:response', (event, msg) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (!msg || typeof msg.id !== 'string') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg.result);
  });

  return {
    call,
    markReady,
    waitReady,
    reset,
    isReady: () => ready,
    pendingCount: () => pending.size,
    _logger: logger,
  };
}

module.exports = { createRendererControl };
