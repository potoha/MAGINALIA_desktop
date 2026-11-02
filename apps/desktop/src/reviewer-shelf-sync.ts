/**
 * Explicit main-process synchronization from approved Reviewer records into a
 * selected Private Shelf. Creating this adapter performs no network requests;
 * callers opt in by invoking it from a dedicated sync action.
 */
import { lookupOpenBdMetadata } from "./openbd-metadata";
import {
  materializeReviewerRecords,
  type MaterializationResult,
  type ReviewerShelfMetadataLookup
} from "./reviewer-shelf-materializer";
import {
  parseReviewerBaseUrl,
  type ReviewerQuotation
} from "./reviewer-ipc";
import type {
  ApprovedReviewerRecord,
  ReviewerSourceFile,
  ReviewerReconciliationPending
} from "./reviewer-shelf-reconciliation";
import type { ReviewerShelfWriteCoordination } from "./reviewer-shelf-write-binding";

export const REVIEWER_SHELF_SYNC_PAGE_LIMIT = 100;
export const MAX_REVIEWER_SHELF_SYNC_PAGES = 1_001;

export type ReviewerShelfSyncFailureCode =
  | "reviewer-unavailable"
  | "reviewer-error"
  | "reviewer-invalid-response"
  | "pagination-inconsistent";

export interface ReviewerShelfSyncResult {
  readonly kind: "completed" | "error";
  readonly materialized: number;
  readonly unchanged: number;
  /** Number of records left pending by the existing reconciliation core. */
  readonly pending: number;
  readonly pendingRecords: readonly ReviewerReconciliationPending[];
  readonly conflicts: number;
  /** Per-record openBD lookup failures, or one for a sync-wide Reviewer error. */
  readonly failed: number;
  readonly error?: {
    readonly code: ReviewerShelfSyncFailureCode;
    readonly message: string;
  };
}

export interface ReviewerShelfSyncAdapterOptions {
  /** Main-process configuration only; never supplied by renderer input. */
  readonly baseUrl?: string;
  readonly getBaseUrl?: () => string | URL | null | Promise<string | URL | null>;
  readonly reviewerFetcher?: typeof fetch;
  /** Main-process-only token for the owned Reviewer source-asset endpoint. */
  readonly getDesktopRequestToken?: () => string | null;
  /** Test seam; production uses the main-process Reviewer fetch adapter. */
  readonly sourceAssetFetcher?: typeof fetch;
  readonly maxSourceAssetBytes?: number;
  /** Override metadata lookup for a host adapter or focused tests. */
  readonly lookupMetadata?: ReviewerShelfMetadataLookup;
  /** Override the durable boundary for focused tests. */
  readonly materialize?: typeof materializeReviewerRecords;
  /** Product main process supplies the stable D071 binding for this Shelf. */
  readonly getWriteCoordination?: (shelfRoot: string) => Promise<ReviewerShelfWriteCoordination>;
  /** Must not exceed the Reviewer sidecar's limit of 100. */
  readonly pageLimit?: number;
}

interface ReviewerSearchPage {
  readonly results: readonly ReviewerQuotation[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

type PageResult =
  | { readonly kind: "page"; readonly page: ReviewerSearchPage }
  | { readonly kind: "error"; readonly code: ReviewerShelfSyncFailureCode; readonly message: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalStringValue(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isSafeSourceFile(value: unknown): boolean {
  if (!isPlainRecord(value)
    || typeof value.path !== "string"
    || value.path.length === 0
    || value.path.includes("\\")
    || value.path.includes("\0")
    || value.path.startsWith("/")
    || /^[A-Za-z]:/u.test(value.path)
    || value.path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    || (value.mediaType !== "image/jpeg" && value.mediaType !== "application/pdf")
    || typeof value.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.sha256)
    || (value.originalName !== undefined && typeof value.originalName !== "string")) return false;
  return true;
}

function isReviewerQuotation(value: unknown): value is ReviewerQuotation {
  return isPlainRecord(value)
    && typeof value.annotationId === "string"
    && value.annotationId.length > 0
    && typeof value.captureId === "string"
    && value.captureId.length > 0
    && typeof value.pageId === "string"
    && value.pageId.length > 0
    && isOptionalStringOrNull(value.sourcePageId)
    && isOptionalStringOrNull(value.isbn13)
    && isOptionalStringOrNull(value.title)
    && Array.isArray(value.authors)
    && value.authors.every((author) => typeof author === "string")
    && typeof value.quote === "string"
    && value.quote.length > 0
    && typeof value.pageLabel === "string"
    && typeof value.comment === "string"
    && value.reviewState === "APPROVED"
    && (value.packageId === undefined || value.packageId === null
      || (typeof value.packageId === "string" && /^capkg:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value.packageId)))
    && (value.sourceKind === undefined || value.sourceKind === null
      || ["book", "selfpublish", "website", "bookwithoutisbn", "Handwritten"].includes(String(value.sourceKind)))
    && (value.getDate === undefined || value.getDate === null || typeof value.getDate === "string")
    && isOptionalStringValue(value.url)
    && isOptionalStringValue(value.publisher)
    && isOptionalStringValue(value.circleName)
    && isOptionalStringValue(value.eventName)
    && (value.year === undefined || value.year === null
      || (typeof value.year === "number" && Number.isInteger(value.year) && value.year >= 0))
    && (value.sourceFiles === undefined || (Array.isArray(value.sourceFiles) && value.sourceFiles.every(isSafeSourceFile)))
    && (value.reviewedAtMs === undefined
      || value.reviewedAtMs === null
      || (typeof value.reviewedAtMs === "number" && Number.isFinite(value.reviewedAtMs)));
}

function parseSearchPage(value: unknown): ReviewerSearchPage | null {
  if (!isPlainRecord(value)
    || !Array.isArray(value.results)
    || !isSafeInteger(value.total)
    || !isSafeInteger(value.limit)
    || !isSafeInteger(value.offset)
    || !value.results.every(isReviewerQuotation)) {
    return null;
  }

  if (value.limit < 1
    || value.results.length > value.limit
    || !Number.isSafeInteger(value.offset + value.results.length)
    || value.offset + value.results.length > value.total) {
    return null;
  }

  const results = value.results.map((quotation) => Object.freeze({
    ...quotation,
    authors: Object.freeze([...quotation.authors]),
    reviewedAtMs: quotation.reviewedAtMs ?? null
  }));
  return Object.freeze({
    results: Object.freeze(results),
    total: value.total,
    limit: value.limit,
    offset: value.offset
  });
}

function toApprovedReviewerRecord(quotation: ReviewerQuotation): ApprovedReviewerRecord {
  return Object.freeze({
    annotationId: quotation.annotationId,
    reviewState: "APPROVED",
    packageId: quotation.packageId,
    sourceKind: quotation.sourceKind,
    getDate: quotation.getDate,
    isbn13: quotation.isbn13,
    url: quotation.url,
    title: quotation.title,
    authors: quotation.authors,
    publisher: quotation.publisher,
    year: quotation.year,
    circleName: quotation.circleName,
    eventName: quotation.eventName,
    quote: quotation.quote,
    pageLabel: quotation.pageLabel,
    comment: quotation.comment,
    ...(quotation.sourceFiles === undefined ? {} : { sourceFiles: quotation.sourceFiles })
  });
}

async function fetchSourceAsset(
  baseUrl: URL,
  fetcher: typeof fetch,
  token: string,
  annotationId: string,
  file: ReviewerSourceFile,
  maxBytes: number
): Promise<Uint8Array | null> {
  const endpoint = new URL(`api/captures/${encodeURIComponent(annotationId)}/source-file`, baseUrl);
  endpoint.searchParams.set("asset_path", file.path);
  try {
    const response = await fetcher(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { "X-Maginalia-Reviewer-Desktop-Token": token }
    });
    if (!response.ok) return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxBytes) return null;
    if (response.body === null) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch {
    return null;
  }
}

function reviewerError(
  code: ReviewerShelfSyncFailureCode,
  message: string
): ReviewerShelfSyncResult {
  return Object.freeze({
    kind: "error",
    materialized: 0,
    unchanged: 0,
    pending: 0,
    pendingRecords: Object.freeze([]),
    conflicts: 0,
    failed: 1,
    error: Object.freeze({ code, message })
  });
}

async function fetchSearchPage(
  baseUrl: URL,
  fetcher: typeof fetch,
  offset: number,
  limit: number
): Promise<PageResult> {
  const endpoint = new URL("api/search", baseUrl);
  endpoint.searchParams.set("q", "");
  endpoint.searchParams.set("status", "APPROVED");
  endpoint.searchParams.set("limit", String(limit));
  endpoint.searchParams.set("offset", String(offset));

  let response: Response;
  try {
    response = await fetcher(endpoint, { method: "GET", redirect: "error" });
  } catch {
    return {
      kind: "error",
      code: "reviewer-unavailable",
      message: "Reviewer unavailable. Try again from Shelf Review."
    };
  }
  if (!response.ok) {
    return {
      kind: "error",
      code: "reviewer-error",
      message: `Reviewer search failed (${response.status}).`
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "error",
      code: "reviewer-invalid-response",
      message: "Reviewer returned an invalid search response."
    };
  }
  const page = parseSearchPage(body);
  if (page === null) {
    return {
      kind: "error",
      code: "reviewer-invalid-response",
      message: "Reviewer returned an invalid search response."
    };
  }
  if (page.limit !== limit || page.offset !== offset) {
    return {
      kind: "error",
      code: "pagination-inconsistent",
      message: "Reviewer search pagination was inconsistent."
    };
  }
  return { kind: "page", page };
}

function mapMaterializationResult(
  materialized: MaterializationResult,
  failed: number
): ReviewerShelfSyncResult {
  return Object.freeze({
    kind: "completed",
    materialized: materialized.materialized,
    unchanged: materialized.unchanged,
    pending: materialized.pending.length,
    pendingRecords: materialized.pending,
    conflicts: materialized.conflicts,
    failed
  });
}

/**
 * Create an explicit Reviewer -> Private Shelf synchronization operation.
 * Every approved search page is validated before the materializer is called,
 * so Reviewer transport or pagination failures cannot partially write Shelf
 * data. Search and export paths remain independent of this adapter.
 */
export function createReviewerShelfSyncAdapter(
  options: ReviewerShelfSyncAdapterOptions = {}
): (shelfRoot: string) => Promise<ReviewerShelfSyncResult> {
  const configuredBaseUrl = parseReviewerBaseUrl(options.baseUrl);
  const fetcher = options.reviewerFetcher ?? fetch;
  const assetFetcher = options.sourceAssetFetcher ?? fetcher;
  const maxSourceAssetBytes = options.maxSourceAssetBytes ?? 256 * 1024 * 1024;
  const lookupMetadata = options.lookupMetadata ?? ((isbn13) => lookupOpenBdMetadata(isbn13));
  const materialize = options.materialize ?? materializeReviewerRecords;
  const pageLimit = options.pageLimit ?? REVIEWER_SHELF_SYNC_PAGE_LIMIT;

  return async (shelfRoot: string): Promise<ReviewerShelfSyncResult> => {
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > REVIEWER_SHELF_SYNC_PAGE_LIMIT) {
      return reviewerError("reviewer-invalid-response", "The Reviewer page limit is invalid.");
    }

    let baseUrl = configuredBaseUrl;
    if (baseUrl === null && options.getBaseUrl !== undefined) {
      try {
        const resolved = await options.getBaseUrl();
        baseUrl = parseReviewerBaseUrl(resolved instanceof URL ? resolved.href : resolved ?? undefined);
      } catch {
        return reviewerError("reviewer-unavailable", "Reviewer unavailable. Try again from Shelf Review.");
      }
    }
    if (baseUrl === null) {
      return reviewerError("reviewer-unavailable", "Reviewer unavailable. Try again from Shelf Review.");
    }

    const records: ApprovedReviewerRecord[] = [];
    const annotationIds = new Set<string>();
    const sourceAssetCache = new Map<string, Promise<Uint8Array | null>>();
    let expectedOffset = 0;
    let expectedTotal: number | undefined;
    let pageCount = 0;

    while (expectedTotal === undefined || expectedOffset < expectedTotal) {
      if (pageCount >= MAX_REVIEWER_SHELF_SYNC_PAGES) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination exceeded its safe limit.");
      }
      const result = await fetchSearchPage(baseUrl, fetcher, expectedOffset, pageLimit);
      if (result.kind === "error") return reviewerError(result.code, result.message);

      const { page } = result;
      if (expectedTotal !== undefined && page.total !== expectedTotal) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination was inconsistent.");
      }
      expectedTotal = page.total;
      if (page.offset !== expectedOffset
        || (page.total > expectedOffset && page.results.length === 0)
        || (page.offset + page.results.length < page.total && page.results.length !== page.limit)) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination was inconsistent.");
      }

      for (const quotation of page.results) {
        if (annotationIds.has(quotation.annotationId)) {
          return reviewerError("pagination-inconsistent", "Reviewer search returned a duplicate annotation.");
        }
        annotationIds.add(quotation.annotationId);
        let record = toApprovedReviewerRecord(quotation);
        if (quotation.sourceFiles !== undefined && quotation.sourceFiles.length > 0) {
          const token = options.getDesktopRequestToken?.();
          const files: ReviewerSourceFile[] = [];
          let unavailable = token === null || token === undefined || !Number.isSafeInteger(maxSourceAssetBytes) || maxSourceAssetBytes < 1;
          if (!unavailable) {
            for (const file of quotation.sourceFiles) {
              let asset = sourceAssetCache.get(file.sha256);
              if (asset === undefined) {
                asset = fetchSourceAsset(baseUrl, assetFetcher, token!, quotation.annotationId, file, maxSourceAssetBytes);
                sourceAssetCache.set(file.sha256, asset);
              }
              const bytes = await asset;
              if (bytes === null) unavailable = true;
              files.push(Object.freeze({ ...file, ...(bytes === null ? {} : { bytes }) }));
            }
          }
          record = Object.freeze({
            ...record,
            sourceFiles: Object.freeze(files.length > 0 ? files : [...quotation.sourceFiles]),
            sourceAssetsUnavailable: unavailable
          });
        }
        records.push(record);
      }

      const nextOffset = page.offset + page.results.length;
      if (nextOffset <= expectedOffset && nextOffset < page.total) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination did not make forward progress.");
      }
      expectedOffset = nextOffset;
      pageCount += 1;
    }

    const metadataByIsbn = new Map<string, Promise<Awaited<ReturnType<ReviewerShelfMetadataLookup>>>>();
    const failedAnnotationIds = new Set<string>();
    const cachedLookup: ReviewerShelfMetadataLookup = (isbn13) => {
      const cached = metadataByIsbn.get(isbn13);
      if (cached !== undefined) return cached;

      const lookup = Promise.resolve()
        .then(() => lookupMetadata(isbn13))
        .catch(() => ({ status: "unavailable" }))
        .then((result) => {
          if (result.status !== "ok" && result.status !== "not-found" && result.status !== "incomplete") {
            for (const record of records) {
              if (record.isbn13 === isbn13) failedAnnotationIds.add(record.annotationId);
            }
          }
          return result;
        });
      metadataByIsbn.set(isbn13, lookup);
      return lookup;
    };

    let coordination: ReviewerShelfWriteCoordination | undefined;
    if (records.length > 0 && options.getWriteCoordination !== undefined) {
      try {
        coordination = await options.getWriteCoordination(shelfRoot);
      } catch (error: unknown) {
        const message = error instanceof Error && error.message.length > 0
          ? error.message
          : "Private Shelf write coordination is unavailable.";
        return reviewerError("reviewer-error", message);
      }
    }
    const summary = await materialize(shelfRoot, Object.freeze(records), cachedLookup, coordination);
    return mapMaterializationResult(summary, failedAnnotationIds.size);
  };
}
