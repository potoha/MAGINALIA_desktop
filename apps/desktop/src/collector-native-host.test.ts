import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExperimentalFrameDecoder, handleExperimentalRequest, parseExperimentalFrame } from "./collector-native-host";
import type { ShelfQuoteWriteReceipt, ShelfQuoteWriteRequest } from "./shelf-write-coordination";

const protocol = "maginalia.collector.experimental.v1";
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

describe("experimental Native Messaging framing", () => {
  it("parses split and concatenated frames, retaining partial input", () => {
    const decoder = new ExperimentalFrameDecoder();
    const data = Buffer.concat([frame('{"a":1}'), frame('{"b":2}')]);
    expect([...decoder.push(data.subarray(0, 2))]).toEqual([]);
    expect(decoder.hasPartialFrame()).toBe(true);
    expect([...decoder.push(data.subarray(2))].map(parseExperimentalFrame)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decoder.hasPartialFrame()).toBe(false);
  });
  it("rejects invalid lengths, JSON, and UTF-8", () => {
    for (const size of [0, 65537, 0xffffffff]) {
      const header = Buffer.alloc(4); header.writeUInt32LE(size);
      expect(() => [...new ExperimentalFrameDecoder().push(header)]).toThrow("invalid_frame_length");
    }
    expect(() => parseExperimentalFrame(Buffer.from([0xff]))).toThrow();
    expect(() => parseExperimentalFrame(Buffer.from("{"))).toThrow();
  });
});

describe("experimental request validation", () => {
  it("requires explicit exact origin, protocol, fields and known operation", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-unit-"));
    try {
      const file = path.join(temp, "descriptor.json");
      const origin = `chrome-extension://${"a".repeat(32)}/`;
      await writeFile(file, JSON.stringify({ experimental: true, shelfLocationPath: path.join(temp, "location.yml"), expectedShelfId: "750e8400-e29b-41d4-a716-446655440000", allowedOrigin: origin }));
      expect(await handleExperimentalRequest({ protocol, operation: "health" }, file, origin)).toMatchObject({ ok: true, writesEnabled: false });
      expect(await handleExperimentalRequest({ protocol, operation: "health" }, file, "wrong")).toMatchObject({ error: "host_configuration_or_origin_invalid" });
      for (const value of [null, [], { protocol, operation: "health", extra: 1 }, { protocol: "v2", operation: "health" }]) {
        expect(await handleExperimentalRequest(value, file, origin)).toMatchObject({ error: "invalid_request" });
      }
      expect(await handleExperimentalRequest({ protocol, operation: "save" }, file, origin)).toMatchObject({ error: "unsupported_operation" });
      await writeFile(path.join(temp, "location.yml"), "x".repeat(65537));
      expect(await handleExperimentalRequest({ protocol, operation: "configured_shelf" }, file, origin)).toMatchObject({ error: "configuration_unavailable" });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("keeps save disabled unless both the test-only descriptor and process gate are present", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-readonly-"));
    try {
      const file = path.join(temp, "descriptor.json");
      const origin = `chrome-extension://${"a".repeat(32)}/`;
      const shelfId = "750e8400-e29b-41d4-a716-446655440000";
      await writeFile(file, JSON.stringify({ experimental: true, shelfLocationPath: path.join(temp, "location.yml"), expectedShelfId: shelfId, allowedOrigin: origin }));
      const request = { protocol, operation: "save_web_quote", requestId: "00000000-0000-4000-8000-000000000001", quote: "Selected test quotation", url: "https://example.com/", getDate: "202611031200" };
      const writer = async () => { throw new Error("writer must not run"); };

      expect(await handleExperimentalRequest({ protocol, operation: "health" }, file, origin, { MAGINALIA_COLLECTOR_TEST_ONLY: "1" }))
        .toMatchObject({ ok: true, operations: ["health", "configured_shelf"], writesEnabled: false });
      expect(await handleExperimentalRequest(request, file, origin, { MAGINALIA_COLLECTOR_TEST_ONLY: "1" }, writer))
        .toMatchObject({ ok: false, error: "unsupported_operation" });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("writes only through the explicit test profile and returns the common writer receipt", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-test-write-"));
    try {
      const shelfRoot = path.join(temp, "configured-shelf");
      const coordinationRoot = path.join(temp, "coordination");
      const shelfLocationPath = path.join(temp, "shelf_location.yml");
      const descriptorPath = path.join(temp, "descriptor.json");
      const origin = `chrome-extension://${"b".repeat(32)}/`;
      const shelfId = "750e8400-e29b-41d4-a716-446655440000";
      await mkdir(path.join(shelfRoot, "books"), { recursive: true });
      await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
      await writeFile(path.join(shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${shelfId}\n`);
      await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({ type: "library", version: "0.1", name: "Test Private Shelf", booksPath: "books", annotationsPath: "annotations" }));
      await writeFile(shelfLocationPath, [
        "version: 1", "private_shelf:", `  registry: ${JSON.stringify(shelfRoot)}`, "  urls:", "    github: null", "    homepage: null", "    other: []",
        "public_shelf:", "  registry: null", "  urls:", "    github: null", "    homepage: null", "    other: []", ""
      ].join("\n"));
      await writeFile(descriptorPath, JSON.stringify({
        experimental: true, shelfLocationPath, expectedShelfId: shelfId, allowedOrigin: origin,
        testOnlyWritesEnabled: true, coordinationRoot
      }));
      const requestId = "00000000-0000-4000-8000-000000000002";
      const request = { protocol, operation: "save_web_quote", requestId, quote: "Selected test quotation", url: "https://example.com/", getDate: "202611031200", title: "Sample Page", authors: [] };
      const receipt: ShelfQuoteWriteReceipt = {
        version: 1, state: "committed", requestId, shelfId, bookId: "book:01JBF5GD3RT8YCKM93Q5D9X0EX",
        annotationId: "ann:01JBF5GD3RT8YCKM93Q5D9X0EY", bookReused: false,
        annotationDigest: `sha256:${"a".repeat(64)}`, requestDigest: `sha256:${"b".repeat(64)}`, recordedAt: "2026-11-03T03:00:00.000Z"
      };
      let writerRequest: ShelfQuoteWriteRequest | undefined;
      const writer = async (value: ShelfQuoteWriteRequest) => { writerRequest = value; return receipt; };
      const env = { MAGINALIA_COLLECTOR_TEST_ONLY: "1" };

      expect(await handleExperimentalRequest({ protocol, operation: "health" }, descriptorPath, origin, env))
        .toMatchObject({ ok: true, operations: ["health", "configured_shelf", "save_web_quote"], writesEnabled: true });
      expect(await handleExperimentalRequest(request, descriptorPath, origin, env, writer)).toEqual({ protocol, ok: true, receipt });
      expect(writerRequest).toMatchObject({
        requestId, shelfRoot, expectedShelfId: shelfId, coordinationRoot,
        quote: "Selected test quotation", url: "https://example.com/", getDate: "202611031200", title: "Sample Page",
        processLabel: "collector-native-host-test-only"
      });
      expect(JSON.stringify(await handleExperimentalRequest(request, descriptorPath, origin, env, writer))).not.toContain(temp);

      let calls = 0;
      const guardedWriter = async () => { calls += 1; return receipt; };
      expect(await handleExperimentalRequest({ ...request, shelfRoot }, descriptorPath, origin, env, guardedWriter))
        .toMatchObject({ ok: false, error: "invalid_request" });
      expect(calls).toBe(0);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("does not disclose writer diagnostics when a test-only save fails", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "collector-host-write-fail-"));
    try {
      const shelfRoot = path.join(temp, "shelf");
      const shelfLocationPath = path.join(temp, "location.yml");
      const descriptorPath = path.join(temp, "descriptor.json");
      const origin = `chrome-extension://${"c".repeat(32)}/`;
      const shelfId = "750e8400-e29b-41d4-a716-446655440000";
      await mkdir(path.join(shelfRoot, "books"), { recursive: true });
      await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
      await writeFile(path.join(shelfRoot, "shelf.magi"), `version = 1\ntype = shelf\nid = ${shelfId}\n`);
      await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({ type: "library", version: "0.1", name: "Test Shelf", booksPath: "books", annotationsPath: "annotations" }));
      await writeFile(shelfLocationPath, ["version: 1", "private_shelf:", `  registry: ${JSON.stringify(shelfRoot)}`, "  urls:", "    github: null", "    homepage: null", "    other: []", "public_shelf:", "  registry: null", "  urls:", "    github: null", "    homepage: null", "    other: []", ""].join("\n"));
      await writeFile(descriptorPath, JSON.stringify({ experimental: true, shelfLocationPath, expectedShelfId: shelfId, allowedOrigin: origin, testOnlyWritesEnabled: true, coordinationRoot: path.join(temp, "coordination") }));
      const response = await handleExperimentalRequest({ protocol, operation: "save_web_quote", requestId: "00000000-0000-4000-8000-000000000003", quote: "Selected test quotation", url: "https://example.com/", getDate: "202611031200" }, descriptorPath, origin,
        { MAGINALIA_COLLECTOR_TEST_ONLY: "1" }, async () => { throw new Error(`private failure at ${temp}`); });
      expect(response).toEqual({ protocol, ok: false, error: "save_failed" });
      expect(JSON.stringify(response)).not.toContain(temp);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
