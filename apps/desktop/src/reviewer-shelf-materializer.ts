/**
 * Main-process-only, conflict-safe Reviewer -> Private Shelf v0.4 writer.
 *
 * The publication primitives (path safety, no-replace writes, Book matching)
 * are owned by `shelf-write-core`; this module only holds Reviewer policy.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import type {
  ShelfAnnotation,
  ShelfAnnotationV04,
  ShelfBook,
  ShelfBookV04,
  ShelfSourceFileV04
} from "@maginalia/format" with { "resolution-mode": "import" };
import {
  createReviewerReconciliationCandidate,
  materializeReviewerReconciliationCandidate,
  REVIEWER_SHELF_PROVENANCE_VERSION,
  type ApprovedReviewerRecord,
  type OpenBdBookMetadata,
  type ReviewerReconciliationCandidate,
  type ReviewerReconciliationPending
} from "./reviewer-shelf-reconciliation";
import {
  ensureShelfDirectory,
  isInsideDirectory,
  listShelfRecordFiles,
  matchShelfBook,
  publishShelfFileNoReplace,
  readExistingShelfBooks,
  resolveShelfDirectories,
  serializeShelfRecord,
  shelfBookFilename,
  shelfRecordFilename
} from "./shelf-write-core.js";
import { acquireShelfWriteLease } from "./shelf-write-coordination.js";

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });
let formatCorePromise: Promise<FormatCore> | undefined;
function loadFormatCore(): Promise<FormatCore> {
  formatCorePromise ??= import("@maginalia/format");
  return formatCorePromise;
}

export interface ReviewerShelfMetadataLookup {
  (isbn13: string): Promise<
    | { readonly status: "ok"; readonly metadata: OpenBdBookMetadata }
    | { readonly status: string }
  >;
}

export interface MaterializationResult {
  readonly materialized: number;
  readonly unchanged: number;
  readonly pending: readonly ReviewerReconciliationPending[];
  readonly conflicts: number;
}

interface AliasEntry {
  readonly digest: string;
  readonly version?: number;
}

function reviewerAlias(annotation: ShelfAnnotation): { readonly annotationId: string; readonly digest: string; readonly version?: number } | undefined {
  const metadata = annotation.deviceMetadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const provenance = (metadata as Record<string, unknown>).maginaliaReviewer;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = provenance as Record<string, unknown>;
  return typeof value.annotationId === "string" && typeof value.digest === "string"
    ? { annotationId: value.annotationId, digest: value.digest, ...(typeof value.version === "number" ? { version: value.version } : {}) }
    : undefined;
}

async function existingAliases(directory: string, format: FormatCore): Promise<Map<string, AliasEntry[]>> {
  const aliases = new Map<string, AliasEntry[]>();
  for (const filename of await listShelfRecordFiles(directory, directory)) {
    try {
      const validated = format.parseShelfEntity("annotation", await readFile(filename, "utf8"));
      if (!validated.valid) continue;
      const alias = reviewerAlias(validated.value);
      if (!alias) continue;
      const matches = aliases.get(alias.annotationId) ?? [];
      matches.push({ digest: alias.digest, version: alias.version });
      aliases.set(alias.annotationId, matches);
    } catch { /* Invalid user data is never adopted or rewritten. */ }
  }
  return aliases;
}

function sourceFolderKey(candidate: ReviewerReconciliationCandidate): string {
  const identity = candidate.canonicalSourceAssets
    .map(({ file }) => `${file.mediaType}:${file.sha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(identity || `${candidate.packageId}:${candidate.sourceKind}`, "utf8").digest("hex");
}

function legacyReviewerDigest(record: ApprovedReviewerRecord): string | undefined {
  if (record.reviewState !== "APPROVED"
    || typeof record.annotationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(record.annotationId)
    || typeof record.isbn13 !== "string"
    || !/^[0-9]{13}$/u.test(record.isbn13)
    || typeof record.quote !== "string"
    || typeof record.pageLabel !== "string"
    || typeof record.comment !== "string") return undefined;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(record.isbn13[index]) * (index % 2 === 0 ? 1 : 3);
  if ((10 - sum % 10) % 10 !== Number(record.isbn13[12])) return undefined;
  const canonical = JSON.stringify({
    annotationId: record.annotationId,
    comment: record.comment,
    isbn13: record.isbn13,
    pageLabel: record.pageLabel,
    quote: record.quote,
    reviewState: record.reviewState
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function shelfRelativePath(value: string): string | null {
  if (value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return value;
}

async function prepareBookAndFiles(
  root: string,
  candidate: ReviewerReconciliationCandidate,
  selectedBook: ShelfBookV04 | undefined,
  format: FormatCore
): Promise<{ readonly book: ShelfBookV04; readonly files: readonly ShelfSourceFileV04[] } | null> {
  if (selectedBook !== undefined) {
    const existingFiles = selectedBook.source.files ?? [];
    if (candidate.canonicalSourceAssets.length > 0) {
      for (const asset of candidate.canonicalSourceAssets) {
        const existingFile = existingFiles.find((file) => file.sha256 === asset.file.sha256 && file.mediaType === asset.file.mediaType);
        if (existingFile === undefined) return null;
        const relative = shelfRelativePath(existingFile.path);
        if (relative === null) return null;
        const target = path.resolve(root, relative);
        if (!isInsideDirectory(root, target)) return null;
        const directory = path.dirname(target);
        if (!await ensureShelfDirectory(root, directory)) return null;
        const state = await publishShelfFileNoReplace(target, asset.bytes);
        if (state === "conflict") return null;
      }
    }
    return { book: selectedBook, files: Object.freeze([...existingFiles]) };
  }

  const shelfFiles: ShelfSourceFileV04[] = [];
  for (const asset of candidate.canonicalSourceAssets) {
    const packagePath = shelfRelativePath(asset.file.path);
    if (packagePath === null) return null;
    const relative = `sources/${sourceFolderKey(candidate)}/${packagePath}`;
    const target = path.resolve(root, ...relative.split("/"));
    if (!isInsideDirectory(root, target) || !await ensureShelfDirectory(root, path.dirname(target))) return null;
    const state = await publishShelfFileNoReplace(target, asset.bytes);
    if (state === "conflict") return null;
    shelfFiles.push(Object.freeze({
      path: relative,
      mediaType: asset.file.mediaType,
      sha256: asset.file.sha256,
      ...(asset.file.originalName === undefined ? {} : { originalName: asset.file.originalName })
    }));
  }
  const book: ShelfBookV04 = Object.freeze({
    type: "book",
    version: "0.4",
    id: candidate.bookId,
    source: Object.freeze({
      kind: candidate.sourceKind,
      ...(shelfFiles.length === 0 ? {} : { files: Object.freeze(shelfFiles) })
    }),
    get: Object.freeze({ date: candidate.getDate }),
    ...(candidate.isbn13 === undefined ? {} : { isbn13: candidate.isbn13 }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    ...(candidate.authors.length === 0 ? {} : { authors: Object.freeze([...candidate.authors]) }),
    ...(candidate.publisher === undefined ? {} : { publisher: candidate.publisher }),
    ...(candidate.year === undefined ? {} : { year: candidate.year }),
    ...(candidate.circleName === undefined ? {} : { circleName: candidate.circleName }),
    ...(candidate.eventName === undefined ? {} : { eventName: candidate.eventName })
  });
  const validated = format.validateShelfEntity("book", book);
  if (!validated.valid) return null;
  return { book: validated.value as ShelfBookV04, files: Object.freeze(shelfFiles) };
}

async function materializeUnlocked(
  shelfRoot: string,
  records: readonly ApprovedReviewerRecord[],
  lookupMetadata: ReviewerShelfMetadataLookup
): Promise<MaterializationResult> {
  const format = await loadFormatCore();
  let root: string;
  try { root = await realpath(shelfRoot); } catch { throw new Error("The selected Private Shelf is unavailable."); }
  const resolution = await resolveShelfDirectories(root);
  if (resolution.kind !== "ok") {
    switch (resolution.kind) {
      case "library-unreadable": throw new Error("The selected Private Shelf has no readable library.json.");
      case "library-invalid": throw new Error("The selected Private Shelf library is invalid.");
      case "paths-invalid": throw new Error("The Private Shelf paths are invalid.");
      case "paths-unsafe": throw new Error("The Private Shelf paths are unavailable or unsafe.");
    }
  }
  const { booksDirectory, annotationsDirectory } = resolution.directories;

  const aliases = await existingAliases(annotationsDirectory, format);
  const books = await readExistingShelfBooks(booksDirectory, format);
  const pending: ReviewerReconciliationPending[] = [];
  let materialized = 0;
  let unchanged = 0;
  let conflicts = 0;

  for (const record of records) {
    const prior = typeof record.annotationId === "string" ? aliases.get(record.annotationId) : undefined;
    const legacyDigest = legacyReviewerDigest(record);
    if (prior !== undefined
      && prior.length === 1
      && prior[0].version === 1
      && legacyDigest !== undefined
      && prior[0].digest === legacyDigest) {
      unchanged += 1;
      continue;
    }
    let enrichment: unknown;
    if (record.isbn13 && (!record.title || !record.authors || record.authors.length === 0)) {
      try {
        const result = await lookupMetadata(record.isbn13);
        if (result.status === "ok" && "metadata" in result) enrichment = result.metadata;
      } catch { /* Provider enrichment is optional; package provenance is not. */ }
    }
    const candidateResult = await createReviewerReconciliationCandidate(record, enrichment);
    if (candidateResult.kind === "pending") {
      if (prior !== undefined) conflicts += 1;
      else pending.push(candidateResult);
      continue;
    }
    const candidate = candidateResult;
    if (prior !== undefined) {
      if (prior.length === 1 && prior[0].version === REVIEWER_SHELF_PROVENANCE_VERSION && prior[0].digest === candidate.digest) unchanged += 1;
      else conflicts += 1;
      continue;
    }

    const match = matchShelfBook(candidate, books);
    if (match.kind === "conflict") { conflicts += 1; continue; }
    const prepared = await prepareBookAndFiles(root, candidate, match.kind === "match" ? match.book : undefined, format);
    if (prepared === null) { conflicts += 1; continue; }

    if (match.kind === "new") {
      const target = path.join(booksDirectory, shelfBookFilename(prepared.book));
      const state = await publishShelfFileNoReplace(target, Buffer.from(serializeShelfRecord(prepared.book), "utf8"));
      if (state === "conflict") { conflicts += 1; continue; }
      books.push(prepared.book);
    }

    const output = await materializeReviewerReconciliationCandidate(
      candidate,
      prepared.book,
      prepared.files
    );
    if (output.kind === "pending") { pending.push(output); continue; }
    const annotationTarget = path.join(annotationsDirectory, shelfRecordFilename(output.annotation.id));
    const state = await publishShelfFileNoReplace(annotationTarget, Buffer.from(serializeShelfRecord(output.annotation), "utf8"));
    if (state === "conflict") { conflicts += 1; continue; }
    const entries = aliases.get(candidate.reviewerAnnotationId) ?? [];
    entries.push({ digest: candidate.digest });
    aliases.set(candidate.reviewerAnnotationId, entries);
    if (state === "same") unchanged += 1;
    else materialized += 1;
  }
  return Object.freeze({ materialized, unchanged, pending: Object.freeze(pending), conflicts });
}

// The Desktop single-instance main process serializes Shelf writes so a manual
// retry and an approval-triggered retry cannot create duplicate aliases.
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Opt-in cross-process exclusion for the Desktop writer.
 *
 * The process-local queue above only protects this process. A Collector Native
 * Messaging Host writing to the same configured Shelf needs the Shelf-scoped
 * lease from the shared coordination layer. Passing this option is what makes the
 * Desktop writer and the Host mutually exclusive; omitting it preserves today's
 * behavior exactly. Enablement is an owner decision, not implied by this type.
 */
export interface ReviewerShelfWriteCoordination {
  readonly coordinationRoot: string;
  /** Stable Shelf UUID from the folder marker (D068). */
  readonly shelfId: string;
  readonly acquireTimeoutMs?: number;
}

export function materializeReviewerRecords(
  shelfRoot: string,
  records: readonly ApprovedReviewerRecord[],
  lookupMetadata: ReviewerShelfMetadataLookup,
  coordination?: ReviewerShelfWriteCoordination
): Promise<MaterializationResult> {
  const result = writeQueue.then(async () => {
    if (coordination === undefined) return materializeUnlocked(shelfRoot, records, lookupMetadata);
    const lease = await acquireShelfWriteLease({
      coordinationRoot: coordination.coordinationRoot,
      shelfId: coordination.shelfId,
      processLabel: "desktop-main",
      ...(coordination.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: coordination.acquireTimeoutMs })
    });
    try {
      return await materializeUnlocked(shelfRoot, records, lookupMetadata);
    } finally {
      await lease.release();
    }
  });
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}
