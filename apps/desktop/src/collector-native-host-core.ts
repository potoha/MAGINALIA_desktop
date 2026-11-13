/**
 * Shared Native Messaging core for the Collector Hosts.
 *
 * Both entry points use this module:
 * - `collector-native-host.ts`: the developer / isolated test-only entry. It keeps the
 *   descriptor + `MAGINALIA_COLLECTOR_TEST_ONLY` gate and the recovery probe.
 * - `collector-native-host-product.ts`: the production entry. It reads no environment
 *   variables, cwd or descriptor files.
 *
 * The protocol is `maginalia.collector.experimental.v1`, with operations `health`,
 * `configured_shelf`, `save_web_quote` and (production Host only) `host_info`. Requests are limited to 64 KiB and
 * responses to 1 MiB. stdout carries only length-prefixed frames, and nothing here
 * writes diagnostics.
 */
import { once } from "node:events";
import { TextDecoder } from "node:util";

export const COLLECTOR_PROTOCOL = "maginalia.collector.experimental.v1";
export const COLLECTOR_REQUEST_LIMIT = 64 * 1024;
export const COLLECTOR_RESPONSE_LIMIT = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

export type RecordValue = Record<string, unknown>;

export function isRecordValue(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(value: RecordValue, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function protocolError(code: string): RecordValue {
  return { protocol: COLLECTOR_PROTOCOL, ok: false, error: code };
}

declare const __COLLECTOR_HOST_VERSION__: string | undefined;

/**
 * Host version reported by `host_info` and the contact record. The Host SEA build
 * (`scripts/build-collector-host.mjs`) replaces `__COLLECTOR_HOST_VERSION__` with the
 * payload version at bundle time; every other build uses the default.
 */
export const COLLECTOR_HOST_VERSION: string = typeof __COLLECTOR_HOST_VERSION__ === "string"
  ? __COLLECTOR_HOST_VERSION__
  : "0.2.0";
/** Oldest Collector extension version this Host supports (compile-time constant). */
export const COLLECTOR_MINIMUM_EXTENSION_VERSION = "0.2.0";

/** Strict semver-like `major.minor.patch` with an optional short pre-release; no build metadata. */
export const COLLECTOR_VERSION_PATTERN = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,15})?$/u;
export const COLLECTOR_VERSION_MAX_LENGTH = 32;

export function isCollectorVersionString(value: unknown): value is string {
  return typeof value === "string" && value.length <= COLLECTOR_VERSION_MAX_LENGTH && COLLECTOR_VERSION_PATTERN.test(value);
}

export const COLLECTOR_READ_OPERATIONS = Object.freeze(["health", "configured_shelf"] as const);
export const COLLECTOR_WRITE_OPERATIONS = Object.freeze(["health", "configured_shelf", "save_web_quote"] as const);

/**
 * `advertiseHostInfo` is true only for the production Host, the only Host that answers
 * `host_info`. `host_info` is appended, so the existing prefix of each list is unchanged.
 */
export function healthResponse(writesEnabled: boolean, advertiseHostInfo = false): RecordValue {
  const operations: string[] = writesEnabled ? [...COLLECTOR_WRITE_OPERATIONS] : [...COLLECTOR_READ_OPERATIONS];
  if (advertiseHostInfo) operations.push("host_info");
  return { protocol: COLLECTOR_PROTOCOL, ok: true, experimental: true, operations, writesEnabled };
}

export function hostInfoResponse(): RecordValue {
  return {
    protocol: COLLECTOR_PROTOCOL,
    ok: true,
    host: { version: COLLECTOR_HOST_VERSION, minimumExtensionVersion: COLLECTOR_MINIMUM_EXTENSION_VERSION },
  };
}

export type CollectorRequestKind =
  | { readonly kind: "health" }
  | { readonly kind: "configured_shelf" }
  | { readonly kind: "host_info"; readonly extensionVersion: string }
  | { readonly kind: "save_web_quote"; readonly value: RecordValue }
  | { readonly kind: "error"; readonly response: RecordValue };

/** Validate the envelope; operation-specific payload validation stays with the caller. */
export function classifyCollectorRequest(value: unknown): CollectorRequestKind {
  if (!isRecordValue(value) || value.protocol !== COLLECTOR_PROTOCOL || typeof value.operation !== "string") {
    return { kind: "error", response: protocolError("invalid_request") };
  }
  if ((value.operation === "health" || value.operation === "configured_shelf") && !hasExactKeys(value, ["protocol", "operation"])) {
    return { kind: "error", response: protocolError("invalid_request") };
  }
  if (value.operation === "health") return { kind: "health" };
  if (value.operation === "configured_shelf") return { kind: "configured_shelf" };
  if (value.operation === "host_info") {
    if (!hasExactKeys(value, ["protocol", "operation", "extensionVersion"]) || !isCollectorVersionString(value.extensionVersion)) {
      return { kind: "error", response: protocolError("invalid_request") };
    }
    return { kind: "host_info", extensionVersion: value.extensionVersion };
  }
  if (value.operation === "save_web_quote") return { kind: "save_web_quote", value };
  return { kind: "error", response: protocolError("unsupported_operation") };
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * YYYYMMDDHHMM with the same month/day/hour/minute ranges as the Shelf writer's
 * `GET_DATE_PATTERN` (`shelf-write-coordination.ts`), so a date the writer would reject
 * is refused here as `invalid_request` instead of reaching the write path.
 */
export const COLLECTOR_GET_DATE_PATTERN = /^[0-9]{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:[01][0-9]|2[0-3])(?:[0-5][0-9])$/u;

export interface ValidSaveWebQuoteRequest extends RecordValue {
  readonly protocol: string;
  readonly operation: string;
  readonly requestId: string;
  readonly quote: string;
  readonly url: string;
  readonly getDate: string;
  readonly title?: string;
  readonly authors?: string[];
}

export function isValidSaveWebQuoteRequest(value: RecordValue): value is ValidSaveWebQuoteRequest {
  const required = ["protocol", "operation", "requestId", "quote", "url", "getDate"];
  const optional = ["title", "authors"];
  if (!required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return false;
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)
    || typeof value.quote !== "string" || value.quote.trim().length === 0
    || typeof value.url !== "string" || value.url.length > 8192
    || typeof value.getDate !== "string" || !COLLECTOR_GET_DATE_PATTERN.test(value.getDate)) return false;
  try {
    const parsed = new URL(value.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch { return false; }
  if (Object.hasOwn(value, "title") && (typeof value.title !== "string" || value.title.length > 2048)) return false;
  if (Object.hasOwn(value, "authors") && (!Array.isArray(value.authors) || value.authors.length > 8
    || value.authors.some((author) => typeof author !== "string" || author.length === 0 || author.length > 512))) return false;
  return true;
}

/** Optional writer fields, omitted when empty, exactly as the dev Host passed them. */
export function optionalQuoteFields(value: ValidSaveWebQuoteRequest): { title?: string; authors?: string[] } {
  return {
    ...(value.title ? { title: value.title } : {}),
    ...(value.authors === undefined || value.authors.length === 0 ? {} : { authors: value.authors }),
  };
}

/** Incremental parser that retains at most one bounded frame, even for a large input chunk. */
export class CollectorFrameDecoder {
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
        if (size === 0 || size > COLLECTOR_REQUEST_LIMIT) throw new Error("invalid_frame_length");
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

export function parseCollectorFrame(body: Buffer): unknown {
  return JSON.parse(decoder.decode(body)) as unknown;
}

export function encodeCollectorFrame(value: RecordValue): Buffer {
  let body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > COLLECTOR_RESPONSE_LIMIT) body = Buffer.from(JSON.stringify(protocolError("response_too_large")), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export interface CollectorHostStreams {
  readonly input: AsyncIterable<Buffer | string>;
  readonly output: NodeJS.WritableStream;
}

/**
 * Windows Chrome uses little-endian 32-bit lengths. Requests are handled one at a time
 * in arrival order; a frame-length error ends the session after its error frame.
 */
export async function runCollectorMessageLoop(
  handle: (value: unknown) => Promise<RecordValue>,
  streams: CollectorHostStreams = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const send = async (value: RecordValue): Promise<void> => {
    if (!streams.output.write(encodeCollectorFrame(value))) await once(streams.output, "drain");
  };
  const frames = new CollectorFrameDecoder();
  for await (const chunk of streams.input) {
    try {
      for (const body of frames.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        let value: unknown;
        try {
          value = parseCollectorFrame(body);
        } catch { await send(protocolError("invalid_json")); continue; }
        await send(await handle(value));
      }
    } catch { await send(protocolError("invalid_frame_length")); return; }
  }
  if (frames.hasPartialFrame()) await send(protocolError("truncated_frame"));
}
