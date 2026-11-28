import type { NeedsReviewCause, SyncState } from "./sync-state.js";

/**
 * Sync decision table (after fetch, with saved changes already checkpointed).
 * Pure: it only says what the orchestrator may do next; it does no I/O.
 */

/** Relation of local `main` to the remote after a fetch, including the two "no usable remote" cases. */
export type FetchedRelation =
  | "equal"
  | "ahead"
  | "behind"
  | "diverged"
  | "remote-empty"
  | "remote-not-found";

export interface SyncDecisionInput {
  readonly relation: FetchedRelation;
  /** The working tree has edits Autosave has not written yet. */
  readonly hasUnsavedEdits: boolean;
  /** True only during the initial setup run. */
  readonly isSetup: boolean;
}

/** The only ref a Sync may update on either side. Never force. */
export const SYNC_REFSPEC = "refs/heads/main:refs/heads/main";

/** Actions that leave the working tree and every ref untouched. */
export type ReadOnlySyncAction =
  | { readonly kind: "none"; readonly mutatesRepository: false }
  /** Diverged: both histories stay as they are; nothing is merged or written. */
  | { readonly kind: "keep-both"; readonly mutatesRepository: false }
  /** Behind with unsaved edits: do not fast-forward, wait for the save and decide again. */
  | { readonly kind: "wait-for-save"; readonly mutatesRepository: false }
  /** Remote is gone or unexpectedly empty: never create it, guide re-linking. */
  | { readonly kind: "guide-relink"; readonly mutatesRepository: false };

/** Actions that write. Neither ever forces. */
export type WritingSyncAction =
  | {
      readonly kind: "push";
      readonly mutatesRepository: true;
      readonly refspec: typeof SYNC_REFSPEC;
      readonly force: false;
      /** A rejected push (remote moved first) is fetched and decided again, never forced. */
      readonly onRejected: "refetch-and-decide-again";
    }
  | { readonly kind: "initial-push"; readonly mutatesRepository: true; readonly refspec: typeof SYNC_REFSPEC; readonly force: false }
  | { readonly kind: "fast-forward"; readonly mutatesRepository: true };

export type SyncAction = ReadOnlySyncAction | WritingSyncAction;

export interface SyncDecision {
  readonly action: SyncAction;
  /** State after the action succeeds (or after a read-only action). */
  readonly resultState: SyncState;
  /** State if the action fails for a transient reason; null when the action cannot fail that way. */
  readonly failureState: SyncState | null;
  readonly reviewCause: NeedsReviewCause | null;
}

const NONE = Object.freeze({ kind: "none", mutatesRepository: false } as const);
const KEEP_BOTH = Object.freeze({ kind: "keep-both", mutatesRepository: false } as const);
const WAIT_FOR_SAVE = Object.freeze({ kind: "wait-for-save", mutatesRepository: false } as const);
const GUIDE_RELINK = Object.freeze({ kind: "guide-relink", mutatesRepository: false } as const);
const PUSH = Object.freeze({
  kind: "push",
  mutatesRepository: true,
  refspec: SYNC_REFSPEC,
  force: false,
  onRejected: "refetch-and-decide-again",
} as const);
const INITIAL_PUSH = Object.freeze({ kind: "initial-push", mutatesRepository: true, refspec: SYNC_REFSPEC, force: false } as const);
const FAST_FORWARD = Object.freeze({ kind: "fast-forward", mutatesRepository: true } as const);

function decision(action: SyncAction, resultState: SyncState, failureState: SyncState | null, reviewCause: NeedsReviewCause | null): SyncDecision {
  return Object.freeze({ action, resultState, failureState, reviewCause });
}

/** Pure: never mutates `input`, performs no I/O. */
export function decideSync(input: SyncDecisionInput): SyncDecision {
  switch (input.relation) {
    case "equal":
      return decision(NONE, "SYNCED", null, null);
    case "ahead":
      return decision(PUSH, "SYNCED", "PENDING", null);
    case "behind":
      return input.hasUnsavedEdits
        ? decision(WAIT_FOR_SAVE, "PENDING", null, null)
        : decision(FAST_FORWARD, "SYNCED", null, null);
    case "diverged":
      return decision(KEEP_BOTH, "NEEDS_REVIEW", null, "diverged");
    case "remote-empty":
      // An empty remote is only expected while setting up. Anywhere else it is
      // treated like a missing remote (failure path F22).
      return input.isSetup
        ? decision(INITIAL_PUSH, "SYNCED", "PENDING", null)
        : decision(GUIDE_RELINK, "NEEDS_REVIEW", null, "remote-missing");
    case "remote-not-found":
      return decision(GUIDE_RELINK, "NEEDS_REVIEW", null, "remote-missing");
  }
}
