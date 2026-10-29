import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExperimentalFrameDecoder, handleExperimentalRequest, parseExperimentalFrame } from "./collector-native-host";

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
});
