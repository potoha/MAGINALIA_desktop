/** Disposable fixtures for Collector binding / Host tests. Never touches the real profile. */
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { createShelfBindingFromConfirmedSelection, persistShelfBinding } from "./shelf-binding.js";
import { createShelfBindingFileStore, resolveShelfBindingStoragePaths, type ShelfBindingStoragePaths } from "./shelf-binding-store.js";
import type { PathSecurityFacts } from "./collector-path-security.js";

export const FIXTURE_SHELF_ID = "750e8400-e29b-41d4-a716-446655440000";
export const OTHER_SHELF_ID = "850e8400-e29b-41d4-a716-446655440000";
export const CURRENT_USER_SID = "S-1-5-21-1-2-3-1001";

export interface CollectorFixture {
  readonly temp: string;
  readonly localAppData: string;
  readonly storage: ShelfBindingStoragePaths;
  readonly shelfRoot: string;
  readonly shelfLocationPath: string;
  writeBinding(options?: { readonly shelfId?: string; readonly locator?: string; readonly generation?: number }): Promise<void>;
  cleanup(): Promise<void>;
}

/** Safe facts for every path: owned by the current user, only trusted writers. */
export function safeFacts(isDirectory: boolean): PathSecurityFacts {
  return {
    exists: true,
    isDirectory,
    isReparsePoint: false,
    ownerSid: CURRENT_USER_SID,
    currentUserSid: CURRENT_USER_SID,
    daclPresent: true,
    aces: [
      { type: "allow", sid: CURRENT_USER_SID, mask: 0x1f01ff, inheritOnly: false },
      { type: "allow", sid: "S-1-5-18", mask: 0x1f01ff, inheritOnly: false },
      { type: "allow", sid: "S-1-5-32-544", mask: 0x1f01ff, inheritOnly: false },
    ],
  };
}

/** A fake inspector that reports real existence/type with safe ACL facts. */
export function fakeSafeInspector(target: string): PathSecurityFacts {
  try {
    const info = lstatSync(target);
    return safeFacts(info.isDirectory());
  } catch {
    return { exists: false };
  }
}

export async function createCollectorFixture(options: {
  readonly createDirectory?: (directory: string) => Promise<void>;
  readonly prepareLocalAppData?: (directory: string) => Promise<void>;
} = {}): Promise<CollectorFixture> {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "collector-binding-日本語-")));
  const localAppData = path.join(temp, "Local");
  if (options.prepareLocalAppData) await options.prepareLocalAppData(localAppData);
  else await mkdir(localAppData);
  const storage = resolveShelfBindingStoragePaths(localAppData);
  const shelfRoot = path.join(temp, "本棚");
  await mkdir(path.join(shelfRoot, "books"), { recursive: true });
  await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
  await writeFile(path.join(shelfRoot, "名前変更.magi"), `version = 1\ntype = shelf\nid = ${FIXTURE_SHELF_ID}\n`);
  await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({ type: "library", version: "0.1", name: "研究棚" }));
  const roaming = path.join(temp, "Roaming");
  await mkdir(roaming);
  const shelfLocationPath = path.join(roaming, "shelf_location.yml");
  await writeFile(shelfLocationPath, `version: 1\nprivate_shelf:\n  registry: ${JSON.stringify(shelfRoot)}\npublic_shelf:\n  registry: null\n`);
  const store = createShelfBindingFileStore(storage.bindingDirectory, options.createDirectory ? { createDirectory: options.createDirectory } : {});
  return {
    temp,
    localAppData,
    storage,
    shelfRoot,
    shelfLocationPath,
    async writeBinding(binding = {}) {
      const generation = binding.generation ?? 1;
      const created = createShelfBindingFromConfirmedSelection({
        shelfLocationPath,
        privateShelfLocator: binding.locator ?? shelfRoot,
        confirmedMarker: { version: 1, type: "shelf", id: binding.shelfId ?? FIXTURE_SHELF_ID },
        generation,
      });
      if (created.kind === "error") throw new Error(created.code);
      const current = await store.readBindingText();
      const previous = current === null ? null : (JSON.parse(current) as { generation: number }).generation;
      const stored = await persistShelfBinding(store, { ...created.binding, generation: previous === null ? 1 : previous + 1 }, previous);
      if (stored.kind === "error") throw new Error(stored.code);
    },
    cleanup: () => rm(temp, { recursive: true, force: true }),
  };
}
