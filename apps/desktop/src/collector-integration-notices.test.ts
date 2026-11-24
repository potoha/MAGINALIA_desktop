import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAlpha1MigrationNotice,
  buildRemoveFailedNotice,
  buildRepairNotice,
  buildUpdatedNotice,
  createFileCollectorNoticeStore,
  DEFAULT_COLLECTOR_NOTICE_STATE,
  parseCollectorNoticeState,
} from "./collector-integration-notices.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("notice state", () => {
  it("round-trips through the file store atomically and holds no path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-notices-"));
    directories.push(directory);
    const file = path.join(directory, "sub", "collector-notices.json");
    const store = createFileCollectorNoticeStore(file);
    expect(await store.read()).toEqual(DEFAULT_COLLECTOR_NOTICE_STATE);
    const state = { version: 2 as const, removeRequested: true, alpha1: "shown" as const, updated: { extensionVersion: "0.4.0", createdAt: "2026-11-16T09:00:00.000Z" }, browser: "edge" as const };
    await store.write(state);
    expect(await store.read()).toEqual(state);
    expect(await readdir(path.dirname(file))).toEqual(["collector-notices.json"]);
    expect(await readFile(file, "utf8")).not.toMatch(/[A-Za-z]:\\/u);
  });

  it("defaults to version 2 with no remembered browser", () => {
    expect(DEFAULT_COLLECTOR_NOTICE_STATE).toEqual({ version: 2, removeRequested: false, alpha1: "unseen", updated: null, browser: null });
  });

  it("reads a version 1 file as version 2 with no browser, and the next write is version 2", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-notices-"));
    directories.push(directory);
    const file = path.join(directory, "collector-notices.json");
    const v1 = { version: 1, removeRequested: true, alpha1: "dismissed", updated: { extensionVersion: "0.4.0", createdAt: "2026-11-16T09:00:00.000Z" } };
    await writeFile(file, JSON.stringify(v1), "utf8");
    const store = createFileCollectorNoticeStore(file);
    const read = await store.read();
    expect(read).toEqual({ ...v1, version: 2, browser: null });
    await store.write({ ...read, browser: "chrome" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...v1, version: 2, browser: "chrome" });
  });

  it.each([
    ["an unknown id", "brave"],
    ["a path", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
    ["a URL", "https://example.test"],
    ["a wrong case", "Chrome"],
    ["a number", 7],
    ["an object", { id: "chrome" }],
    ["a boolean", true],
  ])("ignores %s as the saved browser and keeps the rest of the state", (_name, browser) => {
    const text = JSON.stringify({ version: 2, removeRequested: true, alpha1: "shown", updated: null, browser });
    expect(parseCollectorNoticeState(text)).toEqual({ version: 2, removeRequested: true, alpha1: "shown", updated: null, browser: null });
  });

  it.each(["edge", "chrome", "vivaldi"] as const)("keeps the saved browser %s", (browser) => {
    expect(parseCollectorNoticeState(JSON.stringify({ version: 2, removeRequested: false, alpha1: "unseen", updated: null, browser }))?.browser).toBe(browser);
  });

  it("reads a damaged file as the defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-notices-"));
    directories.push(directory);
    const file = path.join(directory, "collector-notices.json");
    await writeFile(file, "{not json", "utf8");
    expect(await createFileCollectorNoticeStore(file).read()).toEqual(DEFAULT_COLLECTOR_NOTICE_STATE);
  });

  it.each([
    ["extra field", { version: 1, removeRequested: false, alpha1: "unseen", updated: null, path: "C:\\x" }],
    ["extra field in version 2", { version: 2, removeRequested: false, alpha1: "unseen", updated: null, browser: null, path: "C:\\x" }],
    ["a browser field in version 1", { version: 1, removeRequested: false, alpha1: "unseen", updated: null, browser: "chrome" }],
    ["version 2 without the browser field", { version: 2, removeRequested: false, alpha1: "unseen", updated: null }],
    ["unknown version", { version: 3, removeRequested: false, alpha1: "unseen", updated: null, browser: null }],
    ["version 0", { version: 0, removeRequested: false, alpha1: "unseen", updated: null }],
    ["a damaged flag in version 2", { version: 2, removeRequested: "yes", alpha1: "unseen", updated: null, browser: "chrome" }],
    ["bad alpha1", { version: 1, removeRequested: false, alpha1: "maybe", updated: null }],
    ["bad extension version", { version: 1, removeRequested: false, alpha1: "unseen", updated: { extensionVersion: "x", createdAt: "2026-11-16T09:00:00.000Z" } }],
    ["bad timestamp", { version: 1, removeRequested: false, alpha1: "unseen", updated: { extensionVersion: "0.4.0", createdAt: "yesterday" } }],
    ["extra updated field", { version: 1, removeRequested: false, alpha1: "unseen", updated: { extensionVersion: "0.4.0", createdAt: "2026-11-16T09:00:00.000Z", a: 1 } }],
  ])("rejects %s", (_name, value) => {
    expect(parseCollectorNoticeState(JSON.stringify(value))).toBeUndefined();
  });
});

describe("notice data", () => {
  it("uses the design 6.5 and 5 copy and stable command IDs", () => {
    const updated = buildUpdatedNotice("0.4.0", "2026-11-16T09:00:00.000Z");
    expect(updated.detail).toBe("ブラウザーの拡張機能の画面で MAGINALIA Collector の［更新］（↻）を押すか、ブラウザーを再起動すると反映されます。");
    expect(updated.actions.map((action) => action.label)).toEqual(["ブラウザーで拡張機能の画面を開く", "閉じる"]);
    expect(buildAlpha1MigrationNotice().title).toBe("ブラウザーで読んでいる Web ページの引用を、本棚に保存できるようになりました（MAGINALIA Collector）。");
    expect(buildAlpha1MigrationNotice().actions.map((action) => action.label)).toEqual(["設定する", "今はしない"]);
    expect(buildRepairNotice("damaged").actions[0]?.commandId).toBe("maginalia.collector.repair");
  });

  it("the remove-failed notice (decision 4) has the fixed title, says the automatic update is paused, and retries through the remove command", () => {
    const notice = buildRemoveFailedNotice();
    expect(notice.title).toBe("Collector 連携の解除に失敗しました");
    expect(notice.detail).toContain("Collector の自動更新は止まったまま");
    expect(notice.detail).toContain("解除を取りやめる");
    // the cancel button closes the notice once its command succeeded
    expect(notice.actions[1]?.closesNoticeId).toBe("collector.notice.remove-failed");
    expect(notice.actions.map((action) => [action.commandId, action.label])).toEqual([
      ["maginalia.collector.removeIntegration", "解除をやり直す…"],
      ["maginalia.collector.cancelRemove", "解除を取りやめる"],
      ["maginalia.collector.dismissNotice", "閉じる"],
    ]);
    // nothing about it is persisted: the state schema is unchanged (still version 2, same four-plus-one fields)
    expect(Object.keys(DEFAULT_COLLECTOR_NOTICE_STATE)).toEqual(["version", "removeRequested", "alpha1", "updated", "browser"]);
  });
});
