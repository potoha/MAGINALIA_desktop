/**
 * Real-Electron compatibility probe for the Windows named-mutex addon.
 *
 * This is an Electron main process (not `ELECTRON_RUN_AS_NODE`), so it proves the
 * N-API binary loads and works inside Electron's own Node/V8 with Electron's ABI.
 *
 * Sequence:
 *   1. load the addon and acquire the Shelf mutex on the Electron main thread;
 *   2. spawn a second process (plain Node, so it is not another Electron runtime)
 *      that tries the same lock, which must be refused while Electron owns it;
 *   3. release, re-acquire to prove the mutex is still usable, release, close.
 *
 * The result is written to `MAGINALIA_NATIVE_RESULT` (and printed) because a GUI
 * subsystem executable's stdout is not guaranteed to reach the parent's pipe.
 * Test-only; never packaged as an application entry point.
 */
const { app } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const addonPath = process.env.MAGINALIA_SHELF_MUTEX_PATH;
const workerPath = process.env.MAGINALIA_NATIVE_WORKER;
const nodeBinary = process.env.MAGINALIA_NATIVE_NODE;
const shelfId = process.env.MAGINALIA_NATIVE_SHELF_ID;
const resultPath = process.env.MAGINALIA_NATIVE_RESULT;

const result = {
  electron: process.versions.electron,
  node: process.versions.node,
  modules: process.versions.modules,
  pid: process.pid
};

let finished = false;

function finish(code, extra) {
  if (finished) return;
  finished = true;
  Object.assign(result, extra);
  const text = `${JSON.stringify(result)}\n`;
  writeFileSync(resultPath, text, "utf8");
  process.stdout.write(text);
  app.exit(code);
}

setTimeout(() => finish(9, { error: "timed-out" }), 25_000);

/** Run the spike worker and collect its JSON lines. */
function runWorker(command) {
  return new Promise((resolve, reject) => {
    const commandFile = path.join(os.tmpdir(), `maginalia-electron-cmd-${randomUUID()}.json`);
    writeFileSync(commandFile, JSON.stringify(command), "utf8");
    // A plain Node child: the loader policy treats a packaged Electron runtime as
    // "packaged" and only trusts `<resources>/shelf-mutex/...`, which is not where the
    // development addon lives. The contender only has to be a second OS process.
    const environment = { ...process.env, MAGINALIA_SHELF_MUTEX_PATH: addonPath };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(nodeBinary ?? process.execPath, [workerPath, commandFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment
    });
    const lines = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const text = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (text.length > 0) lines.push(JSON.parse(text));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, lines }));
  });
}

async function main() {
  const addon = require(addonPath);
  result.apiVersion = addon.apiVersion;
  const name = `Local\\MAGINALIA.ShelfWrite.${shelfId}`;
  const handle = addon.createMutex(name);

  const first = addon.acquire(handle, 2_000);
  result.firstAcquire = first;

  const contender = await runWorker({
    mode: "tryAcquire",
    expectedShelfId: shelfId,
    acquireTimeoutMs: 500
  });
  result.contender = contender.lines.at(-1);
  result.contenderExit = contender.code;

  const released = addon.release(handle);
  result.released = released;
  // Re-acquire from the same process: the handle is reusable after release.
  const second = addon.acquire(handle, 2_000);
  result.secondAcquire = second;
  addon.release(handle);
  addon.close(handle);

  const ok =
    first.acquired === true &&
    contender.lines.at(-1) !== undefined &&
    contender.lines.at(-1).ok === false &&
    contender.lines.at(-1).code === "shelf-write-busy" &&
    released.released === true &&
    second.acquired === true;
  finish(ok ? 0 : 8, { ok });
}

main().catch((error) => finish(8, { ok: false, error: String(error && error.message ? error.message : error) }));
