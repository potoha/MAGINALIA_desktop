/**
 * Build the Collector Native Messaging Host PAYLOAD for the Desktop installer
 * (collector-wizard-integration-design §2.1/§2.5): a Node single executable
 * application (SEA) with the prebuilt `shelf_mutex.node` next to it, plus licenses,
 * notices and provenance. It builds no installer and registers nothing: the Desktop
 * app places and registers the Host at runtime, and `stage-windows-app.mjs` copies this
 * payload into the Desktop resources.
 *
 *   npm run package:windows:collector-host      (after `npm run build:native`)
 *
 * Output (apps/desktop/release/collector-host/payload/):
 *   MAGINALIA-Collector-Host.exe     Node SEA (bundle of collector-native-host-product-entry.ts)
 *   shelf_mutex.node                 the N-API 8 addon from `npm run build:native`, static CRT (/MT)
 *   LICENSE.txt NOTICE.txt NODE-LICENSE.txt PROVENANCE.txt
 *
 * The build reads the toolchain from this checkout only. Nothing is installed or
 * registered on the build machine. It must run on Node.js >= 24 (the SEA embeds the
 * building runtime) and takes the Node LICENSE from next to that node.exe.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_ADDON, HOST_EXECUTABLE, PAYLOAD_VERSION } from "./collector-payload.mjs";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(desktop, "..", "..");
const output = path.join(desktop, "release", "collector-host");
const stage = path.join(output, "stage");
const payload = path.join(output, "payload");

export const HOST_NAME = "org.maginalia.collector";
export const EXECUTABLE = HOST_EXECUTABLE;
export const ADDON = HOST_ADDON;
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

export async function bundle(entry, fileName) {
  const { build } = await import("vite");
  await build({
    configFile: false,
    root: desktop,
    logLevel: "warn",
    plugins: [inlineFormatSchemas()],
    // The payload version is the Host version that `host_info` reports.
    define: { __COLLECTOR_HOST_VERSION__: JSON.stringify(PAYLOAD_VERSION) },
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
  // A define that did not take effect would silently fall back to the runtime default.
  if (code.includes("__COLLECTOR_HOST_VERSION__")
    || (entry.endsWith("collector-native-host-product-entry.ts") && !code.includes(`COLLECTOR_HOST_VERSION = ${JSON.stringify(PAYLOAD_VERSION)}`))) {
    throw new Error("The Collector Host version was not injected into the bundle.");
  }
  // Fail the build if a non-builtin module would be resolved from disk at runtime.
  // Ajv's code-generation templates contain `require("...")` text inside template
  // literals (only used for standalone code export); those are not runtime requires.
  const external = [...code.matchAll(/(?<![`\w.$])require\(["']([^"']+)["']\)/gu)].map((match) => match[1])
    .filter((name) => !name.startsWith("node:") && !require("node:module").builtinModules.includes(name));
  if (external.length > 0) throw new Error(`The Host bundle still requires external modules: ${[...new Set(external)].join(", ")}`);
  return file;
}

/**
 * The Host ships the very addon `npm run build:native` produced (the same build that
 * `shelf-mutex-addon.mjs` stages for the Desktop Reviewer). It is not rebuilt here, so
 * both resources copies are byte-identical; `stage-windows-app.mjs` asserts that.
 */
async function readAddon() {
  const addon = path.join(desktop, "native", "shelf-mutex", "build", "Release", ADDON);
  const bytes = await readFile(addon).catch(() => { throw new Error("shelf_mutex.node is missing; run `npm run build:native` first."); });
  // /MT: the addon must not depend on the Visual C++ redistributable.
  const text = bytes.toString("latin1").toLowerCase();
  for (const dll of ["vcruntime140.dll", "msvcp140.dll", "ucrtbase.dll", "api-ms-win-crt-"]) {
    if (text.includes(dll)) throw new Error(`The Shelf mutex addon imports ${dll}; expected a static CRT (/MT) build.`);
  }
  return addon;
}

/**
 * `execArgvExtension: "none"` (a recent SEA option) is what keeps
 * NODE_OPTIONS and CLI flags away from the Host. A Node that predates it would silently
 * ignore the option and produce an executable that honours NODE_OPTIONS, so the build
 * refuses to run on anything older than the pinned major.
 */
export const MINIMUM_BUILD_NODE_MAJOR = 24;

export function assertBuildNodeSupportsExecArgvExtension(version = process.versions.node) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < MINIMUM_BUILD_NODE_MAJOR) {
    throw new Error(
      `The Collector Host must be built with Node.js ${MINIMUM_BUILD_NODE_MAJOR} or later `
      + `(SEA execArgvExtension support); this is ${version}.`,
    );
  }
}

/**
 * Prove on the built executable that NODE_OPTIONS and CLI runtime flags are ignored.
 * A rejected origin makes the Host answer without reading any binding or Shelf, so this
 * check touches no user data. A preload script that runs would leave a marker file.
 */
export async function verifyExecutableIgnoresRuntimeOptions(executable) {
  const marker = path.join(stage, "node-options-injected.txt");
  const preload = path.join(stage, "node-options-preload.cjs");
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");
`);
  const body = Buffer.from(JSON.stringify({ protocol: "maginalia.collector.experimental.v1", operation: "health" }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  const input = Buffer.concat([header, body]);
  const attempts = [
    { label: "NODE_OPTIONS", args: [], env: { ...process.env, NODE_OPTIONS: `--require "${preload}"` } },
    { label: "CLI --require", args: ["--require", preload], env: process.env },
  ];
  for (const attempt of attempts) {
    const result = spawnSync(executable, attempt.args, { input, env: attempt.env, cwd: stage, timeout: 30000, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`The built Host failed the ${attempt.label} check: ${result.error?.message ?? `exit ${result.status}`}.`);
    }
    const reply = result.stdout.length >= 4 ? result.stdout.subarray(4, 4 + result.stdout.readUInt32LE(0)).toString("utf8") : "";
    if (!reply.includes("host_configuration_or_origin_invalid")) {
      throw new Error(`The built Host did not reject the missing caller origin during the ${attempt.label} check.`);
    }
    const injected = await access(marker).then(() => true, () => false);
    if (injected) throw new Error(`The built Host executed a preload script supplied through ${attempt.label}.`);
  }
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

/**
 * The SEA embeds the exact Node.js build that runs this script, so its authoritative
 * LICENSE (shipped next to node.exe in the official distribution) must ship too.
 * There is deliberately no fallback or download.
 */
export function nodeLicensePath() {
  return path.join(path.dirname(process.execPath), "LICENSE");
}

async function readNodeLicense() {
  try {
    return await readFile(nodeLicensePath());
  } catch {
    throw new Error(
      `The Node.js LICENSE of the building runtime was not found at ${nodeLicensePath()}. `
      + "Build with a Node.js distribution that ships LICENSE next to node.exe (for example the official win-x64 zip).",
    );
  }
}

const LICENSE_FILE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license", "license.md"];

/**
 * npm packages compiled into the bundle, from the bundler's `//#region` source
 * markers. Workspace packages (`packages/*`) are this repository's own code and are
 * covered by its LICENSE. Each package must declare a license and ship a license file.
 */
export async function collectBundledPackageLicenses(bundleFile) {
  const code = await readFile(bundleFile, "utf8");
  const roots = new Set();
  for (const match of code.matchAll(/^\/\/#region (.+)$/gmu)) {
    const source = match[1].trim().replace(/\\/gu, "/");
    const marker = source.lastIndexOf("node_modules/");
    if (marker < 0) continue;
    const rest = source.slice(marker + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    roots.add(path.resolve(desktop, source.slice(0, marker + "node_modules/".length), name));
  }
  const packages = [];
  for (const root of [...roots].sort()) {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    let licenseText;
    for (const candidate of LICENSE_FILE_NAMES) {
      licenseText = await readFile(path.join(root, candidate), "utf8").catch(() => undefined);
      if (licenseText !== undefined) break;
    }
    if (typeof manifest.license !== "string" || licenseText === undefined) {
      throw new Error(`Bundled package ${manifest.name} has no declared license or license file.`);
    }
    packages.push({ name: manifest.name, version: manifest.version, license: manifest.license, text: licenseText.replace(/\r\n/gu, "\n").trim() });
  }
  const unique = new Map(packages.map((entry) => [`${entry.name}@${entry.version}`, entry]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

async function writeNotice(nodeLicenseSha256, bundled) {
  const base = (await readFile(path.join(repository, "NOTICE"), "utf8")).replace(/\r\n/gu, "\n").trimEnd();
  const sections = [
    base,
    "",
    "=".repeat(78),
    "Third-party components included in MAGINALIA Collector Host",
    "=".repeat(78),
    "",
    `Node.js ${process.version} (win-${process.arch}) is embedded in MAGINALIA-Collector-Host.exe`,
    "as a single executable application. Its license, including the licenses of the",
    "third-party components bundled with Node.js, is in NODE-LICENSE.txt",
    `(SHA-256 ${nodeLicenseSha256}).`,
    "",
    "The following npm packages are compiled into MAGINALIA-Collector-Host.exe:",
    "",
    ...bundled.map((entry) => `- ${entry.name} ${entry.version} (${entry.license})`),
  ];
  for (const entry of bundled) {
    sections.push("", "-".repeat(78), `${entry.name} ${entry.version} - ${entry.license}`, "-".repeat(78), "", entry.text);
  }
  await writeFile(path.join(payload, "NOTICE.txt"), `${sections.join("\n")}\n`);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The Collector Host is built on Windows x64 only.");
  assertBuildNodeSupportsExecArgvExtension();
  const desktopPackage = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  if (desktopPackage.version !== PAYLOAD_VERSION) {
    throw new Error(`apps/desktop/package.json version ${desktopPackage.version} must equal the Host payload version ${PAYLOAD_VERSION}.`);
  }
  const nodeLicense = await readNodeLicense();
  const nodeLicenseSha256 = sha256(nodeLicense);
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
  const addon = await readAddon();
  // Same bundler configuration, disposable profile: proves the bundled write path.
  const selfTest = await bundle(path.join(desktop, "scripts", "collector-host-bundle-selftest.ts"), "collector-host-selftest.cjs");
  if (!run(process.execPath, [selfTest]).includes("COLLECTOR_HOST_BUNDLE_SELFTEST_OK")) {
    throw new Error("The Collector Host bundle self-test did not pass.");
  }
  const executable = await buildExecutable(bundleFile);
  await verifyExecutableIgnoresRuntimeOptions(executable);
  await copyFile(addon, path.join(payload, ADDON));
  await copyFile(path.join(repository, "LICENSE"), path.join(payload, "LICENSE.txt"));
  await writeFile(path.join(payload, "NODE-LICENSE.txt"), nodeLicense);
  const bundled = await collectBundledPackageLicenses(bundleFile);
  await writeNotice(nodeLicenseSha256, bundled);

  const commit = run("git", ["rev-parse", "HEAD"]);
  const dirty = run("git", ["status", "--porcelain"]).length > 0;
  const shipped = (await readdir(payload)).sort();
  const lines = [
    "MAGINALIA Collector Host payload - build provenance",
    "",
    `payload version: ${PAYLOAD_VERSION} (= apps/desktop/package.json version)`,
    `host name: ${HOST_NAME}`,
    `allowed origin: ${origin}`,
    `git commit: ${commit}${dirty ? " (working tree had uncommitted changes)" : ""}`,
    `built at: ${new Date().toISOString()}`,
    `node (SEA base, ${process.arch}): ${process.version}`,
    `n-api: ${process.versions.napi}; v8: ${process.versions.v8}`,
    `node license: NODE-LICENSE.txt = LICENSE next to the building node.exe (${process.version}), SHA-256 ${nodeLicenseSha256}`,
    `bundled npm packages: ${bundled.map((entry) => `${entry.name}@${entry.version} (${entry.license})`).join(", ")}`,
    `postject: ${require("postject/package.json").version}`,
    `vite: ${require("vite/package.json").version}`,
    `node-gyp: ${require("node-gyp/package.json").version}`,
    "addon: N-API 8, static CRT (/MT), no VC++ runtime import (checked); copied from npm run build:native",
    "signing: unsigned (SmartScreen warning is a known limitation)",
    "",
    "SHA-256 of shipped files:",
  ];
  for (const file of shipped) lines.push(`${sha256(await readFile(path.join(payload, file)))}  ${file}`);
  await writeFile(path.join(payload, "PROVENANCE.txt"), `${lines.join("\n")}\n`);

  const sums = [];
  for (const file of (await readdir(payload)).sort()) sums.push(`${sha256(await readFile(path.join(payload, file)))}  payload/${file}`);
  await writeFile(path.join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
  await rm(stage, { recursive: true, force: true });
  process.stdout.write(`${sums.join("\n")}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
