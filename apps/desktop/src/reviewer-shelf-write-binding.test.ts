import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseShelfBindingJson } from "./shelf-binding.js";
import { createShelfBindingFileStore, resolveShelfBindingStoragePaths } from "./shelf-binding-store.js";
import { resolveReviewerShelfWriteCoordination, type ReviewerShelfBindingContext } from "./reviewer-shelf-write-binding.js";

const marker = { version: 1, type: "shelf", id: "11111111-2222-4333-8444-555555555555" } as const;
const context: ReviewerShelfBindingContext = {
  shelfName: "Research Shelf",
  shelfRoot: "D:\\Research\\Private Shelf",
  shelfLocationPath: "C:\\Users\\Researcher\\AppData\\Roaming\\MAGINALIA\\shelf_location.yml",
  privateShelfLocator: "D:\\Research\\Private Shelf",
  typedMarker: marker,
};

describe("Reviewer write binding", () => {
  test("requires explicit confirmation once, then reuses the per-user binding after relogin", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "maginalia-reviewer-binding-"));
    try {
      const profileRoot = await realpath(profile);
      const storagePaths = resolveShelfBindingStoragePaths("C:\\Users\\Researcher\\AppData\\Local\\Temp\\");
      const store = createShelfBindingFileStore(path.join(profileRoot, "Local", "MAGINALIA", "integration"));
      const confirmRebind = vi.fn(async () => true);
      const options = {
        context,
        storagePaths,
        store,
        confirmRebind,
        reloadConfiguration: async () => context.privateShelfLocator,
        reloadTypedMarker: async () => marker,
      };
      const first = await resolveReviewerShelfWriteCoordination(options);
      expect(first).toEqual({ expectedShelfId: marker.id, coordinationRoot: storagePaths.coordinationRoot });
      expect(confirmRebind).toHaveBeenCalledOnce();

      const second = await resolveReviewerShelfWriteCoordination(options);
      expect(second).toEqual(first);
      expect(confirmRebind).toHaveBeenCalledOnce();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  test("requires reconfirmation after the configured locator changes and increments the descriptor generation", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "maginalia-reviewer-binding-move-"));
    try {
      const profileRoot = await realpath(profile);
      const storagePaths = resolveShelfBindingStoragePaths("C:\\Users\\Researcher\\AppData\\Local\\Temp\\");
      const store = createShelfBindingFileStore(path.join(profileRoot, "Local", "MAGINALIA", "integration"));
      const confirmRebind = vi.fn(async () => true);
      await resolveReviewerShelfWriteCoordination({
        context,
        storagePaths,
        store,
        confirmRebind,
        reloadConfiguration: async () => context.privateShelfLocator,
        reloadTypedMarker: async () => marker,
      });

      const moved = { ...context, privateShelfLocator: "E:\\Research\\Moved Shelf", shelfRoot: "E:\\Research\\Moved Shelf" };
      const coordination = await resolveReviewerShelfWriteCoordination({
        context: moved,
        storagePaths,
        store,
        confirmRebind,
        reloadConfiguration: async () => moved.privateShelfLocator,
        reloadTypedMarker: async () => marker,
      });
      expect(coordination.expectedShelfId).toBe(marker.id);
      expect(confirmRebind).toHaveBeenCalledTimes(2);
      const raw = await store.readBindingText();
      expect(raw).not.toBeNull();
      expect(parseShelfBindingJson(raw)).toMatchObject({ kind: "valid", binding: { generation: 2 } });
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  test("fails closed when confirmation is declined or the descriptor is corrupt", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "maginalia-reviewer-binding-fail-"));
    try {
      const profileRoot = await realpath(profile);
      const storagePaths = resolveShelfBindingStoragePaths("C:\\Users\\Researcher\\AppData\\Local\\Temp\\");
      const directory = path.join(profileRoot, "Local", "MAGINALIA", "integration");
      const store = createShelfBindingFileStore(directory);
      await expect(resolveReviewerShelfWriteCoordination({
        context,
        storagePaths,
        store,
        confirmRebind: async () => false,
        reloadConfiguration: async () => context.privateShelfLocator,
        reloadTypedMarker: async () => marker,
      })).rejects.toThrow("declined");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "private-shelf-binding.json"), "{broken", "utf8");
      const confirm = vi.fn(async () => true);
      await expect(resolveReviewerShelfWriteCoordination({
        context,
        storagePaths,
        store,
        confirmRebind: confirm,
        reloadConfiguration: async () => context.privateShelfLocator,
        reloadTypedMarker: async () => marker,
      })).rejects.toThrow("invalid or unsupported");
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
