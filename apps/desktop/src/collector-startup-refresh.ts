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
 *  - Notice state is read and written through one serialized chain; an apply never runs inside it.
 *  - The alpha1 notice is held back (not even persisted as `shown`) until the renderer asked for notices
 *    (`markNoticeSurfaceReady`); refresh and repair notices do not wait for that.
 *  - alpha1 notice (design 5, owner decision): once, whenever the user has not opted in, the state is
 *    `not-set-up` and the notice was never shown. Only the Desktop notice state (userData) is written.
 *    Other states (foreign-registration etc.) never raise it; the repair notice owns those.
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
  readonly noticeStore: CollectorNoticeStore;
  readonly now: () => Date;
  /** Decided by the composition root (this module reads no environment). */
  readonly e2eIsolationActive: boolean;
  /** Development build without an embedded payload descriptor: the feature is off (a packaged app fails at composition instead). */
  readonly payloadUnavailable?: boolean;
}

export type CollectorStartupRefreshOutcome =
  | "skipped-e2e-isolation"
  | "skipped-no-payload"
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
  /**
   * The renderer can show notices now (it asked for them at least once). Until then the one-time
   * alpha1 notice is neither persisted as `shown` nor shown; everything else runs independently.
   * Returns the active notices. Never throws.
   */
  markNoticeSurfaceReady(): Promise<readonly CollectorNotice[]>;
  /** Tells the orchestrator about an apply a user started (setup / repair / remove). Never throws. */
  recordApplyResult(result: CollectorApplyResult): Promise<void>;
  currentNotices(): readonly CollectorNotice[];
}

const REPAIR_STATES: readonly string[] = ["foreign-registration", "registration-missing", "damaged"];

export function createCollectorStartupRefresh(deps: CollectorStartupRefreshDependencies): CollectorStartupRefresh {
  const active = new Map<string, CollectorNotice>();
  const dismissedForSession = new Set<string>();
  let running: Promise<CollectorStartupResult> | undefined;
  /** The renderer has asked for the notices at least once, so something can show them. */
  let surfaceReady = false;
  /** The alpha1 notice is due but was held back until a surface exists. */
  let alpha1Pending = false;

  const snapshot = (): readonly CollectorNotice[] => Object.freeze([...active.values()]);

  // Every read-modify-write of the notice state goes through this one chain, so a reconcile, a
  // dismissal, an apply record and the startup run can never overwrite each other with a stale copy.
  // Applies and inspections are NOT run inside it (an apply may wait for a user dialog).
  let stateChain: Promise<unknown> = Promise.resolve();

  /**
   * Reads the current state, lets `update` return the next one (or `undefined` for "no change") and
   * persists it. `state` is the state after the update even when the write failed (`persisted: false`).
   */
  function mutate(update: (state: CollectorNoticeState) => CollectorNoticeState | undefined): Promise<{ readonly state: CollectorNoticeState; readonly persisted: boolean }> {
    const run = stateChain.then(async () => {
      const current = await deps.noticeStore.read();
      const next = update(current);
      if (next === undefined) return { state: current, persisted: false };
      try {
        await deps.noticeStore.write(next);
        return { state: next, persisted: true };
      } catch {
        return { state: next, persisted: false };
      }
    });
    stateChain = run.then(() => undefined, () => undefined);
    return run;
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

  /** Drops the pending "updated" notice when a matching contact exists (decided on the freshest state). */
  async function clearUpdatedIfSatisfied(inspection: CollectorIntegrationInspection): Promise<CollectorNoticeState> {
    const result = await mutate((state) => state.updated !== null && updatedPendingIsSatisfied(state.updated, inspection) ? { ...state, updated: null } : undefined);
    // a failed write only means the notice is re-evaluated (and cleared again) next time
    if (result.state.updated === null) active.delete(COLLECTOR_NOTICE_IDS.updated);
    return result.state;
  }

  function showUpdated(state: CollectorNoticeState): void {
    if (state.updated === null) return;
    active.set(COLLECTOR_NOTICE_IDS.updated, buildUpdatedNotice(state.updated.extensionVersion, state.updated.createdAt));
  }

  /**
   * The one-time alpha1 notice: remembered (`shown`) before it is shown, and only once a surface can
   * show it. A notice that could not be remembered stays hidden. A leftover "updated" entry of a
   * removed installation is dropped with the same write.
   */
  async function showAlpha1(): Promise<void> {
    const result = await mutate((state) => state.alpha1 === "unseen" ? { ...state, alpha1: "shown" as const, updated: null } : undefined);
    if (result.persisted) active.set(COLLECTOR_NOTICE_IDS.alpha1Migration, buildAlpha1MigrationNotice());
  }

  async function execute(): Promise<CollectorStartupResult> {
    active.clear();
    alpha1Pending = false;
    const finish = (outcome: CollectorStartupRefreshOutcome): CollectorStartupResult => Object.freeze({ outcome, notices: snapshot() });
    if (deps.e2eIsolationActive) return finish("skipped-e2e-isolation");
    if (deps.payloadUnavailable === true) return finish("skipped-no-payload");

    const inspection = await inspectSafely();
    if (inspection === undefined) return finish("inspection-failed");
    const optedIn = await probe(deps.hasOptedIn);
    let state = (await mutate(() => undefined)).state;

    if (!optedIn) {
      // Nothing is refreshed or repaired.
      if (inspection.state === "not-set-up" && state.alpha1 === "unseen") {
        if (surfaceReady) await showAlpha1();
        else alpha1Pending = true; // nothing could show it yet: do not spend the one-time notice
      }
      return finish("not-opted-in");
    }

    if (state.removeRequested) {
      if (inspection.state === "ready") {
        // The installation is complete again (a setup happened outside `recordApplyResult`): lift the flag.
        state = (await mutate((current) => ({ ...current, removeRequested: false }))).state;
      } else {
        await mutate((current) => current.updated !== null ? { ...current, updated: null } : undefined);
        return finish("remove-requested");
      }
    }

    if (!inspection.inspectionComplete) {
      showUpdated(state);
      return finish("inspection-incomplete");
    }

    state = await clearUpdatedIfSatisfied(inspection);

    if (inspection.state === "outdated") {
      const result = await applyRefresh();
      // The apply may have waited behind a user action: decide on the state as it is now.
      if (result === undefined) {
        showUpdated((await mutate(() => undefined)).state);
        return finish("refresh-failed");
      }
      if (result.outcome === "applied") {
        // Announce only when the placed payload changed (design 4.6 / 5.4). A registration-only refresh
        // adds registry keys and leaves the payloadId alone: nothing new to tell the user, and any
        // pending "updated" notice stays as it is.
        if (result.inspection.installed.payloadId === inspection.installed.payloadId) {
          showUpdated((await mutate(() => undefined)).state);
          return finish("refreshed");
        }
        const createdAt = deps.now().toISOString();
        const extensionVersion = result.inspection.installed.extensionVersion;
        const after = await mutate((current) => extensionVersion !== null ? { ...current, updated: { extensionVersion, createdAt } } : undefined);
        showUpdated(after.state);
        return finish("refreshed");
      }
      showUpdated((await mutate(() => undefined)).state);
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

    async markNoticeSurfaceReady(): Promise<readonly CollectorNotice[]> {
      try {
        if (deps.e2eIsolationActive || deps.payloadUnavailable === true) return snapshot();
        surfaceReady = true;
        if (running !== undefined) await running.catch(() => undefined); // a run in progress sees the flag itself, or leaves `alpha1Pending`
        if (alpha1Pending) {
          alpha1Pending = false;
          const optedIn = await probe(deps.hasOptedIn);
          if (!optedIn) await showAlpha1();
        }
      } catch {
        // keep what is shown
      }
      return snapshot();
    },

    async reconcile(): Promise<readonly CollectorNotice[]> {
      try {
        if (deps.e2eIsolationActive) return snapshot();
        const state = (await mutate(() => undefined)).state;
        if (state.updated === null) return snapshot();
        const inspection = await inspectSafely();
        if (inspection !== undefined) await clearUpdatedIfSatisfied(inspection);
      } catch {
        // keep the notice
      }
      return snapshot();
    },

    async dismiss(noticeId: string): Promise<readonly CollectorNotice[]> {
      try {
        if (noticeId === COLLECTOR_NOTICE_IDS.updated) {
          active.delete(noticeId);
          await mutate((state) => state.updated !== null ? { ...state, updated: null } : undefined);
        } else if (noticeId === COLLECTOR_NOTICE_IDS.alpha1Migration) {
          active.delete(noticeId);
          await mutate((state) => state.alpha1 !== "dismissed" ? { ...state, alpha1: "dismissed" as const } : undefined);
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
        // `refused` changed nothing (`busy` is a transient snapshot): it is not a completed user request.
        if (deps.e2eIsolationActive || result.outcome === "refused") return;
        if (result.action === "remove") {
          // Whatever else happened, the user asked for it: stay quiet (a `partial` removal still looks damaged).
          active.delete(COLLECTOR_NOTICE_IDS.repair);
          active.delete(COLLECTOR_NOTICE_IDS.updated);
          await mutate((state) => !state.removeRequested || state.updated !== null ? { ...state, removeRequested: true, updated: null } : undefined);
        } else if ((result.action === "setup" || result.action === "repair") && (result.outcome === "applied" || result.outcome === "noop")) {
          active.delete(COLLECTOR_NOTICE_IDS.repair);
          active.delete(COLLECTOR_NOTICE_IDS.alpha1Migration);
          alpha1Pending = false;
          await mutate((state) => {
            const next: CollectorNoticeState = { ...state, removeRequested: false, alpha1: state.alpha1 === "unseen" ? "dismissed" : state.alpha1 };
            return next.removeRequested !== state.removeRequested || next.alpha1 !== state.alpha1 ? next : undefined;
          });
        }
      } catch {
        // best effort
      }
    },

    currentNotices: snapshot,
  };
}
