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
import { mkdir, mkdtemp, link, lstat, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
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
  commitShelfQuoteWithNativeLock,
  inspectShelfWriterRecoveryState,
  writeShelfWriterRecoveryState
} from "./shelf-native-write-lock.js";
import {
  commitShelfQuote,
  inspectShelfWriteJournal,
  type ShelfQuoteWriteRequest
} from "./shelf-write-coordination.js";

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

  test("a truncated recovery record still counts as pending", async () => {
    const fixture = await createFixture("recovery-truncated");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    await writeFile(
      path.join(coordinationDirectory(fixture), SHELF_WRITER_RECOVERY_STATE_FILENAME),
      "{\"version\": 1,",
      "utf8"
    );
    const state = await inspectShelfWriterRecoveryState(coordinationDirectory(fixture));
    expect(state.pending).toBe(true);
    expect(state.record).toBeUndefined();
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

  hardlinkTest("an existing regular marker is replaced without modifying a hardlinked sentinel", async () => {
    const fixture = await createFixture("marker-hardlink");
    await mkdir(coordinationDirectory(fixture), { recursive: true });
    const sentinel = path.join(fixture.base, "hardlink-sentinel.txt");
    await writeFile(sentinel, "SENTINEL\n", "utf8");
    // The marker is a second name for the sentinel's inode. Truncating it in place would
    // destroy the sentinel; replacing the directory entry must not.
    await link(sentinel, markerPath(fixture));

    await writeShelfWriterRecoveryState({
      coordinationDirectory: coordinationDirectory(fixture),
      requestId: "req-hardlink"
    });

    expect(await readFile(sentinel, "utf8")).toBe("SENTINEL\n");
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

afterEach(async () => {
  while (created.length > 0) {
    const directory = created.pop()!;
    await rm(directory, { recursive: true, force: true });
  }
});
