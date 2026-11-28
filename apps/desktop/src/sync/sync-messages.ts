import { SYNC_COMMAND_IDS, type SyncCommandId } from "./sync-commands.js";
import type { DerivedSyncState, NeedsReviewCause, SyncState } from "./sync-state.js";

/**
 * Normal-UI wording for each state. These strings are user-facing Japanese and
 * must stay free of developer vocabulary (the setup screen is the only place
 * that may name the hosting service). Only fixed strings are exposed so raw
 * transport errors can never reach the UI.
 */
export interface SyncStateView {
  readonly label: string;
  /** Supplementary sentence; null when the state needs none. */
  readonly note: string | null;
  /** The UI should append the last successful sync time to the note. */
  readonly showsLastSyncAt: boolean;
  /** Command the status surface offers for this state, if any. */
  readonly command: SyncCommandId | null;
}

const STATE_VIEWS: Readonly<Record<Exclude<SyncState, "NEEDS_REVIEW">, SyncStateView>> = Object.freeze({
  NOT_CONFIGURED: view("バックアップは未設定です", "「バックアップ・共有を始める」から設定できます。", false, SYNC_COMMAND_IDS.setup),
  SYNCED: view("同期済み", null, true, null),
  LOCAL_ONLY_SAVED: view("履歴に保存済み", "次の同期で送ります。", false, null),
  PENDING: view("同期待ち", "接続が戻ると自動で同期します。", false, null),
  SYNCING: view("同期中", null, false, null),
  RECONNECT: view("再接続が必要", "再接続すると同期を再開します。", false, SYNC_COMMAND_IDS.reconnect),
  SAVED_ONLY: view("保存済み", null, false, null),
});

const NEEDS_REVIEW_LABEL = "同期に確認が必要";
const LOCAL_KEPT_SENTENCE = "ローカルの内容は保たれています。";

/** One sentence per cause. */
const REVIEW_CAUSE_SENTENCES: Readonly<Record<NeedsReviewCause, string>> = Object.freeze({
  diverged: "この端末とバックアップ先の両方に、別々の変更があります。",
  "remote-missing": "バックアップ先が見つかりません。",
  "account-mismatch": "バックアップ先を作成したときとは別のアカウントで接続されています。",
  "excluded-content": "バックアップの対象にしない内容が、履歴に含まれています。",
  "file-too-large": "サイズが大きすぎるファイルがあり、バックアップできません。",
  "secret-detected": "パスワードや鍵のような内容が含まれている可能性があります。",
  "remote-public": "バックアップ先が非公開ではなくなっています。",
});

function view(label: string, note: string | null, showsLastSyncAt: boolean, command: SyncCommandId | null): SyncStateView {
  return Object.freeze({ label, note, showsLastSyncAt, command });
}

export function reviewCauseSentence(cause: NeedsReviewCause): string {
  return REVIEW_CAUSE_SENTENCES[cause];
}

/** Every user-facing string in this module, for wording checks. */
export function allSyncMessageStrings(): readonly string[] {
  const states = Object.values(STATE_VIEWS).flatMap((entry) => [entry.label, entry.note ?? ""]);
  return [...states, NEEDS_REVIEW_LABEL, LOCAL_KEPT_SENTENCE, ...Object.values(REVIEW_CAUSE_SENTENCES)].filter((text) => text !== "");
}

export function describeSyncState(derived: DerivedSyncState): SyncStateView {
  if (derived.state !== "NEEDS_REVIEW") return STATE_VIEWS[derived.state];
  const sentence = derived.reviewCause === null ? "" : REVIEW_CAUSE_SENTENCES[derived.reviewCause];
  return Object.freeze({
    label: NEEDS_REVIEW_LABEL,
    note: `${sentence}${LOCAL_KEPT_SENTENCE}`,
    showsLastSyncAt: false,
    command: SYNC_COMMAND_IDS.showStatus,
  });
}
