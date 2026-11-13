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
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, link, lstat, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./shelf-write-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shelf-write-core.js")>();
  return { ...actual, listShelfRecordFiles: vi.fn(actual.listShelfRecordFiles) };
});
import {
  acquireShelfMutex,
  closeShelfMutexHandles,
  isPathWithin,
  loadNativeShelfMutex,
  nativeShelfMutexAvailable,
  resolveNativeAddonCandidates,
  resolveShelfMutexName,
  ShelfNativeMutexError
} from "./shelf-native-mutex.js";
import {
  SHELF_WRITER_RECOVERY_STATE_FILENAME,
  assessShelfWriteRecoveryState,
  clearShelfWriterRecoveryState,
  commitShelfQuoteWithNativeLock,
  commitShelfRecordTransactionWithNativeLock,
  inspectShelfWriterRecoveryState,
  writeShelfWriterRecoveryState
} from "./shelf-native-write-lock.js";
import {
  commitShelfQuote,
  inspectShelfWriteJournal,
  type ShelfQuoteWriteRequest
} from "./shelf-write-coordination.js";
import { listShelfRecordFiles } from "./shelf-write-core.js";
import { LibraryService } from "./library-service.js";

/**
 * Windows only allows file symlinks with Developer Mode or
 * SeCreateSymbolicLinkPrivilege. Probe once so the symlink-marker test can be reported
 * as skipped instead of silently passing.
 */
async function probeLinkSupport(kind: "symlink" | "hardlink"): Promise<boolean> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `maginalia-link-probe-${kind}-`));
  try {
    const target = path.join(directory, "target.txt");
    await writeFile(target, "probe", "utf8");
    if (kind === "symlink") await symlink(target, path.join(directory, "link.txt"));
    else await link(target, path.join(directory, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const symlinkSupport = await probeLinkSupport("symlink");
const hardlinkSupport = await probeLinkSupport("hardlink");
if (!symlinkSupport) {
  console.warn(
    "NOT VERIFIED: this Windows account cannot create file symlinks (EPERM); " +
      "the symlink-marker refusal test is skipped. Junction and directory cases still run."
  );
}

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
    const assessment = await assessShelfWriteRecoveryState({
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
    const assessment = await assessShelfWriteRecoveryState({
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
    const assessment = await assessShelfWriteRecoveryState({
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
    await expect(assessShelfWriteRecoveryState({
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
    await expect(assessShelfWriteRecoveryState({
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
    await expect(assessShelfWriteRecoveryState({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    })).rejects.toMatchObject({ code: "shelf-write-journal-invalid" });
  });

  test("a Shelf whose marker no longer matches fails closed", async () => {
    const fixture = await createFixture("assess-identity");
    await commitOnce(fixture);
    await writeFile(path.join(fixture.shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${randomUUID()}\n`, "utf8");
    await expect(assessShelfWriteRecoveryState({
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

const windowsSuite = process.platform === "win32" ? describe : describe.skip;

windowsSuite("addon loading policy", () => {
  const resources = "C:\\Program Files\\MAGINALIA desktop\\resources";

  test("packaged mode has exactly one candidate and ignores the environment and cwd", () => {
    const resolution = resolveNativeAddonCandidates({
      resourcesPath: resources,
      defaultApp: false,
      envOverride: "C:\\Users\\public\\Downloads\\evil.node",
      cwd: "C:\\Users\\public\\Downloads",
      moduleDirectory: "C:\\Users\\public\\Downloads\\dist\\main"
    });
    expect(resolution.mode).toBe("packaged");
    expect(resolution.candidates).toEqual([path.join(resources, "shelf-mutex", "shelf_mutex.node")]);
  });

  test("dev Electron and plain Node keep the development candidates", () => {
    // `electron main.js` sets process.defaultApp = true, so the env override stays
    // available for development and tests.
    const devElectron = resolveNativeAddonCandidates({
      resourcesPath: "C:\\electron\\resources",
      defaultApp: true,
      envOverride: "C:\\work\\native\\shelf-mutex\\build\\Release\\shelf_mutex.node",
      cwd: "C:\\work"
    });
    expect(devElectron.mode).toBe("development");
    expect(devElectron.candidates[0]).toBe("C:\\work\\native\\shelf-mutex\\build\\Release\\shelf_mutex.node");

    // Plain Node has no resourcesPath at all.
    const plainNode = resolveNativeAddonCandidates({ cwd: "C:\\work" });
    expect(plainNode.mode).toBe("development");
    expect(plainNode.candidates[0]).toBe("C:\\work\\native\\shelf-mutex\\build\\Release\\shelf_mutex.node");
    expect(plainNode.candidates).toHaveLength(2);
  });

  test("containment rejects a path outside the resources root", () => {
    expect(isPathWithin(resources, path.join(resources, "shelf-mutex", "shelf_mutex.node"))).toBe(true);
    expect(isPathWithin(resources, "C:\\Program Files\\MAGINALIA desktop\\resources-evil\\x.node")).toBe(false);
    expect(isPathWithin(resources, "C:\\Windows\\System32\\evil.node")).toBe(false);
    expect(isPathWithin("C:\\app", "C:\\app\\..\\app2\\x.node")).toBe(false);
  });

  test("the development loader resolves the built addon in this checkout", () => {
    expect(loadNativeShelfMutex().apiVersion).toBe(1);
  });
});

mutexSuite("persistent recovery state", () => {
  function coordinationDirectory(fixture: Awaited<ReturnType<typeof createFixture>>): string {
    return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase());
  }

  test("a completed native-lock write leaves no recovery record", async () => {
    const fixture = await createFixture("recovery-clean");
    const receipt = await commitShelfQuoteWithNativeLock(request(fixture), { acquireTimeoutMs: 2_000 });
    expect(receipt.state).toBe("committed");
    const state = await inspectShelfWriterRecoveryState(coordinationDirectory(fixture));
    expect(state.pending).toBe(false);
    const names = await readdir(coordinationDirectory(fixture));
    expect(names).not.toContain(SHELF_WRITER_RECOVERY_STATE_FILENAME);
    // Published atomically: no temp file survives a completed marker lifecycle.
    expect(names.filter((name) => name.startsWith(`.${SHELF_WRITER_RECOVERY_STATE_FILENAME}.`))).toEqual([]);
  });

  test("a failure after Book publication preserves old hashes and leaves the prior quote readable/searchable", async () => {
    const fixture = await createFixture("recovery-book-isolation");
    const prior = await commitShelfQuoteWithNativeLock(request(fixture, {
      quote: "既存の確定済み引用。",
      url: "https://example.test/prior"
    }), { acquireTimeoutMs: 2_000 });
    const priorBook = path.join(fixture.booksDirectory, (await readdir(fixture.booksDirectory))[0]!);
    const priorAnnotation = path.join(fixture.annotationsDirectory, (await readdir(fixture.annotationsDirectory))[0]!);
    const priorHashes = {
      book: createHash("sha256").update(await readFile(priorBook)).digest("hex"),
      annotation: createHash("sha256").update(await readFile(priorAnnotation)).digest("hex")
    };
    const interrupted = request(fixture, {
      quote: "書込み途中の引用。",
      url: "https://example.test/interrupted",
      faults: { beforeAnnotationPublish: () => { throw new Error("injected failure after Book publication"); } }
    });

    await expect(commitShelfQuoteWithNativeLock(interrupted, { acquireTimeoutMs: 2_000 }))
      .rejects.toThrow("injected failure after Book publication");

    const journal = await inspectShelfWriteJournal({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    const interruptedEntry = journal.find((entry) => entry.record.requestId === interrupted.requestId);
    expect(interruptedEntry?.record.state).toBe("staged");
    expect(interruptedEntry?.bookPresent).toBe(true);
    expect(interruptedEntry?.annotationPresent).toBe(false);
    expect((await inspectShelfWriterRecoveryState(coordinationDirectory(fixture))).record?.requestId)
      .toBe(interrupted.requestId);
    expect(createHash("sha256").update(await readFile(priorBook)).digest("hex")).toBe(priorHashes.book);
    expect(createHash("sha256").update(await readFile(priorAnnotation)).digest("hex")).toBe(priorHashes.annotation);
    expect((await readdir(fixture.booksDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect((await readdir(fixture.annotationsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const service = new LibraryService();
    try {
      const owner = {};
      const opened = await service.openPrivateShelfForOwner(owner, fixture.shelfRoot);
      expect(opened.kind).toBe("opened");
      if (opened.kind !== "opened") throw new Error("The existing Shelf citation must remain readable.");
      const records = service.getRecordsForOwner(owner, opened.library.libraryId);
      expect(records.kind).toBe("records");
      if (records.kind !== "records") throw new Error("The existing Shelf records must remain readable.");
      expect(records.records.map((record) => record.quote)).toEqual(["既存の確定済み引用。"]);
      const priorSearch = service.searchForOwner(owner, opened.library.libraryId, "既存の確定済み引用");
      expect(priorSearch.kind).toBe("results");
      if (priorSearch.kind !== "results") throw new Error("The existing Shelf quote must remain searchable.");
      expect(priorSearch.results).toHaveLength(1);
      expect(service.searchForOwner(owner, opened.library.libraryId, "書込み途中の引用")).toMatchObject({
        kind: "results",
        results: []
      });
      expect(prior.state).toBe("committed");
    } finally {
      service.dispose();
    }
  });

  test("a pending record makes the next writer verify before writing", async () => {
    const fixture = await createFixture("recovery-pending");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    await writeShelfWriterRecoveryState({
      coordinationDirectory: coordinationDirectory(fixture),
      requestId: "req-interrupted"
    });
    expect((await inspectShelfWriterRecoveryState(coordinationDirectory(fixture))).pending).toBe(true);

    const triggers: string[] = [];
    const receipt = await commitShelfQuoteWithNativeLock(request(fixture), {
      acquireTimeoutMs: 2_000,
      onRecovery: (assessment, info) => {
        triggers.push(info.trigger);
        expect(assessment.resumable).toBe(true);
      }
    });
    expect(receipt.state).toBe("committed");
    // No abandonment is possible here (the mutex object was never lost in-process), so
    // the record alone has to be what triggers the verification.
    expect(triggers).toEqual(["pending-write"]);
    expect((await inspectShelfWriterRecoveryState(coordinationDirectory(fixture))).pending).toBe(false);
  });

  test("a pending record with a damaged journal fails closed and keeps everything", async () => {
    const fixture = await createFixture("recovery-corrupt");
    await mkdir(fixture.journalDirectory, { recursive: true });
    const damaged = path.join(fixture.journalDirectory, `req-${randomUUID()}.json`);
    await writeFile(damaged, "{\"version\": 1,", "utf8");
    await writeShelfWriterRecoveryState({
      coordinationDirectory: coordinationDirectory(fixture),
      requestId: "req-interrupted"
    });

    await expect(
      commitShelfQuoteWithNativeLock(request(fixture), { acquireTimeoutMs: 2_000 })
    ).rejects.toMatchObject({ code: "shelf-write-journal-invalid" });

    // Nothing repaired, nothing deleted, nothing written.
    expect(await readFile(damaged, "utf8")).toBe("{\"version\": 1,");
    expect(await readdir(fixture.annotationsDirectory)).toEqual([]);
    expect(await readdir(fixture.booksDirectory)).toEqual([]);
    const state = await inspectShelfWriterRecoveryState(coordinationDirectory(fixture));
    expect(state.pending).toBe(true);
    expect(state.record?.requestId).toBe("req-interrupted");
  });

  test("a complete marker cleanup follows the committed receipt and both canonical records", async () => {
    const fixture = await createFixture("recovery-complete-order");
    const command = request(fixture);
    const receipt = await commitShelfQuoteWithNativeLock(command, { acquireTimeoutMs: 2_000 });
    expect(receipt.state).toBe("committed");
    const journal = await inspectShelfWriteJournal({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(journal).toHaveLength(1);
    expect(journal[0]!.record.state).toBe("committed");
    expect(journal[0]!.matchesDisk).toBe(true);
    expect(journal[0]!.bookPresent).toBe(true);
    expect(journal[0]!.annotationPresent).toBe(true);
    expect((await readdir(fixture.booksDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect((await readdir(fixture.annotationsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect((await readdir(coordinationDirectory(fixture))).includes(SHELF_WRITER_RECOVERY_STATE_FILENAME)).toBe(false);
  });

  test("malformed and empty markers fail closed for Reviewer and test Host with a valid journal", async () => {
    for (const [label, markerBytes] of [["truncated", "{\"version\": 1,"], ["empty", ""]] as const) {
      const fixture = await createFixture(`recovery-${label}`);
      const prior = await commitShelfQuoteWithNativeLock(request(fixture, {
        quote: "保存済みの引用。",
        url: "https://example.test/committed"
      }), { acquireTimeoutMs: 2_000 });
      const bookFile = path.join(fixture.booksDirectory, (await readdir(fixture.booksDirectory))[0]!);
      const annotationFile = path.join(fixture.annotationsDirectory, (await readdir(fixture.annotationsDirectory))[0]!);
      const libraryFile = path.join(fixture.shelfRoot, "library.json");
      const before = {
        book: createHash("sha256").update(await readFile(bookFile)).digest("hex"),
        annotation: createHash("sha256").update(await readFile(annotationFile)).digest("hex"),
        library: createHash("sha256").update(await readFile(libraryFile)).digest("hex")
      };
      const marker = path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME);
      await writeFile(marker, markerBytes, "utf8");

      const newHostRequest = request(fixture, {
        quote: "拒否される新規引用。",
        url: "https://example.test/rejected-host"
      });
      await expect(inspectShelfWriterRecoveryState(coordinationDirectory(fixture))).rejects.toMatchObject({
        code: "shelf-write-recovery-state-invalid"
      });
      await expect(
        commitShelfQuoteWithNativeLock(newHostRequest, { acquireTimeoutMs: 2_000 })
      ).rejects.toMatchObject({ code: "shelf-write-recovery-state-invalid" });

      await expect(
        commitShelfRecordTransactionWithNativeLock({
          shelfRoot: fixture.shelfRoot,
          expectedShelfId: fixture.shelfId,
          coordinationRoot: fixture.coordinationRoot,
          requestId: `reviewer-${"a".repeat(64)}`,
          prepare: async () => {
            throw new Error("A Reviewer transaction must not be prepared while the marker is invalid.");
          }
        }, { acquireTimeoutMs: 2_000 })
      ).rejects.toMatchObject({ code: "shelf-write-recovery-state-invalid" });

      await expect(writeShelfWriterRecoveryState({
        coordinationDirectory: coordinationDirectory(fixture),
        requestId: "req-overwrite-invalid"
      })).rejects.toMatchObject({ code: "shelf-write-recovery-state-invalid" });
      await expect(clearShelfWriterRecoveryState(marker)).rejects.toMatchObject({
        code: "shelf-write-recovery-state-invalid"
      });

      expect(await readFile(marker, "utf8")).toBe(markerBytes);
      expect(createHash("sha256").update(await readFile(bookFile)).digest("hex")).toBe(before.book);
      expect(createHash("sha256").update(await readFile(annotationFile)).digest("hex")).toBe(before.annotation);
      expect(createHash("sha256").update(await readFile(libraryFile)).digest("hex")).toBe(before.library);
      expect((await readdir(fixture.booksDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
      expect((await readdir(fixture.annotationsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
      expect(await readdir(fixture.journalDirectory)).toHaveLength(1);
      const priorJournal = await inspectShelfWriteJournal({
        shelfRoot: fixture.shelfRoot,
        expectedShelfId: fixture.shelfId,
        coordinationRoot: fixture.coordinationRoot
      });
      expect(priorJournal).toHaveLength(1);
      expect(priorJournal[0]!.record.requestId).toBe(prior.requestId);
      expect(priorJournal[0]!.record.state).toBe("committed");

      const service = new LibraryService();
      try {
        const owner = {};
        const opened = await service.openPrivateShelfForOwner(owner, fixture.shelfRoot);
        expect(opened.kind).toBe("opened");
        if (opened.kind !== "opened") throw new Error("The existing Shelf citation must remain readable.");
        const records = service.getRecordsForOwner(owner, opened.library.libraryId);
        expect(records.kind).toBe("records");
        if (records.kind !== "records") throw new Error("The existing Shelf records must remain readable.");
        expect(records.records.map((record) => record.quote)).toEqual(["保存済みの引用。"]);
        const search = service.searchForOwner(owner, opened.library.libraryId, "保存済みの引用");
        expect(search.kind).toBe("results");
        if (search.kind !== "results") throw new Error("The existing Shelf quote must remain searchable.");
        expect(search.results).toHaveLength(1);
        expect(service.searchForOwner(owner, opened.library.libraryId, "拒否される新規引用")).toMatchObject({
          kind: "results",
          results: []
        });
      } finally {
        service.dispose();
      }
    }
  });

  test("the recovery record is not a journal record", async () => {
    const fixture = await createFixture("recovery-not-journal");
    const { requestId } = await (async () => {
      const command = request(fixture);
      await commitShelfQuote(command);
      return { requestId: command.requestId };
    })();
    await writeShelfWriterRecoveryState({
      coordinationDirectory: coordinationDirectory(fixture),
      requestId: "req-interrupted"
    });
    const entries = await inspectShelfWriteJournal({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(entries.map((entry) => entry.record.requestId)).toEqual([requestId]);
  });
});

mutexSuite("recovery marker file safety", () => {
  const symlinkTest = symlinkSupport ? test : test.skip;
  const hardlinkTest = hardlinkSupport ? test : test.skip;
  const junctionTest = process.platform === "win32" ? test : test.skip;

  function coordinationDirectory(fixture: Awaited<ReturnType<typeof createFixture>>): string {
    return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase());
  }

  function markerPath(fixture: Awaited<ReturnType<typeof createFixture>>): string {
    return path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME);
  }

  symlinkTest("a symlink marker is refused and its external sentinel is untouched", async () => {
    const fixture = await createFixture("marker-symlink");
    const directory = coordinationDirectory(fixture);
    await mkdir(directory, { recursive: true });
    const sentinel = path.join(fixture.base, "external-sentinel.txt");
    await writeFile(sentinel, "SENTINEL-DO-NOT-TOUCH\n", "utf8");
    await symlink(sentinel, markerPath(fixture));

    await expect(
      writeShelfWriterRecoveryState({ coordinationDirectory: directory, requestId: "req-symlink" })
    ).rejects.toMatchObject({ code: "shelf-write-recovery-state-unavailable" });
    await expect(inspectShelfWriterRecoveryState(directory)).rejects.toMatchObject({
      code: "shelf-write-recovery-state-unavailable"
    });
    // The whole write is refused, not just the marker update.
    await expect(
      commitShelfQuoteWithNativeLock(request(fixture), { acquireTimeoutMs: 2_000 })
    ).rejects.toMatchObject({ code: "shelf-write-recovery-state-unavailable" });

    // Neither truncation nor deletion reached the link target.
    expect(await readFile(sentinel, "utf8")).toBe("SENTINEL-DO-NOT-TOUCH\n");
    expect((await lstat(markerPath(fixture))).isSymbolicLink()).toBe(true);
    expect(await readdir(fixture.annotationsDirectory)).toEqual([]);
    expect(await readdir(fixture.booksDirectory)).toEqual([]);
  });

  junctionTest("a junction at the marker path is refused and its target is untouched", async () => {
    const fixture = await createFixture("marker-junction");
    const externalDirectory = path.join(fixture.base, "external-target");
    await mkdir(externalDirectory, { recursive: true });
    const sentinel = path.join(externalDirectory, "sentinel.txt");
    await writeFile(sentinel, "SENTINEL\n", "utf8");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    await symlink(externalDirectory, markerPath(fixture), "junction");

    await expect(
      writeShelfWriterRecoveryState({
        coordinationDirectory: coordinationDirectory(fixture),
        requestId: "req-junction"
      })
    ).rejects.toMatchObject({ code: "shelf-write-recovery-state-unavailable" });
    await expect(inspectShelfWriterRecoveryState(coordinationDirectory(fixture))).rejects.toMatchObject({
      code: "shelf-write-recovery-state-unavailable"
    });

    expect(await readFile(sentinel, "utf8")).toBe("SENTINEL\n");
    expect((await lstat(markerPath(fixture))).isSymbolicLink()).toBe(true);
  });

  test("a directory at the marker path is refused", async () => {
    const fixture = await createFixture("marker-directory");
    await mkdir(markerPath(fixture), { recursive: true });

    await expect(
      writeShelfWriterRecoveryState({
        coordinationDirectory: coordinationDirectory(fixture),
        requestId: "req-directory"
      })
    ).rejects.toMatchObject({ code: "shelf-write-recovery-state-unavailable" });
    expect((await lstat(markerPath(fixture))).isDirectory()).toBe(true);
  });

  hardlinkTest("a valid marker is replaced without modifying its hardlinked sentinel", async () => {
    const fixture = await createFixture("marker-hardlink");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    const sentinel = path.join(fixture.base, "hardlink-sentinel.txt");
    await writeShelfWriterRecoveryState({
      coordinationDirectory: coordinationDirectory(fixture),
      requestId: "req-hardlink-original"
    });
    const originalMarker = await readFile(markerPath(fixture));
    // The sentinel is a second name for the marker's inode. Truncating in place would
    // destroy the sentinel; replacing the directory entry must not.
    await link(markerPath(fixture), sentinel);

    await writeShelfWriterRecoveryState({
      coordinationDirectory: coordinationDirectory(fixture),
      requestId: "req-hardlink"
    });

    expect(await readFile(sentinel)).toEqual(originalMarker);
    const written = JSON.parse(await readFile(markerPath(fixture), "utf8"));
    expect(written.state).toBe("write-in-progress");
    expect(written.requestId).toBe("req-hardlink");
  });

  test("a half-written marker temp file never replaces the pending state", async () => {
    const fixture = await createFixture("marker-interrupted-update");
    const directory = coordinationDirectory(fixture);
    await mkdir(directory, { recursive: true });
    await writeShelfWriterRecoveryState({ coordinationDirectory: directory, requestId: "req-original" });

    // Shape of a crash during a marker update: complete new bytes in a temp file, the
    // final path untouched. Recovery must still point at the original pending request.
    const leftover = path.join(directory, `.${SHELF_WRITER_RECOVERY_STATE_FILENAME}.9999-${randomUUID()}.tmp`);
    await writeFile(
      leftover,
      `${JSON.stringify({ version: 1, state: "write-in-progress", pid: 9999, requestId: "req-new", startedAt: new Date().toISOString() })}\n`,
      "utf8"
    );

    const state = await inspectShelfWriterRecoveryState(directory);
    expect(state.pending).toBe(true);
    expect(state.record?.requestId).toBe("req-original");
  });
});

mutexSuite("request validation happens before the recovery marker (D071)", () => {
  function coordinationDirectory(fixture: Awaited<ReturnType<typeof createFixture>>): string {
    return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase());
  }

  async function journalNames(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string[]> {
    return (await readdir(fixture.journalDirectory).catch(() => [])).sort();
  }

  async function markerNames(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string[]> {
    return (await readdir(coordinationDirectory(fixture)).catch(() => []))
      .filter((name) => name.includes(SHELF_WRITER_RECOVERY_STATE_FILENAME));
  }

  test.each([
    ["blank quote", { quote: "   " }],
    ["non-http URL", { url: "file:///etc/passwd" }],
    ["month out of range", { getDate: "202613011200" }],
    ["minute out of range", { getDate: "202610301260" }],
    ["malformed getDate", { getDate: "2026-10-30" }],
    ["empty author", { authors: [""] }],
    ["unknown comment field", { commentField: "other" as never }]
  ])("a rejected request (%s) leaves no marker and no journal record", async (_label, overrides) => {
    const fixture = await createFixture("validate-first");
    await expect(commitShelfQuoteWithNativeLock(request(fixture, overrides as Partial<ShelfQuoteWriteRequest>), { acquireTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "shelf-write-invalid-request" });
    expect(await markerNames(fixture)).toEqual([]);
    expect(await journalNames(fixture)).toEqual([]);
    expect(await readdir(fixture.booksDirectory)).toEqual([]);
    expect(await readdir(fixture.annotationsDirectory)).toEqual([]);
  });

  test("resending a request ID with different content is rejected without a marker or journal change", async () => {
    const fixture = await createFixture("validate-digest");
    const first = request(fixture);
    const receipt = await commitShelfQuoteWithNativeLock(first, { acquireTimeoutMs: 2_000 });
    expect(receipt.state).toBe("committed");
    const journalFile = path.join(fixture.journalDirectory, `${first.requestId}.json`);
    const before = await readFile(journalFile, "utf8");

    await expect(commitShelfQuoteWithNativeLock({ ...first, quote: "別の本文。" }, { acquireTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "shelf-write-request-mismatch" });

    expect(await readFile(journalFile, "utf8")).toBe(before);
    expect(await markerNames(fixture)).toEqual([]);
    expect((await readdir(fixture.annotationsDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    // The original request still replays as already-committed.
    expect((await commitShelfQuoteWithNativeLock(first, { acquireTimeoutMs: 2_000 })).state).toBe("already-committed");
  });

  test("an already-committed replay leaves no marker", async () => {
    const fixture = await createFixture("validate-replay");
    const first = request(fixture);
    await commitShelfQuoteWithNativeLock(first, { acquireTimeoutMs: 2_000 });
    const replay = await commitShelfQuoteWithNativeLock(first, { acquireTimeoutMs: 2_000 });
    expect(replay.state).toBe("already-committed");
    expect(await markerNames(fixture)).toEqual([]);
  });

  test("a real in-flight failure still leaves the marker, written before the journal and Book", async () => {
    const fixture = await createFixture("validate-inflight");
    const interrupted = request(fixture, {
      faults: { beforeAnnotationPublish: () => { throw new Error("injected in-flight failure"); } }
    });
    await expect(commitShelfQuoteWithNativeLock(interrupted, { acquireTimeoutMs: 2_000 }))
      .rejects.toThrow("injected in-flight failure");
    const marker = await inspectShelfWriterRecoveryState(coordinationDirectory(fixture));
    expect(marker.pending).toBe(true);
    expect(marker.record?.requestId).toBe(interrupted.requestId);
    expect(await journalNames(fixture)).toEqual([`${interrupted.requestId}.json`]);
    expect((await readdir(fixture.booksDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  async function leaveInterrupted(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<ShelfQuoteWriteRequest> {
    const interrupted = request(fixture, {
      faults: { beforeAnnotationPublish: () => { throw new Error("injected in-flight failure"); } }
    });
    await expect(commitShelfQuoteWithNativeLock(interrupted, { acquireTimeoutMs: 2_000 })).rejects.toThrow();
    return interrupted;
  }

  test("a request rejected by validation leaves the existing marker and journal byte for byte unchanged", async () => {
    const fixture = await createFixture("validate-preserve");
    const interrupted = await leaveInterrupted(fixture);
    const markerFile = path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME);
    const journalFile = path.join(fixture.journalDirectory, `${interrupted.requestId}.json`);
    const markerBefore = await readFile(markerFile, "utf8");
    const journalBefore = await readFile(journalFile, "utf8");
    const retry = { ...interrupted };
    delete (retry as { faults?: unknown }).faults;
    // Same request ID (the recovery gate passes) with different content: digest conflict.
    await expect(commitShelfQuoteWithNativeLock({ ...retry, quote: "別の本文。" }, { acquireTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "shelf-write-request-mismatch" });
    // Same request ID with an invalid getDate: shape validation.
    await expect(commitShelfQuoteWithNativeLock({ ...retry, getDate: "202613011200" }, { acquireTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "shelf-write-invalid-request" });
    expect(await readFile(markerFile, "utf8")).toBe(markerBefore);
    expect(await readFile(journalFile, "utf8")).toBe(journalBefore);
    expect(await journalNames(fixture)).toEqual([`${interrupted.requestId}.json`]);
  });

  test("a marker over a fully committed journal is preserved when a new request is rejected by validation", async () => {
    const fixture = await createFixture("validate-committed-marker");
    await commitShelfQuoteWithNativeLock(request(fixture), { acquireTimeoutMs: 2_000 });
    const marker = {
      version: 1, state: "write-in-progress", pid: 4242, requestId: "req-left-over-1", startedAt: new Date().toISOString()
    };
    const markerFile = path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME);
    await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    const markerBefore = await readFile(markerFile, "utf8");
    const journalBefore = await journalNames(fixture);
    await expect(commitShelfQuoteWithNativeLock(request(fixture, { getDate: "202613011200" }), { acquireTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "shelf-write-invalid-request" });
    expect(await readFile(markerFile, "utf8")).toBe(markerBefore);
    expect(await journalNames(fixture)).toEqual(journalBefore);
  });

  test("a corrupt marker plus an invalid request fails closed (#92) and the marker is untouched", async () => {
    const fixture = await createFixture("validate-corrupt-marker");
    await commitShelfQuoteWithNativeLock(request(fixture), { acquireTimeoutMs: 2_000 });
    const markerFile = path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME);
    await writeFile(markerFile, "{ not json", "utf8");
    await expect(commitShelfQuoteWithNativeLock(request(fixture, { getDate: "202613011200" }), { acquireTimeoutMs: 2_000 }))
      .rejects.toMatchObject({ code: "shelf-write-recovery-state-invalid" });
    expect(await readFile(markerFile, "utf8")).toBe("{ not json");
  });

  test("commitShelfQuote writes nothing when beforeMutation throws", async () => {
    const fixture = await createFixture("before-mutation-throws");
    await expect(commitShelfQuote(request(fixture, { beforeMutation: async () => { throw new Error("marker unavailable"); } })))
      .rejects.toThrow("marker unavailable");
    expect(await journalNames(fixture)).toEqual([]);
    expect(await readdir(fixture.booksDirectory)).toEqual([]);
    expect(await readdir(fixture.annotationsDirectory)).toEqual([]);
  });

  test("an abandoned mutex with a staged request and no marker keeps its evidence when the retry fails before any mutation", async () => {
    const fixture = await createFixture("abandoned-no-marker");
    const staged = await leaveInterrupted(fixture);
    const markerFile = path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME);
    // The crash left no marker: only the abandoned mutex reveals the interrupted write.
    await rm(markerFile);
    expect((await inspectShelfWriterRecoveryState(coordinationDirectory(fixture))).pending).toBe(false);
    // Make the mutex abandoned: another thread acquires it and exits without releasing.
    const probe = await acquireShelfMutex({ shelfId: fixture.shelfId, acquireTimeoutMs: 500 });
    probe.release();
    const binary = path.join(process.cwd(), "native", "shelf-mutex", "build", "Release", "shelf_mutex.node");
    // A killed process leaves the kernel mutex abandoned (a worker thread would not).
    const name = resolveShelfMutexName(fixture.shelfId);
    const child = spawn(process.execPath, ["-e",
      `const a=require(${JSON.stringify(binary)});const h=a.createMutex(${JSON.stringify(name)});`
      + "console.log(JSON.stringify(a.acquire(h,1000)));setInterval(()=>{},1000)"]);
    const acquired = await new Promise<{ acquired: boolean }>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString()) as { acquired: boolean }));
      child.once("error", reject);
    });
    expect(acquired.acquired).toBe(true);
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });

    // Resend the same request ID with different content: the gate passes, validation fails.
    const retry = { ...staged };
    delete (retry as { faults?: unknown }).faults;
    const reported: string[] = [];
    await expect(commitShelfQuoteWithNativeLock({ ...retry, quote: "別の本文。" }, {
      acquireTimeoutMs: 2_000,
      onRecovery: (assessment, info) => { reported.push(`${info.trigger}:${assessment.interruptedRequestIds.join(",")}`); }
    })).rejects.toMatchObject({ code: "shelf-write-request-mismatch" });
    expect(reported).toEqual([`abandoned:${staged.requestId}`]);
    // The evidence was re-recorded and the mutex stays held, so no later writer slips past.
    const marker = await inspectShelfWriterRecoveryState(coordinationDirectory(fixture));
    expect(marker.pending).toBe(true);
    expect(marker.record?.requestId).toBe(staged.requestId);
    await expect(acquireShelfMutex({ shelfId: fixture.shelfId, acquireTimeoutMs: 200 }))
      .rejects.toMatchObject({ code: "shelf-write-busy" });
  });
});

mutexSuite("recovery assessment scans the Shelf once", () => {
  const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function suffix(index: number): string {
    let rest = index;
    let out = "";
    for (let i = 0; i < 6; i += 1) { out = BASE32[rest % 32]! + out; rest = Math.floor(rest / 32); }
    return out;
  }

  async function buildSyntheticShelf(entries: number, annotations: number): Promise<Awaited<ReturnType<typeof createFixture>>> {
    const fixture = await createFixture(`scan-${entries}`);
    const template = request(fixture);
    await commitShelfQuote(template);
    const bookFile = (await readdir(fixture.booksDirectory))[0]!;
    const annotationFile = (await readdir(fixture.annotationsDirectory))[0]!;
    const book = JSON.parse(await readFile(path.join(fixture.booksDirectory, bookFile), "utf8")) as Record<string, unknown>;
    const annotation = JSON.parse(await readFile(path.join(fixture.annotationsDirectory, annotationFile), "utf8")) as Record<string, unknown>;
    const journalFile = path.join(fixture.journalDirectory, `${template.requestId}.json`);
    const journal = JSON.parse(await readFile(journalFile, "utf8")) as Record<string, unknown>;
    const prefix = String(book.id).slice("book:".length, "book:".length + 20);
    const idFor = (kind: "book" | "ann", index: number): string => `${kind}:${prefix}${suffix(index)}`;
    // Replace the real records with synthetic ones so every ID is distinct and well formed.
    await rm(path.join(fixture.booksDirectory, bookFile));
    await rm(path.join(fixture.annotationsDirectory, annotationFile));
    await rm(journalFile);
    for (let index = 0; index < Math.max(entries, annotations); index += 1) {
      const bookId = idFor("book", index);
      const annotationId = idFor("ann", index);
      if (index < entries) {
        await writeFile(path.join(fixture.booksDirectory, `${index}.json`), `${JSON.stringify({ ...book, id: bookId, url: `https://example.test/${index}` }, null, 2)}\n`, "utf8");
      }
      if (index < annotations) {
        const body = `${JSON.stringify({ ...annotation, id: annotationId, source: { ...(annotation.source as object), id: bookId } }, null, 2)}\n`;
        await writeFile(path.join(fixture.annotationsDirectory, `${index}.json`), body, "utf8");
        if (index < entries) {
          const requestId = `req-synthetic-${String(index).padStart(5, "0")}`;
          await writeFile(path.join(fixture.journalDirectory, `${requestId}.json`), `${JSON.stringify({
            ...journal,
            requestId,
            bookId,
            annotationId,
            annotationDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`
          }, null, 2)}\n`, "utf8");
        }
      }
    }
    return fixture;
  }

  /** Counts every call that reaches `listShelfRecordFiles`, whichever code path makes it. */
  async function assess(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<{ scans: number; committed: number }> {
    const lister = vi.mocked(listShelfRecordFiles);
    lister.mockClear();
    const assessment = await assessShelfWriteRecoveryState({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    return { scans: lister.mock.calls.length, committed: assessment.committedRequestIds.length };
  }

  test("directory scans do not grow with the journal size", async () => {
    const small = await assess(await buildSyntheticShelf(20, 40));
    const large = await assess(await buildSyntheticShelf(300, 600));
    expect(small.committed).toBe(20);
    expect(large.committed).toBe(300);
    // One Book scan and one Annotation scan per assessment, whatever the journal size.
    expect(small.scans).toBe(2);
    expect(large.scans).toBe(2);
  }, 180_000);
});

afterEach(async () => {
  while (created.length > 0) {
    const directory = created.pop()!;
    await rm(directory, { recursive: true, force: true });
  }
});
