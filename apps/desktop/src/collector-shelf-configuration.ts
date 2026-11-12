/**
 * Read-only resolution of the Private Shelf that MAGINALIA Collector may write.
 *
 * Desktop #86 design memo, section 1: the production configuration is the #87 Shelf
 * binding (`MAGINALIA\integration\private-shelf-binding.json`). Desktop writes it on
 * an explicit user action; the Native Messaging Host only reads it. A write is allowed
 * only when every one of these holds:
 *
 * 1. the fixed per-user location comes from the native Windows LocalAppData known
 *    folder (never an environment variable, cwd, executable path or descriptor);
 * 2. the binding exists, parses strictly and passes the ownership/ACL/reparse checks
 *    of `collector-path-security.ts`;
 * 3. `shelfLocationPath` -> `shelf_location.yml` -> `private_shelf.registry` matches the
 *    recorded `locatorSha256`;
 * 4. the typed D068 marker in that folder is valid and its UUID equals
 *    `expectedShelfId`;
 * 5. `library.json` validates with `@maginalia/format`.
 *
 * Nothing here creates, repairs or adopts a marker, a binding or a Shelf. Failure codes
 * are the Collector protocol vocabulary and never carry paths.
 */
import { lstat, open } from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { inspectFolderMarkers } from "./folder-identity.js";
import { parseShelfLocationSource } from "./shelf-location-registry.js";
import { readShelfBinding, validateShelfBindingForUse, type ShelfBindingV1 } from "./shelf-binding.js";
import {
  createShelfBindingFileStore,
  resolveShelfBindingStoragePaths,
  type ShelfBindingStoragePaths,
} from "./shelf-binding-store.js";
import { verifyCollectorStorageSecurity, type PathSecurityInspector } from "./collector-path-security.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const SHELF_LOCATION_LIMIT = 64 * 1024;
const LIBRARY_LIMIT = 1024 * 1024;

export type CollectorConfigurationErrorCode =
  | "shelf_unconfigured"
  | "configuration_unavailable"
  | "shelf_identity_mismatch"
  | "shelf_identity_unavailable"
  | "shelf_unavailable";

export interface CollectorConfiguredShelf {
  readonly root: string;
  readonly id: string;
  readonly name: string;
}

export interface ValidCollectorShelfConfiguration {
  readonly kind: "valid";
  readonly binding: ShelfBindingV1;
  readonly shelf: CollectorConfiguredShelf;
  readonly coordinationRoot: string;
}

export interface CollectorConfigurationFailure {
  readonly kind: "error";
  readonly code: CollectorConfigurationErrorCode;
}

export type CollectorShelfConfigurationResult = ValidCollectorShelfConfiguration | CollectorConfigurationFailure;

export interface CollectorShelfConfigurationDependencies {
  /** Native `SHGetKnownFolderPath(FOLDERID_LocalAppData)`; tests inject a disposable root. */
  readonly resolveLocalAppDataPath: () => string;
  /** Native `inspectPathSecurity`. */
  readonly inspectPathSecurity: PathSecurityInspector;
}

function failure(code: CollectorConfigurationErrorCode): CollectorConfigurationFailure {
  return Object.freeze({ kind: "error", code });
}

/** Read a small regular file, refusing links, oversize input and changes during the read. */
export async function readBoundedTextFile(file: string, limit: number): Promise<string> {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) throw new Error("invalid file");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.size !== stats.size) {
      throw new Error("changed file");
    }
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used !== stats.size || used > limit) throw new Error("changed file");
    return decoder.decode(bytes.subarray(0, used));
  } finally {
    await handle.close();
  }
}

export interface ConfiguredPrivateShelfMarker {
  readonly kind: "valid";
  /** Exact `private_shelf.registry` string (hashed into the binding). */
  readonly locator: string;
  readonly root: string;
  readonly marker: { readonly version: 1; readonly type: "shelf"; readonly id: string };
}

/**
 * Resolve the Private Shelf folder that `shelf_location.yml` currently names and read
 * its typed D068 marker. Used by the Host (after the binding is read) and by the
 * Desktop command that writes the binding.
 */
export async function inspectConfiguredPrivateShelfMarker(
  shelfLocationPath: string,
): Promise<ConfiguredPrivateShelfMarker | CollectorConfigurationFailure> {
  let location: ReturnType<typeof parseShelfLocationSource>;
  try {
    location = parseShelfLocationSource(await readBoundedTextFile(shelfLocationPath, SHELF_LOCATION_LIMIT));
  } catch {
    return failure("configuration_unavailable");
  }
  if (!location) return failure("configuration_unavailable");
  const root = location.privateShelf.registry;
  if (root === null) return failure("shelf_unconfigured");

  let markerInspection: Awaited<ReturnType<typeof inspectFolderMarkers>>;
  try {
    markerInspection = await inspectFolderMarkers(root);
  } catch {
    // The folder itself is missing, unreadable or not a safe directory.
    return failure("shelf_unavailable");
  }
  if (markerInspection.kind !== "valid" || markerInspection.marker.type !== "shelf") {
    return failure("shelf_identity_unavailable");
  }
  const id = markerInspection.marker.id;
  return Object.freeze({
    kind: "valid",
    locator: root,
    root,
    marker: Object.freeze({ version: 1 as const, type: "shelf" as const, id }),
  });
}

/** Validate `library.json` and return its display name. */
export async function readPrivateShelfLibraryName(root: string): Promise<string | CollectorConfigurationFailure> {
  try {
    const libraryText = await readBoundedTextFile(path.join(root, "library.json"), LIBRARY_LIMIT);
    const format = await import("@maginalia/format");
    const library = format.parseAndValidate("library", libraryText);
    return library.valid ? library.value.name : failure("shelf_unavailable");
  } catch {
    return failure("shelf_unavailable");
  }
}

/** Resolve the fixed integration paths from the native known folder only. */
export function resolveCollectorStoragePaths(
  dependencies: Pick<CollectorShelfConfigurationDependencies, "resolveLocalAppDataPath">,
): ShelfBindingStoragePaths | undefined {
  try {
    return resolveShelfBindingStoragePaths(dependencies.resolveLocalAppDataPath());
  } catch {
    return undefined;
  }
}

/**
 * Host-side, read-only: decide whether the bound Private Shelf may receive a Collector
 * write. Every failure closes writes; nothing is created or repaired.
 */
export async function readCollectorShelfConfiguration(
  dependencies: CollectorShelfConfigurationDependencies,
): Promise<CollectorShelfConfigurationResult> {
  const paths = resolveCollectorStoragePaths(dependencies);
  if (paths === undefined) return failure("configuration_unavailable");

  const read = await readShelfBinding(createShelfBindingFileStore(paths.bindingDirectory));
  if (read.kind === "error") {
    return failure(read.code === "binding-missing" ? "shelf_unconfigured" : "configuration_unavailable");
  }
  if (!verifyCollectorStorageSecurity(paths, dependencies.inspectPathSecurity).ok) {
    return failure("configuration_unavailable");
  }

  const configured = await inspectConfiguredPrivateShelfMarker(read.binding.shelfLocationPath);
  if (configured.kind === "error") return configured;

  const validated = validateShelfBindingForUse({
    binding: read.binding,
    shelfLocationPath: read.binding.shelfLocationPath,
    privateShelfLocator: configured.locator,
    marker: configured.marker,
  });
  if (validated.kind === "error") {
    return failure(validated.code === "shelf-identity-mismatch" ? "shelf_identity_mismatch" : "configuration_unavailable");
  }

  const name = await readPrivateShelfLibraryName(configured.root);
  if (typeof name !== "string") return name;

  return Object.freeze({
    kind: "valid",
    binding: validated.binding,
    shelf: Object.freeze({ root: configured.root, id: configured.marker.id, name }),
    coordinationRoot: paths.coordinationRoot,
  });
}
