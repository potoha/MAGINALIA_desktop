import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYNC_REFSPEC, decideSync, type FetchedRelation, type SyncDecisionInput } from "./sync-decision.js";
import { deriveSyncState, type SyncState } from "./sync-state.js";

const SETTLED: Omit<SyncDecisionInput, "relation"> = { hasUnsavedEdits: false, isSetup: false };

describe("decideSync: one test per row of the decision table", () => {
  it("equal -> no action, SYNCED", () => {
    const result = decideSync({ ...SETTLED, relation: "equal" });
    expect(result).toMatchObject({ action: { kind: "none", mutatesRepository: false }, resultState: "SYNCED", failureState: null, reviewCause: null });
  });

  it("ahead -> push of refs/heads/main only without force; SYNCED, or PENDING on failure", () => {
    const result = decideSync({ ...SETTLED, relation: "ahead" });
    expect(result.action).toEqual({
      kind: "push",
      mutatesRepository: true,
      refspec: "refs/heads/main:refs/heads/main",
      force: false,
      onRejected: "refetch-and-decide-again",
    });
    expect(result).toMatchObject({ resultState: "SYNCED", failureState: "PENDING", reviewCause: null });
    expect(SYNC_REFSPEC.startsWith("+")).toBe(false);
  });

  it("behind with a clean working tree -> fast-forward, SYNCED", () => {
    const result = decideSync({ ...SETTLED, relation: "behind" });
    expect(result).toMatchObject({ action: { kind: "fast-forward", mutatesRepository: true, ffOnly: true }, resultState: "SYNCED", reviewCause: null });
  });

  it("behind with unsaved edits -> no fast-forward; wait for the save and decide again (PENDING)", () => {
    const result = decideSync({ ...SETTLED, relation: "behind", hasUnsavedEdits: true });
    expect(result).toMatchObject({ action: { kind: "wait-for-save", mutatesRepository: false }, resultState: "PENDING", reviewCause: null });
  });

  it("diverged -> keep both histories, write nothing, NEEDS_REVIEW (diverged)", () => {
    const result = decideSync({ ...SETTLED, relation: "diverged" });
    // Fixed by the diverged overload's type, and pinned here at run time.
    expect(result.action.kind).toBe("keep-both");
    expect(result.resultState).toBe("NEEDS_REVIEW");
    expect(result).toMatchObject({
      action: { kind: "keep-both", mutatesRepository: false },
      resultState: "NEEDS_REVIEW",
      failureState: null,
      reviewCause: "diverged",
    });
  });

  it("remote has no branch yet during setup -> initial push, SYNCED, PENDING on failure", () => {
    const result = decideSync({ ...SETTLED, relation: "remote-empty", isSetup: true });
    expect(result.action).toEqual({ kind: "initial-push", mutatesRepository: true, refspec: SYNC_REFSPEC, force: false });
    expect(result).toMatchObject({ resultState: "SYNCED", failureState: "PENDING", reviewCause: null });
  });

  it("remote has no branch outside setup -> never pushes, NEEDS_REVIEW (remote-missing)", () => {
    const result = decideSync({ ...SETTLED, relation: "remote-empty", isSetup: false });
    expect(result).toMatchObject({ action: { kind: "guide-relink", mutatesRepository: false }, resultState: "NEEDS_REVIEW", reviewCause: "remote-missing" });
  });

  it.each([true, false])("remote repository not found (setup=%s) -> never creates it, NEEDS_REVIEW (remote-missing)", (isSetup) => {
    const result = decideSync({ ...SETTLED, relation: "remote-not-found", isSetup });
    expect(result).toMatchObject({ action: { kind: "guide-relink", mutatesRepository: false }, resultState: "NEEDS_REVIEW", reviewCause: "remote-missing" });
  });
});

describe("decideSync: read-only guarantees", () => {
  it("diverged is read-only for every combination of the other inputs and leaves a frozen input intact", () => {
    for (const hasUnsavedEdits of [false, true]) {
      for (const isSetup of [false, true]) {
        const input = Object.freeze({ relation: "diverged" as const, hasUnsavedEdits, isSetup });
        const before = JSON.stringify(input);
        const result = decideSync(input);
        expect(result.action.mutatesRepository).toBe(false);
        expect(JSON.stringify(input)).toBe(before);
      }
    }
  });

  it("the only writing actions are push, initial push and fast-forward, and none of them forces", () => {
    const relations = ["equal", "ahead", "behind", "diverged", "remote-empty", "remote-not-found"] as const;
    for (const relation of relations) {
      for (const hasUnsavedEdits of [false, true]) {
        for (const isSetup of [false, true]) {
          const { action } = decideSync({ relation, hasUnsavedEdits, isSetup });
          if (action.mutatesRepository) {
            expect(["push", "initial-push", "fast-forward"]).toContain(action.kind);
            if (action.kind !== "fast-forward") expect(action.force).toBe(false);
          }
        }
      }
    }
  });

  it("the pure modules import no filesystem, process, network or Electron API", async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const name of (await readdir(dir)).filter((file) => /^sync-(state|decision|messages|commands)\.ts$/u.test(file))) {
      const source = await readFile(path.join(dir, name), "utf8");
      expect(source, name).not.toMatch(/from\s+"(node:|electron|isomorphic-git)/u);
    }
  });
});

describe("decideSync resultState agrees with deriveSyncState", () => {
  // Sync-axis outcome -> the derive inputs that describe the same situation.
  function deriveFor(relation: FetchedRelation, state: SyncState, local: "clean" | "unsaved") {
    const syncRelation = state === "SYNCED" ? "equal" : relation === "behind" ? "behind" : "unknown";
    const reviewCause = state === "NEEDS_REVIEW" ? decideSync({ relation, hasUnsavedEdits: false, isSetup: false }).reviewCause : null;
    return deriveSyncState({
      connection: "authenticated",
      relation: relation === "diverged" ? "diverged" : syncRelation,
      local,
      syncRunning: false,
      reviewCause: relation === "diverged" ? null : reviewCause,
    });
  }

  const relations = ["equal", "ahead", "behind", "diverged", "remote-empty", "remote-not-found"] as const;

  it.each(relations)("%s: with a settled local axis both give the same state", (relation) => {
    for (const isSetup of [false, true]) {
      const { resultState, reviewCause } = decideSync({ relation, hasUnsavedEdits: false, isSetup });
      const derived = deriveFor(relation, resultState, "clean");
      expect(derived.state).toBe(resultState);
      expect(derived.reviewCause).toBe(reviewCause);
    }
  });

  it("differs only through the local axis: SYNCED with unsaved edits is displayed as SAVED_ONLY", () => {
    const { resultState } = decideSync({ relation: "equal", hasUnsavedEdits: true, isSetup: false });
    expect(resultState).toBe("SYNCED");
    expect(deriveFor("equal", resultState, "unsaved").state).toBe("SAVED_ONLY");
  });

  it("a failed push is displayed as PENDING by deriveSyncState", () => {
    const { failureState } = decideSync({ relation: "ahead", hasUnsavedEdits: false, isSetup: false });
    expect(failureState).toBe("PENDING");
    expect(deriveSyncState({ connection: "authenticated", relation: "ahead", local: "clean", syncRunning: false, reviewCause: null }).state).toBe("PENDING");
  });
});
