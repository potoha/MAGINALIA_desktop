import { createHash } from "node:crypto";
import * as path from "node:path";

/**
 * Versioned machine-local binding between the existing Shelf location config
 * and one independently confirmed D068 Shelf marker.
 *
 * This module is deliberately pure apart from the injected persistence
 * callbacks below. It does not read environment variables, resolve relative
 * paths against cwd, inspect or create markers, or provide a filesystem
 * adapter. Product code supplies a fixed per-user LocalAppData store.
 */
export const SHELF_BINDING_VERSION = 1 as const;

const CONFIG_FILE_NAME = "shelf_location.yml";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_DESCRIPTOR_LENGTH = 16 * 1024;

export interface ShelfBindingV1 {
  readonly version: typeof SHELF_BINDING_VERSION;
  /** Explicit path to the sole locator authority, `shelf_location.yml`. */
  readonly shelfLocationPath: string;
  /** UUID taken from the typed D068 marker after explicit user confirmation. */
  readonly expectedShelfId: string;
  /** SHA-256 of the exact configured `private_shelf.registry` string. */
  readonly locatorSha256: string;
  /** Monotonically increasing descriptor generation, starting at 1. */
  readonly generation: number;
}

export type ShelfBindingErrorCode =
  | "binding-json-corrupt"
  | "binding-schema-invalid"
  | "binding-version-unsupported"
  | "binding-generation-invalid"
  | "configuration-reference-invalid"
  | "configuration-reference-mismatch"
  | "locator-invalid"
  | "locator-changed"
  | "marker-invalid"
  | "shelf-identity-mismatch"
  | "binding-missing"
  | "binding-unavailable"
  | "binding-generation-conflict"
  | "binding-store-unavailable";

export interface ShelfBindingSuccess {
  readonly kind: "valid";
  readonly binding: ShelfBindingV1;
}

export interface ShelfBindingFailure {
  readonly kind: "error";
  readonly code: ShelfBindingErrorCode;
}

export type ShelfBindingResult = ShelfBindingSuccess | ShelfBindingFailure;

export interface ShelfBindingCreationRequest {
  readonly shelfLocationPath: unknown;
  readonly privateShelfLocator: unknown;
  /** Parsed D068 marker returned by the explicit selection/reconfirmation flow. */
  readonly confirmedMarker: unknown;
  /** Defaults to 1 only for the first explicit binding. */
  readonly generation?: unknown;
}

export interface ShelfBindingUseRequest {
  readonly binding: unknown;
  readonly shelfLocationPath: unknown;
  /** Current `private_shelf.registry` value read from shelf_location.yml. */
  readonly privateShelfLocator: unknown;
  /** Parsed current D068 marker. This function never reads or repairs it. */
  readonly marker: unknown;
}

export interface ShelfBindingReaderAdapter {
  /** Reads only the binding descriptor. It must not create or repair it. */
  readBindingText(): Promise<string | null>;
}

/**
 * Write-capable persistence is injected separately from the read-only Host interface.
 */
export interface SecureShelfBindingPersistenceAdapter extends ShelfBindingReaderAdapter {
  /**
   * Atomically replace the descriptor only if its current generation equals
   * `expectedGeneration` (or it is absent when expectedGeneration is null).
   * The store owns the fixed per-user location, inherited OS ACL and atomic
   * replacement. No Shelf config, marker, or research data is written here.
   */
  replaceBindingAtomically(
    serializedBinding: string,
    expectedGeneration: number | null,
  ): Promise<void>;
}

function failure(code: ShelfBindingErrorCode): ShelfBindingFailure {
  return Object.freeze({ kind: "error", code });
}

function success(binding: ShelfBindingV1): ShelfBindingSuccess {
  return Object.freeze({ kind: "valid", binding });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalWindowsLocalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_767 || value.includes("\0")) return false;
  // A drive-qualified DOS path is local and absolute. Rooted paths, UNC paths,
  // device paths, relative paths and paths with dot-segments are refused.
  if (!/^[A-Za-z]:\\/u.test(value) || value.startsWith("\\\\")) return false;
  return path.win32.normalize(value) === value;
}

function isShelfLocationPath(value: unknown): value is string {
  return isCanonicalWindowsLocalPath(value)
    && path.win32.basename(value).toLocaleLowerCase("en-US") === CONFIG_FILE_NAME;
}

function isPrivateShelfLocator(value: unknown): value is string {
  return isCanonicalWindowsLocalPath(value)
    && (path.win32.basename(value).length > 0 || /^[A-Za-z]:\\$/u.test(value));
}

function parseShelfMarker(value: unknown): { readonly version: 1; readonly type: "shelf"; readonly id: string } | undefined {
  if (!isPlainRecord(value)
    || !hasExactlyKeys(value, ["version", "type", "id"])
    || value.version !== 1
    || value.type !== "shelf"
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)) return undefined;

  return Object.freeze({ version: 1, type: "shelf", id: value.id });
}

function parseGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

/** Hash the exact absolute local path selected in `private_shelf.registry`. */
export function digestPrivateShelfLocator(locator: unknown): string | undefined {
  if (!isPrivateShelfLocator(locator)) return undefined;
  return createHash("sha256").update(locator, "utf8").digest("hex");
}

/** Strictly parse a descriptor value, rejecting unknown and missing fields. */
export function parseShelfBinding(value: unknown): ShelfBindingResult {
  if (!isPlainRecord(value)) return failure("binding-schema-invalid");
  if (!hasExactlyKeys(value, [
    "version",
    "shelfLocationPath",
    "expectedShelfId",
    "locatorSha256",
    "generation",
  ])) return failure("binding-schema-invalid");
  if (value.version !== SHELF_BINDING_VERSION) return failure("binding-version-unsupported");

  if (!isShelfLocationPath(value.shelfLocationPath)
    || typeof value.expectedShelfId !== "string"
    || !UUID_PATTERN.test(value.expectedShelfId)
    || typeof value.locatorSha256 !== "string"
    || !SHA256_PATTERN.test(value.locatorSha256)) return failure("binding-schema-invalid");

  const generation = parseGeneration(value.generation);
  if (generation === undefined) return failure("binding-generation-invalid");

  return success(Object.freeze({
    version: SHELF_BINDING_VERSION,
    shelfLocationPath: value.shelfLocationPath,
    expectedShelfId: value.expectedShelfId,
    locatorSha256: value.locatorSha256,
    generation,
  }));
}

function canonicalJson(binding: ShelfBindingV1): string {
  return `${JSON.stringify({
    version: binding.version,
    shelfLocationPath: binding.shelfLocationPath,
    expectedShelfId: binding.expectedShelfId,
    locatorSha256: binding.locatorSha256,
    generation: binding.generation,
  }, null, 2)}\n`;
}

/** Serialize with one deterministic JSON representation for secure adapters. */
export function serializeShelfBinding(binding: ShelfBindingV1): string {
  const parsed = parseShelfBinding(binding);
  if (parsed.kind === "error") throw new TypeError(`Invalid Shelf binding: ${parsed.code}`);
  return canonicalJson(parsed.binding);
}

/** Parse canonical descriptor JSON; duplicate keys and alternate encodings fail closed. */
export function parseShelfBindingJson(source: unknown): ShelfBindingResult {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_DESCRIPTOR_LENGTH) {
    return failure("binding-json-corrupt");
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return failure("binding-json-corrupt");
  }

  const parsed = parseShelfBinding(value);
  if (parsed.kind === "error") return parsed;
  // The descriptor is written by serializeShelfBinding. Requiring that exact
  // form also rejects duplicate JSON keys, whitespace corruption and BOMs.
  return canonicalJson(parsed.binding) === source ? parsed : failure("binding-json-corrupt");
}

/**
 * Create a binding only from the caller's explicit user-confirmed selection.
 * This function never discovers a marker or replaces an existing binding.
 */
export function createShelfBindingFromConfirmedSelection(
  request: ShelfBindingCreationRequest,
): ShelfBindingResult {
  if (!isShelfLocationPath(request.shelfLocationPath)) return failure("configuration-reference-invalid");
  const locatorSha256 = digestPrivateShelfLocator(request.privateShelfLocator);
  if (locatorSha256 === undefined) return failure("locator-invalid");
  const marker = parseShelfMarker(request.confirmedMarker);
  if (marker === undefined) return failure("marker-invalid");
  const generation = request.generation === undefined ? 1 : parseGeneration(request.generation);
  if (generation === undefined) return failure("binding-generation-invalid");

  return parseShelfBinding({
    version: SHELF_BINDING_VERSION,
    shelfLocationPath: request.shelfLocationPath,
    expectedShelfId: marker.id,
    locatorSha256,
    generation,
  });
}

/** Validate a previously stored binding against fresh, independently supplied facts. */
export function validateShelfBindingForUse(request: ShelfBindingUseRequest): ShelfBindingResult {
  const parsed = parseShelfBinding(request.binding);
  if (parsed.kind === "error") return parsed;
  if (!isShelfLocationPath(request.shelfLocationPath)) return failure("configuration-reference-invalid");
  if (parsed.binding.shelfLocationPath !== request.shelfLocationPath) {
    return failure("configuration-reference-mismatch");
  }

  const locatorSha256 = digestPrivateShelfLocator(request.privateShelfLocator);
  if (locatorSha256 === undefined) return failure("locator-invalid");
  if (parsed.binding.locatorSha256 !== locatorSha256) return failure("locator-changed");

  const marker = parseShelfMarker(request.marker);
  if (marker === undefined) return failure("marker-invalid");
  if (marker.id.toLowerCase() !== parsed.binding.expectedShelfId.toLowerCase()) {
    return failure("shelf-identity-mismatch");
  }

  return parsed;
}

/** Read-only adapter surface suitable for a future Host reader. */
export async function readShelfBinding(adapter: ShelfBindingReaderAdapter): Promise<ShelfBindingResult> {
  let source: string | null;
  try {
    source = await adapter.readBindingText();
  } catch {
    return failure("binding-unavailable");
  }
  if (source === null) return failure("binding-missing");
  return parseShelfBindingJson(source);
}

/**
 * Persist only a descriptor through an injected native-secure adapter. Hosts
 * receive the read-only adapter type and have no write operation.
 */
export async function persistShelfBinding(
  adapter: SecureShelfBindingPersistenceAdapter,
  candidate: unknown,
  expectedGeneration: number | null,
): Promise<ShelfBindingResult> {
  const parsed = parseShelfBinding(candidate);
  if (parsed.kind === "error") return parsed;
  if (expectedGeneration !== null && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)) {
    return failure("binding-generation-invalid");
  }
  const requiredGeneration = expectedGeneration === null ? 1 : expectedGeneration + 1;
  if (!Number.isSafeInteger(requiredGeneration) || parsed.binding.generation !== requiredGeneration) {
    return failure("binding-generation-conflict");
  }

  try {
    await adapter.replaceBindingAtomically(canonicalJson(parsed.binding), expectedGeneration);
  } catch {
    return failure("binding-store-unavailable");
  }
  return parsed;
}
