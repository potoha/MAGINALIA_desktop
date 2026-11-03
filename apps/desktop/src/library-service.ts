import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";

import type {
  Annotation,
  Book,
  Library,
  ShelfAnnotation,
  ShelfBook,
  ShelfAnnotationV04,
  ShelfBookV04
} from "@maginalia/format" with { "resolution-mode": "import" };
import { FolderMarkerError, resolveFolderMarker } from "./folder-identity.js";

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });

let formatCorePromise: Promise<FormatCore> | undefined;

async function loadFormatCore(): Promise<FormatCore> {
  // The desktop main bundle remains CommonJS for Electron's existing entry
  // point; load the ESM format package at the adapter boundary.
  formatCorePromise ??= import("@maginalia/format");
  return formatCorePromise;
}

export interface LibrarySummary {
  readonly libraryId: string;
  readonly displayName: string;
}

export interface LibraryOpened {
  readonly kind: "opened";
  readonly library: LibrarySummary;
  readonly recordCount: number;
  readonly issueCount: number;
  readonly folderIdentityId?: string;
  /** Shelf records remain available while this explicit recovery state is surfaced. */
  readonly folderIdentityRecovery?: { readonly code: string; readonly message: string };
}

export type LibraryFailureCode =
  | "invalid-owner"
  | "invalid-root"
  | "root-missing"
  | "root-not-directory"
  | "root-unreadable"
  | "invalid-library"
  | "invalid-library-config"
  | "ambiguous-library"
  | "invalid-library-id"
  | "library-not-owned"
  | "invalid-query"
  | "invalid-annotation-id"
  | "annotation-not-found";

export interface LibraryFailure {
  readonly kind: "error";
  readonly code: LibraryFailureCode;
  readonly message: string;
}

export type LibraryOpenResult = LibraryOpened | LibraryFailure;

/**
 * This is deliberately a main-process-only representation. It is a small
 * projection of an Annotation joined to its Book; it never contains an
 * entity, filename, or capture evidence.
 */
export interface LibraryRecord {
  readonly annotationId: string;
  readonly sourceId: string;
  readonly quote: string;
  readonly privateMemo?: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
  readonly url?: string;
}

export interface LibraryRecordsRead {
  readonly kind: "records";
  readonly records: readonly LibraryRecord[];
}

export type LibraryRecordsResult = LibraryRecordsRead | LibraryFailure;

/** Main-process search projection. It deliberately contains no quotation text or memo. */
export interface LibrarySearchReference {
  readonly annotationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
  readonly url?: string;
}

export interface LibrarySearchRead {
  readonly kind: "results";
  readonly libraryId: string;
  readonly results: readonly LibrarySearchReference[];
}

export type LibrarySearchResult = LibrarySearchRead | LibraryFailure;

/** Main-process resolution result for the explicit writing insertion boundary. */
export interface LibraryQuotationResolved {
  readonly kind: "resolved";
  readonly libraryId: string;
  readonly annotationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
  readonly quote: string;
}

export type LibraryQuotationResult = LibraryQuotationResolved | LibraryFailure;

const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_CANDIDATE_FILES = 4_096;
const MAX_ENTITY_BYTES = 1_048_576;
export const MAX_LIBRARY_SEARCH_QUERY_CHARS = 2_000;
export const MAX_LIBRARY_SEARCH_RESULTS = 100;
const ENTITY_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "bundle",
  "out",
  "coverage",
  "target",
  "vendor",
]);
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANNOTATION_ID = /^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REVIEWER_ANNOTATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVALID_OWNER: LibraryFailure = {
  kind: "error",
  code: "invalid-owner",
  message: "The Library owner is invalid.",
};

const INVALID_ROOT: LibraryFailure = {
  kind: "error",
  code: "invalid-root",
  message: "Choose an absolute Library folder.",
};

const ROOT_MISSING: LibraryFailure = {
  kind: "error",
  code: "root-missing",
  message: "The Library folder is no longer available. Choose it again.",
};

const ROOT_NOT_DIRECTORY: LibraryFailure = {
  kind: "error",
  code: "root-not-directory",
  message: "The selected Library root is not a directory.",
};

const ROOT_UNREADABLE: LibraryFailure = {
  kind: "error",
  code: "root-unreadable",
  message: "The Library folder could not be read. Check its permissions and try again.",
};

const INVALID_LIBRARY: LibraryFailure = {
  kind: "error",
  code: "invalid-library",
  message: "The Library configuration is invalid; no records were loaded.",
};

const INVALID_LIBRARY_CONFIG: LibraryFailure = {
  kind: "error",
  code: "invalid-library-config",
  message: "The Library configured path is unavailable or escapes its selected root.",
};

const AMBIGUOUS_LIBRARY: LibraryFailure = {
  kind: "error",
  code: "ambiguous-library",
  message: "More than one Library configuration was found; no records were loaded.",
};

const LIBRARY_NOT_OWNED: LibraryFailure = {
  kind: "error",
  code: "library-not-owned",
  message: "That Library snapshot is not open for this owner.",
};

const INVALID_QUERY: LibraryFailure = {
  kind: "error",
  code: "invalid-query",
  message: "The Library search query is invalid or too long.",
};

const INVALID_ANNOTATION_ID: LibraryFailure = {
  kind: "error",
  code: "invalid-annotation-id",
  message: "The Annotation ID is invalid.",
};

const ANNOTATION_NOT_FOUND: LibraryFailure = {
  kind: "error",
  code: "annotation-not-found",
  message: "That quotation is not in the current Library snapshot.",
};

interface CandidateFile {
  readonly path: string;
  readonly realPath: string;
  readonly relativePath: string;
}

type ParsedEntity =
  | { readonly kind: "library"; readonly value: Library; readonly candidate: CandidateFile }
  | { readonly kind: "book"; readonly value: ShelfBook; readonly candidate: CandidateFile }
  | { readonly kind: "annotation"; readonly value: ShelfAnnotation; readonly candidate: CandidateFile }
  | { readonly kind: "invalid-library"; readonly candidate: CandidateFile };

interface IssueCounter {
  value: number;
}

interface ScanResult {
  readonly candidates: readonly CandidateFile[];
  readonly issueCount: number;
}

interface LibraryScope {
  readonly path: string;
  readonly realPath: string;
  readonly isFile: boolean;
}

interface ScopeResolution {
  readonly scope?: LibraryScope;
  readonly failure?: LibraryFailure;
}

interface LibrarySnapshot {
  readonly owner: object;
  readonly library: LibrarySummary;
  readonly records: readonly LibraryRecord[];
}

interface PrivateShelfLibrarySnapshot extends LibrarySnapshot {
  readonly privateShelf: true;
  readonly canonicalRoot: string;
  readonly entities: CanonicalShelfEntities;
  readonly folderIdentityId?: string;
  readonly folderIdentityRecovery?: { readonly code: string; readonly message: string };
}

type OwnedLibrarySnapshot = LibrarySnapshot | PrivateShelfLibrarySnapshot;

/** Format entities retained only for main-process QuoteRef resolution. */
export interface CanonicalShelfEntities {
  readonly annotations: readonly ShelfAnnotation[];
  readonly books: readonly ShelfBook[];
}

/** Main-process-only view of the currently selected Private Shelf. */
export interface ActivePrivateShelf {
  readonly kind: "private-shelf";
  readonly privateShelf: true;
  readonly library: LibrarySummary;
  readonly canonicalRoot: string;
  readonly records: readonly LibraryRecord[];
  readonly entities: CanonicalShelfEntities;
  readonly folderIdentityId?: string;
  readonly folderIdentityRecovery?: { readonly code: string; readonly message: string };
}

export type ActivePrivateShelfResult = ActivePrivateShelf | LibraryFailure;

function isOwner(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function rootFailure(error: unknown): LibraryFailure {
  switch (errorCode(error)) {
    case "ENOENT":
    case "ENAMETOOLONG":
      return ROOT_MISSING;
    case "ENOTDIR":
      return ROOT_NOT_DIRECTORY;
    default:
      return ROOT_UNREADABLE;
  }
}

function pathForComparison(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(pathForComparison(root), pathForComparison(candidate));
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function isIgnoredDirectory(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(name.toLocaleLowerCase());
}

function isEntityFile(filePath: string): boolean {
  return ENTITY_EXTENSIONS.has(path.extname(filePath).toLocaleLowerCase());
}

function compareNames(left: string, right: string): number {
  const leftLower = left.toLocaleLowerCase();
  const rightLower = right.toLocaleLowerCase();
  if (leftLower < rightLower) return -1;
  if (leftLower > rightLower) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function relativeLabel(root: string, candidate: string): string {
  return path.relative(root, candidate) || ".";
}

function entityKindHint(text: string): "library" | "book" | "annotation" | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const type = (parsed as { type?: unknown }).type;
      if (type === "library" || type === "book" || type === "annotation") return type;
    }
  } catch {
    // YAML is parsed by @maginalia/format below. This fallback only identifies
    // an invalid candidate that should count as an issue.
  }

  const match = text.match(/^\s*type\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
  const type = match?.[1] ?? match?.[2] ?? match?.[3];
  return type === "library" || type === "book" || type === "annotation" ? type : undefined;
}

async function scanFiles(root: string): Promise<ScanResult> {
  const candidates: CandidateFile[] = [];
  const visitedDirectories = new Set<string>();
  const issues: IssueCounter = { value: 0 };
  let visitedEntries = 0;
  let stopped = false;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (stopped) return;
    if (depth > MAX_SCAN_DEPTH) {
      issues.value += 1;
      return;
    }

    let directoryRealPath: string;
    try {
      directoryRealPath = await realpath(directory);
    } catch {
      issues.value += 1;
      return;
    }
    if (!isWithin(root, directoryRealPath)) {
      issues.value += 1;
      return;
    }

    const directoryKey = pathForComparison(directoryRealPath);
    if (visitedDirectories.has(directoryKey)) return;
    visitedDirectories.add(directoryKey);

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      issues.value += 1;
      return;
    }
    entries.sort((left, right) => compareNames(left.name, right.name));

    for (const entry of entries) {
      if (stopped) return;
      visitedEntries += 1;
      if (visitedEntries > MAX_SCAN_ENTRIES) {
        issues.value += 1;
        stopped = true;
        return;
      }

      // Hidden files are not candidate entities, matching hidden directory
      // handling and avoiding accidental metadata ingestion.
      if (entry.name.startsWith(".")) continue;

      const entryPath = path.join(directory, entry.name);
      let entryStat: Awaited<ReturnType<typeof lstat>>;
      try {
        entryStat = await lstat(entryPath);
      } catch {
        issues.value += 1;
        continue;
      }

      let entryRealPath: string;
      try {
        entryRealPath = await realpath(entryPath);
      } catch {
        issues.value += 1;
        continue;
      }
      if (!isWithin(root, entryRealPath)) {
        // A symlink may not make the selected root escape its canonical
        // boundary. Count it without revealing its name to callers.
        issues.value += 1;
        continue;
      }

      if (entryStat.isDirectory()) {
        if (!isIgnoredDirectory(entry.name)) await visit(entryPath, depth + 1);
        continue;
      }

      if (entryStat.isSymbolicLink()) {
        let targetStat: Awaited<ReturnType<typeof lstat>>;
        try {
          targetStat = await lstat(entryRealPath);
        } catch {
          issues.value += 1;
          continue;
        }
        if (targetStat.isDirectory()) {
          if (!isIgnoredDirectory(entry.name)) await visit(entryPath, depth + 1);
          continue;
        }
        if (!targetStat.isFile() || !isEntityFile(entryPath)) continue;
      } else if (!entryStat.isFile() || !isEntityFile(entryPath)) {
        continue;
      }

      if (candidates.length >= MAX_CANDIDATE_FILES) {
        issues.value += 1;
        stopped = true;
        return;
      }
      candidates.push({
        path: entryPath,
        realPath: entryRealPath,
        relativePath: relativeLabel(root, entryPath),
      });
    }
  };

  await visit(root, 0);
  candidates.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  return { candidates, issueCount: issues.value };
}

async function parseCandidate(candidate: CandidateFile, issues: IssueCounter): Promise<ParsedEntity | undefined> {
  let text: string;
  try {
    const file = await lstat(candidate.realPath);
    if (file.size > MAX_ENTITY_BYTES) {
      issues.value += 1;
      return undefined;
    }
    text = await readFile(candidate.realPath, "utf8");
  } catch {
    issues.value += 1;
    return undefined;
  }

  const hint = entityKindHint(text);
  try {
    const format = await loadFormatCore();
    const library = format.parseAndValidate("library", text);
    if (library.valid) return { kind: "library", value: library.value, candidate };
    const book = format.parseShelfEntity("book", text);
    if (book.valid) return { kind: "book", value: book.value, candidate };
    const annotation = format.parseShelfEntity("annotation", text);
    if (annotation.valid) return { kind: "annotation", value: annotation.value, candidate };
    if (hint === "library") return { kind: "invalid-library", candidate };
    if (hint !== undefined) issues.value += 1;
  } catch {
    if (hint === "library") return { kind: "invalid-library", candidate };
    if (hint !== undefined) issues.value += 1;
  }
  return undefined;
}

function isUnsafeConfiguredPath(value: string): boolean {
  return value.length === 0
    || value.includes("\0")
    || path.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || /^(?:[\\/]{1,2})/.test(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value);
}

async function resolveConfiguredScope(root: string, value: string | undefined): Promise<ScopeResolution> {
  if (value === undefined) return { scope: undefined };
  if (isUnsafeConfiguredPath(value)) return { failure: INVALID_LIBRARY_CONFIG };

  const scopePath = path.resolve(root, value);
  if (!isWithin(root, scopePath)) return { failure: INVALID_LIBRARY_CONFIG };

  let scopeStat: Awaited<ReturnType<typeof lstat>>;
  let scopeRealPath: string;
  try {
    scopeStat = await lstat(scopePath);
    scopeRealPath = await realpath(scopePath);
  } catch {
    return { failure: INVALID_LIBRARY_CONFIG };
  }
  if (!isWithin(root, scopeRealPath)) return { failure: INVALID_LIBRARY_CONFIG };

  let targetStat = scopeStat;
  if (scopeStat.isSymbolicLink()) {
    try {
      targetStat = await lstat(scopeRealPath);
    } catch {
      return { failure: INVALID_LIBRARY_CONFIG };
    }
  }
  if (!targetStat.isDirectory() && !targetStat.isFile()) return { failure: INVALID_LIBRARY_CONFIG };
  return { scope: { path: scopePath, realPath: scopeRealPath, isFile: targetStat.isFile() } };
}

function isInScope(candidate: CandidateFile, scope: LibraryScope | undefined): boolean {
  if (scope === undefined) return true;
  if (scope.isFile) {
    return pathForComparison(candidate.path) === pathForComparison(scope.path)
      || pathForComparison(candidate.realPath) === pathForComparison(scope.realPath);
  }
  return isWithin(scope.path, candidate.path) || isWithin(scope.realPath, candidate.realPath);
}

function removeDuplicateIds<T extends { value: { id: string } }>(
  entities: readonly T[],
  issues: IssueCounter,
): T[] {
  const byId = new Map<string, T[]>();
  for (const entity of entities) {
    const values = byId.get(entity.value.id) ?? [];
    values.push(entity);
    byId.set(entity.value.id, values);
  }

  const duplicateIds = new Set<string>();
  for (const [id, values] of byId) {
    if (values.length < 2) continue;
    duplicateIds.add(id);
    // Every ambiguous record is excluded; no first/last record wins.
    issues.value += values.length;
  }
  return entities.filter((entity) => !duplicateIds.has(entity.value.id));
}

function annotationSourceId(annotation: ShelfAnnotation): string {
  return annotation.version === "0.4" ? annotation.source.id : annotation.source;
}

function titleForBook(book: ShelfBook): string {
  if (book.version === "0.1") return book.title;
  return book.title ?? book.isbn13 ?? book.url ?? book.id;
}

function authorsForBook(book: ShelfBook): readonly string[] {
  return book.authors ?? [];
}

function sourceUrlForAnnotation(annotation: ShelfAnnotation, book: ShelfBook): string | undefined {
  const annotationUrl = annotation.version === "0.4" ? annotation.url : undefined;
  const bookUrl = book.version === "0.4" ? book.url : undefined;
  return annotationUrl ?? bookUrl;
}

function toSnapshotRecord(annotation: ShelfAnnotation, book: ShelfBook): LibraryRecord {
  const record: {
    annotationId: string;
    sourceId: string;
    quote: string;
    privateMemo?: string;
    title: string;
    authors: readonly string[];
    page?: number;
    url?: string;
  } = {
    annotationId: annotation.id,
    sourceId: annotationSourceId(annotation),
    quote: annotation.quote,
    title: titleForBook(book),
    authors: Object.freeze([...authorsForBook(book)]),
  };
  if (annotation.privateMemo !== undefined) record.privateMemo = annotation.privateMemo;
  const location = annotation.location;
  if (location?.page !== undefined) record.page = location.page;
  const url = sourceUrlForAnnotation(annotation, book);
  if (url !== undefined) record.url = url;
  return Object.freeze(record);
}

function reviewerAnnotationAlias(annotation: ShelfAnnotation): string | undefined {
  const deviceMetadata = annotation.deviceMetadata;
  if (deviceMetadata === undefined) return undefined;
  const reviewer = deviceMetadata.maginaliaReviewer;
  if (reviewer === null || typeof reviewer !== "object" || Array.isArray(reviewer)) return undefined;
  const alias = (reviewer as { annotationId?: unknown }).annotationId;
  return typeof alias === "string" && REVIEWER_ANNOTATION_UUID.test(alias) ? alias : undefined;
}

function toCanonicalShelfAnnotation(annotation: ShelfAnnotation): ShelfAnnotation {
  if (annotation.version === "0.4") {
    return Object.freeze({
      ...annotation,
      source: Object.freeze({
        ...annotation.source,
        ...(annotation.source.files === undefined ? {} : { files: Object.freeze(annotation.source.files.map((file) => Object.freeze({ ...file }))) })
      }),
      get: Object.freeze({ ...annotation.get }),
      ...(annotation.location === undefined ? {} : { location: Object.freeze({ ...annotation.location }) }),
      ...(annotation.deviceMetadata === undefined ? {} : { deviceMetadata: Object.freeze({ ...annotation.deviceMetadata }) })
    });
  }
  // The canonical snapshot is an in-memory projection, not a normalization
  // pass. Preserve either legal Format v0.1 location representation exactly;
  // in particular, an existing stable path must not be converted to `{}`.
  const location: Annotation["location"] = Object.freeze({
    ...(annotation.location.page === undefined ? {} : { page: annotation.location.page }),
    ...(annotation.location.path === undefined ? {} : { path: annotation.location.path }),
  });
  const canonical: Annotation = {
    type: "annotation",
    version: "0.1",
    id: annotation.id,
    source: annotation.source,
    location,
    quote: annotation.quote,
  };
  const reviewerAlias = reviewerAnnotationAlias(annotation);
  if (reviewerAlias !== undefined) {
    canonical.deviceMetadata = Object.freeze({
      maginaliaReviewer: Object.freeze({ annotationId: reviewerAlias }),
    });
  }
  return Object.freeze(canonical);
}

function toCanonicalShelfBook(book: ShelfBook): ShelfBook {
  if (book.version === "0.4") {
    return Object.freeze({
      ...book,
      source: Object.freeze({
        ...book.source,
        ...(book.source.files === undefined ? {} : { files: Object.freeze(book.source.files.map((file) => Object.freeze({ ...file }))) })
      }),
      get: Object.freeze({ ...book.get }),
      ...(book.authors === undefined ? {} : { authors: Object.freeze([...book.authors]) })
    });
  }
  const canonical: Book = {
    type: "book",
    version: "0.1",
    id: book.id,
    title: book.title,
    authors: Object.freeze([...book.authors]) as unknown as string[],
    isbn13: book.isbn13,
  };
  if (book.publisher !== undefined) canonical.publisher = book.publisher;
  if (book.year !== undefined) canonical.year = book.year;
  return Object.freeze(canonical);
}

function toCanonicalShelfEntities(
  annotations: readonly ShelfAnnotation[],
  books: readonly ShelfBook[],
): CanonicalShelfEntities {
  return Object.freeze({
    annotations: Object.freeze(annotations.map(toCanonicalShelfAnnotation)),
    books: Object.freeze(books.map(toCanonicalShelfBook)),
  });
}

function isPrivateShelfSnapshot(snapshot: OwnedLibrarySnapshot): snapshot is PrivateShelfLibrarySnapshot {
  return "privateShelf" in snapshot && snapshot.privateShelf === true;
}

function cloneRecords(records: readonly LibraryRecord[]): readonly LibraryRecord[] {
  return Object.freeze(records.map((record) => {
    const copy: {
      annotationId: string;
      sourceId: string;
      quote: string;
      privateMemo?: string;
      title: string;
      authors: readonly string[];
      page?: number;
      url?: string;
    } = {
      annotationId: record.annotationId,
      sourceId: record.sourceId,
      quote: record.quote,
      title: record.title,
      authors: Object.freeze([...record.authors]),
    };
    if (record.privateMemo !== undefined) copy.privateMemo = record.privateMemo;
    if (record.page !== undefined) copy.page = record.page;
    if (record.url !== undefined) copy.url = record.url;
    return Object.freeze(copy);
  }));
}

function searchableText(value: string | number | undefined): string {
  if (value === undefined) return "";
  return String(value).normalize("NFKC").toLocaleLowerCase();
}

function toSearchReference(record: LibraryRecord): LibrarySearchReference {
  const reference: {
    annotationId: string;
    sourceId: string;
    title: string;
    authors: readonly string[];
    page?: number;
    url?: string;
  } = {
    annotationId: record.annotationId,
    sourceId: record.sourceId,
    title: record.title,
    authors: Object.freeze([...record.authors]),
  };
  if (record.page !== undefined) reference.page = record.page;
  if (record.url !== undefined) reference.url = record.url;
  return Object.freeze(reference);
}

function toResolvedQuotation(record: LibraryRecord, libraryId: string): LibraryQuotationResolved {
  const quotation: {
    kind: "resolved";
    libraryId: string;
    annotationId: string;
    sourceId: string;
    title: string;
    authors: readonly string[];
    page?: number;
    quote: string;
  } = {
    kind: "resolved",
    libraryId,
    annotationId: record.annotationId,
    sourceId: record.sourceId,
    title: record.title,
    authors: Object.freeze([...record.authors]),
    quote: record.quote,
  };
  if (record.page !== undefined) quotation.page = record.page;
  return Object.freeze(quotation);
}

function findRecord(records: readonly LibraryRecord[], annotationId: string): LibraryRecord | undefined {
  return records.find((record) => record.annotationId === annotationId);
}

function isLibraryFailure(value: LibrarySnapshot | LibraryFailure): value is LibraryFailure {
  return "kind" in value && value.kind === "error";
}

/**
 * Main-process-only adapter for a selected Library root. It loads one
 * immutable snapshot per owner and exposes no filesystem path or raw entity.
 */
export class LibraryService {
  private readonly snapshots = new Map<string, OwnedLibrarySnapshot>();
  private readonly owners = new Map<object, OwnedLibrarySnapshot>();

  public async openForOwner(owner: unknown, rootPath: unknown): Promise<LibraryOpenResult> {
    return this.openRootForOwner(owner, rootPath, false);
  }

  /** Open a selected Private Shelf and retain its canonical root for main-process use. */
  public async openPrivateShelfForOwner(owner: unknown, rootPath: unknown): Promise<LibraryOpenResult> {
    return this.openRootForOwner(owner, rootPath, true);
  }

  /** Open a registry-configured Private Shelf only when it has a Library contract. */
  public async openConfiguredPrivateShelfForOwner(owner: unknown, rootPath: unknown): Promise<LibraryOpenResult> {
    return this.openRootForOwner(owner, rootPath, true, undefined, true);
  }

  /** Reload the currently selected Private Shelf while keeping its Library ID stable. */
  public async reloadForOwner(owner: unknown): Promise<LibraryOpenResult> {
    if (!isOwner(owner)) return INVALID_OWNER;
    const previous = this.owners.get(owner);
    if (!previous || !isPrivateShelfSnapshot(previous)) return LIBRARY_NOT_OWNED;
    return this.openRootForOwner(owner, previous.canonicalRoot, true, previous);
  }

  private async openRootForOwner(
    owner: unknown,
    rootPath: unknown,
    privateShelf: boolean,
    expectedSnapshot?: PrivateShelfLibrarySnapshot,
    requireLibraryConfig = false,
  ): Promise<LibraryOpenResult> {
    if (!isOwner(owner)) return INVALID_OWNER;
    if (typeof rootPath !== "string" || rootPath.length === 0 || !path.isAbsolute(rootPath)) {
      return INVALID_ROOT;
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootPath);
    } catch (error: unknown) {
      return rootFailure(error);
    }

    let rootStats: Awaited<ReturnType<typeof lstat>>;
    try {
      rootStats = await lstat(canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }
    if (!rootStats.isDirectory()) return ROOT_NOT_DIRECTORY;

    // Distinguish an unavailable selected root from an otherwise valid root
    // whose individual candidates merely have issues.
    try {
      await readdir(canonicalRoot, { withFileTypes: true });
    } catch {
      return ROOT_UNREADABLE;
    }

    const scan = await scanFiles(canonicalRoot);
    const issues: IssueCounter = { value: scan.issueCount };
    const parsed: ParsedEntity[] = [];
    for (const candidate of scan.candidates) {
      const entity = await parseCandidate(candidate, issues);
      if (entity) parsed.push(entity);
    }

    if (parsed.some((entity) => entity.kind === "invalid-library")) return INVALID_LIBRARY;
    const libraries = parsed.filter((entity): entity is Extract<ParsedEntity, { kind: "library" }> => entity.kind === "library");
    if (libraries.length > 1) return AMBIGUOUS_LIBRARY;
    if (requireLibraryConfig && libraries.length === 0) return INVALID_LIBRARY_CONFIG;

    const library = libraries[0]?.value;
    const booksScope = await resolveConfiguredScope(canonicalRoot, library?.booksPath);
    if (booksScope.failure) return booksScope.failure;
    const annotationsScope = await resolveConfiguredScope(canonicalRoot, library?.annotationsPath);
    if (annotationsScope.failure) return annotationsScope.failure;

    const books = removeDuplicateIds(
      parsed.filter((entity): entity is Extract<ParsedEntity, { kind: "book" }> =>
        entity.kind === "book" && isInScope(entity.candidate, booksScope.scope)),
      issues,
    );
    const annotations = removeDuplicateIds(
      parsed.filter((entity): entity is Extract<ParsedEntity, { kind: "annotation" }> =>
        entity.kind === "annotation" && isInScope(entity.candidate, annotationsScope.scope)),
      issues,
    );
    const booksById = new Map<string, ShelfBook>(books.map((book) => [book.value.id, book.value] as const));
    const records: LibraryRecord[] = [];
    for (const annotation of annotations) {
      const book = booksById.get(annotationSourceId(annotation.value));
      if (!book) {
        issues.value += 1;
        continue;
      }
      records.push(toSnapshotRecord(annotation.value, book));
    }

    let folderIdentityId: string | undefined;
    let folderIdentityRecovery: { readonly code: string; readonly message: string } | undefined;
    if (privateShelf) {
      try {
        const resolved = await resolveFolderMarker(canonicalRoot, "shelf");
        folderIdentityId = resolved.marker.id;
      } catch (error: unknown) {
        if (error instanceof FolderMarkerError) {
          folderIdentityRecovery = Object.freeze({ code: error.code, message: error.message });
        } else {
          folderIdentityRecovery = Object.freeze({ code: "marker-unavailable", message: "Shelf records opened, but its folder identity could not be read." });
        }
      }
    }

    if (expectedSnapshot !== undefined && this.owners.get(owner) !== expectedSnapshot) return LIBRARY_NOT_OWNED;

    const libraryId = expectedSnapshot?.library.libraryId ?? randomUUID();
    const librarySummary: LibrarySummary = Object.freeze({
      libraryId,
      displayName: library?.name ?? (path.basename(canonicalRoot) || "Library"),
    });
    let snapshot: OwnedLibrarySnapshot;
    if (privateShelf) {
      const entities = toCanonicalShelfEntities(
        annotations.map(({ value }) => value),
        books.map(({ value }) => value),
      );
      snapshot = Object.freeze({
        owner,
        library: librarySummary,
        records: Object.freeze(records),
        privateShelf: true,
        canonicalRoot,
        entities,
        ...(folderIdentityId ? { folderIdentityId } : {}),
        ...(folderIdentityRecovery ? { folderIdentityRecovery } : {}),
      });
    } else {
      snapshot = Object.freeze({
        owner,
        library: librarySummary,
        records: Object.freeze(records),
      });
    }
    const previous = this.owners.get(owner);
    if (previous) this.snapshots.delete(previous.library.libraryId);
    this.owners.set(owner, snapshot);
    this.snapshots.set(libraryId, snapshot);

    return {
      kind: "opened",
      library: snapshot.library,
      recordCount: records.length,
      issueCount: issues.value,
      ...(privateShelf && folderIdentityId ? { folderIdentityId } : {}),
      ...(privateShelf && folderIdentityRecovery ? { folderIdentityRecovery } : {}),
    };
  }

  /** Return a frozen main-process view of the current selected Private Shelf. */
  public getActivePrivateShelfForOwner(owner: unknown): ActivePrivateShelfResult {
    if (!isOwner(owner)) return INVALID_OWNER;
    const snapshot = this.owners.get(owner);
    if (!snapshot || !isPrivateShelfSnapshot(snapshot)) return LIBRARY_NOT_OWNED;
    return Object.freeze({
      kind: "private-shelf",
      privateShelf: true,
      library: snapshot.library,
      canonicalRoot: snapshot.canonicalRoot,
      records: cloneRecords(snapshot.records),
      entities: toCanonicalShelfEntities(snapshot.entities.annotations, snapshot.entities.books),
      ...(snapshot.folderIdentityId ? { folderIdentityId: snapshot.folderIdentityId } : {}),
      ...(snapshot.folderIdentityRecovery ? { folderIdentityRecovery: snapshot.folderIdentityRecovery } : {}),
    });
  }

  /**
   * Read a retained snapshot for main-process search/resolve consumers. Every
   * call returns a frozen copy so callers cannot mutate service state.
   */
  public getRecordsForOwner(owner: unknown, libraryId: unknown): LibraryRecordsResult {
    const snapshot = this.findSnapshot(owner, libraryId);
    if (isLibraryFailure(snapshot)) return snapshot;
    return { kind: "records", records: cloneRecords(snapshot.records) };
  }

  /**
   * Search only the retained projection. The private memo participates in
   * matching but is never copied into a search reference.
   */
  public searchForOwner(owner: unknown, libraryId: unknown, query: unknown): LibrarySearchResult {
    const snapshot = this.findSnapshot(owner, libraryId);
    if (isLibraryFailure(snapshot)) return snapshot;
    if (typeof query !== "string" || query.length > MAX_LIBRARY_SEARCH_QUERY_CHARS) return INVALID_QUERY;

    const needle = searchableText(query);
    const matches = snapshot.records.flatMap((record, index) => {
      const quoteMatch = needle.length > 0 && searchableText(record.quote).includes(needle);
      const searchableFields: Array<string | number | undefined> = [
        record.quote,
        record.title,
        ...record.authors,
        record.annotationId,
        record.sourceId,
        record.page,
        record.privateMemo,
        record.url,
      ];
      if (needle.length > 0 && !searchableFields.some((field) => searchableText(field).includes(needle))) return [];
      return [{ record, quoteMatch, index }];
    });
    matches.sort((left, right) => Number(right.quoteMatch) - Number(left.quoteMatch) || left.index - right.index);

    const resultReferences = Object.freeze(
      matches.slice(0, MAX_LIBRARY_SEARCH_RESULTS).map(({ record }) => toSearchReference(record)),
    );
    return Object.freeze({
      kind: "results",
      libraryId: snapshot.library.libraryId,
      results: resultReferences,
    });
  }

  /** Resolve a snapshot member for the explicit writing insertion operation. */
  public resolveQuotationForInsertForOwner(
    owner: unknown,
    libraryId: unknown,
    annotationId: unknown,
  ): LibraryQuotationResult {
    const snapshot = this.findSnapshot(owner, libraryId);
    if (isLibraryFailure(snapshot)) return snapshot;
    if (typeof annotationId !== "string" || !ANNOTATION_ID.test(annotationId)) return INVALID_ANNOTATION_ID;

    const record = findRecord(snapshot.records, annotationId);
    if (!record) return ANNOTATION_NOT_FOUND;
    return toResolvedQuotation(record, snapshot.library.libraryId);
  }

  private findSnapshot(owner: unknown, libraryId: unknown): OwnedLibrarySnapshot | LibraryFailure {
    if (!isOwner(owner)) return INVALID_OWNER;
    if (!isOpaqueId(libraryId)) return {
      kind: "error",
      code: "invalid-library-id",
      message: "The Library ID is invalid.",
    };

    const snapshot = this.snapshots.get(libraryId);
    if (!snapshot || snapshot.owner !== owner || this.owners.get(owner) !== snapshot) return LIBRARY_NOT_OWNED;
    return snapshot;
  }

  public dispose(): void {
    this.snapshots.clear();
    this.owners.clear();
  }
}
