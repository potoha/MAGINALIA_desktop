/**
 * Renderer-to-main contract of the Collector integration (design 4.1, 5; WP-7 slice A).
 *
 * The renderer sends INTENTS only: an enumerated intent plus two optional booleans. It never
 * sends a path, a command line or free text. Results are state summaries (enumerations, version
 * strings, booleans). No machine-local absolute path crosses this boundary in either direction:
 * the extension folder is placed on the clipboard or opened by the main process itself.
 *
 * This module is shared by the main process, the preload and the renderer: it imports nothing
 * from Electron and nothing with side effects.
 */
import type { CollectorApplyAction, CollectorApplyOutcome, CollectorApplyReason, CollectorApplyWarning } from "./collector-integration-apply-types.js";
import type {
  CollectorIntegrationReason,
  CollectorIntegrationState,
  DefaultBrowserKind,
} from "./collector-integration-types.js";
import type { CollectorNotice } from "./collector-integration-notices.js";
import type { CollectorSaveDestinationIpcResult } from "./collector-save-destination-ipc.js";

/** One invoke channel for every intent (`CollectorIntegrationRequest`). */
export const COLLECTOR_INTEGRATION_CHANNEL = "maginalia:collector-integration";
/** Pull the notices that are active now (the renderer may load after the startup run finished). */
export const GET_COLLECTOR_NOTICES_CHANNEL = "maginalia:collector-notices-get";
/** Close one notice. The argument is a notice id (`COLLECTOR_NOTICE_IDS`). */
export const DISMISS_COLLECTOR_NOTICE_CHANNEL = "maginalia:collector-notice-dismiss";
/** Main to renderer event: the full list of active notices, sent whenever it changes. */
export const COLLECTOR_NOTICES_EVENT_CHANNEL = "maginalia:collector-notices";

export const COLLECTOR_INTEGRATION_INTENTS = [
  "inspect",
  "setup",
  "repair",
  "remove",
  "openChromeExtensions",
  "copyExtensionPath",
  "revealExtensionFolder",
  "checkConnection",
] as const;
export type CollectorIntegrationIntent = (typeof COLLECTOR_INTEGRATION_INTENTS)[number];

export interface CollectorIntegrationRequest {
  readonly intent: CollectorIntegrationIntent;
  /**
   * `setup` / `repair` only. The user explicitly chose to switch a foreign registration to the one
   * bundled with MAGINALIA (design 4.3). Without it a foreign registration is refused.
   */
  readonly confirmReplaceForeign?: boolean;
  /**
   * `setup` only. The user chose "Chrome は入っています（このまま続ける）" (design 4.2). Without it a
   * setup is refused unless Chrome was found.
   */
  readonly proceedWithoutChrome?: boolean;
}

const REQUEST_KEYS = ["intent", "confirmReplaceForeign", "proceedWithoutChrome"] as const;

export function isCollectorIntegrationRequest(value: unknown): value is CollectorIntegrationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => (REQUEST_KEYS as readonly string[]).includes(key))) return false;
  if (!Object.hasOwn(record, "intent") || typeof record.intent !== "string" || !(COLLECTOR_INTEGRATION_INTENTS as readonly string[]).includes(record.intent)) return false;
  for (const flag of ["confirmReplaceForeign", "proceedWithoutChrome"] as const) {
    if (record[flag] !== undefined && typeof record[flag] !== "boolean") return false;
  }
  if (record.confirmReplaceForeign !== undefined && record.intent !== "setup" && record.intent !== "repair") return false;
  if (record.proceedWithoutChrome !== undefined && record.intent !== "setup") return false;
  return true;
}

/**
 * Copy of `COLLECTOR_NOTICE_IDS` (the notices module imports `node:fs`, which the preload must not
 * load). A unit test asserts the two stay equal.
 */
export const COLLECTOR_NOTICE_ID_VALUES: readonly string[] = Object.freeze([
  "collector.notice.updated",
  "collector.notice.repair",
  "collector.notice.alpha1-migration",
]);

export function isCollectorNoticeId(value: unknown): value is string {
  return typeof value === "string" && COLLECTOR_NOTICE_ID_VALUES.includes(value);
}

// ----- Results ------------------------------------------------------------------------------

/** Everything safe for the renderer. Deliberately has no path field. */
export interface CollectorIntegrationStatus {
  readonly state: CollectorIntegrationState;
  readonly reasons: readonly CollectorIntegrationReason[];
  readonly inspectionComplete: boolean;
  readonly registration: "absent" | "ours" | "foreign" | "unknown";
  readonly chrome: { readonly status: "found" | "not-found" | "unknown"; readonly defaultBrowser: DefaultBrowserKind };
  readonly policy: {
    readonly blocked: boolean;
    readonly userLevelHostsDisabled: boolean;
    readonly hostBlocked: boolean;
    readonly extensionLoadMayBeBlocked: boolean;
  };
  readonly installed: { readonly hostVersion: string | null; readonly extensionVersion: string | null };
  readonly payloadStatus: "valid" | "invalid" | "unavailable";
  /** The extension folder exists as part of a recorded installation (so it can be copied or opened). */
  readonly extensionFolderPlaced: boolean;
  readonly writesAllowed: boolean;
}

export type CollectorConnectionSummary =
  /** No contact record yet (or one that cannot be read as a valid record). */
  | { readonly state: "waiting" }
  | { readonly state: "connected"; readonly extensionVersion: string; readonly hostVersion: string; readonly contactedAt: string }
  | { readonly state: "extension-version-differs"; readonly loadedVersion: string; readonly placedVersion: string | null }
  | { readonly state: "protocol-differs" }
  /** The integration folder cannot be trusted or read: the wizard falls back to user confirmation. */
  | { readonly state: "unavailable" };

export type CollectorIntegrationUnavailableReason = "e2e-isolation" | "payload-unavailable" | "startup-failed";

export type CollectorIntegrationResponse =
  | { readonly kind: "unavailable"; readonly reason: CollectorIntegrationUnavailableReason }
  | { readonly kind: "invalid-request" }
  | { readonly kind: "busy" }
  | { readonly kind: "error" }
  | { readonly kind: "status"; readonly status: CollectorIntegrationStatus }
  /** `setup` / `repair` / `remove` ran (or was refused by the apply preconditions: see `outcome` / `reason`). */
  | {
    readonly kind: "apply";
    readonly action: CollectorApplyAction;
    readonly outcome: CollectorApplyOutcome;
    readonly reason: CollectorApplyReason | null;
    readonly warnings: readonly CollectorApplyWarning[];
    readonly selfCheck: "ok" | "failed" | "skipped";
    readonly status: CollectorIntegrationStatus;
    /** `remove` with the confirmation checkbox: what happened to the save destination setting. */
    readonly saveDestination?: CollectorSaveDestinationIpcResult["kind"];
  }
  /** `remove`: the user declined the confirmation. Nothing changed. */
  | { readonly kind: "cancelled" }
  /** `setup`: Chrome was not found (or could not be determined) and `proceedWithoutChrome` was not set. Nothing written. */
  | { readonly kind: "chrome-required"; readonly status: CollectorIntegrationStatus }
  | { readonly kind: "chrome-extensions"; readonly result: "opened" | "chrome-not-found" | "failed" }
  | { readonly kind: "extension-folder"; readonly intent: "copyExtensionPath" | "revealExtensionFolder"; readonly result: "done" | "unavailable" | "failed" }
  | { readonly kind: "connection"; readonly state: CollectorIntegrationState; readonly connection: CollectorConnectionSummary };

// ----- Notices ------------------------------------------------------------------------------

/**
 * The notice model already carries only ids, copy, versions and command IDs. This guard checks the
 * shape the preload accepts from the main process (defence in depth against a malformed event).
 */
export function isCollectorNoticeList(value: unknown): value is readonly CollectorNotice[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  return value.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const notice = item as Record<string, unknown>;
    if (!isCollectorNoticeId(notice.id) || typeof notice.title !== "string" || notice.title.length > 400) return false;
    if (notice.kind !== "updated" && notice.kind !== "repair" && notice.kind !== "alpha1-migration") return false;
    if (notice.detail !== null && (typeof notice.detail !== "string" || notice.detail.length > 800)) return false;
    if (!Array.isArray(notice.actions) || notice.actions.length > 4) return false;
    return notice.actions.every((action) => {
      if (action === null || typeof action !== "object" || Array.isArray(action)) return false;
      const entry = action as Record<string, unknown>;
      if (typeof entry.commandId !== "string" || !/^maginalia\.collector\.[A-Za-z]+$/u.test(entry.commandId)) return false;
      if (typeof entry.label !== "string" || entry.label.length > 80) return false;
      if (entry.argument !== undefined) {
        const argument = entry.argument as Record<string, unknown> | null;
        if (argument === null || typeof argument !== "object" || !isCollectorNoticeId(argument.noticeId)) return false;
      }
      return entry.closesNoticeId === undefined || isCollectorNoticeId(entry.closesNoticeId);
    });
  });
}
