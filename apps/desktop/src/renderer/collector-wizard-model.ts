/**
 * Collector integration wizard: pure state model (S8 / WP-7 slice B, step B2).
 *
 * `reduceWizard(state, event)` returns the next state and a list of EFFECTS: data that tells the
 * panel (slice B3) what to do. The model itself never touches the DOM, `window`, Electron, a timer
 * or the clock: time arrives as `event.now` (milliseconds, any monotonic origin) and requests leave
 * as `request` / `configureSaveDestination` effects. The panel runs an effect, then feeds the
 * outcome back as a `response` / `destinationResult` / `requestFailed` / `clipboardResult` event.
 *
 * Design: docs/collector-wizard-integration-design.md 4 (steps A to E, 4.6 connection check, 4.7
 * keyboard) as amended by docs/collector-multi-browser-design.md 2.3, 2.4, 7.
 *
 * EFFECT EXECUTOR CONTRACT (the panel, slice B3, must honour all of this):
 * - `event.now` must come from `performance.now()` (monotonic), never `Date.now()`: a wall-clock jump would
 *   fire or skip a poll or the 3-minute timeout. A non-finite `now` is ignored; a clock that goes backwards
 *   counts as no time passing.
 * - Run `focusHeading` after the render that shows the new step, not before.
 * - `ticker` is idempotent: start it if inactive, stop it if active, never stack timers. Stop it when the panel closes.
 * - `copyText` must be answered with exactly one `clipboardResult` (after the clipboard call settles).
 * - Every async result (`response`, `destinationResult`, `requestFailed`, `clipboardResult`) must be bound to the
 *   wizard instance that issued the effect and DROPPED after that instance closed. `nextRequestId` restarts at 0
 *   when a wizard is recreated, so an old instance's pending promise must never answer a new instance.
 * - Dispatch only the events `wizardActions(state)` lists as enabled, plus `tick`, `radioKey`, `selectBrowser`,
 *   `escape` and the result events above. A disallowed event is ignored by the model anyway.
 *
 * Invariants kept here:
 * - Nothing is written before the user presses the step B button. `confirmReplaceForeign` and
 *   `proceedWithoutSupportedBrowser` are sent only after an explicit user event for each.
 * - One blocking operation at a time. Other operation events are ignored (not queued) while one is
 *   in flight. A connection poll is not blocking: any user event cancels it.
 * - Requests carry enumerated intents and a browser id only. No path, URL or free text leaves, and
 *   none is held in state (the response types carry none).
 * - A `status` / `connection` carrying `applyInProgress: true` is discarded, never shown or acted on.
 */
import {
  COLLECTOR_BROWSERS,
  type CollectorBrowserId,
  type CollectorBrowserSpec,
  type CollectorRecommendationReason,
} from "../collector-browser-table";
import type { CollectorApplyReason } from "../collector-integration-apply-types";
import type {
  CollectorIntegrationRequest,
  CollectorIntegrationResponse,
  CollectorIntegrationStatus,
} from "../collector-integration-ipc";
import type { CollectorSaveDestinationIpcResult } from "../collector-save-destination-ipc";
import {
  buildWizardCopy,
  wizardProgressLabel,
  WIZARD_MESSAGE_ROLE,
  type WizardCopy,
  type WizardCopyContext,
  type WizardMessageCopy,
  type WizardMessageId,
  type WizardMessageRole,
  type WizardReasonCopy,
} from "./collector-wizard-copy";

// ----- Timing (design 4.6) -----------------------------------------------------------------------

/** The panel asks for the next contact record at most this often. */
export const WIZARD_POLL_INTERVAL_MS = 2_000;
/** Waiting for the extension ends here (design 4.6: "Timed out (3 min)"). Inclusive. */
export const WIZARD_CONNECTION_TIMEOUT_MS = 180_000;
/**
 * A blocking request (setup, repair, destination, placement ...) that has not answered after this much
 * wall-clock time offers 「キャンセル」. Measured from timestamps (`event.now`), never from counted ticks,
 * so minimising the window or a sleeping machine cannot stall it. The connection-check poll is excluded
 * (it has `WIZARD_CONNECTION_TIMEOUT_MS`).
 */
export const WIZARD_INFLIGHT_CANCEL_MS = 180_000;
/** How often the panel should send `tick` while a `ticker` effect is active. Resolution only; not a poll interval. */
export const WIZARD_TICK_INTERVAL_MS = 1_000;

// ----- Types -------------------------------------------------------------------------------------

export type WizardStepId = "A" | "B" | "C" | "D" | "E" | "done";
type WizardResultStep = "A" | "B" | "C" | "D";

export type WizardConnectionPhase =
  | "waiting"
  | "connected"
  | "extension-version-differs"
  | "protocol-differs"
  | "unavailable"
  | "timed-out"
  | "user-confirmed";

export interface WizardConnection {
  readonly phase: WizardConnectionPhase;
  /** `now` of the event that began this waiting round. */
  readonly startedAt: number;
  /** `now` of the last poll request; `null` right after a discarded response (poll at the next tick). */
  readonly lastPollAt: number | null;
  readonly loadedVersion: string | null;
  readonly placedVersion: string | null;
}

type WizardOperation =
  | "inspect"
  | "recheck-browsers"
  | "download"
  | "setup"
  | "destination"
  | "placement"
  | "open-browser"
  | "copy-path"
  | "reveal"
  | "poll";

export interface WizardInFlight {
  readonly requestId: number;
  readonly operation: WizardOperation;
  /** `now` of the event that issued the request (stamped by `reduceWizard`); `null` only inside the reducer. */
  readonly startedAt: number | null;
  /** The watchdog fired: `cancelInFlight` is allowed and the panel should show the slow-response notice. */
  readonly cancelOffered: boolean;
}

export type WizardClosedOutcome = "later" | "finished";

export interface WizardState {
  readonly step: WizardStepId;
  /** Set when the panel must close. Every later event is ignored. */
  readonly closed: WizardClosedOutcome | null;
  /** The latest accepted inspection (never one with `applyInProgress`). */
  readonly status: CollectorIntegrationStatus | null;
  /** Step A: the first inspection is running (`loading`), done (`ready`) or could not be read (`failed`). */
  readonly statusLoad: "loading" | "ready" | "failed";
  /** The radiogroup selection. Used by steps B to E and for wording. */
  readonly selectedBrowser: CollectorBrowserId | null;
  /** The user explicitly chose to continue without a detected browser (sent as `proceedWithoutSupportedBrowser`). */
  readonly proceedWithoutBrowser: boolean;
  /** The result or notice shown on each step. It survives going back and forward. */
  readonly results: Readonly<Partial<Record<WizardResultStep, WizardMessageId>>>;
  /** Step D: whether the extension folder is known to be placed. */
  readonly placement: "unknown" | "checking" | "placed" | "missing";
  /** Step E. `null` until the user presses 「読み込みました」. */
  readonly connection: WizardConnection | null;
  /** How the wizard ended, for the done screen: `user-confirmed` is never shown as verified. */
  readonly verification: "connected" | "user-confirmed" | null;
  /** The last step B attempt ended in a failed self-check: a later `noop` must not read as success. */
  readonly selfCheckFailed: boolean;
  readonly inFlight: WizardInFlight | null;
  readonly nextRequestId: number;
}

export function initialWizardState(): WizardState {
  return Object.freeze({
    step: "A",
    closed: null,
    status: null,
    statusLoad: "loading",
    selectedBrowser: null,
    proceedWithoutBrowser: false,
    results: Object.freeze({}),
    placement: "unknown",
    connection: null,
    verification: null,
    selfCheckFailed: false,
    inFlight: null,
    nextRequestId: 0,
  });
}

export type WizardRadioKey = "ArrowDown" | "ArrowRight" | "ArrowUp" | "ArrowLeft" | "Home" | "End";

/** Events produced by the user (a button, a key). The `type` equals the action id the panel dispatches. */
export type WizardUserEvent =
  | { readonly type: "selectBrowser"; readonly browser: CollectorBrowserId }
  | { readonly type: "radioKey"; readonly key: WizardRadioKey }
  | { readonly type: "next" }
  | { readonly type: "back" }
  | { readonly type: "later" }
  /** The Escape key: the same as 「あとで設定」 (and 「閉じる」 on the last screen). */
  | { readonly type: "escape" }
  | { readonly type: "recheckBrowsers" }
  | { readonly type: "openDownloadPage"; readonly browser: CollectorBrowserId }
  | { readonly type: "continueWithoutBrowser" }
  | { readonly type: "register" }
  | { readonly type: "confirmForeign" }
  | { readonly type: "declineForeign" }
  | { readonly type: "confirmDestination" }
  /** Step C after destination-error / destination-busy: opens the destination picker again (same effect as `confirmDestination`). */
  | { readonly type: "chooseDestinationAgain" }
  /**
   * Abort a blocking request that has not answered for `WIZARD_INFLIGHT_CANCEL_MS`. Only forgets the request:
   * nothing already written is rolled back, and a late answer is discarded.
   */
  | { readonly type: "cancelInFlight" }
  | { readonly type: "retryPlacement" }
  | { readonly type: "openBrowserExtensions" }
  | { readonly type: "copyAddress" }
  | { readonly type: "copyPath" }
  | { readonly type: "revealFolder" }
  | { readonly type: "loaded" }
  | { readonly type: "recheckConnection" }
  | { readonly type: "waitAgain" }
  | { readonly type: "userConfirmed" }
  | { readonly type: "finish" }
  | { readonly type: "close" };

/** Events produced by the panel (lifecycle, timer, results of effects). */
export type WizardSystemEvent =
  | { readonly type: "opened" }
  | { readonly type: "tick" }
  | { readonly type: "response"; readonly requestId: number; readonly response: CollectorIntegrationResponse }
  | { readonly type: "destinationResult"; readonly requestId: number; readonly result: CollectorSaveDestinationIpcResult }
  /** The IPC call rejected or threw (no response arrived). */
  | { readonly type: "requestFailed"; readonly requestId: number }
  | { readonly type: "clipboardResult"; readonly purpose: "address"; readonly ok: boolean };

/** Every event carries the time it happened. The model never reads a clock. */
export type WizardEvent = (WizardUserEvent | WizardSystemEvent) & { readonly now: number };

export type WizardEffect =
  /** Run `runCollectorIntegration(request)`, then send `response` (or `requestFailed`) with the same `requestId`. */
  | { readonly type: "request"; readonly requestId: number; readonly request: CollectorIntegrationRequest }
  /** Run `configureCollectorSaveDestination()`, then send `destinationResult` (or `requestFailed`). */
  | { readonly type: "configureSaveDestination"; readonly requestId: number }
  /** Write `text` (a fixed browser address, never a path) to the clipboard, then send `clipboardResult`. */
  | { readonly type: "copyText"; readonly purpose: "address"; readonly text: string }
  /** Move keyboard focus to the step heading (`tabindex="-1"`). Emitted on step change only; polling never emits it. */
  | { readonly type: "focusHeading" }
  /** Move focus to the radio of `browser` (arrow keys move the selection and the focus together). */
  | { readonly type: "focusRadio"; readonly browser: CollectorBrowserId }
  /** Start or stop the `tick` timer. Idempotent. Off whenever nothing is being waited for. */
  | { readonly type: "ticker"; readonly active: boolean; readonly intervalMs: number }
  /** Close the panel. `later` writes nothing; it never undoes a completed write. */
  | { readonly type: "close"; readonly outcome: WizardClosedOutcome };

export interface WizardReduction {
  readonly state: WizardState;
  readonly effects: readonly WizardEffect[];
}

// ----- Browser options (step A radiogroup) -------------------------------------------------------

export interface WizardBrowserOption {
  readonly id: CollectorBrowserId;
  readonly recommended: boolean;
  readonly selectable: boolean;
  readonly note: "policy-blocked" | "detection-unknown" | null;
}

/**
 * The radiogroup of design 2.3: verified rows that were found (organization-blocked ones are shown
 * but cannot be chosen), plus, only when detection failed altogether, every verified row marked
 * 「確認できませんでした」. Table order.
 */
export function wizardBrowserOptions(
  status: CollectorIntegrationStatus | null,
  table: readonly CollectorBrowserSpec[] = COLLECTOR_BROWSERS,
): readonly WizardBrowserOption[] {
  if (status === null) return [];
  const detectionFailed = status.browsers.recommendationReason === "detection-failed";
  const options: WizardBrowserOption[] = [];
  for (const row of table) {
    if (row.verification !== "verified") continue;
    const entry = status.browsers.entries.find((candidate) => candidate.id === row.id);
    if (entry === undefined || entry.verification !== "verified") continue;
    const recommended = status.browsers.recommended === row.id;
    if (entry.installed === "found") {
      options.push({ id: row.id, recommended, selectable: !entry.policyBlocked, note: entry.policyBlocked ? "policy-blocked" : null });
    } else if (entry.installed === "unknown" && detectionFailed) {
      options.push({ id: row.id, recommended, selectable: !entry.policyBlocked, note: entry.policyBlocked ? "policy-blocked" : "detection-unknown" });
    }
  }
  return options;
}

/**
 * Arrow-key movement in the radiogroup (design 4.7). Only selectable options take part. Down and
 * Right go forward, Up and Left go back, both wrap at the ends; Home and End jump. With no current
 * selection, forward lands on the first and back on the last. Returns `null` when nothing is selectable.
 */
export function moveRadioSelection(
  options: readonly WizardBrowserOption[],
  current: CollectorBrowserId | null,
  key: WizardRadioKey,
): CollectorBrowserId | null {
  const ids = options.filter((option) => option.selectable).map((option) => option.id);
  if (ids.length === 0) return null;
  if (key === "Home") return ids[0]!;
  if (key === "End") return ids[ids.length - 1]!;
  const index = current === null ? -1 : ids.indexOf(current);
  const forward = key === "ArrowDown" || key === "ArrowRight";
  if (index < 0) return forward ? ids[0]! : ids[ids.length - 1]!;
  return ids[(index + (forward ? 1 : ids.length - 1)) % ids.length]!;
}

/** The selection after a new inspection: keep the user's choice if still selectable, else the recommendation. */
function reconcileSelection(current: CollectorBrowserId | null, status: CollectorIntegrationStatus): CollectorBrowserId | null {
  const options = wizardBrowserOptions(status);
  if (current !== null && options.some((option) => option.id === current && option.selectable)) return current;
  const recommended = status.browsers.recommended;
  if (recommended !== null && options.some((option) => option.id === recommended && option.selectable)) return recommended;
  return null;
}

/** Verified browsers that were found but are blocked by an organization policy. */
export function wizardBlockedBrowsers(status: CollectorIntegrationStatus | null): readonly CollectorBrowserId[] {
  return wizardBrowserOptions(status).filter((option) => option.note === "policy-blocked").map((option) => option.id);
}

/**
 * Every usable-looking browser is blocked by policy: the aggregate state says so, or the radiogroup is
 * not empty and nothing in it can be selected. The table reports this as "none-installed", which would
 * be the wrong message (the browsers are installed).
 */
export function wizardAllBrowsersBlocked(status: CollectorIntegrationStatus | null): boolean {
  if (status === null) return false;
  if (status.state === "policy-blocked") return true;
  const options = wizardBrowserOptions(status);
  return options.length > 0 && options.every((option) => !option.selectable && option.note === "policy-blocked");
}

const TERMINAL_UNAVAILABLE: readonly WizardMessageId[] = ["unavailable-e2e-isolation", "unavailable-payload-unavailable", "unavailable-startup-failed"];

function isSelectable(state: WizardState, browser: CollectorBrowserId | null): boolean {
  return browser !== null && wizardBrowserOptions(state.status).some((option) => option.id === browser && option.selectable);
}

// ----- Response classification (every kind, checked by the compiler) ------------------------------

type ResponseClass =
  | { readonly class: "unavailable"; readonly message: WizardMessageId }
  | { readonly class: "invalid" }
  | { readonly class: "busy" }
  | { readonly class: "status"; readonly status: CollectorIntegrationStatus }
  | { readonly class: "apply"; readonly response: Extract<CollectorIntegrationResponse, { kind: "apply" }> }
  | { readonly class: "cancelled" }
  | { readonly class: "browser-required"; readonly status: CollectorIntegrationStatus }
  | { readonly class: "browser-extensions"; readonly result: "opened" | "browser-not-found" | "failed" }
  | { readonly class: "browser-download"; readonly result: "opened" | "failed" | "not-offered" }
  | { readonly class: "extension-folder"; readonly intent: "copyExtensionPath" | "revealExtensionFolder"; readonly result: "done" | "unavailable" | "failed" }
  | { readonly class: "connection"; readonly response: Extract<CollectorIntegrationResponse, { kind: "connection" }> };

const UNAVAILABLE_MESSAGE: Readonly<Record<Extract<CollectorIntegrationResponse, { kind: "unavailable" }>["reason"], WizardMessageId>> = {
  "e2e-isolation": "unavailable-e2e-isolation",
  "payload-unavailable": "unavailable-payload-unavailable",
  "startup-failed": "unavailable-startup-failed",
};

/**
 * Compile-time exhaustiveness without a runtime throw: a value outside the type (a newer main process,
 * a malformed IPC answer) must degrade to a retryable error, never leave the wizard stuck.
 */
function unreachable(_value: never): void {
  // intentionally empty
}

/** One `switch` over every response kind; adding a kind to the IPC contract breaks the build here. */
export function classifyWizardResponse(response: CollectorIntegrationResponse): ResponseClass {
  switch (response.kind) {
    case "unavailable": {
      const message = (UNAVAILABLE_MESSAGE as Readonly<Record<string, WizardMessageId | undefined>>)[response.reason];
      return message === undefined ? { class: "invalid" } : { class: "unavailable", message };
    }
    case "invalid-request":
    case "error":
      return { class: "invalid" };
    case "busy":
      return { class: "busy" };
    case "status":
      return { class: "status", status: response.status };
    case "apply":
      return { class: "apply", response };
    case "cancelled":
      return { class: "cancelled" };
    case "browser-required":
      return { class: "browser-required", status: response.status };
    case "browser-extensions":
      return { class: "browser-extensions", result: response.result };
    case "browser-download":
      return { class: "browser-download", result: response.result };
    case "extension-folder":
      return { class: "extension-folder", intent: response.intent, result: response.result };
    case "connection":
      return { class: "connection", response };
    default:
      unreachable(response);
      return { class: "invalid" };
  }
}

/**
 * Step B: what each apply refusal or failure reads as. `Record` over the reason union: a new reason
 * does not compile until it is placed. "policy-blocked" is resolved to the generic or the
 * browser-named message at use.
 */
export const APPLY_REASON_MESSAGE: Readonly<Record<CollectorApplyReason, WizardMessageId | "policy-blocked">> = {
  "e2e-isolation": "unavailable-e2e-isolation",
  "policy-blocked": "policy-blocked",
  "inspection-incomplete": "register-failed",
  "wrong-state": "register-failed",
  "foreign-confirmation-required": "foreign-confirmation",
  "program-folder-unsafe": "folder-unsafe",
  "reparse-point-found": "folder-unsafe",
  "program-folder-unrecognized-content": "register-failed",
  "payload-unavailable": "unavailable-payload-unavailable",
  "registration-changed": "register-failed",
  "expected-targets-changed": "register-failed",
  "layout-unresolved": "register-failed",
  "busy": "busy",
  "file-locked": "file-locked",
  "source-changed": "register-failed",
  "hash-mismatch": "register-failed",
  "extension-verification-failed": "register-failed",
  "write-failed": "register-failed",
  "registry-write-denied": "registry-denied",
  "registry-write-failed": "registry-denied",
  "registry-readback-mismatch": "registry-denied",
  "unregister-failed": "register-failed",
  "self-check-failed": "self-check-failed",
};

/** `outdated-pending`: registered, and the main process updates it itself at the next start; the user may go on. */
const STEP_B_SUCCESS: readonly WizardMessageId[] = ["registered", "registered-verified", "already-ready", "refreshed", "outdated-pending"];
/** After these the step B button is gone: retrying cannot help. */
const STEP_B_TERMINAL: readonly WizardMessageId[] = [
  "folder-unsafe",
  "policy-blocked",
  "policy-blocked-browser",
  "unavailable-e2e-isolation",
  "unavailable-payload-unavailable",
  "unavailable-startup-failed",
  // No self-check-only retry exists. Re-opening the wizard re-evaluates the installation state from scratch (verified by B5).
  "self-check-failed",
];
const STEP_C_PROCEED: readonly WizardMessageId[] = ["destination-configured", "destination-writes-disabled", "destination-cancelled"];

// ----- Small state helpers -----------------------------------------------------------------------

const FOCUS_HEADING: WizardEffect = Object.freeze({ type: "focusHeading" });

function ticker(active: boolean): WizardEffect {
  return Object.freeze({ type: "ticker", active, intervalMs: WIZARD_TICK_INTERVAL_MS });
}

function withResult(state: WizardState, step: WizardResultStep, message: WizardMessageId | null): WizardState {
  const results = { ...state.results };
  if (message === null) delete results[step];
  else results[step] = message;
  return { ...state, results: Object.freeze(results) };
}

function dropPoll(state: WizardState): WizardState {
  return state.inFlight?.operation === "poll" ? { ...state, inFlight: null } : state;
}

function isBlocking(state: WizardState): boolean {
  return state.inFlight !== null && state.inFlight.operation !== "poll";
}

/** A running setup or a modal confirmation cannot be walked away from. */
function isMutating(state: WizardState): boolean {
  return state.inFlight?.operation === "setup" || state.inFlight?.operation === "destination";
}

function issue(state: WizardState, operation: WizardOperation, request: CollectorIntegrationRequest | null): { state: WizardState; effect: WizardEffect } {
  const requestId = state.nextRequestId + 1;
  const next: WizardState = { ...state, nextRequestId: requestId, inFlight: { requestId, operation, startedAt: null, cancelOffered: false } };
  return {
    state: next,
    effect: request === null
      ? Object.freeze({ type: "configureSaveDestination", requestId })
      : Object.freeze({ type: "request", requestId, request: Object.freeze(request) }),
  };
}

function setupRequest(state: WizardState, confirmReplaceForeign: boolean): CollectorIntegrationRequest {
  const repair = state.status?.state === "damaged" || state.status?.state === "registration-missing";
  if (repair) return confirmReplaceForeign ? { intent: "repair", confirmReplaceForeign: true } : { intent: "repair" };
  return {
    intent: "setup",
    ...(state.selectedBrowser === null ? {} : { browser: state.selectedBrowser }),
    ...(state.proceedWithoutBrowser ? { proceedWithoutSupportedBrowser: true } : {}),
    ...(confirmReplaceForeign ? { confirmReplaceForeign: true } : {}),
  };
}

/** The fixed table constant (not the IPC copy), or `null` when empty. */
function addressOf(browser: CollectorBrowserId): string | null {
  const address = COLLECTOR_BROWSERS.find((row) => row.id === browser)?.extensionsPage.displayUrl;
  return address === undefined || address === "" ? null : address;
}

function recommendationReason(state: WizardState) {
  return state.status?.browsers.recommendationReason ?? null;
}

// ----- Which events are allowed now (shared by the reducer and `wizardActions`) --------------------

/**
 * Whether a user event may take effect in `state`. The reducer ignores a disallowed event; the
 * panel uses `wizardActions` (which calls this) to disable the matching button.
 */
export function isWizardEventAllowed(state: WizardState, event: WizardUserEvent): boolean {
  if (state.closed !== null) return false;
  // After a finished check the only way out is 完了 then 閉じる: leaving early would hide that it worked.
  const completed = state.step === "E" && (state.connection?.phase === "connected" || state.connection?.phase === "user-confirmed");
  if (event.type === "cancelInFlight") return isBlocking(state) && state.inFlight?.cancelOffered === true;
  if (event.type === "later") return state.step !== "done" && !completed && !isMutating(state);
  if (event.type === "escape") return !completed && !isMutating(state);
  if (state.step === "done") return event.type === "close";
  if (event.type === "close") return false;
  if (isBlocking(state)) return false;

  const result = (step: WizardResultStep): WizardMessageId | undefined => state.results[step];
  switch (state.step) {
    case "A": {
      if (state.statusLoad === "loading") return false;
      if (event.type === "recheckBrowsers" && state.statusLoad === "failed" && state.results.A !== undefined && TERMINAL_UNAVAILABLE.includes(state.results.A)) return false;
      const reason = recommendationReason(state);
      const blocked = wizardAllBrowsersBlocked(state.status);
      switch (event.type) {
        case "recheckBrowsers":
          return true;
        case "selectBrowser":
          return state.statusLoad === "ready" && isSelectable(state, event.browser);
        case "radioKey":
          return state.statusLoad === "ready" && wizardBrowserOptions(state.status).some((option) => option.selectable);
        case "next":
          return state.statusLoad === "ready" && !blocked && reason !== "none-installed" && reason !== "detection-failed" && isSelectable(state, state.selectedBrowser);
        case "continueWithoutBrowser":
          return state.statusLoad === "ready" && !blocked && (reason === "none-installed" || (reason === "detection-failed" && isSelectable(state, state.selectedBrowser)));
        case "openDownloadPage":
          return state.statusLoad === "ready" && !blocked && reason === "none-installed" && COLLECTOR_BROWSERS.some((row) => row.id === event.browser && row.verification === "verified" && row.downloadUrl !== null);
        default:
          return false;
      }
    }
    case "B": {
      const current = result("B");
      switch (event.type) {
        case "back":
          return true;
        case "register":
          return current !== "foreign-confirmation" && !(current !== undefined && (STEP_B_SUCCESS.includes(current) || STEP_B_TERMINAL.includes(current)));
        case "confirmForeign":
        case "declineForeign":
          return current === "foreign-confirmation";
        case "next":
          return current !== undefined && STEP_B_SUCCESS.includes(current);
        default:
          return false;
      }
    }
    case "C": {
      const current = result("C");
      switch (event.type) {
        case "back":
          return true;
        case "confirmDestination":
          return current === undefined || !(current === "destination-configured" || current === "destination-writes-disabled");
        case "chooseDestinationAgain":
          return current === "destination-error" || current === "destination-busy";
        case "next":
          return current !== undefined && STEP_C_PROCEED.includes(current);
        default:
          return false;
      }
    }
    case "D": {
      const placed = state.placement === "placed";
      const canOpen = placed && state.selectedBrowser !== null && !state.proceedWithoutBrowser;
      switch (event.type) {
        case "back":
          return true;
        case "retryPlacement":
          return state.placement === "missing" || state.placement === "unknown";
        case "openBrowserExtensions":
          return canOpen;
        case "copyAddress":
          return placed && state.selectedBrowser !== null;
        case "copyPath":
        case "revealFolder":
        case "loaded":
          return placed;
        default:
          return false;
      }
    }
    case "E": {
      const phase = state.connection?.phase;
      switch (event.type) {
        case "back":
          return true;
        case "recheckConnection":
          return phase === "extension-version-differs";
        case "openBrowserExtensions":
          return phase === "extension-version-differs" && state.selectedBrowser !== null && !state.proceedWithoutBrowser;
        case "waitAgain":
          return phase === "timed-out";
        case "userConfirmed":
          return phase === "timed-out" || phase === "unavailable";
        case "finish":
          return phase === "connected" || phase === "user-confirmed";
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

// ----- Reducer -----------------------------------------------------------------------------------

function reduction(state: WizardState, ...effects: readonly WizardEffect[]): WizardReduction {
  return { state, effects };
}

function unchanged(state: WizardState): WizardReduction {
  return { state, effects: [] };
}

function close(state: WizardState, outcome: WizardClosedOutcome): WizardReduction {
  const effects: WizardEffect[] = [];
  if (state.connection?.phase === "waiting") effects.push(ticker(false));
  effects.push({ type: "close", outcome });
  return { state: { ...dropPoll(state), closed: outcome, inFlight: null }, effects };
}

function goTo(state: WizardState, step: WizardStepId, ...effects: readonly WizardEffect[]): WizardReduction {
  const leavingE = state.step === "E" && step !== "E";
  const next = leavingE ? dropPoll(state) : state;
  const out: WizardEffect[] = [];
  if (leavingE && state.connection?.phase === "waiting") out.push(ticker(false));
  out.push(...effects, FOCUS_HEADING);
  return { state: { ...next, step }, effects: out };
}

/** The state after a failed or unexpected result for the operation that was in flight. */
function failed(state: WizardState, operation: WizardOperation, message: WizardMessageId): WizardState {
  switch (operation) {
    case "inspect":
    case "recheck-browsers":
      // Keep the specific reason (busy, unavailable) on the first inspection; only a generic failure reads as inspect-failed.
      return {
        ...withResult(state, "A", state.status === null && message === "request-failed" ? "inspect-failed" : message),
        statusLoad: state.status === null ? "failed" : "ready",
      };
    case "download":
      return withResult(state, "A", message);
    case "setup":
      return withResult(state, "B", message);
    case "destination":
      return withResult(state, "C", message === "request-failed" ? "destination-error" : message);
    case "placement":
      return { ...withResult(state, "D", message), placement: "unknown" };
    case "open-browser":
    case "copy-path":
    case "reveal":
      return withResult(state, "D", message);
    case "poll":
      return state;
    default:
      unreachable(operation);
      return state;
  }
}

function startConnection(state: WizardState, now: number, previous: WizardConnection | null): WizardReduction {
  const polled = issue(state, "poll", { intent: "checkConnection" });
  const connection: WizardConnection = {
    phase: "waiting",
    startedAt: now,
    lastPollAt: now,
    loadedVersion: null,
    placedVersion: previous?.placedVersion ?? null,
  };
  return {
    state: { ...polled.state, connection, verification: null },
    effects: [ticker(true), polled.effect],
  };
}

function leaveWaiting(state: WizardState, patch: Partial<WizardConnection> & { readonly phase: WizardConnectionPhase }): WizardReduction {
  const connection = state.connection;
  if (connection === null) return unchanged(state);
  return {
    state: {
      ...dropPoll(state),
      connection: { ...connection, ...patch },
      verification: patch.phase === "connected" || patch.phase === "user-confirmed" ? patch.phase : state.verification,
    },
    effects: [ticker(false)],
  };
}

function handleTick(state: WizardState, now: number): WizardReduction {
  const connection = state.connection;
  if (state.step !== "E" || connection === null || connection.phase !== "waiting") return unchanged(state);
  if (Math.max(0, now - connection.startedAt) >= WIZARD_CONNECTION_TIMEOUT_MS) return leaveWaiting(state, { phase: "timed-out" });
  if (state.inFlight !== null) return unchanged(state);
  if (connection.lastPollAt !== null && Math.max(0, now - connection.lastPollAt) < WIZARD_POLL_INTERVAL_MS) return unchanged(state);
  const polled = issue(state, "poll", { intent: "checkConnection" });
  return { state: { ...polled.state, connection: { ...connection, lastPollAt: now } }, effects: [polled.effect] };
}

/** Accepts a status unless an apply was running (then the facts may describe a half-written installation). */
function acceptStatus(state: WizardState, status: CollectorIntegrationStatus, reconcile = true): WizardState | null {
  if (status.applyInProgress) return null;
  return { ...state, status, selectedBrowser: reconcile ? reconcileSelection(state.selectedBrowser, status) : state.selectedBrowser };
}

function handleResponse(state: WizardState, operation: WizardOperation, response: CollectorIntegrationResponse, now: number): WizardReduction {
  const classified = classifyWizardResponse(response);

  if (operation === "poll") return handlePollResponse(state, classified, now);

  // Problems that read the same on every operation.
  if (classified.class === "unavailable") return unchanged(failed(state, operation, classified.message));
  if (classified.class === "invalid") return unchanged(failed(state, operation, "request-failed"));
  if (classified.class === "busy") return unchanged(failed(state, operation, "busy"));

  switch (operation) {
    case "inspect":
    case "recheck-browsers": {
      if (classified.class !== "status") return unchanged(failed(state, operation, "request-failed"));
      const accepted = acceptStatus(state, classified.status);
      if (accepted === null) return unchanged(failed(state, operation, "busy"));
      const proceedReset = operation === "recheck-browsers" ? { proceedWithoutBrowser: false } : {};
      return unchanged({ ...withResult({ ...accepted, ...proceedReset, statusLoad: "ready" }, "A", null) });
    }
    case "download": {
      if (classified.class !== "browser-download") return unchanged(failed(state, operation, "request-failed"));
      const message: WizardMessageId = classified.result === "opened" ? "download-opened" : classified.result === "failed" ? "download-failed" : "download-not-offered";
      return unchanged(withResult(state, "A", message));
    }
    case "setup":
      return handleSetupResponse(state, classified);
    case "placement": {
      if (classified.class !== "status") return unchanged(failed(state, operation, "request-failed"));
      const accepted = acceptStatus(state, classified.status);
      if (accepted === null) return unchanged(failed(state, operation, "busy"));
      if (!classified.status.inspectionComplete) {
        return unchanged({ ...withResult(accepted, "D", "check-incomplete"), placement: "unknown" });
      }
      return unchanged(
        classified.status.extensionFolderPlaced
          ? { ...withResult(accepted, "D", null), placement: "placed" }
          : { ...withResult(accepted, "D", "extension-not-placed"), placement: "missing" },
      );
    }
    case "open-browser": {
      if (classified.class !== "browser-extensions") return unchanged(failed(state, operation, "request-failed"));
      return unchanged(withResult(state, "D", classified.result === "opened" ? "browser-opened" : "browser-not-opened"));
    }
    case "copy-path":
    case "reveal": {
      const expected = operation === "copy-path" ? "copyExtensionPath" : "revealExtensionFolder";
      if (classified.class !== "extension-folder" || classified.intent !== expected) return unchanged(failed(state, operation, "request-failed"));
      if (classified.result === "done") return unchanged(withResult(state, "D", operation === "copy-path" ? "path-copied" : null));
      return unchanged(withResult(state, "D", operation === "copy-path" ? "path-copy-failed" : "folder-open-failed"));
    }
    case "destination":
      // Answered by `destinationResult`, never by an integration response.
      return unchanged(failed(state, operation, "request-failed"));
    default:
      unreachable(operation);
      return unchanged(state);
  }
}

function handleSetupResponse(state: WizardState, classified: ResponseClass): WizardReduction {
  if (classified.class === "browser-required") {
    // Nothing was written. The browser situation changed since step A: show step A again, with the new facts.
    const accepted = acceptStatus(state, classified.status);
    if (accepted === null) return unchanged(failed(state, "setup", "busy"));
    const base = withResult(withResult({ ...accepted, statusLoad: "ready", proceedWithoutBrowser: false }, "A", null), "B", null);
    return goTo(base, "A");
  }
  if (classified.class !== "apply") return unchanged(failed(state, "setup", "request-failed"));

  const apply = classified.response;
  // The user's choice stays as it is: if the browser became unusable, the message names it.
  const accepted = acceptStatus(state, apply.status, false);
  const base = accepted ?? state;

  if (apply.outcome === "noop" && state.selfCheckFailed) {
    // The files look intact again, but the earlier start-up check never succeeded: not a success.
    return unchanged(withResult(base, "B", "self-check-failed"));
  }
  if (apply.outcome === "applied" || apply.outcome === "noop") {
    const message: WizardMessageId = apply.action === "refresh"
      ? "refreshed"
      : apply.outcome === "noop"
        ? "already-ready"
        : apply.selfCheck === "ok" ? "registered-verified" : "registered";
    return unchanged({ ...withResult(base, "B", message), selfCheckFailed: false });
  }

  let message: WizardMessageId;
  if (apply.reason === null) {
    message = "register-failed";
  } else {
    const mapped = APPLY_REASON_MESSAGE[apply.reason];
    if (mapped === "policy-blocked") {
      const selected = state.selectedBrowser;
      const entry = selected === null ? undefined : base.status?.browsers.entries.find((candidate) => candidate.id === selected);
      message = entry?.policyBlocked === true ? "policy-blocked-browser" : "policy-blocked";
    } else {
      message = mapped ?? "register-failed"; // a reason this build does not know
    }
  }
  return unchanged({ ...withResult(base, "B", message), selfCheckFailed: message === "self-check-failed" ? true : state.selfCheckFailed });
}

function handlePollResponse(state: WizardState, classified: ResponseClass, now: number): WizardReduction {
  const connection = state.connection;
  if (state.step !== "E" || connection === null || connection.phase !== "waiting") return unchanged(state);
  if (classified.class === "unavailable") return leaveWaiting(state, { phase: "unavailable" });
  if (classified.class !== "connection") return unchanged(state); // busy / error: transient, the next poll asks again

  const { applyInProgress, connection: summary } = classified.response;
  // Discard it, and ask again after the normal interval (never on the very next tick).
  if (applyInProgress) return unchanged({ ...state, connection: { ...connection, lastPollAt: now } });
  switch (summary.state) {
    case "waiting":
      return unchanged(state);
    case "connected":
      return leaveWaiting(state, { phase: "connected" });
    case "extension-version-differs":
      return leaveWaiting(state, { phase: "extension-version-differs", loadedVersion: summary.loadedVersion, placedVersion: summary.placedVersion });
    case "protocol-differs":
      return leaveWaiting(state, { phase: "protocol-differs" });
    case "unavailable":
      return leaveWaiting(state, { phase: "unavailable" });
    default:
      unreachable(summary);
      return unchanged(state); // an unknown connection state is treated as transient
  }
}

function destinationMessage(result: CollectorSaveDestinationIpcResult): WizardMessageId {
  switch (result.kind) {
    case "configured":
    case "already-configured":
      return result.writesEnabled ? "destination-configured" : "destination-writes-disabled";
    case "cancelled":
      return "destination-cancelled";
    case "busy":
      return "destination-busy";
    case "error":
    case "not-configured":
    case "cleared":
      return "destination-error";
    default:
      unreachable(result);
      return "destination-error";
  }
}

/**
 * The next state and effects for one event. Pure: equal inputs give equal outputs, and the input
 * state is never mutated. Unknown or disallowed events return the state unchanged with no effects.
 */
export function reduceWizard(state: WizardState, event: WizardEvent): WizardReduction {
  if (state.closed !== null) return unchanged(state);
  // A non-finite clock value would make every tick look due: ignore the event.
  if (!Number.isFinite(event.now)) return unchanged(state);
  return applyWatchdog(state, event, reduceCore(state, event));
}

/** Whether the panel must be sending `tick`: the connection wait, or a blocking request that the watchdog times. */
function needsTicker(state: WizardState): boolean {
  if (state.closed !== null) return false;
  if (state.step === "E" && state.connection?.phase === "waiting") return true;
  return isBlocking(state);
}

/**
 * Stamps new requests with the event time, fires the in-flight watchdog from timestamps (a clock jump
 * counts as elapsed time; a backward jump never un-offers) and keeps the `ticker` effect in step with `needsTicker`.
 */
function applyWatchdog(before: WizardState, event: WizardEvent, reduced: WizardReduction): WizardReduction {
  let state = reduced.state;
  let inFlight = state.inFlight;
  if (inFlight !== null && inFlight.startedAt === null) inFlight = { ...inFlight, startedAt: event.now };
  if (inFlight !== null && inFlight.operation !== "poll" && !inFlight.cancelOffered && inFlight.startedAt !== null
    && event.now - inFlight.startedAt >= WIZARD_INFLIGHT_CANCEL_MS) {
    inFlight = { ...inFlight, cancelOffered: true };
  }
  if (inFlight !== state.inFlight) state = { ...state, inFlight };
  const effects = [...reduced.effects];
  let current = needsTicker(before);
  for (const effect of effects) if (effect.type === "ticker") current = effect.active;
  const wanted = needsTicker(state);
  if (wanted !== current) {
    const closeAt = effects.findIndex((effect) => effect.type === "close");
    if (closeAt >= 0) effects.splice(closeAt, 0, ticker(wanted));
    else effects.push(ticker(wanted));
  }
  return { state, effects };
}

function reduceCore(state: WizardState, event: WizardEvent): WizardReduction {
  switch (event.type) {
    case "opened": {
      if (state.nextRequestId !== 0 || state.inFlight !== null || state.status !== null) return unchanged(state);
      const issued = issue(state, "inspect", { intent: "inspect" });
      return reduction(issued.state, issued.effect, FOCUS_HEADING);
    }
    case "tick":
      return handleTick(state, event.now);
    case "response": {
      if (state.inFlight === null || state.inFlight.requestId !== event.requestId) return unchanged(state);
      const operation = state.inFlight.operation;
      return handleResponse({ ...state, inFlight: null }, operation, event.response, event.now);
    }
    case "destinationResult": {
      if (state.inFlight === null || state.inFlight.requestId !== event.requestId || state.inFlight.operation !== "destination") return unchanged(state);
      return unchanged(withResult({ ...state, inFlight: null }, "C", destinationMessage(event.result)));
    }
    case "requestFailed": {
      if (state.inFlight === null || state.inFlight.requestId !== event.requestId) return unchanged(state);
      const operation = state.inFlight.operation;
      return unchanged(failed({ ...state, inFlight: null }, operation, "request-failed"));
    }
    case "clipboardResult": {
      if (state.step !== "D") return unchanged(state);
      return unchanged(withResult(state, "D", event.ok ? "address-copied" : "address-copy-failed"));
    }
    default:
      return reduceUserEvent(state, event);
  }
}

function reduceUserEvent(state: WizardState, event: WizardUserEvent & { readonly now: number }): WizardReduction {
  if (!isWizardEventAllowed(state, event)) return unchanged(state);

  switch (event.type) {
    case "later":
      return close(state, "later");
    case "escape":
      return close(state, state.step === "done" ? "finished" : "later");
    case "close":
      return close(state, "finished");

    case "selectBrowser":
      return unchanged({ ...state, selectedBrowser: event.browser });
    case "radioKey": {
      const moved = moveRadioSelection(wizardBrowserOptions(state.status), state.selectedBrowser, event.key);
      if (moved === null) return unchanged(state);
      return reduction({ ...state, selectedBrowser: moved }, { type: "focusRadio", browser: moved });
    }

    case "recheckBrowsers": {
      const issued = issue(withResult(state, "A", null), "recheck-browsers", { intent: "inspect" });
      return reduction({ ...issued.state, statusLoad: state.status === null ? "loading" : state.statusLoad }, issued.effect);
    }
    case "openDownloadPage": {
      const issued = issue(withResult(state, "A", null), "download", { intent: "openBrowserDownloadPage", browser: event.browser });
      return reduction(issued.state, issued.effect);
    }
    case "continueWithoutBrowser":
      return goTo({ ...state, proceedWithoutBrowser: true }, "B");

    case "next":
      return reduceNext(state);
    case "back":
      return reduceBack(state);

    case "register": {
      if (state.status?.state === "outdated") {
        // `apply` can only refresh an outdated installation, and no renderer intent exists for that: the main process
        // refreshes it at the next start. Registration is already in place, so let the user go on.
        return unchanged(withResult(state, "B", "outdated-pending"));
      }
      const issued = issue(withResult(state, "B", null), "setup", setupRequest(state, false));
      return reduction(issued.state, issued.effect);
    }
    case "confirmForeign": {
      const issued = issue(withResult(state, "B", null), "setup", setupRequest(state, true));
      return reduction(issued.state, issued.effect);
    }
    case "declineForeign":
      return unchanged(withResult(state, "B", "foreign-declined"));

    case "confirmDestination":
    case "chooseDestinationAgain": {
      const issued = issue(withResult(state, "C", null), "destination", null);
      return reduction(issued.state, issued.effect);
    }

    case "cancelInFlight": {
      // Abort only: forget the request (a late answer then fails the requestId guard) and keep every result as it is.
      // Registrations that already happened stay. Only states that would otherwise be stuck on "waiting" are reset.
      const operation = state.inFlight?.operation;
      return unchanged({
        ...state,
        placement: operation === "placement" ? "unknown" : state.placement,
        statusLoad: operation === "inspect" && state.status === null ? "failed" : state.statusLoad,
        inFlight: null,
      });
    }

    case "retryPlacement": {
      const issued = issue(withResult({ ...state, placement: "checking" }, "D", null), "placement", { intent: "inspect" });
      return reduction(issued.state, issued.effect);
    }
    case "openBrowserExtensions": {
      const issued = issue(withResult(state, "D", null), "open-browser", { intent: "openBrowserExtensions", ...(state.selectedBrowser === null ? {} : { browser: state.selectedBrowser }) });
      return reduction(issued.state, issued.effect);
    }
    case "copyAddress": {
      const text = state.selectedBrowser === null ? null : addressOf(state.selectedBrowser);
      if (text === null) return unchanged(state);
      return reduction(withResult(state, "D", null), { type: "copyText", purpose: "address", text });
    }
    case "copyPath": {
      const issued = issue(withResult(state, "D", null), "copy-path", { intent: "copyExtensionPath" });
      return reduction(issued.state, issued.effect);
    }
    case "revealFolder": {
      const issued = issue(withResult(state, "D", null), "reveal", { intent: "revealExtensionFolder" });
      return reduction(issued.state, issued.effect);
    }
    case "loaded": {
      const entered = goTo(withResult(state, "D", null), "E");
      const started = startConnection(entered.state, event.now, state.connection);
      return { state: started.state, effects: [...entered.effects, ...started.effects] };
    }

    case "recheckConnection":
    case "waitAgain":
      return startConnection(state, event.now, state.connection);
    case "userConfirmed":
      return leaveWaiting(state, { phase: "user-confirmed" });
    case "finish":
      return goTo(state, "done");
    default:
      unreachable(event);
      return unchanged(state);
  }
}

function reduceNext(state: WizardState): WizardReduction {
  switch (state.step) {
    case "A":
      return goTo({ ...state, proceedWithoutBrowser: false }, "B");
    case "B":
      return goTo(state, "C");
    case "C": {
      const issued = issue(withResult({ ...state, placement: "checking" }, "D", null), "placement", { intent: "inspect" });
      return goTo(issued.state, "D", issued.effect);
    }
    default:
      return unchanged(state);
  }
}

function reduceBack(state: WizardState): WizardReduction {
  switch (state.step) {
    case "B":
      return goTo(state, "A");
    case "C":
      return goTo(state, "B");
    case "D":
      return goTo(state, "C");
    case "E":
      return goTo(state, "D");
    default:
      return unchanged(state);
  }
}

// ----- Selectors for the panel -------------------------------------------------------------------

/** 1 to 5 for steps A to E, `null` on the last screen. */
export function wizardStepNumber(step: WizardStepId): number | null {
  switch (step) {
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
    case "D": return 4;
    case "E": return 5;
    case "done": return null;
    default:
      unreachable(step);
      return null;
  }
}

/** 「手順 n / 5」, or `null` on the last screen. */
export function wizardProgress(state: WizardState): string | null {
  const number = wizardStepNumber(state.step);
  return number === null ? null : wizardProgressLabel(number);
}

export function wizardCopyContext(state: WizardState): WizardCopyContext {
  return {
    browser: state.selectedBrowser,
    recommended: state.status?.browsers.recommended ?? null,
    preferred: state.status?.browsers.preferred ?? null,
    blocked: wizardBlockedBrowsers(state.status),
    defaultBrowser: state.status?.browsers.defaultBrowser ?? "unknown",
    loadedVersion: state.connection?.loadedVersion ?? null,
    placedVersion: state.connection?.placedVersion ?? null,
  };
}

/** All copy resolved for the current situation (browser names, versions). */
export function wizardCopy(state: WizardState): WizardCopy {
  return buildWizardCopy(wizardCopyContext(state));
}

export interface WizardMessageView {
  readonly id: WizardMessageId;
  /** `alert` for failures that need action, `status` (polite) otherwise. */
  readonly role: WizardMessageRole;
  readonly copy: WizardMessageCopy;
}

/**
 * The result or notice of the current step, or `null`. Step E's connection state is in
 * `wizardConnectionView`; here step E only carries the result of 「…で拡張機能の画面を開く」 (shown on a
 * version mismatch), which is stored with step D's results.
 */
export function wizardMessage(state: WizardState): WizardMessageView | null {
  if (state.step === "done") return null;
  const id = state.results[state.step === "E" ? "D" : state.step];
  if (id === undefined) return null;
  return { id, role: WIZARD_MESSAGE_ROLE[id], copy: wizardCopy(state).messages[id] };
}

/** True while a blocking operation runs: show a busy indicator and expect disabled buttons. */
export function wizardIsBusy(state: WizardState): boolean {
  return isBlocking(state);
}

/**
 * The slow-response notice, only after `WIZARD_INFLIGHT_CANCEL_MS` of a blocking request (shown together with the
 * `cancelInFlight` action), else `null`.
 */
export function wizardInFlightNotice(state: WizardState): WizardMessageView | null {
  if (!isBlocking(state) || state.inFlight?.cancelOffered !== true) return null;
  return { id: "inflight-slow", role: WIZARD_MESSAGE_ROLE["inflight-slow"], copy: wizardCopy(state).messages["inflight-slow"] };
}

/** The step E line 「保存先：…」. */
export function wizardDestinationConfigured(state: WizardState): boolean {
  return state.results.C === "destination-configured";
}

export interface WizardAction {
  /** Stable id for the DOM (`data-action`). */
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
  readonly enabled: boolean;
  /** Dispatch this (plus `now`) when the action is activated. */
  readonly event: WizardUserEvent;
}

/**
 * The buttons of the current screen, in reading order, with labels and enabled flags. Browser
 * dependent buttons (open the extensions page, copy the address) are listed only when they apply.
 */
export function wizardActions(state: WizardState): readonly WizardAction[] {
  const copy = wizardCopy(state);
  const actions: WizardAction[] = [];
  const add = (id: string, label: string, event: WizardUserEvent, primary = false): void => {
    actions.push({ id, label, primary, enabled: isWizardEventAllowed(state, event), event });
  };
  const later = (label: string = copy.common.later): void => add("later", label, { type: "later" });
  const back = (): void => add("back", copy.common.back, { type: "back" });
  const result = state.step === "A" || state.step === "B" || state.step === "C" || state.step === "D" ? state.results[state.step] : undefined;
  const failure = result !== undefined && WIZARD_MESSAGE_ROLE[result] === "alert";

  switch (state.step) {
    case "A": {
      const reason = recommendationReason(state);
      if (state.statusLoad !== "ready") {
        // A terminal failure (this environment cannot run the integration) has nothing to retry.
        if (result === undefined || !TERMINAL_UNAVAILABLE.includes(result)) add("recheckBrowsers", copy.common.recheck, { type: "recheckBrowsers" }, true);
        later();
        break;
      }
      if (wizardAllBrowsersBlocked(state.status)) {
        add("recheckBrowsers", copy.common.recheck, { type: "recheckBrowsers" }, true);
      } else if (reason === "none-installed") {
        for (const row of COLLECTOR_BROWSERS) {
          if (row.verification === "verified" && row.downloadUrl !== null) {
            add(`openDownloadPage-${row.id}`, copy.stepA.downloadButtons[row.id], { type: "openDownloadPage", browser: row.id });
          }
        }
        add("recheckBrowsers", copy.common.recheck, { type: "recheckBrowsers" });
        add("continueWithoutBrowser", copy.stepA.continueWithoutBrowser, { type: "continueWithoutBrowser" });
      } else if (reason === "detection-failed") {
        add("continueWithoutBrowser", copy.stepA.continueWithSelectedBrowser, { type: "continueWithoutBrowser" }, true);
      } else {
        add("next", copy.common.next, { type: "next" }, true);
      }
      later();
      break;
    }
    case "B": {
      if (result === "foreign-confirmation") {
        add("confirmForeign", copy.stepB.switchForeign, { type: "confirmForeign" }, true);
        add("declineForeign", copy.stepB.declineForeign, { type: "declineForeign" });
      } else if (result !== undefined && STEP_B_SUCCESS.includes(result)) {
        add("next", copy.common.next, { type: "next" }, true);
      } else if (result !== undefined && STEP_B_TERMINAL.includes(result)) {
        // Nothing to retry. 戻る comes first, as everywhere else. Policy and unavailable end in 閉じる; an unsafe folder in あとで設定 (design 4.3).
        back();
        later(result === "folder-unsafe" ? copy.common.later : copy.common.close);
        break;
      } else {
        const label = failure || result === "foreign-declined" ? copy.common.retry : copy.stepB.register;
        add("register", label, { type: "register" }, true);
      }
      back();
      later();
      break;
    }
    case "C": {
      const proceed = result !== undefined && STEP_C_PROCEED.includes(result);
      if (result === "destination-configured") {
        add("next", copy.common.next, { type: "next" }, true);
      } else if (result === "destination-writes-disabled") {
        add("next", copy.stepC.nextWritesDisabled, { type: "next" }, true);
      } else if (result === "destination-error" || result === "destination-busy") {
        // Exactly these three (no 戻る, 次へ, 閉じる). Cancel only closes the wizard (`later`); nothing registered is rolled back.
        add("confirmDestination", copy.common.retry, { type: "confirmDestination" }, true);
        add("chooseDestinationAgain", copy.stepC.chooseAgain, { type: "chooseDestinationAgain" });
        add("cancelSetup", copy.stepC.cancelSetup, { type: "later" });
        break;
      } else {
        add("confirmDestination", result === undefined ? copy.stepC.confirm : copy.stepC.confirmAgain, { type: "confirmDestination" }, !proceed);
        if (proceed) add("next", copy.common.next, { type: "next" }, true);
      }
      back();
      later();
      break;
    }
    case "D": {
      if (state.placement !== "placed") {
        if (state.placement !== "checking") add("retryPlacement", copy.common.retry, { type: "retryPlacement" }, true);
        back();
        later();
        break;
      }
      if (state.selectedBrowser !== null && !state.proceedWithoutBrowser) {
        add("openBrowserExtensions", copy.stepD.openExtensions, { type: "openBrowserExtensions" });
      }
      if (state.selectedBrowser !== null) add("copyAddress", copy.stepD.copyAddress, { type: "copyAddress" });
      add("copyPath", copy.stepD.copyPath, { type: "copyPath" });
      add("revealFolder", copy.stepD.revealFolder, { type: "revealFolder" });
      add("loaded", copy.stepD.loaded, { type: "loaded" }, true);
      back();
      later();
      break;
    }
    case "E": {
      const phase = state.connection?.phase;
      if (phase === "connected" || phase === "user-confirmed") {
        add("finish", copy.common.finish, { type: "finish" }, true);
      } else if (phase === "extension-version-differs") {
        if (state.selectedBrowser !== null && !state.proceedWithoutBrowser) {
          add("openBrowserExtensions", copy.stepD.openExtensions, { type: "openBrowserExtensions" });
        }
        add("recheckConnection", copy.stepE.recheck, { type: "recheckConnection" }, true);
      } else if (phase === "timed-out") {
        add("waitAgain", copy.stepE.waitAgain, { type: "waitAgain" }, true);
        add("userConfirmed", copy.stepE.confirmReady, { type: "userConfirmed" });
      } else if (phase === "unavailable") {
        add("userConfirmed", copy.stepE.confirmReady, { type: "userConfirmed" }, true);
      }
      if (phase === "protocol-differs") {
        later(copy.common.close);
      } else if (phase !== "connected" && phase !== "user-confirmed") {
        back();
        later();
      } else {
        back();
      }
      break;
    }
    case "done":
      add("close", copy.common.close, { type: "close" }, true);
      break;
    default:
      unreachable(state.step);
  }
  if (isBlocking(state) && state.inFlight?.cancelOffered === true) {
    add("cancelInFlight", copy.common.cancelWait, { type: "cancelInFlight" });
  }
  return actions;
}

// ----- Views for the panel (pure, derived) -------------------------------------------------------

export interface WizardAOption {
  readonly id: CollectorBrowserId;
  readonly displayName: string;
  /** Radio label: the name plus 「（おすすめ）」 when recommended. */
  readonly label: string;
  readonly recommended: boolean;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly note: WizardBrowserOption["note"];
  /** The 「組織の管理設定により使えません」 / 「確認できませんでした」 text for `note`, or `null`. */
  readonly noteText: string | null;
}

export interface WizardAView {
  /** The first inspection is running. */
  readonly loading: boolean;
  readonly title: string;
  readonly body: string;
  readonly bullets: readonly string[];
  readonly menuNote: string;
  readonly radiogroupLabel: string;
  /** Every usable browser is blocked by policy: show `notice` instead of the reason text and offer no browser actions. */
  readonly allBlocked: boolean;
  /** The all-blocked message (names inserted), or `null`. */
  readonly notice: WizardMessageView | null;
  readonly reason: CollectorRecommendationReason | null;
  /** The recommendation wording for `reason`; `null` while loading or when all are blocked. */
  readonly reasonCopy: WizardReasonCopy | null;
  /** 「前回は {name} を選びました。」, only when the remembered browser differs from the recommended one. */
  readonly previouslyChosen: string | null;
  readonly options: readonly WizardAOption[];
}

export function wizardAView(state: WizardState): WizardAView {
  const copy = wizardCopy(state);
  const status = state.status;
  const reason = status?.browsers.recommendationReason ?? null;
  const allBlocked = wizardAllBrowsersBlocked(status);
  const preferred = status?.browsers.preferred ?? null;
  const recommended = status?.browsers.recommended ?? null;
  const options = wizardBrowserOptions(status).map((option): WizardAOption => {
    const displayName = COLLECTOR_BROWSERS.find((row) => row.id === option.id)?.displayName ?? option.id;
    return {
      id: option.id,
      displayName,
      label: option.recommended ? `${displayName}${copy.stepA.optionRecommendedSuffix}` : displayName,
      recommended: option.recommended,
      selectable: option.selectable,
      selected: state.selectedBrowser === option.id,
      note: option.note,
      noteText: option.note === "policy-blocked" ? copy.stepA.optionPolicyBlocked : option.note === "detection-unknown" ? copy.stepA.optionDetectionUnknown : null,
    };
  });
  return {
    loading: state.statusLoad === "loading",
    title: copy.stepA.title,
    body: copy.stepA.body,
    bullets: copy.stepA.bullets,
    menuNote: copy.stepA.menuNote,
    radiogroupLabel: copy.stepA.radiogroupLabel,
    allBlocked,
    notice: allBlocked ? { id: "all-browsers-policy-blocked", role: WIZARD_MESSAGE_ROLE["all-browsers-policy-blocked"], copy: copy.messages["all-browsers-policy-blocked"] } : null,
    reason,
    reasonCopy: reason === null || allBlocked ? null : copy.stepA.reasons[reason],
    previouslyChosen: preferred !== null && preferred !== recommended ? copy.stepA.previouslyChosen : null,
    options,
  };
}

export interface WizardDView {
  readonly placement: WizardState["placement"];
  readonly title: string;
  readonly intro: string;
  readonly pathNote: string;
  readonly stepsLabel: string;
  /** The five numbered instructions. */
  readonly steps: readonly string[];
  /** Render this directly under instruction 1 (`steps[0]`), together with the [アドレスをコピー] button. */
  readonly addressNote: string;
  readonly addressNoteAfterStep: 1;
  /** Drag-and-drop loading text, or `null` (not observed for this browser: do not render). */
  readonly alternative: string | null;
  readonly cautionsLabel: string;
  readonly cautions: readonly string[];
  readonly multiBrowserSummary: string;
  readonly multiBrowserNote: string;
  /** The selected browser's `extensionLoadMayBeBlocked` flag (organization policy may block loading an extension). */
  readonly showPolicyWarning: boolean;
  readonly policyWarning: string;
  readonly checkingFolder: string;
}

export function wizardStepDView(state: WizardState): WizardDView {
  const d = wizardCopy(state).stepD;
  const entry = state.selectedBrowser === null ? undefined : state.status?.browsers.entries.find((candidate) => candidate.id === state.selectedBrowser);
  return {
    placement: state.placement,
    title: d.title,
    intro: d.intro,
    pathNote: d.pathNote,
    stepsLabel: d.stepsLabel,
    steps: d.steps,
    addressNote: d.addressNote,
    addressNoteAfterStep: 1,
    alternative: d.alternative,
    cautionsLabel: d.cautionsLabel,
    cautions: d.cautions,
    multiBrowserSummary: d.multiBrowserSummary,
    multiBrowserNote: d.multiBrowserNote,
    showPolicyWarning: entry?.extensionLoadMayBeBlocked === true,
    policyWarning: d.policyWarning,
    checkingFolder: d.checkingFolder,
  };
}

export interface WizardConnectionView {
  readonly phase: WizardConnectionPhase;
  readonly title: string;
  /** `status` (polite): waiting, connected, user-confirmed. `alert`: version or protocol mismatch, timeout, unavailable. */
  readonly role: WizardMessageRole;
  readonly headline: string;
  readonly detail: string | null;
  readonly checklistLabel: string | null;
  /** The timeout checklist, or `null`. */
  readonly checklist: readonly string[] | null;
  /** 「保存先：…」, only when connected. */
  readonly destinationLine: string | null;
  /** The 「「はじめに」画面を開く方法」 disclosure, only while waiting. */
  readonly howToOpen: { readonly summary: string; readonly detail: string } | null;
  /** The result of 「…で拡張機能の画面を開く」 pressed on step E (version mismatch), or `null`. */
  readonly launchMessage: WizardMessageView | null;
}

/** Step E, or `null` before the user pressed 「読み込みました」. */
export function wizardConnectionView(state: WizardState): WizardConnectionView | null {
  const connection = state.connection;
  if (connection === null) return null;
  const e = wizardCopy(state).stepE;
  const base = { phase: connection.phase, title: e.title, checklistLabel: null, checklist: null, destinationLine: null, howToOpen: null, launchMessage: wizardMessage(state) } as const;
  switch (connection.phase) {
    case "waiting":
      return { ...base, role: "status", headline: e.waiting.headline, detail: e.waiting.detail, howToOpen: { summary: e.howToOpenSummary, detail: e.howToOpenDetail } };
    case "connected":
      return { ...base, role: "status", headline: e.connected.headline, detail: e.connected.detail, destinationLine: wizardDestinationConfigured(state) ? e.destinationConfigured : e.destinationNotConfigured };
    case "extension-version-differs":
      return { ...base, role: "alert", headline: e.versionDiffers.headline, detail: e.versionDiffers.detail };
    case "protocol-differs":
      return { ...base, role: "alert", headline: e.protocolDiffers.headline, detail: e.protocolDiffers.detail };
    case "timed-out":
      return { ...base, role: "alert", headline: e.timedOut.headline, detail: null, checklistLabel: e.timedOut.checklistLabel, checklist: e.timedOut.checklist };
    case "unavailable":
      return { ...base, role: "alert", headline: e.unavailable.headline, detail: e.unavailable.detail };
    case "user-confirmed":
      return { ...base, role: "status", headline: e.userConfirmed.headline, detail: e.userConfirmed.detail };
    default:
      unreachable(connection.phase);
      return null;
  }
}

export interface WizardDoneView {
  /** `true` only when the contact record proved the connection. A user confirmation is never shown as verified. */
  readonly verified: boolean;
  readonly title: string;
  readonly body: string;
}

export function wizardDoneView(state: WizardState): WizardDoneView {
  const done = wizardCopy(state).done;
  return state.verification === "connected"
    ? { verified: true, title: done.title, body: done.body }
    : { verified: false, title: done.unverifiedTitle, body: done.unverifiedBody };
}
