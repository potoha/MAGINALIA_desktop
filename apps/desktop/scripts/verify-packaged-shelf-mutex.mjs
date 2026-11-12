/**
 * Verify, from a built Windows package (not dev mode), that the installed
 * Desktop loads its native Shelf mutex from `<resources>/shelf-mutex/`.
 *
 * Usage: node scripts/verify-packaged-shelf-mutex.mjs <win-unpacked directory> [result.json]
 *
 * 1. The packaged file exists as a regular file and matches the shipped and
 *    staged PROVENANCE.json SHA-256.
 * 2. The packaged executable, run as Node (ELECTRON_RUN_AS_NODE=1) from an
 *    unrelated working directory with no MAGINALIA_SHELF_MUTEX_PATH, loads the
 *    *product* loader from `app.asar/dist/main/shelf-native-mutex.js`. That
 *    loader must select packaged mode with exactly the one resources candidate,
 *    load the addon, and acquire and release a throwaway session mutex.
 *
 * A `win-unpacked` directory is the tree NSIS wraps. Passing this check is not
 * an NSIS installation PASS.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROBE = String.raw`
const path = require("node:path");
const { randomUUID } = require("node:crypto");
(async () => {
  const resources = process.resourcesPath;
  const appPackage = require(path.join(resources, "app.asar", "package.json"));
  const mutex = require(path.join(resources, "app.asar", "dist", "main", "shelf-native-mutex.js"));
  const resolution = mutex.resolveNativeAddonCandidates({ resourcesPath: resources, defaultApp: process.defaultApp, envOverride: process.env.MAGINALIA_SHELF_MUTEX_PATH, cwd: process.cwd(), moduleDirectory: undefined });
  const native = mutex.loadNativeShelfMutex();
  const lease = await mutex.acquireShelfMutex({ shelfId: randomUUID(), acquireTimeoutMs: 2000 });
  const held = lease.state().owned;
  lease.release();
  mutex.closeShelfMutexHandles();
  process.stdout.write(JSON.stringify({
    electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi,
    resourcesPathSet: typeof resources === "string", defaultApp: process.defaultApp ?? null,
    mode: resolution.mode, candidates: resolution.candidates.map((candidate) => path.relative(resources, candidate)),
    addonApiVersion: native.apiVersion, acquiredAndHeld: held, released: !lease.state().owned,
    appPackage: { name: appPackage.name, productName: appPackage.productName ?? null, version: appPackage.version }
  }));
})().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
`;

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [unpackedArgument, resultPath] = process.argv.slice(2);
  check(unpackedArgument && path.isAbsolute(unpackedArgument), "usage: verify-packaged-shelf-mutex.mjs <absolute win-unpacked directory> [result.json]");
  const unpacked = path.resolve(unpackedArgument);
  const executables = (await readdir(unpacked)).filter((name) => name.toLowerCase().endsWith(".exe") && !/^uninstall/iu.test(name));
  check(executables.length === 1, `expected one application executable, found ${executables.length}`);
  const executable = path.join(unpacked, executables[0]);
  const resources = path.join(unpacked, "resources");
  const addon = path.join(resources, "shelf-mutex", "shelf_mutex.node");
  const info = await lstat(addon);
  check(info.isFile() && !info.isSymbolicLink(), "packaged addon is not a regular file");
  const digest = createHash("sha256").update(await readFile(addon)).digest("hex");
  const shipped = JSON.parse(await readFile(path.join(resources, "shelf-mutex", "PROVENANCE.json"), "utf8"));
  const staged = JSON.parse(await readFile(path.join(desktopRoot, "packaging", "runtime", "shelf-mutex", "PROVENANCE.json"), "utf8"));
  check(shipped.sha256 === digest, "packaged addon does not match its shipped PROVENANCE.json");
  check(staged.sha256 === digest, "packaged addon does not match the staged addon");

  const scratch = await mkdtemp(path.join(os.tmpdir(), "maginalia-packaged-mutex-"));
  try {
    const probe = path.join(scratch, "probe.cjs");
    await writeFile(probe, PROBE, "utf8");
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.MAGINALIA_SHELF_MUTEX_PATH;
    const result = await run(executable, [probe], { cwd: scratch, env });
    check(result.code === 0, `packaged probe failed (exit ${result.code}): ${result.stderr.trim()}`);
    const probeResult = JSON.parse(result.stdout);
    check(probeResult.mode === "packaged", `loader did not select packaged mode: ${probeResult.mode}`);
    check(probeResult.candidates.length === 1 && probeResult.candidates[0] === path.join("shelf-mutex", "shelf_mutex.node"), "loader candidates are not exactly <resources>/shelf-mutex/shelf_mutex.node");
    check(probeResult.acquiredAndHeld === true && probeResult.released === true, "packaged mutex acquire/release failed");
    const output = { status: "PASS", verified: "win-unpacked directory package (not an NSIS installation)", executable: executables[0], addonSha256: digest, addonBytes: info.size, provenance: shipped, probe: probeResult };
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (resultPath) await writeFile(resultPath, text, "utf8");
    process.stdout.write(text);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`verify-packaged-shelf-mutex: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
