/**
 * Startup refresh and notice orchestration for the Collector integration (design 5, 6; WP-5c).
 *
 * Every side effect is injected (inspection, apply, the opt-in and alpha1 probes, the notice
 * store, the clock), so the rules below are unit-tested with fakes and nothing here touches the
 * registry, the file system or Electron.
 *
 * Rules:
 *  - The startup inspection is cheap: `verifyFileHashes: false` (a string compare of `payloadId`,
 *    design 6.2). Hashes are computed only inside `apply`, when it writes.
 *  - "Opted in" means a valid `integration-state.json` exists (`hasOptedIn`). Without it nothing is
 *    refreshed, repaired, written or shown, except the one-time alpha1 notice below.
 *  - `refresh` runs only for state `outdated` of an opted-in installation. `foreign-registration`,
 *    `registration-missing` and `damaged` never refresh or repair by themselves: they raise a repair
 *    notice that dispatches `maginalia.collector.repair`. `policy-blocked`, `not-set-up` and `ready`
 *    raise no repair notice.
 *  - "Updated" is announced only for `applied`. `failed` / `refused` / `noop` / `partial` announce
 *    nothing; the next start inspects again, so a locked file is retried. `busy` (another apply is
 *    running) is a transient snapshot and is ignored.
 *  - An incomplete inspection (a read failed) acts on nothing: the result fails closed to `damaged`,
 *    which would be a false alarm.
 *  - After the user asked for `remove` (`removeRequested`, persisted) no refresh and no repair
 *    notice happen until a setup or repair is applied (`recordApplyResult`).
 *  - alpha1 notice (design 5): once, for a user who has not opted in and shows an alpha1 footprint.
 *  - Under E2E isolation the orchestrator does nothing at all.
 */
import { compareCollectorVersions } from "./collector-version.js";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types.js";
import type { CollectorInspectOptions, CollectorIntegrationInspection } from "./collector-integration-types.js";
import {
  buildAlpha1MigrationNotice,
  buildRepairNotice,
  buildUpdatedNotice,
  COLLECTOR_NOTICE_IDS,
  type CollectorNotice,
  type CollectorNoticeState,
  type CollectorNoticeStore,
  type CollectorRepairNoticeState,
} from "./collector-integration-notices.js";

export interface CollectorStartupRefreshDependencies {
  readonly inspect: (options: CollectorInspectOptions) => Promise<CollectorIntegrationInspection>;
  readonly apply: (request: CollectorApplyRequest) => Promise<CollectorApplyResult>;
  /** `true` when a valid `integration-state.json` exists (the user set the integration up). Read-only. */
  readonly hasOptedIn: () => Promise<boolean>;
  /** `true` when an alpha1 Collector footprint exists on this machine. Read-only. Not called for opted-in users. */
  readonly hasAlpha1Footprint: () => Promise<boolean>;
  readonly noticeStore: CollectorNoticeStore;
  readonly now: () => Date;
  /** Decided by the composition root (this module reads no environment). */
  readonly e2eIsolationActive: boolean;
}

export type CollectorStartupRefreshOutcome =
  | "skipped-e2e-isolation"
  | "inspection-failed"
  | "inspection-incomplete"
  | "not-opted-in"
  | "remove-requested"
  | "no-action"
  | "refreshed"
  | "refresh-failed"
  | "refresh-retry-later";

export interface CollectorStartupResult {
  readonly outcome: CollectorStartupRefreshOutcome;
  /** Notices that are active after this run. */
  readonly notices: readonly CollectorNotice[];
}

export interface CollectorStartupRefresh {
  /** Run once per launch. Never throws. */
  runStartup(): Promise<CollectorStartupResult>;
  /** Clears the "updated" notice once a contact record reports the new extension version. Never throws. */
  reconcile(): Promise<readonly CollectorNotice[]>;
  /** Closes one notice (`maginalia.collector.dismissNotice`). Never throws. */
  dismiss(noticeId: string): Promise<readonly CollectorNotice[]>;
  /** Tells the orchestrator about an apply a user started (setup / repair / remove). Never throws. */
  recordApplyResult(result: CollectorApplyResult): Promise<void>;
  currentNotices(): readonly CollectorNotice[];
}

const REPAIR_STATES: readonly string[] = ["foreign-registration", "registration-missing", "damaged"];

export function createCollectorStartupRefresh(deps: CollectorStartupRefreshDependencies): CollectorStartupRefresh {
  const active = new Map<string, CollectorNotice>();
  const dismissedForSession = new Set<string>();
  let running: Promise<CollectorStartupResult> | undefined;

  const snapshot = (): readonly CollectorNotice[] => Object.freeze([...active.values()]);

  async function persist(next: CollectorNoticeState): Promise<boolean> {
    try {
      await deps.noticeStore.write(next);
      return true;
    } catch {
      return false;
    }
  }

  async function inspectSafely(): Promise<CollectorIntegrationInspection | undefined> {
    try {
      return await deps.inspect({ verifyFileHashes: false });
    } catch {
      return undefined;
    }
  }

  async function probe(read: () => Promise<boolean>): Promise<boolean> {
    try {
      return await read();
    } catch {
      return false;
    }
  }

  function updatedPendingIsSatisfied(pending: NonNullable<CollectorNoticeState["updated"]>, inspection: CollectorIntegrationInspection): boolean {
    if (inspection.contact.status !== "present") return false;
    const record = inspection.contact.record;
    const comparison = compareCollectorVersions(record.extensionVersion, pending.extensionVersion);
    if (comparison !== "equal" && comparison !== "newer") return false;
    const contactedAt = Date.parse(record.contactedAt);
    const createdAt = Date.parse(pending.createdAt);
    return Number.isFinite(contactedAt) && Number.isFinite(createdAt) && contactedAt >= createdAt;
  }

  /** Drops the pending "updated" notice when a matching contact exists. Returns the (possibly new) state. */
  async function clearUpdatedIfSatisfied(state: CollectorNoticeState, inspection: CollectorIntegrationInspection): Promise<CollectorNoticeState> {
    if (state.updated === null || !updatedPendingIsSatisfied(state.updated, inspection)) return state;
    const next: CollectorNoticeState = { ...state, updated: null };
    active.delete(COLLECTOR_NOTICE_IDS.updated);
    await persist(next); // a failed write only means the notice is re-evaluated (and cleared again) next time
    return next;
  }

  function showUpdated(state: CollectorNoticeState): void {
    if (state.updated === null) return;
    active.set(COLLECTOR_NOTICE_IDS.updated, buildUpdatedNotice(state.updated.extensionVersion, state.updated.createdAt));
  }

  async function execute(): Promise<CollectorStartupResult> {
    active.clear();
    const finish = (outcome: CollectorStartupRefreshOutcome): CollectorStartupResult => Object.freeze({ outcome, notices: snapshot() });
    if (deps.e2eIsolationActive) return finish("skipped-e2e-isolation");

    const inspection = await inspectSafely();
    if (inspection === undefined) return finish("inspection-failed");
    const optedIn = await probe(deps.hasOptedIn);
    let state = await deps.noticeStore.read();

    if (!optedIn) {
      // Nothing is refreshed or repaired. A leftover "updated" notice of a removed installation is dropped.
      if (state.updated !== null) state = { ...state, updated: null };
      const candidate = inspection.state === "not-set-up" || inspection.state === "foreign-registration";
      if (candidate && state.alpha1 === "unseen" && (inspection.registration === "foreign" || await probe(deps.hasAlpha1Footprint))) {
        // Shown once: remembered before it is shown. A notice that could not be remembered stays hidden.
        if (await persist({ ...state, alpha1: "shown" })) active.set(COLLECTOR_NOTICE_IDS.alpha1Migration, buildAlpha1MigrationNotice());
      }
      return finish("not-opted-in");
    }

    if (state.removeRequested) {
      if (inspection.state === "ready") {
        // The installation is complete again (a setup happened outside `recordApplyResult`): lift the flag.
        state = { ...state, removeRequested: false };
        await persist(state);
      } else {
        if (state.updated !== null) await persist({ ...state, updated: null });
        return finish("remove-requested");
      }
    }

    if (!inspection.inspectionComplete) {
      showUpdated(state);
      return finish("inspection-incomplete");
    }

    state = await clearUpdatedIfSatisfied(state, inspection);

    if (inspection.state === "outdated") {
      const result = await applyRefresh();
      if (result === undefined) {
        showUpdated(state);
        return finish("refresh-failed");
      }
      if (result.outcome === "applied") {
        const createdAt = deps.now().toISOString();
        const extensionVersion = result.inspection.installed.extensionVersion;
        if (extensionVersion !== null) {
          state = { ...state, updated: { extensionVersion, createdAt } };
          await persist(state);
        }
        showUpdated(state);
        return finish("refreshed");
      }
      showUpdated(state);
      // `busy` is another apply running right now: its snapshot is transient. Everything else retries next launch.
      return finish(result.reason === "busy" ? "refresh-retry-later" : "refresh-failed");
    }

    if (REPAIR_STATES.includes(inspection.state) && !dismissedForSession.has(COLLECTOR_NOTICE_IDS.repair)) {
      active.set(COLLECTOR_NOTICE_IDS.repair, buildRepairNotice(inspection.state as CollectorRepairNoticeState));
    }
    showUpdated(state);
    return finish("no-action");
  }

  async function applyRefresh(): Promise<CollectorApplyResult | undefined> {
    try {
      return await deps.apply({ action: "refresh" });
    } catch {
      return undefined;
    }
  }

  return {
    runStartup(): Promise<CollectorStartupResult> {
      // One run at a time: a second call shares the first run.
      running ??= execute().catch((): CollectorStartupResult => Object.freeze({ outcome: "inspection-failed" as const, notices: snapshot() }))
        .finally(() => { running = undefined; });
      return running;
    },

    async reconcile(): Promise<readonly CollectorNotice[]> {
      try {
        if (deps.e2eIsolationActive) return snapshot();
        const state = await deps.noticeStore.read();
        if (state.updated === null) return snapshot();
        const inspection = await inspectSafely();
        if (inspection !== undefined) await clearUpdatedIfSatisfied(state, inspection);
      } catch {
        // keep the notice
      }
      return snapshot();
    },

    async dismiss(noticeId: string): Promise<readonly CollectorNotice[]> {
      try {
        const state = await deps.noticeStore.read();
        if (noticeId === COLLECTOR_NOTICE_IDS.updated) {
          active.delete(noticeId);
          if (state.updated !== null) await persist({ ...state, updated: null });
        } else if (noticeId === COLLECTOR_NOTICE_IDS.alpha1Migration) {
          active.delete(noticeId);
          if (state.alpha1 !== "dismissed") await persist({ ...state, alpha1: "dismissed" });
        } else if (noticeId === COLLECTOR_NOTICE_IDS.repair) {
          active.delete(noticeId);
          dismissedForSession.add(noticeId);
        }
      } catch {
        // nothing to do
      }
      return snapshot();
    },

    async recordApplyResult(result: CollectorApplyResult): Promise<void> {
      try {
        if (deps.e2eIsolationActive || result.reason === "busy") return;
        const state = await deps.noticeStore.read();
        if (result.action === "remove") {
          // Whatever the outcome, the user asked for it: stay quiet (a `partial` removal still looks damaged).
          active.delete(COLLECTOR_NOTICE_IDS.repair);
          active.delete(COLLECTOR_NOTICE_IDS.updated);
          if (!state.removeRequested || state.updated !== null) await persist({ ...state, removeRequested: true, updated: null });
        } else if ((result.action === "setup" || result.action === "repair") && (result.outcome === "applied" || result.outcome === "noop")) {
          active.delete(COLLECTOR_NOTICE_IDS.repair);
          active.delete(COLLECTOR_NOTICE_IDS.alpha1Migration);
          const next: CollectorNoticeState = { ...state, removeRequested: false, alpha1: state.alpha1 === "unseen" ? "dismissed" : state.alpha1 };
          if (next.removeRequested !== state.removeRequested || next.alpha1 !== state.alpha1) await persist(next);
        }
      } catch {
        // best effort
      }
    },

    currentNotices: snapshot,
  };
}
