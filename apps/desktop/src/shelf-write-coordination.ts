/**
 * Cross-process Private Shelf write coordination — foundation, not product wiring.
 *
 * The Desktop main process and the Collector Native Messaging Host are separate
 * OS processes that may address the same configured Private Shelf. ADR 0019 / D070
 * accept the Host boundary but explicitly leave the locking, atomicity, recovery,
 * idempotency, and receipt mechanisms unselected.
 *
 * This module is the technical verification of one candidate mechanism:
 *
 * - exclusion is keyed by the Shelf's stable folder-marker UUID (D068), not by a
 *   machine path, so the same Shelf is protected after the folder is moved/renamed;
 * - the lease lives outside the Shelf, so no coordination state becomes user data,
 *   git-visible Shelf content, or a second source of truth;
 * - record publication reuses `shelf-write-core` (the Reviewer writer's own
 *   primitives), so there is exactly one Shelf write implementation;
 * - the Annotation file is the single commit point: assets and Book are add-only
 *   preludes, so an interrupted write can be completed by a retry instead of being
 *   rolled back;
 * - a durable per-request journal provides the idempotency key and the receipt.
 *
 * Nothing here is imported by the Desktop write path or by the experimental host.
 * Enabling either is a separate owner decision (see
 * `docs/collector-shelf-writer-coordination.md`, open decisions).
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, link, unlink } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ShelfAnnotationV04,
  ShelfBookV04
} from "@maginalia/format" with { "resolution-mode": "import" };
import { inspectFolderMarkers } from "./folder-identity.js";
import { assertSafeRoot } from "./repository-filesystem.js";
import {
  ensureShelfDirectory,
  isInsideDirectory,
  matchShelfBook,
  publishShelfFileNoReplace,
  readExistingShelfBooks,
  readShelfDirectoryConfig,
  serializeShelfRecord,
  shelfBookFilename,
  shelfRecordFilename
} from "./shelf-write-core.js";

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });
let formatCorePromise: Promise<FormatCore> | undefined;
function loadFormatCore(): Promise<FormatCore> {
  formatCorePromise ??= import("@maginalia/format");
  return formatCorePromise;
}

export const SHELF_WRITE_LEASE_VERSION = 1 as const;
export const SHELF_WRITE_JOURNAL_VERSION = 1 as const;
/**
 * Heartbeat age after which a *live* holder's lease is considered uncertain.
 *
 * This is deliberately NOT a theft threshold: a live PID with an expired
 * heartbeat fails closed with `shelf-write-lease-uncertain` instead of losing its
 * lease. Only a provably dead PID justifies reclamation.
 */
export const SHELF_WRITE_LEASE_TTL_MS = 120_000;
export const SHELF_WRITE_ACQUIRE_TIMEOUT_MS = 15_000;
export const SHELF_WRITE_POLL_INTERVAL_MS = 40;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const GET_DATE_PATTERN = /^[0-9]{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:[01][0-9]|2[0-3])(?:[0-5][0-9])$/u;
const BOOK_ID_PATTERN = /^book:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const ANNOTATION_ID_PATTERN = /^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export type ShelfWriteCoordinationErrorCode =
  | "shelf-write-invalid-request"
  | "shelf-write-unsafe-path"
  | "shelf-write-shelf-unavailable"
  | "shelf-write-identity-unavailable"
  | "shelf-write-identity-conflict"
  | "shelf-write-identity-mismatch"
  | "shelf-write-layout-invalid"
  | "shelf-write-busy"
  | "shelf-write-lease-lost"
  | "shelf-write-lease-uncertain"
  | "shelf-write-journal-unavailable"
  | "shelf-write-journal-invalid"
  | "shelf-write-request-mismatch"
  | "shelf-write-book-conflict"
  | "shelf-write-record-conflict"
  | "shelf-write-receipt-missing"
  | "shelf-write-recovery-state-unavailable";

export class ShelfWriteCoordinationError extends Error {
  public constructor(
    public readonly code: ShelfWriteCoordinationErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "ShelfWriteCoordinationError";
  }
}

function fail(code: ShelfWriteCoordinationErrorCode, message: string, detail?: string): never {
  throw new ShelfWriteCoordinationError(code, message, detail);
}

function isExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

export function digestShelfWriteContent(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/* -------------------------------------------------------------------------- */
/* Shelf identity and layout                                                  */
/* -------------------------------------------------------------------------- */

export interface ShelfFileIdentity {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

export interface ShelfWriteLayoutFingerprint {
  readonly root: ShelfFileIdentity;
  readonly books: ShelfFileIdentity;
  readonly annotations: ShelfFileIdentity;
}

export interface ShelfWriteLayout {
  /** Canonical (realpath) Shelf root. */
  readonly root: string;
  /** Stable Shelf UUID taken from the validated `*.magi` folder marker. */
  readonly shelfId: string;
  readonly booksDirectory: string;
  readonly annotationsDirectory: string;
  readonly coordinationDirectory: string;
  readonly fingerprint: ShelfWriteLayoutFingerprint;
}

async function directoryIdentity(target: string): Promise<ShelfFileIdentity> {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("shelf-write-unsafe-path", "A Shelf directory is a link or reparse point.");
  }
  const canonical = await realpath(target);
  return Object.freeze({ realpath: canonical, dev: info.dev, ino: info.ino });
}

function sameIdentity(left: ShelfFileIdentity, right: ShelfFileIdentity): boolean {
  return left.realpath === right.realpath && left.dev === right.dev && left.ino === right.ino;
}

/**
 * Compare the recorded layout fingerprint with the live filesystem.
 *
 * This is the defence against a path swap performed between the identity check
 * and the publish: a junction/symlink replacement changes `lstat` to a link (or
 * changes `dev`/`ino`), and a moved or renamed directory changes the realpath.
 * The window between this check and the `link()` publish is a residual TOCTOU
 * risk that this layer reduces but does not eliminate.
 */
export async function assertShelfWriteLayoutCurrent(layout: ShelfWriteLayout): Promise<void> {
  let root: ShelfFileIdentity;
  let books: ShelfFileIdentity;
  let annotations: ShelfFileIdentity;
  try {
    root = await directoryIdentity(layout.root);
    books = await directoryIdentity(layout.booksDirectory);
    annotations = await directoryIdentity(layout.annotationsDirectory);
  } catch (error: unknown) {
    if (error instanceof ShelfWriteCoordinationError) throw error;
    fail("shelf-write-unsafe-path", "The Shelf layout is no longer readable.");
  }
  if (!sameIdentity(root, layout.fingerprint.root)
    || !sameIdentity(books, layout.fingerprint.books)
    || !sameIdentity(annotations, layout.fingerprint.annotations)) {
    fail("shelf-write-unsafe-path", "The Shelf layout changed after it was validated.");
  }
  if (!isInsideDirectory(layout.root, books.realpath) || !isInsideDirectory(layout.root, annotations.realpath)) {
    fail("shelf-write-unsafe-path", "A Shelf record directory escaped the Shelf root.");
  }
}

function foldPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when either path is the other or one contains the other (case-folded on Windows). */
function pathsOverlap(left: string, right: string): boolean {
  const a = foldPath(left);
  const b = foldPath(right);
  if (a === b) return true;
  const isDescendant = (relative: string): boolean =>
    relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return isDescendant(path.relative(a, b)) || isDescendant(path.relative(b, a));
}

function assertNoShelfOverlap(shelfRoot: string, candidate: string): void {
  if (pathsOverlap(shelfRoot, candidate)) {
    fail("shelf-write-unsafe-path", "The coordination root overlaps the Private Shelf.");
  }
}

/**
 * Canonicalize a path that may not exist yet by resolving the deepest existing
 * ancestor, so junctions/symlinks in the parent chain are honoured before any
 * directory is created.
 */
async function canonicalizeProspectivePath(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(current);
      return suffix.length === 0 ? canonical : path.join(canonical, ...[...suffix].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolveShelfWriteLayoutOptions {
  readonly shelfRoot: string;
  readonly expectedShelfId: string;
  readonly coordinationRoot: string;
}

/**
 * Resolve and fully validate a write target.
 *
 * Identity is the marker UUID; the configured path is only a locator. A missing,
 * conflicting, or mismatched marker fails closed and no marker is ever created,
 * adopted, or repaired here.
 */
export async function resolveShelfWriteLayout(options: ResolveShelfWriteLayoutOptions): Promise<ShelfWriteLayout> {
  if (typeof options.expectedShelfId !== "string" || !UUID_PATTERN.test(options.expectedShelfId)) {
    fail("shelf-write-invalid-request", "The expected Shelf identity is not a UUID.");
  }
  if (typeof options.coordinationRoot !== "string" || options.coordinationRoot.length === 0) {
    fail("shelf-write-invalid-request", "A coordination root is required.");
  }

  let root: string;
  try {
    root = await assertSafeRoot(options.shelfRoot);
  } catch {
    fail("shelf-write-shelf-unavailable", "The configured Private Shelf is unavailable.");
  }

  let marker;
  try {
    marker = await inspectFolderMarkers(root);
  } catch {
    fail("shelf-write-identity-unavailable", "The Shelf folder marker cannot be inspected.");
  }
  if (marker.kind === "conflict") {
    fail("shelf-write-identity-conflict", "The Shelf folder carries conflicting identity markers.");
  }
  if (marker.kind !== "valid" || marker.marker.type !== "shelf") {
    fail("shelf-write-identity-unavailable", "The folder is not an identified Private Shelf.");
  }
  const shelfId = marker.marker.id;
  if (shelfId.toLowerCase() !== options.expectedShelfId.toLowerCase()) {
    fail("shelf-write-identity-mismatch", "The Shelf identity does not match the configured identity.");
  }

  const resolution = await readShelfDirectoryConfig(root);
  if (resolution.kind !== "ok") {
    fail("shelf-write-layout-invalid", `The Private Shelf layout is not writable (${resolution.kind}).`);
  }

  // The overlap check runs BEFORE any directory is created, so a rejected
  // configuration cannot leave a trace inside the user's Shelf. Paths that do not
  // exist yet are canonicalized through their deepest existing ancestor, which
  // still resolves junctions in the parent chain.
  const prospectiveCoordinationRoot = await canonicalizeProspectivePath(options.coordinationRoot);
  assertNoShelfOverlap(root, prospectiveCoordinationRoot);

  let coordinationDirectory: string;
  let coordinationRootReal: string;
  try {
    await mkdir(options.coordinationRoot, { recursive: true });
    coordinationRootReal = await realpath(options.coordinationRoot);
    // Re-check after creation: the created directory may resolve through a
    // junction that only becomes visible once it exists.
    assertNoShelfOverlap(root, coordinationRootReal);
    const shelfCoordinationPath = path.join(coordinationRootReal, "shelves", shelfId.toLowerCase());
    await mkdir(path.join(shelfCoordinationPath, "requests"), { recursive: true });
    coordinationDirectory = await realpath(shelfCoordinationPath);
  } catch (error: unknown) {
    if (error instanceof ShelfWriteCoordinationError) throw error;
    fail("shelf-write-journal-unavailable", "The coordination directory is unavailable.");
  }
  assertNoShelfOverlap(root, coordinationDirectory);

  if (!await ensureShelfDirectory(root, resolution.directories.booksDirectory)
    || !await ensureShelfDirectory(root, resolution.directories.annotationsDirectory)) {
    fail("shelf-write-layout-invalid", "The Private Shelf record directories are unavailable or unsafe.");
  }

  const fingerprint: ShelfWriteLayoutFingerprint = Object.freeze({
    root: await directoryIdentity(root),
    books: await directoryIdentity(resolution.directories.booksDirectory),
    annotations: await directoryIdentity(resolution.directories.annotationsDirectory)
  });

  return Object.freeze({
    root,
    shelfId,
    booksDirectory: resolution.directories.booksDirectory,
    annotationsDirectory: resolution.directories.annotationsDirectory,
    coordinationDirectory,
    fingerprint
  });
}

/* -------------------------------------------------------------------------- */
/* Cross-process lease                                                        */
/* -------------------------------------------------------------------------- */

interface ShelfWriteLeaseMetadata {
  readonly version: typeof SHELF_WRITE_LEASE_VERSION;
  readonly shelfId: string;
  readonly token: string;
  readonly pid: number;
  readonly processLabel: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: number;
}

export interface AcquireShelfWriteLeaseOptions {
  readonly coordinationRoot: string;
  readonly shelfId: string;
  readonly processLabel?: string;
  /** Heartbeat age that marks a live holder as uncertain (never a theft window). */
  readonly leaseTtlMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injectable clock; milliseconds since epoch. Required for staleness tests. */
  readonly now?: () => number;
  /**
   * Test seam: runs between the verified observation of a dead holder's lock and
   * the atomic reap rename, so race behaviour can be reproduced deterministically.
   */
  readonly onBeforeReapRename?: () => void | Promise<void>;
}

export interface ShelfWriteLease {
  readonly shelfId: string;
  readonly token: string;
  readonly lockPath: string;
  release(): Promise<void>;
  assertHeld(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;

function parseLeaseMetadata(text: string): ShelfWriteLeaseMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.version !== SHELF_WRITE_LEASE_VERSION
      || typeof value.shelfId !== "string"
      || !UUID_PATTERN.test(value.shelfId)
      || typeof value.token !== "string"
      || value.token.length < 16
      || typeof value.pid !== "number"
      || !Number.isInteger(value.pid)
      || typeof value.processLabel !== "string"
      || typeof value.acquiredAt !== "string"
      || typeof value.heartbeatAt !== "number"
      || !Number.isFinite(value.heartbeatAt)) return undefined;
    return Object.freeze({
      version: SHELF_WRITE_LEASE_VERSION,
      shelfId: value.shelfId,
      token: value.token,
      pid: value.pid,
      processLabel: value.processLabel,
      acquiredAt: value.acquiredAt,
      heartbeatAt: value.heartbeatAt
    });
  } catch {
    return undefined;
  }
}

async function readLeaseMetadata(lockPath: string): Promise<ShelfWriteLeaseMetadata | undefined> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
    return parseLeaseMetadata(await readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * An immutable observation of the lock file: exact bytes, parsed metadata, and the
 * `{dev, ino}` pair that identifies the concrete file, not just the name.
 */
interface ObservedLease {
  readonly metadata: ShelfWriteLeaseMetadata;
  readonly text: string;
  readonly dev: number;
  readonly ino: number;
}

async function readObservedLease(lockPath: string): Promise<ObservedLease | undefined> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
    const text = await readFile(lockPath, "utf8");
    const metadata = parseLeaseMetadata(text);
    if (metadata === undefined) return undefined;
    return Object.freeze({ metadata, text, dev: info.dev, ino: info.ino });
  } catch {
    return undefined;
  }
}

async function leaseFileExists(lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
    return true;
  } catch {
    return false;
  }
}

type ReapOutcome = "reaped" | "changed" | "uncertain";

/**
 * Reclaim a lock whose owner is provably dead, without stealing a live writer's
 * lease.
 *
 * The reap is a verified swap, never a bare delete:
 *
 * 1. the observable file is pinned with a hard link, and the pin's `{dev, ino}` is
 *    compared with the observation, so a lock that was already replaced cannot be
 *    touched;
 * 2. only then is the lock atomically renamed into quarantine;
 * 3. the quarantined file's bytes and `{dev, ino}` are compared with the
 *    observation again; a mismatch means a competitor replaced the lock in the
 *    window, so the quarantined file is restored atomically with `link()` and the
 *    caller retries (`changed`);
 * 4. if restoration is impossible (a third writer already created a lock, or the
 *    filesystem cannot link) the outcome is `uncertain` and the caller fails
 *    closed — no writer may proceed on an unproven lease state.
 *
 * The single residual window is between the final identity check and the rename
 * syscall; a stolen lease is always detected by `assertHeld()` before any record
 * is published, so a mis-taken lease cannot produce a duplicate write.
 */
async function reapObservedDeadLease(
  lockPath: string,
  observed: ObservedLease,
  onBeforeReapRename?: () => void | Promise<void>
): Promise<ReapOutcome> {
  const pinPath = `${lockPath}.${randomUUID()}.pin`;
  try {
    await link(lockPath, pinPath);
  } catch {
    // Hard links are unavailable (some network filesystems) or the lock vanished.
    return "uncertain";
  }

  let pinned: { readonly text: string; readonly dev: number; readonly ino: number } | undefined;
  try {
    const info = await lstat(pinPath);
    const text = await readFile(pinPath, "utf8");
    pinned = { text, dev: info.dev, ino: info.ino };
  } catch {
    pinned = undefined;
  }
  if (pinned === undefined || pinned.text !== observed.text
    || pinned.dev !== observed.dev || pinned.ino !== observed.ino) {
    // The name no longer points at the observed dead holder's lock. Nothing is
    // removed: a newer holder owns the lease now.
    try { await unlink(pinPath); } catch { /* Best effort. */ }
    return "changed";
  }

  await onBeforeReapRename?.();

  // Re-read the name immediately before the rename. The confirmed pin proves what
  // the observation referred to; this second observation is what decides whether the
  // name still refers to that same file. A lock created by another writer in the
  // window is therefore never renamed away.
  const current = await readObservedLease(lockPath);
  if (current === undefined || current.text !== observed.text
    || current.dev !== observed.dev || current.ino !== observed.ino) {
    try { await unlink(pinPath); } catch { /* Best effort. */ }
    return "changed";
  }

  const quarantine = `${lockPath}.${randomUUID()}.reap`;
  try {
    await rename(lockPath, quarantine);
  } catch (error: unknown) {
    try { await unlink(pinPath); } catch { /* Best effort. */ }
    return isMissing(error) ? "changed" : "uncertain";
  }
  try { await unlink(pinPath); } catch { /* Best effort. */ }

  let moved: { readonly text: string; readonly dev: number; readonly ino: number } | undefined;
  try {
    const info = await lstat(quarantine);
    const text = await readFile(quarantine, "utf8");
    moved = { text, dev: info.dev, ino: info.ino };
  } catch {
    moved = undefined;
  }

  if (moved !== undefined && moved.text === observed.text
    && moved.dev === observed.dev && moved.ino === observed.ino) {
    // The dead holder's own lock file was removed. Confirmed reclamation.
    try { await unlink(quarantine); } catch { /* Best effort. */ }
    return "reaped";
  }

  // A different file was moved. Put it back atomically; if that is impossible the
  // lease state is unprovable and the caller must stop.
  try {
    await link(quarantine, lockPath);
  } catch (error: unknown) {
    if (isExists(error)) {
      // Another writer holds a fresh lock; the quarantined file cannot be restored
      // without overwriting it. Leave the quarantine in place as evidence.
      return "uncertain";
    }
    return "uncertain";
  }
  try { await unlink(quarantine); } catch { /* Best effort. */ }
  return "changed";
}

/**
 * Acquire the Shelf-scoped cross-process write lease.
 *
 * The lease is a `wx`-created file, so creation itself is the atomic
 * compare-and-set. A crashed holder is evicted only when its PID is provably dead;
 * an expired heartbeat alone never removes a lease, because a slow but healthy
 * writer must not lose its exclusivity.
 */
export async function acquireShelfWriteLease(options: AcquireShelfWriteLeaseOptions): Promise<ShelfWriteLease> {
  const shelfId = options.shelfId;
  if (!UUID_PATTERN.test(shelfId)) fail("shelf-write-invalid-request", "The Shelf identity is not a UUID.");
  const ttlMs = options.leaseTtlMs ?? SHELF_WRITE_LEASE_TTL_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? SHELF_WRITE_ACQUIRE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SHELF_WRITE_POLL_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const processLabel = options.processLabel ?? "unknown";

  let directory: string;
  try {
    await mkdir(path.join(options.coordinationRoot, "shelves", shelfId.toLowerCase()), { recursive: true });
    directory = await realpath(path.join(options.coordinationRoot, "shelves", shelfId.toLowerCase()));
  } catch {
    fail("shelf-write-journal-unavailable", "The coordination directory is unavailable.");
  }
  const lockPath = path.join(directory, "writer.lock");
  const token = randomUUID();
  const deadline = now() + acquireTimeoutMs;
  let backoff = pollIntervalMs;

  for (;;) {
    const metadata: ShelfWriteLeaseMetadata = {
      version: SHELF_WRITE_LEASE_VERSION,
      shelfId,
      token,
      pid: process.pid,
      processLabel,
      acquiredAt: new Date(now()).toISOString(),
      heartbeatAt: now()
    };
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return Object.freeze({
        shelfId,
        token,
        lockPath,
        async release(): Promise<void> {
          const current = await readLeaseMetadata(lockPath);
          if (current === undefined || current.token !== token) return;
          try { await unlink(lockPath); } catch { /* A newer holder already replaced it. */ }
        },
        async assertHeld(): Promise<void> {
          const current = await readLeaseMetadata(lockPath);
          if (current === undefined || current.token !== token) {
            fail("shelf-write-lease-lost", "The Shelf write lease is no longer held by this writer.");
          }
        }
      });
    } catch (error: unknown) {
      if (!isExists(error)) fail("shelf-write-journal-unavailable", "The Shelf write lease cannot be created.");
    }

    const observed = await readObservedLease(lockPath);
    const lockPresent = observed !== undefined || await leaseFileExists(lockPath);
    if (observed !== undefined) {
      const alive = processIsAlive(observed.metadata.pid);
      if (!alive) {
        const outcome = await reapObservedDeadLease(lockPath, observed, options.onBeforeReapRename);
        if (outcome === "reaped") continue;
        if (outcome === "changed") {
          // Another writer is actively replacing the lock. Keep polling, but never
          // spin past the acquire window without reporting a bounded outcome.
          if (now() >= deadline) {
            fail("shelf-write-busy", "Another process holds the Shelf write lease.");
          }
          await delay(backoff);
          backoff = Math.min(backoff * 2, 250);
          continue;
        }
        fail("shelf-write-lease-uncertain", "A stale Shelf write lease could not be reclaimed safely.");
      }
      // A live holder keeps its lease regardless of heartbeat age. An old heartbeat
      // means we cannot prove the holder is healthy, so we must not take the lease.
      if (now() - observed.metadata.heartbeatAt > ttlMs) {
        fail(
          "shelf-write-lease-uncertain",
          "A live writer holds the Shelf write lease but its heartbeat is stale.",
          observed.metadata.processLabel
        );
      }
    }

    if (now() >= deadline) {
      // A lock that exists but cannot be parsed may be mid-write by a live creator,
      // so it is given the full acquire window to become valid. If it is still
      // unreadable after that, the lease state is unprovable: fail closed rather
      // than guess.
      if (lockPresent && observed === undefined) {
        fail("shelf-write-lease-uncertain", "The Shelf write lease file is unreadable or malformed.");
      }
      fail("shelf-write-busy", "Another process holds the Shelf write lease.", observed?.metadata.processLabel);
    }
    await delay(backoff);
    backoff = Math.min(backoff * 2, 250);
  }
}

/* -------------------------------------------------------------------------- */
/* Durable request journal (idempotency key + receipt)                         */
/* -------------------------------------------------------------------------- */

export type ShelfWriteJournalState = "staged" | "committed" | "aborted";

export interface ShelfWriteJournalRecord {
  readonly version: typeof SHELF_WRITE_JOURNAL_VERSION;
  readonly kind: "shelf-write-request";
  readonly shelfId: string;
  readonly requestId: string;
  /** Digest of the caller's content, excluding generated IDs. */
  readonly requestDigest: string;
  readonly state: ShelfWriteJournalState;
  readonly bookId: `book:${string}`;
  readonly annotationId: `ann:${string}`;
  readonly bookReused: boolean;
  readonly annotationDigest: string;
  readonly stagedAt: string;
  readonly updatedAt: string;
  readonly writer: { readonly pid: number; readonly process: string };
  readonly committedAt?: string;
  readonly abortedReason?: string;
}

async function writeJournalRecord(layout: ShelfWriteLayout, record: ShelfWriteJournalRecord): Promise<void> {
  const directory = path.join(layout.coordinationDirectory, "requests");
  const target = path.join(directory, `${record.requestId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serializeShelfRecord(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch {
    fail("shelf-write-journal-unavailable", "The Shelf write journal record cannot be persisted.");
  } finally {
    try { await unlink(temporary); } catch { /* Published or never created. */ }
  }
}

const JOURNAL_REQUIRED_KEYS: readonly string[] = [
  "version", "kind", "shelfId", "requestId", "requestDigest", "state",
  "bookId", "annotationId", "bookReused", "annotationDigest",
  "stagedAt", "updatedAt", "writer"
];
const JOURNAL_OPTIONAL_KEYS: readonly string[] = ["committedAt", "abortedReason"];
const JOURNAL_WRITER_KEYS: readonly string[] = ["pid", "process"];
const JOURNAL_MAX_BYTES = 8192;

function invalidJournal(detail: string): never {
  fail("shelf-write-journal-invalid", "The Shelf write journal record is invalid.", detail);
}

function journalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalidJournal(`${label} must be a non-empty string`);
  return value;
}

/**
 * Parse and strictly validate a journal record.
 *
 * A journal is *external input* on resume: it is read from disk after a crash, so
 * it can be truncated, hand-edited, copied from another Shelf, or left over from a
 * different request. Nothing about it is trusted:
 *
 * - the file name must be the record's own request ID, and every ID must match the
 *   canonical Shelf pattern *before* it is used to build any filesystem path, so a
 *   record can never point outside the journal, Book, or Annotation directory;
 * - the record's Shelf identity must be the Shelf that is actually open;
 * - unknown keys are rejected, so a future field cannot be smuggled in;
 * - `state` must be internally consistent (`committed` needs its timestamp and a
 *   fully formed digest, `aborted` needs a reason, `staged`/`committed` need a real
 *   Annotation digest).
 *
 * Any deviation fails closed with `shelf-write-journal-invalid`; a malformed record
 * can therefore never produce `committed`/`already-committed`.
 */
function parseJournalRecord(
  raw: unknown,
  options: { readonly requestId: string; readonly shelfId: string }
): ShelfWriteJournalRecord {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    invalidJournal("the record is not an object");
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!JOURNAL_REQUIRED_KEYS.includes(key) && !JOURNAL_OPTIONAL_KEYS.includes(key)) {
      invalidJournal(`unknown field "${key}"`);
    }
  }
  for (const key of JOURNAL_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalidJournal(`missing field "${key}"`);
  }

  if (value.version !== SHELF_WRITE_JOURNAL_VERSION) invalidJournal("unsupported record version");
  if (value.kind !== "shelf-write-request") invalidJournal("unexpected record kind");

  const shelfId = journalString(value.shelfId, "shelfId");
  if (!UUID_PATTERN.test(shelfId)) invalidJournal("shelfId is not a Shelf identity");
  if (shelfId.toLowerCase() !== options.shelfId.toLowerCase()) {
    invalidJournal("the record belongs to a different Shelf");
  }

  const requestId = journalString(value.requestId, "requestId");
  if (!REQUEST_ID_PATTERN.test(requestId)) invalidJournal("requestId is not a valid request ID");
  if (requestId !== options.requestId) invalidJournal("the record does not match its file name");

  const state = value.state;
  if (state !== "staged" && state !== "committed" && state !== "aborted") {
    invalidJournal("unknown record state");
  }

  const bookId = journalString(value.bookId, "bookId");
  if (!BOOK_ID_PATTERN.test(bookId)) invalidJournal("bookId is not a Book identity");
  const annotationId = journalString(value.annotationId, "annotationId");
  if (!ANNOTATION_ID_PATTERN.test(annotationId)) invalidJournal("annotationId is not an Annotation identity");

  if (typeof value.bookReused !== "boolean") invalidJournal("bookReused must be a boolean");

  const requestDigest = journalString(value.requestDigest, "requestDigest");
  if (!SHA256_DIGEST_PATTERN.test(requestDigest)) invalidJournal("requestDigest is not a SHA-256 digest");

  const annotationDigestRaw = value.annotationDigest;
  if (typeof annotationDigestRaw !== "string") invalidJournal("annotationDigest must be a string");
  if (annotationDigestRaw !== "" && !SHA256_DIGEST_PATTERN.test(annotationDigestRaw)) {
    invalidJournal("annotationDigest is not a SHA-256 digest");
  }
  if (state !== "aborted" && annotationDigestRaw === "") {
    invalidJournal("a persisted request must record its Annotation digest");
  }

  const stagedAt = journalString(value.stagedAt, "stagedAt");
  if (!ISO_TIMESTAMP_PATTERN.test(stagedAt)) invalidJournal("stagedAt is not an ISO timestamp");
  const updatedAt = journalString(value.updatedAt, "updatedAt");
  if (!ISO_TIMESTAMP_PATTERN.test(updatedAt)) invalidJournal("updatedAt is not an ISO timestamp");

  const writer = value.writer;
  if (writer === null || typeof writer !== "object" || Array.isArray(writer)) {
    invalidJournal("writer must be an object");
  }
  const writerValue = writer as Record<string, unknown>;
  for (const key of Object.keys(writerValue)) {
    if (!JOURNAL_WRITER_KEYS.includes(key)) invalidJournal(`unknown writer field "${key}"`);
  }
  if (typeof writerValue.pid !== "number" || !Number.isInteger(writerValue.pid) || writerValue.pid < 0) {
    invalidJournal("writer.pid must be a process ID");
  }
  if (typeof writerValue.process !== "string" || writerValue.process.length === 0) {
    invalidJournal("writer.process must be a non-empty string");
  }

  let committedAt: string | undefined;
  if (value.committedAt !== undefined) {
    committedAt = journalString(value.committedAt, "committedAt");
    if (!ISO_TIMESTAMP_PATTERN.test(committedAt)) invalidJournal("committedAt is not an ISO timestamp");
    if (state !== "committed") invalidJournal("only a committed record carries a commit time");
  }
  let abortedReason: string | undefined;
  if (value.abortedReason !== undefined) {
    abortedReason = journalString(value.abortedReason, "abortedReason");
    if (state !== "aborted") invalidJournal("only an aborted record carries an abort reason");
  }
  if (state === "committed" && committedAt === undefined) {
    invalidJournal("a committed record must carry its commit time");
  }
  if (state === "aborted" && abortedReason === undefined) {
    invalidJournal("an aborted record must carry its abort reason");
  }

  return Object.freeze({
    version: SHELF_WRITE_JOURNAL_VERSION,
    kind: "shelf-write-request",
    shelfId,
    requestId,
    requestDigest,
    state,
    bookId: bookId as `book:${string}`,
    annotationId: annotationId as `ann:${string}`,
    bookReused: value.bookReused,
    annotationDigest: annotationDigestRaw,
    stagedAt,
    updatedAt,
    writer: Object.freeze({ pid: writerValue.pid, process: writerValue.process }),
    ...(committedAt === undefined ? {} : { committedAt }),
    ...(abortedReason === undefined ? {} : { abortedReason })
  });
}

async function readJournalRecord(
  layout: ShelfWriteLayout,
  requestId: string
): Promise<ShelfWriteJournalRecord | undefined> {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    invalidJournal("the requested journal name is not a valid request ID");
  }
  const target = path.join(layout.coordinationDirectory, "requests", `${requestId}.json`);
  let text: string;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > JOURNAL_MAX_BYTES) {
      invalidJournal("the journal record is not a regular, size-bounded file");
    }
    text = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (error instanceof ShelfWriteCoordinationError) throw error;
    if (isMissing(error)) return undefined;
    fail("shelf-write-journal-unavailable", "The Shelf write journal record cannot be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalidJournal("the journal record is not valid JSON");
  }
  return parseJournalRecord(parsed, { requestId, shelfId: layout.shelfId });
}

async function annotationDigestOnDisk(directory: string, annotationId: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path.join(directory, shelfRecordFilename(annotationId)));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}

async function shelfRecordExists(directory: string, id: string): Promise<boolean> {
  try {
    const info = await lstat(path.join(directory, shelfRecordFilename(id)));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Collector web-quote write                                                  */
/* -------------------------------------------------------------------------- */

export interface ShelfWriteFaultHooks {
  /** Test seam: simulate a crash between the Book publish and the Annotation publish. */
  readonly beforeAnnotationPublish?: () => void | Promise<void>;
}

export interface ShelfQuoteWriteRequest {
  readonly requestId: string;
  readonly shelfRoot: string;
  readonly expectedShelfId: string;
  readonly coordinationRoot: string;
  readonly quote: string;
  readonly url: string;
  readonly getDate: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly comment?: string;
  /**
   * OPEN DECISION: which annotation field carries the user's comment for a
   * Collector web quote is not settled (`comment` legacy field vs `privateMemo`).
   * The default preserves the Collector instruction to reuse `comment`.
   */
  readonly commentField?: "comment" | "privateMemo";
  readonly processLabel?: string;
  readonly leaseTtlMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly now?: () => number;
  readonly faults?: ShelfWriteFaultHooks;
  /**
   * Technical-verification seam (Issue #80 / OD-10), not a product option.
   *
   * When present, the caller already holds an OS-level cross-process lock (the
   * Windows named mutex spike) and the file lease is not taken. The writer then
   * only re-asserts that the supplied lock is still held, so there is exactly one
   * Shelf writer implementation and no second write path is introduced.
   *
   * Leaving this undefined preserves the original behavior byte for byte.
   */
  readonly externalLock?: ShelfWriteExternalLock;
}

/** Minimal view of an externally held cross-process lock. */
export interface ShelfWriteExternalLock {
  assertHeld(): Promise<void>;
}

export interface ShelfQuoteWriteReceipt {
  readonly version: 1;
  readonly state: "committed" | "already-committed";
  readonly requestId: string;
  readonly shelfId: string;
  readonly bookId: `book:${string}`;
  readonly annotationId: `ann:${string}`;
  readonly bookReused: boolean;
  readonly annotationDigest: string;
  readonly requestDigest: string;
  readonly recordedAt: string;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("shelf-write-invalid-request", `${label} is required.`);
  }
  return value;
}

function validateQuoteRequest(request: ShelfQuoteWriteRequest): {
  readonly quote: string;
  readonly url: string;
  readonly getDate: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly comment?: string;
} {
  if (typeof request.requestId !== "string" || !REQUEST_ID_PATTERN.test(request.requestId)) {
    fail("shelf-write-invalid-request", "The request ID is invalid.");
  }
  const quote = requireString(request.quote, "quote");
  if (quote.trim().length === 0) fail("shelf-write-invalid-request", "The quote must not be blank.");
  const url = requireString(request.url, "url");
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("shelf-write-invalid-request", "The source URL is invalid."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("shelf-write-invalid-request", "The source URL must be http or https.");
  }
  const getDate = requireString(request.getDate, "get.date");
  if (!GET_DATE_PATTERN.test(getDate)) fail("shelf-write-invalid-request", "get.date must be YYYYMMDDHHMM.");
  const title = request.title === undefined ? undefined : requireString(request.title, "title");
  let authors: readonly string[] | undefined;
  if (request.authors !== undefined) {
    if (!Array.isArray(request.authors) || request.authors.some((author) => typeof author !== "string" || author.length === 0)) {
      fail("shelf-write-invalid-request", "authors must be non-empty strings.");
    }
    authors = request.authors.length === 0 ? undefined : Object.freeze([...request.authors]);
  }
  const comment = request.comment === undefined || request.comment === ""
    ? undefined
    : requireString(request.comment, "comment");
  return Object.freeze({
    quote, url, getDate,
    ...(title === undefined ? {} : { title }),
    ...(authors === undefined ? {} : { authors }),
    ...(comment === undefined ? {} : { comment })
  });
}

function buildBook(
  id: `book:${string}`,
  content: ReturnType<typeof validateQuoteRequest>
): ShelfBookV04 {
  return Object.freeze({
    type: "book",
    version: "0.4",
    id,
    source: Object.freeze({ kind: "website" }),
    get: Object.freeze({ date: content.getDate }),
    url: content.url,
    ...(content.title === undefined ? {} : { title: content.title }),
    ...(content.authors === undefined ? {} : { authors: content.authors })
  });
}

function buildAnnotation(
  id: `ann:${string}`,
  book: ShelfBookV04,
  content: ReturnType<typeof validateQuoteRequest>,
  commentField: "comment" | "privateMemo"
): ShelfAnnotationV04 {
  const base = {
    type: "annotation" as const,
    version: "0.4" as const,
    id,
    source: Object.freeze({ id: book.id, kind: "website" as const }),
    get: Object.freeze({ date: content.getDate }),
    quote: content.quote,
    url: content.url
  };
  if (content.comment === undefined) return Object.freeze(base);
  return Object.freeze(commentField === "comment"
    ? { ...base, comment: content.comment }
    : { ...base, privateMemo: content.comment });
}

/**
 * Idempotent cross-process Collector web-quote write.
 *
 * Order of durable effects:
 *   1. lease (cross-process exclusion, Shelf-scoped)
 *   2. journal `staged` (records the generated IDs and the content digest)
 *   3. Book publish (add-only, never replaces; reused when a compatible Book exists)
 *   4. Annotation publish (the commit point)
 *   5. journal `committed` (the receipt)
 *
 * A crash before step 5 leaves a resumable `staged` journal plus, at worst, an
 * add-only Book that a later request reuses. Retrying the same request ID
 * completes the interrupted write with the recorded IDs instead of appending a
 * second Annotation.
 */
export async function commitShelfQuote(request: ShelfQuoteWriteRequest): Promise<ShelfQuoteWriteReceipt> {
  const content = validateQuoteRequest(request);
  const commentField = request.commentField ?? "comment";
  if (commentField !== "comment" && commentField !== "privateMemo") {
    fail("shelf-write-invalid-request", "The comment field selector is invalid.");
  }
  const format = await loadFormatCore();
  const layout = await resolveShelfWriteLayout({
    shelfRoot: request.shelfRoot,
    expectedShelfId: request.expectedShelfId,
    coordinationRoot: request.coordinationRoot
  });
  // Every input that changes the persisted bytes is part of the digest. The comment
  // field selector decides whether the text lands in `comment` or `privateMemo`, so
  // a resend with the same request ID but a different field is a different request,
  // not a retry.
  const requestDigest = digestShelfWriteContent({ ...content, commentField });
  const nowIso = () => new Date(request.now?.() ?? Date.now()).toISOString();

  const lease = request.externalLock === undefined
    ? await acquireShelfWriteLease({
        coordinationRoot: request.coordinationRoot,
        shelfId: layout.shelfId,
        ...(request.processLabel === undefined ? {} : { processLabel: request.processLabel }),
        ...(request.leaseTtlMs === undefined ? {} : { leaseTtlMs: request.leaseTtlMs }),
        ...(request.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: request.acquireTimeoutMs }),
        ...(request.now === undefined ? {} : { now: request.now })
      })
    : undefined;
  // The guard is the file lease, or the caller's external OS lock when one is held.
  const guard: ShelfWriteExternalLock = request.externalLock ?? lease!;

  try {
    const journal = await readJournalRecord(layout, request.requestId);
    if (journal !== undefined && journal.requestDigest !== requestDigest) {
      fail("shelf-write-request-mismatch", "The request ID was already used with different content.");
    }
    if (journal !== undefined && journal.state === "committed") {
      if (!await shelfRecordExists(layout.booksDirectory, journal.bookId)) {
        fail("shelf-write-receipt-missing", "A committed receipt exists but its Book is missing.");
      }
      const onDisk = await annotationDigestOnDisk(layout.annotationsDirectory, journal.annotationId);
      if (onDisk === undefined) {
        fail("shelf-write-receipt-missing", "A committed receipt exists but its Annotation is missing.");
      }
      if (onDisk !== journal.annotationDigest.slice("sha256:".length)) {
        fail("shelf-write-receipt-missing", "A committed receipt exists but its Annotation changed.");
      }
      return Object.freeze({
        version: 1,
        state: "already-committed",
        requestId: journal.requestId,
        shelfId: layout.shelfId,
        bookId: journal.bookId,
        annotationId: journal.annotationId,
        bookReused: journal.bookReused,
        annotationDigest: journal.annotationDigest,
        requestDigest: journal.requestDigest,
        recordedAt: journal.committedAt ?? journal.updatedAt
      });
    }

    // Book reconciliation happens under the lease so two processes cannot both
    // decide "no such Book" and create duplicate Books for one source.
    const books = await readExistingShelfBooks(layout.booksDirectory, format);
    const stagedBook = journal === undefined
      ? undefined
      : books.find((book) => book.id === journal.bookId);
    const match = matchShelfBook(
      { sourceKind: "website", url: content.url, sourceFiles: [] },
      books
    );
    if (match.kind === "conflict") {
      await writeJournalRecord(layout, {
        version: SHELF_WRITE_JOURNAL_VERSION,
        kind: "shelf-write-request",
        shelfId: layout.shelfId,
        requestId: request.requestId,
        requestDigest,
        state: "aborted",
        bookId: journal?.bookId ?? (format.generateEntityId("book") as `book:${string}`),
        annotationId: journal?.annotationId ?? (format.generateEntityId("ann") as `ann:${string}`),
        bookReused: false,
        annotationDigest: "",
        stagedAt: journal?.stagedAt ?? nowIso(),
        updatedAt: nowIso(),
        writer: { pid: process.pid, process: request.processLabel ?? "unknown" },
        abortedReason: "book-conflict"
      });
      fail("shelf-write-book-conflict", "The source matches more than one incompatible Book.");
    }

    let bookId: `book:${string}`;
    let bookReused: boolean;
    let book: ShelfBookV04;
    if (stagedBook !== undefined) {
      book = stagedBook;
      bookId = stagedBook.id;
      bookReused = journal!.bookReused;
    } else if (match.kind === "match") {
      book = match.book;
      bookId = match.book.id;
      bookReused = true;
    } else {
      bookId = (journal?.bookId ?? format.generateEntityId("book")) as `book:${string}`;
      if (!BOOK_ID_PATTERN.test(bookId)) fail("shelf-write-invalid-request", "The generated Book ID is invalid.");
      book = buildBook(bookId, content);
      bookReused = false;
    }

    const bookValidation = format.validateShelfEntity("book", book);
    if (!bookValidation.valid) fail("shelf-write-invalid-request", "The planned Book is not Shelf v0.4 valid.");

    const annotationId = (journal?.annotationId ?? format.generateEntityId("ann")) as `ann:${string}`;
    if (!ANNOTATION_ID_PATTERN.test(annotationId)) fail("shelf-write-invalid-request", "The generated Annotation ID is invalid.");
    const annotation = buildAnnotation(annotationId, book, content, commentField);
    const annotationValidation = format.validateShelfEntity("annotation", annotation);
    if (!annotationValidation.valid) fail("shelf-write-invalid-request", "The planned Annotation is not Shelf v0.4 valid.");

    const serializedAnnotation = serializeShelfRecord(annotation);
    const annotationDigest = `sha256:${createHash("sha256").update(serializedAnnotation, "utf8").digest("hex")}`;

    if (journal === undefined || journal.state !== "staged") {
      await writeJournalRecord(layout, {
        version: SHELF_WRITE_JOURNAL_VERSION,
        kind: "shelf-write-request",
        shelfId: layout.shelfId,
        requestId: request.requestId,
        requestDigest,
        state: "staged",
        bookId,
        annotationId,
        bookReused,
        annotationDigest,
        stagedAt: nowIso(),
        updatedAt: nowIso(),
        writer: { pid: process.pid, process: request.processLabel ?? "unknown" }
      });
    } else if (journal.annotationDigest !== annotationDigest || journal.requestDigest !== requestDigest) {
      fail("shelf-write-request-mismatch", "The staged request no longer matches its recorded content.");
    }

    if (!bookReused) {
      await guard.assertHeld();
      await assertShelfWriteLayoutCurrent(layout);
      const state = await publishShelfFileNoReplace(
        path.join(layout.booksDirectory, shelfBookFilename(book)),
        Buffer.from(serializeShelfRecord(book), "utf8")
      );
      if (state === "conflict") fail("shelf-write-record-conflict", "A different Book already occupies the planned Book file.");
    }

    await request.faults?.beforeAnnotationPublish?.();

    await guard.assertHeld();
    await assertShelfWriteLayoutCurrent(layout);
    const published = await publishShelfFileNoReplace(
      path.join(layout.annotationsDirectory, shelfRecordFilename(annotationId)),
      Buffer.from(serializedAnnotation, "utf8")
    );
    if (published === "conflict") fail("shelf-write-record-conflict", "A different Annotation already occupies the planned Annotation file.");

    const committedAt = nowIso();
    const receipt: ShelfQuoteWriteReceipt = Object.freeze({
      version: 1,
      state: "committed",
      requestId: request.requestId,
      shelfId: layout.shelfId,
      bookId,
      annotationId,
      bookReused,
      annotationDigest,
      requestDigest,
      recordedAt: committedAt
    });
    await writeJournalRecord(layout, {
      version: SHELF_WRITE_JOURNAL_VERSION,
      kind: "shelf-write-request",
      shelfId: layout.shelfId,
      requestId: request.requestId,
      requestDigest,
      state: "committed",
      bookId,
      annotationId,
      bookReused,
      annotationDigest,
      stagedAt: journal?.stagedAt ?? committedAt,
      updatedAt: committedAt,
      writer: { pid: process.pid, process: request.processLabel ?? "unknown" },
      committedAt
    });
    return receipt;
  } finally {
    await lease?.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Journal inspection (recovery evidence)                                     */
/* -------------------------------------------------------------------------- */

export interface ShelfWriteJournalEntry {
  readonly record: ShelfWriteJournalRecord;
  readonly annotationPresent: boolean;
  readonly bookPresent: boolean;
  readonly matchesDisk: boolean;
}

/**
 * Read-only inspection used to prove crash recovery and to report interrupted
 * writes. Does not repair anything: a `staged` entry is completed by retrying the
 * same request ID, and an add-only Book left behind is reused by the locator.
 */
export async function inspectShelfWriteJournal(options: {
  readonly shelfRoot: string;
  readonly expectedShelfId: string;
  readonly coordinationRoot: string;
}): Promise<readonly ShelfWriteJournalEntry[]> {
  const layout = await resolveShelfWriteLayout(options);
  const directory = path.join(layout.coordinationDirectory, "requests");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isMissing(error)) return Object.freeze([]);
    fail("shelf-write-journal-unavailable", "The Shelf write journal cannot be listed.");
  }
  const books = await readdir(layout.booksDirectory).catch(() => [] as string[]);
  const annotations = await readdir(layout.annotationsDirectory).catch(() => [] as string[]);
  const entries: ShelfWriteJournalEntry[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const requestId = name.slice(0, -".json".length);
    // A file whose name cannot be a request ID is not a journal record. A
    // well-named record with invalid content still throws
    // `shelf-write-journal-invalid`, because silently skipping it would let a
    // damaged journal look like a complete, clean journal.
    if (!REQUEST_ID_PATTERN.test(requestId)) continue;
    const record = await readJournalRecord(layout, requestId);
    if (record === undefined) continue;
    const annotationPresent = annotations.includes(shelfRecordFilename(record.annotationId));
    const bookPresent = books.includes(shelfRecordFilename(record.bookId));
    const onDisk = await annotationDigestOnDisk(layout.annotationsDirectory, record.annotationId);
    entries.push(Object.freeze({
      record,
      annotationPresent,
      bookPresent,
      matchesDisk: record.annotationDigest.length === 0
        ? true
        : onDisk !== undefined && record.annotationDigest === `sha256:${onDisk}`
    }));
  }
  return Object.freeze(entries);
}
