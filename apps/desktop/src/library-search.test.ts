import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LibraryService,
  type LibraryOpenResult,
  type LibraryQuotationResult,
  type LibrarySearchResult,
} from "./library-service";

const FIRST_BOOK_ID = "isbn:9781234567890";
const SECOND_BOOK_ID = "isbn:9781234567891";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-library-search-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function annotationId(index: number): string {
  return `ann:01ARZ3NDEKTSV4RRFFQ69G${index.toString(16).toUpperCase().padStart(4, "0")}`;
}

function generatedBookId(index: number): string {
  return `isbn:${String(9780000000000 + index).padStart(13, "0")}`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value), "utf8");
}

async function writeRecord(
  root: string,
  index: number,
  bookId: string,
  bookOverrides: Record<string, unknown> = {},
  annotationOverrides: Record<string, unknown> = {},
): Promise<void> {
  await writeJson(path.join(root, "books", `book-${index.toString().padStart(3, "0")}.json`), {
    type: "book",
    version: "0.1",
    id: bookId,
    title: `Book ${index}`,
    authors: [`Author ${index}`],
    isbn13: bookId.slice("isbn:".length),
    ...bookOverrides,
  });
  await writeJson(path.join(root, "annotations", `annotation-${index.toString().padStart(3, "0")}.json`), {
    type: "annotation",
    version: "0.1",
    id: annotationId(index),
    source: bookId,
    location: { page: index + 1 },
    quote: `Quote ${index}`,
    ...annotationOverrides,
  });
}

async function writeV04WebRecord(
  root: string,
  index: number,
  quote: string,
  bookUrl: string,
  annotationUrl?: string,
): Promise<void> {
  const ulid = `01ARZ3NDEKTSV4RRFFQ69G${index.toString(16).toUpperCase().padStart(4, "0")}`;
  const bookId = `book:${ulid}`;
  const book: Record<string, unknown> = {
    type: "book",
    version: "0.4",
    id: bookId,
    source: { kind: "website" },
    get: { date: "202611031200" },
    url: bookUrl,
    title: `Website ${index}`,
    authors: [`Web Author ${index}`],
  };
  const annotation: Record<string, unknown> = {
    type: "annotation",
    version: "0.4",
    id: annotationId(index),
    source: { id: bookId, kind: "website" },
    get: { date: "202611031200" },
    quote,
    ...(annotationUrl === undefined ? { isbn13: "9780306406157" } : { url: annotationUrl }),
  };
  await writeJson(path.join(root, "books", `book-${index.toString().padStart(3, "0")}.json`), book);
  await writeJson(path.join(root, "annotations", `annotation-${index.toString().padStart(3, "0")}.json`), annotation);
}

function opened(result: LibraryOpenResult) {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected the Library to open");
  return result;
}

function searchResults(result: LibrarySearchResult) {
  expect(result.kind).toBe("results");
  if (result.kind !== "results") throw new Error("Expected search results");
  return result;
}

function resolved(result: LibraryQuotationResult) {
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") throw new Error("Expected a quotation resolution");
  return result;
}

async function createSearchFixture(directory: string): Promise<string> {
  const root = path.join(directory, "search-library");
  await mkdir(path.join(root, "books"), { recursive: true });
  await mkdir(path.join(root, "annotations"), { recursive: true });
  await writeRecord(root, 0, FIRST_BOOK_ID, {
    title: "日本語の本",
    authors: ["著者"],
  }, {
    quote: "通常の引用",
    comment: "excluded-secret",
    attribution: "excluded-secret",
    captureImage: "excluded-secret/capture.jpg",
    rawOcr: "excluded-secret raw OCR",
    localPath: "excluded-secret/local.png",
    deviceMetadata: { secret: "excluded-secret" },
    unpublishedComments: ["excluded-secret"],
    privateMemo: "memo-only-needle",
    location: { page: 42, path: "excluded-secret/path" },
  });
  await writeRecord(root, 1, SECOND_BOOK_ID, {
    title: "Other title",
    authors: ["Author Needle"],
  }, {
    quote: "NEEDLE quote *",
    privateMemo: "other memo",
  });
  await writeRecord(root, 2, generatedBookId(2), {
    title: "Third title",
    authors: ["Third author"],
  }, {
    quote: "日本語引用",
  });
  return root;
}

describe("LibraryService search and quotation resolution", () => {
  it("searches literal fields, ranks quote matches, and never returns quotation or memo text", async () => {
    await withTempDirectory(async (directory) => {
      const root = await createSearchFixture(directory);
      const owner = {};
      const service = new LibraryService();
      const openedResult = opened(await service.openForOwner(owner, root));

      const ranked = searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "needle"));
      expect(ranked.results.map((result) => result.annotationId)).toEqual([
        annotationId(1),
        annotationId(0),
      ]);
      expect(Object.keys(ranked.results[0]).sort()).toEqual([
        "annotationId",
        "authors",
        "page",
        "sourceId",
        "title",
      ]);
      const serialized = JSON.stringify(ranked);
      expect(serialized).not.toContain("NEEDLE quote");
      expect(serialized).not.toContain("memo-only-needle");
      expect(serialized).not.toContain(root);

      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "memo-only-needle"))
        .results.map((result) => result.annotationId)).toEqual([annotationId(0)]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "*"))
        .results.map((result) => result.annotationId)).toEqual([annotationId(1)]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "日本語"))
        .results.map((result) => result.annotationId)).toEqual([annotationId(2), annotationId(0)]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, annotationId(0)))
        .results.map((result) => result.annotationId)).toEqual([annotationId(0)]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, FIRST_BOOK_ID))
        .results.map((result) => result.annotationId)).toEqual([annotationId(0)]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "42"))
        .results.map((result) => result.annotationId)).toEqual([annotationId(0)]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "excluded-secret"))
        .results).toEqual([]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, ""))
        .results.map((result) => result.annotationId)).toEqual([annotationId(0), annotationId(1), annotationId(2)]);
      expect(service.searchForOwner(owner, openedResult.library.libraryId, "x".repeat(2_001))).toMatchObject({
        kind: "error",
        code: "invalid-query",
      });
    });
  });

  it("searches v0.4 Annotation URLs first, falls back to the Book URL, and leaves legacy records URL-free", async () => {
    await withTempDirectory(async (directory) => {
      const root = await createSearchFixture(directory);
      const annotationUrl = "https://example.test/annotation-specific-source";
      const bookUrl = "https://example.test/book-level-source";
      const fallbackUrl = "https://example.test/book-only-source";
      await writeV04WebRecord(root, 3, "The Collector example quotation", bookUrl, annotationUrl);
      await writeV04WebRecord(root, 4, "A quote with only Book provenance", fallbackUrl);

      const owner = {};
      const service = new LibraryService();
      const openedResult = opened(await service.openForOwner(owner, root));

      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "annotation-specific-source")).results)
        .toEqual([expect.objectContaining({ annotationId: annotationId(3), url: annotationUrl })]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "book-level-source")).results)
        .toEqual([]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "book-only-source")).results)
        .toEqual([expect.objectContaining({ annotationId: annotationId(4), url: fallbackUrl })]);
      expect(searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "Collector example quotation")).results)
        .toEqual([expect.objectContaining({ annotationId: annotationId(3), url: annotationUrl })]);

      const legacy = searchResults(service.searchForOwner(owner, openedResult.library.libraryId, "通常の引用"))
        .results.find((result) => result.annotationId === annotationId(0));
      expect(legacy).toBeDefined();
      expect(legacy).not.toHaveProperty("url");
    });
  });

  it("bounds empty-query results to one hundred records in snapshot order", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "large-search-library");
      await mkdir(path.join(root, "books"), { recursive: true });
      await mkdir(path.join(root, "annotations"), { recursive: true });
      for (let index = 0; index < 105; index += 1) {
        await writeRecord(root, index, generatedBookId(index));
      }

      const service = new LibraryService();
      const owner = {};
      const openedResult = opened(await service.openForOwner(owner, root));
      expect(openedResult.recordCount).toBe(105);
      const result = searchResults(service.searchForOwner(owner, openedResult.library.libraryId, ""));
      expect(result.results).toHaveLength(100);
      expect(result.results[0].annotationId).toBe(annotationId(0));
      expect(result.results[99].annotationId).toBe(annotationId(99));
    });
  });

  it("resolves only a current snapshot member for explicit insertion", async () => {
    await withTempDirectory(async (directory) => {
      const root = await createSearchFixture(directory);
      const otherRoot = path.join(directory, "other-library");
      await mkdir(path.join(otherRoot, "books"), { recursive: true });
      await mkdir(path.join(otherRoot, "annotations"), { recursive: true });
      await writeRecord(otherRoot, 0, generatedBookId(50));

      const service = new LibraryService();
      const owner = {};
      const otherOwner = {};
      const first = opened(await service.openForOwner(owner, root));
      const resolvedResult = resolved(service.resolveQuotationForInsertForOwner(
        owner,
        first.library.libraryId,
        annotationId(0),
      ));
      expect(Object.keys(resolvedResult).sort()).toEqual([
        "annotationId",
        "authors",
        "kind",
        "libraryId",
        "page",
        "quote",
        "sourceId",
        "title",
      ]);
      expect(resolvedResult.quote).toBe("通常の引用");
      const serialized = JSON.stringify(resolvedResult);
      expect(serialized).not.toContain("memo-only-needle");
      expect(serialized).not.toContain("excluded-secret");
      expect(serialized).not.toContain(root);

      expect(service.resolveQuotationForInsertForOwner(owner, first.library.libraryId, "bad-id")).toMatchObject({
        kind: "error",
        code: "invalid-annotation-id",
      });
      expect(service.resolveQuotationForInsertForOwner(owner, first.library.libraryId, annotationId(99))).toMatchObject({
        kind: "error",
        code: "annotation-not-found",
      });
      expect(service.resolveQuotationForInsertForOwner(otherOwner, first.library.libraryId, annotationId(0))).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });

      const second = opened(await service.openForOwner(owner, otherRoot));
      expect(service.resolveQuotationForInsertForOwner(owner, first.library.libraryId, annotationId(0))).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });
      expect(resolved(service.resolveQuotationForInsertForOwner(owner, second.library.libraryId, annotationId(0))).quote)
        .toBe("Quote 0");
    });
  });
});
