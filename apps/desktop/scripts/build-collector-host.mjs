/**
 * Build the standalone Windows x64 MAGINALIA Collector Native Messaging Host
 * (Desktop #86): a Node single executable application (SEA) with the prebuilt
 * `shelf_mutex.node` next to it, plus a per-user NSIS installer.
 *
 *   npm run dist:collector-host
 *
 * Output (apps/desktop/release/collector-host/):
 *   payload/MAGINALIA-Collector-Host.exe       Node SEA (bundle of collector-native-host-product.ts)
 *   payload/shelf_mutex.node                   N-API 8 addon, static CRT (/MT)
 *   payload/org.maginalia.collector.json       Chrome host manifest (path relative to itself)
 *   payload/PROVENANCE.txt                     commit, toolchain, SHA-256 of every shipped file
 *   MAGINALIA-Collector-Host-Setup-<version>.exe
 *   SHA256SUMS                                 payload files and the installer
 *
 * The build reads the toolchain from this checkout only. Nothing is installed or
 * registered on the build machine.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(desktop, "..", "..");
const output = path.join(desktop, "release", "collector-host");
const stage = path.join(output, "stage");
const payload = path.join(output, "payload");

export const HOST_VERSION = "0.1.0";
export const HOST_NAME = "org.maginalia.collector";
export const EXECUTABLE = "MAGINALIA-Collector-Host.exe";
export const ADDON = "shelf_mutex.node";
export const MANIFEST = `${HOST_NAME}.json`;
export const INSTALLER = `MAGINALIA-Collector-Host-Setup-${HOST_VERSION}.exe`;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, { cwd: desktop, stdio: ["ignore", "pipe", "inherit"], ...options });
  return result === null ? "" : result.toString("utf8").trim();
}

/** The compiled origin is the single source; read it from the product module bundle input. */
async function allowedOrigin() {
  const source = await readFile(path.join(desktop, "src", "collector-native-host-product.ts"), "utf8");
  const id = /COLLECTOR_EXTENSION_ID = "([a-p]{32})"/u.exec(source)?.[1];
  if (!id) throw new Error("The Collector extension ID constant was not found.");
  return `chrome-extension://${id}/`;
}

/**
 * `@maginalia/format` reads its JSON Schemas from disk next to its module at import
 * time. A single executable has no such directory, so the schemas are inlined at
 * bundle time from the same copied files the package ships.
 */
function inlineFormatSchemas() {
  const formatDist = path.join(repository, "packages", "format", "dist");
  return {
    name: "maginalia-inline-format-schemas",
    async transform(code, id) {
      if (path.resolve(id.split("?")[0]) !== path.join(formatDist, "index.js")) return null;
      const start = code.indexOf("const specDirectory");
      const end = code.indexOf("const ajv = new Ajv2020");
      if (start < 0 || end < 0) throw new Error("Unexpected @maginalia/format layout; refusing to bundle.");
      const schemas = {};
      for (const file of (await readdir(path.join(formatDist, "schemas"))).filter((name) => name.endsWith(".json")).sort()) {
        schemas[file] = JSON.parse(await readFile(path.join(formatDist, "schemas", file), "utf8"));
      }
      const inlined = `const inlinedSchemas = ${JSON.stringify(schemas)};\n`
        + "const readSchema = (file) => { const schema = inlinedSchemas[file]; if (schema === undefined) throw new Error(`Missing schema ${file}`); return JSON.parse(JSON.stringify(schema)); };\n";
      return { code: code.slice(0, start) + inlined + code.slice(end), map: null };
    },
  };
}

async function bundle(entry, fileName) {
  const { build } = await import("vite");
  await build({
    configFile: false,
    root: desktop,
    logLevel: "warn",
    plugins: [inlineFormatSchemas()],
    resolve: { alias: { "@maginalia/writing-core": path.join(repository, "packages", "writing-core", "src", "index.ts") } },
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: entry,
      outDir: stage,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: "node24",
      rollupOptions: {
        output: { format: "cjs", entryFileNames: fileName, codeSplitting: false },
      },
    },
  });
  const file = path.join(stage, fileName);
  const code = await readFile(file, "utf8");
  // Fail the build if a non-builtin module would be resolved from disk at runtime.
  // Ajv's code-generation templates contain `require("...")` text inside template
  // literals (only used for standalone code export); those are not runtime requires.
  const external = [...code.matchAll(/(?<![`\w.$])require\(["']([^"']+)["']\)/gu)].map((match) => match[1])
    .filter((name) => !name.startsWith("node:") && !require("node:module").builtinModules.includes(name));
  if (external.length > 0) throw new Error(`The Host bundle still requires external modules: ${[...new Set(external)].join(", ")}`);
  return file;
}

async function buildAddon() {
  run(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild", "--directory=native/shelf-mutex"], { stdio: ["ignore", "ignore", "inherit"] });
  const addon = path.join(desktop, "native", "shelf-mutex", "build", "Release", ADDON);
  const bytes = await readFile(addon);
  // /MT: the addon must not depend on the Visual C++ redistributable.
  const text = bytes.toString("latin1").toLowerCase();
  for (const dll of ["vcruntime140.dll", "msvcp140.dll", "ucrtbase.dll", "api-ms-win-crt-"]) {
    if (text.includes(dll)) throw new Error(`The Shelf mutex addon imports ${dll}; expected a static CRT (/MT) build.`);
  }
  return addon;
}

async function buildExecutable(bundleFile) {
  const blob = path.join(stage, "collector-host.blob");
  const config = path.join(stage, "sea-config.json");
  await writeFile(config, JSON.stringify({
    main: bundleFile,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    // Ignore NODE_OPTIONS and CLI runtime flags: the Host's argv belongs to Chrome.
    execArgv: [],
    execArgvExtension: "none",
  }, null, 2));
  run(process.execPath, ["--experimental-sea-config", config], { stdio: ["ignore", "ignore", "inherit"] });
  const executable = path.join(payload, EXECUTABLE);
  await copyFile(process.execPath, executable);
  const { inject } = require("postject");
  await inject(executable, "NODE_SEA_BLOB", await readFile(blob), { sentinelFuse: SEA_FUSE, overwrite: true });
  return executable;
}

async function nsis() {
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const toolset = builderRequire("app-builder-lib/out/toolsets/windows");
  // Same checksum-pinned NSIS bundle electron-builder uses for the Desktop installer.
  return toolset.getMakeNsisPath(null);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The Collector Host is built on Windows x64 only.");
  for (const required of [
    path.join(repository, "packages", "format", "dist", "index.js"),
    path.join(repository, "packages", "repository-core", "dist", "index.js"),
  ]) {
    await readFile(required).catch(() => { throw new Error(`Build the workspace packages first (missing ${path.relative(repository, required)}).`); });
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(payload, { recursive: true });

  const origin = await allowedOrigin();
  const bundleFile = await bundle(path.join(desktop, "src", "collector-native-host-product-entry.ts"), "collector-host.cjs");
  const addon = await buildAddon();
  // Same bundler configuration, disposable profile: proves the bundled write path.
  const selfTest = await bundle(path.join(desktop, "scripts", "collector-host-bundle-selftest.ts"), "collector-host-selftest.cjs");
  if (!run(process.execPath, [selfTest]).includes("COLLECTOR_HOST_BUNDLE_SELFTEST_OK")) {
    throw new Error("The Collector Host bundle self-test did not pass.");
  }
  await buildExecutable(bundleFile);
  await copyFile(addon, path.join(payload, ADDON));
  // Chrome on Windows resolves a relative `path` against the manifest's folder, so the
  // manifest is static ASCII and safe for any (including non-ASCII) install path.
  await writeFile(path.join(payload, MANIFEST), `${JSON.stringify({
    name: HOST_NAME,
    description: "MAGINALIA Collector Native Messaging Host",
    path: EXECUTABLE,
    type: "stdio",
    allowed_origins: [origin],
  }, null, 2)}\n`);
  await copyFile(path.join(repository, "LICENSE"), path.join(payload, "LICENSE.txt"));
  await copyFile(path.join(repository, "NOTICE"), path.join(payload, "NOTICE.txt"));

  const makensis = await nsis();
  const nsisVersion = run(makensis.path, ["/VERSION"], { env: { ...process.env, ...(makensis.env ?? {}) } });
  const commit = run("git", ["rev-parse", "HEAD"]);
  const dirty = run("git", ["status", "--porcelain"]).length > 0;
  const shipped = (await readdir(payload)).sort();
  const lines = [
    "MAGINALIA Collector Host - build provenance",
    "",
    `version: ${HOST_VERSION}`,
    `host name: ${HOST_NAME}`,
    `allowed origin: ${origin}`,
    `git commit: ${commit}${dirty ? " (working tree had uncommitted changes)" : ""}`,
    `built at: ${new Date().toISOString()}`,
    `node (SEA base, ${process.arch}): ${process.version}`,
    `n-api: ${process.versions.napi}; v8: ${process.versions.v8}`,
    `postject: ${require("postject/package.json").version}`,
    `vite: ${require("vite/package.json").version}`,
    `node-gyp: ${require("node-gyp/package.json").version}`,
    `nsis: ${nsisVersion} (electron-builder ${require("electron-builder/package.json").version} toolset)`,
    "addon: N-API 8, static CRT (/MT), no VC++ runtime import (checked)",
    "signing: unsigned (SmartScreen warning is a known limitation)",
    "",
    "SHA-256 of shipped files:",
  ];
  for (const file of shipped) lines.push(`${sha256(await readFile(path.join(payload, file)))}  ${file}`);
  await writeFile(path.join(payload, "PROVENANCE.txt"), `${lines.join("\n")}\n`);

  run(makensis.path, [
    "/V2", "/INPUTCHARSET", "UTF8",
    `/DVERSION=${HOST_VERSION}`,
    `/DPAYLOAD=${payload}`,
    `/DOUTFILE=${path.join(output, INSTALLER)}`,
    path.join(desktop, "packaging", "collector-host", "installer.nsi"),
  ], { env: { ...process.env, ...(makensis.env ?? {}) }, stdio: ["ignore", "ignore", "inherit"] });

  const sums = [];
  for (const file of (await readdir(payload)).sort()) sums.push(`${sha256(await readFile(path.join(payload, file)))}  payload/${file}`);
  sums.push(`${sha256(await readFile(path.join(output, INSTALLER)))}  ${INSTALLER}`);
  await writeFile(path.join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
  await rm(stage, { recursive: true, force: true });
  process.stdout.write(`${sums.join("\n")}\n`);
}

await main();
