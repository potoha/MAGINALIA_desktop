import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateShelfEntity } from "@maginalia/format";

const host = fileURLToPath(new URL("../dist/main/collector-native-host.js", import.meta.url));
const protocol = "maginalia.collector.experimental.v1";
const origin = `chrome-extension://${"a".repeat(32)}/`;
const id = "750e8400-e29b-41d4-a716-446655440000";
function frame(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function request(operation) { return frame(Buffer.from(JSON.stringify({ protocol, operation }))); }
function saveRequest(requestId) {
  return frame(Buffer.from(JSON.stringify({
    protocol, operation: "save_web_quote", requestId, quote: "Selected test quotation",
    url: "https://example.com/", getDate: "202611031200", title: "Sample Page"
  })));
}
async function run(descriptor, chunks, caller = origin, extraEnv = {}) {
  const child = spawn(process.execPath, [host, caller], {
    cwd: path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), ".."),
    env: { ...process.env, ...extraEnv, MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR: descriptor }
  });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const finished = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve(code)); });
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  assert.equal(await finished, 0, Buffer.concat(errors).toString());
  const bytes = Buffer.concat(output);
  const values = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(bytes.length >= offset + 4);
    const size = bytes.readUInt32LE(offset);
    assert.ok(size <= 1024 * 1024 && bytes.length >= offset + 4 + size);
    values.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + size).toString("utf8")));
    offset += 4 + size;
  }
  return values;
}

test("real host validates frames, caller and configured Shelf identity without writes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-日本語-"));
  try {
    const shelf = path.join(temp, "本棚");
    await mkdir(shelf);
    const marker = path.join(shelf, "名前変更.magi");
    const markerText = `version = 1\ntype = shelf\nid = ${id}\n`;
    await writeFile(marker, markerText);
    await writeFile(path.join(shelf, "library.json"), JSON.stringify({ type: "library", version: "0.1", name: "研究棚" }));
    const registry = path.join(temp, "shelf_location.yml");
    await writeFile(registry, `version: 1\nprivate_shelf:\n  registry: ${JSON.stringify(shelf)}\npublic_shelf:\n  registry: null\n`);
    const config = path.join(temp, "descriptor.json");
    await writeFile(config, JSON.stringify({ experimental: true, shelfLocationPath: registry, expectedShelfId: id, allowedOrigin: origin }));
    const first = request("health");
    const results = await run(config, [first.subarray(0, 2), first.subarray(2), request("configured_shelf")]);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].writesEnabled, false);
    assert.deepEqual(results[1].shelf, { id, name: "研究棚", type: "private", writesEnabled: false });
    assert.equal(JSON.stringify(results).includes(temp), false);
    assert.equal((await run(config, [request("health")], `chrome-extension://${"b".repeat(32)}/`))[0].error, "host_configuration_or_origin_invalid");
    assert.equal((await run(config, [request("save")]))[0].error, "unsupported_operation");
    assert.equal((await run(config, [frame(Buffer.from(JSON.stringify({ protocol, operation: "health", extra: true })))]))[0].error, "invalid_request");
    assert.equal((await run(config, [frame(Buffer.from(JSON.stringify({ protocol: "other", operation: "health" })))]))[0].error, "invalid_request");
    assert.equal((await run(config, [frame(Buffer.from([0xff]))]))[0].error, "invalid_json");
    assert.equal((await run(config, [Buffer.from([1, 0])]))[0].error, "truncated_frame");
    assert.equal((await run(config, [Buffer.from([1, 0, 1, 0])]))[0].error, "invalid_frame_length");
    await writeFile(config, JSON.stringify({ experimental: true, shelfLocationPath: registry, expectedShelfId: "850e8400-e29b-41d4-a716-446655440000", allowedOrigin: origin }));
    assert.equal((await run(config, [request("configured_shelf")]))[0].error, "shelf_identity_mismatch");
    await writeFile(config, JSON.stringify({ experimental: true, shelfLocationPath: registry, expectedShelfId: id, allowedOrigin: origin }));
    await writeFile(path.join(shelf, "conflict.magi"), `version = 1\ntype = shelf\nid = 850e8400-e29b-41d4-a716-446655440000\n`);
    assert.equal((await run(config, [request("configured_shelf")]))[0].error, "shelf_identity_unavailable");
    assert.equal(await readFile(marker, "utf8"), markerText);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("test-only Host recovers an interrupted v0.4 write and makes the same request idempotent", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-write-日本語-"));
  try {
    const shelf = path.join(temp, "本棚");
    const books = path.join(shelf, "books");
    const annotations = path.join(shelf, "annotations");
    const coordinationRoot = path.join(temp, "isolated-coordination");
    await mkdir(books, { recursive: true });
    await mkdir(annotations, { recursive: true });
    await mkdir(coordinationRoot, { recursive: true });
    await writeFile(path.join(shelf, "shelf.magi"), `version = 1\ntype = shelf\nid = ${id}\n`);
    const libraryText = JSON.stringify({ type: "library", version: "0.1", name: "Disposable Shelf", booksPath: "books", annotationsPath: "annotations" }, null, 2) + "\n";
    await writeFile(path.join(shelf, "library.json"), libraryText);
    const registry = path.join(temp, "test-shelf_location.yml");
    await writeFile(registry, `version: 1\nprivate_shelf:\n  registry: ${JSON.stringify(shelf)}\n  urls:\n    github: null\n    homepage: null\n    other: []\npublic_shelf:\n  registry: null\n  urls:\n    github: null\n    homepage: null\n    other: []\n`);
    const config = path.join(temp, "descriptor.json");
    await writeFile(config, JSON.stringify({
      experimental: true, shelfLocationPath: registry, expectedShelfId: id, allowedOrigin: origin,
      testOnlyWritesEnabled: true, coordinationRoot
    }));
    const requestId = "00000000-0000-4000-8000-000000000010";
    const testEnv = {
      MAGINALIA_COLLECTOR_TEST_ONLY: "1",
      MAGINALIA_COLLECTOR_TEST_RECOVERY_PROBE_ONCE: "1"
    };

    const interrupted = (await run(config, [saveRequest(requestId)], origin, testEnv))[0];
    assert.deepEqual(interrupted, { protocol, ok: false, error: "save_failed" });
    assert.equal(await readFile(path.join(shelf, "library.json"), "utf8"), libraryText);
    assert.equal((await readdir(books)).length, 1);
    assert.equal((await readdir(annotations)).length, 0);
    const coordinationDirectory = path.join(coordinationRoot, "shelves", id);
    assert.equal(JSON.parse(await readFile(path.join(coordinationDirectory, "writer-recovery.json"), "utf8")).requestId, requestId);

    const recovered = (await run(config, [saveRequest(requestId)], origin, testEnv))[0];
    assert.equal(recovered.ok, true);
    assert.equal(recovered.receipt.state, "committed");
    assert.equal(recovered.receipt.requestId, requestId);
    assert.equal(recovered.receipt.shelfId, id);
    await assert.rejects(readFile(path.join(coordinationDirectory, "writer-recovery.json")), { code: "ENOENT" });

    const duplicate = (await run(config, [saveRequest(requestId)], origin, testEnv))[0];
    assert.equal(duplicate.receipt.state, "already-committed");
    assert.equal(duplicate.receipt.annotationId, recovered.receipt.annotationId);
    assert.equal(duplicate.receipt.requestDigest, recovered.receipt.requestDigest);
    const bookFiles = await readdir(books);
    const annotationFiles = await readdir(annotations);
    assert.equal(bookFiles.length, 1);
    assert.equal(annotationFiles.length, 1);

    const book = JSON.parse(await readFile(path.join(books, bookFiles[0]), "utf8"));
    const annotation = JSON.parse(await readFile(path.join(annotations, annotationFiles[0]), "utf8"));
    assert.equal(validateShelfEntity("book", book).valid, true);
    assert.equal(validateShelfEntity("annotation", annotation).valid, true);
    assert.equal(book.version, "0.4");
    assert.equal(annotation.version, "0.4");
    assert.equal(annotation.quote, "Selected test quotation");
    assert.equal(annotation.url, "https://example.com/");
    assert.equal(annotation.source.id, book.id);

    const { inspectShelfWriteJournal } = await import("../dist/main/shelf-write-coordination.js");
    const journal = await inspectShelfWriteJournal({ shelfRoot: shelf, expectedShelfId: id, coordinationRoot });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].record.state, "committed");
    assert.equal(journal[0].matchesDisk, true);
    assert.equal(JSON.stringify({ recovered, duplicate }).includes(temp), false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
