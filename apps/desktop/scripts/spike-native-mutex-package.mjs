/**
 * Packaging spike for the Windows named-mutex Shelf lock.
 *
 * Answers one question: can the addon ship inside the Windows x64 installer layout
 * without requiring Node.js, Python, Visual Studio, or the VC++ redistributable on a
 * user's PC?
 *
 * It builds a production-shaped `dir` package with electron-builder and then proves
 * two independent load paths from the packaged layout:
 *
 *   1. `ELECTRON_RUN_AS_NODE=1 <packaged exe> probe.js` — the packaged Electron binary
 *      running as Node can `require` `<resources>/shelf-mutex/shelf_mutex.node`;
 *   2. `<packaged exe>` — a real Electron main process loads the same file via
 *      `process.resourcesPath` (which is exactly what `shelf-native-mutex.ts` does).
 *
 * This is not the product installer: `packaging/runtime/*` (Reviewer sidecar, pandoc,
 * OCR runtime) is absent, so `npm run dist:windows` cannot run here. The NSIS layer
 * only wraps this same `win-unpacked` tree, so the addon placement proven here is the
 * placement the installer would ship.
 *
 * Usage: node scripts/spike-native-mutex-package.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(desktopRoot, "package.json"));

const addonBinary = path.join(desktopRoot, "native", "shelf-mutex", "build", "Release", "shelf_mutex.node");
const outputDirectory = path.join(desktopRoot, "release", "native-mutex-spike");
const unpackedDirectory = path.join(outputDirectory, "win-unpacked");
const configPath = path.join(desktopRoot, "packaging", "native-mutex-spike", "electron-builder.json");
const electronVersion = require("electron/package.json").version;
const electronDist = path.dirname(require("electron"));
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

async function main() {
  const addonStat = await readFile(addonBinary).catch(() => undefined);
  if (addonStat === undefined) {
    log(`NOT VERIFIED: ${addonBinary} is missing. Run "npm run build:native" first.`);
    process.exit(2);
  }
  log(`addon: ${addonBinary}`);
  log(`electron: ${electronVersion} (${electronDist})`);

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  log("building electron-builder dir package...");
  const build = await run(
    process.execPath,
    [
      electronBuilderCli,
      "--config",
      configPath,
      "--win",
      "dir",
      "--x64",
      "--publish",
      "never",
      `-c.electronVersion=${electronVersion}`,
      `-c.electronDist=${electronDist}`
    ],
    { cwd: desktopRoot }
  );
  if (build.code !== 0) {
    log(build.stdout);
    log(build.stderr);
    log("FAIL: electron-builder could not produce a dir package.");
    process.exit(1);
  }

  const packagedAddon = path.join(unpackedDirectory, "resources", "shelf-mutex", "shelf_mutex.node");
  const packagedAddonBytes = await readFile(packagedAddon).catch(() => undefined);
  if (packagedAddonBytes === undefined) {
    log(`FAIL: ${packagedAddon} was not produced.`);
    process.exit(1);
  }
  log(`PASS: extraResources placed the addon at ${packagedAddon} (${packagedAddonBytes.byteLength} bytes)`);

  const executable = path.join(unpackedDirectory, "MAGINALIA Native Mutex Spike.exe");
  const executableBytes = await readFile(executable).catch(() => undefined);
  if (executableBytes === undefined) {
    log(`FAIL: packaged executable not found at ${executable}`);
    process.exit(1);
  }

  // Probe 1: packaged Electron binary running as Node.
  const probeDirectory = await mkdtempScratch();
  const probeScript = path.join(probeDirectory, "run-as-node-probe.cjs");
  await writeFile(
    probeScript,
    `const path = require("node:path");\n` +
      `const addon = require(path.join(process.env.MAGINALIA_PROBE_RESOURCES, "shelf-mutex", "shelf_mutex.node"));\n` +
      `const handle = addon.createMutex("Local\\\\MAGINALIA.Spike.RunAsNode." + process.pid);\n` +
      `const acquire = addon.acquire(handle, 1000);\n` +
      `const release = addon.release(handle);\n` +
      `addon.close(handle);\n` +
      `process.stdout.write(JSON.stringify({ apiVersion: addon.apiVersion, acquire, release }) + "\\n");\n`,
    "utf8"
  );
  const runAsNode = await run(executable, [probeScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MAGINALIA_PROBE_RESOURCES: path.join(unpackedDirectory, "resources")
    }
  });
  const runAsNodeLine = runAsNode.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  let runAsNodeResult;
  try {
    runAsNodeResult = JSON.parse(runAsNodeLine ?? "");
  } catch {
    runAsNodeResult = undefined;
  }
  if (runAsNode.code !== 0 || runAsNodeResult?.apiVersion !== 1 || runAsNodeResult?.acquire?.acquired !== true) {
    log(`FAIL: ELECTRON_RUN_AS_NODE probe could not use the packaged addon (exit ${runAsNode.code}).`);
    log(runAsNode.stdout);
    log(runAsNode.stderr);
    process.exit(1);
  }
  log("PASS: packaged Electron binary loaded and used <resources>/shelf-mutex/shelf_mutex.node as Node");

  // Probe 2: real Electron main process reading the addon from process.resourcesPath.
  const resultFile = path.join(probeDirectory, "electron-result.json");
  const electronProbe = await run(executable, [], {
    env: { ...process.env, MAGINALIA_SPIKE_RESULT: resultFile }
  });
  const electronText = await readFile(resultFile, "utf8").catch(() => "");
  if (electronText === "") {
    log(`FAIL: real Electron main process produced no result (exit ${electronProbe.code}).`);
    log(electronProbe.stdout);
    log(electronProbe.stderr);
    process.exit(1);
  }
  const electronResult = JSON.parse(electronText);
  if (electronProbe.code !== 0 || electronResult.ok !== true) {
    log(`FAIL: real Electron main process could not use the packaged addon: ${electronText}`);
    log(electronProbe.stderr);
    process.exit(1);
  }
  log(`PASS: real Electron ${electronResult.electron} main process loaded the packaged addon`);

  await rm(probeDirectory, { recursive: true, force: true });
  log("");
  log("Packaging spike result: PASS");
  log(`  package: ${unpackedDirectory}`);
  log("  distribution: prebuilt .node copied through extraResources; no Node.js, Python,");
  log("  Visual Studio, or VC++ redistributable is required on the user's PC.");
}

async function mkdtempScratch() {
  return await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "maginalia-package-spike-"))
  );
}

main().catch((error) => {
  log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
