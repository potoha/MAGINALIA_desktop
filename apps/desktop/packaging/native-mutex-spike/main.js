/**
 * Packaging-spike entry point.
 *
 * Deliberately tiny: the point is to load the mutex addon from the *packaged* layout
 * (`<resources>/shelf-mutex/shelf_mutex.node`, i.e. outside `app.asar`) inside a real
 * Electron main process, not to be a usable application.
 *
 * Result is written to `MAGINALIA_SPIKE_RESULT` because a GUI-subsystem executable's
 * stdout is not guaranteed to reach the parent's pipe.
 */
const { app } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");

const resultPath = process.env.MAGINALIA_SPIKE_RESULT;
const outcome = {
  electron: process.versions.electron,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath()
};

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  const text = `${JSON.stringify(outcome)}\n`;
  try {
    writeFileSync(resultPath, text, "utf8");
  } catch (error) {
    process.stderr.write(`cannot write result: ${String(error)}\n`);
  }
  process.stdout.write(text);
  app.exit(code);
}

setTimeout(() => finish(9), 20_000);

try {
  const addonPath = path.join(process.resourcesPath, "shelf-mutex", "shelf_mutex.node");
  outcome.addonPath = addonPath;
  const addon = require(addonPath);
  outcome.apiVersion = addon.apiVersion;
  // Unique name per run so a leftover process from a previous run cannot poison this.
  const name = `Local\\MAGINALIA.Spike.Packaged.${process.pid}`;
  const handle = addon.createMutex(name);
  outcome.acquire = addon.acquire(handle, 1_000);
  outcome.release = addon.release(handle);
  addon.close(handle);
  outcome.ok =
    outcome.apiVersion === 1 && outcome.acquire.acquired === true && outcome.release.released === true;
  finish(outcome.ok ? 0 : 1);
} catch (error) {
  outcome.ok = false;
  outcome.error = String(error && error.message ? error.message : error);
  finish(1);
}
