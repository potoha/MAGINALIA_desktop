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
import type {
  CollectorBrowserId,
  CollectorBrowserInstalled,
  CollectorDefaultBrowserKind,
  CollectorEffectiveRegistration,
  CollectorRecommendationReason,
  CollectorRegistryTargetId,
  CollectorTargetOwnership,
} from "./collector-browser-table.js";
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
  /** Healthy installation, but an expected registration target was never registered (design 4.4-5). */
  | "registration-target-added"
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

export type BrowserExecutableSource = "app-paths-hkcu" | "app-paths-hklm-64" | "app-paths-hklm-32" | "known-local-app-data" | "known-program-files" | "known-program-files-x86";
/** @deprecated Use `BrowserExecutableSource` (S7 removes the Chrome-only names). */
export type ChromeSource = BrowserExecutableSource;

export type ChromeCandidateRejection =
  | "not-absolute-local"
  | "unexpanded-variable"
  | "wrong-basename"
  | "missing"
  | "not-regular-file"
  | "reparse-point"
  | "read-failed";

/** The default browser as classified against the browser table (design 2.1). */
export type DefaultBrowserKind = CollectorDefaultBrowserKind;

/** Main-process result of the locator. `executablePath` must never be logged or sent to the renderer. */
export type BrowserLocation =
  | { readonly status: "found"; readonly source: BrowserExecutableSource; readonly executablePath: string; readonly rejected: readonly BrowserRejectedCandidate[] }
  | { readonly status: "not-found"; readonly rejected: readonly BrowserRejectedCandidate[] }
  | { readonly status: "unknown" };
/** @deprecated Use `BrowserLocation`. */
export type ChromeLocation = BrowserLocation;

export interface BrowserRejectedCandidate {
  readonly source: BrowserExecutableSource;
  readonly reason: ChromeCandidateRejection;
}
/** @deprecated Use `BrowserRejectedCandidate`. */
export type ChromeRejectedCandidate = BrowserRejectedCandidate;

/** The Chrome row of `browsers`, kept for the pre-multi-browser consumers (S7 removes it). */
export interface ChromeDetection {
  readonly status: "found" | "not-found" | "unknown";
  readonly source: BrowserExecutableSource | null;
  readonly rejected: readonly BrowserRejectedCandidate[];
  readonly defaultBrowser: DefaultBrowserKind;
}

export interface ChromePolicyEvaluation {
  /** `NativeMessagingUserLevelHosts` is effectively 0: Chrome ignores HKCU registrations. */
  readonly userLevelHostsDisabled: boolean;
  /** The host name is blocklisted (by name or `*`) and not allowlisted. */
  readonly hostBlocked: boolean;
  /** `userLevelHostsDisabled || hostBlocked`: drives the `policy-blocked` state. */
  readonly blocked: boolean;
  /** Warning only (design 8.4): extension loading may be restricted; the browser is the authority. */
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

/** Ownership of one registry target. `unknown`: not readable (or not inspected: the addon has no such target). */
export type { CollectorTargetOwnership };

/** What the inspection reports for one browser row. Never contains a path. */
export interface CollectorBrowserStatus {
  readonly id: CollectorBrowserId;
  readonly verification: "verified" | "unverified";
  readonly installed: CollectorBrowserInstalled;
  readonly source: BrowserExecutableSource | null;
  /** First present target in the row's `lookupOrder`: what this browser will actually use (Edge falls back to Chromium, then Chrome). */
  readonly effective: CollectorEffectiveRegistration;
  readonly policy: ChromePolicyEvaluation & { readonly status: "read" | "unavailable" | "not-applicable" };
}

export interface CollectorBrowsersInspection {
  readonly defaultBrowser: DefaultBrowserKind;
  readonly recommended: CollectorBrowserId | null;
  readonly recommendationReason: CollectorRecommendationReason;
  /** Table order. */
  readonly entries: readonly CollectorBrowserStatus[];
}

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
  /** Aggregate over the expected set `expectedTargets` (design 4.2). */
  readonly registration: HostRegistrationOwnership | "unknown";
  /** Per registry target. Targets no table row looks up (`vivaldi` today) are `unknown`: not inspected. */
  readonly registrations: Readonly<Record<CollectorRegistryTargetId, CollectorTargetOwnership>>;
  /** The expected set `E` of design 3.1, in registry order. */
  readonly expectedTargets: readonly CollectorRegistryTargetId[];
  /** `registeredTargets` of the state file (v1: `["chrome"]`), or `null` when no valid state file was read. */
  readonly registeredTargets: readonly CollectorRegistryTargetId[] | null;
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
  /** Aggregate: `blocked` only when every verified browser is blocked (design 4.4-1). */
  readonly policy: ChromePolicyEvaluation & { readonly status: "read" | "unavailable" };
  readonly browsers: CollectorBrowsersInspection;
  /** @deprecated The Chrome row of `browsers`; kept until S7 migrates the WP-7a service and IPC. */
  readonly chrome: ChromeDetection;
  readonly contact: CollectorContactStatus;
  /** The only path allowed to leave (design 4.1): where the extension folder is or will be. */
  readonly extensionFolderDisplay: string | null;
  /** `false` under `MAGINALIA_E2E_ISOLATION_ROOT`: later write steps refuse. Inspection is unaffected. */
  readonly writesAllowed: boolean;
}
