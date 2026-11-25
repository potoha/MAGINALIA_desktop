import { describe, expect, it, vi } from "vitest";
import {
  createShelfHandlers,
  isSearchShelfRequest,
  MAX_SHELF_QUERY_CHARS,
  type ShelfHandlerDependencies,
  type ShelfHandlers,
} from "./shelf-ipc";

const LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";

function createTestHandlers(overrides: Partial<ShelfHandlerDependencies> = {}): ShelfHandlers {
  return createShelfHandlers({
    getActivePrivateShelf: async () => ({
      kind: "private-shelf",
      privateShelf: true,
      library: { libraryId: LIBRARY_ID, displayName: "Research Shelf" },
      canonicalRoot: "C:\\private\\shelf",
      records: [{
        annotationId: ANNOTATION_ID,
        sourceId: "isbn:9780306406157",
        quote: "PRIVATE_QUOTATION_TEXT",
        privateMemo: "PRIVATE_MEMO_TEXT",
        title: "Title",
        authors: ["Author"],
      }],
      entities: { annotations: [], books: [] },
    }),
    searchPrivateShelf: async (_owner, libraryId) => ({
      kind: "results",
      libraryId,
      results: [{
        annotationId: ANNOTATION_ID,
        sourceId: "isbn:9780306406157",
        title: "Title",
        authors: ["Author"],
        page: 7,
      }],
    }),
    synchronizePrivateShelf: async () => ({
      kind: "completed",
      materialized: 2,
      unchanged: 1,
      pending: 1,
      conflicts: 0,
      failed: 0,
    }),
    reloadPrivateShelf: async () => ({
      kind: "opened",
      library: { libraryId: LIBRARY_ID, displayName: "Research Shelf" },
      recordCount: 3,
      issueCount: 0,
    }),
    ...overrides,
  });
}

describe("canonical Private Shelf IPC", () => {
  it("accepts only a bounded query request", () => {
    expect(isSearchShelfRequest({ query: "日本語" })).toBe(true);
    expect(isSearchShelfRequest({ query: "日本語", root: "C:\\outside" })).toBe(false);
    expect(isSearchShelfRequest({ query: "x".repeat(MAX_SHELF_QUERY_CHARS + 1) })).toBe(false);
    expect(isSearchShelfRequest(null)).toBe(false);
  });

  it("searches the owner's active Private Shelf and exposes only canonical references", async () => {
    const owner = {};
    const getActivePrivateShelf = vi.fn(async () => ({
      kind: "private-shelf" as const,
      privateShelf: true as const,
      library: { libraryId: LIBRARY_ID, displayName: "Research Shelf" },
      canonicalRoot: "C:\\private\\shelf",
      records: [{
        annotationId: ANNOTATION_ID,
        sourceId: "isbn:9780306406157",
        quote: "PRIVATE_QUOTATION_TEXT",
        privateMemo: "PRIVATE_MEMO_TEXT",
        title: "Title",
        authors: ["Author"],
        page: 7,
        url: "https://example.test/annotation-source",
        captureId: "raw reviewer field must not cross IPC",
      } as unknown as {
        annotationId: string;
        sourceId: string;
        quote: string;
        privateMemo: string;
        title: string;
        authors: readonly string[];
        page?: number;
        url?: string;
      }],
      entities: { annotations: [], books: [] },
    }));
    const searchPrivateShelf = vi.fn(async (_owner: object, libraryId: string, query: string) => ({
      kind: "results" as const,
      libraryId,
      results: [{
        annotationId: ANNOTATION_ID,
        sourceId: "isbn:9780306406157",
        title: "Title",
        authors: ["Author"],
        page: 7,
        url: "https://example.test/annotation-source",
      } as unknown as {
        annotationId: string;
        sourceId: string;
        title: string;
        authors: readonly string[];
        page?: number;
        url?: string;
      }],
      query,
    }));
    const handlers = createTestHandlers({ getActivePrivateShelf, searchPrivateShelf });

    const result = await handlers.searchShelf({ sender: owner }, { query: "needle" });

    expect(getActivePrivateShelf).toHaveBeenCalledWith(owner);
    expect(searchPrivateShelf).toHaveBeenCalledWith(owner, LIBRARY_ID, "needle");
    expect(result).toEqual({
      kind: "results",
      results: [{
        annotationId: ANNOTATION_ID,
        sourceId: "isbn:9780306406157",
        quote: "PRIVATE_QUOTATION_TEXT",
        privateMemo: "PRIVATE_MEMO_TEXT",
        title: "Title",
        authors: ["Author"],
        page: 7,
        url: "https://example.test/annotation-source",
      }],
      total: 1,
    });
    expect(JSON.stringify(result)).toContain("PRIVATE_QUOTATION_TEXT");
    expect(JSON.stringify(result)).toContain("PRIVATE_MEMO_TEXT");
    expect(JSON.stringify(result)).not.toContain("captureId");
    expect(JSON.stringify(result)).not.toContain("C:\\private");
    expect(await handlers.searchShelf({ sender: owner }, { query: "x", libraryId: LIBRARY_ID })).toMatchObject({
      kind: "error",
      code: "invalid-request",
    });
  });

  it("synchronizes once against the active root and reloads that owner's Shelf", async () => {
    const owner = {};
    const synchronizePrivateShelf = vi.fn(async (root: string) => ({
      kind: "completed" as const,
      materialized: 2,
      unchanged: 1,
      pending: 1,
      conflicts: 0,
      failed: 0,
      receivedRoot: root,
    }));
    const reloadPrivateShelf = vi.fn(async (_owner: object) => ({
      kind: "opened" as const,
      library: { libraryId: LIBRARY_ID, displayName: "Research Shelf" },
      recordCount: 3,
      issueCount: 0,
    }));
    const handlers = createTestHandlers({ synchronizePrivateShelf, reloadPrivateShelf });

    const result = await handlers.refreshShelf({ sender: owner });

    expect(synchronizePrivateShelf).toHaveBeenCalledTimes(1);
    expect(synchronizePrivateShelf).toHaveBeenCalledWith("C:\\private\\shelf");
    expect(reloadPrivateShelf).toHaveBeenCalledTimes(1);
    expect(reloadPrivateShelf).toHaveBeenCalledWith(owner);
    expect(result).toEqual({
      kind: "refreshed",
      materialized: 2,
      unchanged: 1,
      pending: 1,
      conflicts: 0,
      failed: 0,
    });
    expect(JSON.stringify(result)).not.toContain("receivedRoot");
    expect(await handlers.refreshShelf({ sender: owner }, "extra")).toMatchObject({
      kind: "error",
      code: "invalid-request",
    });
  });

  it("does not sync or reload when no Private Shelf is selected", async () => {
    const synchronizePrivateShelf = vi.fn(async () => ({
      kind: "completed" as const,
      materialized: 0,
      unchanged: 0,
      pending: 0,
      conflicts: 0,
      failed: 0,
    }));
    const reloadPrivateShelf = vi.fn(async () => ({
      kind: "opened" as const,
      library: { libraryId: LIBRARY_ID, displayName: "Research Shelf" },
      recordCount: 0,
      issueCount: 0,
    }));
    const handlers = createTestHandlers({
      getActivePrivateShelf: async () => ({
        kind: "error",
        code: "library-not-owned",
        message: "That Library snapshot is not open for this owner.",
      }),
      synchronizePrivateShelf,
      reloadPrivateShelf,
    });

    await expect(handlers.refreshShelf({ sender: {} })).resolves.toMatchObject({
      kind: "error",
      code: "shelf-not-selected",
    });
    expect(synchronizePrivateShelf).not.toHaveBeenCalled();
    expect(reloadPrivateShelf).not.toHaveBeenCalled();
  });

  it("keeps configured Shelf failures actionable instead of masking them as a generic selection error", async () => {
    const handlers = createTestHandlers({
      getActivePrivateShelf: async () => ({
        kind: "error",
        code: "invalid-library-config",
        message: "Private Shelf is not configured: shelf_location.yml was not found.",
      }),
    });

    await expect(handlers.searchShelf({ sender: {} }, { query: "引用" })).resolves.toEqual({
      kind: "error",
      code: "invalid-library-config",
      message: "Private Shelf is not configured: shelf_location.yml was not found.",
    });
    await expect(handlers.refreshShelf({ sender: {} })).resolves.toEqual({
      kind: "error",
      code: "shelf-not-selected",
      message: "Private Shelf is not configured: shelf_location.yml was not found.",
    });
  });

  it("preserves sync failures and skips the Shelf reload", async () => {
    const reloadPrivateShelf = vi.fn(async () => ({
      kind: "opened" as const,
      library: { libraryId: LIBRARY_ID, displayName: "Research Shelf" },
      recordCount: 0,
      issueCount: 0,
    }));
    const handlers = createTestHandlers({
      synchronizePrivateShelf: async () => ({
        kind: "error",
        materialized: 0,
        unchanged: 0,
        pending: 0,
        conflicts: 0,
        failed: 1,
        error: { code: "reviewer-unavailable", message: "Reviewer unavailable. Try again from Shelf Review." },
      }),
      reloadPrivateShelf,
    });

    await expect(handlers.refreshShelf({ sender: {} })).resolves.toEqual({
      kind: "error",
      code: "reviewer-unavailable",
      message: "Reviewer unavailable. Try again from Shelf Review.",
    });
    expect(reloadPrivateShelf).not.toHaveBeenCalled();
  });
});
