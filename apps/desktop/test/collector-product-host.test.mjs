import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const main = path.join(desktop, "dist", "main");
const productEntry = path.join(main, "collector-native-host-product-entry.js");
const harness = path.join(here, "collector-product-host-harness.mjs");
const nativeMutex = require(path.join(main, "shelf-native-mutex.js"));
const binding = require(path.join(main, "shelf-binding.js"));
const bindingStore = require(path.join(main, "shelf-binding-store.js"));

const protocol = "maginalia.collector.experimental.v1";
const origin = "chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/";
const id = "750e8400-e29b-41d4-a716-446655440000";

function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
const op = (operation) => frame({ protocol, operation });
const save = (requestId) => frame({
  protocol, operation: "save_web_quote", requestId, quote: "Selected test quotation",
  url: "https://example.com/", getDate: "202611121200", title: "Sample Page"
});

async function runProcess(args, chunks, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: desktop, env });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const finished = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  const code = await finished;
  const stderr = Buffer.concat(errors).toString();
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "", "the Host writes nothing to stderr on handled requests");
  const bytes = Buffer.concat(output);
  const values = [];
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset);
    assert.ok(size <= 1024 * 1024 && bytes.length >= offset + 4 + size, "stdout carries only complete frames");
    values.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + size).toString("utf8")));
    offset += 4 + size;
  }
  return values;
}

async function exists(file) {
  try { await lstat(file); return true; } catch { return false; }
}

test("production entry ignores env/cwd/descriptor input and fails closed without a binding", async (t) => {
  const localAppData = nativeMutex.getNativeLocalAppDataPath();
  const applicationRoot = path.join(localAppData, "MAGINALIA");
  if (await exists(path.join(applicationRoot, "integration", "private-shelf-binding.json"))) {
    t.skip("a real Collector binding exists on this machine; the unconfigured case cannot be asserted");
    return;
  }
  const rootBefore = await exists(applicationRoot);
  const temp = await mkdtemp(path.join(os.tmpdir(), "collector-product-entry-"));
  try {
    // A fully valid dev/test-only descriptor and gate in the environment must have no effect.
    const descriptor = path.join(temp, "descriptor.json");
    await writeFile(descriptor, JSON.stringify({
      experimental: true, shelfLocationPath: path.join(temp, "shelf_location.yml"), expectedShelfId: id,
      allowedOrigin: origin, testOnlyWritesEnabled: true, coordinationRoot: path.join(temp, "coordination")
    }));
    const env = {
      ...process.env,
      MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR: descriptor,
      MAGINALIA_COLLECTOR_TEST_ONLY: "1",
      MAGINALIA_SHELF_MUTEX_PATH: path.join(temp, "missing.node"),
      LOCALAPPDATA: temp
    };
    const health = op("health");
    const results = await runProcess([productEntry, origin, "--parent-window=0"],
      [health.subarray(0, 3), health.subarray(3), op("configured_shelf"), save("00000000-0000-4000-8000-0000000000b1")], env);
    assert.deepEqual(results, [
      { protocol, ok: true, experimental: true, operations: ["health", "configured_shelf", "host_info"], writesEnabled: false },
      { protocol, ok: false, error: "shelf_unconfigured" },
      { protocol, ok: false, error: "shelf_unconfigured" }
    ]);
    assert.deepEqual(await runProcess([productEntry, `chrome-extension://${"a".repeat(32)}/`], [op("health")], env),
      [{ protocol, ok: false, error: "host_configuration_or_origin_invalid" }]);
    assert.deepEqual(await runProcess([productEntry], [op("health")], env),
      [{ protocol, ok: false, error: "host_configuration_or_origin_invalid" }]);
    assert.deepEqual(await runProcess([productEntry, origin], [frame(Buffer.from([0xff]))], env), [{ protocol, ok: false, error: "invalid_json" }]);
    assert.deepEqual(await runProcess([productEntry, origin], [Buffer.from([1, 0])], env), [{ protocol, ok: false, error: "truncated_frame" }]);
    assert.deepEqual(await runProcess([productEntry, origin], [Buffer.from([1, 0, 1, 0])], env), [{ protocol, ok: false, error: "invalid_frame_length" }]);
    assert.deepEqual(await readdir(temp), ["descriptor.json"], "nothing is created from env-supplied locations");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  assert.equal(await exists(applicationRoot), rootBefore, "the real MAGINALIA LocalAppData root is not created");
});

async function createBoundFixture(name) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), `collector-product-${name}-日本語-`)));
  const localAppData = path.join(temp, "Local");
  await mkdir(localAppData);
  const shelf = path.join(temp, "本棚");
  await mkdir(path.join(shelf, "books"), { recursive: true });
  await mkdir(path.join(shelf, "annotations"), { recursive: true });
  await writeFile(path.join(shelf, "shelf.magi"), `version = 1\ntype = shelf\nid = ${id}\n`);
  await writeFile(path.join(shelf, "library.json"), JSON.stringify({ type: "library", version: "0.1", name: "Disposable Shelf", booksPath: "books", annotationsPath: "annotations" }));
  const roaming = path.join(temp, "Roaming");
  await mkdir(roaming);
  const shelfLocationPath = path.join(roaming, "shelf_location.yml");
  await writeFile(shelfLocationPath, `version: 1\nprivate_shelf:\n  registry: ${JSON.stringify(shelf)}\npublic_shelf:\n  registry: null\n`);
  const paths = bindingStore.resolveShelfBindingStoragePaths(localAppData);
  const store = bindingStore.createShelfBindingFileStore(paths.bindingDirectory, {
    createDirectory: async (directory) => { nativeMutex.createNativePrivateDirectory(directory); }
  });
  const created = binding.createShelfBindingFromConfirmedSelection({
    shelfLocationPath, privateShelfLocator: shelf, confirmedMarker: { version: 1, type: "shelf", id }
  });
  assert.equal(created.kind, "valid");
  assert.equal((await binding.persistShelfBinding(store, created.binding, null)).kind, "valid");
  const commandFile = path.join(temp, "harness.json");
  await writeFile(commandFile, JSON.stringify({ localAppData, origin, acquireTimeoutMs: 600 }));
  return { temp, shelf, paths, commandFile };
}

test("product core in a real process commits, replays idempotently and reports busy", async () => {
  const fixture = await createBoundFixture("write");
  try {
    const first = await runProcess([harness, fixture.commandFile], [op("health"), op("configured_shelf"), save("00000000-0000-4000-8000-0000000000c1")]);
    assert.deepEqual(first[0].operations, ["health", "configured_shelf", "save_web_quote", "host_info"]);
    assert.equal(first[0].writesEnabled, true);
    assert.deepEqual(first[1].shelf, { id, name: "Disposable Shelf", type: "private", writesEnabled: true });
    assert.equal(first[2].ok, true);
    assert.equal(first[2].receipt.state, "committed");
    const coordination = path.join(fixture.paths.coordinationRoot, "shelves", id);
    assert.equal((await readdir(coordination)).includes("writer-recovery.json"), false);

    const resend = await runProcess([harness, fixture.commandFile], [save("00000000-0000-4000-8000-0000000000c1")]);
    assert.equal(resend[0].receipt.state, "already-committed");
    assert.equal(resend[0].receipt.annotationId, first[2].receipt.annotationId);
    assert.equal((await readdir(path.join(fixture.shelf, "annotations"))).length, 1);

    // Another process holds the Shelf mutex: the Host answers shelf_write_busy and writes nothing.
    const holderScript = `const m=require(${JSON.stringify(path.join(main, "shelf-native-mutex.js"))});`
      + `m.acquireShelfMutex({shelfId:${JSON.stringify(id)}}).then((l)=>{process.stdout.write("held\\n");`
      + `setTimeout(()=>{l.release();process.exit(0);},4000);});`;
    const holder = spawn(process.execPath, ["-e", holderScript], { cwd: desktop });
    await new Promise((resolve, reject) => {
      holder.stdout.on("data", (chunk) => { if (chunk.toString().includes("held")) resolve(); });
      holder.on("error", reject);
      holder.on("exit", (code) => reject(new Error(`holder exited ${code}`)));
    });
    try {
      const busy = await runProcess([harness, fixture.commandFile], [save("00000000-0000-4000-8000-0000000000c2")]);
      assert.deepEqual(busy, [{ protocol, ok: false, error: "shelf_write_busy" }]);
      assert.equal((await readdir(path.join(fixture.shelf, "annotations"))).length, 1);
    } finally {
      await new Promise((resolve) => { if (holder.exitCode !== null) resolve(); else holder.on("close", resolve); });
    }
    const after = await runProcess([harness, fixture.commandFile], [save("00000000-0000-4000-8000-0000000000c2")]);
    assert.equal(after[0].receipt.state, "committed");
    assert.equal((await readdir(path.join(fixture.shelf, "annotations"))).length, 2);
    const serialized = JSON.stringify([first, resend, after]);
    assert.equal(serialized.includes(fixture.temp), false);
    assert.equal(serialized.includes("Selected test quotation"), false, "receipts never echo quote text");
  } finally {
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("product core in a real process fails closed for an unsafe binding ACL and a mismatched marker", async () => {
  const fixture = await createBoundFixture("unsafe");
  try {
    await writeFile(path.join(fixture.shelf, "shelf.magi"), "version = 1\ntype = shelf\nid = 850e8400-e29b-41d4-a716-446655440000\n");
    assert.deepEqual(await runProcess([harness, fixture.commandFile], [save("00000000-0000-4000-8000-0000000000d1")]),
      [{ protocol, ok: false, error: "shelf_identity_mismatch" }]);
    await writeFile(path.join(fixture.shelf, "shelf.magi"), `version = 1\ntype = shelf\nid = ${id}\n`);
    const { execFileSync } = await import("node:child_process");
    execFileSync("icacls", [fixture.paths.bindingPath, "/grant", "*S-1-1-0:(W)"], { stdio: "ignore" });
    assert.deepEqual(await runProcess([harness, fixture.commandFile], [op("health"), save("00000000-0000-4000-8000-0000000000d2")]), [
      { protocol, ok: true, experimental: true, operations: ["health", "configured_shelf", "host_info"], writesEnabled: false },
      { protocol, ok: false, error: "configuration_unavailable" }
    ]);
    assert.equal((await readdir(path.join(fixture.shelf, "annotations"))).length, 0);
    assert.equal(await readFile(path.join(fixture.shelf, "shelf.magi"), "utf8"), `version = 1\ntype = shelf\nid = ${id}\n`);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

const hostInfo = (extensionVersion) => frame({ protocol, operation: "host_info", extensionVersion });
const contactFiles = ["version", "protocol", "hostVersion", "extensionVersion", "contactedAt"];

test("host_info in a real process answers and writes the exact five-field contact record once per minute", async () => {
  const fixture = await createBoundFixture("contact");
  try {
    const recordPath = path.join(fixture.paths.bindingDirectory, "collector-contact.json");
    const first = await runProcess([harness, fixture.commandFile], [op("health"), hostInfo("0.3.0")]);
    assert.ok(first[0].operations.includes("host_info"));
    assert.deepEqual(Object.keys(first[1]), ["protocol", "ok", "host"]);
    assert.equal(first[1].ok, true);
    assert.deepEqual(Object.keys(first[1].host), ["version", "minimumExtensionVersion"]);
    const text = await readFile(recordPath, "utf8");
    const record = JSON.parse(text);
    assert.deepEqual(Object.keys(record), contactFiles);
    assert.equal(record.version, 1);
    assert.equal(record.protocol, protocol);
    assert.equal(record.hostVersion, first[1].host.version);
    assert.equal(record.extensionVersion, "0.3.0");
    assert.equal(new Date(record.contactedAt).toISOString(), record.contactedAt);
    assert.equal(text.includes(fixture.temp), false);
    assert.equal(text.includes(id), false, "no Shelf UUID");
    assert.equal(JSON.stringify(first).includes(fixture.temp), false);
    assert.deepEqual((await readdir(fixture.paths.bindingDirectory)).sort(), ["collector-contact.json", "private-shelf-binding.json"]);

    // Same values within 60 s: the record is left untouched (a new process reads it back).
    const again = await runProcess([harness, fixture.commandFile], [hostInfo("0.3.0")]);
    assert.equal(again[0].ok, true);
    assert.equal(await readFile(recordPath, "utf8"), text);
    // A changed value is written at once.
    await runProcess([harness, fixture.commandFile], [hostInfo("0.3.1")]);
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).extensionVersion, "0.3.1");
    assert.deepEqual((await readdir(fixture.paths.bindingDirectory)).sort(), ["collector-contact.json", "private-shelf-binding.json"]);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("host_info validation and origin failures write nothing", async () => {
  const fixture = await createBoundFixture("contact-invalid");
  try {
    const recordPath = path.join(fixture.paths.bindingDirectory, "collector-contact.json");
    const bad = await runProcess([harness, fixture.commandFile], [
      hostInfo("not-a-version"),
      frame({ protocol, operation: "host_info", extensionVersion: "0.3.0", extra: true }),
      frame({ protocol, operation: "host_info" }),
    ]);
    assert.deepEqual(bad, Array(3).fill({ protocol, ok: false, error: "invalid_request" }));
    assert.equal(await exists(recordPath), false);

    const wrongCommand = path.join(fixture.temp, "wrong-origin.json");
    await writeFile(wrongCommand, JSON.stringify({ localAppData: path.join(fixture.temp, "Local"), origin: `chrome-extension://${"a".repeat(32)}/` }));
    assert.deepEqual(await runProcess([harness, wrongCommand], [hostInfo("0.3.0")]),
      [{ protocol, ok: false, error: "host_configuration_or_origin_invalid" }]);
    assert.equal(await exists(recordPath), false);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("host_info without an integration folder answers ok and creates nothing", async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "collector-product-contact-none-")));
  try {
    const localAppData = path.join(temp, "Local");
    await mkdir(localAppData);
    const commandFile = path.join(temp, "harness.json");
    await writeFile(commandFile, JSON.stringify({ localAppData, origin }));
    const values = await runProcess([harness, commandFile], [hostInfo("0.3.0"), op("health")]);
    assert.equal(values[0].ok, true);
    assert.equal(values[1].writesEnabled, false);
    assert.deepEqual(await readdir(localAppData), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("host_info skips the contact record when the integration folder ACL is weak, still answering ok", async () => {
  const fixture = await createBoundFixture("contact-acl");
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("icacls", [fixture.paths.bindingDirectory, "/grant", "*S-1-1-0:(W)"], { stdio: "ignore" });
    const values = await runProcess([harness, fixture.commandFile], [hostInfo("0.3.0")]);
    assert.equal(values[0].ok, true);
    assert.equal(await exists(path.join(fixture.paths.bindingDirectory, "collector-contact.json")), false);
    assert.deepEqual((await readdir(fixture.paths.bindingDirectory)).filter((name) => name !== "private-shelf-binding.json"), []);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("host_info refuses a non-regular or linked contact entry and leaves its target alone", async () => {
  const fixture = await createBoundFixture("contact-reparse");
  try {
    const recordPath = path.join(fixture.paths.bindingDirectory, "collector-contact.json");
    const target = path.join(fixture.temp, "link-target");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "keep");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, recordPath, "junction");
    const linked = await runProcess([harness, fixture.commandFile], [hostInfo("0.3.0")]);
    assert.equal(linked[0].ok, true);
    assert.deepEqual(await readdir(target), ["keep.txt"]);
    assert.equal((await lstat(recordPath)).isFile(), false);
    await rm(recordPath, { recursive: true, force: true });
    await mkdir(recordPath);
    const directory = await runProcess([harness, fixture.commandFile], [hostInfo("0.3.0")]);
    assert.equal(directory[0].ok, true);
    assert.deepEqual(await readdir(recordPath), []);
    assert.deepEqual((await readdir(fixture.paths.bindingDirectory)).sort(), ["collector-contact.json", "private-shelf-binding.json"]);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true });
  }
});
