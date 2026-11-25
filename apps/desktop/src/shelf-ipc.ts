import type {
  ActivePrivateShelfResult,
  LibraryFailure,
  LibraryOpenResult,
  LibraryRecord,
  LibrarySearchReference,
  LibrarySearchResult,
} from "./library-service";

export const SEARCH_SHELF_CHANNEL = "maginalia:search-shelf";
export const REFRESH_SHELF_CHANNEL = "maginalia:refresh-shelf";
export const MAX_SHELF_QUERY_CHARS = 2_000;

export interface SearchShelfRequest {
  readonly query: string;
}

export interface CanonicalShelfSearchReference extends LibrarySearchReference {
  readonly quote: string;
  readonly privateMemo?: string;
}

export interface SearchShelfSuccess {
  readonly kind: "results";
  readonly results: readonly CanonicalShelfSearchReference[];
  readonly total: number;
  readonly folderIdentityRecovery?: { readonly code: string; readonly message: string };
}

export type ShelfSearchFailureCode = "invalid-request" | "shelf-not-selected" | "shelf-search-failed";

export interface ShelfSearchFailure {
  readonly kind: "error";
  readonly code: ShelfSearchFailureCode;
  readonly message: string;
}

export type SearchShelfResult = SearchShelfSuccess | LibraryFailure | ShelfSearchFailure;

export interface RefreshShelfSuccess {
  readonly kind: "refreshed";
  readonly materialized: number;
  readonly unchanged: number;
  readonly pending: number;
  readonly conflicts: number;
  readonly failed: number;
}

export type ShelfRefreshFailureCode =
  | "invalid-request"
  | "shelf-not-selected"
  | "reviewer-unavailable"
  | "reviewer-error"
  | "reviewer-invalid-response"
  | "pagination-inconsistent"
  | "shelf-refresh-failed";

export interface ShelfRefreshFailure {
  readonly kind: "error";
  readonly code: ShelfRefreshFailureCode;
  readonly message: string;
}

export type RefreshShelfResult = RefreshShelfSuccess | ShelfRefreshFailure;

export interface ShelfSyncOutcome {
  readonly kind: "completed" | "error";
  readonly materialized: number;
  readonly unchanged: number;
  readonly pending: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly error?: {
    readonly code: Exclude<ShelfRefreshFailureCode, "invalid-request" | "shelf-not-selected" | "shelf-refresh-failed">;
    readonly message: string;
  };
}

export interface ShelfInvokeEvent {
  readonly sender: object;
}

export interface ShelfHandlerDependencies {
  readonly getActivePrivateShelf: (owner: object) => ActivePrivateShelfResult | Promise<ActivePrivateShelfResult>;
  readonly searchPrivateShelf: (
    owner: object,
    libraryId: string,
    query: string,
  ) => LibrarySearchResult | Promise<LibrarySearchResult>;
  readonly synchronizePrivateShelf: (shelfRoot: string) => Promise<ShelfSyncOutcome>;
  readonly reloadPrivateShelf: (owner: object) => Promise<LibraryOpenResult>;
}

export interface ShelfHandlers {
  readonly searchShelf: (
    event: ShelfInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<SearchShelfResult>;
  readonly refreshShelf: (
    event: ShelfInvokeEvent,
    ...args: readonly unknown[]
  ) => Promise<RefreshShelfResult>;
}

const INVALID_SEARCH_REQUEST: ShelfSearchFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The Shelf search request was invalid.",
});

const SHELF_SEARCH_FAILED: ShelfSearchFailure = Object.freeze({
  kind: "error",
  code: "shelf-search-failed",
  message: "The Private Shelf search could not be completed. Try again.",
});

const SHELF_NOT_SELECTED_FOR_SEARCH: ShelfSearchFailure = Object.freeze({
  kind: "error",
  code: "shelf-not-selected",
  message: "Activate a Private Shelf repository before searching.",
});

const INVALID_REFRESH_REQUEST: ShelfRefreshFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The Shelf refresh request was invalid.",
});

const SHELF_NOT_SELECTED: ShelfRefreshFailure = Object.freeze({
  kind: "error",
  code: "shelf-not-selected",
  message: "Activate a Private Shelf repository before refreshing Shelf.",
});

const SHELF_REFRESH_FAILED: ShelfRefreshFailure = Object.freeze({
  kind: "error",
  code: "shelf-refresh-failed",
  message: "The Private Shelf could not be refreshed. Try again.",
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

export function isSearchShelfRequest(value: unknown): value is SearchShelfRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ["query"])
    && typeof value.query === "string"
    && value.query.length <= MAX_SHELF_QUERY_CHARS;
}

function copyReference(reference: LibraryRecord): CanonicalShelfSearchReference {
  const result: {
    annotationId: string;
    sourceId: string;
    quote: string;
    privateMemo?: string;
    title: string;
    authors: readonly string[];
    page?: number;
    url?: string;
  } = {
    annotationId: reference.annotationId,
    sourceId: reference.sourceId,
    quote: reference.quote,
    title: reference.title,
    authors: Object.freeze([...reference.authors]),
  };
  if (reference.privateMemo !== undefined) result.privateMemo = reference.privateMemo;
  if (reference.page !== undefined) result.page = reference.page;
  if (reference.url !== undefined) result.url = reference.url;
  return Object.freeze(result);
}

function refreshFailure(
  code: ShelfRefreshFailureCode,
  message: string,
): ShelfRefreshFailure {
  return Object.freeze({ kind: "error", code, message });
}

export function createShelfHandlers(dependencies: ShelfHandlerDependencies): ShelfHandlers {
  return {
    searchShelf: async (event, request, ...args) => {
      if (args.length !== 0 || !isSearchShelfRequest(request)) return INVALID_SEARCH_REQUEST;
      try {
        const active = await dependencies.getActivePrivateShelf(event.sender);
        if (active.kind === "error") return active;
        const result = await dependencies.searchPrivateShelf(
          event.sender,
          active.library.libraryId,
          request.query,
        );
        if (result.kind !== "results") return result;
        const recordsById = new Map(active.records.map((record) => [record.annotationId, record] as const));
        const results = Object.freeze(result.results.flatMap((reference) => {
          const record = recordsById.get(reference.annotationId);
          return record === undefined ? [] : [copyReference(record)];
        }));
        return Object.freeze({
          kind: "results",
          results,
          total: results.length,
          ...(active.folderIdentityRecovery ? { folderIdentityRecovery: active.folderIdentityRecovery } : {}),
        });
      } catch (_error: unknown) {
        return SHELF_SEARCH_FAILED;
      }
    },
    refreshShelf: async (event, ...args) => {
      if (args.length !== 0) return INVALID_REFRESH_REQUEST;

      let active: ActivePrivateShelfResult;
      try {
        active = await dependencies.getActivePrivateShelf(event.sender);
      } catch (_error: unknown) {
        return SHELF_NOT_SELECTED;
      }
      if (active.kind === "error") return refreshFailure("shelf-not-selected", active.message);

      let synchronized: ShelfSyncOutcome;
      try {
        synchronized = await dependencies.synchronizePrivateShelf(active.canonicalRoot);
      } catch (_error: unknown) {
        return SHELF_REFRESH_FAILED;
      }
      if (synchronized.kind === "error") {
        const failure = synchronized.error;
        return failure === undefined
          ? SHELF_REFRESH_FAILED
          : refreshFailure(failure.code, failure.message);
      }

      let reloaded: LibraryOpenResult;
      try {
        reloaded = await dependencies.reloadPrivateShelf(event.sender);
      } catch (_error: unknown) {
        return SHELF_REFRESH_FAILED;
      }
      if (reloaded.kind !== "opened") {
        return refreshFailure("shelf-refresh-failed", reloaded.message);
      }
      return Object.freeze({
        kind: "refreshed",
        materialized: synchronized.materialized,
        unchanged: synchronized.unchanged,
        pending: synchronized.pending,
        conflicts: synchronized.conflicts,
        failed: synchronized.failed,
      });
    },
  };
}
