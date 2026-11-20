/**
 * Collector integration service (main process, WP-7 slice A).
 *
 * The single object the IPC handlers, the startup run and the focus / interval reconcile talk to.
 * Every side effect is injected, so the rules below are unit-tested with fakes; nothing here
 * imports Electron.
 *
 *  - Apply-class operations (`setup`, `repair`, `remove`, and the startup `refresh`) run one at a
 *    time through ONE gate (`createCollectorApplyGate`). A user intent that arrives while another
 *    apply is running or queued is answered `busy` immediately (no queueing of user clicks, so a
 *    repeated click can never replay a stale `remove` after a `setup`). The startup refresh QUEUES
 *    behind a user apply instead of failing, because it has no user to retry it.
 *  - Every apply result is handed to the orchestrator (`recordApplyResult`) and the resulting
 *    notice list is published.
 *  - `setup` refuses without a supported browser unless the user explicitly continued (design 4.2). `remove`
 *    always asks for confirmation here, in the main process, so the renderer cannot remove the
 *    integration on its own.
 *  - Results are summaries (`collector-integration-ipc.ts`): no machine-local path is returned and
 *    nothing here logs one. Errors are logged by code only.
 */
import type { CollectorNotice } from "./collector-integration-notices.js";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types.js";
import { COLLECTOR_BROWSERS, type CollectorBrowserId } from "./collector-browser-table.js";
import type { BrowserLocation, CollectorInspectOptions, CollectorIntegrationInspection } from "./collector-integration-types.js";
import type { CollectorStartupRefresh, CollectorStartupResult } from "./collector-startup-refresh.js";
import type { CollectorIntegrationRuntimeMode } from "./collector-startup-refresh-composition.js";
import {
  isCollectorIntegrationRequest,
  isCollectorNoticeId,
  type CollectorConnectionSummary,
  type CollectorIntegrationRequest,
  type CollectorIntegrationResponse,
  type CollectorIntegrationStatus,
} from "./collector-integration-ipc.js";
import type { CollectorSaveDestinationIpcResult } from "./collector-save-destination-ipc.js";

// ----- Serialization gate --------------------------------------------------------------------

export interface CollectorApplyGate {
  /** Runs `task` when nothing is running or queued; otherwise resolves `{ ran: false }` without running it. */
  tryRun<T>(task: () => Promise<T>): Promise<{ readonly ran: true; readonly value: T } | { readonly ran: false }>;
  /** Runs `task` after everything already running or queued. */
  queue<T>(task: () => Promise<T>): Promise<T>;
  readonly busy: boolean;
  /** Incremented when a task starts and again when it ends (any task, including the startup refresh). */
  readonly generation: number;
}

export function createCollectorApplyGate(): CollectorApplyGate {
  let pending = 0;
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    pending += 1; // synchronous: two overlapping callers can never both see an idle gate
    // The counter drops before the caller's promise settles, so a follow-up call never sees a stale "busy".
    const result = tail.then(async () => {
      generation += 1;
      try {
        return await task();
      } finally {
        generation += 1;
      }
    }).finally(() => { pending -= 1; });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    queue: enqueue,
    async tryRun<T>(task: () => Promise<T>) {
      if (pending > 0) return { ran: false as const };
      return { ran: true as const, value: await enqueue(task) };
    },
    get busy() {
      return pending > 0;
    },
    get generation() {
      return generation;
    },
  };
}

// ----- Dependencies --------------------------------------------------------------------------

export interface CollectorIntegrationServiceDependencies {
  readonly mode: CollectorIntegrationRuntimeMode;
  readonly startupRefresh: CollectorStartupRefresh;
  readonly inspect: (options?: CollectorInspectOptions) => Promise<CollectorIntegrationInspection>;
  readonly apply: (request: CollectorApplyRequest) => Promise<CollectorApplyResult>;
  /** Main-process locator of one table row; the path it returns never leaves the main process. */
  readonly locateBrowser: (id: CollectorBrowserId) => Promise<BrowserLocation>;
  /** The gate also handed to the composition's `wrapApply`, so the startup refresh shares it. */
  readonly gate: CollectorApplyGate;
  /** Detached launch of the validated browser executable with the row's fixed arguments. `false` on failure. */
  readonly launchBrowser: (executablePath: string, args: readonly string[]) => Promise<boolean>;
  readonly writeClipboardText: (text: string) => void;
  /** Opens an https URL in the user's default browser. `false` on failure. Only ever called with a table constant. */
  readonly openExternal: (url: string) => Promise<boolean>;
  /** Opens a folder in the shell. `false` when it could not be opened. */
  readonly openFolder: (folder: string) => Promise<boolean>;
  /** Native confirmation owned by the main process (design 5, removal copy). */
  readonly confirmRemove: () => Promise<{ readonly confirmed: boolean; readonly clearSaveDestination: boolean }>;
  /** The existing `maginalia.collector.clearSaveDestination` implementation. */
  readonly clearSaveDestination: () => Promise<CollectorSaveDestinationIpcResult>;
  /** Called with the full active notice list whenever it changed. */
  readonly publishNotices: (notices: readonly CollectorNotice[]) => void;
  /** Logs a stable code (never a path or an error message). */
  readonly logError: (code: string, error?: unknown) => void;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export const COLLECTOR_RECONCILE_INTERVAL_MS = 60_000;

export interface CollectorIntegrationService {
  /** Handles one renderer request. Never throws and never returns a path. */
  handle(request: unknown): Promise<CollectorIntegrationResponse>;
  /** Startup refresh and notice evaluation. Never throws. Publishes the notices. */
  runStartup(): Promise<CollectorStartupResult | undefined>;
  /** Re-evaluates the "updated" notice (window focus, interval). Never throws. */
  reconcile(): Promise<void>;
  /**
   * The renderer asked for the notices (first call: it can show them). Releases the one-time alpha1
   * notice and returns the active list. Never throws.
   */
  connectNoticeSurface(): Promise<readonly CollectorNotice[]>;
  /** The renderer closed a notice. Invalid ids are ignored. Never throws. */
  dismissNotice(noticeId: unknown): Promise<readonly CollectorNotice[]>;
  currentNotices(): readonly CollectorNotice[];
  /** Starts the periodic `reconcile`. Idempotent. */
  startPeriodicReconcile(intervalMs?: number): void;
  stop(): void;
}

// ----- Summaries -----------------------------------------------------------------------------

export function summarizeInspection(
  inspection: CollectorIntegrationInspection,
  applyInProgress = false,
  preferred: CollectorBrowserId | null = null,
): CollectorIntegrationStatus {
  return Object.freeze({
    applyInProgress,
    state: inspection.state,
    reasons: Object.freeze([...inspection.reasons]),
    inspectionComplete: inspection.inspectionComplete,
    registration: inspection.registration,
    browsers: Object.freeze({
      defaultBrowser: inspection.browsers.defaultBrowser,
      recommended: inspection.browsers.recommended,
      recommendationReason: inspection.browsers.recommendationReason,
      preferred,
      entries: Object.freeze(inspection.browsers.entries.map((entry) => Object.freeze({
        id: entry.id,
        verification: entry.verification,
        installed: entry.installed,
        registration: entry.effective.ownership,
        registrationVia: entry.effective.target,
        policyBlocked: entry.policy.blocked,
        extensionLoadMayBeBlocked: entry.policy.extensionLoadMayBeBlocked,
        // A fixed table constant (for example "chrome://extensions"), never a path.
        extensionsAddress: COLLECTOR_BROWSERS.find((row) => row.id === entry.id)?.extensionsPage.displayUrl ?? "",
      }))),
    }),
    policy: Object.freeze({
      blocked: inspection.policy.blocked,
      userLevelHostsDisabled: inspection.policy.userLevelHostsDisabled,
      hostBlocked: inspection.policy.hostBlocked,
      extensionLoadMayBeBlocked: inspection.policy.extensionLoadMayBeBlocked,
    }),
    installed: Object.freeze({ hostVersion: inspection.installed.hostVersion, extensionVersion: inspection.installed.extensionVersion }),
    payloadStatus: inspection.payload.status,
    extensionFolderPlaced: inspection.installed.extensionVersion !== null && inspection.extensionFolderDisplay !== null,
    writesAllowed: inspection.writesAllowed,
  });
}

export function summarizeConnection(inspection: CollectorIntegrationInspection): CollectorConnectionSummary {
  const contact = inspection.contact;
  if (contact.status === "absent") return { state: "waiting" };
  if (contact.status === "unavailable") return { state: "unavailable" };
  if (contact.status === "invalid") {
    // A record that cannot be read or parsed right now is treated as transient (the Host rewrites it
    // atomically); only a protocol mismatch or a reparse point is a standing condition.
    if (contact.reason === "wrong-protocol") return { state: "protocol-differs" };
    return contact.reason === "reparse-point" ? { state: "unavailable" } : { state: "waiting" };
  }
  // Only the exact placed version counts as connected; a newer or unparseable loaded version is a mismatch too.
  if (contact.extensionVersionVsPlaced === "equal") {
    return { state: "connected", extensionVersion: contact.record.extensionVersion, hostVersion: contact.record.hostVersion, contactedAt: contact.record.contactedAt };
  }
  return { state: "extension-version-differs", loadedVersion: contact.record.extensionVersion, placedVersion: inspection.installed.extensionVersion };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function noticeKey(notices: readonly CollectorNotice[]): string {
  return JSON.stringify(notices.map((notice) => [notice.id, notice.kind, notice.title, notice.detail]));
}

// ----- Service -------------------------------------------------------------------------------

export function createCollectorIntegrationService(deps: CollectorIntegrationServiceDependencies): CollectorIntegrationService {
  let lastPublished = noticeKey([]);
  let timer: unknown;
  /**
   * The gate's generation changes when any apply starts and when it ends. A read-only inspection is
   * shared only within one generation, so nobody receives a snapshot that started before an apply
   * began (or ended) as if it were current. Inspections that run DURING an apply may still see a
   * half-written installation: their status carries `applyInProgress: true` and slice B must ignore it.
   */
  let inspectInFlight: { readonly generation: number; readonly promise: Promise<CollectorIntegrationInspection> } | undefined;

  const unavailableReason = (): "e2e-isolation" | "payload-unavailable" | undefined =>
    deps.mode === "inert-e2e-isolation" ? "e2e-isolation" : deps.mode === "inert-no-payload" ? "payload-unavailable" : undefined;

  function publish(notices: readonly CollectorNotice[]): void {
    const key = noticeKey(notices);
    if (key === lastPublished) return;
    lastPublished = key;
    try {
      deps.publishNotices(notices);
    } catch (error: unknown) {
      deps.logError("MAGINALIA_COLLECTOR_NOTICE_PUBLISH_FAILED", error);
    }
  }

  /** Read-only inspections share one run: a fast poll never stacks inspections. */
  function inspectShared(): Promise<CollectorIntegrationInspection> {
    if (inspectInFlight !== undefined && inspectInFlight.generation === deps.gate.generation) return inspectInFlight.promise;
    const entry: { generation: number; promise: Promise<CollectorIntegrationInspection> } = {
      generation: deps.gate.generation,
      promise: deps.inspect({ verifyFileHashes: false }).finally(() => { if (inspectInFlight === entry) inspectInFlight = undefined; }),
    };
    inspectInFlight = entry;
    return entry.promise;
  }

  /** The remembered browser; a failure reads as "none". */
  async function preferredBrowser(): Promise<CollectorBrowserId | null> {
    try {
      return await deps.startupRefresh.preferredBrowser();
    } catch (error: unknown) {
      deps.logError("MAGINALIA_COLLECTOR_PREFERRED_BROWSER_READ_FAILED", error);
      return null;
    }
  }

  async function rememberBrowser(browser: CollectorBrowserId): Promise<void> {
    try {
      await deps.startupRefresh.setPreferredBrowser(browser);
    } catch (error: unknown) {
      deps.logError("MAGINALIA_COLLECTOR_PREFERRED_BROWSER_WRITE_FAILED", error);
    }
  }

  /** `chosenBrowser` (setup only): remembered once the apply succeeded (applied / noop) and the row is usable, so the returned status already shows it. */
  async function runApply(request: CollectorApplyRequest, chosenBrowser?: CollectorBrowserId): Promise<CollectorIntegrationResponse> {
    const outcome = await deps.gate.tryRun(runExclusive);
    if (!outcome.ran) return { kind: "busy" };
    return toResponse(outcome.value, await preferredBrowser());

    async function runExclusive() {
      let extra: Partial<{ saveDestination: CollectorSaveDestinationIpcResult["kind"] }> = {};
      if (request.action === "remove") {
        const confirmation = await deps.confirmRemove();
        if (!confirmation.confirmed) return { kind: "cancelled" } as const;
        // Q9: record the request before anything is deleted (a refused apply puts it back in recordApplyResult).
        try {
          await deps.startupRefresh.beginRemove();
        } catch (error: unknown) {
          deps.logError("MAGINALIA_COLLECTOR_BEGIN_REMOVE_FAILED", error);
        }
        let result: CollectorApplyResult;
        try {
          result = await deps.apply(request);
        } catch (error: unknown) {
          // Decision 4: `removeRequested` (set by `beginRemove`) stays set; tell the user the removal did not finish.
          deps.logError("MAGINALIA_COLLECTOR_REMOVE_APPLY_FAILED", error);
          try {
            await deps.startupRefresh.recordRemoveFailure();
          } catch (recordError: unknown) {
            deps.logError("MAGINALIA_COLLECTOR_RECORD_REMOVE_FAILURE_FAILED", recordError);
          }
          publish(deps.startupRefresh.currentNotices());
          throw error;
        }
        await recordSafely(result);
        // A refused removal changed nothing: the save destination setting stays too.
        if (confirmation.clearSaveDestination && result.outcome !== "refused") {
          try {
            extra = { saveDestination: (await deps.clearSaveDestination()).kind };
          } catch (error: unknown) {
            deps.logError("MAGINALIA_COLLECTOR_CLEAR_SAVE_DESTINATION_FAILED", error);
            extra = { saveDestination: "error" };
          }
        }
        return { kind: "result", result, extra } as const;
      }
      const result = await deps.apply(request);
      await recordSafely(result);
      if (chosenBrowser !== undefined && (result.outcome === "applied" || result.outcome === "noop")) {
        // Only a usable choice is remembered: verified, installed and not blocked by policy.
        const entry = result.inspection.browsers.entries.find((candidate) => candidate.id === chosenBrowser);
        if (entry !== undefined && entry.verification === "verified" && entry.installed === "found" && !entry.policy.blocked) await rememberBrowser(chosenBrowser);
      }
      return { kind: "result", result, extra } as const;
    }

    function toResponse(value: Awaited<ReturnType<typeof runExclusive>>, preferred: CollectorBrowserId | null): CollectorIntegrationResponse {
    if (value.kind === "cancelled") return { kind: "cancelled" };
    const { result, extra } = value;
    return {
      kind: "apply",
      action: result.action,
      outcome: result.outcome,
      reason: result.reason,
      warnings: Object.freeze([...result.warnings]),
      selfCheck: result.selfCheck,
      // A failed self-check leaves the files "ready" on disk but the integration unusable: say so (apply reports it as damaged).
      status: result.selfCheck === "failed" ? { ...summarizeInspection(result.inspection, false, preferred), state: result.state } : summarizeInspection(result.inspection, false, preferred),
      ...extra,
    };
    }
  }

  async function recordSafely(result: CollectorApplyResult): Promise<void> {
    try {
      await deps.startupRefresh.recordApplyResult(result);
    } catch (error: unknown) {
      deps.logError("MAGINALIA_COLLECTOR_RECORD_APPLY_FAILED", error);
    }
    publish(deps.startupRefresh.currentNotices());
  }

  async function handleValidated(request: CollectorIntegrationRequest): Promise<CollectorIntegrationResponse> {
    switch (request.intent) {
      case "inspect":
        return { kind: "status", status: summarizeInspection(await inspectShared(), deps.gate.busy, await preferredBrowser()) };
      case "checkConnection": {
        const inspection = await inspectShared();
        return { kind: "connection", state: inspection.state, applyInProgress: deps.gate.busy, connection: summarizeConnection(inspection) };
      }
      case "setup": {
        if (request.proceedWithoutSupportedBrowser !== true) {
          const inspection = await inspectShared();
          // Design 7.2: a verified, installed browser that policy does not block must exist.
          const usable = inspection.browsers.entries.some((entry) => entry.verification === "verified" && entry.installed === "found" && !entry.policy.blocked);
          if (!usable) return { kind: "browser-required", status: summarizeInspection(inspection, deps.gate.busy, await preferredBrowser()) };
        }
        return runApply({ action: "setup", ...(request.confirmReplaceForeign === true ? { confirmReplaceForeign: true } : {}) }, request.browser);
      }
      case "repair":
        return runApply({ action: "repair", ...(request.confirmReplaceForeign === true ? { confirmReplaceForeign: true } : {}) });
      case "remove":
        return runApply({ action: "remove" });
      case "openBrowserExtensions": {
        // The renderer names at most a table row id. The executable comes from the main-process locator
        // and the arguments from the row: nothing here is taken from the request.
        // Order (design 7.2): the named row, then the remembered choice, then the recommendation.
        const target: CollectorBrowserId | null = request.browser ?? (await preferredBrowser()) ?? (await inspectShared()).browsers.recommended;
        const row = target === null ? undefined : COLLECTOR_BROWSERS.find((entry) => entry.id === target);
        if (target === null || row === undefined) return { kind: "browser-extensions", browser: target, result: "browser-not-found" };
        const location = await deps.locateBrowser(target);
        if (location.status !== "found") return { kind: "browser-extensions", browser: target, result: "browser-not-found" };
        const launched = await deps.launchBrowser(location.executablePath, row.extensionsPage.launchArguments);
        // Only an explicit choice is remembered: a recommendation the user never saw is not a preference.
        if (launched && request.browser !== undefined) await rememberBrowser(request.browser);
        return { kind: "browser-extensions", browser: target, result: launched ? "opened" : "failed" };
      }
      case "openBrowserDownloadPage": {
        // The renderer names at most a table row id; the URL is the row's main-process constant (https only).
        const row = request.browser === undefined ? undefined : COLLECTOR_BROWSERS.find((entry) => entry.id === request.browser);
        const url = row?.downloadUrl;
        if (typeof url !== "string" || !isHttpsUrl(url)) return { kind: "browser-download", result: "not-offered" };
        return { kind: "browser-download", result: (await deps.openExternal(url)) ? "opened" : "failed" };
      }
      case "copyExtensionPath":
      case "revealExtensionFolder": {
        const inspection = await inspectShared();
        const folder = inspection.extensionFolderDisplay;
        if (folder === null || inspection.installed.extensionVersion === null) return { kind: "extension-folder", intent: request.intent, result: "unavailable" };
        if (request.intent === "copyExtensionPath") {
          deps.writeClipboardText(folder);
          return { kind: "extension-folder", intent: request.intent, result: "done" };
        }
        return { kind: "extension-folder", intent: request.intent, result: (await deps.openFolder(folder)) ? "done" : "failed" };
      }
    }
  }

  async function reconcile(): Promise<void> {
    try {
      publish(await deps.startupRefresh.reconcile());
    } catch (error: unknown) {
      deps.logError("MAGINALIA_COLLECTOR_RECONCILE_FAILED", error);
    }
  }

  return {
    async handle(value: unknown): Promise<CollectorIntegrationResponse> {
      if (!isCollectorIntegrationRequest(value)) return { kind: "invalid-request" };
      const reason = unavailableReason();
      if (reason !== undefined) return { kind: "unavailable", reason };
      try {
        return await handleValidated(value);
      } catch (error: unknown) {
        deps.logError("MAGINALIA_COLLECTOR_INTEGRATION_REQUEST_FAILED", error);
        return { kind: "error" };
      }
    },

    async runStartup(): Promise<CollectorStartupResult | undefined> {
      try {
        const result = await deps.startupRefresh.runStartup();
        publish(result.notices);
        return result;
      } catch (error: unknown) {
        deps.logError("MAGINALIA_COLLECTOR_STARTUP_FAILED", error);
        return undefined;
      }
    },

    reconcile,

    async dismissNotice(noticeId: unknown): Promise<readonly CollectorNotice[]> {
      if (!isCollectorNoticeId(noticeId)) return deps.startupRefresh.currentNotices();
      try {
        const notices = await deps.startupRefresh.dismiss(noticeId);
        publish(notices);
        return notices;
      } catch (error: unknown) {
        deps.logError("MAGINALIA_COLLECTOR_DISMISS_FAILED", error);
        return deps.startupRefresh.currentNotices();
      }
    },

    async connectNoticeSurface(): Promise<readonly CollectorNotice[]> {
      try {
        const notices = await deps.startupRefresh.markNoticeSurfaceReady();
        publish(notices);
        return notices;
      } catch (error: unknown) {
        deps.logError("MAGINALIA_COLLECTOR_NOTICE_SURFACE_FAILED", error);
        return deps.startupRefresh.currentNotices();
      }
    },

    currentNotices: () => deps.startupRefresh.currentNotices(),

    startPeriodicReconcile(intervalMs = COLLECTOR_RECONCILE_INTERVAL_MS): void {
      if (timer !== undefined || unavailableReason() !== undefined) return;
      const set = deps.setInterval ?? ((callback, ms) => {
        const handle = setInterval(callback, ms);
        handle.unref?.();
        return handle;
      });
      timer = set(() => { void reconcile(); }, intervalMs);
    },

    stop(): void {
      if (timer === undefined) return;
      (deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout)))(timer);
      timer = undefined;
    },
  };
}

