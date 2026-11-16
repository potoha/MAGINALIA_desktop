import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAlpha1MigrationNotice,
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
    const state = { version: 1 as const, removeRequested: true, alpha1: "shown" as const, updated: { extensionVersion: "0.4.0", createdAt: "2026-11-16T09:00:00.000Z" } };
    await store.write(state);
    expect(await store.read()).toEqual(state);
    expect(await readdir(path.dirname(file))).toEqual(["collector-notices.json"]);
    expect(await readFile(file, "utf8")).not.toMatch(/[A-Za-z]:\\/u);
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
    ["wrong version", { version: 2, removeRequested: false, alpha1: "unseen", updated: null }],
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
    expect(updated.detail).toBe("Chrome の拡張機能の画面で MAGINALIA Collector の［更新］（↻）を押すか、Chrome を再起動すると反映されます。");
    expect(updated.actions.map((action) => action.label)).toEqual(["Chrome で拡張機能の画面を開く", "閉じる"]);
    expect(buildAlpha1MigrationNotice().title).toBe("Chrome で読んでいる Web ページの引用を、本棚に保存できるようになりました（MAGINALIA Collector）。");
    expect(buildAlpha1MigrationNotice().actions.map((action) => action.label)).toEqual(["設定する", "今はしない"]);
    expect(buildRepairNotice("damaged").actions[0]?.commandId).toBe("maginalia.collector.repair");
  });
});
