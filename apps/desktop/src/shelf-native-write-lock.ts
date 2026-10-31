/**
 * Writing a Collector web quote while holding the Windows named mutex.
 *
 * `WAIT_ABANDONED` means the previous owner died inside the critical section. The
 * OS lock is already available at that point, so the only thing that stands between
 * a dead writer and a corrupted Shelf is the shared journal. This module therefore
 * treats abandonment as an instruction:
 *
 * 1. re-resolve the Shelf layout (marker identity, `library.json`, realpath and
 *    `dev`/`ino` fingerprints) — a swapped or mismatched Shelf fails closed;
 * 2. strictly validate every journal record — a damaged journal fails closed;
 * 3. require every `committed` receipt to still match its Book and Annotation;
 * 4. allow a `staged` record only when the Annotation is either absent (the previous
 *    writer died before the commit point) or present with the recorded digest (it
 *    died after the commit point, so the retry only has to write the receipt);
 * 5. refuse to continue, and keep the mutex held, when any of that is unprovable.
 *
 * Keeping the mutex held on a failed assessment is deliberate: the state needs human
 * repair, and releasing it would let the next writer treat the mutex as healthy
 * (abandonment is consumed by the first acquirer). The process is expected to exit
 * after reporting the failure, and the next process re-runs the assessment.
 *
 * Nothing here is imported by the product write path or by the Native Messaging
 * Host. Journal and Shelf record formats are unchanged.
 */
import path from "node:path";
import {
  ShelfWriteCoordinationError,
  commitShelfQuote,
  inspectShelfWriteJournal,
  resolveShelfWriteLayout,
  type ShelfQuoteWriteReceipt,
  type ShelfQuoteWriteRequest
} from "./shelf-write-coordination.js";
import {
  acquireShelfMutex,
  type ShelfMutexLease,
  type ShelfMutexScope
} from "./shelf-native-mutex.js";

export interface AbandonedShelfStateAssessment {
  readonly resumable: boolean;
  /** Requests that were interrupted and will be completed by their own retry. */
  readonly interruptedRequestIds: readonly string[];
  /** Committed receipts that were re-verified against the files on disk. */
  readonly committedRequestIds: readonly string[];
}

/**
 * Check whether the shared journal is consistent enough to continue after a writer
 * died. Throws instead of returning `resumable: false`: every outcome here is
 * fail-closed, so there is nothing a caller could safely do with `false`.
 */
export async function assessShelfWriteStateAfterAbandon(options: {
  readonly shelfRoot: string;
  readonly expectedShelfId: string;
  readonly coordinationRoot: string;
}): Promise<AbandonedShelfStateAssessment> {
  // Re-resolving validates the marker identity, the configured directories, the
  // realpath containment and the dev/ino fingerprints of a live Shelf.
  await resolveShelfWriteLayout(options);
  // Strict journal validation: a malformed, foreign or internally inconsistent
  // record throws `shelf-write-journal-invalid` here.
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

export interface NativeShelfWriteOptions {
  readonly scope?: ShelfMutexScope;
  readonly acquireTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  /** Observability hook for tests and diagnostics; runs only after abandonment. */
  readonly onAbandoned?: (assessment: AbandonedShelfStateAssessment, lease: ShelfMutexLease) => void | Promise<void>;
}

/**
 * Commit one web quote under the OS mutex instead of the file lease.
 *
 * The writer itself is the existing single implementation (`commitShelfQuote`); the
 * external lock only replaces `acquireShelfWriteLease`, so no second write path and
 * no journal format change is introduced.
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
    if (lease.abandoned) {
      try {
        const assessment = await assessShelfWriteStateAfterAbandon({
          shelfRoot: request.shelfRoot,
          expectedShelfId: request.expectedShelfId,
          coordinationRoot: request.coordinationRoot
        });
        await options.onAbandoned?.(assessment, lease);
      } catch (error: unknown) {
        // Fail closed and stop the process from writing again. Do not release: the
        // abandonment signal would be lost and a later writer would skip this check.
        keepHeld = true;
        throw error;
      }
    }
    return await commitShelfQuote({ ...request, externalLock: lease });
  } finally {
    if (!keepHeld) lease.release();
  }
}
