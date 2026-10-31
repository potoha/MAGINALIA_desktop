/**
 * Electron compatibility evidence for the Windows named-mutex Shelf lock.
 *
 * Spawns a real Electron main process (`test/electron-native-lock-main.cjs`, no
 * `ELECTRON_RUN_AS_NODE`) that loads the addon, takes the Shelf lock, blocks a second
 * Node process, releases and re-acquires. This is the "does it load and work under
 * Electron's ABI" acceptance item; the packaged-app variant is proven by
 * `scripts/spike-packaging.mjs`.
 *
 * Requires the built addon and `npm run build:main`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const mainScript = fileURLToPath(new URL("./electron-native-lock-main.cjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./collector-shelf-native-worker.mjs", import.meta.url));
const addonBinary = fileURLToPath(
  new URL("../native/shelf-mutex/build/Release/shelf_mutex.node", import.meta.url)
);

/**
 * Environment for the Electron child. `ELECTRON_RUN_AS_NODE` must be *absent* for the
 * child to start as a real Electron runtime; an empty value can still be read as set.
 */
function electronEnvironment(extra) {
  const environment = { ...process.env, ...extra };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

test("Electron loads the mutex addon and excludes a separate process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-electron-native-"));
  const resultFile = path.join(directory, "result.json");
  try {
    const child = spawn(electronBinary, [mainScript], {
      stdio: ["ignore", "pipe", "pipe"],
      env: electronEnvironment({
        MAGINALIA_SHELF_MUTEX_PATH: addonBinary,
        MAGINALIA_NATIVE_WORKER: workerScript,
        MAGINALIA_NATIVE_NODE: process.execPath,
        MAGINALIA_NATIVE_SHELF_ID: randomUUID(),
        MAGINALIA_NATIVE_RESULT: resultFile
      })
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const text = await readFile(resultFile, "utf8").catch(() => "");
    assert.notEqual(text, "", `Electron produced no result; exit ${code}; stderr ${Buffer.concat(stderr).toString("utf8")}`);
    const result = JSON.parse(text);
    assert.equal(result.ok, true, text);
    assert.match(result.electron, /^4[0-9]\./u, "a real Electron runtime must report its version");
    assert.equal(result.apiVersion, 1);
    assert.equal(result.firstAcquire.acquired, true);
    assert.equal(result.firstAcquire.abandoned, false);
    // A second process cannot take the lock while Electron holds it.
    assert.equal(result.contenderExit, 3, JSON.stringify(result.contender));
    assert.equal(result.contender.code, "shelf-write-busy");
    assert.equal(result.released.released, true);
    assert.equal(result.secondAcquire.acquired, true);
    assert.equal(code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
