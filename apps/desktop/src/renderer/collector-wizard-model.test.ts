import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CollectorBrowserId, CollectorRecommendationReason } from "../collector-browser-table";
import type { CollectorApplyReason } from "../collector-integration-apply-types";
import {
  isCollectorIntegrationRequest,
  type CollectorBrowserSummary,
  type CollectorConnectionSummary,
  type CollectorIntegrationResponse,
  type CollectorIntegrationStatus,
} from "../collector-integration-ipc";
import type { CollectorSaveDestinationIpcResult } from "../collector-save-destination-ipc";
import { WIZARD_MESSAGE_IDS, type WizardMessageId } from "./collector-wizard-copy";
import {
  APPLY_REASON_MESSAGE,
  classifyWizardResponse,
  initialWizardState,
  isWizardEventAllowed,
  moveRadioSelection,
  reduceWizard,
  wizardActions,
  wizardBrowserOptions,
  wizardCopy,
  wizardDestinationConfigured,
  wizardIsBusy,
  wizardMessage,
  wizardProgress,
  WIZARD_CONNECTION_TIMEOUT_MS,
  WIZARD_POLL_INTERVAL_MS,
  type WizardBrowserOption,
  type WizardEffect,
  type WizardState,
  type WizardSystemEvent,
  type WizardUserEvent,
} from "./collector-wizard-model";

// ----- fixtures ---------------------------------------------------------------------------------

const T0 = 1_000_000;

function entry(id: CollectorBrowserId, over: Partial<CollectorBrowserSummary> = {}): CollectorBrowserSummary {
  const verified = id === "chrome";
  return {
    id,
    verification: verified ? "verified" : "unverified",
    installed: "found",
    registration: "absent",
    registrationVia: null,
    policyBlocked: false,
    extensionLoadMayBeBlocked: false,
    extensionsAddress: `${id}://extensions`,
    ...over,
  };
}

type StatusOverrides = Omit<Partial<CollectorIntegrationStatus>, "browsers"> & { browsers?: Partial<CollectorIntegrationStatus["browsers"]> };

function status(over: StatusOverrides = {}): CollectorIntegrationStatus {
  const { browsers, ...rest } = over;
  return {
    applyInProgress: false,
    state: "not-set-up",
    reasons: [],
    inspectionComplete: true,
    registration: "absent",
    browsers: {
      defaultBrowser: "chrome",
      recommended: "chrome",
      recommendationReason: "default-supported",
      preferred: null,
      entries: [entry("edge"), entry("chrome"), entry("vivaldi")],
      ...browsers,
    },
    policy: { blocked: false, userLevelHostsDisabled: false, hostBlocked: false, extensionLoadMayBeBlocked: false },
    installed: { hostVersion: null, extensionVersion: null },
    payloadStatus: "valid",
    extensionFolderPlaced: true,
    writesAllowed: true,
    ...rest,
  };
}

function statusResponse(over: StatusOverrides = {}): CollectorIntegrationResponse {
  return { kind: "status", status: status(over) };
}

function applyResponse(over: Partial<Extract<CollectorIntegrationResponse, { kind: "apply" }>> = {}): CollectorIntegrationResponse {
  return { kind: "apply", action: "setup", outcome: "applied", reason: null, warnings: [], selfCheck: "ok", status: status({ state: "ready" }), ...over };
}

function connection(summary: CollectorConnectionSummary, applyInProgress = false): CollectorIntegrationResponse {
  return { kind: "connection", state: "ready", applyInProgress, connection: summary };
}

interface Harness {
  state: WizardState;
  now: number;
  /** Every effect emitted so far. */
  log: WizardEffect[];
}

type AnyEvent = WizardUserEvent | WizardSystemEvent;

function start(): Harness {
  return { state: initialWizardState(), now: T0, log: [] };
}

function send(h: Harness, event: AnyEvent, at?: number): readonly WizardEffect[] {
  if (at !== undefined) h.now = at;
  const reduction = reduceWizard(h.state, { ...event, now: h.now });
  h.state = reduction.state;
  h.log.push(...reduction.effects);
  for (const effect of reduction.effects) {
    if (effect.type === "request") expect(isCollectorIntegrationRequest(effect.request), JSON.stringify(effect.request)).toBe(true);
  }
  return reduction.effects;
}

function requestsOf(effects: readonly WizardEffect[]) {
  return effects.flatMap((effect) => (effect.type === "request" ? [effect.request] : []));
}

/** Answers the request that is in flight. */
function respond(h: Harness, response: CollectorIntegrationResponse): readonly WizardEffect[] {
  expect(h.state.inFlight, "a request is in flight").not.toBeNull();
  return send(h, { type: "response", requestId: h.state.inFlight!.requestId, response });
}

function atStepA(over: StatusOverrides = {}): Harness {
  const h = start();
  send(h, { type: "opened" });
  respond(h, statusResponse(over));
  return h;
}

function atStepB(over: StatusOverrides = {}): Harness {
  const h = atStepA(over);
  send(h, { type: "next" });
  expect(h.state.step).toBe("B");
  return h;
}

function atStepC(): Harness {
  const h = atStepB();
  send(h, { type: "register" });
  respond(h, applyResponse());
  send(h, { type: "next" });
  expect(h.state.step).toBe("C");
  return h;
}

function atStepD(placed = true): Harness {
  const h = atStepC();
  send(h, { type: "confirmDestination" });
  send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
  send(h, { type: "next" });
  expect(h.state.step).toBe("D");
  respond(h, statusResponse({ state: "ready", extensionFolderPlaced: placed }));
  return h;
}

function atStepE(): Harness {
  const h = atStepD();
  send(h, { type: "loaded" }, T0 + 10_000);
  expect(h.state.step).toBe("E");
  return h;
}

const ALL_KINDS_RESPONSES: readonly CollectorIntegrationResponse[] = [
  { kind: "unavailable", reason: "e2e-isolation" },
  { kind: "unavailable", reason: "payload-unavailable" },
  { kind: "unavailable", reason: "startup-failed" },
  { kind: "invalid-request" },
  { kind: "busy" },
  { kind: "error" },
  statusResponse(),
  applyResponse(),
  applyResponse({ outcome: "failed", reason: "write-failed" }),
  { kind: "cancelled" },
  { kind: "browser-required", status: status() },
  { kind: "browser-extensions", browser: "chrome", result: "opened" },
  { kind: "browser-extensions", browser: null, result: "browser-not-found" },
  { kind: "browser-download", result: "opened" },
  { kind: "extension-folder", intent: "copyExtensionPath", result: "done" },
  { kind: "extension-folder", intent: "revealExtensionFolder", result: "failed" },
  connection({ state: "waiting" }),
  connection({ state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "2026-11-20T00:00:00.000Z" }),
];

function actionLabels(h: Harness): string[] {
  return wizardActions(h.state).map((action) => action.label);
}

function action(h: Harness, id: string) {
  const found = wizardActions(h.state).find((candidate) => candidate.id === id);
  expect(found, `action ${id} on step ${h.state.step}`).toBeDefined();
  return found!;
}

// ----- tests ------------------------------------------------------------------------------------

describe("wizard model: start and step A", () => {
  it("opening asks for an inspection once and moves focus to the heading", () => {
    const h = start();
    const effects = send(h, { type: "opened" });
    expect(requestsOf(effects)).toEqual([{ intent: "inspect" }]);
    expect(effects.map((effect) => effect.type)).toEqual(["request", "focusHeading"]);
    expect(wizardIsBusy(h.state)).toBe(true);
    expect(wizardProgress(h.state)).toBe("手順 1 / 5");
    expect(send(h, { type: "opened" })).toEqual([]);
  });

  it("selects the recommended browser and offers 次へ", () => {
    const h = atStepA();
    expect(h.state.statusLoad).toBe("ready");
    expect(h.state.selectedBrowser).toBe("chrome");
    expect(actionLabels(h)).toEqual(["次へ", "あとで設定"]);
    expect(action(h, "next").enabled).toBe(true);
    expect(wizardMessage(h.state)).toBeNull();
  });

  it("discards a status taken while an apply was running", () => {
    const h = start();
    send(h, { type: "opened" });
    respond(h, statusResponse({ applyInProgress: true }));
    expect(h.state.status).toBeNull();
    expect(h.state.statusLoad).toBe("failed");
    expect(wizardMessage(h.state)?.id).toBe("inspect-failed");
    expect(action(h, "recheckBrowsers").enabled).toBe(true);
    send(h, { type: "recheckBrowsers" });
    respond(h, statusResponse());
    expect(h.state.statusLoad).toBe("ready");
    expect(wizardMessage(h.state)).toBeNull();
  });

  it("an IPC failure on the first inspection can be retried", () => {
    const h = start();
    send(h, { type: "opened" });
    send(h, { type: "requestFailed", requestId: h.state.inFlight!.requestId });
    expect(h.state.statusLoad).toBe("failed");
    expect(wizardMessage(h.state)).toMatchObject({ id: "inspect-failed", role: "alert" });
    expect(send(h, { type: "recheckBrowsers" }).map((effect) => effect.type)).toEqual(["request"]);
  });

  it("every reason keeps the right buttons (default-supported and the other selectable reasons)", () => {
    for (const reason of ["default-supported", "default-unsupported", "default-unverified", "default-not-installed", "default-unknown"] as const) {
      const h = atStepA({ browsers: { recommendationReason: reason } });
      expect(actionLabels(h), reason).toEqual(["次へ", "あとで設定"]);
    }
  });

  it("none-installed: download, recheck and an explicit continue; 次へ is not offered", () => {
    const h = atStepA({
      browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("edge", { installed: "not-found" }), entry("chrome", { installed: "not-found" }), entry("vivaldi", { installed: "not-found" })] },
    });
    expect(h.state.selectedBrowser).toBeNull();
    expect(actionLabels(h)).toEqual(["Google Chrome のダウンロードページを開く", "もう一度確認", "ブラウザーは入っています（このまま続ける）", "あとで設定"]);
    expect(isWizardEventAllowed(h.state, { type: "next" })).toBe(false);
    // The download page is requested by browser id only.
    expect(requestsOf(send(h, { type: "openDownloadPage", browser: "chrome" }))).toEqual([{ intent: "openBrowserDownloadPage", browser: "chrome" }]);
    respond(h, { kind: "browser-download", result: "opened" });
    expect(wizardMessage(h.state)?.id).toBe("download-opened");
    // A row without a download URL (unverified, so not even listed) is refused.
    expect(isWizardEventAllowed(h.state, { type: "openDownloadPage", browser: "vivaldi" })).toBe(false);
    // Nothing is written until the user chooses to continue, and only then is the flag sent.
    send(h, { type: "continueWithoutBrowser" });
    expect(h.state.step).toBe("B");
    expect(h.state.proceedWithoutBrowser).toBe(true);
    expect(requestsOf(send(h, { type: "register" }))).toEqual([{ intent: "setup", proceedWithoutSupportedBrowser: true }]);
  });

  it("download results map to messages", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { installed: "not-found" })] } });
    for (const [result, id] of [["failed", "download-failed"], ["not-offered", "download-not-offered"], ["opened", "download-opened"]] as const) {
      send(h, { type: "openDownloadPage", browser: "chrome" });
      respond(h, { kind: "browser-download", result });
      expect(wizardMessage(h.state)?.id).toBe(id);
    }
  });

  it("detection-failed: the verified rows are listed as 確認できませんでした and the user must choose one to continue", () => {
    const h = atStepA({
      browsers: { recommended: null, recommendationReason: "detection-failed", entries: [entry("edge", { installed: "unknown" }), entry("chrome", { installed: "unknown" }), entry("vivaldi", { installed: "unknown" })] },
    });
    expect(wizardBrowserOptions(h.state.status)).toEqual([{ id: "chrome", recommended: false, selectable: true, note: "detection-unknown" }]);
    expect(h.state.selectedBrowser).toBeNull();
    expect(action(h, "continueWithoutBrowser").enabled).toBe(false);
    expect(action(h, "continueWithoutBrowser").label).toBe("このブラウザーで続ける");
    send(h, { type: "selectBrowser", browser: "chrome" });
    expect(action(h, "continueWithoutBrowser").enabled).toBe(true);
    send(h, { type: "continueWithoutBrowser" });
    expect(requestsOf(send(h, { type: "register" }))).toEqual([{ intent: "setup", browser: "chrome", proceedWithoutSupportedBrowser: true }]);
  });

  it("a policy-blocked browser is shown but cannot be selected or continued with", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { policyBlocked: true })] } });
    expect(wizardBrowserOptions(h.state.status)).toEqual([{ id: "chrome", recommended: false, selectable: false, note: "policy-blocked" }]);
    expect(isWizardEventAllowed(h.state, { type: "selectBrowser", browser: "chrome" })).toBe(false);
    expect(isWizardEventAllowed(h.state, { type: "next" })).toBe(false);
  });

  it("selecting an unlisted or unverified browser is ignored", () => {
    const h = atStepA();
    expect(send(h, { type: "selectBrowser", browser: "edge" })).toEqual([]);
    expect(h.state.selectedBrowser).toBe("chrome");
  });

  it("going on from step A clears an earlier continue-without choice and sends the selected browser", () => {
    const h = atStepA();
    send(h, { type: "next" });
    expect(h.state.proceedWithoutBrowser).toBe(false);
    expect(requestsOf(send(h, { type: "register" }))).toEqual([{ intent: "setup", browser: "chrome" }]);
  });
});

describe("wizard model: radiogroup keys", () => {
  const options: readonly WizardBrowserOption[] = [
    { id: "edge", recommended: true, selectable: true, note: null },
    { id: "chrome", recommended: false, selectable: false, note: "policy-blocked" },
    { id: "vivaldi", recommended: false, selectable: true, note: null },
  ];

  it("moves forward and back, wraps at both ends and skips disabled options", () => {
    expect(moveRadioSelection(options, "edge", "ArrowDown")).toBe("vivaldi");
    expect(moveRadioSelection(options, "edge", "ArrowRight")).toBe("vivaldi");
    expect(moveRadioSelection(options, "vivaldi", "ArrowDown")).toBe("edge");
    expect(moveRadioSelection(options, "edge", "ArrowUp")).toBe("vivaldi");
    expect(moveRadioSelection(options, "edge", "ArrowLeft")).toBe("vivaldi");
    expect(moveRadioSelection(options, "vivaldi", "ArrowUp")).toBe("edge");
  });

  it("Home and End jump; with no selection forward lands first and back lands last", () => {
    expect(moveRadioSelection(options, "vivaldi", "Home")).toBe("edge");
    expect(moveRadioSelection(options, "edge", "End")).toBe("vivaldi");
    expect(moveRadioSelection(options, null, "ArrowDown")).toBe("edge");
    expect(moveRadioSelection(options, null, "ArrowUp")).toBe("vivaldi");
    expect(moveRadioSelection(options, "chrome", "ArrowDown")).toBe("edge");
  });

  it("a single option wraps onto itself and nothing selectable gives null", () => {
    const single: readonly WizardBrowserOption[] = [{ id: "chrome", recommended: true, selectable: true, note: null }];
    expect(moveRadioSelection(single, "chrome", "ArrowDown")).toBe("chrome");
    expect(moveRadioSelection(single, "chrome", "ArrowUp")).toBe("chrome");
    expect(moveRadioSelection([{ id: "chrome", recommended: false, selectable: false, note: "policy-blocked" }], null, "ArrowDown")).toBeNull();
    expect(moveRadioSelection([], null, "Home")).toBeNull();
  });

  it("the reducer moves the selection and the focus together", () => {
    const h = atStepA();
    const effects = send(h, { type: "radioKey", key: "ArrowDown" });
    expect(effects).toEqual([{ type: "focusRadio", browser: "chrome" }]);
    expect(h.state.selectedBrowser).toBe("chrome");
    const none = atStepA({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { policyBlocked: true })] } });
    expect(send(none, { type: "radioKey", key: "ArrowDown" })).toEqual([]);
  });

  it("only offers verified, found rows (Edge and Vivaldi are unverified in the table)", () => {
    expect(wizardBrowserOptions(status()).map((option) => option.id)).toEqual(["chrome"]);
    expect(wizardBrowserOptions(null)).toEqual([]);
  });
});

describe("wizard model: step B", () => {
  it("nothing is requested until the user presses the button, and the request carries the enum only", () => {
    const h = atStepB();
    expect(h.log.filter((effect) => effect.type === "request").map((effect) => (effect as { request: unknown }).request)).toEqual([{ intent: "inspect" }]);
    const effects = send(h, { type: "register" });
    expect(requestsOf(effects)).toEqual([{ intent: "setup", browser: "chrome" }]);
    expect(wizardIsBusy(h.state)).toBe(true);
  });

  it("maps a successful apply to registered / registered-verified / already-ready / refreshed", () => {
    const cases: ReadonlyArray<readonly [Partial<Extract<CollectorIntegrationResponse, { kind: "apply" }>>, WizardMessageId]> = [
      [{ selfCheck: "ok" }, "registered-verified"],
      [{ selfCheck: "skipped" }, "registered"],
      [{ outcome: "noop", selfCheck: "skipped" }, "already-ready"],
      [{ action: "refresh", outcome: "applied" }, "refreshed"],
    ];
    for (const [over, id] of cases) {
      const h = atStepB();
      send(h, { type: "register" });
      respond(h, applyResponse(over));
      expect(wizardMessage(h.state)?.id).toBe(id);
      expect(wizardMessage(h.state)?.role).toBe("status");
      expect(action(h, "next").enabled).toBe(true);
      expect(isWizardEventAllowed(h.state, { type: "register" })).toBe(false);
    }
  });

  it("a foreign registration asks first; only 切り替える sends confirmReplaceForeign", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse({ outcome: "refused", reason: "foreign-confirmation-required", status: status({ state: "foreign-registration" }) }));
    expect(wizardMessage(h.state)).toMatchObject({ id: "foreign-confirmation", role: "alert" });
    expect(actionLabels(h)).toEqual(["切り替える", "やめる", "戻る", "あとで設定"]);
    // The register button path is closed while the question is open.
    expect(isWizardEventAllowed(h.state, { type: "register" })).toBe(false);
    expect(send(h, { type: "register" })).toEqual([]);
    expect(requestsOf(send(h, { type: "confirmForeign" }))).toEqual([{ intent: "setup", browser: "chrome", confirmReplaceForeign: true }]);
  });

  it("やめる sends nothing and records that the switch was declined", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse({ outcome: "refused", reason: "foreign-confirmation-required", status: status({ state: "foreign-registration" }) }));
    expect(send(h, { type: "declineForeign" })).toEqual([]);
    expect(wizardMessage(h.state)?.id).toBe("foreign-declined");
    expect(isWizardEventAllowed(h.state, { type: "confirmForeign" })).toBe(false);
    // Without the explicit action there was never a confirm flag in any request.
    expect(requestsOf(h.log).some((request) => "confirmReplaceForeign" in request)).toBe(false);
  });

  it("repairs (not sets up) from damaged or registration-missing, without browser flags", () => {
    for (const state of ["damaged", "registration-missing"] as const) {
      const h = atStepB({ state });
      expect(requestsOf(send(h, { type: "register" }))).toEqual([{ intent: "repair" }]);
    }
    const h = atStepB({ state: "foreign-registration" });
    send(h, { type: "register" });
    respond(h, applyResponse({ outcome: "refused", reason: "foreign-confirmation-required", status: status({ state: "foreign-registration" }) }));
    expect(requestsOf(send(h, { type: "confirmForeign" }))).toEqual([{ intent: "setup", browser: "chrome", confirmReplaceForeign: true }]);
  });

  it("every apply reason produces a result, and policy blocks are terminal", () => {
    const reasons = Object.keys(APPLY_REASON_MESSAGE) as CollectorApplyReason[];
    expect(reasons.length).toBeGreaterThan(20);
    for (const reason of reasons) {
      const h = atStepB();
      send(h, { type: "register" });
      respond(h, applyResponse({ outcome: "refused", reason }));
      const message = wizardMessage(h.state);
      expect(message, reason).not.toBeNull();
      expect(WIZARD_MESSAGE_IDS).toContain(message!.id);
      expect(h.state.inFlight, reason).toBeNull();
      expect(h.state.step, reason).toBe("B");
    }
  });

  it("policy-blocked names the selected browser when it is the blocked one, and offers only 閉じる and 戻る", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse({
      outcome: "refused",
      reason: "policy-blocked",
      status: status({ state: "policy-blocked", browsers: { entries: [entry("edge"), entry("chrome", { policyBlocked: true }), entry("vivaldi")] } }),
    }));
    expect(wizardMessage(h.state)?.id).toBe("policy-blocked-browser");
    expect(wizardMessage(h.state)?.copy.headline).toBe("組織の管理設定により、Google Chrome はこの種類の連携プログラムを使えないようになっています。");
    expect(actionLabels(h)).toEqual(["閉じる", "戻る"]);
    expect(isWizardEventAllowed(h.state, { type: "register" })).toBe(false);
    expect(isWizardEventAllowed(h.state, { type: "next" })).toBe(false);

    const generic = atStepB();
    send(generic, { type: "register" });
    respond(generic, applyResponse({ outcome: "refused", reason: "policy-blocked" }));
    expect(wizardMessage(generic.state)?.id).toBe("policy-blocked");
  });

  it("busy is ignored and the same operation can be retried", () => {
    for (const response of [{ kind: "busy" } as const, applyResponse({ outcome: "refused", reason: "busy" })]) {
      const h = atStepB();
      const first = requestsOf(send(h, { type: "register" }));
      respond(h, response);
      expect(wizardMessage(h.state)?.id).toBe("busy");
      expect(h.state.step).toBe("B");
      expect(action(h, "register").label).toBe("もう一度試す");
      expect(requestsOf(send(h, { type: "register" }))).toEqual(first);
    }
  });

  it("failed or partial results can be retried; a rejected IPC call too", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, applyResponse({ outcome: "partial", reason: null }));
    expect(wizardMessage(h.state)?.id).toBe("register-failed");
    send(h, { type: "register" });
    send(h, { type: "requestFailed", requestId: h.state.inFlight!.requestId });
    expect(wizardMessage(h.state)?.id).toBe("request-failed");
    expect(action(h, "register").enabled).toBe(true);
  });

  it("a status taken during an apply is not adopted from an apply response", () => {
    const h = atStepB();
    const before = h.state.status;
    send(h, { type: "register" });
    respond(h, applyResponse({ status: status({ applyInProgress: true, state: "damaged" }) }));
    expect(h.state.status).toBe(before);
    expect(wizardMessage(h.state)?.id).toBe("registered-verified");
  });

  it("browser-required returns to step A with the new facts and writes nothing", () => {
    const h = atStepB();
    send(h, { type: "register" });
    const effects = respond(h, {
      kind: "browser-required",
      status: status({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { installed: "not-found" })] } }),
    });
    expect(h.state.step).toBe("A");
    expect(effects.map((effect) => effect.type)).toEqual(["focusHeading"]);
    expect(h.state.selectedBrowser).toBeNull();
    expect(h.state.proceedWithoutBrowser).toBe(false);
    expect(actionLabels(h)).toContain("ブラウザーは入っています（このまま続ける）");
  });
});

describe("wizard model: one operation at a time", () => {
  it("ignores operation events while a setup is in flight, and cannot be closed during it", () => {
    const h = atStepB();
    send(h, { type: "register" });
    const id = h.state.nextRequestId;
    for (const event of [{ type: "register" }, { type: "next" }, { type: "back" }, { type: "later" }, { type: "escape" }, { type: "confirmForeign" }] as const) {
      expect(send(h, event), event.type).toEqual([]);
    }
    expect(h.state.nextRequestId).toBe(id);
    expect(h.state.closed).toBeNull();
    expect(wizardActions(h.state).every((candidate) => !candidate.enabled)).toBe(true);
  });

  it("a read-only operation in flight blocks other operations but may be walked away from", () => {
    const h = atStepA();
    send(h, { type: "recheckBrowsers" });
    expect(send(h, { type: "recheckBrowsers" })).toEqual([]);
    expect(send(h, { type: "next" })).toEqual([]);
    const effects = send(h, { type: "later" });
    expect(effects).toEqual([{ type: "close", outcome: "later" }]);
    expect(h.state.closed).toBe("later");
  });

  it("a stale or unknown response is ignored", () => {
    const h = atStepB();
    send(h, { type: "register" });
    const stale = h.state.inFlight!.requestId - 1;
    const before = h.state;
    expect(send(h, { type: "response", requestId: stale, response: applyResponse() })).toEqual([]);
    expect(h.state).toBe(before);
    expect(send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "cancelled" } })).toEqual([]);
    expect(send(h, { type: "requestFailed", requestId: 999 })).toEqual([]);
  });

  it("every response kind is handled for every operation without throwing or leaving a request in flight", () => {
    const builders: ReadonlyArray<readonly [string, () => Harness]> = [
      ["inspect", () => { const h = start(); send(h, { type: "opened" }); return h; }],
      ["recheck", () => { const h = atStepA(); send(h, { type: "recheckBrowsers" }); return h; }],
      ["setup", () => { const h = atStepB(); send(h, { type: "register" }); return h; }],
      ["placement", () => { const h = atStepC(); send(h, { type: "confirmDestination" }); send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "cancelled" } }); send(h, { type: "next" }); return h; }],
      ["open-browser", () => { const h = atStepD(); send(h, { type: "openBrowserExtensions" }); return h; }],
      ["copy-path", () => { const h = atStepD(); send(h, { type: "copyPath" }); return h; }],
      ["reveal", () => { const h = atStepD(); send(h, { type: "revealFolder" }); return h; }],
      ["poll", () => { const h = atStepE(); return h; }],
    ];
    for (const [name, build] of builders) {
      for (const response of ALL_KINDS_RESPONSES) {
        const h = build();
        expect(h.state.inFlight, name).not.toBeNull();
        expect(() => respond(h, response), `${name} <- ${response.kind}`).not.toThrow();
        expect(h.state.inFlight, `${name} <- ${response.kind}`).toBeNull();
        expect(h.state.closed).toBeNull();
      }
    }
  });

  it("classifies all twelve response kinds", () => {
    const kinds = new Set(ALL_KINDS_RESPONSES.map((response) => response.kind));
    expect([...kinds].sort()).toEqual([
      "apply", "browser-download", "browser-extensions", "browser-required", "busy", "cancelled", "connection", "error",
      "extension-folder", "invalid-request", "status", "unavailable",
    ]);
    for (const response of ALL_KINDS_RESPONSES) expect(classifyWizardResponse(response)).toBeDefined();
  });

  it("an unavailable integration is reported on any step and blocks step B for good", () => {
    const h = atStepB();
    send(h, { type: "register" });
    respond(h, { kind: "unavailable", reason: "e2e-isolation" });
    expect(wizardMessage(h.state)?.id).toBe("unavailable-e2e-isolation");
    expect(actionLabels(h)).toEqual(["閉じる", "戻る"]);
  });
});

describe("wizard model: step C (design 4.4)", () => {
  const cases: ReadonlyArray<readonly [CollectorSaveDestinationIpcResult, WizardMessageId, readonly string[]]> = [
    [{ kind: "configured", writesEnabled: true }, "destination-configured", ["次へ", "戻る", "あとで設定"]],
    [{ kind: "already-configured", writesEnabled: true }, "destination-configured", ["次へ", "戻る", "あとで設定"]],
    [{ kind: "configured", writesEnabled: false }, "destination-writes-disabled", ["次へ（保存は無効のまま）", "戻る", "あとで設定"]],
    [{ kind: "already-configured", writesEnabled: false }, "destination-writes-disabled", ["次へ（保存は無効のまま）", "戻る", "あとで設定"]],
    [{ kind: "cancelled" }, "destination-cancelled", ["もう一度確認する", "次へ", "戻る", "あとで設定"]],
    [{ kind: "error" }, "destination-error", ["もう一度確認する", "戻る", "あとで設定"]],
    [{ kind: "busy" }, "destination-busy", ["もう一度確認する", "戻る", "あとで設定"]],
    [{ kind: "not-configured" }, "destination-error", ["もう一度確認する", "戻る", "あとで設定"]],
    [{ kind: "cleared" }, "destination-error", ["もう一度確認する", "戻る", "あとで設定"]],
  ];

  it("starts with 保存先を確認する and dispatches the existing command once", () => {
    const h = atStepC();
    expect(actionLabels(h)).toEqual(["保存先を確認する", "戻る", "あとで設定"]);
    expect(isWizardEventAllowed(h.state, { type: "next" })).toBe(false);
    const effects = send(h, { type: "confirmDestination" });
    expect(effects).toEqual([{ type: "configureSaveDestination", requestId: h.state.inFlight!.requestId }]);
    expect(send(h, { type: "confirmDestination" })).toEqual([]);
  });

  for (const [result, id, labels] of cases) {
    it(`maps ${result.kind}${"writesEnabled" in result ? ` (writes ${result.writesEnabled ? "on" : "off"})` : ""} to ${id}`, () => {
      const h = atStepC();
      send(h, { type: "confirmDestination" });
      send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result });
      expect(wizardMessage(h.state)?.id).toBe(id);
      expect(actionLabels(h)).toEqual(labels);
      expect(wizardDestinationConfigured(h.state)).toBe(id === "destination-configured");
    });
  }

  it("an IPC rejection reads as an error and can be retried", () => {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "requestFailed", requestId: h.state.inFlight!.requestId });
    expect(wizardMessage(h.state)?.id).toBe("destination-error");
    expect(action(h, "confirmDestination").enabled).toBe(true);
  });

  it("cancelled lets the user go on, and the step E line then says the destination is not set", () => {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "cancelled" } });
    send(h, { type: "next" });
    expect(h.state.step).toBe("D");
    expect(wizardDestinationConfigured(h.state)).toBe(false);
  });
});

describe("wizard model: step D", () => {
  it("entering D checks the extension folder, then offers the actions", () => {
    const h = atStepC();
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
    const effects = send(h, { type: "next" });
    expect(requestsOf(effects)).toEqual([{ intent: "inspect" }]);
    expect(effects.map((effect) => effect.type)).toEqual(["request", "focusHeading"]);
    expect(h.state.placement).toBe("checking");
    expect(actionLabels(h)).toEqual(["戻る", "あとで設定"]);
    respond(h, statusResponse({ state: "ready", extensionFolderPlaced: true }));
    expect(h.state.placement).toBe("placed");
    expect(actionLabels(h)).toEqual([
      "Google Chrome で拡張機能の画面を開く", "アドレスをコピー", "パスをコピー", "フォルダーを開く", "読み込みました", "戻る", "あとで設定",
    ]);
    expect(wizardProgress(h.state)).toBe("手順 4 / 5");
  });

  it("an unplaced folder shows a message and can be rechecked", () => {
    const h = atStepD(false);
    expect(h.state.placement).toBe("missing");
    expect(wizardMessage(h.state)).toMatchObject({ id: "extension-not-placed", role: "alert" });
    expect(isWizardEventAllowed(h.state, { type: "loaded" })).toBe(false);
    expect(actionLabels(h)).toEqual(["もう一度試す", "戻る", "あとで設定"]);
    send(h, { type: "retryPlacement" });
    respond(h, statusResponse({ state: "ready", extensionFolderPlaced: true }));
    expect(h.state.placement).toBe("placed");
    expect(wizardMessage(h.state)).toBeNull();
  });

  it("opens the browser by id, copies the address (no path) and asks the main process for the path actions", () => {
    const h = atStepD();
    expect(requestsOf(send(h, { type: "openBrowserExtensions" }))).toEqual([{ intent: "openBrowserExtensions", browser: "chrome" }]);
    respond(h, { kind: "browser-extensions", browser: "chrome", result: "opened" });
    expect(wizardMessage(h.state)?.id).toBe("browser-opened");
    send(h, { type: "openBrowserExtensions" });
    respond(h, { kind: "browser-extensions", browser: "chrome", result: "failed" });
    expect(wizardMessage(h.state)).toMatchObject({ id: "browser-not-opened", role: "alert" });
    expect(wizardMessage(h.state)?.copy.detail).toContain("chrome://extensions");

    const copy = send(h, { type: "copyAddress" });
    expect(copy).toEqual([{ type: "copyText", purpose: "address", text: "chrome://extensions" }]);
    send(h, { type: "clipboardResult", purpose: "address", ok: true });
    expect(wizardMessage(h.state)).toMatchObject({ id: "address-copied", role: "status" });
    send(h, { type: "clipboardResult", purpose: "address", ok: false });
    expect(wizardMessage(h.state)?.id).toBe("address-copy-failed");

    expect(requestsOf(send(h, { type: "copyPath" }))).toEqual([{ intent: "copyExtensionPath" }]);
    respond(h, { kind: "extension-folder", intent: "copyExtensionPath", result: "done" });
    expect(wizardMessage(h.state)?.id).toBe("path-copied");
    send(h, { type: "copyPath" });
    respond(h, { kind: "extension-folder", intent: "copyExtensionPath", result: "failed" });
    expect(wizardMessage(h.state)?.id).toBe("path-copy-failed");

    expect(requestsOf(send(h, { type: "revealFolder" }))).toEqual([{ intent: "revealExtensionFolder" }]);
    respond(h, { kind: "extension-folder", intent: "revealExtensionFolder", result: "unavailable" });
    expect(wizardMessage(h.state)?.id).toBe("folder-open-failed");
    send(h, { type: "revealFolder" });
    respond(h, { kind: "extension-folder", intent: "revealExtensionFolder", result: "done" });
    expect(wizardMessage(h.state)).toBeNull();

    // A response of the wrong intent is not taken as success.
    send(h, { type: "copyPath" });
    respond(h, { kind: "extension-folder", intent: "revealExtensionFolder", result: "done" });
    expect(wizardMessage(h.state)?.id).toBe("request-failed");
  });

  it("with no usable browser (continued without one) only the manual steps are offered", () => {
    const h = atStepA({ browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { installed: "not-found" })] } });
    send(h, { type: "continueWithoutBrowser" });
    send(h, { type: "register" });
    respond(h, applyResponse());
    send(h, { type: "next" });
    send(h, { type: "confirmDestination" });
    send(h, { type: "destinationResult", requestId: h.state.inFlight!.requestId, result: { kind: "configured", writesEnabled: true } });
    send(h, { type: "next" });
    respond(h, statusResponse({ state: "ready", browsers: { recommended: null, recommendationReason: "none-installed", entries: [entry("chrome", { installed: "not-found" })] } }));
    expect(h.state.placement).toBe("placed");
    expect(actionLabels(h)).toEqual(["パスをコピー", "フォルダーを開く", "読み込みました", "戻る", "あとで設定"]);
    expect(isWizardEventAllowed(h.state, { type: "openBrowserExtensions" })).toBe(false);
    expect(isWizardEventAllowed(h.state, { type: "copyAddress" })).toBe(false);
    expect(wizardCopy(h.state).stepD.title).toBe("ブラウザー に Collector を読み込む");
  });

  it("the extension-load policy flag is available to the panel from the entry", () => {
    const h = atStepD();
    expect(h.state.status?.browsers.entries.find((candidate) => candidate.id === "chrome")?.extensionLoadMayBeBlocked).toBe(false);
  });

  it("back and forward keep each step's earlier result", () => {
    const h = atStepD();
    send(h, { type: "back" });
    expect(h.state.step).toBe("C");
    expect(wizardMessage(h.state)?.id).toBe("destination-configured");
    send(h, { type: "back" });
    expect(h.state.step).toBe("B");
    expect(wizardMessage(h.state)?.id).toBe("registered-verified");
    send(h, { type: "back" });
    expect(h.state.step).toBe("A");
    expect(send(h, { type: "back" })).toEqual([]);
  });
});

describe("wizard model: step E connection check (design 4.6)", () => {
  it("entering E starts the ticker and the first poll, and moves focus to the heading", () => {
    const h = atStepD();
    const effects = send(h, { type: "loaded" }, T0 + 5_000);
    expect(effects.map((effect) => effect.type)).toEqual(["focusHeading", "ticker", "request"]);
    expect(effects[1]).toMatchObject({ type: "ticker", active: true });
    expect(requestsOf(effects)).toEqual([{ intent: "checkConnection" }]);
    expect(h.state.connection).toMatchObject({ phase: "waiting", startedAt: T0 + 5_000, lastPollAt: T0 + 5_000 });
    expect(wizardProgress(h.state)).toBe("手順 5 / 5");
    expect(wizardIsBusy(h.state)).toBe(false);
  });

  it("polls every 2 s, never while a poll is in flight, and never moves focus", () => {
    const h = atStepD();
    const start0 = T0;
    send(h, { type: "loaded" }, start0);
    respond(h, connection({ state: "waiting" }));
    expect(send(h, { type: "tick" }, start0 + WIZARD_POLL_INTERVAL_MS - 1)).toEqual([]);
    const effects = send(h, { type: "tick" }, start0 + WIZARD_POLL_INTERVAL_MS);
    expect(requestsOf(effects)).toEqual([{ intent: "checkConnection" }]);
    expect(effects.some((effect) => effect.type === "focusHeading")).toBe(false);
    // The poll is still in flight: no second request however many ticks come, even past the interval.
    expect(send(h, { type: "tick" }, start0 + 3 * WIZARD_POLL_INTERVAL_MS)).toEqual([]);
    respond(h, connection({ state: "waiting" }));
    // The interval counts from the last request (start0 + 2 s), not from the answer.
    expect(requestsOf(send(h, { type: "tick" }, start0 + 3 * WIZARD_POLL_INTERVAL_MS))).toEqual([{ intent: "checkConnection" }]);
    respond(h, connection({ state: "waiting" }));
    expect(send(h, { type: "tick" }, start0 + 4 * WIZARD_POLL_INTERVAL_MS - 1)).toEqual([]);
    expect(requestsOf(send(h, { type: "tick" }, start0 + 5 * WIZARD_POLL_INTERVAL_MS))).toEqual([{ intent: "checkConnection" }]);
  });

  it("times out at exactly 3 minutes and stops the ticker", () => {
    const h = atStepD();
    send(h, { type: "loaded" }, T0);
    respond(h, connection({ state: "waiting" }));
    const justBefore = send(h, { type: "tick" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS - 1);
    expect(h.state.connection?.phase).toBe("waiting");
    expect(justBefore.every((effect) => effect.type === "request")).toBe(true);
    if (h.state.inFlight !== null) respond(h, connection({ state: "waiting" }));
    const atTimeout = send(h, { type: "tick" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS);
    expect(h.state.connection?.phase).toBe("timed-out");
    expect(atTimeout).toEqual([{ type: "ticker", active: false, intervalMs: expect.any(Number) }]);
    expect(h.state.inFlight).toBeNull();
    expect(actionLabels(h)).toEqual(["もう一度待つ", "Collector の「はじめに」画面に「準備ができました」と表示されている", "戻る", "あとで設定"]);
    // No more requests after the timeout.
    expect(send(h, { type: "tick" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS + 10_000)).toEqual([]);
  });

  it("a poll in flight at the timeout is dropped and its late answer ignored", () => {
    const h = atStepD();
    send(h, { type: "loaded" }, T0);
    const requestId = h.state.inFlight!.requestId;
    send(h, { type: "tick" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS);
    expect(h.state.connection?.phase).toBe("timed-out");
    send(h, { type: "response", requestId, response: connection({ state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "x" }) });
    expect(h.state.connection?.phase).toBe("timed-out");
  });

  it("もう一度待つ starts a fresh 3-minute round", () => {
    const h = atStepD();
    send(h, { type: "loaded" }, T0);
    send(h, { type: "tick" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS);
    const effects = send(h, { type: "waitAgain" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS + 500);
    expect(effects.map((effect) => effect.type)).toEqual(["ticker", "request"]);
    expect(h.state.connection).toMatchObject({ phase: "waiting", startedAt: T0 + WIZARD_CONNECTION_TIMEOUT_MS + 500 });
    send(h, { type: "response", requestId: h.state.inFlight!.requestId, response: connection({ state: "waiting" }) });
    send(h, { type: "tick" }, T0 + WIZARD_CONNECTION_TIMEOUT_MS + 500 + WIZARD_CONNECTION_TIMEOUT_MS - 1);
    expect(h.state.connection?.phase).toBe("waiting");
  });

  it("connected: stops polling, finishes through 完了, shows the done screen and closes as finished", () => {
    const h = atStepE();
    const effects = respond(h, connection({ state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "2026-11-20T00:00:00.000Z" }));
    expect(effects).toEqual([{ type: "ticker", active: false, intervalMs: expect.any(Number) }]);
    expect(h.state.connection?.phase).toBe("connected");
    expect(h.state.verification).toBe("connected");
    expect(actionLabels(h)).toEqual(["完了", "戻る"]);
    expect(send(h, { type: "tick" }, T0 + 60_000)).toEqual([]);
    const finish = send(h, { type: "finish" });
    expect(finish.map((effect) => effect.type)).toEqual(["focusHeading"]);
    expect(h.state.step).toBe("done");
    expect(wizardProgress(h.state)).toBeNull();
    expect(actionLabels(h)).toEqual(["閉じる"]);
    expect(send(h, { type: "close" })).toEqual([{ type: "close", outcome: "finished" }]);
    expect(h.state.closed).toBe("finished");
  });

  it("extension-version-differs carries both versions, offers re-check, and polling stops until asked", () => {
    const h = atStepE();
    respond(h, connection({ state: "extension-version-differs", loadedVersion: "0.3.0", placedVersion: "0.4.0" }));
    expect(h.state.connection).toMatchObject({ phase: "extension-version-differs", loadedVersion: "0.3.0", placedVersion: "0.4.0" });
    expect(wizardCopy(h.state).stepE.versionDiffers.headline).toContain("（0.3.0）");
    expect(wizardCopy(h.state).stepE.versionDiffers.headline).toContain("（0.4.0）");
    expect(actionLabels(h)).toEqual(["Google Chrome で拡張機能の画面を開く", "もう一度確認", "戻る", "あとで設定"]);
    expect(send(h, { type: "tick" }, T0 + 30_000)).toEqual([]);
    const effects = send(h, { type: "recheckConnection" }, T0 + 31_000);
    expect(effects.map((effect) => effect.type)).toEqual(["ticker", "request"]);
    expect(h.state.connection?.phase).toBe("waiting");
  });

  it("protocol-differs ends in 閉じる; unavailable falls back to the explicit user confirmation", () => {
    const protocol = atStepE();
    respond(protocol, connection({ state: "protocol-differs" }));
    expect(actionLabels(protocol)).toEqual(["閉じる"]);
    expect(send(protocol, { type: "later" })).toEqual([{ type: "close", outcome: "later" }]);

    for (const response of [connection({ state: "unavailable" }), { kind: "unavailable", reason: "startup-failed" } as const]) {
      const h = atStepE();
      respond(h, response);
      expect(h.state.connection?.phase).toBe("unavailable");
      expect(actionLabels(h)).toEqual(["Collector の「はじめに」画面に「準備ができました」と表示されている", "戻る", "あとで設定"]);
      send(h, { type: "userConfirmed" });
      expect(h.state.connection?.phase).toBe("user-confirmed");
      expect(h.state.verification).toBe("user-confirmed");
      send(h, { type: "finish" });
      expect(h.state.verification).toBe("user-confirmed");
      expect(h.state.step).toBe("done");
    }
  });

  it("the user-confirmed fallback is available after a timeout and is never recorded as connected", () => {
    const h = atStepE();
    send(h, { type: "tick" }, T0 + 10_000 + WIZARD_CONNECTION_TIMEOUT_MS);
    expect(h.state.connection?.phase).toBe("timed-out");
    send(h, { type: "userConfirmed" });
    expect(h.state.verification).toBe("user-confirmed");
    expect(wizardCopy(h.state).stepE.userConfirmed.headline).toBe("ご確認ありがとうございます。");
  });

  it("a status taken while an apply ran is discarded and polled again at the next tick", () => {
    const h = atStepE();
    const connected = { state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "x" } as const;
    respond(h, connection(connected, true));
    expect(h.state.connection?.phase).toBe("waiting");
    expect(h.state.connection?.lastPollAt).toBeNull();
    expect(h.state.verification).toBeNull();
    expect(requestsOf(send(h, { type: "tick" }, T0 + 10_000 + 1))).toEqual([{ intent: "checkConnection" }]);
    respond(h, connection(connected));
    expect(h.state.connection?.phase).toBe("connected");
  });

  it("busy, error and a rejected call are transient: keep waiting", () => {
    const h = atStepE();
    respond(h, { kind: "busy" });
    expect(h.state.connection?.phase).toBe("waiting");
    send(h, { type: "tick" }, T0 + 10_000 + WIZARD_POLL_INTERVAL_MS);
    send(h, { type: "requestFailed", requestId: h.state.inFlight!.requestId });
    expect(h.state.connection?.phase).toBe("waiting");
    expect(h.state.inFlight).toBeNull();
  });

  it("leaving E (back, later) cancels polling and ignores a late answer", () => {
    const back = atStepE();
    const requestId = back.state.inFlight!.requestId;
    const effects = send(back, { type: "back" });
    expect(effects).toEqual([{ type: "ticker", active: false, intervalMs: expect.any(Number) }, { type: "focusHeading" }]);
    expect(back.state.step).toBe("D");
    expect(back.state.inFlight).toBeNull();
    send(back, { type: "response", requestId, response: connection({ state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "x" }) });
    expect(back.state.connection?.phase).toBe("waiting");
    expect(send(back, { type: "tick" }, T0 + 99_000)).toEqual([]);

    const later = atStepE();
    expect(send(later, { type: "later" })).toEqual([{ type: "ticker", active: false, intervalMs: expect.any(Number) }, { type: "close", outcome: "later" }]);
    expect(send(later, { type: "tick" }, T0 + 99_000)).toEqual([]);
  });

  it("a user event during a poll in flight is not blocked by the poll", () => {
    const h = atStepE();
    expect(h.state.inFlight?.operation).toBe("poll");
    expect(action(h, "back").enabled).toBe(true);
    expect(action(h, "later").enabled).toBe(true);
  });

  it("tolerates a clock that goes backwards", () => {
    const h = atStepE();
    respond(h, connection({ state: "waiting" }));
    expect(send(h, { type: "tick" }, T0)).toEqual([]);
    expect(h.state.connection?.phase).toBe("waiting");
  });
});

describe("wizard model: Esc, close and progress", () => {
  it("Esc equals あとで設定 on every step A to E and writes nothing", () => {
    const builders = [atStepA, atStepB, atStepC, atStepD, atStepE];
    for (const build of builders) {
      const h = build();
      const requestsBefore = requestsOf(h.log).length;
      const effects = send(h, { type: "escape" });
      expect(effects.at(-1)).toEqual({ type: "close", outcome: "later" });
      expect(h.state.closed).toBe("later");
      expect(requestsOf(h.log).length).toBe(requestsBefore);
      expect(send(h, { type: "register" })).toEqual([]);
    }
  });

  it("Esc on the last screen closes as finished", () => {
    const h = atStepE();
    respond(h, connection({ state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "x" }));
    send(h, { type: "finish" });
    expect(send(h, { type: "escape" })).toEqual([{ type: "close", outcome: "finished" }]);
    expect(isWizardEventAllowed(atStepE().state, { type: "close" })).toBe(false);
  });

  it("progress reads 手順 n / 5 for every step", () => {
    const labels = [atStepA(), atStepB(), atStepC(), atStepD(), atStepE()].map((h) => wizardProgress(h.state));
    expect(labels).toEqual(["手順 1 / 5", "手順 2 / 5", "手順 3 / 5", "手順 4 / 5", "手順 5 / 5"]);
  });

  it("emits focusHeading on each step change", () => {
    const h = atStepA();
    expect(send(h, { type: "next" }).map((effect) => effect.type)).toEqual(["focusHeading"]);
    send(h, { type: "register" });
    respond(h, applyResponse());
    expect(send(h, { type: "next" }).map((effect) => effect.type)).toEqual(["focusHeading"]);
  });

  it("every message id the model can produce has copy and a role", () => {
    const h = atStepB();
    for (const id of WIZARD_MESSAGE_IDS) {
      const state: WizardState = { ...h.state, results: { B: id } };
      expect(wizardMessage(state)?.copy.headline.length, id).toBeGreaterThan(0);
    }
  });
});

describe("wizard model: purity and safety", () => {
  it("does not mutate its input, and equal input gives equal output", () => {
    const h = atStepB();
    const frozen = JSON.parse(JSON.stringify(h.state)) as WizardState;
    const event = { type: "register", now: T0 } as const;
    const first = reduceWizard(h.state, event);
    const second = reduceWizard(h.state, event);
    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(h.state))).toEqual(frozen);
  });

  it("is a pure module: no DOM, Electron, timer or clock", () => {
    for (const file of ["collector-wizard-model.ts", "collector-wizard-copy.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
      expect(source, file).not.toMatch(/\bDate\b|performance\.now|\bsetTimeout\b|\bsetInterval\b|\bwindow\b|\bdocument\b|navigator|from "electron"|node:fs|require\(/u);
    }
  });

  it("holds no path: the state and every effect serialize without a drive path or UNC path", () => {
    const h = atStepE();
    respond(h, connection({ state: "connected", extensionVersion: "0.3.0", hostVersion: "0.2.0", contactedAt: "x" }));
    const dump = JSON.stringify([h.state, h.log]);
    expect(dump).not.toMatch(/[A-Za-z]:\\\\|\\\\\\\\/u);
  });

  it("never sends a flag the user did not explicitly choose", () => {
    const h = atStepE();
    for (const request of requestsOf(h.log)) {
      expect(request).not.toHaveProperty("confirmReplaceForeign");
      expect(request).not.toHaveProperty("proceedWithoutSupportedBrowser");
    }
  });

  it("covers every recommendation reason in the selectable/unselectable split", () => {
    const reasons: readonly CollectorRecommendationReason[] = ["default-supported", "default-unsupported", "default-unverified", "default-not-installed", "default-unknown", "none-installed", "detection-failed"];
    for (const reason of reasons) {
      const h = atStepA({ browsers: { recommendationReason: reason } });
      expect(wizardActions(h.state).length, reason).toBeGreaterThan(0);
    }
  });
});
