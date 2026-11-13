/**
 * Payload descriptor (`collector-payload.json`, design 2.1) type and strict validator.
 *
 * The file is produced at build time by WP-4. The compiled constants in the main bundle are
 * authoritative; the file in resources is informational. This module only defines the shape
 * and validates whatever an injected `readPayloadDescriptor()` returned. It performs no I/O.
 *
 * Unknown fields are rejected so that a descriptor can never smuggle extra meaning. File
 * names are bare relative names (no drive, no `..`, no backslash, no empty segment).
 */

export const COLLECTOR_PROTOCOL = "maginalia.collector.experimental.v1";
export const COLLECTOR_EXTENSION_ID = "blgmoddncpknfnikdfnjelmdmphfgknf";
export const COLLECTOR_ALLOWED_ORIGINS: readonly string[] = Object.freeze([`chrome-extension://${COLLECTOR_EXTENSION_ID}/`]);
export const COLLECTOR_HOST_EXECUTABLE_NAME = "MAGINALIA-Collector-Host.exe";
export const COLLECTOR_HOST_ADDON_NAME = "shelf_mutex.node";
export const COLLECTOR_PAYLOAD_DESCRIPTOR_VERSION = 1;

const MAX_EXTENSION_FILES = 256;
const MAX_FILE_NAME_LENGTH = 200;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PAYLOAD_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}\+[0-9A-Za-z]{1,40}$/u;
const VERSION_TEXT_PATTERN = /^\d{1,9}(?:\.\d{1,9}){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/u;

export interface CollectorPayloadDescriptor {
  readonly version: 1;
  readonly payloadId: string;
  readonly host: {
    readonly version: string;
    readonly files: Readonly<Record<typeof COLLECTOR_HOST_EXECUTABLE_NAME | typeof COLLECTOR_HOST_ADDON_NAME, string>>;
  };
  readonly extension: {
    readonly version: string;
    readonly id: typeof COLLECTOR_EXTENSION_ID;
    readonly zipSha256: string;
    readonly files: Readonly<Record<string, string>>;
  };
  readonly protocol: typeof COLLECTOR_PROTOCOL;
}

export type CollectorPayloadDescriptorProblem =
  | "not-an-object"
  | "unknown-field"
  | "wrong-descriptor-version"
  | "invalid-payload-id"
  | "invalid-host"
  | "invalid-host-version"
  | "invalid-host-files"
  | "invalid-extension"
  | "invalid-extension-version"
  | "wrong-extension-id"
  | "invalid-zip-hash"
  | "invalid-extension-files"
  | "missing-extension-manifest"
  | "wrong-protocol";

export type CollectorPayloadDescriptorResult =
  | { readonly ok: true; readonly descriptor: CollectorPayloadDescriptor }
  | { readonly ok: false; readonly problem: CollectorPayloadDescriptorProblem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

/** A bare relative POSIX-style file name: segments of safe characters, no traversal. */
export function isSafeRelativeFileName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_FILE_NAME_LENGTH) return false;
  if (/[\\:*?"<>|]/u.test(name) || name.startsWith("/") || name.endsWith("/")) return false;
  // Control characters (including NUL) have no place in a packaged file name.
  if (/[\u0000-\u001f]/u.test(name)) return false;
  return name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/[. ]$/u.test(segment));
}

export function parseCollectorPayloadDescriptor(value: unknown): CollectorPayloadDescriptorResult {
  const fail = (problem: CollectorPayloadDescriptorProblem): CollectorPayloadDescriptorResult => Object.freeze({ ok: false, problem });
  if (!isRecord(value)) return fail("not-an-object");
  if (!hasOnlyKeys(value, ["version", "payloadId", "host", "extension", "protocol"])) return fail("unknown-field");
  if (value.version !== COLLECTOR_PAYLOAD_DESCRIPTOR_VERSION) return fail("wrong-descriptor-version");
  if (typeof value.payloadId !== "string" || !PAYLOAD_ID_PATTERN.test(value.payloadId)) return fail("invalid-payload-id");
  if (value.protocol !== COLLECTOR_PROTOCOL) return fail("wrong-protocol");

  const host = value.host;
  if (!isRecord(host) || !hasOnlyKeys(host, ["version", "files"])) return fail("invalid-host");
  if (typeof host.version !== "string" || !VERSION_TEXT_PATTERN.test(host.version)) return fail("invalid-host-version");
  const hostFiles = host.files;
  if (!isRecord(hostFiles) || !hasOnlyKeys(hostFiles, [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME])
    || !Object.values(hostFiles).every((hash) => typeof hash === "string" && SHA256_PATTERN.test(hash))) {
    return fail("invalid-host-files");
  }

  const extension = value.extension;
  if (!isRecord(extension) || !hasOnlyKeys(extension, ["version", "id", "zipSha256", "files"])) return fail("invalid-extension");
  if (typeof extension.version !== "string" || !VERSION_TEXT_PATTERN.test(extension.version)) return fail("invalid-extension-version");
  if (extension.id !== COLLECTOR_EXTENSION_ID) return fail("wrong-extension-id");
  if (typeof extension.zipSha256 !== "string" || !SHA256_PATTERN.test(extension.zipSha256)) return fail("invalid-zip-hash");
  const extensionFiles = extension.files;
  if (!isRecord(extensionFiles)) return fail("invalid-extension-files");
  const names = Object.keys(extensionFiles);
  if (names.length === 0 || names.length > MAX_EXTENSION_FILES) return fail("invalid-extension-files");
  const folded = new Set<string>();
  for (const name of names) {
    const hash = extensionFiles[name];
    if (!isSafeRelativeFileName(name) || typeof hash !== "string" || !SHA256_PATTERN.test(hash)) return fail("invalid-extension-files");
    const key = name.toLowerCase();
    if (folded.has(key)) return fail("invalid-extension-files"); // case-insensitive duplicate on NTFS
    folded.add(key);
  }
  if (!Object.hasOwn(extensionFiles, "manifest.json")) return fail("missing-extension-manifest");

  return Object.freeze({
    ok: true,
    descriptor: Object.freeze({
      version: 1 as const,
      payloadId: value.payloadId,
      host: Object.freeze({
        version: host.version,
        files: Object.freeze({
          [COLLECTOR_HOST_EXECUTABLE_NAME]: hostFiles[COLLECTOR_HOST_EXECUTABLE_NAME] as string,
          [COLLECTOR_HOST_ADDON_NAME]: hostFiles[COLLECTOR_HOST_ADDON_NAME] as string,
        }),
      }),
      extension: Object.freeze({
        version: extension.version,
        id: COLLECTOR_EXTENSION_ID,
        zipSha256: extension.zipSha256,
        files: Object.freeze({ ...(extensionFiles as Record<string, string>) }),
      }),
      protocol: COLLECTOR_PROTOCOL,
    }),
  });
}
