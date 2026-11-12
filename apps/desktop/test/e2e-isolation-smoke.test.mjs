/**
 * Desktop #93 isolation harness acceptance with real Electron and the real
 * test-only Collector Host. Every write goes to a fresh temporary root.
 *
 * Covers: harness refusals (nothing spawned), in-app gate refusals with real
 * Electron (exit 78, no Desktop file written), the Collector-only scenario
 * (+1/+1) and the first-run scenario (tutorial +3/+3, Collector +1/+1).
 *
 * Requires `npm run build` (dist/main and renderer) and `npm run build:native`.
 * Set MAGINALIA_SMOKE_PACKAGED_EXECUTABLE to run the Electron cases against a
 * packaged `win-unpacked` executable instead of the development entry point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareInventories,
  desktopRoot,
  developmentElectron,
  developmentMain,
  inventoryTree,
  isolatedLaunchSpec,
  prepareIsolationRoot,
  runSpec,
} from "./e2e-isolation-harness.mjs";

const host = path.join(desktopRoot, "dist", "main", "collector-native-host.js");
const verifier = fileURLToPath(new URL("./collector-shelf-e2e-verify.mjs", import.meta.url));
const tutorialSeed = path.resolve(desktopRoot, "..", "..", "Tutorial_sample_setup", "private-shelf-seed");
const packagedExecutable = process.env.MAGINALIA_SMOKE_PACKAGED_EXECUTABLE || undefined;
const protocol = "maginalia.collector.experimental.v1";
const origin = `chrome-extension://${"a".repeat(32)}/`;
const quote = "Isolated E2E harness quotation";
const ISOLATION_EXIT = 78;

async function withBase(label, body) {
  // Canonical spelling: the verifier requires a Shelf root that equals its realpath.
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), `maginalia-e2e-${label}-日本語-`)));
  try {
    await body(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function runNode(args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: desktopRoot, env: { ...process.env, ...env } });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function collectorSave({ base, shelfLocationPath, expectedShelfId, coordinationRoot, requestId }) {
  const descriptorPath = path.join(base, "descriptor.json");
  await writeFile(descriptorPath, JSON.stringify({ experimental: true, shelfLocationPath, expectedShelfId, allowedOrigin: origin, testOnlyWritesEnabled: true, coordinationRoot }));
  const result = await runNode([host, origin], {
    env: { MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR: descriptorPath, MAGINALIA_COLLECTOR_TEST_ONLY: "1" },
    input: frame({ protocol, operation: "save_web_quote", requestId, quote, url: "https://example.com/", getDate: "202611131200", title: "Sample Page" }),
  });
  assert.equal(result.code, 0, result.stderr);
  const size = result.stdout.readUInt32LE(0);
  const response = JSON.parse(result.stdout.subarray(4, 4 + size).toString("utf8"));
  assert.equal(response.ok, true, JSON.stringify(response));
  return descriptorPath;
}

async function snapshotShelf(shelfRoot, out, allowMissing = false) {
  const result = await runNode([verifier, "snapshot", shelfRoot, out, ...(allowMissing ? ["--allow-missing"] : [])]);
  assert.equal(result.code, 0, result.stderr);
}

async function verify(args) {
  const result = await runNode([verifier, ...args]);
  return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
}

function electronDirect({ userData, env }) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const executable = packagedExecutable ?? developmentElectron;
  return runSpec({ executable, args: [`--user-data-dir=${userData}`, ...(packagedExecutable ? [] : [developmentMain]), "--smoke"], env: childEnv }, { timeoutMs: 60_000 });
}

test("the harness refuses to build a launch before anything is spawned", async () => {
  await withBase("refuse", async (base) => {
    const unmarked = path.join(base, "unmarked");
    await mkdir(unmarked);
    await assert.rejects(isolatedLaunchSpec({ root: unmarked }), /marker/u);
    await assert.rejects(isolatedLaunchSpec({ root: "relative-root" }), /absolute/u);
    const root = path.join(base, "root");
    await prepareIsolationRoot(root);
    await assert.rejects(prepareIsolationRoot(root), /refusing to adopt/u);
    await assert.rejects(isolatedLaunchSpec({ root, appArgs: [`--user-data-dir=${path.join(base, "elsewhere")}`] }), /--user-data-dir/u);
    await assert.rejects(isolatedLaunchSpec({ root, env: { MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS: path.join(os.homedir(), "Downloads") } }), /outside/u);
    await assert.rejects(isolatedLaunchSpec({ root, env: { MAGINALIA_FIRST_RUN_SMOKE_SHELF: `${root}${path.sep}..${path.sep}Shelf` } }), /parent-directory/u);
    const spec = await isolatedLaunchSpec({ root, appArgs: ["--smoke"] });
    assert.ok(spec.args[0].startsWith("--user-data-dir="));
    assert.equal(spec.env.MAGINALIA_E2E_ISOLATION_ROOT, spec.root);
  });
});

test("real Electron exits 78 before any Desktop write when userData or a smoke path is outside the root", async () => {
  await withBase("gate", async (base) => {
    const root = path.join(base, "root");
    await prepareIsolationRoot(root);
    const before = await inventoryTree(root);

    // The #93 first-launch failure: Electron did not get the isolated profile.
    // A sibling directory stands in for the real profile, which is never used.
    const outsideUserData = path.join(base, "outside-userData");
    const outside = await electronDirect({ userData: outsideUserData, env: { MAGINALIA_E2E_ISOLATION_ROOT: root } });
    assert.equal(outside.code, ISOLATION_EXIT, outside.stdout + outside.stderr);
    assert.match(outside.stderr, /MAGINALIA_E2E_ISOLATION_FAILED code=destination-outside-root/u);
    // Electron creates the --user-data-dir directory natively before main.js
    // runs; the gate guarantees no Desktop/application file is written there.
    assert.deepEqual((await inventoryTree(outsideUserData, { allowMissing: true })).files, []);

    const smokePath = await electronDirect({
      userData: path.join(root, "userData"),
      env: { MAGINALIA_E2E_ISOLATION_ROOT: root, MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS: path.join(base, "outside-downloads") },
    });
    assert.equal(smokePath.code, ISOLATION_EXIT, smokePath.stdout + smokePath.stderr);

    const unmarked = path.join(base, "unmarked");
    await mkdir(path.join(unmarked, "userData"), { recursive: true });
    const noMarker = await electronDirect({ userData: path.join(unmarked, "userData"), env: { MAGINALIA_E2E_ISOLATION_ROOT: unmarked } });
    assert.equal(noMarker.code, ISOLATION_EXIT);
    assert.match(noMarker.stderr, /root-marker-invalid/u);
    assert.deepEqual((await inventoryTree(path.join(unmarked, "userData"))).files, []);

    assert.deepEqual(compareInventories(before, await inventoryTree(root)), { added: [], removed: [], changed: [] });
  });
});

test("Collector-only scenario: isolated Desktop launch, then exactly +1 Book / +1 Annotation", async () => {
  await withBase("collector-only", async (base) => {
    const root = path.join(base, "root");
    await prepareIsolationRoot(root);
    const shelfId = "6f1c2a7e-93b0-4c1e-9a55-0d6e6c3f9301";
    const shelfRoot = path.join(root, "Shelf", "研究用本棚");
    await mkdir(path.join(shelfRoot, "books"), { recursive: true });
    await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
    await writeFile(path.join(shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${shelfId}\n`);
    await writeFile(path.join(shelfRoot, "library.json"), `${JSON.stringify({ type: "library", version: "0.1", name: "研究用本棚", booksPath: "books", annotationsPath: "annotations" }, null, 2)}\n`);
    const shelfLocationPath = path.join(root, "userData", "shelf_location.yml");
    await writeFile(shelfLocationPath, `version: 1\nprivate_shelf:\n  registry: ${JSON.stringify(shelfRoot)}\npublic_shelf:\n  registry: null\n`);

    const launch = await runSpec(await isolatedLaunchSpec({ root, packagedExecutable, appArgs: ["--smoke"] }), { timeoutMs: 90_000 });
    assert.equal(launch.code, 0, launch.stdout + launch.stderr);
    assert.match(launch.stdout, /MAGINALIA_E2E_ISOLATION_OK/u);
    assert.match(launch.stdout, /MAGINALIA_ELECTRON_SMOKE_OK/u);
    const evidence = (await readdir(path.join(root, "evidence"))).filter((name) => name.startsWith("startup-isolation-"));
    assert.equal(evidence.length, 1);
    const state = JSON.parse(await readFile(path.join(root, "evidence", evidence[0]), "utf8"));
    assert.equal(path.relative(state.root, state.downloads), "Downloads");
    assert.equal(path.relative(state.root, state.documents), "Documents");
    assert.equal(path.relative(state.root, state.userData), "userData");

    const baseline = path.join(root, "evidence", "pre-collector.json");
    await snapshotShelf(shelfRoot, baseline);
    const descriptor = await collectorSave({ base: root, shelfLocationPath, expectedShelfId: shelfId, coordinationRoot: path.join(root, "coordination"), requestId: "00000000-0000-4000-8000-000000000093" });
    const passed = await verify(["collector-only", "--descriptor", descriptor, "--baseline", baseline, "--expected-quote", quote]);
    assert.equal(passed.code, 0, passed.stderr);
    const result = JSON.parse(passed.stdout);
    assert.equal(result.status, "PASS");
    assert.equal(result.collector.addedBooks, 1);
    assert.equal(result.collector.addedAnnotations, 1);

    // The legacy positional form remains the Collector-only scenario.
    assert.equal((await verify([descriptor, baseline, quote])).code, 0);
    // Any extra file or changed existing file is a FAIL.
    await writeFile(path.join(shelfRoot, "books", "unexpected.txt"), "x");
    assert.equal((await verify(["collector-only", "--descriptor", descriptor, "--baseline", baseline, "--expected-quote", quote])).code, 1);
    await rm(path.join(shelfRoot, "books", "unexpected.txt"));
    await writeFile(path.join(shelfRoot, "library.json"), `${JSON.stringify({ type: "library", version: "0.1", name: "changed", booksPath: "books", annotationsPath: "annotations" }, null, 2)}\n`);
    assert.equal((await verify(["collector-only", "--descriptor", descriptor, "--baseline", baseline, "--expected-quote", quote])).code, 1);
  });
});

test("first-run scenario: tutorial +3/+3 inside the root, then Collector +1/+1, SHA-256 of prior files unchanged", { timeout: 300_000 }, async () => {
  await withBase("first-run", async (base) => {
    const root = path.join(base, "root");
    await prepareIsolationRoot(root);
    const workdeskRoot = path.join(root, "Documents", "MAGINALIA", "Workdesk");
    const shelfRoot = path.join(root, "Documents", "MAGINALIA", "Private Shelf");
    const preFirstRun = path.join(root, "evidence", "pre-first-run.json");
    await snapshotShelf(shelfRoot, preFirstRun, true);

    const launch = await runSpec(await isolatedLaunchSpec({
      root,
      packagedExecutable,
      appArgs: ["--first-run-smoke"],
      env: {
        MAGINALIA_FIRST_RUN_SMOKE_WORKDESK: workdeskRoot,
        MAGINALIA_FIRST_RUN_SMOKE_SHELF: shelfRoot,
        MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS: path.join(root, "Downloads"),
        MAGINALIA_FIRST_RUN_SMOKE_OUTPUT: path.join(root, "evidence"),
      },
    }), { timeoutMs: 180_000 });
    assert.equal(launch.code, 0, launch.stdout + launch.stderr);
    assert.match(launch.stdout, /MAGINALIA_FIRST_RUN_SMOKE_OK/u);
    assert.ok((await readdir(path.join(root, "Downloads"))).some((name) => name.startsWith("MAGINALIA_チュートリアル_宮沢賢治")), "tutorial image must land in the isolated Downloads");

    const marker = (await readdir(shelfRoot)).find((name) => name.toLowerCase().endsWith(".magi"));
    const shelfId = /^id = (.+)$/mu.exec(await readFile(path.join(shelfRoot, marker), "utf8"))[1].trim();
    const preCollector = path.join(root, "evidence", "pre-collector.json");
    await snapshotShelf(shelfRoot, preCollector);
    const descriptor = await collectorSave({
      base: root,
      shelfLocationPath: path.join(root, "userData", "shelf_location.yml"),
      expectedShelfId: shelfId,
      coordinationRoot: path.join(root, "coordination"),
      requestId: "00000000-0000-4000-8000-000000000094",
    });
    const passed = await verify(["first-run", "--descriptor", descriptor, "--baseline", preCollector, "--first-run-baseline", preFirstRun, "--tutorial-seed", tutorialSeed, "--expected-quote", quote]);
    assert.equal(passed.code, 0, passed.stderr);
    const result = JSON.parse(passed.stdout);
    assert.equal(result.tutorial.addedBooks, 3);
    assert.equal(result.tutorial.addedAnnotations, 3);
    assert.equal(result.collector.addedBooks, 1);
    assert.equal(result.collector.addedAnnotations, 1);
    // A first-run claim without the pre-first-run baseline is refused.
    assert.equal((await verify(["first-run", "--descriptor", descriptor, "--baseline", preCollector, "--expected-quote", quote])).code, 1);
  });
});
