/**
 * Unit-level evidence for the Windows named-mutex Shelf write lock.
 *
 * These tests run in one process. Cross-process exclusion, force-kill recovery and
 * packaging are proven separately by `test/collector-shelf-native-lock.test.mjs`,
 * `test/electron-native-lock-smoke.mjs` and the packaging spike.
 *
 * When the addon binary is absent (no C++ toolchain), the mutex suites are skipped
 * with an explicit message instead of failing the JavaScript suite. The dedicated
 * command `npm run test:collector-shelf-native` builds first and is the evidence
 * path.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireShelfMutex,
  closeShelfMutexHandles,
  loadNativeShelfMutex,
  nativeShelfMutexAvailable,
  resolveShelfMutexName,
  ShelfNativeMutexError
} from "./shelf-native-mutex.js";
import { assessShelfWriteStateAfterAbandon, commitShelfQuoteWithNativeLock } from "./shelf-native-write-lock.js";
import {
  commitShelfQuote,
  inspectShelfWriteJournal,
  type ShelfQuoteWriteRequest
} from "./shelf-write-coordination.js";

const available = nativeShelfMutexAvailable();
const mutexSuite = available ? describe : describe.skip;

const created: string[] = [];

afterEach(() => {
  closeShelfMutexHandles();
});

async function createFixture(label: string): Promise<{
  readonly base: string;
  readonly shelfRoot: string;
  readonly shelfId: string;
  readonly coordinationRoot: string;
  readonly booksDirectory: string;
  readonly annotationsDirectory: string;
  readonly journalDirectory: string;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), `maginalia-shelf-native-${label}-日本語-`));
  created.push(base);
  const shelfId = randomUUID();
  const shelfRoot = path.join(base, "Private Shelf 本棚");
  const coordinationRoot = path.join(base, "coordination");
  const booksDirectory = path.join(shelfRoot, "books");
  const annotationsDirectory = path.join(shelfRoot, "annotations");
  await Promise.all([
    mkdir(booksDirectory, { recursive: true }),
    mkdir(annotationsDirectory, { recursive: true }),
    mkdir(coordinationRoot, { recursive: true })
  ]);
  await writeFile(path.join(shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${shelfId}\n`, "utf8");
  await writeFile(
    path.join(shelfRoot, "library.json"),
    `${JSON.stringify({ type: "library", version: "0.1", name: "私的書棚", booksPath: "books", annotationsPath: "annotations" }, null, 2)}\n`,
    "utf8"
  );
  return {
    base,
    shelfRoot,
    shelfId,
    coordinationRoot,
    booksDirectory,
    annotationsDirectory,
    journalDirectory: path.join(coordinationRoot, "shelves", shelfId.toLowerCase(), "requests")
  };
}

function request(fixture: { shelfRoot: string; shelfId: string; coordinationRoot: string }, overrides: Partial<ShelfQuoteWriteRequest> = {}): ShelfQuoteWriteRequest {
  return {
    requestId: `req-${randomUUID()}`,
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    quote: "ネイティブmutexで保存する引用。",
    url: "https://example.test/native?id=1",
    getDate: "202610311200",
    comment: "確認用メモ",
    processLabel: "vitest-native",
    ...overrides
  };
}

describe("shelf mutex name derivation", () => {
  test("is deterministic, Shelf-scoped and lowercased", () => {
    const shelfId = randomUUID();
    const name = resolveShelfMutexName(shelfId);
    expect(name).toBe(`Local\\MAGINALIA.ShelfWrite.${shelfId.toLowerCase()}`);
    expect(resolveShelfMutexName(shelfId.toUpperCase())).toBe(name);
    expect(resolveShelfMutexName(randomUUID())).not.toBe(name);
    expect(resolveShelfMutexName(shelfId, "machine")).toBe(`Global\\MAGINALIA.ShelfWrite.${shelfId.toLowerCase()}`);
  });

  test("rejects anything that is not a canonical UUID", () => {
    for (const value of ["", "..\\escape", "not-a-uuid", `${randomUUID()}\\x`, "Local\\MAGINALIA.ShelfWrite.x"]) {
      expect(() => resolveShelfMutexName(value)).toThrowError(ShelfNativeMutexError);
      try {
        resolveShelfMutexName(value);
      } catch (error: unknown) {
        expect((error as ShelfNativeMutexError).code).toBe("native-mutex-invalid-name");
      }
    }
  });
});

mutexSuite("windows named mutex (addon present)", () => {
  test("the addon reports its ABI version", () => {
    expect(loadNativeShelfMutex().apiVersion).toBe(1);
  });

  test("acquire is exclusive in-process and assertHeld tracks the kernel state", async () => {
    const shelfId = randomUUID();
    const lease = await acquireShelfMutex({ shelfId, acquireTimeoutMs: 200 });
    expect(lease.abandoned).toBe(false);
    await lease.assertHeld();
    // The kernel mutex is recursive for the owning thread, so a second in-process
    // acquisition must be refused by the JavaScript guard, not by the kernel.
    await expect(acquireShelfMutex({ shelfId, acquireTimeoutMs: 100 })).rejects.toMatchObject({
      code: "shelf-write-busy"
    });
    lease.release();
    await expect(lease.assertHeld()).rejects.toMatchObject({ code: "shelf-write-lease-lost" });
    const again = await acquireShelfMutex({ shelfId, acquireTimeoutMs: 500 });
    again.release();
  });

  test("a lock held by this thread is not stealable by another thread of the same process", async () => {
    const shelfId = randomUUID();
    const name = resolveShelfMutexName(shelfId);
    const lease = await acquireShelfMutex({ shelfId, acquireTimeoutMs: 200 });
    const binary = path.join(process.cwd(), "native", "shelf-mutex", "build", "Release", "shelf_mutex.node");
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const addon = require(workerData.binary);
       const handle = addon.createMutex(workerData.name);
       const blocked = addon.acquire(handle, 0);
       let releaseCode = null;
       try { addon.release(handle); } catch (error) { releaseCode = error.code; }
       addon.close(handle);
       parentPort.postMessage({ blocked: blocked.acquired, releaseCode });`,
      { eval: true, workerData: { binary, name } }
    );
    const result = await new Promise<{ blocked: boolean; releaseCode: string | null }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(result.blocked).toBe(false);
    // Another thread cannot release a mutex this thread owns.
    expect(result.releaseCode).toBe("mutex-not-owned");
    await lease.assertHeld();
    lease.release();
  });

  test("the security descriptor denies an account it does not grant", () => {
    const native = loadNativeShelfMutex();
    const name = `Local\\MAGINALIA.ShelfWrite.Deny.${randomUUID()}`;
    const restricted = native.createMutex(name, { security: "system-only" });
    try {
      // Establishing the DACL is the point: the test account is not in it, so a
      // second open/create is refused instead of sharing the lock.
      expect(() => native.createMutex(name)).toThrowError(/Win32 error 5/u);
    } finally {
      native.close(restricted);
    }
  });

  test("commits one quote under the OS lock and replays the same request idempotently", async () => {
    const fixture = await createFixture("commit");
    const command = request(fixture);
    const first = await commitShelfQuoteWithNativeLock(command, { acquireTimeoutMs: 2_000 });
    expect(first.state).toBe("committed");
    const second = await commitShelfQuoteWithNativeLock(command, { acquireTimeoutMs: 2_000 });
    expect(second.state).toBe("already-committed");
    expect(second.annotationId).toBe(first.annotationId);
    expect((await readdir(fixture.annotationsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect((await readdir(fixture.booksDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});

describe("abandoned-state journal reconciliation", () => {
  async function commitOnce(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<{ receipt: unknown; requestId: string; command: ShelfQuoteWriteRequest }> {
    const command = request(fixture);
    const receipt = await commitShelfQuote(command);
    return { receipt, requestId: command.requestId, command };
  }

  async function rewriteJournal(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    requestId: string,
    mutate: (record: Record<string, unknown>) => Record<string, unknown>
  ): Promise<void> {
    const file = path.join(fixture.journalDirectory, `${requestId}.json`);
    const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, `${JSON.stringify(mutate(record), null, 2)}\n`, "utf8");
  }

  test("a fully committed journal is resumable and re-verified", async () => {
    const fixture = await createFixture("assess-committed");
    const { requestId } = await commitOnce(fixture);
    const assessment = await assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(assessment.resumable).toBe(true);
    expect(assessment.committedRequestIds).toEqual([requestId]);
    expect(assessment.interruptedRequestIds).toEqual([]);
  });

  test("an interrupted request before the commit point is resumable", async () => {
    const fixture = await createFixture("assess-staged");
    const { requestId, receipt } = await commitOnce(fixture);
    const annotationId = (receipt as { annotationId: string }).annotationId;
    // Remove the Annotation and turn the receipt back into a staged record: this is
    // exactly the state a crash between the Book publish and the Annotation publish
    // leaves behind (plus the file lease, which the mutex replaces).
    await unlink(path.join(fixture.annotationsDirectory, `${annotationId.replace(":", "-")}.json`));
    await rewriteJournal(fixture, requestId, (record) => {
      const { committedAt: _committedAt, ...rest } = record;
      return { ...rest, state: "staged" };
    });
    const assessment = await assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(assessment.resumable).toBe(true);
    expect(assessment.interruptedRequestIds).toEqual([requestId]);
  });

  test("an interrupted request that passed the commit point is resumable", async () => {
    const fixture = await createFixture("assess-staged-published");
    const { requestId, command } = await commitOnce(fixture);
    await rewriteJournal(fixture, requestId, (record) => {
      const { committedAt: _committedAt, ...rest } = record;
      return { ...rest, state: "staged" };
    });
    // The Annotation is on disk with the recorded digest, so only the receipt is
    // missing. Retrying the same request ID completes it without a second record.
    const assessment = await assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(assessment.resumable).toBe(true);
    expect(assessment.interruptedRequestIds).toEqual([requestId]);
    const retried = await commitShelfQuote(command);
    expect(retried.state).toBe("committed");
  });

  test("a staged record whose Annotation does not match its digest fails closed", async () => {
    const fixture = await createFixture("assess-mismatch");
    const { requestId, receipt } = await commitOnce(fixture);
    const annotationId = (receipt as { annotationId: string }).annotationId;
    await rewriteJournal(fixture, requestId, (record) => {
      const { committedAt: _committedAt, ...rest } = record;
      return { ...rest, state: "staged" };
    });
    const file = path.join(fixture.annotationsDirectory, `${annotationId.replace(":", "-")}.json`);
    const original = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, `${JSON.stringify({ ...original, quote: "改変された引用" }, null, 2)}\n`, "utf8");
    await expect(assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    })).rejects.toMatchObject({ code: "shelf-write-lease-uncertain" });
  });

  test("a committed receipt whose Annotation vanished fails closed", async () => {
    const fixture = await createFixture("assess-receipt");
    const { receipt } = await commitOnce(fixture);
    const annotationId = (receipt as { annotationId: string }).annotationId;
    await unlink(path.join(fixture.annotationsDirectory, `${annotationId.replace(":", "-")}.json`));
    await expect(assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    })).rejects.toMatchObject({ code: "shelf-write-receipt-missing" });
  });

  test("a damaged journal fails closed instead of being skipped", async () => {
    const fixture = await createFixture("assess-corrupt");
    const requestId = `req-${randomUUID()}`;
    await mkdir(fixture.journalDirectory, { recursive: true });
    await writeFile(path.join(fixture.journalDirectory, `${requestId}.json`), "{\"version\": 1,", "utf8");
    await expect(assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    })).rejects.toMatchObject({ code: "shelf-write-journal-invalid" });
  });

  test("a Shelf whose marker no longer matches fails closed", async () => {
    const fixture = await createFixture("assess-identity");
    await commitOnce(fixture);
    await writeFile(path.join(fixture.shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${randomUUID()}\n`, "utf8");
    await expect(assessShelfWriteStateAfterAbandon({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    })).rejects.toMatchObject({ code: "shelf-write-identity-mismatch" });
  });

  test("the journal is unchanged by assessment (read-only recovery check)", async () => {
    const fixture = await createFixture("assess-readonly");
    const { requestId } = await commitOnce(fixture);
    const before = await readFile(path.join(fixture.journalDirectory, `${requestId}.json`), "utf8");
    const entries = await inspectShelfWriteJournal({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(entries).toHaveLength(1);
    expect(await readFile(path.join(fixture.journalDirectory, `${requestId}.json`), "utf8")).toBe(before);
  });
});

afterEach(async () => {
  while (created.length > 0) {
    const directory = created.pop()!;
    await rm(directory, { recursive: true, force: true });
  }
});
