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
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ShelfAnnotationV04,
  ShelfBookV04
} from "@maginalia/format" with { "resolution-mode": "import" };
import { inspectFolderMarkers } from "./folder-identity.js";
import { assertSafeRoot } from "./repository-filesystem.js";
import {
  isInsideDirectory,
  matchShelfBook,
  publishShelfFileNoReplace,
  readExistingShelfBooks,
  resolveShelfDirectories,
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
/** A lease older than this is treated as abandoned even if its PID is reused. */
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
  | "shelf-write-journal-unavailable"
  | "shelf-write-request-mismatch"
  | "shelf-write-book-conflict"
  | "shelf-write-record-conflict"
  | "shelf-write-receipt-missing";

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

  const resolution = await resolveShelfDirectories(root);
  if (resolution.kind !== "ok") {
    fail("shelf-write-layout-invalid", `The Private Shelf layout is not writable (${resolution.kind}).`);
  }

  let coordinationDirectory: string;
  try {
    await mkdir(options.coordinationRoot, { recursive: true });
    const shelfCoordinationPath = path.join(options.coordinationRoot, "shelves", shelfId.toLowerCase());
    await mkdir(path.join(shelfCoordinationPath, "requests"), { recursive: true });
    coordinationDirectory = await realpath(shelfCoordinationPath);
  } catch {
    fail("shelf-write-journal-unavailable", "The coordination directory is unavailable.");
  }
  const coordinationRootReal = await realpath(options.coordinationRoot);
  // Coordination state must never become Shelf user data, and the Shelf must not
  // be nested inside the coordination root.
  if (isInsideDirectory(root, coordinationRootReal) || isInsideDirectory(coordinationRootReal, root)) {
    fail("shelf-write-unsafe-path", "The coordination root overlaps the Private Shelf.");
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
  readonly leaseTtlMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injectable clock; milliseconds since epoch. Required for staleness tests. */
  readonly now?: () => number;
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

async function readLeaseMetadata(lockPath: string): Promise<ShelfWriteLeaseMetadata | undefined> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.version !== SHELF_WRITE_LEASE_VERSION
      || typeof value.shelfId !== "string"
      || typeof value.token !== "string"
      || value.token.length < 16
      || typeof value.pid !== "number"
      || typeof value.processLabel !== "string"
      || typeof value.acquiredAt !== "string"
      || typeof value.heartbeatAt !== "number") return undefined;
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

function leaseIsStale(metadata: ShelfWriteLeaseMetadata, now: number, ttlMs: number): boolean {
  if (!processIsAlive(metadata.pid)) return true;
  return now - metadata.heartbeatAt > ttlMs;
}

/**
 * Acquire the Shelf-scoped cross-process write lease.
 *
 * The lease is a `wx`-created file, so creation itself is the atomic
 * compare-and-set. A crashed holder is evicted by an atomic rename of the stale
 * lock to a quarantine name; only one contender wins that rename, and the loser
 * retries creation and still observes the winner's lock.
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

    const existing = await readLeaseMetadata(lockPath);
    if (existing !== undefined && leaseIsStale(existing, now(), ttlMs)) {
      const quarantine = `${lockPath}.${randomUUID()}.stale`;
      try {
        await rename(lockPath, quarantine);
        try { await unlink(quarantine); } catch { /* Quarantine cleanup is best effort. */ }
      } catch { /* Another contender evicted it first. */ }
      continue;
    }
    if (now() >= deadline) {
      fail("shelf-write-busy", "Another process holds the Shelf write lease.", existing?.processLabel);
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

async function readJournalRecord(
  layout: ShelfWriteLayout,
  requestId: string
): Promise<ShelfWriteJournalRecord | undefined> {
  const target = path.join(layout.coordinationDirectory, "requests", `${requestId}.json`);
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    fail("shelf-write-journal-unavailable", "The Shelf write journal record cannot be read.");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const value = parsed as Record<string, unknown>;
    if (value.version !== SHELF_WRITE_JOURNAL_VERSION
      || value.kind !== "shelf-write-request"
      || typeof value.requestId !== "string"
      || typeof value.shelfId !== "string"
      || typeof value.requestDigest !== "string"
      || (value.state !== "staged" && value.state !== "committed" && value.state !== "aborted")
      || typeof value.bookId !== "string"
      || typeof value.annotationId !== "string"
      || typeof value.annotationDigest !== "string"
      || typeof value.stagedAt !== "string"
      || typeof value.updatedAt !== "string"
      || typeof value.bookReused !== "boolean") throw new Error("invalid");
    return Object.freeze({
      version: SHELF_WRITE_JOURNAL_VERSION,
      kind: "shelf-write-request",
      shelfId: value.shelfId,
      requestId: value.requestId,
      requestDigest: value.requestDigest,
      state: value.state,
      bookId: value.bookId as `book:${string}`,
      annotationId: value.annotationId as `ann:${string}`,
      bookReused: value.bookReused,
      annotationDigest: value.annotationDigest,
      stagedAt: value.stagedAt,
      updatedAt: value.updatedAt,
      writer: typeof value.writer === "object" && value.writer !== null
        ? Object.freeze({
          pid: typeof (value.writer as Record<string, unknown>).pid === "number" ? (value.writer as Record<string, number>).pid : 0,
          process: typeof (value.writer as Record<string, unknown>).process === "string"
            ? (value.writer as Record<string, string>).process
            : "unknown"
        })
        : Object.freeze({ pid: 0, process: "unknown" }),
      ...(typeof value.committedAt === "string" ? { committedAt: value.committedAt } : {}),
      ...(typeof value.abortedReason === "string" ? { abortedReason: value.abortedReason } : {})
    });
  } catch {
    fail("shelf-write-journal-unavailable", "The Shelf write journal record is corrupt.");
  }
}

async function annotationDigestOnDisk(directory: string, annotationId: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path.join(directory, shelfRecordFilename(annotationId)));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
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
  const format = await loadFormatCore();
  const layout = await resolveShelfWriteLayout({
    shelfRoot: request.shelfRoot,
    expectedShelfId: request.expectedShelfId,
    coordinationRoot: request.coordinationRoot
  });
  const requestDigest = digestShelfWriteContent(content);
  const nowIso = () => new Date(request.now?.() ?? Date.now()).toISOString();

  const lease = await acquireShelfWriteLease({
    coordinationRoot: request.coordinationRoot,
    shelfId: layout.shelfId,
    ...(request.processLabel === undefined ? {} : { processLabel: request.processLabel }),
    ...(request.leaseTtlMs === undefined ? {} : { leaseTtlMs: request.leaseTtlMs }),
    ...(request.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: request.acquireTimeoutMs }),
    ...(request.now === undefined ? {} : { now: request.now })
  });

  try {
    const journal = await readJournalRecord(layout, request.requestId);
    if (journal !== undefined && journal.requestDigest !== requestDigest) {
      fail("shelf-write-request-mismatch", "The request ID was already used with different content.");
    }
    if (journal !== undefined && journal.state === "committed") {
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
      await lease.assertHeld();
      await assertShelfWriteLayoutCurrent(layout);
      const state = await publishShelfFileNoReplace(
        path.join(layout.booksDirectory, shelfBookFilename(book)),
        Buffer.from(serializeShelfRecord(book), "utf8")
      );
      if (state === "conflict") fail("shelf-write-record-conflict", "A different Book already occupies the planned Book file.");
    }

    await request.faults?.beforeAnnotationPublish?.();

    await lease.assertHeld();
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
    await lease.release();
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
    const record = await readJournalRecord(layout, name.slice(0, -".json".length));
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
