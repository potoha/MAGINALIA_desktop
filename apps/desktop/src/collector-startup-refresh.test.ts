import { describe, expect, it } from "vitest";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types.js";
import type { CollectorIntegrationInspection, CollectorIntegrationState } from "./collector-integration-types.js";
import {
  COLLECTOR_DISMISS_NOTICE_COMMAND_ID,
  COLLECTOR_NOTICE_IDS,
  COLLECTOR_OPEN_CHROME_EXTENSIONS_COMMAND_ID,
  COLLECTOR_REPAIR_COMMAND_ID,
  COLLECTOR_SETUP_COMMAND_ID,
  DEFAULT_COLLECTOR_NOTICE_STATE,
  type CollectorNotice,
  type CollectorNoticeState,
  type CollectorNoticeStore,
} from "./collector-integration-notices.js";
import { createCollectorStartupRefresh, type CollectorStartupRefreshDependencies } from "./collector-startup-refresh.js";

const T0 = "2026-11-16T09:00:00.000Z";

function inspection(state: CollectorIntegrationState, overrides: Partial<CollectorIntegrationInspection> = {}): CollectorIntegrationInspection {
  return {
    state,
    reasons: [],
    inspectionComplete: true,
    registration: state === "foreign-registration" ? "foreign" : state === "not-set-up" ? "absent" : "ours",
    folderSecurityViolation: null,
    payload: { status: "valid", payloadId: "1.3.0+def5678" },
    installed: { payloadId: "1.2.0+abc1234", activeSlot: "a", hostVersion: "1.2.0", extensionVersion: "0.3.0" },
    versions: { host: "older", extension: "older" },
    filesVerified: false,
    policy: { userLevelHostsDisabled: false, hostBlocked: false, blocked: false, extensionLoadMayBeBlocked: false, status: "read" },
    chrome: { status: "found", source: "app-paths-hkcu", rejected: [], defaultBrowser: "chrome" },
    contact: { status: "absent" },
    extensionFolderDisplay: null,
    writesAllowed: true,
    ...overrides,
  } as CollectorIntegrationInspection;
}

function applyResult(outcome: CollectorApplyResult["outcome"], reason: CollectorApplyResult["reason"] = null, action: CollectorApplyResult["action"] = "refresh"): CollectorApplyResult {
  const post = inspection(outcome === "applied" ? "ready" : "outdated", {
    installed: { payloadId: "1.3.0+def5678", activeSlot: "b", hostVersion: "1.3.0", extensionVersion: "0.4.0" },
  });
  return { action, outcome, reason, warnings: [], state: post.state, selfCheck: "skipped", inspection: post };
}

class MemoryStore implements CollectorNoticeStore {
  public state: CollectorNoticeState = DEFAULT_COLLECTOR_NOTICE_STATE;
  public writes: CollectorNoticeState[] = [];
  public failWrites = false;
  public async read(): Promise<CollectorNoticeState> { return this.state; }
  public async write(state: CollectorNoticeState): Promise<void> {
    if (this.failWrites) throw new Error("disk full");
    this.writes.push(state);
    this.state = state;
  }
}

interface Rig {
  readonly store: MemoryStore;
  readonly applies: CollectorApplyRequest[];
  readonly inspects: number[];
  current: CollectorIntegrationInspection;
  optedIn: boolean;
  alpha1: boolean;
  applyOutcome: CollectorApplyResult | "throw";
  isolated: boolean;
  clock: Date;
  readonly deps: CollectorStartupRefreshDependencies;
}

function rig(state: CollectorIntegrationState = "ready"): Rig {
  const store = new MemoryStore();
  const r: Rig = {
    store,
    applies: [],
    inspects: [],
    current: inspection(state),
    optedIn: true,
    alpha1: false,
    applyOutcome: applyResult("applied"),
    isolated: false,
    clock: new Date(T0),
    get deps(): CollectorStartupRefreshDependencies {
      return {
        inspect: async (options) => {
          expect(options.verifyFileHashes).toBe(false);
          r.inspects.push(1);
          return r.current;
        },
        apply: async (request) => {
          r.applies.push(request);
          if (r.applyOutcome === "throw") throw new Error("boom");
          return r.applyOutcome;
        },
        hasOptedIn: async () => r.optedIn,
        hasAlpha1Footprint: async () => r.alpha1,
        noticeStore: store,
        now: () => r.clock,
        e2eIsolationActive: r.isolated,
      };
    },
  };
  return r;
}

const kinds = (notices: readonly CollectorNotice[]): string[] => notices.map((notice) => notice.kind);

describe("automatic refresh (design 6.2)", () => {
  it("refreshes an opted-in installation that is outdated, with the cheap inspection", async () => {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh(r.deps);
    const result = await startup.runStartup();
    expect(r.applies).toEqual([{ action: "refresh" }]);
    expect(result.outcome).toBe("refreshed");
    expect(kinds(result.notices)).toEqual(["updated"]);
    const updated = result.notices[0] as Extract<CollectorNotice, { kind: "updated" }>;
    expect(updated.extensionVersion).toBe("0.4.0");
    expect(updated.title).toBe("MAGINALIA Collector を新しい版（0.4.0）に更新しました。");
    expect(updated.actions.map((action) => action.commandId)).toEqual([COLLECTOR_OPEN_CHROME_EXTENSIONS_COMMAND_ID, COLLECTOR_DISMISS_NOTICE_COMMAND_ID]);
    expect(r.store.state.updated).toEqual({ extensionVersion: "0.4.0", createdAt: T0 });
  });

  it.each(["foreign-registration", "registration-missing", "damaged"] as const)("never refreshes or repairs %s by itself; it raises a repair notice", async (state) => {
    const r = rig(state);
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(r.applies).toEqual([]);
    expect(kinds(result.notices)).toEqual(["repair"]);
    const repair = result.notices[0] as Extract<CollectorNotice, { kind: "repair" }>;
    expect(repair.state).toBe(state);
    expect(repair.actions[0]?.commandId).toBe(COLLECTOR_REPAIR_COMMAND_ID);
    expect(r.store.writes).toEqual([]);
  });

  it.each(["ready", "policy-blocked", "not-set-up"] as const)("does nothing for %s when opted in", async (state) => {
    const r = rig(state);
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(r.applies).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(r.store.writes).toEqual([]);
  });

  it.each(["failed", "refused", "partial", "noop"] as const)("announces nothing for a refresh that ends %s, and retries at the next start", async (outcome) => {
    const r = rig("outdated");
    r.applyOutcome = applyResult(outcome, outcome === "failed" ? "file-locked" : null);
    const first = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(kinds(first.notices)).toEqual([]);
    expect(r.store.writes).toEqual([]);
    // next launch: a new orchestrator over the same persisted state tries again
    r.applyOutcome = applyResult("applied");
    const second = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(r.applies).toHaveLength(2);
    expect(kinds(second.notices)).toEqual(["updated"]);
  });

  it("ignores a busy refresh (transient snapshot) and does not announce or raise a repair notice", async () => {
    const r = rig("outdated");
    const busy = applyResult("refused", "busy");
    r.applyOutcome = { ...busy, state: "damaged", inspection: inspection("damaged") };
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(result.outcome).toBe("refresh-retry-later");
    expect(result.notices).toEqual([]);
    expect(r.store.writes).toEqual([]);
  });

  it("treats a throwing apply as a failed refresh without a notice", async () => {
    const r = rig("outdated");
    r.applyOutcome = "throw";
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(result.outcome).toBe("refresh-failed");
    expect(result.notices).toEqual([]);
  });

  it("acts on nothing when the inspection is incomplete (it fails closed to damaged)", async () => {
    const r = rig("damaged");
    r.current = inspection("damaged", { inspectionComplete: false });
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(result.outcome).toBe("inspection-incomplete");
    expect(result.notices).toEqual([]);
    expect(r.applies).toEqual([]);
  });

  it("shares a single run between overlapping startups", async () => {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh(r.deps);
    await Promise.all([startup.runStartup(), startup.runStartup()]);
    expect(r.applies).toHaveLength(1);
  });
});

describe("opt-in and isolation", () => {
  it("does nothing, writes nothing and shows nothing when the user has not opted in", async () => {
    for (const state of ["outdated", "damaged", "registration-missing", "ready", "not-set-up", "policy-blocked"] as const) {
      const r = rig(state);
      r.optedIn = false;
      const result = await createCollectorStartupRefresh(r.deps).runStartup();
      expect(result.outcome).toBe("not-opted-in");
      expect(result.notices).toEqual([]);
      expect(r.applies).toEqual([]);
      expect(r.store.writes).toEqual([]);
    }
  });

  it("does not even inspect under E2E isolation", async () => {
    const r = rig("outdated");
    r.isolated = true;
    const startup = createCollectorStartupRefresh(r.deps);
    expect((await startup.runStartup()).outcome).toBe("skipped-e2e-isolation");
    expect(r.inspects).toEqual([]);
    expect(r.applies).toEqual([]);
    expect(r.store.writes).toEqual([]);
    expect(await startup.reconcile()).toEqual([]);
  });

  it("survives a failing inspection", async () => {
    const r = rig("outdated");
    const deps = { ...r.deps, inspect: async () => { throw new Error("boom"); } };
    expect((await createCollectorStartupRefresh(deps).runStartup()).outcome).toBe("inspection-failed");
  });
});

describe("updated notice clears itself (design 6.5)", () => {
  async function refreshed(): Promise<{ r: Rig; startup: ReturnType<typeof createCollectorStartupRefresh> }> {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    r.current = inspection("ready");
    r.clock = new Date("2026-11-16T09:30:00.000Z");
    return { r, startup };
  }
  const contact = (extensionVersion: string, contactedAt: string): CollectorIntegrationInspection["contact"] => ({
    status: "present",
    record: { version: 1, protocol: "maginalia.collector.experimental.v1", hostVersion: "1.3.0", extensionVersion, contactedAt },
    extensionVersionVsPlaced: "equal",
    hostVersionVsPayload: "equal",
  });

  it("keeps the notice for an old extension contact and for a contact before the refresh", async () => {
    const { r, startup } = await refreshed();
    r.current = inspection("ready", { contact: contact("0.3.0", "2026-11-16T09:10:00.000Z") });
    expect(kinds(await startup.reconcile())).toEqual(["updated"]);
    r.current = inspection("ready", { contact: contact("0.4.0", "2026-11-16T08:59:00.000Z") });
    expect(kinds(await startup.reconcile())).toEqual(["updated"]);
    r.current = inspection("ready", { contact: { status: "absent" } });
    expect(kinds(await startup.reconcile())).toEqual(["updated"]);
    expect(r.store.state.updated).not.toBeNull();
  });

  it("clears after a matching contact and persists the clearing", async () => {
    const { r, startup } = await refreshed();
    r.current = inspection("ready", { contact: contact("0.4.0", "2026-11-16T09:10:00.000Z") });
    expect(await startup.reconcile()).toEqual([]);
    expect(r.store.state.updated).toBeNull();
    // a newer extension also counts
    const second = await refreshed();
    second.r.current = inspection("ready", { contact: contact("0.5.0", "2026-11-16T09:10:00.000Z") });
    expect(await second.startup.reconcile()).toEqual([]);
  });

  it("is restored at the next start while no matching contact exists, and cleared once there is one", async () => {
    const { r } = await refreshed();
    const relaunch = createCollectorStartupRefresh(r.deps);
    expect(kinds((await relaunch.runStartup()).notices)).toEqual(["updated"]);
    r.current = inspection("ready", { contact: contact("0.4.0", "2026-11-16T10:00:00.000Z") });
    const third = createCollectorStartupRefresh(r.deps);
    expect((await third.runStartup()).notices).toEqual([]);
    expect(r.store.state.updated).toBeNull();
  });

  it("can be dismissed", async () => {
    const { r, startup } = await refreshed();
    expect(await startup.dismiss(COLLECTOR_NOTICE_IDS.updated)).toEqual([]);
    expect(r.store.state.updated).toBeNull();
  });
});

describe("alpha1 to alpha2 notice (design 5)", () => {
  it("is shown once for a user without the integration who has an alpha1 footprint", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    r.alpha1 = true;
    const first = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(kinds(first.notices)).toEqual(["alpha1-migration"]);
    const notice = first.notices[0] as CollectorNotice;
    expect(notice.actions.map((action) => action.commandId)).toEqual([COLLECTOR_SETUP_COMMAND_ID, COLLECTOR_DISMISS_NOTICE_COMMAND_ID]);
    expect(r.store.state.alpha1).toBe("shown");
    const second = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(second.notices).toEqual([]);
  });

  it("is also offered for an alpha1 standalone registration (foreign) of a user who has not opted in, but never repaired", async () => {
    const r = rig("foreign-registration");
    r.optedIn = false;
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(kinds(result.notices)).toEqual(["alpha1-migration"]);
    expect(r.applies).toEqual([]);
  });

  it("is not shown without an alpha1 footprint, or when it cannot be remembered", async () => {
    const none = rig("not-set-up");
    none.optedIn = false;
    expect((await createCollectorStartupRefresh(none.deps).runStartup()).notices).toEqual([]);
    expect(none.store.writes).toEqual([]);
    const unwritable = rig("not-set-up");
    unwritable.optedIn = false;
    unwritable.alpha1 = true;
    unwritable.store.failWrites = true;
    expect((await createCollectorStartupRefresh(unwritable.deps).runStartup()).notices).toEqual([]);
  });

  it("stays dismissed", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    r.alpha1 = true;
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    expect(await startup.dismiss(COLLECTOR_NOTICE_IDS.alpha1Migration)).toEqual([]);
    expect(r.store.state.alpha1).toBe("dismissed");
    expect((await createCollectorStartupRefresh(r.deps).runStartup()).notices).toEqual([]);
  });
});

describe("remove requested", () => {
  const removed = (outcome: CollectorApplyResult["outcome"] = "partial"): CollectorApplyResult => applyResult(outcome, null, "remove");

  it("keeps repair notices and refresh quiet after a remove, across restarts", async () => {
    const r = rig("damaged");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.recordApplyResult(removed());
    expect(r.store.state.removeRequested).toBe(true);
    for (const state of ["damaged", "registration-missing", "outdated"] as const) {
      r.current = inspection(state);
      const result = await createCollectorStartupRefresh(r.deps).runStartup();
      expect(result.outcome).toBe("remove-requested");
      expect(result.notices).toEqual([]);
    }
    expect(r.applies).toEqual([]);
  });

  it("is lifted by an applied setup or repair, and notices work again", async () => {
    const r = rig("damaged");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.recordApplyResult(removed());
    await startup.recordApplyResult(applyResult("applied", null, "setup"));
    expect(r.store.state.removeRequested).toBe(false);
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(kinds(result.notices)).toEqual(["repair"]);
  });

  it("is not lifted by a failed setup, nor set by a busy remove", async () => {
    const r = rig("damaged");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.recordApplyResult(applyResult("refused", "busy", "remove"));
    expect(r.store.state.removeRequested).toBe(false);
    await startup.recordApplyResult(removed());
    await startup.recordApplyResult(applyResult("failed", "write-failed", "setup"));
    expect(r.store.state.removeRequested).toBe(true);
  });

  it("is lifted when the installation is ready again", async () => {
    const r = rig("ready");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, removeRequested: true };
    await createCollectorStartupRefresh(r.deps).runStartup();
    expect(r.store.state.removeRequested).toBe(false);
  });
});

describe("repair notice dismissal", () => {
  it("is closed for the session only, and comes back at the next start", async () => {
    const r = rig("damaged");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    expect(await startup.dismiss(COLLECTOR_NOTICE_IDS.repair)).toEqual([]);
    expect(kinds((await createCollectorStartupRefresh(r.deps).runStartup()).notices)).toEqual(["repair"]);
  });
});
