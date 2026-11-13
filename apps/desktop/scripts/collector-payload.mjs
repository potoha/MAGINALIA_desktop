/**
 * Collector payload (WP-4): pinned Collector extension verification and the
 * `collector-payload.json` descriptor (design: collector-wizard-integration-design §2.1/§2.2).
 *
 * Build-time only. Nothing here is read at runtime; the app consumes the generated
 * descriptor and compiled constants. Node built-ins only.
 *
 * Trust model: the ZIP is untrusted bytes until its SHA-256 equals the pin. The
 * extractor is nevertheless strict, so a pin bump to a malformed archive fails loudly
 * instead of shipping something odd.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

/** One Desktop release ships one Host payload; it equals `apps/desktop/package.json` `version`. */
export const PAYLOAD_VERSION = "0.2.0";
export const PAYLOAD_PROTOCOL = "maginalia.collector.experimental.v1";
export const DESCRIPTOR_VERSION = 1;
export const HOST_EXECUTABLE = "MAGINALIA-Collector-Host.exe";
export const HOST_ADDON = "shelf_mutex.node";

export const MAX_ZIP_BYTES = 4 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 64;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class CollectorPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "CollectorPayloadError";
  }
}

function fail(message) {
  throw new CollectorPayloadError(message);
}

const HEX64 = /^[0-9a-f]{64}$/u;
const EXTENSION_ID = /^[a-p]{32}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;

/** Validate and return the `collectorExtension` pin from runtime-versions.json. */
export function readCollectorPin(runtimeVersions) {
  const pin = runtimeVersions?.collectorExtension;
  if (pin === null || typeof pin !== "object") fail("runtime-versions.json has no collectorExtension pin.");
  if (typeof pin.version !== "string" || !SEMVER.test(pin.version)) fail("collectorExtension.version must be MAJOR.MINOR.PATCH.");
  if (pin.asset !== `maginalia-collector-${pin.version}.zip`) fail("collectorExtension.asset must be maginalia-collector-<version>.zip.");
  if (typeof pin.url !== "string" || !pin.url.startsWith("https://github.com/potoha/MAGINALIA-Collector/releases/download/")
    || !pin.url.endsWith(`/${pin.asset}`)) fail("collectorExtension.url must be the GitHub Release asset URL of the pinned asset.");
  if (typeof pin.sha256 !== "string" || !HEX64.test(pin.sha256)) fail("collectorExtension.sha256 must be 64 lowercase hex digits.");
  if (typeof pin.extensionId !== "string" || !EXTENSION_ID.test(pin.extensionId)) fail("collectorExtension.extensionId must be 32 characters a-p.");
  if (!Array.isArray(pin.files) || pin.files.length === 0 || pin.files.length > MAX_ENTRIES) fail("collectorExtension.files must be a non-empty list.");
  for (const name of pin.files) assertSafeEntryName(name);
  if (new Set(pin.files.map((name) => name.toLowerCase())).size !== pin.files.length) fail("collectorExtension.files has duplicate names.");
  if (!pin.files.includes("manifest.json")) fail("collectorExtension.files must contain manifest.json.");
  return pin;
}

/** Chrome extension ID: SHA-256 of the DER public key, first 32 hex digits, 0-f mapped to a-p. */
export function deriveExtensionId(manifestKey) {
  if (typeof manifestKey !== "string" || manifestKey.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(manifestKey)) {
    fail("manifest.key is missing or not base64.");
  }
  const der = Buffer.from(manifestKey, "base64");
  if (der.length === 0) fail("manifest.key decoded to no bytes.");
  return [...sha256(der).slice(0, 32)].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

function assertSafeEntryName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) fail(`Unsafe entry name length: ${JSON.stringify(name)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(name)) fail(`Entry name contains a control character: ${JSON.stringify(name)}`);
  if (name.includes("\\")) fail(`Entry name contains a backslash: ${JSON.stringify(name)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) fail(`Entry name is absolute: ${JSON.stringify(name)}`);
  if (name.includes(":")) fail(`Entry name contains a colon: ${JSON.stringify(name)}`);
  if (name.endsWith("/")) fail(`Entry is a directory, only regular files are allowed: ${JSON.stringify(name)}`);
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail(`Entry name is a path traversal: ${JSON.stringify(name)}`);
  if (segments.length > 1) fail(`Nested entry names are not part of this release layout: ${JSON.stringify(name)}`);
  if (/[. ]$/u.test(name)) fail(`Entry name ends with a dot or space: ${JSON.stringify(name)}`);
}

/**
 * Strict extraction of the Collector release ZIP.
 *
 * Accepts only: single-disk, no ZIP64, no archive comment, central directory ending
 * exactly at the end-of-central-directory record, UTF-8 or ASCII names, stored or
 * deflate entries, no encryption, no data descriptors, regular files only, entry set
 * exactly equal to `expectedFiles`, CRC-32 and sizes verified, size limits enforced.
 *
 * Returns `Map<name, Buffer>` in the pinned `expectedFiles` order.
 */
export function extractCollectorZip(zipBytes, expectedFiles, limits = {}) {
  const maxZip = limits.maxZipBytes ?? MAX_ZIP_BYTES;
  const maxEntry = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  const bytes = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);
  if (bytes.length < 22) fail("The ZIP is too small to be a ZIP archive.");
  if (bytes.length > maxZip) fail(`The ZIP is larger than the ${maxZip} byte limit.`);

  const eocd = bytes.length - 22;
  if (bytes.readUInt32LE(eocd) !== 0x06054b50) fail("The ZIP does not end with an end-of-central-directory record (archive comment or trailing data is refused).");
  const disk = bytes.readUInt16LE(eocd + 4);
  const cdDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 20) !== 0) fail("ZIP archive comments are refused.");
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) fail("Multi-disk ZIP archives are refused.");
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("ZIP64 archives are refused.");
  if (entryCount > maxEntries) fail(`The ZIP has more than ${maxEntries} entries.`);
  if (cdOffset + cdSize !== eocd) fail("The central directory does not end at the end-of-central-directory record.");

  const entries = [];
  const seen = new Set();
  let offset = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) fail("Malformed central directory entry.");
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const external = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) fail("Central directory entry runs past the central directory.");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    // Names must be valid UTF-8 (round-trip) and are then checked as text.
    const name = rawName.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(rawName)) fail("Entry name is not valid UTF-8.");
    assertSafeEntryName(name);
    const key = name.toLowerCase();
    if (seen.has(key)) fail(`Duplicate ZIP entry: ${name}`);
    seen.add(key);
    if ((flags & ~0x0800) !== 0) fail(`Entry ${name} uses unsupported flags 0x${flags.toString(16)} (encryption or data descriptors).`);
    if (method !== 0 && method !== 8) fail(`Entry ${name} uses unsupported compression method ${method}.`);
    if (diskStart !== 0) fail(`Entry ${name} is not on disk 0.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail("ZIP64 entries are refused.");
    if (size > maxEntry) fail(`Entry ${name} is larger than the ${maxEntry} byte limit.`);
    if (method === 0 && compressedSize !== size) fail(`Stored entry ${name} has mismatching sizes.`);
    if ((external & 0x10) !== 0) fail(`Entry ${name} is marked as a directory.`);
    if ((madeBy >> 8) === 3) {
      const type = (external >>> 16) & 0xf000;
      if (type !== 0 && type !== 0x8000) fail(`Entry ${name} is not a regular file (mode type 0x${type.toString(16)}).`);
    }
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset });
    offset = next;
  }
  if (offset !== eocd) fail("Unexpected bytes after the last central directory entry.");

  const expected = new Set(expectedFiles);
  for (const entry of entries) if (!expected.has(entry.name)) fail(`Unexpected entry in the ZIP: ${entry.name}`);
  for (const name of expectedFiles) if (!entries.some((entry) => entry.name === name)) fail(`Missing entry in the ZIP: ${name}`);

  let total = 0;
  const ranges = [];
  const extracted = new Map();
  for (const entry of entries) {
    total += entry.size;
    if (total > maxTotal) fail(`The ZIP expands to more than the ${maxTotal} byte limit.`);
    const local = entry.localOffset;
    if (local + 30 > cdOffset || bytes.readUInt32LE(local) !== 0x04034b50) fail(`Entry ${entry.name} has no valid local header.`);
    const localFlags = bytes.readUInt16LE(local + 6);
    const localMethod = bytes.readUInt16LE(local + 8);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    if (localFlags !== entry.flags || localMethod !== entry.method) fail(`Entry ${entry.name} local header disagrees with the central directory.`);
    if (bytes.readUInt32LE(local + 14) !== entry.crc || bytes.readUInt32LE(local + 18) !== entry.compressedSize || bytes.readUInt32LE(local + 22) !== entry.size) {
      fail(`Entry ${entry.name} local header sizes disagree with the central directory.`);
    }
    if (!bytes.subarray(local + 30, local + 30 + localNameLength).equals(Buffer.from(entry.name, "utf8"))) fail(`Entry ${entry.name} local header name disagrees with the central directory.`);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > cdOffset) fail(`Entry ${entry.name} data runs into the central directory.`);
    ranges.push([local, dataEnd, entry.name]);
    const compressed = bytes.subarray(dataStart, dataEnd);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(compressed);
    } else {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        fail(`Entry ${entry.name} does not inflate to its declared size: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (data.length !== entry.size) fail(`Entry ${entry.name} size does not match its declared size.`);
    if ((zlib.crc32(data) >>> 0) !== entry.crc) fail(`Entry ${entry.name} fails its CRC-32 check.`);
    extracted.set(entry.name, data);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) fail(`ZIP entries ${ranges[index - 1][2]} and ${ranges[index][2]} overlap.`);
  }
  return new Map(expectedFiles.map((name) => [name, extracted.get(name)]));
}

/**
 * Verify the Collector ZIP against the pin and return the verified extension files.
 * Fails on a wrong ZIP hash, an extra or missing entry, a manifest version that is not
 * the pinned version, a missing `key`, or a derived extension ID that is not the pinned
 * ID (and, when given, the Host constant).
 */
export function verifyCollectorExtension(zipBytes, pin, { hostExtensionId } = {}) {
  const zipSha256 = sha256(zipBytes);
  if (zipSha256 !== pin.sha256) fail(`The Collector ZIP SHA-256 ${zipSha256} does not match the pinned ${pin.sha256}.`);
  const files = extractCollectorZip(zipBytes, pin.files);
  let manifest;
  try {
    manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  } catch {
    fail("manifest.json in the Collector ZIP is not valid JSON.");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest.json is not an object.");
  if (manifest.manifest_version !== 3) fail("The Collector manifest is not Manifest V3.");
  if (manifest.version !== pin.version) fail(`The Collector manifest version ${String(manifest.version)} does not match the pinned ${pin.version}.`);
  const derived = deriveExtensionId(manifest.key);
  if (derived !== pin.extensionId) fail(`The extension ID derived from manifest.key (${derived}) does not match the pinned ${pin.extensionId}.`);
  if (hostExtensionId !== undefined && derived !== hostExtensionId) {
    fail(`The extension ID derived from manifest.key (${derived}) does not match the Host constant ${hostExtensionId}.`);
  }
  return { zipSha256, files, version: manifest.version, extensionId: derived };
}

/** Load the ZIP from an explicit local path (build-time flag) or the pinned URL. Never trusted before verification. */
export async function loadCollectorZip(pin, { localZip, fetchImpl = fetch } = {}) {
  if (localZip !== undefined) {
    if (!path.isAbsolute(localZip)) fail("--collector-zip must be an absolute path.");
    const bytes = await readFile(localZip);
    if (bytes.length > MAX_ZIP_BYTES) fail(`The local ZIP is larger than the ${MAX_ZIP_BYTES} byte limit.`);
    return { bytes, source: "local" };
  }
  const response = await fetchImpl(pin.url, { redirect: "follow" });
  if (!response.ok || response.body === null) fail(`Could not download the pinned Collector ZIP (HTTP ${response.status}). The release may not be published yet; pass --collector-zip <absolute path> for a local ZIP (still verified against the pinned SHA-256).`);
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > MAX_ZIP_BYTES) fail(`The Collector ZIP download exceeds the ${MAX_ZIP_BYTES} byte limit.`);
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), source: "pinned-url" };
}

/** Read `--collector-zip <path>` (or `--collector-zip=<path>`) from an argv list. */
export function parseCollectorZipFlag(argv) {
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--collector-zip") {
      if (value !== undefined) fail("--collector-zip was given twice.");
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail("--collector-zip needs an absolute path.");
      index += 1;
    } else if (argument.startsWith("--collector-zip=")) {
      if (value !== undefined) fail("--collector-zip was given twice.");
      value = argument.slice("--collector-zip=".length);
      if (value === "") fail("--collector-zip needs an absolute path.");
    }
  }
  return value;
}

/**
 * Build `collector-payload.json` (design §2.1 shape, exactly these fields).
 * `hostFiles` / `extensionFiles` are `Map<name, Buffer>`.
 */
export function buildDescriptor({ desktopVersion, commit, hostFiles, extension }) {
  if (desktopVersion !== PAYLOAD_VERSION) fail(`apps/desktop/package.json version ${desktopVersion} must equal PAYLOAD_VERSION ${PAYLOAD_VERSION}.`);
  const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => [name, sha256(bytes)]));
  const descriptor = {
    version: DESCRIPTOR_VERSION,
    payloadId: `${desktopVersion}+${commit.slice(0, 7)}`,
    host: { version: desktopVersion, files: sorted(hostFiles) },
    extension: { version: extension.version, id: extension.extensionId, zipSha256: extension.zipSha256, files: sorted(extension.files) },
    protocol: PAYLOAD_PROTOCOL,
  };
  validateDescriptor(descriptor);
  return descriptor;
}

/**
 * Structural validator for `collector-payload.json`. Mirrors
 * `packaging/collector-payload.schema.json` (a test keeps them in step).
 */
export function validateDescriptor(value) {
  const object = (candidate, keys, label) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail(`${label} must be an object.`);
    const actual = Object.keys(candidate).sort();
    if (actual.join(",") !== [...keys].sort().join(",")) fail(`${label} must have exactly the keys ${keys.join(", ")}.`);
    return candidate;
  };
  const hashes = (candidate, label, required) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail(`${label} must be an object.`);
    const names = Object.keys(candidate);
    if (names.length === 0 || names.length > MAX_ENTRIES) fail(`${label} must list between 1 and ${MAX_ENTRIES} files.`);
    for (const name of names) {
      assertSafeEntryName(name);
      if (typeof candidate[name] !== "string" || !HEX64.test(candidate[name])) fail(`${label}.${name} must be a lowercase SHA-256.`);
    }
    for (const name of required) if (!(name in candidate)) fail(`${label} must contain ${name}.`);
  };
  object(value, ["version", "payloadId", "host", "extension", "protocol"], "descriptor");
  if (value.version !== DESCRIPTOR_VERSION) fail("descriptor.version must be 1.");
  if (typeof value.payloadId !== "string" || !/^\d+\.\d+\.\d+\+[0-9a-f]{7}$/u.test(value.payloadId)) fail("descriptor.payloadId must be <version>+<7 hex commit>.");
  object(value.host, ["version", "files"], "descriptor.host");
  if (typeof value.host.version !== "string" || !SEMVER.test(value.host.version)) fail("descriptor.host.version must be MAJOR.MINOR.PATCH.");
  if (value.payloadId.split("+")[0] !== value.host.version) fail("descriptor.payloadId must start with the host version.");
  hashes(value.host.files, "descriptor.host.files", [HOST_EXECUTABLE, HOST_ADDON]);
  if (Object.keys(value.host.files).length !== 2) fail("descriptor.host.files must be exactly the Host executable and the addon.");
  object(value.extension, ["version", "id", "zipSha256", "files"], "descriptor.extension");
  if (typeof value.extension.version !== "string" || !SEMVER.test(value.extension.version)) fail("descriptor.extension.version must be MAJOR.MINOR.PATCH.");
  if (typeof value.extension.id !== "string" || !EXTENSION_ID.test(value.extension.id)) fail("descriptor.extension.id must be 32 characters a-p.");
  if (typeof value.extension.zipSha256 !== "string" || !HEX64.test(value.extension.zipSha256)) fail("descriptor.extension.zipSha256 must be a lowercase SHA-256.");
  hashes(value.extension.files, "descriptor.extension.files", ["manifest.json"]);
  if (value.protocol !== PAYLOAD_PROTOCOL) fail(`descriptor.protocol must be ${PAYLOAD_PROTOCOL}.`);
  return value;
}
