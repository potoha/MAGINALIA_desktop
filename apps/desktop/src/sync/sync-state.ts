/**
 * Backup / Sync state model (pure logic, no I/O).
 *
 * The user-facing state is derived from three axes (connection, relation,
 * local) plus two flags. Display wording lives in `sync-messages.ts` and the
 * Sync action table in `sync-decision.ts`.
 */

/** Connection axis. Derived from the remote registry, credentials and fetch results. */
export type SyncConnection = "not-configured" | "authenticated" | "auth-required" | "offline";

/**
 * Relation of local `main` to the fetched remote `main`.
 * `unknown` means no fetch has completed yet in this session.
 */
export type SyncRelation = "equal" | "ahead" | "behind" | "diverged" | "unknown";

/**
 * Local axis.
 * - `clean`: nothing newer than the last checkpoint.
 * - `dirty`: saved changes exist that no checkpoint covers yet.
 * - `unsaved`: edits still waiting for Autosave.
 */
export type SyncLocalState = "clean" | "dirty" | "unsaved";

/** Reasons that need a person to look. None of them is resolved automatically. */
export type NeedsReviewCause =
  | "diverged"
  | "remote-missing"
  | "account-mismatch"
  | "excluded-content"
  | "file-too-large"
  | "secret-detected"
  | "remote-public";

export type SyncState =
  | "NOT_CONFIGURED"
  | "SYNCED"
  | "LOCAL_ONLY_SAVED"
  | "PENDING"
  | "SYNCING"
  | "NEEDS_REVIEW"
  | "RECONNECT"
  | "SAVED_ONLY";

export interface SyncStateInputs {
  readonly connection: SyncConnection;
  readonly relation: SyncRelation;
  readonly local: SyncLocalState;
  /** True only while a Sync run is in progress. */
  readonly syncRunning: boolean;
  /**
   * A problem found by a check other than the relation (missing remote,
   * another account, excluded content, ...). `diverged` is derived from
   * `relation` and does not need to be passed here.
   */
  readonly reviewCause: NeedsReviewCause | null;
}

export interface DerivedSyncState {
  readonly state: SyncState;
  /** Set if and only if `state` is NEEDS_REVIEW. */
  readonly reviewCause: NeedsReviewCause | null;
}

function derived(state: SyncState, reviewCause: NeedsReviewCause | null = null): DerivedSyncState {
  return Object.freeze({ state, reviewCause });
}

/**
 * Pure: never mutates `inputs`, performs no I/O.
 *
 * Display priority, highest first:
 *   NOT_CONFIGURED (exclusive) > SYNCING (only while running)
 *   > RECONNECT > NEEDS_REVIEW > PENDING > SAVED_ONLY > LOCAL_ONLY_SAVED > SYNCED
 * The requirements rank RECONNECT > NEEDS_REVIEW > PENDING > SYNCING >
 * LOCAL_ONLY_SAVED > SYNCED and allow SYNCING to win while running. They do
 * not rank SAVED_ONLY; it sits above LOCAL_ONLY_SAVED so unsaved edits never
 * read as "history saved" or "synced".
 */
export function deriveSyncState(inputs: SyncStateInputs): DerivedSyncState {
  if (inputs.connection === "not-configured") return derived("NOT_CONFIGURED");
  if (inputs.syncRunning) return derived("SYNCING");
  if (inputs.connection === "auth-required") return derived("RECONNECT");

  const cause = inputs.reviewCause ?? (inputs.relation === "diverged" ? "diverged" : null);
  if (cause !== null) return derived("NEEDS_REVIEW", cause);

  // Offline history is never shown as synced; unknown/ahead/behind are all
  // "waiting for the next Sync".
  if (inputs.connection === "offline") return derived("PENDING");
  if (inputs.relation !== "equal") return derived("PENDING");

  if (inputs.local === "unsaved") return derived("SAVED_ONLY");
  if (inputs.local === "dirty") return derived("LOCAL_ONLY_SAVED");
  return derived("SYNCED");
}
