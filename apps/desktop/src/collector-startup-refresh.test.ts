import { describe, expect, it } from "vitest";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types.js";
import type { CollectorIntegrationInspection, CollectorIntegrationState } from "./collector-integration-types.js";
import {
  COLLECTOR_DISMISS_NOTICE_COMMAND_ID,
  COLLECTOR_NOTICE_IDS,
  COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND_ID,
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
  return { action, outcome, reason, warnings: [], targets: [], filesChanged: false, state: post.state, selfCheck: "skipped", inspection: post };
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
    expect(updated.actions.map((action) => action.commandId)).toEqual([COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND_ID, COLLECTOR_DISMISS_NOTICE_COMMAND_ID]);
    expect(r.store.state.updated).toEqual({ extensionVersion: "0.4.0", createdAt: T0 });
  });

  describe("registration-only refresh (payloadId unchanged, multi-browser S6)", () => {
    const sameInstalled = { payloadId: "1.2.0+abc1234", activeSlot: "a", hostVersion: "1.2.0", extensionVersion: "0.3.0" } as const;
    function registrationOnly(): Rig {
      const r = rig("outdated");
      r.current = inspection("outdated", { installed: sameInstalled });
      r.applyOutcome = { ...applyResult("applied"), inspection: inspection("ready", { installed: sameInstalled }) };
      return r;
    }

    it("applies but raises no updated notice and persists nothing", async () => {
      const r = registrationOnly();
      const result = await createCollectorStartupRefresh(r.deps).runStartup();
      expect(r.applies).toEqual([{ action: "refresh" }]);
      expect(result.outcome).toBe("refreshed");
      expect(kinds(result.notices)).toEqual([]);
      expect(r.store.state.updated).toBeNull();
      expect(r.store.writes).toEqual([]);
    });

    it("stays quiet across repeated starts", async () => {
      const r = registrationOnly();
      for (let launch = 0; launch < 3; launch += 1) {
        r.current = inspection("outdated", { installed: sameInstalled });
        const result = await createCollectorStartupRefresh(r.deps).runStartup();
        expect(kinds(result.notices)).toEqual([]);
      }
      expect(r.applies).toHaveLength(3);
      expect(r.store.state.updated).toBeNull();
    });

    it("keeps an already pending updated notice as it was, without renewing it", async () => {
      const r = registrationOnly();
      const pending = { extensionVersion: "0.3.0", createdAt: "2026-11-15T09:00:00.000Z" };
      r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, updated: pending };
      const result = await createCollectorStartupRefresh(r.deps).runStartup();
      expect(kinds(result.notices)).toEqual(["updated"]);
      expect(r.store.state.updated).toEqual(pending);
    });
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
  it("never refreshes or repairs when the user has not opted in; only the alpha1 notice state is written for not-set-up", async () => {
    for (const state of ["outdated", "damaged", "registration-missing", "ready", "not-set-up", "policy-blocked"] as const) {
      const r = rig(state);
      r.optedIn = false;
      const startup = createCollectorStartupRefresh(r.deps);
      const result = await startup.runStartup();
      expect(result.outcome).toBe("not-opted-in");
      expect(result.notices).toEqual([]);
      expect(r.store.writes).toHaveLength(0); // nothing is written before a surface exists
      expect(kinds(await startup.markNoticeSurfaceReady())).toEqual(state === "not-set-up" ? ["alpha1-migration"] : []);
      expect(r.applies).toEqual([]);
      expect(r.store.writes).toHaveLength(state === "not-set-up" ? 1 : 0);
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
  it("is shown once on a fresh userData for a user without the integration", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    const startup = createCollectorStartupRefresh(r.deps);
    expect((await startup.runStartup()).notices).toEqual([]);
    const shown = await startup.markNoticeSurfaceReady();
    expect(kinds(shown)).toEqual(["alpha1-migration"]);
    const notice = shown[0] as CollectorNotice;
    expect(notice.actions.map((action) => action.commandId)).toEqual([COLLECTOR_SETUP_COMMAND_ID, COLLECTOR_DISMISS_NOTICE_COMMAND_ID]);
    expect(notice.actions[0]?.closesNoticeId).toBe(COLLECTOR_NOTICE_IDS.alpha1Migration);
    expect(r.store.state.alpha1).toBe("shown");
    expect(r.applies).toEqual([]);
    const second = createCollectorStartupRefresh(r.deps);
    await second.runStartup();
    expect(await second.markNoticeSurfaceReady()).toEqual([]);
  });

  it("is not persisted as shown before a notice surface exists, and is spent exactly once after it appears", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    expect(r.store.state.alpha1).toBe("unseen");
    expect(r.store.writes).toEqual([]);
    expect(kinds(await startup.markNoticeSurfaceReady())).toEqual(["alpha1-migration"]);
    expect(r.store.state.alpha1).toBe("shown");
    expect(r.store.writes).toHaveLength(1);
    await startup.markNoticeSurfaceReady();
    expect(r.store.writes).toHaveLength(1);
  });

  it("a user who never opens a surface keeps the notice for the next launch", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    await createCollectorStartupRefresh(r.deps).runStartup();
    const next = createCollectorStartupRefresh(r.deps);
    await next.runStartup();
    expect(kinds(await next.markNoticeSurfaceReady())).toEqual(["alpha1-migration"]);
  });

  it("a surface that appears before the startup run finishes still gets the notice once", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    const startup = createCollectorStartupRefresh(r.deps);
    const run = startup.runStartup();
    const ready = startup.markNoticeSurfaceReady();
    await run;
    expect(kinds(await ready)).toEqual(["alpha1-migration"]);
    expect(r.store.writes).toHaveLength(1);
  });

  it("repair and update notices do not wait for the surface", async () => {
    const r = rig("damaged");
    expect(kinds((await createCollectorStartupRefresh(r.deps).runStartup()).notices)).toEqual(["repair"]);
    const outdated = rig("outdated");
    expect(kinds((await createCollectorStartupRefresh(outdated.deps).runStartup()).notices)).toEqual(["updated"]);
  });

  it("a setup applied while the notice is pending spends it without ever showing it", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    await startup.recordApplyResult(applyResult("applied", null, "setup"));
    expect(await startup.markNoticeSurfaceReady()).toEqual([]);
    expect(r.store.state.alpha1).toBe("dismissed");
  });

  it("is not shown for an opted-in user, for ready, or for foreign / damaged / outdated states", async () => {
    for (const state of ["ready", "foreign-registration", "damaged", "registration-missing", "outdated", "policy-blocked"] as const) {
      const r = rig(state);
      r.optedIn = state === "ready";
      const result = await createCollectorStartupRefresh(r.deps).runStartup();
      expect(kinds(result.notices).includes("alpha1-migration")).toBe(false);
      expect(r.store.state.alpha1).toBe("unseen");
    }
    const notOptedForeign = rig("foreign-registration");
    notOptedForeign.optedIn = false;
    const result = await createCollectorStartupRefresh(notOptedForeign.deps).runStartup();
    expect(result.notices).toEqual([]);
    expect(notOptedForeign.store.writes).toEqual([]);
  });

  it("is not shown when it cannot be remembered (so it can never repeat)", async () => {
    const unwritable = rig("not-set-up");
    unwritable.optedIn = false;
    unwritable.store.failWrites = true;
    expect((await createCollectorStartupRefresh(unwritable.deps).runStartup()).notices).toEqual([]);
  });

  it("stays dismissed", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    expect(await startup.dismiss(COLLECTOR_NOTICE_IDS.alpha1Migration)).toEqual([]);
    expect(r.store.state.alpha1).toBe("dismissed");
    expect((await createCollectorStartupRefresh(r.deps).runStartup()).notices).toEqual([]);
  });

  it("writes and shows nothing under E2E isolation", async () => {
    const r = rig("not-set-up");
    r.optedIn = false;
    r.isolated = true;
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(result.notices).toEqual([]);
    expect(r.store.writes).toEqual([]);
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
      // Only an outdated installation (whose refresh is paused) says so; the other states stay quiet (Q9).
      expect(kinds(result.notices)).toEqual(state === "outdated" ? ["remove-failed"] : []);
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
    await startup.recordApplyResult(applyResult("refused", "wrong-state", "remove"));
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

describe("remove apply threw (decision 4)", () => {
  it("keeps removeRequested set, raises the failure notice and says the automatic update is paused", async () => {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.beginRemove();
    await startup.recordRemoveFailure(); // the apply threw: no recordApplyResult
    expect(r.store.state.removeRequested).toBe(true);
    const notices = startup.currentNotices();
    expect(kinds(notices)).toEqual(["remove-failed"]);
    expect(notices[0]?.title).toBe("Collector 連携の解除に失敗しました");
    expect(notices[0]?.detail).toContain("自動更新は止まったまま");
    expect(notices[0]?.actions.map((action) => action.commandId)).toEqual([
      "maginalia.collector.removeIntegration",
      "maginalia.collector.dismissNotice",
    ]);
  });

  it("re-asserts removeRequested when beginRemove could not persist it", async () => {
    const r = rig("outdated");
    await createCollectorStartupRefresh(r.deps).recordRemoveFailure();
    expect(r.store.state.removeRequested).toBe(true);
  });

  it("at startup an outdated installation with removeRequested pauses the refresh AND shows the notice; other states stay quiet", async () => {
    const r = rig("outdated");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, removeRequested: true };
    const result = await createCollectorStartupRefresh(r.deps).runStartup();
    expect(result.outcome).toBe("remove-requested");
    expect(r.applies).toEqual([]);
    expect(kinds(result.notices)).toEqual(["remove-failed"]);
    for (const state of ["damaged", "registration-missing"] as const) {
      r.current = inspection(state);
      expect((await createCollectorStartupRefresh(r.deps).runStartup()).notices).toEqual([]);
    }
  });

  it("is dismissed for the session, and cleared by a later remove result, setup or repair", async () => {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.recordRemoveFailure();
    expect(kinds(await startup.dismiss("collector.notice.remove-failed"))).toEqual([]);
    await startup.recordRemoveFailure();
    expect(kinds(startup.currentNotices())).toEqual(["remove-failed"]);
    await startup.recordApplyResult(applyResult("applied", null, "remove"));
    expect(startup.currentNotices()).toEqual([]);
    await startup.recordRemoveFailure();
    await startup.recordApplyResult(applyResult("applied", null, "repair"));
    expect(startup.currentNotices()).toEqual([]);
    expect(r.store.state.removeRequested).toBe(false);
  });

  it("a refused retry keeps the notice and removeRequested", async () => {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.recordRemoveFailure();
    await startup.recordApplyResult(applyResult("refused", "busy", "remove"));
    expect(kinds(startup.currentNotices())).toEqual(["remove-failed"]);
    expect(r.store.state.removeRequested).toBe(true);
  });

  it("does nothing under E2E isolation", async () => {
    const r = rig("outdated");
    r.isolated = true;
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.recordRemoveFailure();
    expect(startup.currentNotices()).toEqual([]);
    expect(r.store.state.removeRequested).toBe(false);
  });
});

describe("remove requested before the apply (Q9)", () => {
  const removeResult = (outcome: CollectorApplyResult["outcome"], reason: CollectorApplyResult["reason"] = null): CollectorApplyResult => applyResult(outcome, reason, "remove");

  it("persists removeRequested before any apply result exists, so a crash midway raises no repair notice", async () => {
    const r = rig("ready");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.beginRemove();
    expect(r.store.state.removeRequested).toBe(true);
    // the process dies here: the next start sees a half-removed installation
    for (const state of ["registration-missing", "damaged"] as const) {
      r.current = inspection(state);
      const result = await createCollectorStartupRefresh(r.deps).runStartup();
      expect(result.outcome).toBe("remove-requested");
      expect(result.notices).toEqual([]);
    }
    expect(r.applies).toEqual([]);
  });

  it("keeps a showing repair notice while the remove runs and when it is refused", async () => {
    const r = rig("damaged");
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    expect(kinds(startup.currentNotices())).toEqual(["repair"]);
    await startup.beginRemove();
    expect(kinds(startup.currentNotices())).toEqual(["repair"]);
    await startup.recordApplyResult(removeResult("refused", "wrong-state"));
    expect(kinds(startup.currentNotices())).toEqual(["repair"]);
    expect(r.store.state.removeRequested).toBe(false);
  });

  it("a remove that ran clears the repair notice", async () => {
    for (const outcome of ["applied", "partial"] as const) {
      const r = rig("damaged");
      const startup = createCollectorStartupRefresh(r.deps);
      await startup.runStartup();
      await startup.beginRemove();
      await startup.recordApplyResult(removeResult(outcome));
      expect(startup.currentNotices()).toEqual([]);
    }
  });

  it("puts the previous value back when the remove was refused (nothing changed)", async () => {
    for (const reason of ["busy", "wrong-state"] as const) {
      const r = rig("ready");
      const startup = createCollectorStartupRefresh(r.deps);
      await startup.beginRemove();
      expect(r.store.state.removeRequested).toBe(true);
      await startup.recordApplyResult(removeResult("refused", reason));
      expect(r.store.state.removeRequested).toBe(false);
    }
  });

  it("a refused remove keeps removeRequested when it was already set before", async () => {
    const r = rig("ready");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, removeRequested: true };
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.beginRemove();
    await startup.recordApplyResult(removeResult("refused", "wrong-state"));
    expect(r.store.state.removeRequested).toBe(true);
  });

  it("keeps it for applied, partial and failed removes, and the rollback does not apply to a later refused remove", async () => {
    for (const outcome of ["applied", "partial", "failed"] as const) {
      const r = rig("ready");
      const startup = createCollectorStartupRefresh(r.deps);
      await startup.beginRemove();
      await startup.recordApplyResult(removeResult(outcome, outcome === "failed" ? "write-failed" : null));
      expect(r.store.state.removeRequested).toBe(true);
      // a refused remove that never called beginRemove changes nothing
      await startup.recordApplyResult(removeResult("refused", "busy"));
      expect(r.store.state.removeRequested).toBe(true);
    }
  });

  it("a refused remove without beginRemove leaves no removeRequested (existing behavior)", async () => {
    const r = rig("ready");
    await createCollectorStartupRefresh(r.deps).recordApplyResult(removeResult("refused", "wrong-state"));
    expect(r.store.state.removeRequested).toBe(false);
    expect(r.store.writes).toEqual([]);
  });

  it("does not touch the pending updated notice or the remembered browser", async () => {
    const r = rig("ready");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, alpha1: "shown", updated: { extensionVersion: "0.4.0", createdAt: T0 }, browser: "edge" };
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.beginRemove();
    expect(r.store.state).toEqual({ ...DEFAULT_COLLECTOR_NOTICE_STATE, alpha1: "shown", updated: { extensionVersion: "0.4.0", createdAt: T0 }, browser: "edge", removeRequested: true });
    await startup.recordApplyResult(removeResult("refused", "busy"));
    expect(r.store.state).toEqual({ ...DEFAULT_COLLECTOR_NOTICE_STATE, alpha1: "shown", updated: { extensionVersion: "0.4.0", createdAt: T0 }, browser: "edge" });
  });

  it("never throws when the state cannot be written, and writes nothing under E2E isolation", async () => {
    const failing = rig("ready");
    failing.store.failWrites = true;
    await expect(createCollectorStartupRefresh(failing.deps).beginRemove()).resolves.toBeUndefined();
    const isolated = rig("ready");
    isolated.isolated = true;
    await createCollectorStartupRefresh(isolated.deps).beginRemove();
    expect(isolated.store.writes).toEqual([]);
  });
});

describe("remembered browser (multi-browser design 7.4)", () => {
  it("is null by default and round-trips through the notice state", async () => {
    const r = rig("ready");
    const startup = createCollectorStartupRefresh(r.deps);
    expect(await startup.preferredBrowser()).toBeNull();
    await startup.setPreferredBrowser("edge");
    expect(await startup.preferredBrowser()).toBe("edge");
    expect(r.store.state.browser).toBe("edge");
    expect(await createCollectorStartupRefresh(r.deps).preferredBrowser()).toBe("edge");
  });

  it("writes only when the value changes and keeps every other field", async () => {
    const r = rig("ready");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, removeRequested: true, alpha1: "dismissed", updated: { extensionVersion: "0.4.0", createdAt: T0 } };
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.setPreferredBrowser("chrome");
    await startup.setPreferredBrowser("chrome");
    expect(r.store.writes).toHaveLength(1);
    expect(r.store.state).toEqual({ ...DEFAULT_COLLECTOR_NOTICE_STATE, removeRequested: true, alpha1: "dismissed", updated: { extensionVersion: "0.4.0", createdAt: T0 }, browser: "chrome" });
  });

  it("survives every other state change (dismiss, apply record, startup)", async () => {
    const r = rig("damaged");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, browser: "vivaldi" };
    const startup = createCollectorStartupRefresh(r.deps);
    await startup.runStartup();
    await startup.dismiss(COLLECTOR_NOTICE_IDS.alpha1Migration);
    await startup.recordApplyResult(applyResult("applied", null, "setup"));
    await startup.recordApplyResult(applyResult("applied", null, "remove"));
    expect(r.store.state.browser).toBe("vivaldi");
  });

  it("goes through the serialized state chain: concurrent writes never lose each other", async () => {
    const r = rig("ready");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, alpha1: "shown", updated: { extensionVersion: "0.4.0", createdAt: T0 } };
    const slowRead = r.store.read.bind(r.store);
    r.store.read = async () => { const value = await slowRead(); await new Promise((resolve) => setTimeout(resolve, 5)); return value; };
    const startup = createCollectorStartupRefresh(r.deps);
    await Promise.all([
      startup.setPreferredBrowser("edge"),
      startup.dismiss(COLLECTOR_NOTICE_IDS.updated),
      startup.recordApplyResult(applyResult("applied", null, "remove")),
      startup.setPreferredBrowser("chrome"),
    ]);
    expect(r.store.state).toEqual({ ...DEFAULT_COLLECTOR_NOTICE_STATE, alpha1: "shown", removeRequested: true, updated: null, browser: "chrome" });
  });

  it("never throws when the write fails (the preference is only forgotten) and does nothing under E2E isolation", async () => {
    const failing = rig("ready");
    failing.store.failWrites = true;
    await expect(createCollectorStartupRefresh(failing.deps).setPreferredBrowser("edge")).resolves.toBeUndefined();
    const isolated = rig("ready");
    isolated.isolated = true;
    await createCollectorStartupRefresh(isolated.deps).setPreferredBrowser("edge");
    expect(isolated.store.writes).toEqual([]);
  });

  it("a read failure reads as no preference", async () => {
    const r = rig("ready");
    r.store.read = async () => { throw new Error("denied"); };
    expect(await createCollectorStartupRefresh(r.deps).preferredBrowser()).toBeNull();
  });
});

describe("notice state serialization", () => {
  it("concurrent record / dismiss / reconcile never overwrite each other with a stale copy", async () => {
    const r = rig("ready");
    r.store.state = { ...DEFAULT_COLLECTOR_NOTICE_STATE, alpha1: "shown", updated: { extensionVersion: "0.4.0", createdAt: T0 } };
    const slowRead = r.store.read.bind(r.store);
    r.store.read = async () => { const value = await slowRead(); await new Promise((resolve) => setTimeout(resolve, 5)); return value; };
    const startup = createCollectorStartupRefresh(r.deps);
    await Promise.all([
      startup.recordApplyResult(applyResult("applied", null, "remove")),
      startup.dismiss(COLLECTOR_NOTICE_IDS.alpha1Migration),
      startup.dismiss(COLLECTOR_NOTICE_IDS.updated),
    ]);
    expect(r.store.state).toEqual({ ...DEFAULT_COLLECTOR_NOTICE_STATE, removeRequested: true, alpha1: "dismissed", updated: null });
  });

  it("the startup refresh decides on the state after its apply, not on the one read before it", async () => {
    const r = rig("outdated");
    const startup = createCollectorStartupRefresh({
      ...r.deps,
      apply: async (request) => {
        // a user removal completes while the refresh is waiting
        await startup.recordApplyResult(applyResult("applied", null, "remove"));
        return r.deps.apply(request);
      },
    });
    await startup.runStartup();
    expect(r.store.state.removeRequested).toBe(true);
    expect(r.store.state.updated).not.toBeNull(); // the refresh result itself is still recorded, nothing was lost
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
