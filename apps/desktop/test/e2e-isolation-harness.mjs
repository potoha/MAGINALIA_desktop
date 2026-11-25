#!/usr/bin/env node
/**
 * Desktop E2E isolation harness (Desktop issue #93). Test-only.
 *
 * The harness is the primary isolation guarantee: it validates the disposable
 * test root and every Desktop-controlled destination in plain Node *before*
 * spawning Electron, and refuses to spawn on any mismatch. Electron itself
 * creates the `--user-data-dir` directory during native startup, before any
 * application JavaScript runs, so an in-app check alone cannot promise "no
 * filesystem effect" for a wrong userData. The in-app gate
 * (`src/e2e-isolation.ts`, activated by MAGINALIA_E2E_ISOLATION_ROOT) is the
 * second layer: it re-verifies what Electron actually selected, redirects
 * Electron's Downloads/Documents keys into the root, and exits 78 before any
 * Desktop store, first-run action or window exists.
 *
 * Commands (all paths absolute):
 *   prepare   <root>                        create a new marked disposable root
 *   launch    <root> [--packaged <exe>] [--env NAME=VALUE ...] [-- <app args>]
 *   inventory <directory> <out.json> [--allow-missing]
 *   audit     <out.json> <label>=<path>[:name1|name2] ...   read-only metadata audit
 *
 * Cleanup is deliberately not automated: remove only a root this harness
 * prepared (it carries the marker file) after every process using it exited.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = path.resolve(desktopRoot, "../..");
export const developmentElectron = path.join(repositoryRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
export const developmentMain = path.join(desktopRoot, "dist", "main", "main.js");
export const ROOT_LAYOUT = Object.freeze(["userData", "Downloads", "Documents", "evidence"]);

async function loadGate() {
  return import(pathToFileURL(path.join(desktopRoot, "dist", "main", "e2e-isolation.js")).href);
}

/** Paths a test root must never equal or contain. Read from the environment only. */
export function protectedLocations(env = process.env) {
  return [os.homedir(), env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE]
    .filter((value) => typeof value === "string" && path.isAbsolute(value));
}

/** Create a new disposable root. Refuses an existing non-empty directory. */
export async function prepareIsolationRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("prepare: the root must be an absolute path.");
  const parent = await lstat(path.dirname(root)).catch(() => undefined);
  if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error("prepare: the parent directory must exist and must not be a link.");
  const existing = await lstat(root).catch(() => undefined);
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(root)).length > 0) {
      throw new Error("prepare: the root already exists and is not an empty directory; refusing to adopt it.");
    }
  } else {
    await mkdir(root);
  }
  const gate = await loadGate();
  await writeFile(path.join(root, gate.E2E_ISOLATION_MARKER_FILE), `${JSON.stringify({ kind: gate.E2E_ISOLATION_MARKER_KIND, version: 1, preparedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  for (const name of ROOT_LAYOUT) await mkdir(path.join(root, name));
  // Validate what we just made, exactly as a launch would.
  return gate.validateIsolationRoot(root, { protectedPaths: protectedLocations() });
}

/**
 * Build a validated launch. Throws before anything is spawned if the root,
 * userData or any guarded smoke path is outside the root.
 */
export async function isolatedLaunchSpec({ root, packagedExecutable, appArgs = [], env = {} }) {
  const gate = await loadGate();
  if (appArgs.some((argument) => /^--user-data-dir(?:=|$)/u.test(argument))) {
    throw new Error("launch: --user-data-dir is chosen by the harness and must not be passed as an app argument.");
  }
  const isolation = gate.validateIsolationRoot(root, { protectedPaths: protectedLocations() });
  const userData = gate.assertDestinationInsideRoot(isolation, "Electron userData", path.join(isolation.root, "userData"), { mustExist: true });
  for (const name of ["Downloads", "Documents", gate.E2E_ISOLATION_EVIDENCE_DIRECTORY]) {
    gate.assertDestinationInsideRoot(isolation, name, path.join(isolation.root, name), { mustExist: true });
  }
  for (const name of gate.E2E_ISOLATION_GUARDED_ENV) {
    if (env[name] !== undefined) gate.assertDestinationInsideRoot(isolation, name, env[name]);
  }
  const childEnv = { ...process.env, ...env, [gate.E2E_ISOLATION_ROOT_ENV]: isolation.root, MAGINALIA_SMOKE_EXPECTED_USER_DATA: userData };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  for (const name of gate.E2E_ISOLATION_GUARDED_ENV) {
    if (env[name] === undefined) delete childEnv[name];
  }
  const executable = packagedExecutable ?? developmentElectron;
  const args = [`--user-data-dir=${userData}`, ...(packagedExecutable ? [] : [developmentMain]), ...appArgs];
  return Object.freeze({ root: isolation.root, userData, executable, args: Object.freeze(args), env: childEnv });
}

export function runSpec(spec, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { cwd: desktopRoot, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`launch timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

/** SHA-256 inventory of a tree. Links/junctions are reported, never followed. */
export async function inventoryTree(directory, { allowMissing = false, exclude = [] } = {}) {
  const top = await lstat(directory).catch(() => undefined);
  if (top === undefined) {
    if (allowMissing) return { version: 1, exists: false, files: [] };
    throw new Error("inventory: directory does not exist.");
  }
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error("inventory: directory is a link or not a directory.");
  const files = [];
  const links = [];
  async function walk(current, relative) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (exclude.includes(name)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) links.push(name);
      else if (info.isDirectory()) await walk(absolute, name);
      else if (info.isFile()) files.push({ path: name, size: info.size, sha256: await hashFile(absolute) });
      else links.push(name);
    }
  }
  await walk(directory, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, exists: true, files, links: links.sort() };
}

export function compareInventories(before, after) {
  const prior = new Map(before.files.map((entry) => [entry.path, entry]));
  const next = new Map(after.files.map((entry) => [entry.path, entry]));
  const added = [...next.keys()].filter((name) => !prior.has(name));
  const removed = [...prior.keys()].filter((name) => !next.has(name));
  const changed = [...prior.keys()].filter((name) => next.has(name) && next.get(name).sha256 !== prior.get(name).sha256);
  return { added, removed, changed };
}

/**
 * Read-only metadata audit (existence, type, size, mtime) of named locations,
 * for the real-profile impact audit required by #93. It never reads file
 * contents, never lists unnamed user files, and never modifies anything.
 */
export async function auditLocations(entries) {
  const result = [];
  for (const { label, location, names = [] } of entries) {
    const info = await lstat(location).catch(() => undefined);
    const record = { label, exists: info !== undefined, kind: info === undefined ? null : info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file", entries: [] };
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      for (const name of names) {
        const child = await lstat(path.join(location, name)).catch(() => undefined);
        record.entries.push({ name, exists: child !== undefined, size: child?.size ?? null, modified: child?.mtime.toISOString() ?? null });
      }
    }
    result.push(record);
  }
  return { version: 1, auditedAt: new Date().toISOString(), locations: result };
}

async function cli(argv) {
  const [command, ...rest] = argv;
  if (command === "prepare") {
    const validated = await prepareIsolationRoot(rest[0]);
    process.stdout.write(`${JSON.stringify({ status: "PREPARED", root: validated.root })}\n`);
    return 0;
  }
  if (command === "launch") {
    const separator = rest.indexOf("--");
    const options = separator === -1 ? rest : rest.slice(0, separator);
    const appArgs = separator === -1 ? [] : rest.slice(separator + 1);
    const [root] = options;
    let packagedExecutable;
    const env = {};
    for (let index = 1; index < options.length; index += 1) {
      if (options[index] === "--packaged") packagedExecutable = options[++index];
      else if (options[index] === "--env") {
        const [name, ...value] = String(options[++index]).split("=");
        env[name] = value.join("=");
      } else throw new Error(`launch: unknown option ${options[index]}`);
    }
    const spec = await isolatedLaunchSpec({ root, packagedExecutable, appArgs, env });
    const startedAt = new Date().toISOString();
    const result = await runSpec(spec, { timeoutMs: 24 * 60 * 60 * 1000 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    await writeFile(path.join(spec.root, "evidence", `launch-${Date.now()}.json`), `${JSON.stringify({ startedAt, endedAt: new Date().toISOString(), executable: spec.executable, args: spec.args, exitCode: result.code, signal: result.signal }, null, 2)}\n`, "utf8");
    return result.code ?? 1;
  }
  if (command === "inventory") {
    const [directory, out, flag] = rest;
    if (!path.isAbsolute(directory ?? "") || !path.isAbsolute(out ?? "")) throw new Error("inventory: absolute directory and output paths are required.");
    const relative = path.relative(path.resolve(directory), path.resolve(out));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("inventory: the output file must be outside the inventoried directory.");
    await writeFile(out, `${JSON.stringify(await inventoryTree(directory, { allowMissing: flag === "--allow-missing" }), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return 0;
  }
  if (command === "audit") {
    const [out, ...specs] = rest;
    const entries = specs.map((spec) => {
      const separator = spec.indexOf("=");
      const label = spec.slice(0, separator);
      const remainder = spec.slice(separator + 1);
      const namesAt = remainder.lastIndexOf(":");
      const hasNames = namesAt > 2;
      return { label, location: hasNames ? remainder.slice(0, namesAt) : remainder, names: hasNames ? remainder.slice(namesAt + 1).split("|") : [] };
    });
    await writeFile(out, `${JSON.stringify(await auditLocations(entries), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return 0;
  }
  process.stderr.write("usage: e2e-isolation-harness.mjs prepare|launch|inventory|audit ...\n");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`e2e-isolation-harness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
