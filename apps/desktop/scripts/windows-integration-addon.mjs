/**
 * Windows integration addon (Collector wizard, WP-3): release staging checks.
 *
 * The installed Desktop loads this addon only from
 * `<resources>/windows-integration/windows_integration.node`
 * (see `src/windows-integration.ts`). Staging fails closed when the addon is missing or is
 * not the expected product build. Same pattern as `shelf-mutex-addon.mjs`.
 *
 * Checks performed on the `node-gyp` output before it is staged:
 *   - `binding.gyp` still declares N-API 8 and the static CRT (`RuntimeLibrary: "0"` = /MT);
 *   - the file is a PE32+ x64 DLL;
 *   - it imports no Visual C++ runtime DLL (vcruntime*, msvcp*, api-ms-win-crt-*);
 *   - its native export table is exactly the N-API registration pair, and it carries no
 *     test-seam strings (the test target `windows_integration_test.node` is refused);
 *   - a plain Node process can load it and its JS surface is exactly the product API.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const ADDON_FILE_NAME = "windows_integration.node";
export const ADDON_RESOURCE_DIRECTORY = "windows-integration";
/** Exactly the JS surface of the product addon. */
export const PRODUCT_JS_EXPORTS = Object.freeze([
  "apiVersion",
  "getKnownFolderPath",
  "inspectCollectorHostRegistration",
  "readRegistryValue",
  "readRegistryValueNames",
  "registerCollectorHost",
  "replaceForeignCollectorHostRegistration",
  "unregisterCollectorHost",
]);
/** The only symbols an N-API 8 addon exports natively. */
export const PRODUCT_NATIVE_EXPORTS = Object.freeze(["napi_register_module_v1", "node_api_module_get_api_version_v1"]);
/** Strings that exist only in the test-seam target. */
export const TEST_SEAM_MARKERS = Object.freeze(["MAGINALIA-Tests", "testSetRoot", "testSeedValue", "testCleanup"]);

export function addonBuildPath(desktopRoot, fileName = ADDON_FILE_NAME) {
  return path.join(desktopRoot, "native", "windows-integration", "build", "Release", fileName);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parse just enough of the PE header to confirm an x64 DLL. */
export function inspectPortableExecutable(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Windows integration addon is not a PE file (no MZ header).");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) throw new Error("Windows integration addon has no PE signature.");
  const machine = bytes.readUInt16LE(peOffset + 4);
  const characteristics = bytes.readUInt16LE(peOffset + 22);
  const optionalMagic = bytes.readUInt16LE(peOffset + 24);
  if (machine !== 0x8664) throw new Error(`Windows integration addon is not x64 (machine 0x${machine.toString(16)}).`);
  if ((characteristics & 0x2000) === 0) throw new Error("Windows integration addon is not a DLL.");
  if (optionalMagic !== 0x20b) throw new Error("Windows integration addon is not PE32+.");
  return { machine: "x64", dll: true };
}

/** Names in the PE export directory (a PE32+ image). */
export function listNativeExports(bytes) {
  const peOffset = bytes.readUInt32LE(0x3c);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const exportRva = bytes.readUInt32LE(optionalOffset + 112); // DataDirectory[0] of PE32+
  if (exportRva === 0) return [];
  const sectionsOffset = optionalOffset + optionalSize;
  const toOffset = (rva) => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sectionsOffset + index * 40;
      const virtualSize = bytes.readUInt32LE(section + 8);
      const virtualAddress = bytes.readUInt32LE(section + 12);
      const rawSize = bytes.readUInt32LE(section + 16);
      const rawOffset = bytes.readUInt32LE(section + 20);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) return rva - virtualAddress + rawOffset;
    }
    throw new Error("Windows integration addon has a malformed export directory.");
  };
  const directory = toOffset(exportRva);
  const nameCount = bytes.readUInt32LE(directory + 24);
  const namesOffset = toOffset(bytes.readUInt32LE(directory + 32));
  const names = [];
  for (let index = 0; index < nameCount; index += 1) {
    const nameOffset = toOffset(bytes.readUInt32LE(namesOffset + index * 4));
    names.push(bytes.toString("latin1", nameOffset, bytes.indexOf(0, nameOffset)));
  }
  return names.sort();
}

/** DLL names are stored as ASCII in the import directory; any CRT DLL name means a dynamic CRT. */
export function findDynamicCrtImports(bytes) {
  const text = bytes.toString("latin1");
  return [...new Set([...text.matchAll(/(?:vcruntime\d+(?:_\d+)?|msvcp\d+(?:_\w+)?|ucrtbased?|api-ms-win-crt-[a-z-]+-l\d-\d-\d)\.dll/giu)].map((match) => match[0].toLowerCase()))];
}

/** Test-seam strings present in a binary (UTF-8/ASCII and UTF-16LE). */
export function findTestSeamMarkers(bytes) {
  return TEST_SEAM_MARKERS.filter((marker) => bytes.includes(Buffer.from(marker, "latin1")) || bytes.includes(Buffer.from(marker, "utf16le")));
}

/** Throws unless the bytes are the product addon (not the test-seam build). */
export function assertProductBinary(bytes) {
  inspectPortableExecutable(bytes);
  const crt = findDynamicCrtImports(bytes);
  if (crt.length > 0) throw new Error(`The Windows integration addon links a dynamic C runtime (${crt.join(", ")}); rebuild with /MT.`);
  const exported = listNativeExports(bytes);
  if (JSON.stringify(exported) !== JSON.stringify([...PRODUCT_NATIVE_EXPORTS].sort())) {
    throw new Error(`The Windows integration addon has unexpected native exports: ${exported.join(", ")}`);
  }
  const markers = findTestSeamMarkers(bytes);
  if (markers.length > 0) throw new Error(`The Windows integration addon contains test-seam code (${markers.join(", ")}); stage the product target only.`);
}

export async function assertBindingConfiguration(desktopRoot) {
  const text = await readFile(path.join(desktopRoot, "native", "windows-integration", "binding.gyp"), "utf8");
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

// Loading is safe: the module's Init only defines functions; none is called here.
const LOAD_PROBE = `
const m = require(process.argv[1]);
process.stdout.write(JSON.stringify({ apiVersion: m.apiVersion, keys: Object.getOwnPropertyNames(m).sort() }));
`;

/** Verify the built addon and copy it with provenance into `<runtimeRoot>/windows-integration/`. */
export async function stageWindowsIntegrationAddon({ desktopRoot, repositoryRoot, runtimeRoot }) {
  const source = addonBuildPath(desktopRoot);
  try {
    await access(source);
  } catch {
    throw new Error("The Windows integration addon is missing. Run \"npm run build:native\" in apps/desktop before staging; the Collector wizard must not ship without it.");
  }
  await assertBindingConfiguration(desktopRoot);
  const bytes = await readFile(source);
  assertProductBinary(bytes);
  const probe = await run(process.execPath, ["-e", LOAD_PROBE, source]);
  if (probe.code !== 0) throw new Error(`The Windows integration addon did not load in Node: ${probe.stderr.trim()}`);
  const exported = JSON.parse(probe.stdout);
  if (JSON.stringify(exported.keys) !== JSON.stringify([...PRODUCT_JS_EXPORTS].sort())) {
    throw new Error(`The Windows integration addon JS surface is not the product API: ${exported.keys.join(", ")}`);
  }

  const destinationDirectory = path.join(runtimeRoot, ADDON_RESOURCE_DIRECTORY);
  await rm(destinationDirectory, { recursive: true, force: true });
  await mkdir(destinationDirectory, { recursive: true });
  // Write the exact bytes that were verified above (never re-read the source path).
  await writeFile(path.join(destinationDirectory, ADDON_FILE_NAME), bytes);
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
