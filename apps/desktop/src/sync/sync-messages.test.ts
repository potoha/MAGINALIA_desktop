import { describe, expect, it } from "vitest";
import { SYNC_COMMAND_IDS } from "./sync-commands.js";
import { allSyncMessageStrings, describeSyncState, reviewCauseSentence } from "./sync-messages.js";
import type { NeedsReviewCause, SyncState } from "./sync-state.js";

const CAUSES: readonly NeedsReviewCause[] = [
  "diverged",
  "remote-missing",
  "account-mismatch",
  "excluded-content",
  "file-too-large",
  "secret-detected",
  "remote-public",
];

describe("state wording", () => {
  const labels: readonly (readonly [Exclude<SyncState, "NEEDS_REVIEW">, string])[] = [
    ["NOT_CONFIGURED", "バックアップは未設定です"],
    ["SYNCED", "同期済み"],
    ["LOCAL_ONLY_SAVED", "履歴に保存済み"],
    ["PENDING", "同期待ち"],
    ["SYNCING", "同期中"],
    ["RECONNECT", "再接続が必要"],
    ["SAVED_ONLY", "保存済み"],
  ];

  it.each(labels)("%s is labelled %s", (state, label) => {
    expect(describeSyncState({ state, reviewCause: null }).label).toBe(label);
  });

  it("offers setup / reconnect only where the state calls for it", () => {
    expect(describeSyncState({ state: "NOT_CONFIGURED", reviewCause: null }).command).toBe("maginalia.sync.setup");
    expect(describeSyncState({ state: "RECONNECT", reviewCause: null }).command).toBe("maginalia.sync.reconnect");
    expect(describeSyncState({ state: "SYNCED", reviewCause: null }).command).toBeNull();
  });

  it("asks the UI to show the last sync time only for SYNCED", () => {
    expect(describeSyncState({ state: "SYNCED", reviewCause: null }).showsLastSyncAt).toBe(true);
    expect(describeSyncState({ state: "PENDING", reviewCause: null }).showsLastSyncAt).toBe(false);
  });

  it.each(CAUSES)("NEEDS_REVIEW (%s) has the shared label, one cause sentence and the local-content note", (cause) => {
    const view = describeSyncState({ state: "NEEDS_REVIEW", reviewCause: cause });
    expect(view.label).toBe("同期に確認が必要");
    expect(view.note).toBe(`${reviewCauseSentence(cause)}ローカルの内容は保たれています。`);
    expect(reviewCauseSentence(cause).split("。").filter((part) => part !== "")).toHaveLength(1);
  });

  it("uses a different sentence for every cause", () => {
    expect(new Set(CAUSES.map(reviewCauseSentence)).size).toBe(CAUSES.length);
  });
});

describe("wording rules", () => {
  it("no normal-UI string contains commit / push / branch / token / GitHub vocabulary", () => {
    const forbidden = /commit|push|pull|fetch|branch|token|github|\bgit\b|force|コミット|プッシュ|ブランチ|トークン|ギットハブ|リモート|リポジトリ|マージ|プル|フェッチ/iu;
    const strings = allSyncMessageStrings();
    expect(strings.length).toBeGreaterThan(10);
    for (const text of strings) expect(text).not.toMatch(forbidden);
  });
});

describe("Command IDs", () => {
  it("are the stable, namespaced IDs and are unique", () => {
    expect(SYNC_COMMAND_IDS).toEqual({
      setup: "maginalia.sync.setup",
      syncNow: "maginalia.sync.now",
      reconnect: "maginalia.sync.reconnect",
      disconnect: "maginalia.sync.disconnect",
      showStatus: "maginalia.sync.showStatus",
      checkpoint: "maginalia.history.checkpoint",
      restore: "maginalia.sync.restore",
    });
    const ids = Object.values(SYNC_COMMAND_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
