import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLECTOR_ALLOWED_ORIGIN,
  COLLECTOR_HOST_NAME,
  collectorCallerOrigin,
  handleCollectorProductRequest,
  isAllowedCollectorOrigin,
  type CollectorProductHostDependencies,
} from "./collector-native-host-product";
import { readCollectorShelfConfiguration } from "./collector-shelf-configuration";
import { commitShelfQuoteWithNativeLock } from "./shelf-native-write-lock";
import { ShelfWriteCoordinationError } from "./shelf-write-coordination";
import { COLLECTOR_GET_DATE_PATTERN } from "./collector-native-host-core";
import { acquireShelfMutex, nativeShelfMutexAvailable, ShelfNativeMutexError } from "./shelf-native-mutex";
import {
  FIXTURE_SHELF_ID,
  OTHER_SHELF_ID,
  createCollectorFixture,
  fakeSafeInspector,
  type CollectorFixture,
} from "./collector-host-fixture.test-helper";

const protocol = "maginalia.collector.experimental.v1";
const origin = COLLECTOR_ALLOWED_ORIGIN;
const requestId = "00000000-0000-4000-8000-0000000000a1";
const save = {
  protocol, operation: "save_web_quote", requestId,
  quote: "Selected test quotation", url: "https://example.com/", getDate: "202611121200", title: "Sample Page",
};

let fixture: CollectorFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

function dependencies(current: CollectorFixture, writeQuote: CollectorProductHostDependencies["writeQuote"] = commitShelfQuoteWithNativeLock): CollectorProductHostDependencies {
  return {
    readConfiguration: () => readCollectorShelfConfiguration({
      resolveLocalAppDataPath: () => current.localAppData,
      inspectPathSecurity: fakeSafeInspector,
    }),
    writeQuote,
  };
}

const neverWrite: CollectorProductHostDependencies["writeQuote"] = async () => { throw new Error("writer must not run"); };

describe("production Host identity", () => {
  it("fixes the host name and compares Chrome's caller origin exactly", () => {
    expect(COLLECTOR_HOST_NAME).toBe("org.maginalia.collector");
    expect(COLLECTOR_ALLOWED_ORIGIN).toBe("chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/");
    expect(isAllowedCollectorOrigin(COLLECTOR_ALLOWED_ORIGIN)).toBe(true);
    for (const value of [undefined, "", "chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf", "CHROME-EXTENSION://blgmoddncpknfnikdfnjelmdmphfgknf/",
      `chrome-extension://${"a".repeat(32)}/`, `${COLLECTOR_ALLOWED_ORIGIN} `, `${COLLECTOR_ALLOWED_ORIGIN}x`]) {
      expect(isAllowedCollectorOrigin(value)).toBe(false);
    }
    expect(collectorCallerOrigin(["node", "host.js", origin, "--parent-window=0"], 2)).toBe(origin);
  });

  it("rejects a wrong origin before reading configuration or writing", async () => {
    let reads = 0;
    const deps: CollectorProductHostDependencies = { readConfiguration: async () => { reads += 1; return { kind: "error", code: "shelf_unconfigured" }; }, writeQuote: neverWrite };
    for (const operation of ["health", "configured_shelf"]) {
      expect(await handleCollectorProductRequest({ protocol, operation }, `chrome-extension://${"b".repeat(32)}/`, deps))
        .toEqual({ protocol, ok: false, error: "host_configuration_or_origin_invalid" });
    }
    expect(await handleCollectorProductRequest(save, undefined, deps)).toMatchObject({ error: "host_configuration_or_origin_invalid" });
    expect(reads).toBe(0);
  });
});

describe("production Host fail-closed configuration", () => {
  it("advertises save only while the binding is fully valid", async () => {
    fixture = await createCollectorFixture();
    const deps = dependencies(fixture, neverWrite);
    expect(await handleCollectorProductRequest({ protocol, operation: "health" }, origin, deps))
      .toEqual({ protocol, ok: true, experimental: true, operations: ["health", "configured_shelf"], writesEnabled: false });
    expect(await handleCollectorProductRequest({ protocol, operation: "configured_shelf" }, origin, deps))
      .toEqual({ protocol, ok: false, error: "shelf_unconfigured" });
    expect(await handleCollectorProductRequest(save, origin, deps)).toEqual({ protocol, ok: false, error: "shelf_unconfigured" });

    await fixture.writeBinding();
    expect(await handleCollectorProductRequest({ protocol, operation: "health" }, origin, deps))
      .toEqual({ protocol, ok: true, experimental: true, operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true });
    expect(await handleCollectorProductRequest({ protocol, operation: "configured_shelf" }, origin, deps))
      .toEqual({ protocol, ok: true, shelf: { id: FIXTURE_SHELF_ID, name: "研究棚", type: "private", writesEnabled: true } });
  });

  it("returns the contract code for each invalid state and never calls the writer", async () => {
    fixture = await createCollectorFixture();
    const current = fixture;
    const deps = dependencies(current, neverWrite);
    const saveError = async () => (await handleCollectorProductRequest(save, origin, deps)).error;

    await current.writeBinding();
    await writeFile(current.storage.bindingPath, "{}");
    expect(await saveError()).toBe("configuration_unavailable");
    await current.writeBinding({ generation: 1 }).catch(() => undefined);
    await writeFile(current.storage.bindingPath, "");
    expect(await saveError()).toBe("configuration_unavailable");
    const { unlink } = await import("node:fs/promises");
    await unlink(current.storage.bindingPath);

    await current.writeBinding({ shelfId: OTHER_SHELF_ID });
    expect(await saveError()).toBe("shelf_identity_mismatch");
    await current.writeBinding();
    await unlink(path.join(current.shelfRoot, "名前変更.magi"));
    expect(await saveError()).toBe("shelf_identity_unavailable");
    await writeFile(path.join(current.shelfRoot, "名前変更.magi"), `version = 1\ntype = shelf\nid = ${FIXTURE_SHELF_ID}\n`);
    await writeFile(path.join(current.shelfRoot, "library.json"), "{}");
    expect(await saveError()).toBe("shelf_unavailable");

    const aclDeps: CollectorProductHostDependencies = {
      readConfiguration: () => readCollectorShelfConfiguration({ resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: () => ({ exists: true, isDirectory: true, isReparsePoint: true, ownerSid: "S-1-5-18", currentUserSid: "S-1-5-18", daclPresent: true, aces: [] }) }),
      writeQuote: neverWrite,
    };
    expect((await handleCollectorProductRequest(save, origin, aclDeps)).error).toBe("configuration_unavailable");
  });

  it("validates the request before configuration and rejects extra fields", async () => {
    fixture = await createCollectorFixture();
    const deps = dependencies(fixture, neverWrite);
    for (const value of [null, [], { protocol, operation: "health", extra: 1 }, { protocol: "v2", operation: "health" },
      { ...save, shelfRoot: "C:\\" }, { ...save, quote: " " }, { ...save, url: "file:///C:/x" }, { ...save, requestId: "x" }]) {
      expect(await handleCollectorProductRequest(value, origin, deps)).toMatchObject({ ok: false, error: "invalid_request" });
    }
    expect(await handleCollectorProductRequest({ protocol, operation: "save" }, origin, deps)).toMatchObject({ error: "unsupported_operation" });
  });
});

describe("production Host request validation and error mapping", () => {
  it("rejects getDate values the Shelf writer would reject, before configuration or writing", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding();
    const deps = dependencies(fixture, neverWrite);
    for (const getDate of ["202613011200", "202600011200", "202611001200", "202611321200", "202611122400", "202611121260", "20261112120", "2026111212000", "2026-11-12", ""]) {
      expect(await handleCollectorProductRequest({ ...save, getDate }, origin, deps)).toEqual({ protocol, ok: false, error: "invalid_request" });
    }
    for (const getDate of ["202601010000", "202612312359", "202611121200"]) {
      expect(COLLECTOR_GET_DATE_PATTERN.test(getDate)).toBe(true);
    }
  });

  it("maps permanent request errors to invalid_request and keeps other failures retryable", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding();
    for (const code of ["shelf-write-invalid-request", "shelf-write-request-mismatch"] as const) {
      const response = await handleCollectorProductRequest(save, origin, dependencies(fixture, async () => {
        throw new ShelfWriteCoordinationError(code, "private detail", `${fixture?.temp}`);
      }));
      expect(response).toEqual({ protocol, ok: false, error: "invalid_request" });
      expect(JSON.stringify(response)).not.toContain(fixture.temp);
    }
    for (const code of ["shelf-write-journal-unavailable", "shelf-write-recovery-state-unavailable", "shelf-write-book-conflict", "shelf-write-receipt-missing"] as const) {
      const response = await handleCollectorProductRequest(save, origin, dependencies(fixture, async () => {
        throw new ShelfWriteCoordinationError(code, "private detail");
      }));
      expect(response).toEqual({ protocol, ok: false, error: "save_failed" });
    }
  });
});

describe("production Host writes through the common native-lock writer", () => {
  it("passes only the validated request, maps busy and failures, and checks the receipt", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding();
    let seen: Parameters<CollectorProductHostDependencies["writeQuote"]>[0] | undefined;
    const receipt = {
      version: 1 as const, state: "committed" as const, requestId, shelfId: FIXTURE_SHELF_ID,
      bookId: "book:01JBF5GD3RT8YCKM93Q5D9X0EX" as const, annotationId: "ann:01JBF5GD3RT8YCKM93Q5D9X0EY" as const, bookReused: false,
      annotationDigest: `sha256:${"a".repeat(64)}`, requestDigest: `sha256:${"b".repeat(64)}`, recordedAt: "2026-11-12T03:00:00.000Z",
    };
    const ok = await handleCollectorProductRequest(save, origin, dependencies(fixture, async (request) => { seen = request; return receipt; }));
    expect(ok).toEqual({ protocol, ok: true, receipt });
    expect(seen).toEqual({
      requestId, shelfRoot: fixture.shelfRoot, expectedShelfId: FIXTURE_SHELF_ID, coordinationRoot: fixture.storage.coordinationRoot,
      quote: "Selected test quotation", url: "https://example.com/", getDate: "202611121200", title: "Sample Page",
      processLabel: "collector-native-host",
    });

    const busy = await handleCollectorProductRequest(save, origin, dependencies(fixture, async () => {
      throw new ShelfNativeMutexError("shelf-write-busy", "Another process holds the Shelf write lock.", "Local\\name");
    }));
    expect(busy).toEqual({ protocol, ok: false, error: "shelf_write_busy" });
    const failed = await handleCollectorProductRequest(save, origin, dependencies(fixture, async () => { throw new Error(`private ${fixture?.temp}`); }));
    expect(failed).toEqual({ protocol, ok: false, error: "save_failed" });
    expect(JSON.stringify(failed)).not.toContain(fixture.temp);
    const staged = await handleCollectorProductRequest(save, origin, dependencies(fixture, async () => ({ ...receipt, state: "staged" as never })));
    expect(staged).toEqual({ protocol, ok: false, error: "save_failed" });
    const otherShelf = await handleCollectorProductRequest(save, origin, dependencies(fixture, async () => ({ ...receipt, shelfId: OTHER_SHELF_ID })));
    expect(otherShelf).toEqual({ protocol, ok: false, error: "save_failed" });
  });

  it.skipIf(!(process.platform === "win32" && nativeShelfMutexAvailable()))(
    "commits once, replays idempotently, clears the recovery marker and reports busy",
    async () => {
      fixture = await createCollectorFixture();
      await fixture.writeBinding();
      const deps = dependencies(fixture);
      const first = await handleCollectorProductRequest(save, origin, deps);
      expect(first).toMatchObject({ ok: true, receipt: { state: "committed", requestId, shelfId: FIXTURE_SHELF_ID } });
      const again = await handleCollectorProductRequest(save, origin, deps);
      expect(again).toMatchObject({ ok: true, receipt: { state: "already-committed", requestId } });
      expect((again.receipt as { annotationId: string }).annotationId).toBe((first.receipt as { annotationId: string }).annotationId);
      expect(await readdir(path.join(fixture.shelfRoot, "books"))).toHaveLength(1);
      const annotations = await readdir(path.join(fixture.shelfRoot, "annotations"));
      expect(annotations).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(fixture.shelfRoot, "annotations", annotations[0]!), "utf8"))).toMatchObject({ quote: "Selected test quotation", version: "0.4" });
      const coordination = path.join(fixture.storage.coordinationRoot, "shelves", FIXTURE_SHELF_ID);
      expect(await readdir(coordination)).not.toContain("writer-recovery.json");
      expect(JSON.stringify([first, again])).not.toContain(fixture.temp);

      // The same process holding the Shelf mutex makes the writer report busy.
      const lease = await acquireShelfMutex({ shelfId: FIXTURE_SHELF_ID, acquireTimeoutMs: 1_000 });
      try {
        const busy = await handleCollectorProductRequest({ ...save, requestId: "00000000-0000-4000-8000-0000000000a2" }, origin, deps);
        expect(busy).toEqual({ protocol, ok: false, error: "shelf_write_busy" });
      } finally {
        lease.release();
      }
      expect(await readdir(path.join(fixture.shelfRoot, "annotations"))).toHaveLength(1);
    },
  );
});
