/**
 * Verify, from a built Windows package (not dev mode), that the installed Desktop loads
 * its Windows integration addon from `<resources>/windows-integration/`.
 *
 * Usage: node scripts/verify-packaged-windows-integration.mjs <win-unpacked directory> [result.json]
 *
 * 1. The packaged file exists as a regular file, matches the shipped and staged
 *    PROVENANCE.json SHA-256 and passes the product-binary checks (no CRT import, exact
 *    native export table, no test seam).
 * 2. The packaged executable, run as Node (ELECTRON_RUN_AS_NODE=1) from an unrelated working
 *    directory, loads the *product* loader from `app.asar/dist/main/windows-integration.js`,
 *    which must select packaged mode with exactly the one resources candidate, then
 *    performs READ-ONLY calls only (a known folder and a harmless registry read).
 *    It never calls register/unregister.
 *
 * A `win-unpacked` directory is the tree NSIS wraps. Passing this check is not an NSIS
 * installation PASS.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertProductBinary } from "./windows-integration-addon.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROBE = String.raw`
const path = require("node:path");
const resources = process.resourcesPath;
const mod = require(path.join(resources, "app.asar", "dist", "main", "windows-integration.js"));
const resolution = mod.resolveWindowsIntegrationAddonCandidates({ resourcesPath: resources, defaultApp: process.defaultApp, moduleDirectory: undefined });
const integration = mod.loadWindowsIntegration();
const folder = integration.getKnownFolderPath("UserProgramFiles");
const productName = integration.readRegistryValue("HKLM", "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "ProductName", "64");
process.stdout.write(JSON.stringify({
  electron: process.versions.electron, napi: process.versions.napi,
  mode: resolution.mode, candidates: resolution.candidates.map((candidate) => path.relative(resources, candidate)),
  knownFolderIsAbsolute: /^[A-Za-z]:[\\/]/.test(folder), registryReadType: productName === null ? null : productName.type
}));
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
  check(unpackedArgument && path.isAbsolute(unpackedArgument), "usage: verify-packaged-windows-integration.mjs <absolute win-unpacked directory> [result.json]");
  const unpacked = path.resolve(unpackedArgument);
  const executables = (await readdir(unpacked)).filter((name) => name.toLowerCase().endsWith(".exe") && !/^uninstall/iu.test(name));
  check(executables.length === 1, `expected one application executable, found ${executables.length}`);
  const executable = path.join(unpacked, executables[0]);
  const resources = path.join(unpacked, "resources");
  const addon = path.join(resources, "windows-integration", "windows_integration.node");
  const info = await lstat(addon);
  check(info.isFile() && !info.isSymbolicLink(), "packaged addon is not a regular file");
  const bytes = await readFile(addon);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const shipped = JSON.parse(await readFile(path.join(resources, "windows-integration", "PROVENANCE.json"), "utf8"));
  const staged = JSON.parse(await readFile(path.join(desktopRoot, "packaging", "runtime", "windows-integration", "PROVENANCE.json"), "utf8"));
  check(shipped.sha256 === digest, "packaged addon does not match its shipped PROVENANCE.json");
  check(staged.sha256 === digest, "packaged addon does not match the staged addon");
  assertProductBinary(bytes);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "maginalia-packaged-wi-"));
  try {
    const probe = path.join(scratch, "probe.cjs");
    await writeFile(probe, PROBE, "utf8");
    const result = await run(executable, [probe], { cwd: scratch, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    check(result.code === 0, `packaged probe failed (exit ${result.code}): ${result.stderr.trim()}`);
    const probeResult = JSON.parse(result.stdout);
    check(probeResult.mode === "packaged", `loader did not select packaged mode: ${probeResult.mode}`);
    check(probeResult.candidates.length === 1 && probeResult.candidates[0] === path.join("windows-integration", "windows_integration.node"), "loader candidates are not exactly <resources>/windows-integration/windows_integration.node");
    check(probeResult.knownFolderIsAbsolute === true, "known folder did not resolve to an absolute path");
    const output = { status: "PASS", verified: "win-unpacked directory package (not an NSIS installation); read-only calls only", executable: executables[0], addonSha256: digest, addonBytes: info.size, provenance: shipped, probe: probeResult };
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (resultPath) await writeFile(resultPath, text, "utf8");
    process.stdout.write(text);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`verify-packaged-windows-integration: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
