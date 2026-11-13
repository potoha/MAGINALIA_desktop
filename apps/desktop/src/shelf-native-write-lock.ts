/**
 * Writing a Private Shelf record while holding the Windows named mutex.
 *
 * A mutex protects the critical section; it says nothing about whether the bytes on
 * disk are sane. A writer can die in two different ways, and both must be handled:
 *
 * 1. **Another participant is alive** (Desktop Reviewer or the isolated test Host). The mutex
 *    object survives, so the next writer receives `WAIT_ABANDONED`.
 * 2. **No participant is alive** (Desktop closed, the Host is the only process and is
 *    killed). The last handle dies with it, the mutex object is destroyed, and the
 *    next process creates a brand-new mutex — which reports neither abandonment nor
 *    any other hint that a write was in flight.
 *
 * Case 2 is why the mutex alone is not enough. Before the critical section starts, the
 * writer durably records `writer-recovery.json` in the Shelf's coordination directory
 * and removes it only after the receipt is committed. That record is the persistent
 * recovery state:
 *
 * - record absent  → the previous native-lock write (if any) finished; no journal scan
 *   is needed, so the normal path stays O(1);
 * - a valid record present → a write was in flight and did not finish, **whatever the
 *   mutex says**, so the journal is verified before anything is written;
 * - a malformed, empty, unreadable or non-regular marker → preserve it and fail closed
 *   for new writes; a clean journal cannot explain invalid marker evidence;
 * - `WAIT_ABANDONED` → verify the journal even when the record is absent.
 *
 * Verification on recovery (`assessShelfWriteRecoveryState`) is read-only and fails
 * closed:
 *
 * 1. re-resolve the Shelf layout (marker identity, `library.json`, realpath and
 *    `dev`/`ino` fingerprints) — a swapped or mismatched Shelf fails closed;
 * 2. strictly validate every journal record — a damaged journal fails closed, and it
 *    is never repaired or deleted;
 * 3. require every `committed` receipt to still match its Book and Annotation;
 * 4. allow a `staged` record only when the Annotation is absent (the previous writer
 *    died before the commit point) or present with the recorded digest (it died after
 *    the commit point, so the retry only has to write the receipt).
 *
 * A failed verification leaves the recovery record in place and keeps the mutex held.
 * Releasing the mutex would be harmless on its own (the record is what makes the next
 * process verify), but keeping it held prevents the failing process from writing again
 * and makes the "restart required" state explicit. Files are never mutated, repaired,
 * or deleted by any of this.
 *
 * The marker file is treated as a security boundary, not as an ordinary file:
 *
 * - the final path is never opened for writing. A private temp file is created in the
 *   same directory with `O_CREAT | O_EXCL` and published with `rename`, so a symlink or
 *   hardlink planted at the marker path is replaced as a *directory entry* and its
 *   target is never written through;
 * - an existing marker must be a regular file and not a reparse point. A symlink,
 *   junction, directory or device at that path is refused instead of followed;
 * - deletion uses `unlink` after the same check, so it never removes a link target;
 * - a crash during a marker update can only leave the previous complete marker or the
 *   new complete marker; the temp file is never mistaken for evidence. A crash before
 *   the marker is published happens before the first journal write, so treating it as
 *   clean is correct.
 *
 * The Desktop Reviewer and the product Collector Native Messaging Host both use this
 * wrapper. The marker is published only after pure request validation and immediately
 * before the first journal or Shelf mutation, and a receipt is returned only after the
 * marker has been cleared. Host v1 journal records remain readable alongside the
 * Reviewer v2 extension.
 */
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  ShelfWriteCoordinationError,
  commitShelfRecordTransaction,
  commitShelfQuote,
  inspectShelfWriteJournal,
  resolveShelfWriteLayout,
  type ShelfRecordFileLister,
  type ShelfRecordWriteTransactionRequest,
  type ShelfQuoteWriteReceipt,
  type ShelfQuoteWriteRequest,
  type ShelfWriteLayout
} from "./shelf-write-coordination.js";
import {
  acquireShelfMutex,
  type ShelfMutexLease,
  type ShelfMutexScope
} from "./shelf-native-mutex.js";

/**
 * Name of the durable "a write is in progress" record inside the Shelf's
 * coordination directory (`<coordination>/shelves/<uuid>/`).
 *
 * It lives next to `requests/`, never inside it, so journal enumeration is unchanged.
 */
export const SHELF_WRITER_RECOVERY_STATE_FILENAME = "writer-recovery.json";

export interface ShelfWriterRecoveryState {
  readonly version: 1;
  readonly state: "write-in-progress";
  readonly pid: number;
  readonly requestId: string;
  readonly startedAt: string;
}

export type InspectedShelfWriterRecoveryState =
  | { readonly path: string; readonly pending: false; readonly record?: never }
  | { readonly path: string; readonly pending: true; readonly record: ShelfWriterRecoveryState };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryStateUnavailable(message: string, detail: string): ShelfWriteCoordinationError {
  return new ShelfWriteCoordinationError("shelf-write-recovery-state-unavailable", message, detail);
}

function recoveryStateInvalid(file: string, detail: string): ShelfWriteCoordinationError {
  return new ShelfWriteCoordinationError(
    "shelf-write-recovery-state-invalid",
    "The Shelf write recovery marker is malformed; preserving it and refusing new writes.",
    `${file}: ${detail}`
  );
}

interface MarkerPathInspection {
  readonly kind: "absent" | "regular";
}

/**
 * Classify the marker path **without following it**.
 *
 * `lstat` reports the directory entry itself, so a symlink or junction is visible as
 * such. Only a missing path or a regular file is acceptable; everything else is refused
 * before any read, replace or delete can touch a link target.
 */
async function inspectMarkerPath(file: string): Promise<MarkerPathInspection> {
  let info;
  try {
    info = await lstat(file);
  } catch (error: unknown) {
    if (isMissing(error)) return Object.freeze({ kind: "absent" as const });
    throw recoveryStateUnavailable(
      "The Shelf write recovery state path cannot be inspected.",
      describe(error)
    );
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw recoveryStateUnavailable(
      "The Shelf write recovery state is not a regular file; refusing to read, replace or delete it.",
      file
    );
  }
  return Object.freeze({ kind: "regular" as const });
}

/**
 * Read the persistent recovery state.
 *
 * Only a genuinely absent marker is a clean state. Existing content must be a valid
 * versioned record; malformed or unreadable evidence throws before recovery can clear or
 * replace it. A non-regular entry fails closed instead of being followed.
 */
export async function inspectShelfWriterRecoveryState(
  coordinationDirectory: string
): Promise<InspectedShelfWriterRecoveryState> {
  return inspectRecoveryMarkerFile(path.join(coordinationDirectory, SHELF_WRITER_RECOVERY_STATE_FILENAME));
}

async function inspectRecoveryMarkerFile(file: string): Promise<InspectedShelfWriterRecoveryState> {
  const entry = await inspectMarkerPath(file);
  if (entry.kind === "absent") return Object.freeze({ path: file, pending: false });
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error: unknown) {
    const reason = isMissing(error)
      ? "The marker disappeared while it was being read."
      : describe(error);
    throw recoveryStateUnavailable("The Shelf write recovery marker cannot be read safely.", `${file}: ${reason}`);
  }
  return parseShelfWriterRecoveryBytes(file, bytes);
}

function parseShelfWriterRecoveryBytes(file: string, bytes: Uint8Array): Extract<InspectedShelfWriterRecoveryState, { pending: true }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw recoveryStateInvalid(file, "The marker is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw recoveryStateInvalid(file, "The marker must be a JSON object.");
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1
    || value.state !== "write-in-progress"
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(value.requestId)
    || typeof value.startedAt !== "string"
    || !ISO_TIMESTAMP_PATTERN.test(value.startedAt)
    || !Number.isFinite(Date.parse(value.startedAt))
    || new Date(value.startedAt).toISOString() !== value.startedAt) {
    throw recoveryStateInvalid(file, "The marker does not match the version 1 in-progress schema.");
  }
  const record: ShelfWriterRecoveryState = Object.freeze({
    version: 1,
    state: "write-in-progress",
    pid: value.pid as number,
    requestId: value.requestId,
    startedAt: value.startedAt
  });
  return Object.freeze({ path: file, pending: true, record });
}

/**
 * Durably record that a write is starting.
 *
 * The record is synced before the critical section begins, so a crash anywhere after
 * this point leaves evidence behind even when the mutex object itself is destroyed.
 *
 * The marker is never written through its final path. A private temp file is created
 * with `O_EXCL` (so it cannot follow a pre-planted link) and published with `rename`,
 * which replaces the directory entry only. A crash therefore leaves either the previous
 * complete marker, the new complete marker, or — when the marker did not exist yet — no
 * marker at all, which is correct because the journal write has not started.
 */
export async function writeShelfWriterRecoveryState(options: {
  readonly coordinationDirectory: string;
  readonly requestId: string;
}): Promise<string> {
  const directory = options.coordinationDirectory;
  const file = path.join(directory, SHELF_WRITER_RECOVERY_STATE_FILENAME);
  const record: ShelfWriterRecoveryState = Object.freeze({
    version: 1,
    state: "write-in-progress",
    pid: process.pid,
    requestId: options.requestId,
    startedAt: new Date().toISOString()
  });
  // A valid prior marker may be updated only after the caller's recovery assessment.
  // Malformed or unreadable evidence is never replaced just because a journal scan is clean.
  await inspectRecoveryMarkerFile(file);

  const temporary = path.join(
    directory,
    `.${SHELF_WRITER_RECOVERY_STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Re-read immediately before the atomic replace so a malformed marker that appeared
    // during staging is not overwritten.
    await inspectRecoveryMarkerFile(file);
    await rename(temporary, file);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => {});
    if (error instanceof ShelfWriteCoordinationError) throw error;
    throw recoveryStateUnavailable(
      "The Shelf write recovery state could not be recorded.",
      describe(error)
    );
  }
  return file;
}

/**
 * Remove the recovery record after a completed write, and only then.
 *
 * `unlink` removes the directory entry itself; combined with the regular-file check it
 * cannot delete a link target or a directory.
 */
export async function clearShelfWriterRecoveryState(file: string): Promise<void> {
  const marker = await inspectRecoveryMarkerFile(file);
  if (!marker.pending) return;
  try {
    await unlink(file);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw recoveryStateUnavailable(
      "The Shelf write recovery state could not be removed.",
      describe(error)
    );
  }
}

export interface ShelfWriteRecoveryAssessment {
  readonly resumable: boolean;
  /** Requests that were interrupted and will be completed by their own retry. */
  readonly interruptedRequestIds: readonly string[];
  /** Committed receipts that were re-verified against the files on disk. */
  readonly committedRequestIds: readonly string[];
}

/**
 * Check whether the shared journal is consistent enough to continue after an unclean
 * write. Throws instead of returning `resumable: false`: every outcome here is
 * fail-closed, so there is nothing a caller could safely do with `false`.
 */
export async function assessShelfWriteRecoveryState(options: {
  readonly shelfRoot: string;
  readonly expectedShelfId: string;
  readonly coordinationRoot: string;
  /** Test seam forwarded to the journal inspection so directory scans can be counted. */
  readonly listRecordFiles?: ShelfRecordFileLister;
}): Promise<ShelfWriteRecoveryAssessment> {
  await resolveShelfWriteLayout(options);
  // Strict journal validation: a malformed, foreign or internally inconsistent
  // record throws `shelf-write-journal-invalid` here. Nothing is repaired.
  const entries = await inspectShelfWriteJournal(options);

  const interrupted: string[] = [];
  const committed: string[] = [];
  for (const entry of entries) {
    const record = entry.record;
    if (record.state === "committed") {
      if (!entry.bookPresent) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-receipt-missing",
          "A committed receipt survived the crash but its Book is missing.",
          `request ${record.requestId}`
        );
      }
      if (!entry.annotationPresent) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-receipt-missing",
          "A committed receipt survived the crash but its Annotation is missing.",
          `request ${record.requestId}`
        );
      }
      if (!entry.matchesDisk) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-receipt-missing",
          "A committed receipt no longer matches the Annotation on disk.",
          `request ${record.requestId}`
        );
      }
      if (!entry.sourceAssetsMatch) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-receipt-missing",
          "A committed receipt no longer matches its referenced source assets.",
          `request ${record.requestId}`
        );
      }
      committed.push(record.requestId);
      continue;
    }
    if (record.state === "staged") {
      if (entry.annotationPresent && !entry.matchesDisk) {
        // The commit point was passed but the bytes do not match what was staged.
        // Finishing or overwriting either way would guess at user data.
        throw new ShelfWriteCoordinationError(
          "shelf-write-lease-uncertain",
          "An interrupted write left an Annotation that does not match its staged digest.",
          `request ${record.requestId}`
        );
      }
      if (!entry.sourceAssetsMatch) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-lease-uncertain",
          "An interrupted write left source assets that do not match its Shelf records.",
          `request ${record.requestId}`
        );
      }
      // Annotation absent: died before the commit point. Annotation present with the
      // staged digest: died after it. Both are completed by retrying the request.
      interrupted.push(record.requestId);
    }
  }

  return Object.freeze({
    resumable: true,
    interruptedRequestIds: Object.freeze(interrupted),
    committedRequestIds: Object.freeze(committed)
  });
}

export type ShelfWriteRecoveryTrigger = "abandoned" | "pending-write";

export interface ShelfWriteRecoveryInfo {
  /**
   * `abandoned`: the mutex reported `WAIT_ABANDONED`.
   * `pending-write`: no abandonment (the previous mutex object may have been destroyed
   * with the last participant), but the durable recovery record says a write was in
   * progress.
   */
  readonly trigger: ShelfWriteRecoveryTrigger;
  readonly lease: ShelfMutexLease;
}

export interface NativeShelfWriteOptions {
  readonly scope?: ShelfMutexScope;
  readonly acquireTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  /** Observability hook for tests and diagnostics; runs after a successful assessment. */
  readonly onRecovery?: (
    assessment: ShelfWriteRecoveryAssessment,
    info: ShelfWriteRecoveryInfo
  ) => void | Promise<void>;
}

/**
 * Make sure a recovery record exists before this process gives up.
 *
 * An existing record is left exactly as it is: it already protects the next writer, and
 * overwriting it would erase the only pointer to the interrupted request.
 */
async function ensureRecoveryStateRecorded(
  layout: ShelfWriteLayout,
  requestId: string,
  cause: unknown
): Promise<never> {
  const existing = await inspectShelfWriterRecoveryState(layout.coordinationDirectory);
  if (!existing.pending) {
    try {
      await writeShelfWriterRecoveryState({
        coordinationDirectory: layout.coordinationDirectory,
        requestId
      });
    } catch (error: unknown) {
      throw new ShelfWriteCoordinationError(
        "shelf-write-recovery-state-unavailable",
        "The Shelf needs recovery, and that state could not be recorded durably.",
        describe(cause) + "; " + describe(error)
      );
    }
  }
  throw cause;
}

export interface NativeShelfWriteSectionContext {
  readonly layout: ShelfWriteLayout;
  readonly lease: ShelfMutexLease;
  /** Present only when abandonment or a recovery marker required journal assessment. */
  readonly recoveryAssessment?: ShelfWriteRecoveryAssessment;
}

/**
 * Run a writer inside the shared native critical section and perform D071 recovery
 * before any mutation. Every staged request must be available to the caller for
 * deterministic retry; otherwise the writer fails closed before starting another
 * transaction. The callback owns per-transaction recovery-marker publication and
 * removal, so batch writers can retain the marker until all interrupted requests
 * have reached committed receipts.
 */
export async function withNativeShelfWriteSection<T>(
  request: {
    readonly shelfRoot: string;
    readonly expectedShelfId: string;
    readonly coordinationRoot: string;
  },
  recoverableRequestIds: readonly string[],
  options: NativeShelfWriteOptions,
  work: (context: NativeShelfWriteSectionContext) => Promise<T>
): Promise<T> {
  const lease = await acquireShelfMutex({
    shelfId: request.expectedShelfId,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.acquireTimeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.now === undefined ? {} : { now: options.now })
  });

  let keepHeld = false;
  try {
    const layout = await resolveShelfWriteLayout(request);
    const marker = await inspectShelfWriterRecoveryState(layout.coordinationDirectory);
    let recoveryAssessment: ShelfWriteRecoveryAssessment | undefined;
    if (lease.abandoned || marker.pending) {
      try {
        recoveryAssessment = await assessShelfWriteRecoveryState(request);
        const allowed = new Set(recoverableRequestIds);
        const unavailable = recoveryAssessment.interruptedRequestIds.filter((id) => !allowed.has(id));
        if (unavailable.length > 0) {
          throw recoveryStateUnavailable(
            "The Private Shelf has interrupted writes that this operation cannot safely resume.",
            unavailable.join(",")
          );
        }
        await options.onRecovery?.(recoveryAssessment, {
          trigger: lease.abandoned ? "abandoned" : "pending-write",
          lease
        });
        // A marker can survive a crash after the receipt was written but before its
        // removal. Clear it only after the complete journal scan proves every receipt.
        if (marker.pending && recoveryAssessment.interruptedRequestIds.length === 0) {
          await clearShelfWriterRecoveryState(marker.path);
        }
      } catch (error: unknown) {
        keepHeld = true;
        await ensureRecoveryStateRecorded(
          layout,
          marker.record?.requestId ?? "recovery-check",
          error
        );
      }
    }

    let result: T;
    try {
      result = await work(Object.freeze({
        layout,
        lease,
        ...(recoveryAssessment === undefined ? {} : { recoveryAssessment })
      }));
    } catch (error: unknown) {
      if (recoveryAssessment !== undefined && recoveryAssessment.interruptedRequestIds.length > 0) {
        keepHeld = true;
        await ensureRecoveryStateRecorded(
          layout,
          recoveryAssessment.interruptedRequestIds[0]!,
          error
        );
      }
      throw error;
    }

    if (recoveryAssessment !== undefined && recoveryAssessment.interruptedRequestIds.length > 0) {
      try {
        const entries = await inspectShelfWriteJournal(request);
        const byId = new Map(entries.map((entry) => [entry.record.requestId, entry.record]));
        const unfinished = recoveryAssessment.interruptedRequestIds.filter((id) => byId.get(id)?.state !== "committed");
        if (unfinished.length > 0) {
          throw recoveryStateUnavailable(
            "Interrupted Private Shelf writes remain staged after recovery.",
            unfinished.join(",")
          );
        }
      } catch (error: unknown) {
        keepHeld = true;
        await ensureRecoveryStateRecorded(
          layout,
          recoveryAssessment.interruptedRequestIds[0]!,
          error
        );
      }
    }
    return result;
  } finally {
    if (!keepHeld) lease.release();
  }
}
/**
 * Commit one web quote under the OS mutex instead of the file lease.
 *
 * The product Collector Native Messaging Host and its isolated E2E mode call this
 * wrapper, which preserves the common v1 writer. The recovery marker is published by
 * the writer just before its first mutation (not before request validation).
 */
export async function commitShelfQuoteWithNativeLock(
  request: ShelfQuoteWriteRequest,
  options: NativeShelfWriteOptions = {}
): Promise<ShelfQuoteWriteReceipt> {
  const lease = await acquireShelfMutex({
    shelfId: request.expectedShelfId,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.acquireTimeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.now === undefined ? {} : { now: options.now })
  });

  let keepHeld = false;
  try {
    const layout = await resolveShelfWriteLayout({
      shelfRoot: request.shelfRoot,
      expectedShelfId: request.expectedShelfId,
      coordinationRoot: request.coordinationRoot
    });
    const recovery = await inspectShelfWriterRecoveryState(layout.coordinationDirectory);
    if (lease.abandoned || recovery.pending) {
      try {
        const assessment = await assessShelfWriteRecoveryState({
          shelfRoot: request.shelfRoot,
          expectedShelfId: request.expectedShelfId,
          coordinationRoot: request.coordinationRoot
        });
        const unrelatedInterrupted = assessment.interruptedRequestIds.filter((id) => id !== request.requestId);
        if (unrelatedInterrupted.length > 0) {
          throw recoveryStateUnavailable(
            "The Private Shelf has interrupted writes that this request cannot safely resume.",
            unrelatedInterrupted.join(",")
          );
        }
        await options.onRecovery?.(assessment, {
          trigger: lease.abandoned ? "abandoned" : "pending-write",
          lease
        });
      } catch (error: unknown) {
        keepHeld = true;
        await ensureRecoveryStateRecorded(layout, request.requestId, error);
      }
    }

    // The marker is published by the writer immediately before its first journal or
    // Shelf mutation, i.e. only after pure request validation has passed. A request
    // that can never succeed therefore leaves neither a marker nor a journal record.
    const markerFile = path.join(layout.coordinationDirectory, SHELF_WRITER_RECOVERY_STATE_FILENAME);
    let markerPublished = false;
    const receipt = await commitShelfQuote({
      ...request,
      externalLock: lease,
      beforeMutation: async (requestId) => {
        await writeShelfWriterRecoveryState({
          coordinationDirectory: layout.coordinationDirectory,
          requestId
        });
        markerPublished = true;
      }
    });
    // Clear only after the committed receipt exists. A marker that survived an earlier
    // crash and was just verified by recovery is cleared by the same receipt.
    if (markerPublished || recovery.pending) await clearShelfWriterRecoveryState(markerFile);
    return receipt;
  } finally {
    if (!keepHeld) lease.release();
  }
}

/**
 * Commit a planned Reviewer record transaction under the same native critical
 * section and persistent recovery marker used by the isolated test Host.
 */
export async function commitShelfRecordTransactionWithNativeLock(
  request: Omit<ShelfRecordWriteTransactionRequest, "externalLock" | "beforeMutation" | "afterReceipt">,
  options: NativeShelfWriteOptions = {}
): Promise<ShelfQuoteWriteReceipt> {
  return withNativeShelfWriteSection(
    request,
    [request.requestId],
    options,
    async ({ layout, lease }) => {
      let recoveryFile: string | undefined;
      return commitShelfRecordTransaction({
        ...request,
        externalLock: lease,
        beforeMutation: async (requestId) => {
          recoveryFile = await writeShelfWriterRecoveryState({
            coordinationDirectory: layout.coordinationDirectory,
            requestId
          });
        },
        afterReceipt: async () => {
          if (recoveryFile !== undefined) await clearShelfWriterRecoveryState(recoveryFile);
        }
      });
    }
  );
}
