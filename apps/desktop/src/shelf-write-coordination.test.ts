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
  reclaimStaleShelfWriteLease,
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

  test("a lease left by a dead process is reported as stale and never taken over", async () => {
    const fixture = await createFixture("stale");
    const token = randomUUID();
    const stale = `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token,
      pid: 2_147_483_647,
      processLabel: "crashed",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now()
    })}\n`;
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    await writeFile(leasePath(fixture), stale, "utf8");

    const error = await expectCoordinationError(
      acquireShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        acquireTimeoutMs: 2_000
      }),
      "shelf-write-lease-stale"
    );
    // The recovery context identifies exactly which lock is stuck.
    expect(error.context?.["token"]).toBe(token);
    expect(error.context?.["pid"]).toBe(2_147_483_647);
    // Nothing was moved, rewritten or left behind.
    expect(await readFile(leasePath(fixture), "utf8")).toBe(stale);
    expect((await readdir(path.dirname(leasePath(fixture)))).sort()).toEqual(["writer.lock"]);
  });

  test("explicit recovery reclaims a dead holder's lease and the next writer proceeds", async () => {
    const fixture = await createFixture("recover");
    const token = randomUUID();
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    await writeFile(leasePath(fixture), `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token,
      pid: 2_147_483_647,
      processLabel: "crashed",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now()
    })}\n`, "utf8");

    const result = await reclaimStaleShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      expectedToken: token
    });
    expect(result.reclaimed).toBe(true);
    expect(result.holder?.token).toBe(token);
    expect(result.holder?.pid).toBe(2_147_483_647);
    // No lock and no debris: the retire quarantine is cleaned up.
    expect(await readdir(path.dirname(leasePath(fixture)))).toEqual([]);

    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      acquireTimeoutMs: 1_000
    });
    await lease.release();
    expect(await readdir(path.dirname(leasePath(fixture)))).toEqual([]);
  });

  test("explicit recovery refuses a lock the caller did not observe", async () => {
    const fixture = await createFixture("recover-token");
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    const stale = `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token: randomUUID(),
      pid: 2_147_483_647,
      processLabel: "crashed",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now()
    })}\n`;
    await writeFile(leasePath(fixture), stale, "utf8");
    await expectCoordinationError(
      reclaimStaleShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        expectedToken: randomUUID()
      }),
      "shelf-write-lease-uncertain"
    );
    expect(await readFile(leasePath(fixture), "utf8")).toBe(stale);
  });

  test("explicit recovery never displaces a live holder", async () => {
    const fixture = await createFixture("recover-live");
    const fixedNow = 1_800_000_000_000;
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    const token = randomUUID();
    const live = `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token,
      pid: process.pid,
      processLabel: "slow-but-alive",
      acquiredAt: new Date(fixedNow - 600_000).toISOString(),
      heartbeatAt: fixedNow - 600_000
    })}\n`;
    await writeFile(leasePath(fixture), live, "utf8");

    // A live PID keeps its lease even with an expired heartbeat, both for normal
    // acquisition and for explicit recovery.
    await expectCoordinationError(
      acquireShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        now: () => fixedNow,
        acquireTimeoutMs: 200,
        pollIntervalMs: 20
      }),
      "shelf-write-lease-uncertain"
    );
    await expectCoordinationError(
      reclaimStaleShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        expectedToken: token
      }),
      "shelf-write-lease-uncertain"
    );
    // The holder keeps its lease: the file is byte-identical and still present.
    expect(await readFile(leasePath(fixture), "utf8")).toBe(live);
  });

  test("a lease is never taken over automatically, even for a dead holder", async () => {
    const fixture = await createFixture("no-auto-takeover");
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
    // The whole Collector write path fails closed before touching the Shelf.
    await expectCoordinationError(
      commitShelfQuote(request(fixture)),
      "shelf-write-lease-stale"
    );
    expect(await readRecords(fixture.booksDirectory)).toHaveLength(0);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(0);
    // Repeated attempts stay fail-closed instead of escalating to a takeover.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expectCoordinationError(commitShelfQuote(request(fixture)), "shelf-write-lease-stale");
    }
  });

  test("explicit recovery cannot remove a lock that another writer acquired after the check", async () => {
    const fixture = await createFixture("recover-race");
    const directory = path.dirname(leasePath(fixture));
    await mkdir(directory, { recursive: true });
    const deadToken = randomUUID();
    await writeFile(leasePath(fixture), `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token: deadToken,
      pid: 2_147_483_647,
      processLabel: "crashed",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now()
    })}\n`, "utf8");

    // Deterministic interleaving: after recovery validated the dead holder and the
    // token, another writer reclaims the lock and takes a fresh, live lease.
    let winnerToken: string | undefined;
    let winnerText = "";
    const onBeforeRetireRename = async (): Promise<void> => {
      await rm(leasePath(fixture), { force: true });
      winnerToken = randomUUID();
      winnerText = `${JSON.stringify({
        version: 1,
        shelfId: fixture.shelfId,
        token: winnerToken,
        pid: process.pid,
        processLabel: "winner",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: Date.now()
      })}\n`;
      await writeFile(leasePath(fixture), winnerText, "utf8");
    };

    await expectCoordinationError(
      reclaimStaleShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        expectedToken: deadToken,
        onBeforeRetireRename
      }),
      "shelf-write-lease-uncertain"
    );

    // The winner's lease is byte-identical and still valid for its holder.
    expect(await readFile(leasePath(fixture), "utf8")).toBe(winnerText);
    expect((JSON.parse(await readFile(leasePath(fixture), "utf8")) as Record<string, unknown>).token).toBe(winnerToken);
    expect((await readdir(directory)).sort()).toEqual(["writer.lock"]);
  });

  test("a malformed lock file fails closed for acquisition and for recovery", async () => {
    const fixture = await createFixture("malformed-lock");
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    const malformed = "{\"version\": 1, \"shelfId\": \"";
    await writeFile(leasePath(fixture), malformed, "utf8");
    await expectCoordinationError(
      acquireShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        acquireTimeoutMs: 150,
        pollIntervalMs: 20
      }),
      "shelf-write-lease-uncertain"
    );
    await expectCoordinationError(
      reclaimStaleShelfWriteLease({
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        expectedToken: randomUUID()
      }),
      "shelf-write-lease-uncertain"
    );
    expect(await readFile(leasePath(fixture), "utf8")).toBe(malformed);
  });

  test("release removes its own lock and nothing else", async () => {
    const fixture = await createFixture("release-own");
    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId
    });
    await lease.release();
    expect(await readdir(path.dirname(leasePath(fixture)))).toEqual([]);
  });

  test("release cannot delete a newer holder's lock", async () => {
    const fixture = await createFixture("release-race");
    // Simulate the replacement at the only instant it can appear without the first
    // holder's cooperation: after this holder's file was moved to its private retire
    // name and before that file's token is verified.
    let replacementText = "";
    const lease = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      releaseFaults: {
        beforeRetireVerify: async () => {
          replacementText = `${JSON.stringify({
            version: 1,
            shelfId: fixture.shelfId,
            token: randomUUID(),
            pid: process.pid,
            processLabel: "replacement",
            acquiredAt: new Date().toISOString(),
            heartbeatAt: Date.now()
          })}\n`;
          await writeFile(leasePath(fixture), replacementText, "utf8");
        }
      }
    });
    await lease.release();
    // The first holder retired only its own file; the replacement is untouched.
    expect(await readFile(leasePath(fixture), "utf8")).toBe(replacementText);
    expect((await readdir(path.dirname(leasePath(fixture)))).sort()).toEqual(["writer.lock"]);
  });

  test("releasing with a superseded token leaves the other holder's lock intact", async () => {
    const fixture = await createFixture("release");
    const first = await acquireShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId
    });
    const parsed = JSON.parse(await readFile(leasePath(fixture), "utf8")) as Record<string, unknown>;
    const replacement = `${JSON.stringify({ ...parsed, token: randomUUID() })}\n`;
    await writeFile(leasePath(fixture), replacement, "utf8");
    await first.release();
    // Byte-identical: the foreign lock was restored, not rewritten.
    expect(await readFile(leasePath(fixture), "utf8")).toBe(replacement);
    expect((await readdir(path.dirname(leasePath(fixture)))).sort()).toEqual(["writer.lock"]);
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

  test("an overlap rejection leaves the Shelf completely unmodified", async () => {
    const fixture = await createFixture("overlap-side-effects");
    // Remove the record directories so any premature `mkdir` would be visible, and
    // so the test can also prove the layout never got as far as re-creating them.
    await rm(fixture.booksDirectory, { recursive: true, force: true });
    await rm(fixture.annotationsDirectory, { recursive: true, force: true });
    const before = (await readdir(fixture.shelfRoot)).sort();

    for (const coordinationRoot of [
      path.join(fixture.shelfRoot, "coordination"),
      path.join(fixture.booksDirectory, "coordination"),
      fixture.shelfRoot
    ]) {
      await expectCoordinationError(
        resolveShelfWriteLayout({
          shelfRoot: fixture.shelfRoot,
          expectedShelfId: fixture.shelfId,
          coordinationRoot
        }),
        "shelf-write-unsafe-path"
      );
    }

    expect((await readdir(fixture.shelfRoot)).sort()).toEqual(before);
    expect(before).not.toContain("coordination");
    expect(before).not.toContain("books");
    expect(before).not.toContain("annotations");
    await expect(readdir(path.join(fixture.shelfRoot, "coordination"))).rejects.toThrow();
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

  test("the Desktop writer fails closed under a crashed holder's stale lease", async () => {
    const fixture = await createFixture("desktop-stale");
    const token = randomUUID();
    await mkdir(path.dirname(leasePath(fixture)), { recursive: true });
    await writeFile(leasePath(fixture), `${JSON.stringify({
      version: 1,
      shelfId: fixture.shelfId,
      token,
      pid: 2_147_483_647,
      processLabel: "crashed-host",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: Date.now()
    })}\n`, "utf8");

    // No automatic takeover, no partial write: the writer reports the stale lease
    // and stops before touching Shelf content.
    const error = await expectCoordinationError(
      materializeReviewerRecords(fixture.shelfRoot, [approvedRecord()], async () => ({ status: "not-found" }), {
        coordinationRoot: fixture.coordinationRoot,
        shelfId: fixture.shelfId,
        acquireTimeoutMs: 500
      }),
      "shelf-write-lease-stale"
    );
    expect(error.context?.["token"]).toBe(token);
    expect(await readRecords(fixture.booksDirectory)).toHaveLength(0);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(0);

    // Explicit recovery is what unblocks the writer.
    const reclaimed = await reclaimStaleShelfWriteLease({
      coordinationRoot: fixture.coordinationRoot,
      shelfId: fixture.shelfId,
      expectedToken: String(error.context?.["token"])
    });
    expect(reclaimed.reclaimed).toBe(true);
    const result = await materializeReviewerRecords(
      fixture.shelfRoot,
      [approvedRecord()],
      async () => ({ status: "not-found" }),
      { coordinationRoot: fixture.coordinationRoot, shelfId: fixture.shelfId, acquireTimeoutMs: 1_000 }
    );
    expect(result.materialized).toBe(1);
    expect(await readRecords(fixture.annotationsDirectory)).toHaveLength(1);
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

  test("refuses a request ID resent with a different comment field", async () => {
    const fixture = await createFixture("comment-field-mismatch");
    const requestId = `req-${randomUUID()}`;
    const first = await commitShelfQuote(request(fixture, { requestId, commentField: "comment" }));
    await expectCoordinationError(
      commitShelfQuote(request(fixture, { requestId, commentField: "privateMemo" })),
      "shelf-write-request-mismatch"
    );
    const annotations = await readRecords(fixture.annotationsDirectory);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.comment).toBe("利用者のコメント");
    expect(annotations[0]!.privateMemo).toBeUndefined();
    expect(annotations[0]!.id).toBe(first.annotationId);
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

describe("shelf write journal validation", () => {
  function journalDirectory(fixture: Fixture): string {
    return path.join(fixture.coordinationRoot, "shelves", fixture.shelfId.toLowerCase(), "requests");
  }

  async function readJournal(fixture: Fixture, requestId: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(path.join(journalDirectory(fixture), `${requestId}.json`), "utf8")
    ) as Record<string, unknown>;
  }

  async function writeJournal(fixture: Fixture, requestId: string, value: Record<string, unknown>): Promise<void> {
    await writeFile(path.join(journalDirectory(fixture), `${requestId}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async function committedFixture(label: string): Promise<{ fixture: Fixture; requestId: string; journal: Record<string, unknown> }> {
    const fixture = await createFixture(label);
    const requestId = `req-${randomUUID()}`;
    await commitShelfQuote(request(fixture, { requestId }));
    return { fixture, requestId, journal: await readJournal(fixture, requestId) };
  }

  test("rejects a record that belongs to a different Shelf", async () => {
    const { fixture, requestId, journal } = await committedFixture("journal-shelf");
    await writeJournal(fixture, requestId, { ...journal, shelfId: randomUUID() });
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-journal-invalid");
  });

  test("rejects a record whose request ID does not match its file name", async () => {
    const { fixture, requestId, journal } = await committedFixture("journal-name");
    await writeJournal(fixture, requestId, { ...journal, requestId: `req-${randomUUID()}` });
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-journal-invalid");
  });

  test("rejects an Annotation ID that would escape the Annotation directory", async () => {
    const { fixture, requestId, journal } = await committedFixture("journal-traversal");
    await writeJournal(fixture, requestId, { ...journal, annotationId: "../../outside" });
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-journal-invalid");
    // Nothing was read or written through the injected path.
    await expect(readFile(path.join(fixture.base, "outside.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(fixture.shelfRoot, "outside.json"), "utf8")).rejects.toThrow();
  });

  test("rejects a malformed Book ID, digest, timestamp, or unknown field", async () => {
    for (const patch of [
      { bookId: "book:../../outside" },
      { requestDigest: "sha256:not-hex" },
      { annotationDigest: "0123" },
      { stagedAt: "2026-10-30 12:00" },
      { unexpected: true },
      { writer: { pid: -1, process: "x" } }
    ]) {
      const { fixture, requestId, journal } = await committedFixture("journal-field");
      await writeJournal(fixture, requestId, { ...journal, ...patch });
      await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-journal-invalid");
    }
  });

  test("rejects an internally inconsistent state", async () => {
    const { fixture, requestId, journal } = await committedFixture("journal-state");
    const { committedAt: _committedAt, ...withoutCommitTime } = journal;
    await writeJournal(fixture, requestId, withoutCommitTime);
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-journal-invalid");

    const staged = await committedFixture("journal-state-staged");
    await writeJournal(staged.fixture, staged.requestId, {
      ...staged.journal,
      state: "staged",
      abortedReason: "not-applicable"
    });
    await expectCoordinationError(
      commitShelfQuote(request(staged.fixture, { requestId: staged.requestId })),
      "shelf-write-journal-invalid"
    );
  });

  test("rejects a record that is not valid JSON instead of treating it as absent", async () => {
    const { fixture, requestId } = await committedFixture("journal-json");
    await writeFile(path.join(journalDirectory(fixture), `${requestId}.json`), "{ \"version\": 1, ", "utf8");
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-journal-invalid");
    // The truncated record must never be reported as a saved or completed request.
    await expectCoordinationError(
      inspectShelfWriteJournal({
        shelfRoot: fixture.shelfRoot,
        expectedShelfId: fixture.shelfId,
        coordinationRoot: fixture.coordinationRoot
      }),
      "shelf-write-journal-invalid"
    );
  });

  test("a committed record whose Book is missing is not reported as already committed", async () => {
    const { fixture, requestId, journal } = await committedFixture("journal-book-missing");
    await rm(path.join(fixture.booksDirectory, `${String(journal.bookId).replace(":", "-")}.json`));
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-receipt-missing");
  });

  test("a committed record whose Annotation is missing is not reported as already committed", async () => {
    const { fixture, requestId, journal } = await committedFixture("journal-annotation-missing");
    await rm(path.join(fixture.annotationsDirectory, `${String(journal.annotationId).replace(":", "-")}.json`));
    await expectCoordinationError(commitShelfQuote(request(fixture, { requestId })), "shelf-write-receipt-missing");
  });
});
