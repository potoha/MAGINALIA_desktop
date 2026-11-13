import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./command-registry";
import {
  ShelfController,
  type ShelfControllerApi,
  type ShelfControllerView,
  type ShelfViewState,
  type ShelfWritingPort
} from "./shelf-controller";
import {
  SHELF_REFRESH_FAILED_MESSAGE,
  SHELF_REFRESH_RELOAD_FAILED_MESSAGE,
  runShelfRefresh,
  shelfRefreshSuccessMessage,
  type ShelfRefreshFeedback
} from "./shelf-refresh-feedback";
import type { CanonicalShelfSearchReference, RefreshShelfResult, SearchShelfResult } from "../shelf-ipc";

function reference(n: number): CanonicalShelfSearchReference {
  return { annotationId: `ann:${n}`, sourceId: "src", quote: `q${n}`, title: "t", authors: [] };
}

function searchResult(count: number): SearchShelfResult {
  return { kind: "results", results: Array.from({ length: count }, (_, i) => reference(i)), total: count } as SearchShelfResult;
}

const refreshed: RefreshShelfResult = { kind: "refreshed", materialized: 0, unchanged: 0, pending: 0, conflicts: 0, failed: 0 };
const writing: ShelfWritingPort = { captureInsertionTarget: () => null, insertQuoteRef: () => { throw new Error("unused"); } };

function harness(counts: number[], refresh: () => Promise<RefreshShelfResult> = async () => refreshed) {
  let last: ShelfViewState | undefined;
  const view: ShelfControllerView = { setShelfState: (s) => { last = s; } };
  const queue = [...counts];
  const api: ShelfControllerApi = {
    searchShelf: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("boom /secret/path");
      return searchResult(next);
    })
  };
  const controller = new ShelfController({ api, writing, view });
  const refreshShelf = vi.fn(refresh);
  const run = (): Promise<ShelfRefreshFeedback> => runShelfRefresh({
    refreshShelf,
    getState: () => controller.getState(),
    reload: () => controller.search("")
  });
  return { controller, api, refreshShelf, run, getLast: () => last };
}

describe("shelfRefreshSuccessMessage", () => {
  it("covers added, unchanged, first-load and decreased", () => {
    expect(shelfRefreshSuccessMessage(5, 3)).toBe("更新しました。引用 5 件（前回から 2 件追加）");
    expect(shelfRefreshSuccessMessage(5, 5)).toBe("更新しました。変更はありません（引用 5 件）");
    expect(shelfRefreshSuccessMessage(5, null)).toBe("更新しました。引用 5 件");
    expect(shelfRefreshSuccessMessage(2, 5)).toBe("更新しました。引用 2 件（前回から 3 件減少）");
  });
});

describe("runShelfRefresh", () => {
  it("reports added quotations compared with the previous load", async () => {
    const h = harness([2, 5]);
    await h.controller.search("");
    expect(await h.run()).toEqual({ kind: "success", message: "更新しました。引用 5 件（前回から 3 件追加）" });
  });

  it("reports no change", async () => {
    const h = harness([4, 4]);
    await h.controller.search("");
    expect((await h.run()).message).toBe("更新しました。変更はありません（引用 4 件）");
  });

  it("shows only the total when there is no previous count", async () => {
    const h = harness([3]);
    expect(await h.run()).toEqual({ kind: "success", message: "更新しました。引用 3 件" });
  });

  it("reports a generic failure without internal detail when refresh errors", async () => {
    const h = harness([1], async () => ({ kind: "error", code: "reviewer-error", message: "C:\secret\path failed" }));
    const feedback = await h.run();
    expect(feedback).toEqual({ kind: "error", message: SHELF_REFRESH_FAILED_MESSAGE });
    expect(feedback.message).not.toContain("secret");
    expect(h.api.searchShelf).not.toHaveBeenCalled();
  });

  it("reports a generic failure when the refresh call throws", async () => {
    const h = harness([], async () => { throw new Error("/secret/path"); });
    expect(await h.run()).toEqual({ kind: "error", message: SHELF_REFRESH_FAILED_MESSAGE });
  });

  it("reports a failure when the reload after refresh fails", async () => {
    const h = harness([2]);
    await h.controller.search("");
    expect(await h.run()).toEqual({ kind: "error", message: SHELF_REFRESH_RELOAD_FAILED_MESSAGE });
  });

  it("reports unavailable when the runtime has no refresh API", async () => {
    const feedback = await runShelfRefresh({ refreshShelf: undefined, getState: () => { throw new Error("unused"); }, reload: async () => undefined });
    expect(feedback.kind).toBe("error");
  });
});

describe("command dispatch and initial load", () => {
  it("shows feedback only when maginalia.shelf.refresh runs, not on the initial load", async () => {
    const h = harness([2, 3]);
    const shown: ShelfRefreshFeedback[] = [];
    const registry = new CommandRegistry();
    registry.register({ id: "maginalia.shelf.refresh", title: "Refresh Shelf" }, async () => { shown.push(await h.run()); });

    await h.controller.search(""); // automatic initial load
    expect(shown).toEqual([]);

    const result = await registry.execute("maginalia.shelf.refresh", {} as never);
    expect(result.kind).toBe("executed");
    expect(shown).toEqual([{ kind: "success", message: "更新しました。引用 3 件（前回から 1 件追加）" }]);
  });

  it("is wired to the button and the command in the renderer composition root", async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = await readFile(path.join(dir, "main.ts"), "utf8");
    expect(source).toContain('executeShelfCommand("maginalia.shelf.refresh")');
    expect(source).toContain("runShelfRefresh(");
    expect(source).toMatch(/id="shelf-refresh-message" class="shelf-refresh-message" role="status" aria-live="polite"/u);
    // The automatic initial load must not call the feedback path.
    expect(source.match(/showShelfRefreshFeedback\(/gu)).toHaveLength(2); // definition + refresh handler
  });
});
