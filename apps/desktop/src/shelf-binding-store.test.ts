import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { createShelfBindingFromConfirmedSelection, persistShelfBinding, readShelfBinding, serializeShelfBinding } from "./shelf-binding.js";
import { createShelfBindingFileStore, resolveShelfBindingStoragePaths } from "./shelf-binding-store.js";

const shelfLocationPath = "C:\\Users\\Researcher\\AppData\\Roaming\\MAGINALIA\\shelf_location.yml";
const privateShelfLocator = "D:\\Research\\Private Shelf";
const shelfId = "11111111-2222-4333-8444-555555555555";

function confirmed(generation = 1) {
  const result = createShelfBindingFromConfirmedSelection({
    shelfLocationPath,
    privateShelfLocator,
    confirmedMarker: { version: 1, type: "shelf", id: shelfId },
    generation,
  });
  if (result.kind === "error") throw new Error(result.code);
  return result.binding;
}

describe("fixed per-user Shelf binding storage", () => {
  test("derives one descriptor and coordination root from the OS LocalAppData path", () => {
    expect(resolveShelfBindingStoragePaths("C:\\Users\\Researcher\\AppData\\Local")).toEqual({
      localAppData: "C:\\Users\\Researcher\\AppData\\Local",
      bindingDirectory: "C:\\Users\\Researcher\\AppData\\Local\\MAGINALIA\\integration",
      bindingPath: "C:\\Users\\Researcher\\AppData\\Local\\MAGINALIA\\integration\\private-shelf-binding.json",
      coordinationRoot: "C:\\Users\\Researcher\\AppData\\Local\\MAGINALIA\\coordination",
    });
    expect(() => resolveShelfBindingStoragePaths("\\\\server\\share\\AppData\\Local")).toThrow();
    expect(() => resolveShelfBindingStoragePaths("C:\\Users\\Researcher\\AppData\\Local\\..\\Roaming")).toThrow();
    expect(() => resolveShelfBindingStoragePaths("LocalAppData")).toThrow();
  });

  test("creates and atomically replaces the descriptor only at the expected generation", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "maginalia-shelf-binding-"));
    try {
      const profileRoot = await realpath(profile);
      const store = createShelfBindingFileStore(path.join(profileRoot, "Local", "MAGINALIA", "integration"));
      expect(await readShelfBinding(store)).toEqual({ kind: "error", code: "binding-missing" });

      expect(await persistShelfBinding(store, confirmed(), null)).toEqual({ kind: "valid", binding: confirmed() });
      expect(await readShelfBinding(store)).toEqual({ kind: "valid", binding: confirmed() });
      const firstText = await readFile(path.join(profileRoot, "Local", "MAGINALIA", "integration", "private-shelf-binding.json"), "utf8");
      expect(firstText).toBe(serializeShelfBinding(confirmed()));

      const next = { ...confirmed(2), expectedShelfId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
      expect(await persistShelfBinding(store, next, 1)).toEqual({ kind: "valid", binding: next });
      expect(await persistShelfBinding(store, { ...next, generation: 3 }, 1)).toEqual({ kind: "error", code: "binding-generation-conflict" });
      expect(await readShelfBinding(store)).toEqual({ kind: "valid", binding: next });
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  test("does not replace a symbolic-link binding file", async () => {
    if (process.platform === "win32") return;
    const profile = await mkdtemp(path.join(os.tmpdir(), "maginalia-shelf-binding-link-"));
    try {
      const directory = path.join(profile, "integration");
      await import("node:fs/promises").then(({ mkdir, symlink }) => mkdir(directory, { recursive: true }).then(() => symlink(path.join(profile, "outside"), path.join(directory, "private-shelf-binding.json"))));
      const store = createShelfBindingFileStore(directory);
      await expect(store.readBindingText()).rejects.toThrow("unsafe");
      await expect(store.replaceBindingAtomically(serializeShelfBinding(confirmed()), null)).rejects.toThrow("unsafe");
      expect(await readFile(path.join(directory, "private-shelf-binding.json"), "utf8").catch(() => "link" )).toBe("link");
      await writeFile(path.join(profile, "outside"), "preserved", "utf8");
      expect(await readFile(path.join(profile, "outside"), "utf8")).toBe("preserved");
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
