/**
 * Cross-process evidence for the Windows named-mutex Shelf write lock (OD-10b spike).
 *
 * Every scenario here uses a real OS child process against an isolated fixture Shelf
 * under the OS temporary directory. Nothing touches a real user Shelf, the Desktop
 * product writer, the Native Messaging Host, or the machine-local Shelf registry.
 *
 * Proven here:
 *   - mutual exclusion between processes (no lost update, one Book per source);
 *   - a live holder cannot be displaced;
 *   - a force-killed holder leaves the lock abandoned, and the next writer refuses to
 *     write until the shared journal has been reconciled;
 *   - a crash between Book and Annotation is recovered by retrying the same request;
 *   - an exit while owning the lock (process.exit or an external kill) is recovered even
 *     when the mutex object is destroyed and no abandonment can be reported;
 *   - a damaged journal fails closed and nothing is written;
 *   - lock names are Shelf-scoped;
 *   - the mutex DACL refuses an account it does not grant.
 *
 * Requires `npm run build:main` and the built addon
 * (`native/shelf-mutex/build/Release/shelf_mutex.node`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShelfFixture, readJsonFiles } from "./shelf-write-fixture.mjs";

const worker = fileURLToPath(new URL("./collector-shelf-native-worker.mjs", import.meta.url));
const addonBinary = fileURLToPath(
  new URL("../native/shelf-mutex/build/Release/shelf_mutex.node", import.meta.url)
);
const requireNative = createRequire(import.meta.url);
const format = await import("@maginalia/format");

/**
 * File symlinks need Developer Mode or SeCreateSymbolicLinkPrivilege on Windows. Probe
 * once so the sentinel test is reported as skipped rather than silently passing.
 */
const symlinkSupport = await (async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-native-symlink-probe-"));
  try {
    const target = path.join(directory, "target.txt");
    await writeFile(target, "probe", "utf8");
    await symlink(target, path.join(directory, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();
if (!symlinkSupport) {
  console.warn(
    "NOT VERIFIED: this Windows account cannot create file symlinks (EPERM); " +
      "the real-process symlink-marker test is skipped. The junction case still runs."
  );
}

test("native addon resolves LocalAppData from the Windows known folder", () => {
  const native = requireNative(addonBinary);
  const localAppData = native.getLocalAppDataPath();
  assert.equal(typeof localAppData, "string");
  assert.match(localAppData, /^[A-Za-z]:\\/u);
  assert.equal(path.win32.normalize(localAppData), localAppData);
});

const symlinkTest = symlinkSupport ? test : test.skip;

function childEnvironment() {
  return { ...process.env, MAGINALIA_SHELF_MUTEX_PATH: addonBinary };
}

async function writeCommandFile(command) {
  const file = path.join(os.tmpdir(), `maginalia-native-cmd-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(command), "utf8");
  return file;
}

/** Run one child process to completion and return its structured output. */
async function runWorker(command, timeoutMs = 60_000) {
  const started = await startWorker(command);
  const timer = setTimeout(() => started.child.kill("SIGKILL"), timeoutMs);
  try {
    const code = await started.closed;
    return { code, lines: started.lines, result: started.lines.at(-1), stderr: started.stderr() };
  } finally {
    clearTimeout(timer);
    await started.cleanup();
  }
}

/**
 * Spawn a worker and expose its stdout lines incrementally, so a test can act while
 * the child is still running (while it holds the mutex, or after it published a Book).
 */
async function startWorker(command) {
  const file = await writeCommandFile(command);
  const child = spawn(process.execPath, [worker, file], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnvironment()
  });
  const lines = [];
  const waiters = [];
  const errorChunks = [];
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
  child.stderr.on("data", (chunk) => errorChunks.push(chunk));
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return {
    child,
    lines,
    closed,
    stderr: () => Buffer.concat(errorChunks).toString("utf8"),
    waitForLine(predicate, timeoutMs = 30_000) {
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

/** Start a participant that keeps a mutex handle open and never acquires it. */
async function startParticipant(fixture) {
  const participant = await startWorker({
    mode: "participant",
    expectedShelfId: fixture.shelfId
  });
  await participant.waitForLine((line) => line.ready === true);
  return participant;
}

/** Force-kill a child (TerminateProcess on Windows) and wait for it to be gone. */
async function forceKill(started) {
  started.child.kill("SIGKILL");
  await started.closed;
  await started.cleanup();
}

async function stopParticipant(participant) {
  if (participant === undefined) return;
  participant.child.kill("SIGKILL");
  await participant.closed;
  await participant.cleanup();
}

function baseCommand(fixture, overrides = {}) {
  return {
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    requestId: `req-${randomUUID()}`,
    quote: "ネイティブmutexで保存する引用。",
    url: "https://example.test/native-mutex?id=1",
    getDate: "202610311200",
    comment: "確認用のメモ",
    processLabel: "poc-native-worker",
    acquireTimeoutMs: 30_000,
    ...overrides
  };
}

function journalDirectory(fixture) {
  return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase(), "requests");
}

test("four processes doing twenty read-modify-writes each never lose an update", async () => {
  const fixture = await createShelfFixture("native-counter");
  try {
    const processes = Array.from({ length: 4 }, () =>
      runWorker({ ...baseCommand(fixture), mode: "counter", iterations: 20 }, 120_000)
    );
    const results = await Promise.all(processes);
    for (const result of results) {
      assert.equal(result.code, 0, `${JSON.stringify(result.result)} ${result.stderr}`);
      assert.equal(result.result.ok, true);
    }
    const counter = JSON.parse(await readFile(path.join(fixture.shelfRoot, "counter.json"), "utf8"));
    assert.equal(counter.value, 80, "20 read-modify-write cycles from 4 processes must total 80");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("six concurrent processes reuse one Book and append every Annotation", async () => {
  const fixture = await createShelfFixture("native-concurrent");
  try {
    const commands = Array.from({ length: 6 }, (_unused, index) =>
      baseCommand(fixture, {
        requestId: `req-native-concurrent-${index}-${randomUUID()}`,
        quote: `並行書込の引用 ${index}`
      })
    );
    const results = await Promise.all(commands.map((command) => runWorker(command)));
    for (const result of results) {
      assert.equal(result.code, 0, `${JSON.stringify(result.result)} ${result.stderr}`);
      assert.equal(result.result.ok, true);
    }
    const books = await readJsonFiles(fixture.booksDirectory);
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(books.length, 1, "exactly one Book is created for one source URL");
    assert.equal(annotations.length, 6, "every concurrent request produced its own Annotation");
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
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("the same request ID sent from four processes commits exactly once", async () => {
  const fixture = await createShelfFixture("native-idempotent");
  try {
    const requestId = `req-native-idempotent-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(baseCommand(fixture, { requestId })))
    );
    for (const result of results) {
      assert.equal(result.code, 0, `${JSON.stringify(result.result)} ${result.stderr}`);
      assert.equal(result.result.ok, true);
    }
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    const states = results.map((result) => result.result.receipt.state).sort();
    assert.deepEqual(states, ["already-committed", "already-committed", "already-committed", "committed"]);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a live holder cannot be displaced and keeps its lock", async () => {
  const fixture = await createShelfFixture("native-live-holder");
  const holder = await startWorker({ ...baseCommand(fixture), mode: "holdMutexMs", holdMutexMs: 3_000 });
  try {
    await holder.waitForLine((line) => line.acquired === true);
    const contender = await runWorker({
      ...baseCommand(fixture),
      mode: "tryAcquire",
      acquireTimeoutMs: 500
    });
    assert.equal(contender.result.ok, false);
    assert.equal(contender.result.code, "shelf-write-busy");
    assert.equal(contender.result.waitedMs >= 500, true, "the contender must actually wait");
    await holder.waitForLine((line) => line.released === true);
    assert.equal((await holder.closed), 0, "the holder still owned the lock at the end");
  } finally {
    await forceKill(holder).catch(() => {});
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a force-killed holder leaves the lock abandoned for the next writer", async () => {
  const fixture = await createShelfFixture("native-abandoned");
  const participant = await startParticipant(fixture);
  let holder;
  try {
    holder = await startWorker({ ...baseCommand(fixture), mode: "holdMutexAndCrash" });
    await holder.waitForLine((line) => line.holding === true);
    await forceKill(holder);
    holder = undefined;

    const contender = await runWorker({
      ...baseCommand(fixture),
      mode: "tryAcquire",
      acquireTimeoutMs: 5_000
    });
    assert.equal(contender.result.ok, true, `${JSON.stringify(contender.result)} ${contender.stderr}`);
    assert.equal(contender.result.abandoned, true, "the kernel must report WAIT_ABANDONED");
    assert.equal(contender.result.waitedMs < 4_000, true, "an abandoned mutex is granted immediately");

    // After the abandonment has been consumed and released, the lock is healthy again.
    const after = await runWorker({ ...baseCommand(fixture), mode: "tryAcquire", acquireTimeoutMs: 5_000 });
    assert.equal(after.result.ok, true);
    assert.equal(after.result.abandoned, false);
  } finally {
    if (holder !== undefined) await forceKill(holder).catch(() => {});
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a process killed after publishing the Book is recovered by retrying the same request", async () => {
  const fixture = await createShelfFixture("native-crash-midwrite");
  const participant = await startParticipant(fixture);
  const requestId = `req-native-crash-${randomUUID()}`;
  const command = baseCommand(fixture, { requestId });
  let holder;
  try {
    holder = await startWorker({ ...command, mode: "crashAfterBookHold" });
    await holder.waitForLine((line) => line.stage === "book-published");
    await forceKill(holder);
    holder = undefined;

    // The crashed writer left a staged journal and a published Book. Its lock died
    // with the process, so the retry must be told the lock was abandoned and must
    // reconcile the journal before writing.
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0);
    const staged = JSON.parse(await readFile(path.join(journalDirectory(fixture), `${requestId}.json`), "utf8"));
    assert.equal(staged.state, "staged");

    const retry = await runWorker(command, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    assert.equal(retry.result.ok, true);
    assert.equal(retry.result.receipt.state, "committed");
    // The retry was told the previous owner died, and it named the interrupted
    // request it reconciled before writing.
    const abandoned = retry.lines.find((line) => line.abandoned === true);
    assert.ok(abandoned !== undefined, `no abandonment report; saw ${JSON.stringify(retry.lines)}`);
    assert.equal(abandoned.recovery.trigger, "abandoned");
    assert.deepEqual(abandoned.recovery.interruptedRequestIds, [requestId]);
    assert.deepEqual(abandoned.recovery.committedRequestIds, []);

    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1, "the retry must not duplicate");
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    const receipt = JSON.parse(await readFile(path.join(journalDirectory(fixture), `${requestId}.json`), "utf8"));
    assert.equal(receipt.state, "committed");
  } finally {
    if (holder !== undefined) await forceKill(holder).catch(() => {});
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("Reviewer and Host share one native lock and a killed Host stage blocks Reviewer until receipt recovery", async () => {
  const fixture = await createShelfFixture("reviewer-host-native-collision");
  const participant = await startParticipant(fixture);
  const hostCommand = baseCommand(fixture, {
    requestId: `req-reviewer-host-${randomUUID()}`,
    url: "https://example.test/reviewer-host-collision",
    mode: "crashAfterBookHold"
  });
  const reviewerRecord = {
    annotationId: "123e4567-e89b-42d3-a456-426614174020",
    reviewState: "APPROVED",
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "website",
    getDate: "202610311200",
    url: hostCommand.url,
    quote: "Reviewerから追加した引用。",
    pageLabel: "1",
    comment: "確認済み"
  };
  const reviewerCommand = {
    mode: "reviewer",
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    acquireTimeoutMs: 30_000,
    reviewerRecord
  };
  let host;
  let reviewer;
  try {
    host = await startWorker(hostCommand);
    await host.waitForLine((line) => line.stage === "book-published");
    reviewer = await startWorker(reviewerCommand);
    await reviewer.waitForLine((line) => line.stage === "starting");
    // Give the Reviewer process time to enter its non-blocking native-lock polling loop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await forceKill(host);
    host = undefined;

    const blockedCode = await reviewer.closed;
    assert.equal(blockedCode, 3, `${JSON.stringify(reviewer.lines)} ${reviewer.stderr()}`);
    assert.equal(reviewer.lines.at(-1)?.code, "shelf-write-recovery-state-unavailable");
    await reviewer.cleanup();
    reviewer = undefined;
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1, "Reviewer must not add a duplicate while Host recovery is pending");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0, "Reviewer must not publish while Host owns staged recovery");

    const recovery = await runWorker({ ...baseCommand(fixture, { requestId: hostCommand.requestId, url: hostCommand.url }), mode: "recoveryState" });
    assert.equal(recovery.result.recoveryState.pending, true);
    assert.equal(recovery.result.recoveryState.requestId, hostCommand.requestId);

    const hostRetry = await runWorker(baseCommand(fixture, { requestId: hostCommand.requestId, url: hostCommand.url }), 120_000);
    assert.equal(hostRetry.code, 0, `${JSON.stringify(hostRetry.result)} ${hostRetry.stderr}`);
    assert.equal(hostRetry.result.receipt.state, "committed");
    const clean = await runWorker({ ...baseCommand(fixture, { requestId: hostCommand.requestId, url: hostCommand.url }), mode: "recoveryState" });
    assert.equal(clean.result.recoveryState.pending, false);

    const reviewerRetry = await runWorker(reviewerCommand, 120_000);
    assert.equal(reviewerRetry.code, 0, `${JSON.stringify(reviewerRetry.result)} ${reviewerRetry.stderr}`);
    assert.equal(reviewerRetry.result.result.materialized, 1);
    const books = await readJsonFiles(fixture.booksDirectory);
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(books.length, 1, "both writers must share the website Book");
    assert.equal(annotations.length, 2, "Host and Reviewer must each retain their Annotation");
    assert.equal(annotations.find((annotation) => annotation.deviceMetadata?.maginaliaReviewer)?.deviceMetadata.maginaliaReviewer.annotationId, reviewerRecord.annotationId);
  } finally {
    if (reviewer !== undefined) await forceKill(reviewer).catch(() => {});
    if (host !== undefined) await forceKill(host).catch(() => {});
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a force-killed Reviewer after asset and Book publication resumes the same v2 request", async () => {
  const fixture = await createShelfFixture("reviewer-killed-after-book");
  const reviewerAnnotationId = "123e4567-e89b-42d3-a456-426614174106";
  const assetBytes = Buffer.from([0xff, 0xd8, 0xff, 0x41, 0x42, 0x43]);
  const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
  const reviewerRecord = {
    annotationId: reviewerAnnotationId,
    reviewState: "APPROVED",
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "Handwritten",
    getDate: "202603021415",
    isbn13: "9780306406157",
    quote: "初回openBD情報を保持した引用。",
    pageLabel: "3",
    comment: "確認済み",
    sourceFiles: [{
      path: "images/source.jpg",
      mediaType: "image/jpeg",
      sha256: assetDigest,
      bytes: [...assetBytes]
    }]
  };
  const requestId = `reviewer-${createHash("sha256").update(reviewerAnnotationId, "utf8").digest("hex")}`;
  const command = {
    mode: "reviewerCrashAtBoundary",
    boundary: "before-annotation",
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    annotationsDirectory: fixture.annotationsDirectory,
    acquireTimeoutMs: 30_000,
    reviewerRecord,
    metadataLookup: {
      status: "ok",
      metadata: { isbn13: reviewerRecord.isbn13, title: "初回openBD書名", authors: ["初回著者"] }
    }
  };
  let crashed;
  try {
    crashed = await startWorker(command);
    await crashed.waitForLine((line) => line.stage === "reviewer-boundary" && line.boundary === "before-annotation");
    await forceKill(crashed);
    crashed = undefined;

    const journalPath = path.join(journalDirectory(fixture), `${requestId}.json`);
    const staged = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(staged.version, 2);
    assert.equal(staged.state, "staged");
    assert.equal(staged.reviewerEnrichment.metadata.title, "初回openBD書名");
    const books = await readJsonFiles(fixture.booksDirectory);
    assert.equal(books.length, 1);
    assert.equal(books[0].title, "初回openBD書名");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0);
    assert.deepEqual(
      await readFile(path.join(fixture.shelfRoot, ...books[0].source.files[0].path.split("/"))),
      assetBytes
    );
    const markerPath = path.join(path.dirname(journalDirectory(fixture)), "writer-recovery.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.requestId, requestId);

    // The retry's provider is now unavailable. The v2 journal snapshot must
    // reconstruct the exact original Book and Annotation without another lookup.
    const retry = await runWorker({ ...command, mode: "reviewer", metadataLookup: { status: "not-found" } }, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    const retryStart = retry.lines.find((line) => line.stage === "starting");
    assert.equal(retryStart.mutex.createdFresh, true, "the Reviewer restart must recover with a new mutex object after all processes exited");
    assert.equal(retryStart.recoveryState.pending, true, "the recovery marker must drive verification when the old mutex object disappeared");
    assert.deepEqual(retry.result.result, { materialized: 1, unchanged: 0, pending: [], conflicts: 0 });
    const receipt = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(receipt.state, "committed");
    assert.equal(receipt.bookId, staged.bookId);
    assert.equal(receipt.annotationId, staged.annotationId);
    const recoveredBooks = await readJsonFiles(fixture.booksDirectory);
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(recoveredBooks.length, 1);
    assert.equal(recoveredBooks[0].title, "初回openBD書名");
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].deviceMetadata.maginaliaReviewer.annotationId, reviewerAnnotationId);
    assert.equal(annotations[0].quote, reviewerRecord.quote);
    assert.deepEqual(
      await readFile(path.join(fixture.shelfRoot, ...recoveredBooks[0].source.files[0].path.split("/"))),
      assetBytes
    );
    const clean = await runWorker({ ...command, mode: "recoveryState" });
    assert.equal(clean.result.recoveryState.pending, false);
  } finally {
    if (crashed !== undefined) await forceKill(crashed).catch(() => {});
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a Reviewer killed after staging and before its first asset resumes without partial files", async () => {
  const fixture = await createShelfFixture("reviewer-killed-before-asset");
  const reviewerAnnotationId = "123e4567-e89b-42d3-a456-426614174112";
  const assetBytes = Buffer.from([0xff, 0xd8, 0xff, 0x51, 0x52]);
  const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
  const reviewerRecord = {
    annotationId: reviewerAnnotationId,
    reviewState: "APPROVED",
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "Handwritten",
    getDate: "202603021415",
    title: "Pre-asset crash",
    authors: [],
    quote: "ステージ後の引用。",
    pageLabel: "3",
    comment: "",
    sourceFiles: [{ path: "images/source.jpg", mediaType: "image/jpeg", sha256: assetDigest, bytes: [...assetBytes] }]
  };
  const requestId = `reviewer-${createHash("sha256").update(reviewerAnnotationId, "utf8").digest("hex")}`;
  const command = {
    mode: "reviewerCrashAtBoundary",
    boundary: "before-asset",
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    annotationsDirectory: fixture.annotationsDirectory,
    acquireTimeoutMs: 30_000,
    reviewerRecord
  };
  let crashed;
  try {
    crashed = await startWorker(command);
    await crashed.waitForLine((line) => line.stage === "reviewer-boundary" && line.boundary === "staged-before-asset");
    await forceKill(crashed);
    crashed = undefined;

    const journalPath = path.join(journalDirectory(fixture), `${requestId}.json`);
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).state, "staged");
    const markerPath = path.join(path.dirname(journalDirectory(fixture)), "writer-recovery.json");
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).requestId, requestId);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 0);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0);
    const sourceFolder = createHash("sha256").update(`image/jpeg:${assetDigest}`, "utf8").digest("hex");
    const assetPath = path.join(fixture.shelfRoot, "sources", sourceFolder, "images", "source.jpg");
    await assert.rejects(readFile(assetPath), { code: "ENOENT" });

    const retry = await runWorker({ ...command, mode: "reviewer" }, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    const retryStart = retry.lines.find((line) => line.stage === "starting");
    assert.equal(retryStart.mutex.createdFresh, true);
    assert.equal(retryStart.recoveryState.pending, true);
    assert.deepEqual(retry.result.result, { materialized: 1, unchanged: 0, pending: [], conflicts: 0 });
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).state, "committed");
    assert.deepEqual(await readFile(assetPath), assetBytes);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
    const clean = await runWorker({ ...command, mode: "recoveryState" });
    assert.equal(clean.result.recoveryState.pending, false);
  } finally {
    if (crashed !== undefined) await forceKill(crashed).catch(() => {});
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a Reviewer killed after Annotation publication but before receipt reuses the same file", async () => {
  const fixture = await createShelfFixture("reviewer-killed-after-annotation");
  const reviewerAnnotationId = "123e4567-e89b-42d3-a456-426614174113";
  const assetBytes = Buffer.from([0xff, 0xd8, 0xff, 0x61, 0x62]);
  const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
  const reviewerRecord = {
    annotationId: reviewerAnnotationId,
    reviewState: "APPROVED",
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "Handwritten",
    getDate: "202603021415",
    title: "Post-annotation crash",
    authors: [],
    quote: "Annotation先行の引用。",
    pageLabel: "3",
    comment: "",
    sourceFiles: [{ path: "images/source.jpg", mediaType: "image/jpeg", sha256: assetDigest, bytes: [...assetBytes] }]
  };
  const requestId = `reviewer-${createHash("sha256").update(reviewerAnnotationId, "utf8").digest("hex")}`;
  const command = {
    mode: "reviewerCrashAtBoundary",
    boundary: "after-annotation-before-receipt",
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    annotationsDirectory: fixture.annotationsDirectory,
    acquireTimeoutMs: 30_000,
    reviewerRecord
  };
  let crashed;
  try {
    crashed = await startWorker(command);
    await crashed.waitForLine((line) => line.stage === "reviewer-boundary" && line.boundary === "after-annotation-before-receipt");
    await forceKill(crashed);
    crashed = undefined;

    const journalPath = path.join(journalDirectory(fixture), `${requestId}.json`);
    const staged = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(staged.state, "staged");
    const annotationNamesBefore = await readdir(fixture.annotationsDirectory);
    assert.equal(annotationNamesBefore.length, 1);
    const annotationPath = path.join(fixture.annotationsDirectory, annotationNamesBefore[0]);
    const annotationBefore = await readFile(annotationPath, "utf8");
    const markerPath = path.join(path.dirname(journalDirectory(fixture)), "writer-recovery.json");
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).requestId, requestId);

    const retry = await runWorker({ ...command, mode: "reviewer" }, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    const retryStart = retry.lines.find((line) => line.stage === "starting");
    assert.equal(retryStart.mutex.createdFresh, true);
    assert.equal(retryStart.recoveryState.pending, true);
    assert.deepEqual(retry.result.result, { materialized: 0, unchanged: 1, pending: [], conflicts: 0 });
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).state, "committed");
    assert.equal(await readFile(annotationPath, "utf8"), annotationBefore);
    assert.deepEqual(await readdir(fixture.annotationsDirectory), annotationNamesBefore);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
    const clean = await runWorker({ ...command, mode: "recoveryState" });
    assert.equal(clean.result.recoveryState.pending, false);
  } finally {
    if (crashed !== undefined) await forceKill(crashed).catch(() => {});
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("the Reviewer approval and refresh path recovers through the shared writer after a process kill", async () => {
  const fixture = await createShelfFixture("reviewer-approval-killed-before-annotation");
  const fixtureRoot = await realpath(fixture.base);
  const reviewerAnnotationId = "123e4567-e89b-42d3-a456-426614174121";
  const reviewerRecord = {
    annotationId: reviewerAnnotationId,
    reviewState: "APPROVED",
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "book",
    getDate: "202610311200",
    isbn13: "9780306406157",
    title: "Reviewer approval route",
    authors: ["著者"],
    quote: "承認から共有Writerへ渡る引用。",
    pageLabel: "12",
    comment: "確認済み"
  };
  const requestId = `reviewer-${createHash("sha256").update(reviewerAnnotationId, "utf8").digest("hex")}`;
  const command = {
    mode: "reviewerApprovalCrashAtBoundary",
    boundary: "before-annotation",
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    bindingDirectory: path.join(fixtureRoot, "integration"),
    shelfLocationPath: path.join(fixtureRoot, "shelf_location.yml"),
    acquireTimeoutMs: 30_000,
    reviewerRecord
  };
  let crashed;
  try {
    crashed = await startWorker(command);
    const firstBinding = await crashed.waitForLine((line) => line.stage === "reviewer-binding");
    assert.equal(firstBinding.expectedShelfId, fixture.shelfId);
    assert.equal(firstBinding.bindingConfirmations, 1);
    await crashed.waitForLine((line) => line.stage === "reviewer-boundary" && line.boundary === "before-annotation");
    await forceKill(crashed);
    crashed = undefined;

    const journalPath = path.join(journalDirectory(fixture), `${requestId}.json`);
    const staged = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(staged.state, "staged");
    assert.equal(staged.version, 2);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0);
    const markerPath = path.join(path.dirname(journalDirectory(fixture)), "writer-recovery.json");
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).requestId, requestId);
    const bindingPath = path.join(command.bindingDirectory, "private-shelf-binding.json");
    const savedBinding = JSON.parse(await readFile(bindingPath, "utf8"));
    assert.equal(savedBinding.expectedShelfId, fixture.shelfId);
    assert.equal(savedBinding.generation, 1);

    const retry = await runWorker({ ...command, mode: "reviewerApproval" }, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    assert.equal(retry.result.path, "reviewer-approval-sync");
    const retryStart = retry.lines.find((line) => line.stage === "starting");
    const retryBinding = retry.lines.find((line) => line.stage === "reviewer-binding");
    assert.equal(retryStart.mutex.createdFresh, true);
    assert.equal(retryStart.recoveryState.pending, true);
    assert.equal(retryBinding.bindingConfirmations, 0, "a normal retry must reuse the per-user binding without prompting again");
    assert.equal(retry.result.bindingConfirmations, 0);
    assert.deepEqual(retry.result.result, { materialized: 1, unchanged: 0, pending: [], conflicts: 0 });
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).state, "committed");
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    const annotations = await readJsonFiles(fixture.annotationsDirectory);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].deviceMetadata.maginaliaReviewer.annotationId, reviewerAnnotationId);
    assert.equal(annotations[0].quote, reviewerRecord.quote);
    const clean = await runWorker({ ...command, mode: "recoveryState" });
    assert.equal(clean.result.recoveryState.pending, false);
  } finally {
    if (crashed !== undefined) await forceKill(crashed).catch(() => {});
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a Reviewer process killed after its receipt leaves a verifiable stale marker", async () => {
  const fixture = await createShelfFixture("reviewer-killed-after-receipt");
  const participant = await startParticipant(fixture);
  const reviewerAnnotationId = "123e4567-e89b-42d3-a456-426614174107";
  const reviewerRecord = {
    annotationId: reviewerAnnotationId,
    reviewState: "APPROVED",
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "book",
    getDate: "202610311200",
    isbn13: "9780306406157",
    title: "既知の書誌",
    authors: ["著者"],
    quote: "receipt境界の引用。",
    pageLabel: "1",
    comment: ""
  };
  const requestId = `reviewer-${createHash("sha256").update(reviewerAnnotationId, "utf8").digest("hex")}`;
  const command = {
    mode: "reviewerCrashAtBoundary",
    boundary: "after-receipt",
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    acquireTimeoutMs: 30_000,
    reviewerRecord
  };
  let crashed;
  try {
    crashed = await startWorker(command);
    const boundary = await crashed.waitForLine((line) => line.stage === "reviewer-boundary" && line.boundary === "after-receipt");
    assert.equal(boundary.receipt.state, "committed");
    await forceKill(crashed);
    crashed = undefined;

    const journalPath = path.join(journalDirectory(fixture), `${requestId}.json`);
    const committed = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(committed.state, "committed");
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
    const pending = await runWorker({ ...command, mode: "recoveryState" });
    assert.equal(pending.result.recoveryState.pending, true);

    const retry = await runWorker({ ...command, mode: "reviewer" }, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    assert.deepEqual(retry.result.result, { materialized: 0, unchanged: 1, pending: [], conflicts: 0 });
    const clean = await runWorker({ ...command, mode: "recoveryState" });
    assert.equal(clean.result.recoveryState.pending, false);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).annotationId, committed.annotationId);
  } finally {
    if (crashed !== undefined) await forceKill(crashed).catch(() => {});
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a process.exit between Book and Annotation still leaves a recoverable journal", async () => {
  const fixture = await createShelfFixture("native-orderly-crash");
  const participant = await startParticipant(fixture);
  const requestId = `req-native-orderly-${randomUUID()}`;
  try {
    const crashed = await runWorker(baseCommand(fixture, { requestId, crashAfterBook: true }));
    assert.equal(crashed.code, 70, JSON.stringify(crashed.result));
    assert.equal(crashed.result.code, "simulated-crash");

    // `process.exit` skips environment teardown, so the addon finalizers do not run and
    // the mutex is normally left abandoned; a natural exit would release it instead.
    // Either way the durable recovery record was written before the critical section, so
    // the retry has to verify the journal. The assertion below therefore accepts both
    // triggers: what matters is that recovery happened and the staged request completed.
    const retry = await runWorker(baseCommand(fixture, { requestId }), 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    assert.equal(retry.result.receipt.state, "committed");
    const reported = retry.lines.find((line) => line.recovery?.trigger !== undefined);
    assert.ok(reported !== undefined, `no recovery report; saw ${JSON.stringify(retry.lines)}`);
    assert.ok(
      reported.recovery.trigger === "abandoned" || reported.recovery.trigger === "pending-write",
      `unexpected trigger ${JSON.stringify(reported)}`
    );
    assert.deepEqual(reported.recovery.interruptedRequestIds, [requestId]);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
  } finally {
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a damaged journal plus an abandoned lock fails closed and writes nothing", async () => {
  const fixture = await createShelfFixture("native-corrupt");
  const participant = await startParticipant(fixture);
  const requestId = `req-native-corrupt-${randomUUID()}`;
  let holder;
  try {
    await mkdir(journalDirectory(fixture), { recursive: true });
    await writeFile(path.join(journalDirectory(fixture), `${requestId}.json`), "{\"version\": 1,", "utf8");

    holder = await startWorker({ ...baseCommand(fixture, { requestId }), mode: "holdMutexAndCrash" });
    await holder.waitForLine((line) => line.holding === true);
    await forceKill(holder);
    holder = undefined;

    const retry = await runWorker(baseCommand(fixture, { requestId }), 120_000);
    assert.equal(retry.code, 3, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    assert.equal(retry.result.code, "shelf-write-journal-invalid");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0, "fail closed: no write");
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 0, "fail closed: no Book");
    // The damaged record is left untouched for human repair.
    assert.equal(
      await readFile(path.join(journalDirectory(fixture), `${requestId}.json`), "utf8"),
      "{\"version\": 1,"
    );
  } finally {
    if (holder !== undefined) await forceKill(holder).catch(() => {});
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

function coordinationDirectory(fixture) {
  return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase());
}

test("Desktop absent: the Host dies alone, and the restart still verifies the journal", async () => {
  const fixture = await createShelfFixture("native-host-only");
  const requestId = `req-native-host-only-${randomUUID()}`;
  const command = baseCommand(fixture, { requestId });
  let holder;
  try {
    // This process is the only participant: no Desktop, no second Host, no
    // long-lived handle. It creates the mutex, publishes the Book, and is killed.
    holder = await startWorker({ ...command, mode: "crashAfterBookHold" });
    await holder.waitForLine((line) => line.stage === "book-published");
    const crashed = holder.lines.find((line) => line.stage === "starting");
    assert.equal(crashed.mutex.createdFresh, true);
    assert.equal(crashed.recoveryState.pending, false, "the record is written after the pre-write snapshot");
    await forceKill(holder);
    holder = undefined;

    // The last handle died with the process, so the mutex object is gone: the restart
    // gets a brand-new mutex and cannot see WAIT_ABANDONED. The durable record is the
    // only thing that can make it verify the journal, and it must.
    const retry = await runWorker(command, 120_000);
    assert.equal(retry.code, 0, `${JSON.stringify(retry.result)} ${retry.stderr}`);
    const pre = retry.lines.find((line) => line.stage === "starting");
    assert.equal(pre.mutex.createdFresh, true, "the mutex object did not survive the Host");
    assert.equal(pre.mutex.abandoned, false, "a recreated mutex cannot report abandonment");
    assert.equal(pre.recoveryState.pending, true, "the durable recovery record survived the Host");
    const reported = retry.lines.find((line) => line.recovery?.trigger !== undefined);
    assert.ok(reported !== undefined, `no recovery report; saw ${JSON.stringify(retry.lines)}`);
    assert.equal(reported.abandoned, false);
    assert.equal(reported.recovery.trigger, "pending-write");
    assert.deepEqual(reported.recovery.interruptedRequestIds, [requestId]);

    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    const journal = JSON.parse(await readFile(path.join(journalDirectory(fixture), `${requestId}.json`), "utf8"));
    assert.equal(journal.state, "committed");
    // The record is only cleared after a completed write.
    assert.equal((await readdir(coordinationDirectory(fixture))).includes("writer-recovery.json"), false);
  } finally {
    if (holder !== undefined) await forceKill(holder).catch(() => {});
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("a malformed journal is refused even though the mutex was newly created", async () => {
  const fixture = await createShelfFixture("native-malformed-fresh");
  const requestId = `req-native-malformed-${randomUUID()}`;
  const command = baseCommand(fixture, { requestId });
  try {
    // State after a Host-only crash: a damaged journal, a durable recovery record, and
    // no mutex object in existence at all.
    await mkdir(journalDirectory(fixture), { recursive: true });
    const damaged = path.join(journalDirectory(fixture), `${requestId}.json`);
    await writeFile(damaged, "{\"version\": 1,", "utf8");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    await writeFile(
      path.join(coordinationDirectory(fixture), "writer-recovery.json"),
      `${JSON.stringify({
        version: 1,
        state: "write-in-progress",
        pid: 4242,
        requestId,
        startedAt: new Date().toISOString()
      })}\n`,
      "utf8"
    );

    const result = await runWorker(command, 120_000);
    assert.equal(result.code, 3, `${JSON.stringify(result.result)} ${result.stderr}`);
    assert.equal(result.result.code, "shelf-write-journal-invalid");
    const pre = result.lines.find((line) => line.stage === "starting");
    assert.equal(pre.mutex.createdFresh, true);
    assert.equal(pre.mutex.abandoned, false);
    assert.equal(pre.recoveryState.pending, true);
    // No recovery success report: the assessment refused to continue.
    assert.equal(result.lines.some((line) => line.recovery?.trigger !== undefined), false);

    assert.equal(await readFile(damaged, "utf8"), "{\"version\": 1,");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 0);
    assert.equal((await readdir(coordinationDirectory(fixture))).includes("writer-recovery.json"), true);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("the test Host refuses a malformed recovery marker beside a valid committed journal", async () => {
  const fixture = await createShelfFixture("native-host-malformed-marker");
  try {
    const existing = await runWorker(baseCommand(fixture, {
      quote: "既存の確定済みHost引用。",
      url: "https://example.test/host-existing"
    }));
    assert.equal(existing.code, 0, `${JSON.stringify(existing.result)} ${existing.stderr}`);
    const bookFile = path.join(fixture.booksDirectory, (await readdir(fixture.booksDirectory))[0]);
    const annotationFile = path.join(fixture.annotationsDirectory, (await readdir(fixture.annotationsDirectory))[0]);
    const bookHash = createHash("sha256").update(await readFile(bookFile)).digest("hex");
    const annotationHash = createHash("sha256").update(await readFile(annotationFile)).digest("hex");
    const priorJournalFiles = await readdir(journalDirectory(fixture));
    assert.equal(priorJournalFiles.length, 1);
    const marker = path.join(coordinationDirectory(fixture), "writer-recovery.json");
    const markerBytes = "{\"version\": 1,";
    await writeFile(marker, markerBytes, "utf8");

    const rejected = await runWorker(baseCommand(fixture, {
      quote: "拒否されるHost引用。",
      url: "https://example.test/host-rejected"
    }));
    assert.equal(rejected.code, 3, `${JSON.stringify(rejected.result)} ${rejected.stderr}`);
    assert.equal(rejected.result.code, "shelf-write-recovery-state-invalid");
    assert.equal(await readFile(marker, "utf8"), markerBytes);
    assert.equal(createHash("sha256").update(await readFile(bookFile)).digest("hex"), bookHash);
    assert.equal(createHash("sha256").update(await readFile(annotationFile)).digest("hex"), annotationHash);
    assert.deepEqual(await readdir(journalDirectory(fixture)), priorJournalFiles);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("the Reviewer writer refuses an empty recovery marker beside a valid committed journal", async () => {
  const fixture = await createShelfFixture("native-reviewer-empty-marker");
  try {
    const existing = await runWorker(baseCommand(fixture, {
      quote: "既存の確定済みReviewerテスト用引用。",
      url: "https://example.test/reviewer-existing"
    }));
    assert.equal(existing.code, 0, `${JSON.stringify(existing.result)} ${existing.stderr}`);
    const bookFile = path.join(fixture.booksDirectory, (await readdir(fixture.booksDirectory))[0]);
    const annotationFile = path.join(fixture.annotationsDirectory, (await readdir(fixture.annotationsDirectory))[0]);
    const bookHash = createHash("sha256").update(await readFile(bookFile)).digest("hex");
    const annotationHash = createHash("sha256").update(await readFile(annotationFile)).digest("hex");
    const priorJournalFiles = await readdir(journalDirectory(fixture));
    assert.equal(priorJournalFiles.length, 1);
    const marker = path.join(coordinationDirectory(fixture), "writer-recovery.json");
    await writeFile(marker, "", "utf8");

    const rejected = await runWorker({
      mode: "reviewer",
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot,
      acquireTimeoutMs: 30_000,
      reviewerRecord: { annotationId: "123e4567-e89b-42d3-a456-426614174190" }
    });
    assert.equal(rejected.code, 3, `${JSON.stringify(rejected.result)} ${rejected.stderr}`);
    assert.equal(rejected.result.code, "shelf-write-recovery-state-invalid");
    assert.equal(await readFile(marker, "utf8"), "");
    assert.equal(createHash("sha256").update(await readFile(bookFile)).digest("hex"), bookHash);
    assert.equal(createHash("sha256").update(await readFile(annotationFile)).digest("hex"), annotationHash);
    assert.deepEqual(await readdir(journalDirectory(fixture)), priorJournalFiles);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("an unreadable recovery marker blocks Reviewer and test Host without changing evidence", async (t) => {
  const fixture = await createShelfFixture("native-unreadable-marker");
  let marker;
  let identity;
  let bookFile;
  let annotationFile;
  let bookHash;
  let annotationHash;
  let denyApplied = false;
  const markerBytes = `${JSON.stringify({
    version: 1,
    state: "write-in-progress",
    pid: 4242,
    requestId: "req-unreadable-marker",
    startedAt: new Date().toISOString()
  })}\n`;
  try {
    const existing = await runWorker(baseCommand(fixture, {
      quote: "既存の確定済み引用。",
      url: "https://example.test/unreadable-existing"
    }));
    assert.equal(existing.code, 0, `${JSON.stringify(existing.result)} ${existing.stderr}`);
    bookFile = path.join(fixture.booksDirectory, (await readdir(fixture.booksDirectory))[0]);
    annotationFile = path.join(fixture.annotationsDirectory, (await readdir(fixture.annotationsDirectory))[0]);
    bookHash = createHash("sha256").update(await readFile(bookFile)).digest("hex");
    annotationHash = createHash("sha256").update(await readFile(annotationFile)).digest("hex");
    const priorJournalFiles = await readdir(journalDirectory(fixture));
    assert.equal(priorJournalFiles.length, 1);
    marker = path.join(coordinationDirectory(fixture), "writer-recovery.json");
    await writeFile(marker, markerBytes, "utf8");

    if (process.platform !== "win32") {
      t.skip("Unreadable-file ACL behavior is verified only on Windows.");
      return;
    }
    try {
      identity = execFileSync("whoami", [], { encoding: "utf8", windowsHide: true }).trim();
      denyApplied = true;
      execFileSync("icacls", [marker, "/deny", `${identity}:(R)`], { stdio: "ignore", windowsHide: true });
    } catch (error) {
      t.skip(`This Windows account could not apply a temporary read-deny ACL: ${String(error)}`);
      return;
    }
    const remainedReadable = await readFile(marker).then(() => true, () => false);
    if (remainedReadable) {
      t.skip("The current Windows token can still read the temporary ACL-protected marker.");
      return;
    }

    const rejectedHost = await runWorker(baseCommand(fixture, {
      quote: "拒否されるHost引用。",
      url: "https://example.test/unreadable-host-rejected"
    }));
    assert.equal(rejectedHost.code, 3, `${JSON.stringify(rejectedHost.result)} ${rejectedHost.stderr}`);
    assert.equal(rejectedHost.result.code, "shelf-write-recovery-state-unavailable");
    const rejectedReviewer = await runWorker({
      mode: "reviewer",
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot,
      acquireTimeoutMs: 30_000,
      reviewerRecord: { annotationId: "123e4567-e89b-42d3-a456-426614174191" }
    });
    assert.equal(rejectedReviewer.code, 3, `${JSON.stringify(rejectedReviewer.result)} ${rejectedReviewer.stderr}`);
    assert.equal(rejectedReviewer.result.code, "shelf-write-recovery-state-unavailable");

    assert.deepEqual(await readdir(journalDirectory(fixture)), priorJournalFiles);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1);
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 1);
  } finally {
    try {
      if (denyApplied && marker && identity) {
        try {
          execFileSync("icacls", [marker, "/remove:d", identity], { stdio: "ignore", windowsHide: true });
        } catch {
          execFileSync("icacls", [marker, "/reset"], { stdio: "ignore", windowsHide: true });
        }
      }
      if (marker) assert.equal(await readFile(marker, "utf8"), markerBytes);
      if (bookFile && annotationFile && bookHash && annotationHash) {
        assert.equal(createHash("sha256").update(await readFile(bookFile)).digest("hex"), bookHash);
        assert.equal(createHash("sha256").update(await readFile(annotationFile)).digest("hex"), annotationHash);
      }
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
});

test("a junction planted at the recovery marker is refused and its target is untouched", async () => {
  const fixture = await createShelfFixture("native-marker-junction");
  const externalDirectory = path.join(fixture.base, "external-target");
  const marker = path.join(coordinationDirectory(fixture), "writer-recovery.json");
  try {
    await mkdir(externalDirectory, { recursive: true });
    const sentinel = path.join(externalDirectory, "sentinel.txt");
    await writeFile(sentinel, "SENTINEL\n", "utf8");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    // A junction needs no special privilege, so this case is testable everywhere.
    await symlink(externalDirectory, marker, "junction");

    const result = await runWorker(baseCommand(fixture), 120_000);
    assert.equal(result.code, 3, `${JSON.stringify(result.result)} ${result.stderr}`);
    assert.equal(result.result.code, "shelf-write-recovery-state-unavailable");
    const pre = result.lines.find((line) => line.stage === "starting");
    assert.equal(pre.recoveryState.error, "shelf-write-recovery-state-unavailable");

    // Nothing was written, nothing was deleted, and the junction target is intact.
    assert.equal(await readFile(sentinel, "utf8"), "SENTINEL\n");
    assert.equal((await readdir(fixture.annotationsDirectory)).length, 0);
    assert.equal((await readdir(fixture.booksDirectory)).length, 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

symlinkTest("a symlink planted at the recovery marker is refused without touching its sentinel", async () => {
  const fixture = await createShelfFixture("native-marker-symlink");
  const sentinel = path.join(fixture.base, "external-sentinel.txt");
  const marker = path.join(coordinationDirectory(fixture), "writer-recovery.json");
  try {
    await writeFile(sentinel, "SENTINEL-DO-NOT-TOUCH\n", "utf8");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    await symlink(sentinel, marker);

    const result = await runWorker(baseCommand(fixture), 120_000);
    assert.equal(result.code, 3, `${JSON.stringify(result.result)} ${result.stderr}`);
    assert.equal(result.result.code, "shelf-write-recovery-state-unavailable");

    assert.equal(await readFile(sentinel, "utf8"), "SENTINEL-DO-NOT-TOUCH\n");
    assert.equal((await readdir(fixture.annotationsDirectory)).length, 0);
    assert.equal((await readdir(fixture.booksDirectory)).length, 0);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("after a failed assessment and a normal exit, the next process still refuses to write", async () => {
  const fixture = await createShelfFixture("native-failed-then-exit");
  const participant = await startParticipant(fixture);
  const requestId = `req-native-failed-${randomUUID()}`;
  const command = baseCommand(fixture, { requestId });
  const damaged = path.join(journalDirectory(fixture), `${requestId}.json`);
  let holder;
  try {
    holder = await startWorker({ ...command, mode: "crashAfterBookHold" });
    await holder.waitForLine((line) => line.stage === "book-published");
    await forceKill(holder);
    holder = undefined;

    // Damage the staged record the crashed write left behind.
    await writeFile(damaged, "{\"version\": 1,", "utf8");

    // First retry: abandonment -> assessment fails -> the process exits *naturally*, so
    // the environment tears down, the addon finalizer runs, and the mutex is released
    // cleanly. That is the exact case this test exists for: the next process cannot rely
    // on abandonment to know it must verify.
    const first = await runWorker({ ...command, exitNaturally: true }, 120_000);
    assert.equal(first.code, 3, `${JSON.stringify(first.result)} ${first.stderr}`);
    assert.equal(first.result.code, "shelf-write-journal-invalid");

    // Prove the premise: the lock is not abandoned, so only the durable record can make
    // the next writer verify. The probe acquires and releases without writing.
    const probe = await runWorker({ ...command, mode: "tryAcquire", acquireTimeoutMs: 5_000 }, 30_000);
    assert.equal(probe.result.ok, true, `${JSON.stringify(probe.result)} ${probe.stderr}`);
    assert.equal(probe.result.abandoned, false, "the natural exit must release the lock");

    const state = await runWorker({ ...command, mode: "recoveryState" }, 30_000);
    assert.equal(state.result.recoveryState.pending, true);

    // Second process: no abandonment, but the record forces the same failed check.
    const second = await runWorker(command, 120_000);
    assert.equal(second.code, 3, `${JSON.stringify(second.result)} ${second.stderr}`);
    assert.equal(second.result.code, "shelf-write-journal-invalid");
    assert.equal(second.lines.some((line) => line.recovery?.trigger !== undefined), false, "no write was allowed");
    const pre = second.lines.find((line) => line.stage === "starting");
    assert.equal(pre.mutex.abandoned, false);
    assert.equal(pre.recoveryState.pending, true);

    // Nothing repaired, nothing deleted, nothing written.
    assert.equal(await readFile(damaged, "utf8"), "{\"version\": 1,");
    assert.equal((await readJsonFiles(fixture.annotationsDirectory)).length, 0);
    assert.equal((await readJsonFiles(fixture.booksDirectory)).length, 1, "the crashed Book is left as-is");
  } finally {
    if (holder !== undefined) await forceKill(holder).catch(() => {});
    await stopParticipant(participant);
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("lock names are Shelf-scoped: one Shelf's lock does not block another", async () => {
  const first = await createShelfFixture("native-scope-a");
  const second = await createShelfFixture("native-scope-b");
  const participantFirst = await startParticipant(first);
  const participantSecond = await startParticipant(second);
  const holder = await startWorker({ ...baseCommand(first), mode: "holdMutexMs", holdMutexMs: 2_500 });
  try {
    await holder.waitForLine((line) => line.acquired === true);
    const blocked = await runWorker({ ...baseCommand(first), mode: "tryAcquire", acquireTimeoutMs: 400 });
    assert.equal(blocked.result.code, "shelf-write-busy");
    const independent = await runWorker({ ...baseCommand(second), mode: "tryAcquire", acquireTimeoutMs: 1_000 });
    assert.equal(independent.result.ok, true, `${JSON.stringify(independent.result)} ${independent.stderr}`);
    assert.equal(independent.result.abandoned, false);
    await holder.waitForLine((line) => line.released === true);
  } finally {
    await forceKill(holder).catch(() => {});
    await stopParticipant(participantFirst);
    await stopParticipant(participantSecond);
    await rm(first.base, { recursive: true, force: true });
    await rm(second.base, { recursive: true, force: true });
  }
});

test("the mutex DACL refuses an account it does not grant", async () => {
  const name = `Local\\MAGINALIA.ShelfWrite.Deny.${randomUUID()}`;
  const result = await runWorker({ mode: "createSystemOnly", name }, 30_000);
  assert.equal(result.code, 0, `${JSON.stringify(result.result)} ${result.stderr}`);
  // Windows error 5 (access denied) surfaces as the addon's `mutex-access-denied`.
  assert.equal(result.result.secondCreateCode, "mutex-access-denied");
});
