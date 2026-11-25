/**
 * Types for the write side of the Collector integration (design 3.5, WP-5b).
 *
 * Everything the apply module does to the machine goes through the injected adapters
 * declared here (`CollectorApplyFileSystem`, the registry adapter of WP-3, the Host self-check
 * runner and the clock), so tests run against temp roots and fakes. Results carry opaque codes
 * only: no paths, no Shelf identifiers, no free text.
 */
import type { CollectorRegistryTargetId } from "./collector-browser-table.js";
import type { CollectorIntegrationFileSystem, CollectorIntegrationInspection, CollectorIntegrationState } from "./collector-integration-types.js";
import type { CollectorIntegrationInspectDependencies } from "./collector-integration.js";

export type CollectorFileSystemErrorCode = "locked" | "exists" | "missing" | "not-empty" | "failed";

/** The only error the write adapters throw. The message is fixed text: never a path. */
export class CollectorFileSystemError extends Error {
  public readonly code: CollectorFileSystemErrorCode;
  public constructor(code: CollectorFileSystemErrorCode) {
    super(`Collector file-system operation failed (${code}).`);
    this.name = "CollectorFileSystemError";
    this.code = code;
  }
}

export interface CollectorDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
  /** `lstat` semantics: the entry itself is a symbolic link or junction. */
  readonly isReparsePoint: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface CollectorCopyResult {
  /** SHA-256 of the bytes as they were written to the destination (not a re-read of the source). */
  readonly sha256: string;
  readonly size: number;
  /** The source's identity (type, size, mtime) differed before and after the copy, or it was not a plain regular file. */
  readonly sourceChanged: boolean;
}

/**
 * Write-capable file-system adapter. The inspection's read-only interface is extended, never
 * widened: there is no recursive delete, no `chmod`, no link creation. Every method acts on the
 * single entry it is given, never follows a final link, and throws `CollectorFileSystemError`.
 */
export interface CollectorApplyFileSystem extends CollectorIntegrationFileSystem {
  /** Entries of a directory (one level, `lstat` each); `null` when the directory does not exist. */
  listDirectory(target: string): Promise<readonly CollectorDirectoryEntry[] | null>;
  /** Non-recursive `mkdir`; inherits the parent's ACL. `exists` when the name is already taken. */
  makeDirectory(target: string): Promise<"created" | "exists">;
  /** Owner-only protected DACL (native `createNativePrivateDirectory`). Never re-permissions an existing folder. */
  createPrivateDirectory(target: string): Promise<"created" | "exists">;
  /** Exclusive create (`wx`), write, flush. Fails with `exists` rather than overwriting. */
  writeFileExclusive(target: string, bytes: Uint8Array): Promise<void>;
  /** Exclusive-create `destination`, stream `source` into it hashing the written bytes. */
  copyFileExclusive(source: string, destination: string): Promise<CollectorCopyResult>;
  /** Rename a file. `replace: false` fails with `exists` when the destination exists. */
  renameFile(from: string, to: string, options: { readonly replace: boolean }): Promise<void>;
  /** Rename a directory. Never replaces an existing destination (`exists`). */
  renameDirectory(from: string, to: string): Promise<void>;
  /** Delete one regular file; `missing` when absent. Refuses directories and links. */
  removeFile(target: string): Promise<"removed" | "missing">;
  /** `rmdir` of one EMPTY directory (non-recursive); `missing` when absent. */
  removeEmptyDirectory(target: string): Promise<"removed" | "missing">;
}

export type HostSelfCheckResult =
  | { readonly status: "ok"; readonly protocol: string; readonly hostVersion?: string }
  | { readonly status: "failed" };

export interface HostSelfCheckRequest {
  /** Executable resolved registry -> manifest -> `path`, exactly as Chrome would. Main process only. */
  readonly executablePath: string;
  /** First command-line argument, as Chrome passes it. */
  readonly allowedOrigin: string;
}

export interface CollectorPayloadSource {
  /** Packaged `collector-host` resource folder (exe, addon, license files). */
  readonly hostFolder: string;
  /** Packaged `collector-extension` resource folder. */
  readonly extensionFolder: string;
}

export interface CollectorIntegrationApplyDependencies extends CollectorIntegrationInspectDependencies {
  readonly fileSystem: CollectorApplyFileSystem;
  readonly payloadSource: CollectorPayloadSource;
  /** Runs the placed Host once and parses its `health` answer. Product: spawn with a 10 s timeout. */
  readonly runHostSelfCheck: (request: HostSelfCheckRequest) => Promise<HostSelfCheckResult>;
  /** Unique, filename-safe suffix (`[0-9a-f]{16}`) for private temp names. */
  readonly randomSuffix: () => string;
}

export type CollectorApplyRequest =
  | { readonly action: "setup" | "repair"; readonly confirmReplaceForeign?: boolean }
  | { readonly action: "refresh" | "remove" };

export type CollectorApplyAction = CollectorApplyRequest["action"];

export type CollectorApplyReason =
  // refusals (nothing written)
  | "e2e-isolation"
  | "policy-blocked"
  | "inspection-incomplete"
  | "wrong-state"
  | "foreign-confirmation-required"
  | "program-folder-unsafe"
  | "reparse-point-found"
  | "program-folder-unrecognized-content"
  | "payload-unavailable"
  | "registration-changed"
  /** The set of browsers whose registration is expected changed between the precondition and a guard (a row became policy-blocked or unblocked). */
  | "expected-targets-changed"
  | "layout-unresolved"
  | "busy"
  // failures
  | "file-locked"
  | "source-changed"
  | "hash-mismatch"
  | "extension-verification-failed"
  | "write-failed"
  | "registry-write-denied"
  | "registry-write-failed"
  | "registry-readback-mismatch"
  | "unregister-failed"
  | "self-check-failed";

export type CollectorApplyWarning =
  | "standalone-leftover"
  | "previous-extension-retained"
  | "integration-folder-unsafe"
  | "leftovers-remain"
  | "foreign-registration-left";

/**
 * - `applied`: the action completed.
 * - `noop`: nothing needed doing (idempotent second run).
 * - `refused`: a precondition failed before anything of the installation was changed: no Host,
 *   extension, manifest, state or registry change. (Creating the empty protected program folder is
 *   not counted, so a refusal may leave that one empty folder.) Also `busy`: another apply is running.
 * - `failed`: a step failed after that point; `reason` says which class and `inspection` shows what
 *   is on disk now. A failure after the manifest switch is never rolled back (design 6.3): the
 *   files stay, the previous slot is intact, and a repair converges. A `file-locked` failure of the
 *   extension swap happens BEFORE the manifest switch and leaves the previous installation, its
 *   state file included, untouched; the next refresh / repair retries it. Callers must not show
 *   "updated" for anything but `applied`.
 * - `partial`: remove deleted what it could; `warnings` contains `leftovers-remain`. The registration
 *   may already be gone (remove unregisters first, even from an unsafe folder: `reason` is then
 *   `program-folder-unsafe` and nothing on disk was touched). When nothing at all changed, remove
 *   from an unsafe folder is `refused` instead.
 *
 * For `reason: "busy"` the `state` and `inspection` are a snapshot taken while another apply is
 * writing and may be transient or inconsistent: callers must ignore them and retry later. (Chosen
 * over omitting the fields because it keeps the result type unchanged for every caller.)
 */
export type CollectorApplyOutcome = "applied" | "noop" | "refused" | "failed" | "partial";

/**
 * What this run did to one writable registry target (design 5.2, 5.5). Opaque codes only.
 *
 * setup / repair / refresh: `ours-already` (nothing written), `registered` (absent -> ours),
 * `replaced` (a confirmed foreign value was replaced), `denied` / `failed` (the write was refused or
 * threw; the key is unchanged), `left-absent` (a refresh does not re-register a target that was
 * registered before; that is a repair), `skipped-policy` (its browser is policy-blocked: not expected),
 * `not-expected` (no verified, unblocked browser row needs it).
 *
 * remove: `removed`, `not-registered`, `foreign-left` (a foreign value is never deleted),
 * `denied` / `failed` (the key is still ours).
 */
export type CollectorApplyTargetOutcome =
  | "ours-already"
  | "registered"
  | "replaced"
  | "denied"
  | "failed"
  | "left-absent"
  | "skipped-policy"
  | "not-expected"
  | "removed"
  | "not-registered"
  | "foreign-left";

export interface CollectorApplyTargetResult {
  readonly target: CollectorRegistryTargetId;
  readonly result: CollectorApplyTargetOutcome;
}

export interface CollectorApplyResult {
  readonly action: CollectorApplyAction;
  readonly outcome: CollectorApplyOutcome;
  readonly reason: CollectorApplyReason | null;
  readonly warnings: readonly CollectorApplyWarning[];
  /**
   * One entry per WRITABLE registry target, in registry order, once the run reached the registry
   * step (or, for remove, the unregister step); empty for a refusal before that. A partial failure
   * is visible here: `outcome` is `failed` when any target was `denied` / `failed`.
   */
  readonly targets: readonly CollectorApplyTargetResult[];
  /**
   * `true` only when this run placed Host or extension files (a slot, the extension folder or the
   * manifest was written). A registration-only refresh (design 5.4), a refusal and a remove leave it
   * `false`: the "updated" notice (design 4.6, WP-5c) must key on this, never on `outcome === "applied"`.
   */
  readonly filesChanged: boolean;
  /**
   * The state the caller should act on: the post-action inspection state, except that a failed
   * self-check reports `damaged` (design 4.3). The override is not persisted.
   */
  readonly state: CollectorIntegrationState;
  readonly selfCheck: "ok" | "failed" | "skipped";
  /** Post-action read-only inspection (hashes verified). Opaque codes and the one display path only. */
  readonly inspection: CollectorIntegrationInspection;
}
