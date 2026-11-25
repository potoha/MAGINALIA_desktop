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
import {
  SHELF_REVIEWER_ENRICHMENT_MAX_BYTES,
  ShelfWriteCoordinationError,
  commitShelfRecordTransaction,
  readShelfWriteJournalRecord,
  type ShelfRecordWritePlan,
  type ShelfReviewerEnrichmentSnapshot,
  type ShelfWriteJournalRecord
} from "./shelf-write-coordination.js";
import {
  clearShelfWriterRecoveryState,
  withNativeShelfWriteSection,
  writeShelfWriterRecoveryState,
  type NativeShelfWriteSectionContext
} from "./shelf-native-write-lock.js";

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
      addReviewerAlias(aliases, validated.value);
    } catch { /* Invalid user data is never adopted or rewritten. */ }
  }
  return aliases;
}

function addReviewerAlias(aliases: Map<string, AliasEntry[]>, annotation: ShelfAnnotation): void {
  const alias = reviewerAlias(annotation);
  if (!alias) return;
  const matches = aliases.get(alias.annotationId) ?? [];
  matches.push({ digest: alias.digest, version: alias.version });
  aliases.set(alias.annotationId, matches);
}

function sourceFolderKey(candidate: ReviewerReconciliationCandidate): string {
  const identity = candidate.canonicalSourceAssets
    .map(({ file }) => `${file.mediaType}:${file.sha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(identity || `${candidate.packageId}:${candidate.sourceKind}`, "utf8").digest("hex");
}

function snapshotOpenBdMetadata(metadata: OpenBdBookMetadata): ShelfReviewerEnrichmentSnapshot {
  if (typeof metadata.isbn13 !== "string" || !/^[0-9]{13}$/u.test(metadata.isbn13)
    || typeof metadata.title !== "string"
    || !Array.isArray(metadata.authors)
    || !metadata.authors.every((author) => typeof author === "string")) {
    return Object.freeze({ kind: "none" });
  }
  const normalized = Object.freeze({
    isbn13: metadata.isbn13,
    title: metadata.title,
    authors: Object.freeze([...metadata.authors]),
    ...(typeof metadata.publisher === "string" ? { publisher: metadata.publisher } : {}),
    ...(typeof metadata.year === "number" && Number.isSafeInteger(metadata.year) && metadata.year >= 0
      ? { year: metadata.year }
      : {})
  });
  if (metadata.authors.length > 128
    || Buffer.byteLength(metadata.title, "utf8") > SHELF_REVIEWER_ENRICHMENT_MAX_BYTES
    || metadata.authors.some((author) => Buffer.byteLength(author, "utf8") > SHELF_REVIEWER_ENRICHMENT_MAX_BYTES)
    || (normalized.publisher !== undefined
      && Buffer.byteLength(normalized.publisher, "utf8") > SHELF_REVIEWER_ENRICHMENT_MAX_BYTES)
    || Buffer.byteLength(JSON.stringify(normalized), "utf8") > SHELF_REVIEWER_ENRICHMENT_MAX_BYTES) {
    // OpenBD enrichment is optional. If it cannot fit in the shared request
    // journal, preserve the approved Reviewer record and commit without the
    // optional provider fields rather than introducing a new write-size limit.
    return Object.freeze({ kind: "none" });
  }
  return Object.freeze({ kind: "openbd", metadata: normalized });
}

/** Hash the exact opaque Reviewer identity into the bounded shared-journal keyspace. */
function reviewerRequestId(annotationId: string): string {
  const digest = createHash("sha256").update(annotationId, "utf8").digest("hex");
  // Windows forbids ':' in file names, and request IDs are used as journal names.
  return `reviewer-${digest}`;
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
): Promise<{
  readonly book: ShelfBookV04;
  readonly files: readonly ShelfSourceFileV04[];
  readonly assets: ShelfRecordWritePlan["assets"];
} | null> {
  if (selectedBook !== undefined) {
    const existingFiles = selectedBook.source.files ?? [];
    const assets: { readonly relativePath: string; readonly bytes: Uint8Array }[] = [];
    if (candidate.canonicalSourceAssets.length > 0) {
      for (const asset of candidate.canonicalSourceAssets) {
        const existingFile = existingFiles.find((file) => file.sha256 === asset.file.sha256 && file.mediaType === asset.file.mediaType);
        if (existingFile === undefined) return null;
        const relative = shelfRelativePath(existingFile.path);
        if (relative === null) return null;
        const target = path.resolve(root, relative);
        if (!isInsideDirectory(root, target)) return null;
        const bytes = new Uint8Array(asset.bytes);
        if (createHash("sha256").update(bytes).digest("hex") !== asset.file.sha256) return null;
        assets.push(Object.freeze({ relativePath: relative, bytes }));
      }
    }
    return { book: selectedBook, files: Object.freeze([...existingFiles]), assets: Object.freeze(assets) };
  }

  const shelfFiles: ShelfSourceFileV04[] = [];
  const assets: { readonly relativePath: string; readonly bytes: Uint8Array }[] = [];
  for (const asset of candidate.canonicalSourceAssets) {
    const packagePath = shelfRelativePath(asset.file.path);
    if (packagePath === null) return null;
    const relative = `sources/${sourceFolderKey(candidate)}/${packagePath}`;
    const target = path.resolve(root, ...relative.split("/"));
    if (!isInsideDirectory(root, target)) return null;
    const bytes = new Uint8Array(asset.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.file.sha256) return null;
    assets.push(Object.freeze({ relativePath: relative, bytes }));
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
  return {
    book: validated.value as ShelfBookV04,
    files: Object.freeze(shelfFiles),
    assets: Object.freeze(assets)
  };
}

async function materializeUnlocked(
  shelfRoot: string,
  records: readonly ApprovedReviewerRecord[],
  lookupMetadata: ReviewerShelfMetadataLookup,
  nativeContext?: {
    readonly coordination: ReviewerShelfWriteCoordination;
    readonly section: NativeShelfWriteSectionContext;
  }
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
  let recoveryFile: string | undefined;

  const interrupted = new Set(nativeContext?.section.recoveryAssessment?.interruptedRequestIds ?? []);
  const orderedRecords = interrupted.size === 0
    ? records
    : [
        ...records.filter((record) => typeof record.annotationId === "string" && interrupted.has(reviewerRequestId(record.annotationId))),
        ...records.filter((record) => typeof record.annotationId !== "string" || !interrupted.has(reviewerRequestId(record.annotationId)))
      ];

  const journalByRequestId = new Map<string, ShelfWriteJournalRecord | undefined>();
  if (nativeContext !== undefined) {
    for (const record of orderedRecords) {
      if (typeof record.annotationId !== "string") continue;
      const requestId = reviewerRequestId(record.annotationId);
      if (journalByRequestId.has(requestId)) continue;
      const prior = aliases.get(record.annotationId);
      const recoveringThisRecord = interrupted.has(requestId);
      const legacyDigest = legacyReviewerDigest(record);
      const isUnchangedLegacyAlias = prior !== undefined
        && prior.length === 1
        && prior[0].version === 1
        && legacyDigest !== undefined
        && prior[0].digest === legacyDigest;
      if (isUnchangedLegacyAlias && !recoveringThisRecord) {
        journalByRequestId.set(requestId, undefined);
        continue;
      }
      const journal = await readShelfWriteJournalRecord({
        shelfRoot: root,
        expectedShelfId: nativeContext.coordination.expectedShelfId,
        coordinationRoot: nativeContext.coordination.coordinationRoot,
        requestId
      });
      if (journal !== undefined && journal.version !== 2) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-recovery-state-unavailable",
          "A legacy Reviewer journal lacks the versioned metadata snapshot required for safe retry.",
          requestId
        );
      }
      journalByRequestId.set(requestId, journal);
    }
  }

  for (const record of orderedRecords) {
    const requestId = nativeContext !== undefined && typeof record.annotationId === "string"
      ? reviewerRequestId(record.annotationId)
      : undefined;
    const recoveringThisRecord = requestId !== undefined && interrupted.has(requestId);
    const prior = typeof record.annotationId === "string" ? aliases.get(record.annotationId) : undefined;
    const legacyDigest = legacyReviewerDigest(record);
    if (prior !== undefined
      && prior.length === 1
      && prior[0].version === 1
      && legacyDigest !== undefined
      && prior[0].digest === legacyDigest) {
      if (recoveringThisRecord) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-recovery-state-unavailable",
          "An interrupted Reviewer write no longer has a resumable v0.4 source record.",
          requestId
        );
      }
      unchanged += 1;
      continue;
    }
    const journal = requestId === undefined || nativeContext === undefined
      ? undefined
      : journalByRequestId.get(requestId);
    if (journal !== undefined && journal.version !== 2) {
      throw new ShelfWriteCoordinationError(
        "shelf-write-recovery-state-unavailable",
        "A legacy Reviewer journal lacks the versioned metadata snapshot required for safe retry.",
        requestId
      );
    }
    let enrichment: unknown;
    let reviewerEnrichment: ShelfReviewerEnrichmentSnapshot = Object.freeze({ kind: "none" });
    if (journal?.version === 2) {
      reviewerEnrichment = journal.reviewerEnrichment!;
      if (reviewerEnrichment.kind === "openbd") enrichment = reviewerEnrichment.metadata;
    } else if (record.isbn13 && (!record.title || !record.authors || record.authors.length === 0)) {
      let lookupResult: Awaited<ReturnType<ReviewerShelfMetadataLookup>> | undefined;
      try {
        lookupResult = await lookupMetadata(record.isbn13);
      } catch { /* Provider enrichment is optional; package provenance is not. */ }
      if (lookupResult?.status === "ok" && "metadata" in lookupResult) {
        if (nativeContext === undefined) enrichment = lookupResult.metadata;
        else {
          reviewerEnrichment = snapshotOpenBdMetadata(lookupResult.metadata);
          if (reviewerEnrichment.kind === "openbd") enrichment = reviewerEnrichment.metadata;
        }
      }
    }
    const candidateResult = await createReviewerReconciliationCandidate(record, enrichment);
    if (candidateResult.kind === "pending") {
      if (recoveringThisRecord) {
        throw new ShelfWriteCoordinationError(
          "shelf-write-recovery-state-unavailable",
          "An interrupted Reviewer write cannot be rebuilt from its approved source record.",
          requestId
        );
      }
      if (prior !== undefined) conflicts += 1;
      else pending.push(candidateResult);
      continue;
    }
    const candidate = candidateResult;
    if (prior !== undefined && journal === undefined) {
      if (prior.length === 1 && prior[0].version === REVIEWER_SHELF_PROVENANCE_VERSION && prior[0].digest === candidate.digest) unchanged += 1;
      else conflicts += 1;
      continue;
    }

    if (nativeContext === undefined || requestId === undefined) {
      if (prior !== undefined) {
        if (prior.length === 1 && prior[0].version === REVIEWER_SHELF_PROVENANCE_VERSION && prior[0].digest === candidate.digest) unchanged += 1;
        else conflicts += 1;
        continue;
      }
      const match = matchShelfBook(candidate, books);
      if (match.kind === "conflict") { conflicts += 1; continue; }
      const prepared = await prepareBookAndFiles(root, candidate, match.kind === "match" ? match.book : undefined, format);
      if (prepared === null) { conflicts += 1; continue; }
      let assetConflict = false;
      for (const asset of prepared.assets) {
        const target = path.resolve(root, ...asset.relativePath.split("/"));
        if (!await ensureShelfDirectory(root, path.dirname(target))) { assetConflict = true; break; }
        if (await publishShelfFileNoReplace(target, Buffer.from(asset.bytes)) === "conflict") { assetConflict = true; break; }
      }
      if (assetConflict) { conflicts += 1; continue; }
      if (match.kind === "new") {
        const target = path.join(booksDirectory, shelfBookFilename(prepared.book));
        const state = await publishShelfFileNoReplace(target, Buffer.from(serializeShelfRecord(prepared.book), "utf8"));
        if (state === "conflict") { conflicts += 1; continue; }
        books.push(prepared.book);
      }
      const output = await materializeReviewerReconciliationCandidate(candidate, prepared.book, prepared.files);
      if (output.kind === "pending") { pending.push(output); continue; }
      const annotationTarget = path.join(annotationsDirectory, shelfRecordFilename(output.annotation.id));
      const state = await publishShelfFileNoReplace(annotationTarget, Buffer.from(serializeShelfRecord(output.annotation), "utf8"));
      if (state === "conflict") { conflicts += 1; continue; }
      const entries = aliases.get(candidate.reviewerAnnotationId) ?? [];
      entries.push({ digest: candidate.digest });
      aliases.set(candidate.reviewerAnnotationId, entries);
      if (state === "same") unchanged += 1;
      else materialized += 1;
      continue;
    }

    if (journal?.state === "aborted") {
      if (recoveringThisRecord) {
        throw new ShelfWriteCoordinationError("shelf-write-recovery-state-unavailable", "An interrupted Reviewer request has an aborted journal record.", requestId);
      }
      conflicts += 1;
      continue;
    }
    if (prior !== undefined
      && (prior.length !== 1
        || prior[0].version !== REVIEWER_SHELF_PROVENANCE_VERSION
        || prior[0].digest !== candidate.digest)) {
      if (recoveringThisRecord) {
        throw new ShelfWriteCoordinationError("shelf-write-request-mismatch", "The staged Reviewer Annotation no longer matches its approved source record.", requestId);
      }
      conflicts += 1;
      continue;
    }

    let plannedCandidate = candidate;
    let selectedBook: ShelfBookV04 | undefined;
    let bookReused = false;
    if (journal !== undefined) {
      plannedCandidate = Object.freeze({ ...candidate, bookId: journal.bookId });
      const match = matchShelfBook(plannedCandidate, books);
      if (match.kind === "conflict"
        || (match.kind === "match" && match.book.id !== journal.bookId)
        || (journal.bookReused && (match.kind !== "match" || match.book.id !== journal.bookId))) {
        if (recoveringThisRecord) {
          throw new ShelfWriteCoordinationError("shelf-write-recovery-state-unavailable", "The staged Reviewer Book can no longer be reconciled safely.", requestId);
        }
        conflicts += 1;
        continue;
      }
      if (journal.bookReused) {
        selectedBook = match.kind === "match" ? match.book : undefined;
        bookReused = true;
      }
    } else {
      const match = matchShelfBook(candidate, books);
      if (match.kind === "conflict") { conflicts += 1; continue; }
      selectedBook = match.kind === "match" ? match.book : undefined;
      bookReused = match.kind === "match";
    }

    const prepared = await prepareBookAndFiles(root, plannedCandidate, selectedBook, format);
    if (prepared === null) {
      if (recoveringThisRecord) {
        throw new ShelfWriteCoordinationError("shelf-write-recovery-state-unavailable", "The staged Reviewer source assets cannot be reconstructed safely.", requestId);
      }
      conflicts += 1;
      continue;
    }
    const output = await materializeReviewerReconciliationCandidate(
      plannedCandidate,
      prepared.book,
      prepared.files,
      journal === undefined ? undefined : () => journal.annotationId
    );
    if (output.kind === "pending") {
      if (recoveringThisRecord) {
        throw new ShelfWriteCoordinationError("shelf-write-recovery-state-unavailable", "The staged Reviewer Annotation cannot be reconstructed safely.", requestId);
      }
      pending.push(output);
      continue;
    }
    const plan: ShelfRecordWritePlan = Object.freeze({
      book: prepared.book,
      annotation: output.annotation,
      bookReused,
      assets: prepared.assets,
      reviewerEnrichment
    });
    const receipt = await commitShelfRecordTransaction({
      requestId,
      shelfRoot: root,
      expectedShelfId: nativeContext.coordination.expectedShelfId,
      coordinationRoot: nativeContext.coordination.coordinationRoot,
      processLabel: "desktop-main-reviewer",
      externalLock: nativeContext.section.lease,
      prepare: async (existing) => {
        if ((existing?.updatedAt ?? undefined) !== (journal?.updatedAt ?? undefined)
          || (existing?.requestDigest ?? undefined) !== (journal?.requestDigest ?? undefined)) {
          throw new ShelfWriteCoordinationError("shelf-write-request-mismatch", "The Reviewer journal changed while the native Shelf lock was held.", requestId);
        }
        return plan;
      },
      beforeMutation: async (id) => {
        recoveryFile = await writeShelfWriterRecoveryState({
          coordinationDirectory: nativeContext.section.layout.coordinationDirectory,
          requestId: id
        });
      },
      afterReceipt: async () => {
        if (recoveringThisRecord) interrupted.delete(requestId);
      }
    });
    if (!bookReused && !books.some((book) => book.id === prepared.book.id)) books.push(prepared.book);
    const entries = aliases.get(candidate.reviewerAnnotationId) ?? [];
    entries.push({ digest: candidate.digest, version: REVIEWER_SHELF_PROVENANCE_VERSION });
    aliases.set(candidate.reviewerAnnotationId, entries);
    if (prior !== undefined || receipt.state === "already-committed") unchanged += 1;
    else materialized += 1;
  }
  if (interrupted.size > 0) {
    throw new ShelfWriteCoordinationError(
      "shelf-write-recovery-state-unavailable",
      "One or more interrupted Reviewer writes were not resumed.",
      [...interrupted].join(",")
    );
  }
  if (recoveryFile !== undefined && interrupted.size === 0) {
    await clearShelfWriterRecoveryState(recoveryFile);
  }
  return Object.freeze({ materialized, unchanged, pending: Object.freeze(pending), conflicts });
}

// The Desktop single-instance main process serializes Shelf writes so a manual
// retry and an approval-triggered retry cannot create duplicate aliases.
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Main-process-only coordination resolved from the saved Shelf binding. Product
 * Reviewer synchronization supplies it; if native mutex loading fails, the write
 * fails instead of falling back to a JavaScript file lease.
 */
export interface ReviewerShelfWriteCoordination {
  readonly coordinationRoot: string;
  /** Stable Shelf UUID from the folder marker (D068). */
  readonly expectedShelfId: string;
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
    const recoverableRequestIds = records
      .filter((record) => typeof record.annotationId === "string")
      .map((record) => reviewerRequestId(record.annotationId));
    return withNativeShelfWriteSection(
      {
        shelfRoot,
        expectedShelfId: coordination.expectedShelfId,
        coordinationRoot: coordination.coordinationRoot
      },
      recoverableRequestIds,
      {
        ...(coordination.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: coordination.acquireTimeoutMs })
      },
      (section) => materializeUnlocked(shelfRoot, records, lookupMetadata, { coordination, section })
    );
  });
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}
