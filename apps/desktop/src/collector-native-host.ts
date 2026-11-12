/** Experimental Native Messaging host. Writes require its isolated test-only mode. */
import { lstat, open } from "node:fs/promises";
import { once } from "node:events";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { inspectFolderMarkers } from "./folder-identity.js";
import { parseShelfLocationSource } from "./shelf-location-registry.js";
import { commitShelfQuoteWithNativeLock } from "./shelf-native-write-lock.js";

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

interface Descriptor {
  shelfLocationPath: string;
  expectedShelfId: string;
  allowedOrigin: string;
  testOnlyWritesEnabled: boolean;
  coordinationRoot?: string;
}
async function descriptor(file: string | undefined, origin: string | undefined): Promise<Descriptor | undefined> {
  try {
    if (!file || !path.isAbsolute(file)) return undefined;
    const value: unknown = JSON.parse(await readBoundedFile(file, 16 * 1024));
    if (!record(value) || value.experimental !== true
      || typeof value.shelfLocationPath !== "string" || !path.isAbsolute(value.shelfLocationPath)
      || typeof value.expectedShelfId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.expectedShelfId)
      || typeof value.allowedOrigin !== "string" || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(value.allowedOrigin)
      || origin !== value.allowedOrigin) return undefined;
    if (keys(value, ["experimental", "shelfLocationPath", "expectedShelfId", "allowedOrigin"])) {
      return {
        shelfLocationPath: value.shelfLocationPath,
        expectedShelfId: value.expectedShelfId,
        allowedOrigin: value.allowedOrigin,
        testOnlyWritesEnabled: false
      };
    }
    if (keys(value, ["experimental", "shelfLocationPath", "expectedShelfId", "allowedOrigin", "testOnlyWritesEnabled", "coordinationRoot"])
      && value.testOnlyWritesEnabled === true && typeof value.coordinationRoot === "string" && path.isAbsolute(value.coordinationRoot)) {
      return {
        shelfLocationPath: value.shelfLocationPath,
        expectedShelfId: value.expectedShelfId,
        allowedOrigin: value.allowedOrigin,
        testOnlyWritesEnabled: true,
        coordinationRoot: value.coordinationRoot
      };
    }
    return undefined;
  } catch { return undefined; }
}

interface ConfiguredShelf { readonly root: string; readonly id: string; readonly name: string }
type ShelfLoadResult = { readonly shelf: ConfiguredShelf } | { readonly error: string };

async function loadConfiguredShelf(config: Descriptor): Promise<ShelfLoadResult> {
  let location: ReturnType<typeof parseShelfLocationSource>;
  try { location = parseShelfLocationSource(await readBoundedFile(config.shelfLocationPath, 64 * 1024)); }
  catch { return { error: "configuration_unavailable" }; }
  if (!location) return { error: "configuration_unavailable" };
  try {
    const root = location.privateShelf.registry;
    if (root === null) return { error: "shelf_unconfigured" };
    const marker = await inspectFolderMarkers(root);
    if (marker.kind !== "valid" || marker.marker.type !== "shelf") return { error: "shelf_identity_unavailable" };
    if (marker.marker.id.toLowerCase() !== config.expectedShelfId.toLowerCase()) return { error: "shelf_identity_mismatch" };
    const libraryText = await readBoundedFile(path.join(root, "library.json"), 1024 * 1024);
    const format = await import("@maginalia/format");
    const library = format.parseAndValidate("library", libraryText);
    if (!library.valid) return { error: "shelf_unavailable" };
    return { shelf: { root, id: marker.marker.id, name: library.value.name } };
  } catch { return { error: "shelf_unavailable" }; }
}

function testOnlyWritesEnabled(config: Descriptor, env: NodeJS.ProcessEnv): boolean {
  return config.testOnlyWritesEnabled && env.MAGINALIA_COLLECTOR_TEST_ONLY === "1";
}

async function shelfStatus(config: Descriptor, writesEnabled: boolean): Promise<RecordValue> {
  const loaded = await loadConfiguredShelf(config);
  if ("error" in loaded) return error(loaded.error);
  return {
    protocol: PROTOCOL,
    ok: true,
    shelf: { id: loaded.shelf.id, name: loaded.shelf.name, type: "private", writesEnabled }
  };
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GET_DATE_PATTERN = /^\d{12}$/;

function validSaveRequest(value: RecordValue): value is RecordValue & {
  protocol: string; operation: string; requestId: string; quote: string; url: string; getDate: string;
  title?: string; authors?: string[];
} {
  const required = ["protocol", "operation", "requestId", "quote", "url", "getDate"];
  const optional = ["title", "authors"];
  if (!required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return false;
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)
    || typeof value.quote !== "string" || value.quote.trim().length === 0
    || typeof value.url !== "string" || value.url.length > 8192
    || typeof value.getDate !== "string" || !GET_DATE_PATTERN.test(value.getDate)) return false;
  try {
    const parsed = new URL(value.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch { return false; }
  if (Object.hasOwn(value, "title") && (typeof value.title !== "string" || value.title.length > 2048)) return false;
  if (Object.hasOwn(value, "authors") && (!Array.isArray(value.authors) || value.authors.length > 8
    || value.authors.some((author) => typeof author !== "string" || author.length === 0 || author.length > 512))) return false;
  return true;
}

type QuoteWriter = typeof commitShelfQuoteWithNativeLock;

async function saveWebQuote(config: Descriptor, value: RecordValue, env: NodeJS.ProcessEnv, writeQuote: QuoteWriter): Promise<RecordValue> {
  if (!testOnlyWritesEnabled(config, env) || !config.coordinationRoot) return error("unsupported_operation");
  if (!validSaveRequest(value)) return error("invalid_request");
  const loaded = await loadConfiguredShelf(config);
  if ("error" in loaded) return error(loaded.error);
  try {
    let recoveryProbe = false;
    if (env.MAGINALIA_COLLECTOR_TEST_RECOVERY_PROBE_ONCE === "1") {
      try {
        const probe = await open(path.join(config.coordinationRoot, ".collector-e2e-recovery-probe-used"), "wx", 0o600);
        try { await probe.writeFile("used\n", "utf8"); await probe.sync(); }
        finally { await probe.close(); }
        recoveryProbe = true;
      } catch (cause) {
        if (cause === null || typeof cause !== "object" || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      }
    }
    const receipt = await writeQuote({
      requestId: value.requestId,
      shelfRoot: loaded.shelf.root,
      expectedShelfId: loaded.shelf.id,
      coordinationRoot: config.coordinationRoot,
      quote: value.quote,
      url: value.url,
      getDate: value.getDate,
      ...(value.title ? { title: value.title } : {}),
      ...(value.authors === undefined || value.authors.length === 0 ? {} : { authors: value.authors }),
      processLabel: "collector-native-host-test-only",
      ...(recoveryProbe ? { faults: { beforeAnnotationPublish: async () => { throw new Error("test-only recovery probe"); } } } : {})
    });
    return { protocol: PROTOCOL, ok: true, receipt };
  } catch {
    // Shelf paths, quote text and filesystem diagnostics never cross Native Messaging.
    return error("save_failed");
  }
}

export async function handleExperimentalRequest(
  value: unknown,
  file: string | undefined,
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  writeQuote: QuoteWriter = commitShelfQuoteWithNativeLock
): Promise<RecordValue> {
  const config = await descriptor(file, origin);
  if (!config) return error("host_configuration_or_origin_invalid");
  if (!record(value) || value.protocol !== PROTOCOL || typeof value.operation !== "string") return error("invalid_request");
  if ((value.operation === "health" || value.operation === "configured_shelf") && !keys(value, ["protocol", "operation"])) return error("invalid_request");
  const writesEnabled = testOnlyWritesEnabled(config, env);
  if (value.operation === "health") return {
    protocol: PROTOCOL,
    ok: true,
    experimental: true,
    operations: writesEnabled ? ["health", "configured_shelf", "save_web_quote"] : ["health", "configured_shelf"],
    writesEnabled
  };
  if (value.operation === "configured_shelf") return shelfStatus(config, writesEnabled);
  if (value.operation === "save_web_quote") return saveWebQuote(config, value, env, writeQuote);
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
