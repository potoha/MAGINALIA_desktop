import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import {
  SYNC_REMOTES_FILE_NAME,
  parseSyncRemotes,
  serializeSyncRemotes,
  validateSyncRemoteEntry,
  type SyncRemoteEntry,
  type SyncRemoteRecord,
} from "./sync-remotes-schema.js";

export { SYNC_REMOTES_FILE_NAME } from "./sync-remotes-schema.js";
export type { SyncFolderKind, SyncRemoteEntry, SyncRemoteRecord } from "./sync-remotes-schema.js";

export type SyncRemotesErrorCode = "unreadable" | "corrupt" | "unsupported-version" | "write-failed";

/**
 * A folder with this UUID is already registered at another location (a copy,
 * or a moved folder). Nothing is attached to the new location until a person
 * confirms; the recorded location is returned so the UI can explain.
 */
export interface SameIdElsewhere {
  readonly kind: "needs-review";
  readonly reason: "same-id-elsewhere";
  readonly recordedRoot: string;
}

export type SyncRemotesLoadResult =
  | { readonly kind: "loaded"; readonly records: readonly SyncRemoteRecord[] }
  | { readonly kind: "error"; readonly code: Exclude<SyncRemotesErrorCode, "write-failed"> };

export type FolderRemoteResolution =
  | { readonly kind: "unregistered" }
  | { readonly kind: "registered"; readonly entry: SyncRemoteEntry }
  | SameIdElsewhere
  | { readonly kind: "invalid-input" }
  | { readonly kind: "error"; readonly code: Exclude<SyncRemotesErrorCode, "write-failed"> };

export type SyncRemotesMutationResult =
  | { readonly kind: "done" }
  | { readonly kind: "not-registered" }
  | SameIdElsewhere
  | { readonly kind: "invalid-input" }
  | { readonly kind: "error"; readonly code: SyncRemotesErrorCode };

/**
 * Normalize a folder root for storage: absolute, resolved, Unicode NFC (macOS
 * hands out NFD names). Callers pass the canonical root they already use for
 * folder identity; no filesystem access happens here.
 */
export function normalizeFolderRoot(root: string): string | undefined {
  if (typeof root !== "string" || root === "" || !path.isAbsolute(root)) return undefined;
  return path.resolve(root).normalize("NFC");
}

/** Comparison key for two normalized roots. Windows paths are case-insensitive. */
function rootKey(normalizedRoot: string): string {
  return process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code?: unknown }).code) : undefined;
}

/**
 * Machine-local map from a folder's `.magi` UUID to its backup location, kept
 * in `sync-remotes.json` under an application-owned directory. The directory
 * is injected so this module never depends on Electron. Nothing is ever
 * written into a user folder or its `.git/config`.
 */
export class SyncRemoteRegistry {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(configDirectory: string) {
    if (!path.isAbsolute(configDirectory)) {
      throw new Error(`Sync configuration directory must be absolute: ${configDirectory}`);
    }
    this.filePath = path.join(path.resolve(configDirectory), SYNC_REMOTES_FILE_NAME);
  }

  public get configurationPath(): string {
    return this.filePath;
  }

  /** A missing file is an empty registry. A damaged file is reported, never replaced. */
  public async load(): Promise<SyncRemotesLoadResult> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      return errorCode(error) === "ENOENT"
        ? Object.freeze({ kind: "loaded", records: Object.freeze([]) })
        : Object.freeze({ kind: "error", code: "unreadable" });
    }
    const parsed = parseSyncRemotes(source);
    return parsed.kind === "ok"
      ? Object.freeze({ kind: "loaded", records: parsed.records })
      : Object.freeze({ kind: "error", code: parsed.reason });
  }

  /**
   * Look up the backup location for the folder found at `root`. A registration
   * is returned only for the location it was made at; the same UUID anywhere
   * else (a copied folder) yields `needs-review` and no remote.
   */
  public async resolveFolder(folderId: string, root: string): Promise<FolderRemoteResolution> {
    const normalized = normalizeFolderRoot(root);
    const id = typeof folderId === "string" ? folderId.toLowerCase() : "";
    if (normalized === undefined || id === "") return Object.freeze({ kind: "invalid-input" });
    const loaded = await this.load();
    if (loaded.kind === "error") return Object.freeze(loaded);
    const record = loaded.records.find((candidate) => candidate.folderId === id);
    if (record === undefined) return Object.freeze({ kind: "unregistered" });
    if (rootKey(record.root) !== rootKey(normalized)) {
      return Object.freeze({ kind: "needs-review", reason: "same-id-elsewhere", recordedRoot: record.root });
    }
    const { root: _root, ...entry } = record;
    return Object.freeze({ kind: "registered", entry: Object.freeze(entry) });
  }

  /** Add or update the entry for the folder at `root`. Refuses a UUID registered at another location. */
  public register(entry: unknown, root: string): Promise<SyncRemotesMutationResult> {
    const valid = validateSyncRemoteEntry(entry);
    const normalized = normalizeFolderRoot(root);
    if (valid === undefined || normalized === undefined) return Promise.resolve(Object.freeze({ kind: "invalid-input" }));
    return this.mutate((records) => {
      const existing = records.find((record) => record.folderId === valid.folderId);
      if (existing !== undefined && rootKey(existing.root) !== rootKey(normalized)) {
        return { result: { kind: "needs-review", reason: "same-id-elsewhere", recordedRoot: existing.root } };
      }
      const next: SyncRemoteRecord = Object.freeze({ ...valid, root: normalized });
      return { result: { kind: "done" }, records: [...records.filter((record) => record !== existing), next] };
    });
  }

  /** Remove the entry (disconnect). Only the registered location may do so. */
  public remove(folderId: string, root: string): Promise<SyncRemotesMutationResult> {
    const normalized = normalizeFolderRoot(root);
    const id = typeof folderId === "string" ? folderId.toLowerCase() : "";
    if (normalized === undefined || id === "") return Promise.resolve(Object.freeze({ kind: "invalid-input" }));
    return this.mutate((records) => {
      const existing = records.find((record) => record.folderId === id);
      if (existing === undefined) return { result: { kind: "not-registered" } };
      if (rootKey(existing.root) !== rootKey(normalized)) {
        return { result: { kind: "needs-review", reason: "same-id-elsewhere", recordedRoot: existing.root } };
      }
      return { result: { kind: "done" }, records: records.filter((record) => record !== existing) };
    });
  }

  /** After a person confirms the folder was moved: point the existing entry at its new location. */
  public confirmRelocation(folderId: string, newRoot: string): Promise<SyncRemotesMutationResult> {
    const normalized = normalizeFolderRoot(newRoot);
    const id = typeof folderId === "string" ? folderId.toLowerCase() : "";
    if (normalized === undefined || id === "") return Promise.resolve(Object.freeze({ kind: "invalid-input" }));
    return this.mutate((records) => {
      const existing = records.find((record) => record.folderId === id);
      if (existing === undefined) return { result: { kind: "not-registered" } };
      const moved: SyncRemoteRecord = Object.freeze({ ...existing, root: normalized });
      return { result: { kind: "done" }, records: records.map((record) => (record === existing ? moved : record)) };
    });
  }

  /** Serialized read-modify-write. `records` is omitted when nothing should be written. */
  private mutate(
    change: (records: readonly SyncRemoteRecord[]) => { readonly result: SyncRemotesMutationResult; readonly records?: readonly SyncRemoteRecord[] },
  ): Promise<SyncRemotesMutationResult> {
    const run = async (): Promise<SyncRemotesMutationResult> => {
      const loaded = await this.load();
      if (loaded.kind === "error") return Object.freeze({ kind: "error", code: loaded.code });
      const { result, records } = change(loaded.records);
      if (records === undefined) return Object.freeze(result);
      try {
        await this.writeAtomically(serializeSyncRemotes(records));
      } catch {
        return Object.freeze({ kind: "error", code: "write-failed" });
      }
      return Object.freeze(result);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Write a temporary file in the same directory, flush it, then rename over the target. */
  private async writeAtomically(text: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
