import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCollectorShelfConfiguration } from "./collector-shelf-configuration";
import { createNativePrivateDirectory, inspectNativePathSecurity, nativeShelfMutexAvailable } from "./shelf-native-mutex";
import {
  FIXTURE_SHELF_ID,
  OTHER_SHELF_ID,
  createCollectorFixture,
  fakeSafeInspector,
  safeFacts,
  type CollectorFixture,
} from "./collector-host-fixture.test-helper";

let fixture: CollectorFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

function dependencies(current: CollectorFixture, inspect: (target: string) => unknown = fakeSafeInspector) {
  return { resolveLocalAppDataPath: () => current.localAppData, inspectPathSecurity: inspect };
}

describe("read-only Collector Shelf configuration", () => {
  it("is valid only for an existing, strict, matching binding and returns no extra data", async () => {
    fixture = await createCollectorFixture();
    await fixture.writeBinding();
    const result = await readCollectorShelfConfiguration(dependencies(fixture));
    expect(result).toEqual({
      kind: "valid",
      binding: expect.objectContaining({ expectedShelfId: FIXTURE_SHELF_ID, generation: 1 }),
      shelf: { root: fixture.shelfRoot, id: FIXTURE_SHELF_ID, name: "研究棚" },
      coordinationRoot: fixture.storage.coordinationRoot,
    });
  });

  it("maps every fail-closed state to the Collector error vocabulary", async () => {
    fixture = await createCollectorFixture();
    const current = fixture;
    const read = () => readCollectorShelfConfiguration(dependencies(current));

    // Missing binding (and absent MAGINALIA directory).
    expect(await read()).toEqual({ kind: "error", code: "shelf_unconfigured" });
    expect(await readCollectorShelfConfiguration({ ...dependencies(current), resolveLocalAppDataPath: () => "relative" }))
      .toEqual({ kind: "error", code: "configuration_unavailable" });
    expect(await readCollectorShelfConfiguration({ ...dependencies(current), resolveLocalAppDataPath: () => { throw new Error("no addon"); } }))
      .toEqual({ kind: "error", code: "configuration_unavailable" });

    // Corrupt binding.
    await current.writeBinding();
    await writeFile(current.storage.bindingPath, "{\"version\":1}");
    expect(await read()).toEqual({ kind: "error", code: "configuration_unavailable" });
    await unlink(current.storage.bindingPath);

    // ACL failure.
    await current.writeBinding();
    const unsafe = (target: string): unknown => target === current.storage.bindingPath
      ? { ...safeFacts(false), ownerSid: "S-1-5-32-544" }
      : fakeSafeInspector(target);
    expect(await readCollectorShelfConfiguration(dependencies(current, unsafe))).toEqual({ kind: "error", code: "configuration_unavailable" });
    expect(await readCollectorShelfConfiguration(dependencies(current, () => { throw new Error("denied"); })))
      .toEqual({ kind: "error", code: "configuration_unavailable" });

    // Marker UUID mismatch.
    await current.writeBinding({ shelfId: OTHER_SHELF_ID });
    expect(await read()).toEqual({ kind: "error", code: "shelf_identity_mismatch" });
    await current.writeBinding();
    expect((await read()).kind).toBe("valid");

    // Locator changed since the binding was confirmed.
    await current.writeBinding({ locator: path.join(current.temp, "旧本棚") });
    expect(await read()).toEqual({ kind: "error", code: "configuration_unavailable" });
    await current.writeBinding();

    // Marker missing, conflicting, corrupt.
    const marker = path.join(current.shelfRoot, "名前変更.magi");
    await unlink(marker);
    expect(await read()).toEqual({ kind: "error", code: "shelf_identity_unavailable" });
    await writeFile(marker, "version = 1\ntype = shelf\nid = not-a-uuid\n");
    expect(await read()).toEqual({ kind: "error", code: "shelf_identity_unavailable" });
    await writeFile(marker, `version = 1\ntype = shelf\nid = ${FIXTURE_SHELF_ID}\n`);
    await writeFile(path.join(current.shelfRoot, "conflict.magi"), `version = 1\ntype = shelf\nid = ${OTHER_SHELF_ID}\n`);
    expect(await read()).toEqual({ kind: "error", code: "shelf_identity_unavailable" });
    await unlink(path.join(current.shelfRoot, "conflict.magi"));

    // Invalid library.json; missing Shelf folder.
    await writeFile(path.join(current.shelfRoot, "library.json"), "{\"type\":\"library\"}");
    expect(await read()).toEqual({ kind: "error", code: "shelf_unavailable" });
    await rm(current.shelfRoot, { recursive: true, force: true });
    expect(await read()).toEqual({ kind: "error", code: "shelf_unavailable" });

    // shelf_location.yml unreadable / Private Shelf unset.
    await writeFile(current.shelfLocationPath, "version: [");
    expect(await read()).toEqual({ kind: "error", code: "configuration_unavailable" });
    await writeFile(current.shelfLocationPath, "version: 1\nprivate_shelf:\n  registry: null\npublic_shelf:\n  registry: null\n");
    expect(await read()).toEqual({ kind: "error", code: "shelf_unconfigured" });
  });

  it("never creates the integration or coordination directories while reading", async () => {
    fixture = await createCollectorFixture();
    expect(await readCollectorShelfConfiguration(dependencies(fixture))).toEqual({ kind: "error", code: "shelf_unconfigured" });
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(path.join(fixture.localAppData, "MAGINALIA"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const native = process.platform === "win32" && nativeShelfMutexAvailable();

describe.skipIf(!native)("read-only Collector Shelf configuration with the real ACL addon", () => {
  it("accepts integration directories created with the protected private DACL", async () => {
    fixture = await createCollectorFixture({
      createDirectory: async (directory) => { createNativePrivateDirectory(directory); },
    });
    await fixture.writeBinding();
    const result = await readCollectorShelfConfiguration(dependencies(fixture, inspectNativePathSecurity));
    expect(result.kind).toBe("valid");
    await mkdir(fixture.storage.coordinationRoot);
    expect((await readCollectorShelfConfiguration(dependencies(fixture, inspectNativePathSecurity))).kind).toBe("valid");
  });
});
