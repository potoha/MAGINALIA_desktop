/**
 * Cross-process Private Shelf writer evidence.
 *
 * Every assertion here involves a real OS child process writing to an isolated
 * fixture Shelf under the OS temporary directory. This proves exclusion,
 * idempotency, interrupted-write recovery, receipt durability and path-swap
 * refusal between processes; it does not prove Desktop UI or Native Messaging
 * Host integration, which remain unenabled and NOT VERIFIED.
 *
 * Requires `dist/main/shelf-write-coordination.js` (run `npm run build:main`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShelfFixture, listJsonFiles, readJsonFiles } from "./shelf-write-fixture.mjs";

const worker = fileURLToPath(new URL("./collector-shelf-write-worker.mjs", import.meta.url));
const format = await import("@maginalia/format");

async function runWorker(command) {
  const file = path.join(os.tmpdir(), `maginalia-cmd-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(command), "utf8");
  const child = spawn(process.execPath, [worker, file], { stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await rm(file, { force: true });
  const lines = Buffer.concat(out).toString("utf8").trim().split(/\r?\n/u).filter((line) => line.length > 0);
  const last = lines.length === 0 ? undefined : JSON.parse(lines[lines.length - 1]);
  return { code, result: last, stderr: Buffer.concat(err).toString("utf8") };
}

function baseCommand(fixture, overrides = {}) {
  return {
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    requestId: `req-${randomUUID()}`,
    quote: "引用された本文テキスト。",
    url: "https://example.test/article?id=1",
    getDate: "202610301200",
    comment: "確認用のメモ",
    processLabel: "poc-worker",
    acquireTimeoutMs: 30_000,
    ...overrides
  };
}

async function journalDirectory(fixture) {
  return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase(), "requests");
}

function leaseFilePath(fixture) {
  return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase(), "writer.lock");
}

/**
 * Spawn a worker and expose its stdout lines incrementally, so a test can act while
 * the child is still running (for example while it holds the write lease).
 */
async function startWorker(command) {
  const file = path.join(os.tmpdir(), `maginalia-cmd-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(command), "utf8");
  const child = spawn(process.execPath, [worker, file], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const waiters = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const text = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (text.length === 0) continue;
      lines.push(JSON.parse(text));
      for (const waiter of [...waiters]) waiter();
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return {
    child,
    lines,
    closed,
    waitForLine(predicate, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const stopWaiting = () => {
          clearTimeout(timer);
          const index = waiters.indexOf(check);
          if (index >= 0) waiters.splice(index, 1);
        };
        const check = () => {
          const found = lines.find(predicate);
          if (found === undefined) return;
          stopWaiting();
          resolve(found);
        };
        const timer = setTimeout(() => {
          stopWaiting();
          reject(new Error(`timed out waiting for worker output; saw ${JSON.stringify(lines)}`));
        }, timeoutMs);
        waiters.push(check);
        check();
      });
    },
    async cleanup() {
      await rm(file, { force: true });
    }
  };
}

test("concurrent processes reuse one Book and append every Annotation without loss", async () => {
  const fixture = await createShelfFixture("concurrent");
  try {
    const commands = Array.from({ length: 6 }, (_unused, index) => baseCommand(fixture, {
      requestId: `req-concurrent-${index}-${randomUUID()}`,
      quote: `並行書込の引用 ${index}`
    }));
    const results = await Promise.all(commands.map((command) => runWorker(command)));
    for (const result of results) {
      assert.equal(result.code, 0, `${JSON.stringify(result.result)} ${result.stderr}`);
      assert.equal(result.result.ok, true);
    }
    const books = await readJsonFiles(fixture.booksDirectory);
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(books.length, 1, "exactly one Book is created for one source URL");
    assert.equal(annotations.length, 6, "every concurrent request produced its own Annotation");
    const bookId = books[0].id;
    for (const annotation of annotations) assert.equal(annotation.source.id, bookId);
    assert.equal(new Set(results.map((result) => result.result.receipt.annotationId)).size, 6);
    // Canonical Shelf v0.4 validation of what real processes left on disk.
    for (const book of books) {
      const validated = format.parseShelfEntity("book", JSON.stringify(book));
      assert.equal(validated.valid, true, JSON.stringify(validated));
      assert.equal(validated.value.version, "0.4");
    }
    for (const annotation of annotations) {
      const validated = format.parseShelfEntity("annotation", JSON.stringify(annotation));
      assert.equal(validated.valid, true, JSON.stringify(validated));
      assert.equal(validated.value.source.kind, "website");
      assert.equal(validated.value.quote.length > 0, true);
      assert.match(validated.value.get.date, /^[0-9]{12}$/u);
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("the same request ID sent concurrently from four processes commits exactly once", async () => {
  const fixture = await createShelfFixture("idempotent");
  try {
    const requestId = `req-idempotent-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 4 }, () => runWorker(baseCommand(fixture, { requestId }))));
    for (const result of results) {
      assert.equal(result.code, 0, `${JSON.stringify(result.result)} ${result.stderr}`);
      assert.equal(result.result.ok, true);
    }
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(annotations.length, 1, "retries never append a second Annotation");
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    const states = results.map((result) => result.result.receipt.state).sort();
    assert.deepEqual(states, ["already-committed", "already-committed", "already-committed", "committed"]);
    const ids = new Set(results.map((result) => result.result.receipt.annotationId));
    assert.equal(ids.size, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a process killed between Book and Annotation publish is recovered by the retry", async () => {
  const fixture = await createShelfFixture("crash");
  try {
    const requestId = `req-crash-${randomUUID()}`;
    const crashed = await runWorker(baseCommand(fixture, { requestId, crashAfterBook: true }));
    assert.equal(crashed.code, 70, JSON.stringify(crashed.result));
    assert.equal(crashed.result.code, "simulated-crash");
    const booksAfterCrash = await readJsonFiles(fixture.booksDirectory);
    assert.equal(booksAfterCrash.length, 1, "the add-only Book survived the crash");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0, "no partial Annotation exists");
    const staged = await readJsonFiles(await journalDirectory(fixture));
    assert.equal(staged.length, 1);
    assert.equal(staged[0].state, "staged");
    assert.equal(staged[0].bookId, booksAfterCrash[0].id);

    // The crashed process left its lease file behind; the retry must take it over.
    const retried = await runWorker(baseCommand(fixture, { requestId }));
    assert.equal(retried.code, 0, `${JSON.stringify(retried.result)} ${retried.stderr}`);
    assert.equal(retried.result.receipt.state, "committed");
    assert.equal(retried.result.receipt.bookId, booksAfterCrash[0].id, "the existing Book is reused, not duplicated");
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].id, staged[0].annotationId, "the staged Annotation ID is reused");
    const committed = await readJsonFiles(await journalDirectory(fixture));
    assert.equal(committed[0].state, "committed");
    assert.equal(committed[0].annotationId, annotations[0].id);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a committed receipt stays durable for a fresh process", async () => {
  const fixture = await createShelfFixture("receipt");
  try {
    const requestId = `req-receipt-${randomUUID()}`;
    const first = await runWorker(baseCommand(fixture, { requestId }));
    assert.equal(first.code, 0, `${JSON.stringify(first.result)} ${first.stderr}`);
    const annotationPath = path.join(fixture.annotationsDirectory, `${first.result.receipt.annotationId.replace(":", "-")}.json`);
    const before = await readFile(annotationPath, "utf8");
    const second = await runWorker(baseCommand(fixture, { requestId }));
    assert.equal(second.code, 0, `${JSON.stringify(second.result)} ${second.stderr}`);
    assert.equal(second.result.receipt.state, "already-committed");
    assert.equal(second.result.receipt.annotationId, first.result.receipt.annotationId);
    assert.equal(second.result.receipt.recordedAt, first.result.receipt.recordedAt);
    assert.equal(await readFile(annotationPath, "utf8"), before, "the Acknowledgement is derived from durable state, not a rewrite");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("reusing a request ID with different content is refused and writes nothing", async () => {
  const fixture = await createShelfFixture("mismatch");
  try {
    const requestId = `req-mismatch-${randomUUID()}`;
    assert.equal((await runWorker(baseCommand(fixture, { requestId }))).code, 0);
    const countBefore = (await listJsonFiles(fixture.annotationsDirectory)).length;
    const conflicting = await runWorker(baseCommand(fixture, { requestId, quote: "異なる本文" }));
    assert.equal(conflicting.code, 3);
    assert.equal(conflicting.result.code, "shelf-write-request-mismatch");
    // A different comment field changes the persisted bytes, so it is different
    // content under the same request ID, not a retry.
    const commentFieldConflict = await runWorker(baseCommand(fixture, { requestId, commentField: "privateMemo" }));
    assert.equal(commentFieldConflict.code, 3);
    assert.equal(commentFieldConflict.result.code, "shelf-write-request-mismatch");
    assert.equal((await listJsonFiles(fixture.annotationsDirectory)).length, countBefore);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a live holder keeps its lease even when its heartbeat looks stale", async () => {
  const fixture = await createShelfFixture("live-holder");
  const holder = await startWorker(baseCommand(fixture, {
    holdLeaseMs: 3_000,
    leaseTtlMs: 50,
    acquireTimeoutMs: 5_000
  }));
  try {
    const acquired = await holder.waitForLine((line) => line.acquired === true);
    assert.equal(typeof acquired.pid, "number");
    // Let the holder's acquisition-time heartbeat age past the contender's
    // threshold. A TTL-only implementation would steal the lease here.
    await new Promise((resolve) => { setTimeout(resolve, 250); });

    const contender = await runWorker(baseCommand(fixture, { leaseTtlMs: 50, acquireTimeoutMs: 400 }));
    assert.equal(contender.code, 3, `${JSON.stringify(contender.result)} ${contender.stderr}`);
    assert.equal(contender.result.code, "shelf-write-lease-uncertain");

    // The holder's lease file is byte-identical in identity: still the same PID.
    const lock = JSON.parse(await readFile(leaseFilePath(fixture), "utf8"));
    assert.equal(lock.pid, acquired.pid);

    const finished = await holder.waitForLine((line) => line.assertedHeld !== undefined);
    assert.equal(finished.assertedHeld, true, "the live holder never lost its lease");
    assert.equal(await holder.closed, 0);
    assert.equal((await listJsonFiles(fixture.annotationsDirectory)).length, 0, "no writer committed");

    const after = await runWorker(baseCommand(fixture));
    assert.equal(after.code, 0, `${JSON.stringify(after.result)} ${after.stderr}`);
    assert.equal((await listJsonFiles(fixture.annotationsDirectory)).length, 1);
  } finally {
    holder.child.kill();
    await holder.cleanup();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a corrupted journal is refused by a fresh process", async () => {
  const fixture = await createShelfFixture("corrupt-journal");
  try {
    const requestId = `req-corrupt-${randomUUID()}`;
    const first = await runWorker(baseCommand(fixture, { requestId }));
    assert.equal(first.code, 0, `${JSON.stringify(first.result)} ${first.stderr}`);

    const journalFile = path.join(await journalDirectory(fixture), `${requestId}.json`);
    const record = JSON.parse(await readFile(journalFile, "utf8"));
    await writeFile(journalFile, `${JSON.stringify({ ...record, annotationId: "../../escape" }, null, 2)}\n`, "utf8");

    const retried = await runWorker(baseCommand(fixture, { requestId }));
    assert.equal(retried.code, 3, `${JSON.stringify(retried.result)} ${retried.stderr}`);
    assert.equal(retried.result.code, "shelf-write-journal-invalid");
    assert.equal((await listJsonFiles(fixture.annotationsDirectory)).length, 1, "nothing new was written");
    await assert.rejects(readFile(path.join(fixture.shelfRoot, "escape.json"), "utf8"));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a Shelf identity mismatch fails closed without touching the Shelf", async () => {
  const fixture = await createShelfFixture("identity");
  try {
    const result = await runWorker(baseCommand(fixture, { expectedShelfId: randomUUID() }));
    assert.equal(result.code, 3);
    assert.equal(result.result.code, "shelf-write-identity-mismatch");
    assert.equal((await listJsonFiles(fixture.booksDirectory)).length, 0);
    assert.equal((await listJsonFiles(fixture.annotationsDirectory)).length, 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a record directory replaced by a junction before the write is refused", async () => {
  const fixture = await createShelfFixture("junction");
  try {
    const outside = path.join(fixture.base, "outside");
    await mkdir(outside, { recursive: true });
    await rename(fixture.annotationsDirectory, `${fixture.annotationsDirectory}.moved`);
    await symlink(outside, fixture.annotationsDirectory, "junction");
    const result = await runWorker(baseCommand(fixture));
    assert.equal(result.code, 3, `${JSON.stringify(result.result)} ${result.stderr}`);
    assert.equal(result.result.code, "shelf-write-layout-invalid");
    assert.deepEqual(await readdir(outside), [], "nothing is written outside the Shelf");
    assert.equal((await listJsonFiles(fixture.booksDirectory)).length, 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a record directory swapped for a junction mid-write is refused before the commit point", async () => {
  const fixture = await createShelfFixture("swap");
  try {
    const outside = path.join(fixture.base, "outside-swap");
    await mkdir(outside, { recursive: true });
    const result = await runWorker(baseCommand(fixture, {
      annotationsPath: fixture.annotationsDirectory,
      swapAnnotationsTo: outside
    }));
    assert.equal(result.code, 3, `${JSON.stringify(result.result)} ${result.stderr}`);
    assert.equal(result.result.code, "shelf-write-unsafe-path");
    assert.deepEqual(await readdir(outside), [], "no Annotation is written through the junction");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a coordination root inside the Shelf is refused", async () => {
  const fixture = await createShelfFixture("overlap");
  try {
    const result = await runWorker(baseCommand(fixture, {
      coordinationRoot: path.join(fixture.shelfRoot, "coordination")
    }));
    assert.equal(result.code, 3);
    assert.equal(result.result.code, "shelf-write-unsafe-path");
    assert.equal((await listJsonFiles(fixture.annotationsDirectory)).length, 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
