/**
 * Packaging-spike entry point.
 *
 * Deliberately tiny: the point is to prove that the *packaged* layout loads the mutex
 * addon through the real wrapper (`shelf-native-mutex.ts`) and not through a path the
 * launcher controls.
 *
 * Two things are checked inside a real Electron main process:
 *
 * 1. the wrapper resolves to exactly one candidate, `<resources>/shelf-mutex/shelf_mutex.node`,
 *    while `MAGINALIA_SHELF_MUTEX_PATH` points at a bogus file and the working directory
 *    is somewhere else entirely — i.e. packaged mode ignores environment and cwd;
 * 2. the addon itself loads and works from that trusted location.
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
  appPath: app.getAppPath(),
  defaultApp: process.defaultApp === true,
  envOverride: process.env.MAGINALIA_SHELF_MUTEX_PATH ?? null
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
  const wrapperPath = path.join(process.resourcesPath, "shelf-mutex", "shelf-native-mutex.js");
  outcome.wrapperPath = wrapperPath;
  const wrapper = require(wrapperPath);

  const policy = wrapper.resolveNativeAddonCandidates({
    resourcesPath: process.resourcesPath,
    defaultApp: process.defaultApp,
    envOverride: process.env.MAGINALIA_SHELF_MUTEX_PATH,
    cwd: process.cwd(),
    moduleDirectory: __dirname
  });
  outcome.policy = { mode: policy.mode, candidates: policy.candidates };

  // Packaged policy is the security boundary: one trusted candidate, no env, no cwd.
  const expected = path.join(process.resourcesPath, "shelf-mutex", "shelf_mutex.node");
  const policyOk =
    policy.mode === "packaged" &&
    policy.candidates.length === 1 &&
    path.resolve(policy.candidates[0]) === path.resolve(expected) &&
    (outcome.envOverride === null || policy.candidates.every((entry) => entry !== outcome.envOverride));

  const addon = wrapper.loadNativeShelfMutex();
  outcome.apiVersion = addon.apiVersion;
  // Unique name per run so a leftover process from a previous run cannot poison this.
  const name = `Local\\MAGINALIA.Spike.Packaged.${process.pid}`;
  const handle = addon.createMutex(name);
  outcome.acquire = addon.acquire(handle, 1_000);
  outcome.release = addon.release(handle);
  addon.close(handle);
  outcome.ok =
    policyOk &&
    outcome.apiVersion === 1 &&
    outcome.acquire.acquired === true &&
    outcome.release.released === true;
  finish(outcome.ok ? 0 : 1);
} catch (error) {
  outcome.ok = false;
  outcome.error = String(error && error.message ? error.message : error);
  finish(1);
}
