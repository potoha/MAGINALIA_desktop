import { describe, expect, it } from "vitest";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types.js";
import { buildAlpha1MigrationNotice, COLLECTOR_NOTICE_IDS, type CollectorNotice } from "./collector-integration-notices.js";
import type { CollectorBrowserId, CollectorRecommendationReason } from "./collector-browser-table.js";
import type { BrowserLocation, CollectorBrowserStatus, CollectorBrowsersInspection, CollectorIntegrationInspection, CollectorIntegrationState } from "./collector-integration-types.js";
import { createCollectorStartupRefresh, type CollectorStartupRefresh } from "./collector-startup-refresh.js";
import { DEFAULT_COLLECTOR_NOTICE_STATE, type CollectorNoticeState } from "./collector-integration-notices.js";
import {
  createCollectorApplyGate,
  createCollectorIntegrationService,
  summarizeConnection,
  type CollectorIntegrationServiceDependencies,
} from "./collector-integration-service.js";

const SECRET_EXTENSION_FOLDER = "C:\\Users\\someone\\AppData\\Local\\Programs\\MAGINALIA Collector\\extension";
const SECRET_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const NO_POLICY = { userLevelHostsDisabled: false, hostBlocked: false, blocked: false, extensionLoadMayBeBlocked: false, status: "read" } as const;

function browserStatus(id: CollectorBrowserId, overrides: Partial<CollectorBrowserStatus> = {}): CollectorBrowserStatus {
  return {
    id,
    verification: id === "chrome" ? "verified" : "unverified",
    installed: "not-found",
    source: null,
    effective: { target: null, ownership: "absent" },
    policy: NO_POLICY,
    ...overrides,
  };
}

/** Chrome installed (the only verified row today); Edge and Vivaldi not installed. */
function browsers(overrides: Partial<CollectorBrowsersInspection> = {}): CollectorBrowsersInspection {
  return {
    defaultBrowser: "chrome",
    recommended: "chrome",
    recommendationReason: "default-supported" as CollectorRecommendationReason,
    entries: [
      browserStatus("edge"),
      browserStatus("chrome", { installed: "found", source: "app-paths-hkcu", effective: { target: "chrome", ownership: "ours" } }),
      browserStatus("vivaldi"),
    ],
    ...overrides,
  };
}

function inspection(state: CollectorIntegrationState = "ready", overrides: Partial<CollectorIntegrationInspection> = {}): CollectorIntegrationInspection {
  return {
    state,
    reasons: [],
    inspectionComplete: true,
    registration: state === "not-set-up" ? "absent" : "ours",
    folderSecurityViolation: null,
    payload: { status: "valid", payloadId: "1.3.0+def5678" },
    installed: { payloadId: "1.3.0+def5678", activeSlot: "a", hostVersion: "1.3.0", extensionVersion: "0.4.0" },
    versions: { host: "equal", extension: "equal" },
    filesVerified: false,
    policy: { userLevelHostsDisabled: false, hostBlocked: false, blocked: false, extensionLoadMayBeBlocked: false, status: "read" },
    browsers: browsers(),
    contact: { status: "absent" },
    extensionFolderDisplay: SECRET_EXTENSION_FOLDER,
    writesAllowed: true,
    ...overrides,
  } as CollectorIntegrationInspection;
}

function applyResult(action: CollectorApplyResult["action"], outcome: CollectorApplyResult["outcome"] = "applied", reason: CollectorApplyResult["reason"] = null): CollectorApplyResult {
  const post = inspection(action === "remove" ? "not-set-up" : "ready");
  return { action, outcome, reason, warnings: [], targets: [], filesChanged: false, state: post.state, selfCheck: "skipped", inspection: post };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

interface Rig {
  readonly deps: CollectorIntegrationServiceDependencies;
  readonly applies: CollectorApplyRequest[];
  readonly recorded: CollectorApplyResult[];
  readonly published: Array<readonly CollectorNotice[]>;
  readonly logs: string[];
  readonly clipboard: string[];
  readonly launches: Array<{ readonly executable: string; readonly args: readonly string[] }>;
  readonly opened: string[];
  notices: CollectorNotice[];
  current: CollectorIntegrationInspection;
  applyImpl: (request: CollectorApplyRequest) => Promise<CollectorApplyResult>;
  confirmation: { confirmed: boolean; clearSaveDestination: boolean };
  clearCalls: number;
  /** What the locator answers per row (missing row: not-found). */
  locations: Partial<Record<CollectorBrowserId, BrowserLocation>>;
  readonly located: CollectorBrowserId[];
  launchResult: boolean;
  startup: CollectorStartupRefresh;
}

function rig(overrides: Partial<CollectorIntegrationServiceDependencies> = {}): Rig {
  const r: Rig = {
    applies: [],
    recorded: [],
    published: [],
    logs: [],
    clipboard: [],
    launches: [],
    opened: [],
    notices: [],
    current: inspection(),
    applyImpl: async (request) => applyResult(request.action),
    confirmation: { confirmed: true, clearSaveDestination: false },
    clearCalls: 0,
    locations: { chrome: { status: "found", source: "app-paths-hkcu", executablePath: SECRET_CHROME, rejected: [] } },
    located: [],
    launchResult: true,
    startup: undefined as unknown as CollectorStartupRefresh,
    get deps(): CollectorIntegrationServiceDependencies {
      return {
        mode: "active",
        startupRefresh: r.startup,
        inspect: async () => r.current,
        apply: async (request) => {
          r.applies.push(request);
          return r.applyImpl(request);
        },
        locateBrowser: async (id) => { r.located.push(id); return r.locations[id] ?? { status: "not-found", rejected: [] }; },
        gate: gate,
        launchBrowser: async (executable, args) => { r.launches.push({ executable, args }); return r.launchResult; },
        writeClipboardText: (text) => { r.clipboard.push(text); },
        openFolder: async (folder) => { r.opened.push(folder); return true; },
        confirmRemove: async () => r.confirmation,
        clearSaveDestination: async () => { r.clearCalls += 1; return { kind: "cleared" }; },
        publishNotices: (notices) => { r.published.push(notices); },
        logError: (code) => { r.logs.push(code); },
        ...overrides,
      };
    },
  };
  const gate = createCollectorApplyGate();
  r.startup = {
    runStartup: async () => ({ outcome: "no-action", notices: r.notices }),
    reconcile: async () => r.notices,
    dismiss: async (noticeId) => { r.notices = r.notices.filter((notice) => notice.id !== noticeId); return r.notices; },
    markNoticeSurfaceReady: async () => r.notices,
    recordApplyResult: async (result) => { r.recorded.push(result); },
    currentNotices: () => r.notices,
  };
  return r;
}

const noAbsolutePath = (value: unknown): void => {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/[A-Za-z]:\\\\/u);
  expect(text).not.toContain("someone");
  expect(text).not.toContain("chrome.exe");
};

describe("collector apply gate", () => {
  it("rejects a second tryRun while one is running and runs queued tasks in order", async () => {
    const gate = createCollectorApplyGate();
    const first = deferred<string>();
    const order: string[] = [];
    const running = gate.tryRun(async () => { order.push("first-start"); const value = await first.promise; order.push("first-end"); return value; });
    expect(gate.busy).toBe(true);
    expect(await gate.tryRun(async () => "second")).toEqual({ ran: false });
    const queued = gate.queue(async () => { order.push("queued"); return "queued"; });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    first.resolve("done");
    expect(await running).toEqual({ ran: true, value: "done" });
    expect(await queued).toBe("queued");
    expect(order).toEqual(["first-start", "first-end", "queued"]);
    expect(gate.busy).toBe(false);
    expect(await gate.tryRun(async () => "again")).toEqual({ ran: true, value: "again" });
  });

  it("releases the gate when a task throws", async () => {
    const gate = createCollectorApplyGate();
    await expect(gate.tryRun(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(gate.busy).toBe(false);
    expect((await gate.tryRun(async () => 1)).ran).toBe(true);
  });
});

describe("collector integration service", () => {
  it("runs only one apply at a time: repeated clicks get busy and never reach apply", async () => {
    const r = rig();
    const gate = deferred<CollectorApplyResult>();
    r.applyImpl = () => gate.promise;
    const service = createCollectorIntegrationService(r.deps);
    const first = service.handle({ intent: "setup" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [second, third, repair, remove] = await Promise.all([
      service.handle({ intent: "setup" }),
      service.handle({ intent: "setup" }),
      service.handle({ intent: "repair" }),
      service.handle({ intent: "remove" }),
    ]);
    expect([second.kind, third.kind, repair.kind, remove.kind]).toEqual(["busy", "busy", "busy", "busy"]);
    expect(r.applies).toHaveLength(1);
    gate.resolve(applyResult("setup"));
    expect((await first).kind).toBe("apply");
    expect(r.applies).toHaveLength(1);
    // the gate is free again
    r.applyImpl = async (request) => applyResult(request.action);
    expect((await service.handle({ intent: "repair" })).kind).toBe("apply");
  });

  it("records every apply result with the orchestrator, including refusals and failures, and publishes notices", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    r.applyImpl = async (request) => applyResult(request.action, "refused", "wrong-state");
    await service.handle({ intent: "setup" });
    r.applyImpl = async (request) => applyResult(request.action, "failed", "write-failed");
    await service.handle({ intent: "repair" });
    r.applyImpl = async (request) => applyResult(request.action, "applied");
    await service.handle({ intent: "remove" });
    expect(r.recorded.map((result) => [result.action, result.outcome])).toEqual([["setup", "refused"], ["repair", "failed"], ["remove", "applied"]]);
  });

  it("publishes the orchestrator notices only when they changed", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    r.notices = [buildAlpha1MigrationNotice()];
    await service.runStartup();
    await service.reconcile();
    expect(r.published).toHaveLength(1);
    expect(r.published[0]?.map((notice) => notice.id)).toEqual([COLLECTOR_NOTICE_IDS.alpha1Migration]);
    await service.dismissNotice(COLLECTOR_NOTICE_IDS.alpha1Migration);
    expect(r.published).toHaveLength(2);
    expect(r.published[1]).toEqual([]);
  });

  it("ignores a dismiss for an id that is not a Collector notice", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    r.notices = [buildAlpha1MigrationNotice()];
    await service.dismissNotice("../etc/passwd");
    await service.dismissNotice({ id: 1 });
    expect(r.notices).toHaveLength(1);
  });

  it("rejects malformed requests without touching anything", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    const bad: unknown[] = [
      undefined, null, "setup", 5, [], {}, { intent: "format-disk" }, { intent: "setup", path: "C:\\x" },
      { intent: "setup", command: "calc.exe" }, { intent: "inspect", confirmReplaceForeign: true },
      { intent: "repair", proceedWithoutSupportedBrowser: true }, { intent: "setup", confirmReplaceForeign: "yes" },
      { intent: "setup", proceedWithoutSupportedBrowser: 1 }, { intent: 7 },
      { intent: "openChromeExtensions" }, { intent: "setup", proceedWithoutChrome: true },
      { intent: "openBrowserExtensions", url: "https://example.test" }, { intent: "openBrowserExtensions", path: "C:\\x\\chrome.exe" },
      { intent: "openBrowserExtensions", browser: "brave" }, { intent: "openBrowserExtensions", browser: "C:\\x\\chrome.exe" },
      { intent: "openBrowserExtensions", browser: 1 }, { intent: "setup", browser: "chrome" }, { intent: "inspect", browser: "edge" },
    ];
    for (const request of bad) expect(await service.handle(request)).toEqual({ kind: "invalid-request" });
    expect(r.applies).toHaveLength(0);
    expect(r.launches).toHaveLength(0);
    expect(r.recorded).toHaveLength(0);
  });

  it("never returns a machine-local absolute path", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    const responses = [
      await service.handle({ intent: "inspect" }),
      await service.handle({ intent: "setup" }),
      await service.handle({ intent: "repair", confirmReplaceForeign: true }),
      await service.handle({ intent: "remove" }),
      await service.handle({ intent: "openBrowserExtensions" }),
      await service.handle({ intent: "openBrowserExtensions", browser: "chrome" }),
      await service.handle({ intent: "copyExtensionPath" }),
      await service.handle({ intent: "revealExtensionFolder" }),
      await service.handle({ intent: "checkConnection" }),
    ];
    expect(responses.map((response) => response.kind)).toEqual(["status", "apply", "apply", "apply", "browser-extensions", "browser-extensions", "extension-folder", "extension-folder", "connection"]);
    for (const response of responses) noAbsolutePath(response);
    // the path is used inside the main process only
    expect(r.clipboard).toEqual([SECRET_EXTENSION_FOLDER]);
    expect(r.opened).toEqual([SECRET_EXTENSION_FOLDER]);
    expect(r.launches).toEqual([
      { executable: SECRET_CHROME, args: ["chrome://extensions/"] },
      { executable: SECRET_CHROME, args: ["chrome://extensions/"] },
    ]);
  });

  it("setup without a supported browser is refused unless the user explicitly continued", async () => {
    const r = rig();
    r.current = inspection("not-set-up", {
      browsers: browsers({
        defaultBrowser: "edge",
        recommended: null,
        recommendationReason: "none-installed",
        entries: [browserStatus("edge"), browserStatus("chrome"), browserStatus("vivaldi")],
      }),
    });
    const service = createCollectorIntegrationService(r.deps);
    expect((await service.handle({ intent: "setup" })).kind).toBe("browser-required");
    expect(r.applies).toHaveLength(0);
    expect((await service.handle({ intent: "setup", proceedWithoutSupportedBrowser: true })).kind).toBe("apply");
    expect(r.applies).toEqual([{ action: "setup" }]);
    r.current = inspection("not-set-up", {
      browsers: browsers({
        defaultBrowser: "unknown",
        recommended: null,
        recommendationReason: "detection-failed",
        entries: [browserStatus("edge", { installed: "unknown" }), browserStatus("chrome", { installed: "unknown" }), browserStatus("vivaldi", { installed: "unknown" })],
      }),
    });
    expect((await service.handle({ intent: "setup" })).kind).toBe("browser-required");
  });

  it("setup needs a verified, installed, non-blocked browser: an unverified or blocked one does not count", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    const withEntries = (entries: readonly CollectorBrowserStatus[]) => inspection("not-set-up", { browsers: browsers({ entries }) });
    // Edge is installed but unverified: not enough.
    r.current = withEntries([browserStatus("edge", { installed: "found" }), browserStatus("chrome"), browserStatus("vivaldi")]);
    expect((await service.handle({ intent: "setup" })).kind).toBe("browser-required");
    // Chrome is installed but policy blocks it.
    r.current = withEntries([browserStatus("edge"), browserStatus("chrome", { installed: "found", policy: { ...NO_POLICY, userLevelHostsDisabled: true, blocked: true } }), browserStatus("vivaldi")]);
    expect((await service.handle({ intent: "setup" })).kind).toBe("browser-required");
    expect(r.applies).toHaveLength(0);
    // Chrome installed and allowed: proceeds.
    r.current = withEntries([browserStatus("edge"), browserStatus("chrome", { installed: "found" }), browserStatus("vivaldi")]);
    expect((await service.handle({ intent: "setup" })).kind).toBe("apply");
  });

  it("the status carries per-browser facts and never a path, an executable name or a ProgId", async () => {
    const r = rig();
    r.current = inspection("ready", {
      browsers: browsers({
        defaultBrowser: "other-chromium",
        recommended: "chrome",
        recommendationReason: "default-unverified",
        entries: [
          browserStatus("edge", { installed: "found", source: "known-program-files-x86", effective: { target: "chrome", ownership: "foreign" }, policy: { ...NO_POLICY, extensionLoadMayBeBlocked: true } }),
          browserStatus("chrome", { installed: "found", source: "app-paths-hkcu", effective: { target: "chrome", ownership: "ours" } }),
          browserStatus("vivaldi", { installed: "unknown" }),
        ],
      }),
    });
    const service = createCollectorIntegrationService(r.deps);
    const response = await service.handle({ intent: "inspect" });
    if (response.kind !== "status") throw new Error("expected a status response");
    expect(response).toMatchObject({
      kind: "status",
      status: {
        browsers: {
          defaultBrowser: "other-chromium",
          recommended: "chrome",
          recommendationReason: "default-unverified",
          entries: [
            { id: "edge", verification: "unverified", installed: "found", registration: "foreign", registrationVia: "chrome", policyBlocked: false, extensionLoadMayBeBlocked: true },
            { id: "chrome", verification: "verified", installed: "found", registration: "ours", registrationVia: "chrome", policyBlocked: false, extensionLoadMayBeBlocked: false },
            { id: "vivaldi", verification: "unverified", installed: "unknown", registration: "absent", registrationVia: null, policyBlocked: false, extensionLoadMayBeBlocked: false },
          ],
        },
      },
    });
    expect(Object.keys(response.status.browsers.entries[0]!).sort()).toEqual(
      ["extensionLoadMayBeBlocked", "id", "installed", "policyBlocked", "registration", "registrationVia", "verification"],
    );
    noAbsolutePath(response);
    expect(JSON.stringify(response)).not.toContain("source");
    expect(response.status).not.toHaveProperty("chrome");
  });

  it("forwards confirmReplaceForeign only when the renderer set it", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    await service.handle({ intent: "setup" });
    await service.handle({ intent: "setup", confirmReplaceForeign: true });
    await service.handle({ intent: "repair", confirmReplaceForeign: false });
    expect(r.applies).toEqual([{ action: "setup" }, { action: "setup", confirmReplaceForeign: true }, { action: "repair" }]);
  });

  it("remove asks the main-process confirmation first; declining changes nothing", async () => {
    const r = rig();
    r.confirmation = { confirmed: false, clearSaveDestination: true };
    const service = createCollectorIntegrationService(r.deps);
    expect(await service.handle({ intent: "remove" })).toEqual({ kind: "cancelled" });
    expect(r.applies).toHaveLength(0);
    expect(r.recorded).toHaveLength(0);
    expect(r.clearCalls).toBe(0);
  });

  it("remove with the checkbox also clears the save destination, after the removal", async () => {
    const r = rig();
    r.confirmation = { confirmed: true, clearSaveDestination: true };
    const service = createCollectorIntegrationService(r.deps);
    const response = await service.handle({ intent: "remove" });
    expect(response).toMatchObject({ kind: "apply", action: "remove", saveDestination: "cleared" });
    expect(r.clearCalls).toBe(1);
    expect(r.recorded.map((result) => result.action)).toEqual(["remove"]);
  });

  it("holds the gate while the remove confirmation is open", async () => {
    const r = rig();
    const confirmation = deferred<{ confirmed: boolean; clearSaveDestination: boolean }>();
    const service = createCollectorIntegrationService({ ...r.deps, confirmRemove: () => confirmation.promise });
    const removing = service.handle({ intent: "remove" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.handle({ intent: "remove" })).kind).toBe("busy");
    expect((await service.handle({ intent: "setup" })).kind).toBe("busy");
    confirmation.resolve({ confirmed: false, clearSaveDestination: false });
    expect(await removing).toEqual({ kind: "cancelled" });
  });

  it("reports an error, releases the gate and logs only a code when apply throws", async () => {
    const r = rig();
    r.applyImpl = async () => { throw new Error("C:\\secret\\path failed"); };
    const service = createCollectorIntegrationService(r.deps);
    expect(await service.handle({ intent: "setup" })).toEqual({ kind: "error" });
    expect(r.logs).toEqual(["MAGINALIA_COLLECTOR_INTEGRATION_REQUEST_FAILED"]);
    r.applyImpl = async (request) => applyResult(request.action);
    expect((await service.handle({ intent: "setup" })).kind).toBe("apply");
  });

  it("is inert under E2E isolation and without an embedded payload: nothing is called", async () => {
    for (const [mode, reason] of [["inert-e2e-isolation", "e2e-isolation"], ["inert-no-payload", "payload-unavailable"]] as const) {
      const r = rig();
      const calls: string[] = [];
      const service = createCollectorIntegrationService({
        ...r.deps,
        mode,
        inspect: async () => { calls.push("inspect"); return r.current; },
        apply: async () => { calls.push("apply"); return applyResult("setup"); },
        locateBrowser: async () => { calls.push("locate"); return r.locations.chrome ?? { status: "unknown" }; },
        launchBrowser: async () => { calls.push("launch"); return true; },
        writeClipboardText: () => { calls.push("clipboard"); },
      });
      for (const intent of ["inspect", "setup", "repair", "remove", "openBrowserExtensions", "copyExtensionPath", "revealExtensionFolder", "checkConnection"] as const) {
        expect(await service.handle({ intent })).toEqual({ kind: "unavailable", reason });
      }
      service.startPeriodicReconcile(1);
      service.stop();
      expect(calls).toEqual([]);
      expect(r.recorded).toHaveLength(0);
    }
  });

  it("startup failure never throws and is logged by code", async () => {
    const r = rig();
    r.startup = { ...r.startup, runStartup: async () => { throw new Error("D:\\x"); } };
    const service = createCollectorIntegrationService(r.deps);
    await expect(service.runStartup()).resolves.toBeUndefined();
    expect(r.logs).toEqual(["MAGINALIA_COLLECTOR_STARTUP_FAILED"]);
  });

  it("a throwing notice publisher does not break the service", async () => {
    const r = rig();
    r.notices = [buildAlpha1MigrationNotice()];
    const service = createCollectorIntegrationService({ ...r.deps, publishNotices: () => { throw new Error("window closed"); } });
    await expect(service.runStartup()).resolves.toBeDefined();
    expect(r.logs).toEqual(["MAGINALIA_COLLECTOR_NOTICE_PUBLISH_FAILED"]);
  });

  it("copy / reveal are unavailable when no extension folder is placed", async () => {
    const r = rig();
    r.current = inspection("not-set-up", { installed: { payloadId: null, activeSlot: null, hostVersion: null, extensionVersion: null }, extensionFolderDisplay: SECRET_EXTENSION_FOLDER });
    const service = createCollectorIntegrationService(r.deps);
    expect(await service.handle({ intent: "copyExtensionPath" })).toEqual({ kind: "extension-folder", intent: "copyExtensionPath", result: "unavailable" });
    expect(await service.handle({ intent: "revealExtensionFolder" })).toEqual({ kind: "extension-folder", intent: "revealExtensionFolder", result: "unavailable" });
    expect(r.clipboard).toEqual([]);
    expect(r.opened).toEqual([]);
  });

  it("openBrowserExtensions reports not-found / failed without spawning when the browser is missing", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    r.locations = { chrome: { status: "not-found", rejected: [] } };
    expect(await service.handle({ intent: "openBrowserExtensions" })).toEqual({ kind: "browser-extensions", browser: "chrome", result: "browser-not-found" });
    r.locations = { chrome: { status: "unknown" } };
    expect(await service.handle({ intent: "openBrowserExtensions" })).toEqual({ kind: "browser-extensions", browser: "chrome", result: "browser-not-found" });
    expect(r.launches).toHaveLength(0);
    r.locations = { chrome: { status: "found", source: "app-paths-hkcu", executablePath: SECRET_CHROME, rejected: [] } };
    r.launchResult = false;
    expect(await service.handle({ intent: "openBrowserExtensions" })).toEqual({ kind: "browser-extensions", browser: "chrome", result: "failed" });
  });

  it("openBrowserExtensions without a request.browser uses the recommended row and spawns its fixed arguments", async () => {
    const r = rig();
    const service = createCollectorIntegrationService(r.deps);
    expect(await service.handle({ intent: "openBrowserExtensions" })).toEqual({ kind: "browser-extensions", browser: "chrome", result: "opened" });
    expect(r.located).toEqual(["chrome"]);
    expect(r.launches).toEqual([{ executable: SECRET_CHROME, args: ["chrome://extensions/"] }]);
  });

  it("openBrowserExtensions with nothing recommended reports not-found without locating or spawning", async () => {
    const r = rig();
    r.current = inspection("not-set-up", { browsers: browsers({ recommended: null, recommendationReason: "none-installed", entries: [browserStatus("edge"), browserStatus("chrome"), browserStatus("vivaldi")] }) });
    const service = createCollectorIntegrationService(r.deps);
    expect(await service.handle({ intent: "openBrowserExtensions" })).toEqual({ kind: "browser-extensions", browser: null, result: "browser-not-found" });
    expect(r.located).toEqual([]);
    expect(r.launches).toEqual([]);
  });

  it("openBrowserExtensions with request.browser opens that row from the locator with the row's own arguments, never anything from the request", async () => {
    const r = rig();
    const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    r.locations = { ...r.locations, edge: { status: "found", source: "known-program-files-x86", executablePath: EDGE, rejected: [] } };
    const service = createCollectorIntegrationService(r.deps);
    const response = await service.handle({ intent: "openBrowserExtensions", browser: "edge" });
    expect(response).toEqual({ kind: "browser-extensions", browser: "edge", result: "opened" });
    expect(r.located).toEqual(["edge"]);
    expect(r.launches).toEqual([{ executable: EDGE, args: ["edge://extensions/"] }]);
    noAbsolutePath(response);
    // an explicit row skips the inspection: the request alone selects the row
    r.located.length = 0;
    r.launches.length = 0;
    expect(await service.handle({ intent: "openBrowserExtensions", browser: "vivaldi" })).toEqual({ kind: "browser-extensions", browser: "vivaldi", result: "browser-not-found" });
    expect(r.located).toEqual(["vivaldi"]);
    expect(r.launches).toEqual([]);
  });

  it("coalesces concurrent read-only inspections", async () => {
    const r = rig();
    let calls = 0;
    const release = deferred<CollectorIntegrationInspection>();
    const service = createCollectorIntegrationService({ ...r.deps, inspect: () => { calls += 1; return release.promise; } });
    const polls = [service.handle({ intent: "checkConnection" }), service.handle({ intent: "checkConnection" }), service.handle({ intent: "inspect" })];
    release.resolve(r.current);
    await Promise.all(polls);
    expect(calls).toBe(1);
  });

  it("reconcile runs on the interval until stopped", async () => {
    const r = rig();
    let reconciles = 0;
    r.startup = { ...r.startup, reconcile: async () => { reconciles += 1; return []; } };
    let tick: (() => void) | undefined;
    const cleared: unknown[] = [];
    const service = createCollectorIntegrationService({
      ...r.deps,
      setInterval: (callback) => { tick = callback; return "handle"; },
      clearInterval: (handle) => { cleared.push(handle); },
    });
    service.startPeriodicReconcile(1000);
    service.startPeriodicReconcile(1000); // idempotent
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconciles).toBe(1);
    service.stop();
    expect(cleared).toEqual(["handle"]);
  });
});

describe("collector integration service (review fixes)", () => {
  it("a refused remove records nothing and keeps the save destination", async () => {
    const r = rig();
    r.confirmation = { confirmed: true, clearSaveDestination: true };
    r.applyImpl = async (request) => applyResult(request.action, "refused", "wrong-state");
    const service = createCollectorIntegrationService(r.deps);
    const response = await service.handle({ intent: "remove" });
    expect(response).toMatchObject({ kind: "apply", outcome: "refused" });
    expect((response as { saveDestination?: unknown }).saveDestination).toBeUndefined();
    expect(r.clearCalls).toBe(0);
  });

  it("connectNoticeSurface releases the alpha1 notice and publishes it", async () => {
    const r = rig();
    const calls: string[] = [];
    r.startup = { ...r.startup, markNoticeSurfaceReady: async () => { calls.push("ready"); r.notices = [buildAlpha1MigrationNotice()]; return r.notices; } };
    const service = createCollectorIntegrationService(r.deps);
    expect((await service.connectNoticeSurface()).map((notice) => notice.id)).toEqual([COLLECTOR_NOTICE_IDS.alpha1Migration]);
    expect(calls).toEqual(["ready"]);
    expect(r.published).toHaveLength(1);
  });

  it("does not hand a pre-apply inspection to a caller that arrives after the apply started", async () => {
    const r = rig();
    const first = deferred<CollectorIntegrationInspection>();
    const calls: Array<Promise<CollectorIntegrationInspection>> = [first.promise];
    let n = 0;
    const applying = deferred<CollectorApplyResult>();
    r.applyImpl = () => applying.promise;
    const service = createCollectorIntegrationService({ ...r.deps, inspect: () => calls[n++] ?? Promise.resolve(inspection("damaged")) });
    const early = service.handle({ intent: "inspect" }); // starts inspection #1 (slow)
    const run = service.handle({ intent: "setup", proceedWithoutSupportedBrowser: true }); // apply starts: new generation
    await new Promise((resolve) => setTimeout(resolve, 0));
    const during = await service.handle({ intent: "inspect" });
    expect(n).toBe(2); // not the shared pre-apply inspection
    expect(during).toMatchObject({ kind: "status", status: { applyInProgress: true } });
    first.resolve(inspection("ready"));
    await early;
    applying.resolve(applyResult("setup"));
    await run;
    const after = await service.handle({ intent: "inspect" });
    expect(after).toMatchObject({ kind: "status", status: { applyInProgress: false } });
    expect(await service.handle({ intent: "checkConnection" })).toMatchObject({ kind: "connection", applyInProgress: false });
  });

  it("real orchestrator and shared gate: a startup refresh waits behind a remove confirmation and ends refused without being recorded", async () => {
    const gate = createCollectorApplyGate();
    let stored: CollectorNoticeState = DEFAULT_COLLECTOR_NOTICE_STATE;
    const store = { read: async () => stored, write: async (state: CollectorNoticeState) => { stored = state; } };
    const order: string[] = [];
    const confirmation = deferred<{ confirmed: boolean; clearSaveDestination: boolean }>();
    const raw = async (request: CollectorApplyRequest): Promise<CollectorApplyResult> => {
      order.push(request.action);
      return request.action === "remove" ? applyResult("remove") : applyResult(request.action, "refused", "wrong-state");
    };
    const startup = createCollectorStartupRefresh({
      inspect: async () => inspection("outdated", { installed: { payloadId: "old", activeSlot: "a", hostVersion: "1.2.0", extensionVersion: "0.3.0" } }),
      apply: (request) => gate.queue(() => raw(request)),
      hasOptedIn: async () => true,
      noticeStore: store,
      now: () => new Date("2026-11-16T09:00:00.000Z"),
      e2eIsolationActive: false,
    });
    const base = rig().deps;
    const service = createCollectorIntegrationService({ ...base, startupRefresh: startup, gate, apply: raw, confirmRemove: () => confirmation.promise });
    const removing = service.handle({ intent: "remove" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const starting = service.runStartup();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]); // both are waiting: the dialog holds the gate
    confirmation.resolve({ confirmed: true, clearSaveDestination: false });
    expect((await removing).kind).toBe("apply");
    const result = await starting;
    expect(order).toEqual(["remove", "refresh"]);
    expect(result?.outcome).toBe("refresh-failed");
    expect(stored.removeRequested).toBe(true);
    expect(stored.updated).toBeNull();
    expect(service.currentNotices()).toEqual([]);
  });
});

describe("connection summary", () => {
  const record = { version: 1, protocol: "maginalia.collector.experimental.v1", hostVersion: "1.3.0", extensionVersion: "0.4.0", contactedAt: "2026-11-16T09:00:00.000Z" } as const;
  it("maps contact facts to the wizard states", () => {
    expect(summarizeConnection(inspection("ready", { contact: { status: "absent" } }))).toEqual({ state: "waiting" });
    expect(summarizeConnection(inspection("ready", { contact: { status: "unavailable", violation: "null-dacl" } }))).toEqual({ state: "unavailable" });
    expect(summarizeConnection(inspection("ready", { contact: { status: "invalid", reason: "wrong-protocol" } }))).toEqual({ state: "protocol-differs" });
    for (const reason of ["unreadable", "too-large", "not-json", "not-an-object", "unexpected-fields", "wrong-version", "invalid-host-version", "invalid-extension-version", "invalid-timestamp", "future-timestamp"] as const) {
      expect(summarizeConnection(inspection("ready", { contact: { status: "invalid", reason } }))).toEqual({ state: "waiting" });
    }
    expect(summarizeConnection(inspection("ready", { contact: { status: "invalid", reason: "reparse-point" } }))).toEqual({ state: "unavailable" });
    for (const vs of ["newer", "unparseable"] as const) {
      expect(summarizeConnection(inspection("ready", { contact: { status: "present", record, extensionVersionVsPlaced: vs, hostVersionVsPayload: "equal" } })))
        .toEqual({ state: "extension-version-differs", loadedVersion: "0.4.0", placedVersion: "0.4.0" });
    }
    expect(summarizeConnection(inspection("ready", { installed: { payloadId: null, activeSlot: null, hostVersion: null, extensionVersion: null }, contact: { status: "present", record, extensionVersionVsPlaced: "not-placed", hostVersionVsPayload: "no-payload" } })))
      .toEqual({ state: "extension-version-differs", loadedVersion: "0.4.0", placedVersion: null });
    expect(summarizeConnection(inspection("ready", { contact: { status: "present", record, extensionVersionVsPlaced: "equal", hostVersionVsPayload: "equal" } })))
      .toEqual({ state: "connected", extensionVersion: "0.4.0", hostVersion: "1.3.0", contactedAt: record.contactedAt });
    expect(summarizeConnection(inspection("ready", { contact: { status: "present", record, extensionVersionVsPlaced: "older", hostVersionVsPayload: "equal" } })))
      .toEqual({ state: "extension-version-differs", loadedVersion: "0.4.0", placedVersion: "0.4.0" });
  });
});
