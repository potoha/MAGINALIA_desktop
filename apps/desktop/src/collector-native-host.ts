/** Experimental, read-only Native Messaging foundation. Not a production contract. */
import { lstat, open } from "node:fs/promises";
import { once } from "node:events";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { inspectFolderMarkers } from "./folder-identity.js";
import { parseShelfLocationSource } from "./shelf-location-registry.js";

const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const PROTOCOL = "maginalia.collector.experimental.v1";
const decoder = new TextDecoder("utf-8", { fatal: true });

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: RecordValue, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function error(code: string): RecordValue { return { protocol: PROTOCOL, ok: false, error: code }; }

async function readBoundedFile(file: string, limit: number): Promise<string> {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) throw new Error("invalid file");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.size !== stats.size) throw new Error("changed file");
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used !== stats.size || used > limit) throw new Error("changed file");
    return decoder.decode(bytes.subarray(0, used));
  } finally { await handle.close(); }
}

interface Descriptor { shelfLocationPath: string; expectedShelfId: string; allowedOrigin: string }
async function descriptor(file: string | undefined, origin: string | undefined): Promise<Descriptor | undefined> {
  try {
    if (!file || !path.isAbsolute(file)) return undefined;
    const value: unknown = JSON.parse(await readBoundedFile(file, 16 * 1024));
    if (!record(value) || !keys(value, ["experimental", "shelfLocationPath", "expectedShelfId", "allowedOrigin"]) || value.experimental !== true
      || typeof value.shelfLocationPath !== "string" || !path.isAbsolute(value.shelfLocationPath)
      || typeof value.expectedShelfId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.expectedShelfId)
      || typeof value.allowedOrigin !== "string" || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(value.allowedOrigin)
      || origin !== value.allowedOrigin) return undefined;
    return { shelfLocationPath: value.shelfLocationPath, expectedShelfId: value.expectedShelfId, allowedOrigin: value.allowedOrigin };
  } catch { return undefined; }
}

async function shelfStatus(config: Descriptor): Promise<RecordValue> {
  let location: ReturnType<typeof parseShelfLocationSource>;
  try { location = parseShelfLocationSource(await readBoundedFile(config.shelfLocationPath, 64 * 1024)); }
  catch { return error("configuration_unavailable"); }
  if (!location) return error("configuration_unavailable");
  try {
    const root = location.privateShelf.registry;
    if (root === null) return error("shelf_unconfigured");
    const marker = await inspectFolderMarkers(root);
    if (marker.kind !== "valid" || marker.marker.type !== "shelf") return error("shelf_identity_unavailable");
    if (marker.marker.id.toLowerCase() !== config.expectedShelfId.toLowerCase()) return error("shelf_identity_mismatch");
    const libraryText = await readBoundedFile(path.join(root, "library.json"), 1024 * 1024);
    const format = await import("@maginalia/format");
    const library = format.parseAndValidate("library", libraryText);
    if (!library.valid) return error("shelf_unavailable");
    return { protocol: PROTOCOL, ok: true, shelf: { id: marker.marker.id, name: library.value.name, type: "private", writesEnabled: false } };
  } catch { return error("shelf_unavailable"); }
}

export async function handleExperimentalRequest(value: unknown, file: string | undefined, origin: string | undefined): Promise<RecordValue> {
  const config = await descriptor(file, origin);
  if (!config) return error("host_configuration_or_origin_invalid");
  if (!record(value) || !keys(value, ["protocol", "operation"]) || value.protocol !== PROTOCOL || typeof value.operation !== "string") return error("invalid_request");
  if (value.operation === "health") return { protocol: PROTOCOL, ok: true, experimental: true, operations: ["health", "configured_shelf"], writesEnabled: false };
  if (value.operation === "configured_shelf") return shelfStatus(config);
  return error("unsupported_operation");
}

/** Incremental parser retains at most one bounded frame, even for a large input chunk. */
export class ExperimentalFrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;

  public *push(chunk: Buffer): Generator<Buffer> {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 4) continue;
        const size = this.header.readUInt32LE(0);
        if (size === 0 || size > REQUEST_LIMIT) throw new Error("invalid_frame_length");
        this.body = Buffer.alloc(size);
        this.bodyBytes = 0;
      }
      const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + count);
      this.bodyBytes += count;
      offset += count;
      if (this.bodyBytes === this.body.length) {
        const complete = this.body;
        this.body = undefined;
        this.headerBytes = 0;
        yield complete;
      }
    }
  }

  public hasPartialFrame(): boolean { return this.headerBytes > 0 || this.body !== undefined; }
}

export function parseExperimentalFrame(body: Buffer): unknown {
  return JSON.parse(decoder.decode(body)) as unknown;
}

async function send(value: RecordValue): Promise<void> {
  let body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > RESPONSE_LIMIT) body = Buffer.from(JSON.stringify(error("response_too_large")), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  if (!process.stdout.write(Buffer.concat([header, body]))) await once(process.stdout, "drain");
}

/** Windows Chrome uses little-endian 32-bit lengths. No diagnostics on stdout. */
async function main(): Promise<void> {
  const frames = new ExperimentalFrameDecoder();
  for await (const chunk of process.stdin) {
    try {
      for (const body of frames.push(chunk as Buffer)) {
        let value: unknown;
        try {
          value = parseExperimentalFrame(body);
        } catch { await send(error("invalid_json")); continue; }
        await send(await handleExperimentalRequest(value, process.env.MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR, process.argv[2]));
      }
    } catch { await send(error("invalid_frame_length")); return; }
  }
  if (frames.hasPartialFrame()) await send(error("truncated_frame"));
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch(() => { process.stderr.write("Experimental host failed.\n"); process.exitCode = 1; });
}
