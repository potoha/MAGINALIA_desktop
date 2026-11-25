import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCollectorSaveDestination,
  collectorSaveDestinationConfirmationText,
  configureCollectorSaveDestination,
  type CollectorSaveDestinationConfirmation,
  type CollectorSaveDestinationDependencies,
  type CollectorSaveDestinationNotice,
} from "./collector-save-destination";
import { createShelfBindingFileStore, removeShelfBindingFile } from "./shelf-binding-store";
import { parseShelfBindingJson } from "./shelf-binding";
import {
  FIXTURE_SHELF_ID,
  OTHER_SHELF_ID,
  createCollectorFixture,
  fakeSafeInspector,
  type CollectorFixture,
} from "./collector-host-fixture.test-helper";

let fixture: CollectorFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

function harness(current: CollectorFixture, answers: boolean[] = [true], inspect: (target: string) => unknown = fakeSafeInspector) {
  const confirmations: CollectorSaveDestinationConfirmation[] = [];
  const notices: CollectorSaveDestinationNotice[] = [];
  const dependencies: CollectorSaveDestinationDependencies = {
    shelfLocationPath: current.shelfLocationPath,
    storagePaths: current.storage,
    store: createShelfBindingFileStore(current.storage.bindingDirectory),
    inspectPathSecurity: inspect,
    removeBinding: () => removeShelfBindingFile(current.storage.bindingDirectory),
    confirm: async (request) => { confirmations.push(request); return answers.shift() ?? false; },
    notify: async (notice) => { notices.push(notice); },
  };
  return { dependencies, confirmations, notices };
}

async function storedBinding(current: CollectorFixture) {
  const parsed = parseShelfBindingJson(await readFile(current.storage.bindingPath, "utf8"));
  if (parsed.kind === "error") throw new Error(parsed.code);
  return parsed.binding;
}

describe("maginalia.collector.configureSaveDestination", () => {
  it("shows the configured Shelf by name, asks once, then writes generation 1 atomically", async () => {
    fixture = await createCollectorFixture();
    const { dependencies, confirmations, notices } = harness(fixture);
    expect(await configureCollectorSaveDestination(dependencies)).toEqual({ kind: "configured", writesEnabled: true });
    expect(confirmations).toEqual([{ kind: "configure", shelfName: "研究棚" }]);
    expect(notices.at(-1)).toMatchObject({ type: "info", message: "Collector の保存先を「研究棚」に設定しました。" });
    expect(await storedBinding(fixture)).toMatchObject({ expectedShelfId: FIXTURE_SHELF_ID, generation: 1, shelfLocationPath: fixture.shelfLocationPath });
    expect(await readdir(fixture.storage.bindingDirectory)).toEqual(["private-shelf-binding.json"]);
    expect(JSON.stringify(notices).includes(fixture.temp)).toBe(false);

    // A second run leaves the binding unchanged and does not ask again.
    const again = harness(fixture);
    expect(await configureCollectorSaveDestination(again.dependencies)).toEqual({ kind: "already-configured", writesEnabled: true });
    expect(again.confirmations).toEqual([]);
    expect((await storedBinding(fixture)).generation).toBe(1);
  });

  it("does not write when the user declines", async () => {
    fixture = await createCollectorFixture();
    const { dependencies, notices } = harness(fixture, [false]);
    expect(await configureCollectorSaveDestination(dependencies)).toEqual({ kind: "cancelled" });
    expect(notices).toEqual([]);
    await expect(lstat(fixture.storage.bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("asks to replace a binding for another Shelf identity and increments the generation", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding({ shelfId: OTHER_SHELF_ID });
    const { dependencies, confirmations } = harness(fixture);
    expect(await configureCollectorSaveDestination(dependencies)).toEqual({ kind: "configured", writesEnabled: true });
    expect(confirmations).toEqual([{ kind: "replace", shelfName: "研究棚" }]);
    expect(await storedBinding(fixture)).toMatchObject({ expectedShelfId: FIXTURE_SHELF_ID, generation: 2 });
  });

  it("refuses invalid or conflicting markers, unset Shelves and corrupt bindings without writing", async () => {
    fixture = await createCollectorFixture();
    const marker = path.join(fixture.shelfRoot, "名前変更.magi");
    await writeFile(path.join(fixture.shelfRoot, "conflict.magi"), `version = 1\ntype = shelf\nid = ${OTHER_SHELF_ID}\n`);
    let run = harness(fixture);
    expect(await configureCollectorSaveDestination(run.dependencies)).toEqual({ kind: "error" });
    expect(run.confirmations).toEqual([]);
    expect(run.notices[0]).toMatchObject({ type: "error", message: "本棚の識別マーカーを確認できません。" });
    await unlink(path.join(fixture.shelfRoot, "conflict.magi"));

    await unlink(marker);
    run = harness(fixture);
    expect(await configureCollectorSaveDestination(run.dependencies)).toEqual({ kind: "error" });
    await writeFile(marker, `version = 1\ntype = shelf\nid = ${FIXTURE_SHELF_ID}\n`);

    const location = await readFile(fixture.shelfLocationPath, "utf8");
    await writeFile(fixture.shelfLocationPath, "version: 1\nprivate_shelf:\n  registry: null\npublic_shelf:\n  registry: null\n");
    run = harness(fixture);
    expect(await configureCollectorSaveDestination(run.dependencies)).toEqual({ kind: "error" });
    expect(run.notices[0]).toMatchObject({ message: "Private Shelf が設定されていません。" });
    await writeFile(fixture.shelfLocationPath, location);
    await expect(lstat(fixture.storage.bindingPath)).rejects.toMatchObject({ code: "ENOENT" });

    await fixture.writeBinding();
    await writeFile(fixture.storage.bindingPath, "not json");
    run = harness(fixture);
    expect(await configureCollectorSaveDestination(run.dependencies)).toEqual({ kind: "error" });
    expect(run.confirmations).toEqual([]);
    expect(await readFile(fixture.storage.bindingPath, "utf8")).toBe("not json");
  });

  it("refuses a marker that changes during confirmation", async () => {
    fixture = await createCollectorFixture();
    const current = fixture;
    const run = harness(current);
    const confirm = run.dependencies.confirm;
    const dependencies = {
      ...run.dependencies,
      confirm: async (request: CollectorSaveDestinationConfirmation) => {
        await writeFile(path.join(current.shelfRoot, "名前変更.magi"), `version = 1\ntype = shelf\nid = ${OTHER_SHELF_ID}\n`);
        return confirm(request);
      },
    };
    expect(await configureCollectorSaveDestination(dependencies)).toEqual({ kind: "error" });
    expect(run.notices.at(-1)).toMatchObject({ type: "error", message: "Collector の保存先を設定できませんでした。" });
    await expect(lstat(current.storage.bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports that writes stay disabled when the integration folders fail the ACL check", async () => {
    fixture = await createCollectorFixture();
    const { dependencies, notices } = harness(fixture, [true], () => ({ exists: true, isDirectory: true, isReparsePoint: true, ownerSid: "S-1-5-18", currentUserSid: "S-1-5-18", daclPresent: true, aces: [] }));
    expect(await configureCollectorSaveDestination(dependencies)).toEqual({ kind: "configured", writesEnabled: false });
    expect(notices.at(-1)).toMatchObject({ type: "warning" });
  });
});

describe("maginalia.collector.clearSaveDestination", () => {
  it("removes only the binding file after confirmation", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding();
    const shelfBefore = (await readdir(fixture.shelfRoot)).sort();
    let run = harness(fixture, [false]);
    expect(await clearCollectorSaveDestination(run.dependencies)).toEqual({ kind: "cancelled" });
    expect((await lstat(fixture.storage.bindingPath)).isFile()).toBe(true);

    run = harness(fixture, [true]);
    expect(await clearCollectorSaveDestination(run.dependencies)).toEqual({ kind: "cleared" });
    expect(run.confirmations).toEqual([{ kind: "clear" }]);
    await expect(lstat(fixture.storage.bindingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(fixture.storage.bindingDirectory)).isDirectory()).toBe(true);
    expect((await readdir(fixture.shelfRoot)).sort()).toEqual(shelfBefore);

    run = harness(fixture, [true]);
    expect(await clearCollectorSaveDestination(run.dependencies)).toEqual({ kind: "not-configured" });
    expect(run.confirmations).toEqual([]);
  });

  it("can clear a corrupt binding (it is not a repair) but never a non-regular entry", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding();
    await writeFile(fixture.storage.bindingPath, "corrupt");
    expect(await clearCollectorSaveDestination(harness(fixture, [true]).dependencies)).toEqual({ kind: "cleared" });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(fixture.storage.bindingPath);
    const run = harness(fixture, [true]);
    expect(await clearCollectorSaveDestination(run.dependencies)).toEqual({ kind: "error" });
    expect((await lstat(fixture.storage.bindingPath)).isDirectory()).toBe(true);
  });
});

describe("Japanese confirmation text", () => {
  it("uses the approved confirmation question", () => {
    expect(collectorSaveDestinationConfirmationText({ kind: "configure", shelfName: "研究棚" }).message)
      .toBe("Collector の保存先をこの本棚に設定しますか？");
    expect(collectorSaveDestinationConfirmationText({ kind: "clear" }).detail).toContain("削除・変更されません");
  });
});
