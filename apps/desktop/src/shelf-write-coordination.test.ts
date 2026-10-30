/**
 * Cross-process Shelf writer foundation: lease, journal and refusal contracts.
 *
 * These tests run in one process. Real two-process exclusion, crash recovery and
 * receipt durability are proven separately by
 * `test/collector-shelf-write-coordination.test.mjs`, which spawns child
 * processes against an isolated fixture Shelf.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireShelfWriteLease,
  commitShelfQuote,
  inspectShelfWriteJournal,
  resolveShelfWriteLayout,
  ShelfWriteCoordinationError,
  type ShelfQuoteWriteRequest
} from "./shelf-write-coordination.js";
import { parseShelfEntity } from "@maginalia/format";
import type { ShelfAnnotationV04, ShelfBookV04 } from "@maginalia/format";
import { materializeReviewerRecords } from "./reviewer-shelf-materializer.js";

interface Fixture {
  readonly base: string;
  readonly shelfId: string;
  readonly shelfRoot: string;
  readonly coordinationRoot: string;
  readonly booksDirectory: string;
  readonly annotationsDirectory: string;
}

const created: string[] = [];

async function createFixture(label: string): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), `maginalia-shelf-write-${label}-日本語-`));
  created.push(base);
  const shelfId = randomUUID();
  const shelfRoot = path.join(base, "Private Shelf 本棚");
  const coordinationRoot = path.join(base, "coordination");
  const booksDirectory = path.join(shelfRoot, "books");
  const annotationsDirectory = path.join(shelfRoot, "annotations");
  await mkdir(booksDirectory, { recursive: true });
  await mkdir(annotationsDirectory, { recursive: true });
  await mkdir(coordinationRoot, { recursive: true });
  await writeFile(path.join(shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${shelfId}\n`, "utf8");
  await writeFile(
    path.join(shelfRoot, "library.json"),
    `${JSON.stringify({ type: "library", version: "0.1", name: "研究用本棚", booksPath: "books", annotationsPath: "annotations" }, null, 2)}\n`,
    "utf8"
  );
  return { base, shelfId, shelfRoot, coordinationRoot, booksDirectory, annotationsDirectory };
}

afterEach(async () => {
  while (created.length > 0) {
    const base = created.pop()!;
    await rm(base, { recursive: true, force: true });
  }
});

function request(fixture: Fixture, overrides: Partial<ShelfQuoteWriteRequest> = {}): ShelfQuoteWriteRequest {
  return {
    requestId: `req-${randomUUID()}`,
    shelfRoot: fixture.shelfRoot,
    expectedShelfId: fixture.shelfId,
    coordinationRoot: fixture.coordinationRoot,
    quote: "引用された本文。",
    url: "https://example.test/page",
    getDate: "202610301200",
    comment: "利用者のコメント",
    processLabel: "unit",
    ...overrides
  };
}

async function expectCoordinationError(promise: Promise<unknown>, code: string): Promise<ShelfWriteCoordinationError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ShelfWriteCoordinationError);
    const typed = error as ShelfWriteCoordinationError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`expected ${code}`);
}

async function readRecords(directory: string): Promise<Record<string, unknown>[]> {
  const output: Record<string, unknown>[] = [];
  for (const name of (await readdir(directory)).filter((value) => value.endsWith(".json")).sort()) {
    output.push(JSON.parse(await readFile(path.join(directory, name), "utf8")) as Record<string, unknown>);
  }
  return output;
}

function leasePath(fixture: Fixture): string {
  return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase(), "writer.lock");
}

describe("shelf write lease", () => {
  test("a second writer is refused while the lease is held and succeeds after release", async () => {
    const fixture = await createFixture("lease");
    const first = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      processLabel: "first"
    });
    await expectCoordinationError(
      acquireShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        processLabel: "second",
        acquireTimeoutMs: 150,
        pollIntervalMs: 20
      }),
      "shelf-write-busy"
    );
    await first.release();
    const second = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      processLabel: "second",
      acquireTimeoutMs: 1_000
    });
    await second.release();
  });

  test("a lease left by a dead process is evicted instead of blocking forever", async () => {
    const fixture = await createFixture("stale");
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    await writeFile(leasePath(fixture), `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token: randomUUID(),
      pid: 2_147_483_647,
      processLabel: "crashed",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now()
    })}\n`, "utf8");
    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      acquireTimeoutMs: 2_000
    });
    await lease.release();
  });

  test("a live PID with an expired heartbeat is treated as stale", async () => {
    const fixture = await createFixture("ttl");
    const fixedNow = 1_800_000_000_000;
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    await writeFile(leasePath(fixture), `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token: randomUUID(),
      pid: process.pid,
      processLabel: "reused-pid",
      acquiredAt: new Date(fixedNow - 600_000).toISOString(),
      heartbeatAt: fixedNow - 600_000
    })}\n`, "utf8");
    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      now: () => fixedNow,
      acquireTimeoutMs: 1_000
    });
    await lease.release();
  });

  test("releasing with a superseded token does not remove the new holder's lease", async () => {
    const fixture = await createFixture("release");
    const first = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId
    });
    const replacement = await readFile(leasePath(fixture), "utf8");
    const parsed = JSON.parse(replacement) as Record<string, unknown>;
    await writeFile(leasePath(fixture), `${JSON.stringify({ ...parsed, token: randomUUID() })}\n`, "utf8");
    await first.release();
    expect(JSON.parse(await readFile(leasePath(fixture), "utf8")).token).not.toBe(first.token);
  });
});

describe("shelf write layout", () => {
  test("rejects a Shelf whose marker identity differs from the configured identity", async () => {
    const fixture = await createFixture("identity");
    await expectCoordinationError(
      resolveShelfWriteLayout({
        shelfRoot: fixture.shelfRoot,
        expectedShelfId: randomUUID(),
        coordinationRoot: fixture.coordinationRoot
      }),
      "shelf-write-identity-mismatch"
    );
  });

  test("rejects a folder with no typed marker instead of adopting it", async () => {
    const fixture = await createFixture("naked");
    await rm(path.join(fixture.shelfRoot, "shelf.magi"));
    await expectCoordinationError(
      resolveShelfWriteLayout({
        shelfRoot: fixture.shelfRoot,
        expectedShelfId: fixture.shelfId,
        coordinationRoot: fixture.coordinationRoot
      }),
      "shelf-write-identity-unavailable"
    );
    await expect(readdir(fixture.shelfRoot)).resolves.not.toContain("shelf.magi");
  });

  test("rejects conflicting markers as a recovery state", async () => {
    const fixture = await createFixture("conflict");
    await writeFile(
      path.join(fixture.shelfRoot, "other.magi"),
      `version = 1\ntype = shelf\nid = ${randomUUID()}\n`,
      "utf8"
    );
    await expectCoordinationError(
      resolveShelfWriteLayout({
        shelfRoot: fixture.shelfRoot,
        expectedShelfId: fixture.shelfId,
        coordinationRoot: fixture.coordinationRoot
      }),
      "shelf-write-identity-conflict"
    );
  });

  test("rejects a coordination root that overlaps the Shelf", async () => {
    const fixture = await createFixture("overlap");
    await expectCoordinationError(
      resolveShelfWriteLayout({
        shelfRoot: fixture.shelfRoot,
        expectedShelfId: fixture.shelfId,
        coordinationRoot: path.join(fixture.shelfRoot, "coordination")
      }),
      "shelf-write-unsafe-path"
    );
  });
});

describe("desktop writer under the shared lease", () => {
  function approvedRecord(): Parameters<typeof materializeReviewerRecords>[1][number] {
    return {
      annotationId: "123e4567-e89b-42d3-a456-426614174000",
      reviewState: "APPROVED" as const,
      packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceKind: "book" as const,
      getDate: "202602011230",
      isbn13: "9780306406157",
      title: "日本語の書名",
      authors: ["著者名"],
      quote: "レビュー済みの引用",
      pageLabel: "12",
      comment: "Reviewer comment"
    };
  }

  test("the Desktop writer refuses to run while a Host-side process holds the lease", async () => {
    const fixture = await createFixture("desktop-locked");
    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      processLabel: "native-host"
    });
    try {
      await expectCoordinationError(
        materializeReviewerRecords(fixture.shelfRoot, [approvedRecord()], async () => ({ status: "not-found" }), {
          coordinationRoot: fixture.coordinationRoot,
          shelfId: fixture.shelfId,
          acquireTimeoutMs: 120
        }),
        "shelf-write-busy"
      );
      expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(0);
    } finally {
      await lease.release();
    }
  });

  test("the Desktop writer completes under the lease and releases it afterwards", async () => {
    const fixture = await createFixture("desktop-lease");
    const result = await materializeReviewerRecords(
      fixture.shelfRoot,
      [approvedRecord()],
      async () => ({ status: "not-found" }),
      { coordinationRoot: fixture.coordinationRoot, shelfId: fixture.shelfId, acquireTimeoutMs: 1_000 }
    );
    expect(result.materialized).toBe(1);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(1);
    // The lease is free again, so a Host-side writer can take it immediately.
    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      acquireTimeoutMs: 500
    });
    await lease.release();
  });
});

describe("collector quote commit", () => {
  test("writes Shelf v0.4 Book and Annotation and reports a durable receipt", async () => {
    const fixture = await createFixture("commit");
    const receipt = await commitShelfQuote(request(fixture));
    expect(receipt.state).toBe("committed");
    expect(receipt.bookReused).toBe(false);
    const books = await readRecords(fixture.booksDirectory);
    const annotations = await readRecords(fixture.annotationsDirectory);
    expect(books).toHaveLength(1);
    expect(annotations).toHaveLength(1);
    const book = parseShelfEntity("book", JSON.stringify(books[0]));
    expect(book.valid).toBe(true);
    const annotation = parseShelfEntity("annotation", JSON.stringify(annotations[0]));
    expect(annotation.valid).toBe(true);
    if (!book.valid || !annotation.valid) return;
    const shelfBook = book.value as ShelfBookV04;
    const shelfAnnotation = annotation.value as ShelfAnnotationV04;
    expect(shelfBook.version).toBe("0.4");
    expect(shelfBook.source.kind).toBe("website");
    expect(shelfBook.url).toBe("https://example.test/page");
    expect(shelfAnnotation.source.id).toBe(shelfBook.id);
    expect(shelfAnnotation.id).toBe(receipt.annotationId);
    expect(shelfAnnotation.quote).toBe("引用された本文。");
    expect(shelfAnnotation.comment).toBe("利用者のコメント");
    expect(shelfAnnotation.privateMemo).toBeUndefined();
    expect(shelfAnnotation.get.date).toBe("202610301200");
  });

  test("reuses an existing Book for the same URL and appends a second Annotation", async () => {
    const fixture = await createFixture("reuse");
    const first = await commitShelfQuote(request(fixture));
    const second = await commitShelfQuote(request(fixture, { quote: "二つ目の引用" }));
    expect(second.bookId).toBe(first.bookId);
    expect(second.bookReused).toBe(true);
    expect(second.annotationId).not.toBe(first.annotationId);
    expect(await readRecords(fixture.booksDirectory)).toHaveLength(1);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(2);
  });

  test("is idempotent for a repeated request ID and never rewrites the record", async () => {
    const fixture = await createFixture("idempotent");
    const requestId = `req-${randomUUID()}`;
    const first = await commitShelfQuote(request(fixture, { requestId }));
    const before = await readFile(path.join(fixture.annotationsDirectory, `${first.annotationId.replace(":", "-")}.json`), "utf8");
    const second = await commitShelfQuote(request(fixture, { requestId }));
    const after = await readFile(path.join(fixture.annotationsDirectory, `${first.annotationId.replace(":", "-")}.json`), "utf8");
    expect(second.state).toBe("already-committed");
    expect(second.annotationId).toBe(first.annotationId);
    expect(second.recordedAt).toBe(first.recordedAt);
    expect(after).toBe(before);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(1);
  });

  test("refuses a request ID reused with different content", async () => {
    const fixture = await createFixture("mismatch");
    const requestId = `req-${randomUUID()}`;
    await commitShelfQuote(request(fixture, { requestId }));
    await expectCoordinationError(
      commitShelfQuote(request(fixture, { requestId, quote: "異なる引用" })),
      "shelf-write-request-mismatch"
    );
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(1);
  });

  test("carries the comment in privateMemo when the caller selects that field", async () => {
    const fixture = await createFixture("private-memo");
    await commitShelfQuote(request(fixture, { commentField: "privateMemo" }));
    const annotations = await readRecords(fixture.annotationsDirectory);
    expect(annotations[0]!.privateMemo).toBe("利用者のコメント");
    expect(annotations[0]!.comment).toBeUndefined();
  });

  test("omits the comment field entirely when no comment is supplied", async () => {
    const fixture = await createFixture("no-comment");
    await commitShelfQuote(request(fixture, { comment: undefined }));
    const annotations = await readRecords(fixture.annotationsDirectory);
    expect(annotations[0]!.comment).toBeUndefined();
    expect(annotations[0]!.privateMemo).toBeUndefined();
  });

  test("rejects an invalid request before touching the Shelf", async () => {
    const fixture = await createFixture("invalid");
    await expectCoordinationError(commitShelfQuote(request(fixture, { quote: "   " })), "shelf-write-invalid-request");
    await expectCoordinationError(commitShelfQuote(request(fixture, { url: "file:///etc/passwd" })), "shelf-write-invalid-request");
    await expectCoordinationError(commitShelfQuote(request(fixture, { getDate: "2026-10-30" })), "shelf-write-invalid-request");
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId: "short" })), "shelf-write-invalid-request");
    expect(await readRecords(fixture.booksDirectory)).toHaveLength(0);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(0);
  });

  test("an interrupted write stays staged and is completed by the same request ID", async () => {
    const fixture = await createFixture("interrupted");
    const requestId = `req-${randomUUID()}`;
    await expect(commitShelfQuote(request(fixture, {
      requestId,
      faults: { beforeAnnotationPublish: () => { throw new Error("simulated crash"); } }
    }))).rejects.toThrow("simulated crash");
    const staged = await inspectShelfWriteJournal({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.record.state).toBe("staged");
    expect(staged[0]!.annotationPresent).toBe(false);
    expect(staged[0]!.bookPresent).toBe(true);
    const completed = await commitShelfQuote(request(fixture, { requestId }));
    expect(completed.state).toBe("committed");
    const after = await inspectShelfWriteJournal({
      shelfRoot: fixture.shelfRoot,
      expectedShelfId: fixture.shelfId,
      coordinationRoot: fixture.coordinationRoot
    });
    expect(after[0]!.record.state).toBe("committed");
    expect(after[0]!.matchesDisk).toBe(true);
  });
});
