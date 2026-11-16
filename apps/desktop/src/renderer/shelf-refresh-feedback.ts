import type { RefreshShelfResult } from "../shelf-ipc";
import type { ShelfViewState } from "./shelf-controller";

export type ShelfRefreshFeedbackKind = "success" | "error";

export interface ShelfRefreshFeedback {
  readonly kind: ShelfRefreshFeedbackKind;
  readonly message: string;
}

/** User-facing failure text. It never carries paths or internal detail. */
export const SHELF_REFRESH_FAILED_MESSAGE = "更新できませんでした。しばらくしてからもう一度お試しください。";
export const SHELF_REFRESH_RELOAD_FAILED_MESSAGE = "更新できませんでした。Shelfの内容を再読み込みできませんでした。";
export const SHELF_REFRESH_UNAVAILABLE_MESSAGE = "更新できませんでした。この環境ではShelfを更新できません。";

export type ShelfRefreshCountScope = "library" | "search";

/**
 * Builds the success message from the real post-refresh count and, when
 * known, the count before this refresh. With an active query the count is for
 * the displayed search results only, and the text says so.
 */
export function shelfRefreshSuccessMessage(
  total: number,
  previousTotal: number | null,
  scope: ShelfRefreshCountScope = "library"
): string {
  const label = scope === "search" ? "表示中の検索結果" : "引用";
  if (previousTotal === null) return `更新しました。${label} ${total} 件`;
  const added = total - previousTotal;
  if (added > 0) return `更新しました。${label} ${total} 件（前回から ${added} 件追加）`;
  if (added === 0) {
    return scope === "search"
      ? `更新しました。表示中の検索結果に変更はありません（${total} 件）`
      : `更新しました。変更はありません（引用 ${total} 件）`;
  }
  return `更新しました。${label} ${total} 件（前回から ${-added} 件減少）`;
}

export interface ShelfRefreshRunner {
  readonly refreshShelf: (() => Promise<RefreshShelfResult>) | undefined;
  readonly getState: () => ShelfViewState;
  readonly reload: () => Promise<void>;
}

/**
 * Runs one explicit Shelf refresh (never the automatic initial load) and
 * returns the confirmation to show. `previousTotal` is only trusted when the
 * Shelf had finished loading before the refresh started.
 */
export async function runShelfRefresh(runner: ShelfRefreshRunner): Promise<ShelfRefreshFeedback> {
  const { refreshShelf } = runner;
  if (typeof refreshShelf !== "function") {
    return { kind: "error", message: SHELF_REFRESH_UNAVAILABLE_MESSAGE };
  }
  const before = runner.getState();
  const beforeTotal = before.status === "ready" ? (before.total ?? before.results.length) : null;

  let result: RefreshShelfResult;
  try {
    result = await refreshShelf();
  } catch (_error: unknown) {
    return { kind: "error", message: SHELF_REFRESH_FAILED_MESSAGE };
  }
  if (result.kind === "error") return { kind: "error", message: SHELF_REFRESH_FAILED_MESSAGE };

  await runner.reload();
  const after = runner.getState();
  if (after.status !== "ready") return { kind: "error", message: SHELF_REFRESH_RELOAD_FAILED_MESSAGE };
  const total = after.total ?? after.results.length;
  // A count from a different query is not comparable: show no delta.
  const previousTotal = before.query === after.query ? beforeTotal : null;
  const scope: ShelfRefreshCountScope = after.query.trim() === "" ? "library" : "search";
  return { kind: "success", message: shelfRefreshSuccessMessage(total, previousTotal, scope) };
}
