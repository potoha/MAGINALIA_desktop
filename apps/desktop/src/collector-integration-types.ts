/**
 * Types for the read-only Collector integration inspection (design 3.5, WP-5a).
 *
 * Everything in `CollectorIntegrationInspection` is safe to hand to the renderer or a log
 * EXCEPT `extensionFolderDisplay`, which is the one path the design allows to leave (for the
 * wizard to display and copy, design 4.1). Every other field is an opaque code, a version
 * string, a number, or a boolean. Raw paths (Chrome's location, the program folder) are never
 * part of this result.
 */
import type { HostRegistrationOwnership } from "./windows-integration.js";
import type { PathSecurityViolation } from "./collector-path-security.js";
import type { VersionComparison } from "./collector-version.js";

/** The seven states of design 3.5 and no others. */
export const COLLECTOR_INTEGRATION_STATES = [
  "not-set-up",
  "policy-blocked",
  "foreign-registration",
  "registration-missing",
  "outdated",
  "damaged",
  "ready",
] as const;
export type CollectorIntegrationState = (typeof COLLECTOR_INTEGRATION_STATES)[number];

/** Opaque reason codes. Never carry a path or free text. */
export type CollectorIntegrationReason =
  // not-set-up
  | "program-folder-unrecognized"
  // policy-blocked
  | "policy-user-level-hosts-disabled"
  | "policy-host-blocklisted"
  // foreign-registration / registration-missing
  | "registration-foreign"
  | "registration-absent"
  // outdated
  | "payload-id-differs"
  | "installed-older"
  | "installed-newer"
  | "installed-version-unparseable"
  // damaged
  | "program-folder-missing"
  | "program-folder-unsafe"
  | "state-file-missing"
  | "state-file-invalid"
  | "manifest-missing"
  | "manifest-invalid"
  | "manifest-mismatch"
  | "slot-missing"
  | "slot-file-missing"
  | "slot-file-hash-mismatch"
  | "extension-folder-missing"
  | "extension-file-missing"
  | "extension-file-hash-mismatch"
  | "extension-manifest-invalid"
  | "extension-version-mismatch"
  | "reparse-point-found"
  | "payload-descriptor-unavailable"
  | "payload-descriptor-invalid"
  // the inspection itself could not finish (fails closed to `damaged`)
  | "known-folder-unavailable"
  | "registry-read-failed"
  | "filesystem-read-failed";

export type CollectorFileEntryKind = "file" | "directory" | "other";

/** `lstat` semantics: the entry itself, never its target. */
export interface CollectorFileEntry {
  readonly kind: CollectorFileEntryKind;
  readonly isReparsePoint: boolean;
  readonly size: number;
}

export type CollectorFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "ok"; readonly bytes: Uint8Array };

/**
 * The only file-system access the inspection has. It is read-only by construction: there is
 * no method that creates, writes, renames, deletes or changes permissions. Tests inject a
 * fake; `createNodeCollectorIntegrationFileSystem()` is the product implementation.
 */
export interface CollectorIntegrationFileSystem {
  /** `null` when the entry does not exist. Throws on any other failure. */
  stat(target: string): Promise<CollectorFileEntry | null>;
  /** Reads at most `maxBytes`; larger files report `too-large` without reading them. */
  readSmallFile(target: string, maxBytes: number): Promise<CollectorFileRead>;
  /** Streaming SHA-256 (lowercase hex); `null` when the file does not exist. */
  sha256File(target: string): Promise<string | null>;
}

export type ChromeSource = "app-paths-hkcu" | "app-paths-hklm-64" | "app-paths-hklm-32" | "known-local-app-data" | "known-program-files" | "known-program-files-x86";

export type ChromeCandidateRejection =
  | "not-absolute-local"
  | "unexpanded-variable"
  | "wrong-basename"
  | "missing"
  | "not-regular-file"
  | "reparse-point"
  | "read-failed";

export type DefaultBrowserKind = "chrome" | "edge" | "other-chromium" | "other" | "unknown";

/** Main-process result of the locator. `executablePath` must never be logged or sent to the renderer. */
export type ChromeLocation =
  | { readonly status: "found"; readonly source: ChromeSource; readonly executablePath: string; readonly rejected: readonly ChromeRejectedCandidate[] }
  | { readonly status: "not-found"; readonly rejected: readonly ChromeRejectedCandidate[] }
  | { readonly status: "unknown" };

export interface ChromeRejectedCandidate {
  readonly source: ChromeSource;
  readonly reason: ChromeCandidateRejection;
}

export interface ChromeDetection {
  readonly status: "found" | "not-found" | "unknown";
  readonly source: ChromeSource | null;
  readonly rejected: readonly ChromeRejectedCandidate[];
  readonly defaultBrowser: DefaultBrowserKind;
}

export interface ChromePolicyEvaluation {
  /** `NativeMessagingUserLevelHosts` is effectively 0: Chrome ignores HKCU registrations. */
  readonly userLevelHostsDisabled: boolean;
  /** The host name is blocklisted (by name or `*`) and not allowlisted. */
  readonly hostBlocked: boolean;
  /** `userLevelHostsDisabled || hostBlocked`: drives the `policy-blocked` state. */
  readonly blocked: boolean;
  /** Warning only (design 8.4): extension loading may be restricted; Chrome is the authority. */
  readonly extensionLoadMayBeBlocked: boolean;
}

export interface CollectorContactRecord {
  readonly version: 1;
  readonly protocol: string;
  readonly hostVersion: string;
  readonly extensionVersion: string;
  readonly contactedAt: string;
}

export type CollectorContactInvalidReason =
  | "unreadable"
  | "too-large"
  | "not-json"
  | "not-an-object"
  | "unexpected-fields"
  | "wrong-version"
  | "wrong-protocol"
  | "invalid-host-version"
  | "invalid-extension-version"
  | "invalid-timestamp"
  | "future-timestamp"
  | "reparse-point";

/** Display-only facts. Nothing here is a trust decision. */
export type CollectorContactStatus =
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly violation: PathSecurityViolation }
  | { readonly status: "invalid"; readonly reason: CollectorContactInvalidReason }
  | {
    readonly status: "present";
    readonly record: CollectorContactRecord;
    /** Loaded extension (from the record) against the version placed by Desktop. */
    readonly extensionVersionVsPlaced: VersionComparison | "not-placed";
    /** Host version (from the record) against the packaged Host version. */
    readonly hostVersionVsPayload: VersionComparison | "no-payload";
  };

export interface CollectorInspectOptions {
  /**
   * Compute SHA-256 of every Host and extension file (default `true`). `false` is the cheap
   * startup mode of design 6: presence and structure only; `filesVerified` is then `false`.
   */
  readonly verifyFileHashes?: boolean;
}

export interface CollectorIntegrationInspection {
  readonly state: CollectorIntegrationState;
  readonly reasons: readonly CollectorIntegrationReason[];
  /** `false` when a read failed and the result fails closed. */
  readonly inspectionComplete: boolean;
  readonly registration: HostRegistrationOwnership | "unknown";
  readonly folderSecurityViolation: PathSecurityViolation | null;
  readonly payload: { readonly status: "valid" | "invalid" | "unavailable"; readonly payloadId: string | null };
  readonly installed: {
    readonly payloadId: string | null;
    readonly activeSlot: "a" | "b" | null;
    readonly hostVersion: string | null;
    readonly extensionVersion: string | null;
  };
  readonly versions: { readonly host: VersionComparison | "not-installed"; readonly extension: VersionComparison | "not-installed" };
  /** Whether file hashes were compared with the packaged payload in this run. */
  readonly filesVerified: boolean;
  readonly policy: ChromePolicyEvaluation & { readonly status: "read" | "unavailable" };
  readonly chrome: ChromeDetection;
  readonly contact: CollectorContactStatus;
  /** The only path allowed to leave (design 4.1): where the extension folder is or will be. */
  readonly extensionFolderDisplay: string | null;
  /** `false` under `MAGINALIA_E2E_ISOLATION_ROOT`: later write steps refuse. Inspection is unaffected. */
  readonly writesAllowed: boolean;
}
