import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MaterializationResult } from "./reviewer-shelf-materializer";
import {
  createReviewerShelfSyncAdapter,
  REVIEWER_SHELF_SYNC_PAGE_LIMIT,
  type ReviewerShelfSyncAdapterOptions
} from "./reviewer-shelf-sync";
import type { OpenBdBookMetadata } from "./reviewer-shelf-reconciliation";

const BASE_URL = "http://127.0.0.1:43127/";
const ISBN = "9780306406157";

let shelfRoot: string | undefined;

afterEach(async () => {
  if (shelfRoot !== undefined) await rm(shelfRoot, { recursive: true, force: true });
  shelfRoot = undefined;
});

function reviewerRow(annotationId: string, quote: string, isbn13: string | null = ISBN) {
  return {
    annotationId,
    captureId: `capture-${annotationId}`,
    pageId: `page-${annotationId}`,
    sourcePageId: null,
    isbn13,
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceKind: "book",
    getDate: "202602011230",
    title: null,
    authors: [],
    quote,
    pageLabel: "12",
    comment: "Reviewer のメモ",
    reviewState: "APPROVED",
    reviewedAtMs: 1_728_000_000_000
  };
}

function page(results: readonly ReturnType<typeof reviewerRow>[], total: number, offset: number, limit: number) {
  return { results, total, limit, offset };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function fakeMaterialization(overrides: Partial<MaterializationResult> = {}): MaterializationResult {
  return {
    materialized: 0,
    unchanged: 0,
    pending: [],
    conflicts: 0,
    ...overrides
  };
}

function adapterOptions(
  pages: readonly unknown[],
  overrides: Partial<ReviewerShelfSyncAdapterOptions> = {}
): ReviewerShelfSyncAdapterOptions & { readonly reviewerFetcher: typeof fetch } {
  let index = 0;
  const reviewerFetcher: typeof fetch = vi.fn(async () => response(pages[index++]) as Response);
  return {
    baseUrl: BASE_URL,
    pageLimit: 2,
    reviewerFetcher,
    ...overrides
  };
}

async function createShelf(): Promise<string> {
  shelfRoot = await mkdtemp(path.join(os.tmpdir(), "maginalia-reviewer-sync-"));
  await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({
    booksPath: "books",
    annotationsPath: "annotations"
  }), "utf8");
  return shelfRoot;
}

describe("Reviewer to Private Shelf sync adapter", () => {
  it("fetches every approved page before materializing and preserves Japanese text", async () => {
    const records = [
      reviewerRow("annotation-1", "「日本語の引用」"),
      reviewerRow("annotation-2", "二ページ目の引用"),
      reviewerRow("annotation-3", "終端ページの引用")
    ];
    const options = adapterOptions([
      page(records.slice(0, 2), 3, 0, 2),
      page(records.slice(2), 3, 2, 2)
    ]);
    const seen: string[] = [];
    const lookupMetadata = vi.fn(async () => ({ status: "not-found" as const }));
    const materialize = vi.fn(async (
      _root: string,
      approved: readonly { readonly quote: string }[],
      lookup: (isbn13: string) => Promise<{ readonly status: string }>
    ) => {
      seen.push(...approved.map((record) => record.quote));
      await lookup(ISBN);
      await lookup(ISBN);
      return fakeMaterialization({ materialized: 2, unchanged: 1 });
    });
    const sync = createReviewerShelfSyncAdapter({ ...options, lookupMetadata, materialize });

    const result = await sync("unused-by-fake-materializer");

    expect(result).toMatchObject({
      kind: "completed",
      materialized: 2,
      unchanged: 1,
      pending: 0,
      conflicts: 0,
      failed: 0
    });
    expect(seen).toEqual(["「日本語の引用」", "二ページ目の引用", "終端ページの引用"]);
    expect(options.reviewerFetcher).toHaveBeenCalledTimes(2);
    const urls = vi.mocked(options.reviewerFetcher).mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => [url.searchParams.get("q"), url.searchParams.get("status"), url.searchParams.get("limit"), url.searchParams.get("offset")]))
      .toEqual([["", "APPROVED", "2", "0"], ["", "APPROVED", "2", "2"]]);
    expect(lookupMetadata).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it("passes the trusted stable binding into the shared Reviewer materializer", async () => {
    const root = await createShelf();
    const coordination = {
      expectedShelfId: "11111111-2222-4333-8444-555555555555",
      coordinationRoot: "C:\\Users\\Researcher\\AppData\\Local\\MAGINALIA\\coordination",
    };
    const materialize = vi.fn(async () => fakeMaterialization({ materialized: 1 }));
    const getWriteCoordination = vi.fn(async () => coordination);
    const sync = createReviewerShelfSyncAdapter({
      ...adapterOptions([page([reviewerRow("annotation-1", "日本語の引用")], 1, 0, 2)]),
      materialize,
      getWriteCoordination,
    });

    await expect(sync(root)).resolves.toMatchObject({ kind: "completed", materialized: 1 });
    expect(getWriteCoordination).toHaveBeenCalledWith(root);
    expect(materialize).toHaveBeenCalledWith(root, expect.any(Array), expect.any(Function), coordination);
  });

  it("does not fall back to the legacy writer when stable binding resolution fails", async () => {
    const root = await createShelf();
    const materialize = vi.fn(async () => fakeMaterialization());
    const sync = createReviewerShelfSyncAdapter({
      ...adapterOptions([page([reviewerRow("annotation-1", "日本語の引用")], 1, 0, 2)]),
      materialize,
      getWriteCoordination: async () => { throw new Error("Shelf binding confirmation was declined."); },
    });

    await expect(sync(root)).resolves.toMatchObject({
      kind: "error",
      error: { code: "reviewer-error", message: "Shelf binding confirmation was declined." },
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("does not request a Shelf binding when Reviewer has no approved records", async () => {
    const root = await createShelf();
    const getWriteCoordination = vi.fn(async () => {
      throw new Error("binding is unnecessary for an empty result");
    });
    const materialize = vi.fn(async () => fakeMaterialization());
    const sync = createReviewerShelfSyncAdapter({
      ...adapterOptions([page([], 0, 0, 2)]),
      getWriteCoordination,
      materialize,
    });

    await expect(sync(root)).resolves.toMatchObject({ kind: "completed", materialized: 0 });
    expect(getWriteCoordination).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledWith(root, [], expect.any(Function), undefined);
  });

  it.each([
    {
      label: "a changing total",
      pages: [
        page([reviewerRow("annotation-1", "一"), reviewerRow("annotation-2", "二")], 3, 0, 2),
        page([reviewerRow("annotation-3", "三")], 4, 2, 2)
      ]
    },
    {
      label: "a duplicate annotation across pages",
      pages: [
        page([reviewerRow("annotation-1", "一"), reviewerRow("annotation-2", "二")], 3, 0, 2),
        page([reviewerRow("annotation-2", "重複")], 3, 2, 2)
      ]
    },
    {
      label: "a short non-final page",
      pages: [
        page([reviewerRow("annotation-1", "一")], 3, 0, 2),
        page([reviewerRow("annotation-2", "二"), reviewerRow("annotation-3", "三")], 3, 2, 2)
      ]
    }
  ])("does not materialize when pagination is invalid: $label", async ({ pages }) => {
    const materialize = vi.fn(async () => fakeMaterialization());
    const lookupMetadata = vi.fn(async () => ({ status: "ok" as const, metadata: {
      isbn13: ISBN,
      title: "題名",
      authors: ["著者"]
    } }));
    const sync = createReviewerShelfSyncAdapter({
      ...adapterOptions(pages),
      lookupMetadata,
      materialize
    });

    const result = await sync("unused-by-fake-materializer");

    expect(result).toMatchObject({ kind: "error", failed: 1, materialized: 0 });
    expect(result.error?.code).toBe("pagination-inconsistent");
    expect(materialize).not.toHaveBeenCalled();
    expect(lookupMetadata).not.toHaveBeenCalled();
  });

  it("materializes with manifest provenance when OpenBD misses, then remains idempotent", async () => {
    const root = await createShelf();
    const reviewerFetcher: typeof fetch = vi.fn(async () => response(page([
      reviewerRow("123e4567-e89b-42d3-a456-426614174000", "引用を保留してから取り込む")
    ], 1, 0, REVIEWER_SHELF_SYNC_PAGE_LIMIT)));
    const metadata: OpenBdBookMetadata = {
      isbn13: ISBN,
      title: "『日本語の書名』",
      authors: ["著者名"],
      publisher: "出版社",
      year: 2024
    };
    const lookupMetadata = vi.fn()
      .mockResolvedValueOnce({ status: "not-found" })
      .mockResolvedValue({ status: "ok", metadata });
    const sync = createReviewerShelfSyncAdapter({
      baseUrl: BASE_URL,
      reviewerFetcher,
      lookupMetadata
    });

    const first = await sync(root);
    expect(first).toMatchObject({ kind: "completed", materialized: 1, pending: 0, failed: 0 });
    const bookFiles = await readdir(path.join(root, "books"));
    expect(bookFiles).toHaveLength(1);
    const annotationFiles = await readdir(path.join(root, "annotations"));
    expect(annotationFiles).toHaveLength(1);

    const second = await sync(root);
    expect(second).toMatchObject({ kind: "completed", materialized: 0, unchanged: 1, pending: 0, failed: 0 });
    expect(await readdir(path.join(root, "books"))).toEqual(bookFiles);
    expect(await readdir(path.join(root, "annotations"))).toEqual(annotationFiles);

    const third = await sync(root);
    expect(third).toMatchObject({ kind: "completed", materialized: 0, unchanged: 1, pending: 0, failed: 0 });
    expect(lookupMetadata).toHaveBeenCalledTimes(3);
    expect(reviewerFetcher).toHaveBeenCalledTimes(3);
  });

  it("isolates an OpenBD rejection without blocking approved manifest-backed records", async () => {
    const root = await createShelf();
    const secondIsbn = "9780134685991";
    const records = [
      reviewerRow("123e4567-e89b-42d3-a456-426614174001", "一つ目", ISBN),
      reviewerRow("123e4567-e89b-42d3-a456-426614174002", "二つ目", secondIsbn)
    ];
    const lookupMetadata = vi.fn(async (isbn13: string) => {
      if (isbn13 === ISBN) throw new Error("network failed");
      return {
        status: "ok" as const,
        metadata: { isbn13, title: "独立した書籍", authors: ["著者"] }
      };
    });
    const sync = createReviewerShelfSyncAdapter({
      ...adapterOptions([page(records, 2, 0, 2)]),
      lookupMetadata
    });

    const result = await sync(root);

    expect(result).toMatchObject({ kind: "completed", materialized: 2, pending: 0, failed: 1 });
    expect(lookupMetadata).toHaveBeenCalledTimes(2);
    expect(await readdir(path.join(root, "books"))).toHaveLength(2);
    expect(await readdir(path.join(root, "annotations"))).toHaveLength(2);
  });

  it("reconciles existing YAML Books before creating a new v0.4 Book", async () => {
    const root = await createShelf();
    const booksDirectory = path.join(root, "books");
    await mkdir(booksDirectory, { recursive: true });
    await writeFile(path.join(booksDirectory, "existing.yaml"), [
      "type: book",
      "version: '0.4'",
      "id: book:01J0A1B2C3D4E5F6G7H8J9K0M1",
      "source:",
      "  kind: book",
      "get:",
      "  date: '202601011200'",
      `isbn13: '${ISBN}'`,
      "title: Existing YAML book",
      "authors:",
      "  - Existing author",
      ""
    ].join("\n"), "utf8");
    const sync = createReviewerShelfSyncAdapter({
      ...adapterOptions([page([reviewerRow("123e4567-e89b-42d3-a456-426614174003", "同じ書籍")], 1, 0, 2)]),
      lookupMetadata: async () => ({ status: "not-found" })
    });

    const result = await sync(root);

    expect(result).toMatchObject({ kind: "completed", materialized: 1, unchanged: 0, conflicts: 0 });
    expect(await readdir(booksDirectory)).toEqual(["existing.yaml"]);
  });
});
