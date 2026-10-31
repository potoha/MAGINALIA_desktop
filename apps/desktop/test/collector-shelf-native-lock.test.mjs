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
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShelfFixture, readJsonFiles } from "./shelf-write-fixture.mjs";

const worker = fileURLToPath(new URL("./collector-shelf-native-worker.mjs", import.meta.url));
const addonBinary = fileURLToPath(
  new URL("../native/shelf-mutex/build/Release/shelf_mutex.node", import.meta.url)
);
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
