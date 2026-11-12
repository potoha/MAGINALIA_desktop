/**
 * Windows Shelf mutex addon: release staging and packaged-layout checks (α2).
 *
 * The installed Desktop loads its native Shelf mutex only from
 * `<resources>/shelf-mutex/shelf_mutex.node` (see `src/shelf-native-mutex.ts`).
 * Staging fails closed when the addon is missing or not the expected build.
 * There is no fallback to the legacy file lease and no unbundled release.
 *
 * Checks performed on the `node-gyp` output before it is staged:
 *   - `binding.gyp` still declares N-API 8 and the static CRT (`RuntimeLibrary: "0"` = /MT);
 *   - the file is a PE32+ x64 DLL;
 *   - it imports no Visual C++ runtime DLL (vcruntime*, msvcp*, api-ms-win-crt-*),
 *     so the user's PC needs no redistributable;
 *   - a plain Node process can load it and it exposes the mutex API.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const ADDON_FILE_NAME = "shelf_mutex.node";
export const ADDON_RESOURCE_DIRECTORY = "shelf-mutex";

export function addonBuildPath(desktopRoot) {
  return path.join(desktopRoot, "native", "shelf-mutex", "build", "Release", ADDON_FILE_NAME);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parse just enough of the PE header to confirm an x64 DLL. */
export function inspectPortableExecutable(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Shelf mutex addon is not a PE file (no MZ header).");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) throw new Error("Shelf mutex addon has no PE signature.");
  const machine = bytes.readUInt16LE(peOffset + 4);
  const characteristics = bytes.readUInt16LE(peOffset + 22);
  const optionalMagic = bytes.readUInt16LE(peOffset + 24);
  if (machine !== 0x8664) throw new Error(`Shelf mutex addon is not x64 (machine 0x${machine.toString(16)}).`);
  if ((characteristics & 0x2000) === 0) throw new Error("Shelf mutex addon is not a DLL.");
  if (optionalMagic !== 0x20b) throw new Error("Shelf mutex addon is not PE32+.");
  return { machine: "x64", dll: true };
}

/** DLL names are stored as ASCII in the import directory; any CRT DLL name means a dynamic CRT. */
export function findDynamicCrtImports(bytes) {
  const text = bytes.toString("latin1");
  return [...new Set([...text.matchAll(/(?:vcruntime\d+(?:_\d+)?|msvcp\d+(?:_\w+)?|ucrtbased?|api-ms-win-crt-[a-z-]+-l\d-\d-\d)\.dll/giu)].map((match) => match[0].toLowerCase()))];
}

export async function assertBindingConfiguration(desktopRoot) {
  const text = await readFile(path.join(desktopRoot, "native", "shelf-mutex", "binding.gyp"), "utf8");
  if (!/"NAPI_VERSION=8"/u.test(text)) throw new Error("binding.gyp no longer declares NAPI_VERSION=8.");
  if (!/"RuntimeLibrary"\s*:\s*"0"/u.test(text)) throw new Error("binding.gyp no longer selects the static CRT (RuntimeLibrary \"0\" = /MT).");
}

function run(command, args, options = {}) {
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

const LOAD_PROBE = `
const m = require(process.argv[1]);
const names = ["createMutex", "openMutex", "acquire", "release", "close", "state", "getLocalAppDataPath"];
const missing = names.filter((name) => typeof m[name] !== "function");
process.stdout.write(JSON.stringify({ apiVersion: m.apiVersion, missing }));
`;

/** Verify the built addon and copy it with provenance into `<runtimeRoot>/shelf-mutex/`. */
export async function stageShelfMutexAddon({ desktopRoot, repositoryRoot, runtimeRoot }) {
  const source = addonBuildPath(desktopRoot);
  try {
    await access(source);
  } catch {
    throw new Error("The Windows Shelf mutex addon is missing. Run \"npm run build:native\" in apps/desktop before staging; α2 must not ship without it.");
  }
  await assertBindingConfiguration(desktopRoot);
  const bytes = await readFile(source);
  inspectPortableExecutable(bytes);
  const crt = findDynamicCrtImports(bytes);
  if (crt.length > 0) throw new Error(`The Shelf mutex addon links a dynamic C runtime (${crt.join(", ")}); rebuild with /MT.`);
  const probe = await run(process.execPath, ["-e", LOAD_PROBE, source]);
  if (probe.code !== 0) throw new Error(`The Shelf mutex addon did not load in Node: ${probe.stderr.trim()}`);
  const exported = JSON.parse(probe.stdout);
  if (exported.missing.length > 0) throw new Error(`The Shelf mutex addon lacks: ${exported.missing.join(", ")}`);

  const destinationDirectory = path.join(runtimeRoot, ADDON_RESOURCE_DIRECTORY);
  await rm(destinationDirectory, { recursive: true, force: true });
  await mkdir(destinationDirectory, { recursive: true });
  await copyFile(source, path.join(destinationDirectory, ADDON_FILE_NAME));
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  const status = await run("git", ["status", "--porcelain", "--", "apps/desktop/native"], { cwd: repositoryRoot });
  const provenance = {
    schemaVersion: 1,
    file: ADDON_FILE_NAME,
    bytes: bytes.length,
    sha256: sha256(bytes),
    sourceCommit: commit.code === 0 ? commit.stdout.trim() : null,
    nativeSourceClean: status.code === 0 ? status.stdout.trim() === "" : null,
    napiVersion: 8,
    crt: "static (/MT)",
    target: "win32-x64",
    addonApiVersion: exported.apiVersion ?? null,
    buildNode: process.version,
    stagedAt: new Date().toISOString(),
  };
  await writeFile(path.join(destinationDirectory, "PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return provenance;
}
