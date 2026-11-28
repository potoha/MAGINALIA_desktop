import { describe, expect, it } from "vitest";
import {
  deriveSyncState,
  type NeedsReviewCause,
  type SyncConnection,
  type SyncLocalState,
  type SyncRelation,
  type SyncState,
  type SyncStateInputs,
} from "./sync-state.js";

const BASE: SyncStateInputs = {
  connection: "authenticated",
  relation: "equal",
  local: "clean",
  syncRunning: false,
  reviewCause: null,
};

function derive(overrides: Partial<SyncStateInputs>): { state: SyncState; reviewCause: NeedsReviewCause | null } {
  return deriveSyncState({ ...BASE, ...overrides });
}

describe("deriveSyncState: one row per user-facing state", () => {
  const rows: readonly { readonly name: string; readonly inputs: Partial<SyncStateInputs>; readonly state: SyncState }[] = [
    { name: "no registration", inputs: { connection: "not-configured", relation: "unknown" }, state: "NOT_CONFIGURED" },
    { name: "authenticated, equal, clean", inputs: {}, state: "SYNCED" },
    { name: "equal with saved changes not yet in history", inputs: { local: "dirty" }, state: "LOCAL_ONLY_SAVED" },
    { name: "offline", inputs: { connection: "offline" }, state: "PENDING" },
    { name: "ahead (push not done)", inputs: { relation: "ahead" }, state: "PENDING" },
    { name: "behind (waiting for the next Sync)", inputs: { relation: "behind" }, state: "PENDING" },
    { name: "no fetch has completed yet", inputs: { relation: "unknown" }, state: "PENDING" },
    { name: "Sync running", inputs: { syncRunning: true }, state: "SYNCING" },
    { name: "diverged", inputs: { relation: "diverged" }, state: "NEEDS_REVIEW" },
    { name: "check found a problem", inputs: { reviewCause: "remote-public" }, state: "NEEDS_REVIEW" },
    { name: "confirmed 401", inputs: { connection: "auth-required" }, state: "RECONNECT" },
    { name: "unsaved edits", inputs: { local: "unsaved" }, state: "SAVED_ONLY" },
  ];

  it.each(rows)("$name -> $state", ({ inputs, state }) => {
    expect(derive(inputs).state).toBe(state);
  });
});

describe("deriveSyncState: priority", () => {
  it("RECONNECT beats NEEDS_REVIEW, PENDING and local states", () => {
    expect(derive({ connection: "auth-required", relation: "diverged", reviewCause: "remote-missing", local: "dirty" }).state).toBe("RECONNECT");
  });

  it("NEEDS_REVIEW beats PENDING (offline, ahead) and local states", () => {
    expect(derive({ relation: "diverged", connection: "offline" }).state).toBe("NEEDS_REVIEW");
    expect(derive({ relation: "ahead", reviewCause: "file-too-large", local: "dirty" }).state).toBe("NEEDS_REVIEW");
  });

  it("PENDING beats LOCAL_ONLY_SAVED, SAVED_ONLY and SYNCED", () => {
    expect(derive({ relation: "ahead", local: "dirty" }).state).toBe("PENDING");
    expect(derive({ connection: "offline", local: "unsaved" }).state).toBe("PENDING");
  });

  it("SAVED_ONLY beats LOCAL_ONLY_SAVED when edits are unsaved", () => {
    expect(derive({ local: "unsaved" }).state).toBe("SAVED_ONLY");
  });

  it("SYNCING wins only while a run is in progress and never over NOT_CONFIGURED", () => {
    expect(derive({ syncRunning: true, relation: "diverged", reviewCause: "remote-missing" }).state).toBe("SYNCING");
    expect(derive({ syncRunning: true, connection: "auth-required" }).state).toBe("SYNCING");
    expect(derive({ syncRunning: true, connection: "not-configured" }).state).toBe("NOT_CONFIGURED");
  });

  it("offline history is never shown as synced", () => {
    expect(derive({ connection: "offline", relation: "equal", local: "clean" }).state).not.toBe("SYNCED");
  });
});

describe("deriveSyncState: review cause", () => {
  it("reports diverged as the cause when the relation is diverged", () => {
    expect(derive({ relation: "diverged" })).toEqual({ state: "NEEDS_REVIEW", reviewCause: "diverged" });
  });

  it("keeps an explicit cause ahead of the relation-derived one", () => {
    expect(derive({ relation: "diverged", reviewCause: "account-mismatch" }).reviewCause).toBe("account-mismatch");
  });

  it.each(["remote-missing", "account-mismatch", "excluded-content", "file-too-large", "secret-detected", "remote-public"] as const)(
    "carries cause %s",
    (cause) => {
      expect(derive({ reviewCause: cause })).toEqual({ state: "NEEDS_REVIEW", reviewCause: cause });
    },
  );
});

describe("deriveSyncState: exhaustive and pure", () => {
  const connections: readonly SyncConnection[] = ["not-configured", "authenticated", "auth-required", "offline"];
  const relations: readonly SyncRelation[] = ["equal", "ahead", "behind", "diverged", "unknown"];
  const locals: readonly SyncLocalState[] = ["clean", "dirty", "unsaved"];
  const causes: readonly (NeedsReviewCause | null)[] = [null, "remote-missing"];

  it("sets a cause exactly when the state is NEEDS_REVIEW, for every input combination", () => {
    for (const connection of connections) {
      for (const relation of relations) {
        for (const local of locals) {
          for (const syncRunning of [false, true]) {
            for (const reviewCause of causes) {
              const result = deriveSyncState({ connection, relation, local, syncRunning, reviewCause });
              expect(result.state === "NEEDS_REVIEW").toBe(result.reviewCause !== null);
            }
          }
        }
      }
    }
  });

  it("does not modify a frozen input", () => {
    const inputs = Object.freeze({ ...BASE, relation: "diverged" as const });
    const before = JSON.stringify(inputs);
    expect(() => deriveSyncState(inputs)).not.toThrow();
    expect(JSON.stringify(inputs)).toBe(before);
  });
});
