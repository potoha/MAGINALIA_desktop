/**
 * Real-child-process driver for the Windows named-mutex Shelf write lock.
 *
 * Test-only. Not packaged and not registered as a Native Messaging Host. It
 * exercises the compiled spike modules (`dist/main/shelf-native-mutex.js`,
 * `dist/main/shelf-native-write-lock.js`) from ordinary OS processes so that
 * exclusion, abandonment, crash recovery and lost-update behavior are proven
 * between processes rather than between in-process stubs.
 *
 * Commands (one per spawned process):
 *   participant          open a mutex handle and keep it (never acquire), then wait
 *   holdMutexMs          acquire the mutex, hold it, assert it, release it
 *   holdMutexAndCrash    acquire the mutex and wait to be killed by the parent
 *   tryAcquire           try to acquire once with a bounded timeout
 *   counter               read-modify-write a counter N times under the mutex
 *   crashAfterBookHold   publish the Book, keep the mutex, then wait to be killed
 *   (default)            commit one Collector web quote under the mutex
 *
 * `crashAfterBook` (a `process.exit` between Book and Annotation) is also supported.
 * `process.exit` skips environment teardown, so the addon finalizers do not run and the
 * mutex is usually left abandoned (or destroyed with the process); `exitNaturally: true`
 * makes a failure path set `process.exitCode` instead, so the environment does tear down
 * and the finalizer releases the lock cleanly. Both are exercised.
 */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const commandFile = process.argv[2];
if (typeof commandFile !== "string") {
  process.stdout.write(`${JSON.stringify({ ok: false, code: "missing-command" })}\n`);
  process.exit(2);
}

const mainDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main");
const command = JSON.parse(await readFile(commandFile, "utf8"));

const mutex = require(path.join(mainDirectory, "shelf-native-mutex.js"));
const nativeLock = require(path.join(mainDirectory, "shelf-native-write-lock.js"));
const shelfWriteCore = require(path.join(mainDirectory, "shelf-write-core.js"));

// Inject crash barriers before loading the Reviewer modules. Their CommonJS import
// namespaces then resolve the same test-only wrapped filesystem export used by the
// exact production transaction path. No production flag or test hook is added.
if ((command.mode === "reviewerCrashAtBoundary" || command.mode === "reviewerApprovalCrashAtBoundary")
  && (command.boundary === "before-asset" || command.boundary === "after-annotation-before-receipt")) {
  const publish = shelfWriteCore.publishShelfFileNoReplace;
  let paused = false;
  shelfWriteCore.publishShelfFileNoReplace = async (target, contents) => {
    const absoluteTarget = path.resolve(target);
    // The test temp folder may be on another volume than the checkout, so
    // path.relative(shelfRoot, target) is not a usable discriminator on Windows.
    const targetParts = absoluteTarget.split(path.sep).map((part) => part.toLowerCase());
    const sourcesIndex = targetParts.lastIndexOf("sources");
    const isSourceAsset = sourcesIndex >= 0 && /^[a-f0-9]{64}$/.test(targetParts[sourcesIndex + 1] ?? "");
    const isAnnotation = typeof command.annotationsDirectory === "string"
      && path.basename(path.dirname(absoluteTarget)).toLowerCase() === "annotations"
      && path.basename(absoluteTarget).toLowerCase().startsWith("ann-")
      && path.basename(absoluteTarget).toLowerCase().endsWith(".json");
    if (!paused && command.boundary === "before-asset" && isSourceAsset) {
      paused = true;
      await pauseAtReviewerBoundary("staged-before-asset");
    }
    const state = await publish(target, contents);
    if (!paused && command.boundary === "after-annotation-before-receipt" && isAnnotation) {
      paused = true;
      await pauseAtReviewerBoundary(command.boundary);
    }
    return state;
  };
}

const coordination = require(path.join(mainDirectory, "shelf-write-coordination.js"));
if ((command.mode === "reviewerCrashAtBoundary" || command.mode === "reviewerApprovalCrashAtBoundary")
  && (command.boundary === "before-annotation" || command.boundary === "after-receipt")) {
  const commit = coordination.commitShelfRecordTransaction;
  coordination.commitShelfRecordTransaction = async (request) => commit({
    ...request,
    ...(command.boundary === "before-annotation"
      ? { beforeAnnotationPublish: async () => pauseAtReviewerBoundary(command.boundary) }
      : { afterReceipt: async (receipt) => pauseAtReviewerBoundary(command.boundary, receipt) })
  });
}
const reviewerMaterializer = require(path.join(mainDirectory, "reviewer-shelf-materializer.js"));

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reportFailure(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
  emit({ ok: false, code, message: String(error && error.message ? error.message : error) });
  const expected = code.startsWith("shelf-write-") || code.startsWith("native-mutex-");
  const exitCode = expected ? 3 : 1;
  if (command.exitNaturally === true) {
    // Let the event loop drain and the environment tear down normally, which runs the
    // addon finalizers: the process releases the mutex on its way out. `process.exit`
    // skips that teardown, so this is the only way to test a *clean* release after a
    // failed recovery assessment.
    process.exitCode = exitCode;
    return;
  }
  process.exit(exitCode);
}

/** Keep the process alive without holding a lock. */
function stayAlive() {
  setInterval(() => {}, 1_000);
}

function mutexOptions() {
  return {
    shelfId: command.expectedShelfId,
    ...(command.scope === undefined ? {} : { scope: command.scope }),
    ...(command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs }),
    ...(command.pollIntervalMs === undefined ? {} : { pollIntervalMs: command.pollIntervalMs })
  };
}

function reviewerRecordFromCommand() {
  const record = structuredClone(command.reviewerRecord);
  if (Array.isArray(record.sourceFiles)) {
    record.sourceFiles = record.sourceFiles.map((file) => ({
      ...file,
      bytes: Array.isArray(file.bytes) ? Uint8Array.from(file.bytes) : file.bytes
    }));
  }
  return record;
}

function pauseAtReviewerBoundary(boundary, receipt) {
  emit({ ok: true, stage: "reviewer-boundary", boundary, ...(receipt === undefined ? {} : { receipt }), pid: process.pid });
  stayAlive();
  return new Promise(() => {});
}

async function runReviewerMaterialization() {
  const result = await reviewerMaterializer.materializeReviewerRecords(
    command.shelfRoot,
    [reviewerRecordFromCommand()],
    async () => command.metadataLookup ?? ({ status: "not-found" }),
    {
      coordinationRoot: command.coordinationRoot,
      expectedShelfId: command.expectedShelfId,
      ...(command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs })
    }
  );
  emit({ ok: true, result, pid: process.pid });
}

async function runReviewerApprovalPath() {
  const reviewerSync = require(path.join(mainDirectory, "reviewer-shelf-sync.js"));
  const approvalMaterializer = require(path.join(mainDirectory, "reviewer-approval-materializer.js"));
  const folderIdentity = require(path.join(mainDirectory, "folder-identity.js"));
  const bindingStore = require(path.join(mainDirectory, "shelf-binding-store.js"));
  const bindingResolver = require(path.join(mainDirectory, "reviewer-shelf-write-binding.js"));
  const reviewerRecord = reviewerRecordFromCommand();
  let bindingConfirmations = 0;
  const quotation = {
    annotationId: reviewerRecord.annotationId,
    captureId: `capture-${reviewerRecord.annotationId}`,
    pageId: `page-${reviewerRecord.annotationId}`,
    sourcePageId: null,
    isbn13: reviewerRecord.isbn13 ?? null,
    packageId: reviewerRecord.packageId ?? null,
    sourceKind: reviewerRecord.sourceKind ?? null,
    getDate: reviewerRecord.getDate ?? null,
    url: reviewerRecord.url ?? null,
    title: reviewerRecord.title ?? null,
    authors: reviewerRecord.authors ?? [],
    publisher: reviewerRecord.publisher ?? null,
    year: reviewerRecord.year ?? null,
    quote: reviewerRecord.quote,
    pageLabel: reviewerRecord.pageLabel,
    comment: reviewerRecord.comment,
    reviewState: "APPROVED",
    reviewedAtMs: reviewerRecord.reviewedAtMs ?? 1_728_000_000_000
  };
  const synchronize = reviewerSync.createReviewerShelfSyncAdapter({
    baseUrl: "http://127.0.0.1:43127/",
    reviewerFetcher: async () => new Response(JSON.stringify({
      results: [quotation],
      total: 1,
      limit: 100,
      offset: 0
    }), { status: 200 }),
    lookupMetadata: async () => command.metadataLookup ?? ({ status: "not-found" }),
    getWriteCoordination: async () => {
      const marker = await folderIdentity.inspectFolderMarkers(command.shelfRoot);
      if (marker.kind !== "valid" || marker.marker.type !== "shelf") {
        throw new Error("The disposable test Shelf marker is invalid.");
      }
      const coordination = await bindingResolver.resolveReviewerShelfWriteCoordination({
        storagePaths: {
          bindingDirectory: command.bindingDirectory,
          coordinationRoot: command.coordinationRoot
        },
        store: bindingStore.createShelfBindingFileStore(command.bindingDirectory),
        context: {
          shelfName: "Disposable test Shelf",
          shelfRoot: command.shelfRoot,
          shelfLocationPath: command.shelfLocationPath,
          privateShelfLocator: command.shelfRoot,
          typedMarker: marker.marker
        },
        confirmRebind: async () => {
          bindingConfirmations += 1;
          return true;
        },
        reloadConfiguration: async () => command.shelfRoot,
        reloadTypedMarker: async () => marker.marker
      });
      emit({
        ok: true,
        stage: "reviewer-binding",
        expectedShelfId: coordination.expectedShelfId,
        bindingConfirmations
      });
      return coordination;
    }
  });
  const configuredShelf = {
    async getActive() { return { kind: "private-shelf", canonicalRoot: command.shelfRoot }; },
    async reload() {}
  };
  const syncResult = await approvalMaterializer.materializeApprovedReviewerRecords(
    {},
    configuredShelf,
    synchronize
  );
  if (syncResult === null || syncResult.kind !== "completed") {
    throw new Error(syncResult?.error?.message ?? "Reviewer approval sync did not complete.");
  }
  emit({
    ok: true,
    path: "reviewer-approval-sync",
    bindingConfirmations,
    result: {
      materialized: syncResult.materialized,
      unchanged: syncResult.unchanged,
      pending: syncResult.pendingRecords,
      conflicts: syncResult.conflicts
    },
    pid: process.pid
  });
}

if (command.mode === "participant") {
  // Product-shaped participant: the Desktop app / Native Host keeps one handle open
  // for its lifetime so a crash by another participant is observable as abandoned.
  try {
    const opened = mutex.openShelfMutexParticipant(
      command.expectedShelfId,
      command.scope ?? "session"
    );
    emit({ ok: true, ready: true, name: opened.name, pid: process.pid });
    stayAlive();
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "holdMutexMs") {
  try {
    const lease = await mutex.acquireShelfMutex(mutexOptions());
    emit({ ok: true, acquired: true, abandoned: lease.abandoned, pid: process.pid, name: lease.name });
    await new Promise((resolve) => {
      setTimeout(resolve, command.holdMutexMs ?? 2_000);
    });
    let assertedHeld = true;
    try {
      await lease.assertHeld();
    } catch {
      assertedHeld = false;
    }
    lease.release();
    emit({ ok: true, acquired: true, assertedHeld, released: true });
    process.exit(assertedHeld ? 0 : 4);
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "holdMutexAndCrash") {
  try {
    const lease = await mutex.acquireShelfMutex(mutexOptions());
    emit({ ok: true, acquired: true, abandoned: lease.abandoned, pid: process.pid, holding: true });
    // Deliberately never release and never exit: the parent kills this process with
    // TerminateProcess (SIGKILL), which is the only way to produce WAIT_ABANDONED.
    stayAlive();
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "tryAcquire") {
  const startedAt = Date.now();
  try {
    const lease = await mutex.acquireShelfMutex(mutexOptions());
    emit({
      ok: true,
      acquired: true,
      abandoned: lease.abandoned,
      waitedMs: Date.now() - startedAt,
      pid: process.pid
    });
    lease.release();
  } catch (error) {
    emit({
      ok: false,
      code: error && typeof error === "object" ? error.code : "unknown",
      waitedMs: Date.now() - startedAt,
      pid: process.pid
    });
    process.exit(3);
  }
} else if (command.mode === "counter") {
  // Lost-update proof that does not depend on the Shelf writer: every process does a
  // read-modify-write on one JSON counter while holding the OS mutex.
  const counterFile = path.join(command.shelfRoot, "counter.json");
  const iterations = command.iterations ?? 20;
  try {
    for (let index = 0; index < iterations; index += 1) {
      const lease = await mutex.acquireShelfMutex(mutexOptions());
      try {
        let value = 0;
        try {
          value = JSON.parse(await readFile(counterFile, "utf8")).value ?? 0;
        } catch {
          value = 0;
        }
        await writeFile(counterFile, `${JSON.stringify({ value: value + 1 })}\n`, "utf8");
      } finally {
        lease.release();
      }
    }
    emit({ ok: true, iterations, pid: process.pid });
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "crashAfterBookHold") {
  const faults = {
    // Hold the mutex and never publish the Annotation: the parent kills this
    // process, leaving a `staged` journal record, a durable recovery record and an
    // abandoned (or destroyed) mutex. The timer keeps the event loop non-empty so Node
    // does not report an unsettled top-level await and exit on its own (which would
    // release the mutex cleanly).
    beforeAnnotationPublish: () => {
      emit({ ok: true, stage: "book-published", pid: process.pid });
      stayAlive();
      return new Promise(() => {});
    }
  };
  try {
    emit({ ok: true, stage: "starting", pid: process.pid, ...(await recoverySnapshot()) });
    await nativeLock.commitShelfQuoteWithNativeLock(
      {
        ...requestFields(),
        faults
      },
      nativeOptions()
    );
    emit({ ok: false, code: "unexpected-completion" });
    process.exit(9);
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "recoveryState") {
  // Report the persistent recovery record without writing anything.
  try {
    emit({ ok: true, ...(await recoverySnapshot()), pid: process.pid });
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "reviewer") {
  try {
    emit({ ok: true, stage: "starting", ...(await recoverySnapshot()), pid: process.pid });
    await runReviewerMaterialization();
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "reviewerCrashAtBoundary") {
  try {
    const boundary = command.boundary;
    if (!["before-asset", "before-annotation", "after-annotation-before-receipt", "after-receipt"].includes(boundary)) {
      throw new Error("unsupported Reviewer crash boundary");
    }
    emit({ ok: true, stage: "starting", pid: process.pid });
    await runReviewerMaterialization();
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "reviewerApproval") {
  try {
    emit({ ok: true, stage: "starting", ...(await recoverySnapshot()), pid: process.pid });
    await runReviewerApprovalPath();
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "reviewerApprovalCrashAtBoundary") {
  try {
    const boundary = command.boundary;
    if (!["before-annotation", "after-annotation-before-receipt", "after-receipt"].includes(boundary)) {
      throw new Error("unsupported Reviewer approval crash boundary");
    }
    emit({ ok: true, stage: "starting", ...(await recoverySnapshot()), pid: process.pid });
    await runReviewerApprovalPath();
  } catch (error) {
    reportFailure(error);
  }
} else if (command.mode === "createSystemOnly") {
  // DACL evidence: a lock created with a SYSTEM-only descriptor must not be
  // openable by this account, which is the mechanism that keeps another Windows
  // user out of the same Shelf lock name.
  const name = command.name;
  let restricted;
  try {
    restricted = mutex.loadNativeShelfMutex().createMutex(name, { security: "system-only" });
    let secondCode = null;
    try {
      mutex.loadNativeShelfMutex().createMutex(name);
    } catch (error) {
      secondCode = error && typeof error === "object" ? error.code : "unknown";
    }
    emit({ ok: true, secondCreateCode: secondCode });
  } catch (error) {
    reportFailure(error);
  } finally {
    if (restricted !== undefined) {
      try {
        mutex.loadNativeShelfMutex().close(restricted);
      } catch {
        // best effort
      }
    }
  }
} else {
  if (command.crashAfterBook === true) {
    // Orderly exit between Book and Annotation publish: `process.exit` still runs the
    // addon finalizers, so the mutex is released cleanly and the retry sees no
    // abandonment. The staged journal is the only evidence left behind.
    const faults = {
      beforeAnnotationPublish: () => {
        emit({ ok: false, code: "simulated-crash" });
        process.exit(70);
      }
    };
    await commitWithFaults(faults);
  } else {
    await commitWithFaults(undefined);
  }
}

function requestFields() {
  return {
    requestId: command.requestId,
    shelfRoot: command.shelfRoot,
    expectedShelfId: command.expectedShelfId,
    coordinationRoot: command.coordinationRoot,
    quote: command.quote,
    url: command.url,
    getDate: command.getDate,
    ...(command.title === undefined ? {} : { title: command.title }),
    ...(command.authors === undefined ? {} : { authors: command.authors }),
    ...(command.comment === undefined ? {} : { comment: command.comment }),
    ...(command.commentField === undefined ? {} : { commentField: command.commentField }),
    processLabel: command.processLabel ?? "poc-native-worker"
  };
}

function nativeOptions() {
  return {
    ...(command.scope === undefined ? {} : { scope: command.scope }),
    ...(command.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: command.acquireTimeoutMs }),
    ...(command.pollIntervalMs === undefined ? {} : { pollIntervalMs: command.pollIntervalMs }),
    onRecovery: (assessment, info) => {
      emit({
        ok: true,
        abandoned: info.trigger === "abandoned",
        recovery: {
          trigger: info.trigger,
          interruptedRequestIds: assessment.interruptedRequestIds,
          committedRequestIds: assessment.committedRequestIds
        },
        pid: process.pid
      });
    }
  };
}

/**
 * Mutex-object and recovery-record state, reported before a write.
 *
 * `mutex.createdFresh === true` is the key evidence for the "Desktop absent, Host
 * killed, restart" case: the previous mutex object was destroyed with the last
 * participant, so no abandonment can be reported and the recovery record is the only
 * thing that can make the new process verify the journal.
 */
async function recoverySnapshot() {
  const mutexInfo = mutex.inspectShelfMutex(command.expectedShelfId, command.scope ?? "session");
  let recoveryState;
  try {
    const layout = await coordination.resolveShelfWriteLayout({
      shelfRoot: command.shelfRoot,
      expectedShelfId: command.expectedShelfId,
      coordinationRoot: command.coordinationRoot
    });
    const state = await nativeLock.inspectShelfWriterRecoveryState(layout.coordinationDirectory);
    recoveryState = {
      pending: state.pending,
      requestId: state.record === undefined ? null : state.record.requestId
    };
  } catch (error) {
    recoveryState = { error: error && typeof error === "object" && error.code ? error.code : "unknown" };
  }
  return {
    mutex: {
      name: mutexInfo.name,
      createdFresh: mutexInfo.createdFresh,
      abandoned: mutexInfo.abandoned,
      owned: mutexInfo.owned
    },
    recoveryState
  };
}

async function commitWithFaults(faults) {
  try {
    emit({ ok: true, stage: "starting", pid: process.pid, ...(await recoverySnapshot()) });
    const receipt = await nativeLock.commitShelfQuoteWithNativeLock(
      { ...requestFields(), ...(faults === undefined ? {} : { faults }) },
      nativeOptions()
    );
    emit({ ok: true, receipt });
  } catch (error) {
    reportFailure(error);
  }
}
