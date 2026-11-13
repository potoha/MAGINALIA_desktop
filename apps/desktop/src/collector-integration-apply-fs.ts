/**
 * Product implementation of `CollectorApplyFileSystem` (WP-5b). Thin on purpose: every
 * decision (which path, which order, what to verify) lives in `collector-integration-apply.ts`.
 * This adapter chooses no location, follows no link, deletes only the single entry it is
 * given, and throws only `CollectorFileSystemError` (fixed message, no path).
 *
 * `createPrivateDirectory` is injected: the composition root passes the native
 * `createNativePrivateDirectory` (owner-only protected DACL); tests pass a `mkdir` stand-in.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import * as path from "node:path";
import { createNodeCollectorIntegrationFileSystem } from "./collector-integration-fs.js";
import {
  CollectorFileSystemError,
  type CollectorApplyFileSystem,
  type CollectorCopyResult,
  type CollectorDirectoryEntry,
  type CollectorFileSystemErrorCode,
} from "./collector-integration-apply-types.js";

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function translate(error: unknown): CollectorFileSystemError {
  if (error instanceof CollectorFileSystemError) return error;
  const code = codeOf(error);
  let mapped: CollectorFileSystemErrorCode = "failed";
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ETXTBSY") mapped = "locked";
  else if (code === "EEXIST") mapped = "exists";
  else if (code === "ENOENT" || code === "ENOTDIR") mapped = "missing";
  else if (code === "ENOTEMPTY") mapped = "not-empty";
  return new CollectorFileSystemError(mapped);
}

async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    throw translate(error);
  }
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export interface NodeCollectorApplyFileSystemOptions {
  /** Owner-only protected-DACL directory creation (native helper in production). */
  readonly createPrivateDirectory: (target: string) => "created" | "exists" | Promise<"created" | "exists">;
}

export function createNodeCollectorApplyFileSystem(options: NodeCollectorApplyFileSystemOptions): CollectorApplyFileSystem {
  const readOnly = createNodeCollectorIntegrationFileSystem();
  return Object.freeze({
    stat: (target: string) => guarded(() => readOnly.stat(target)),
    readSmallFile: (target: string, maxBytes: number) => guarded(() => readOnly.readSmallFile(target, maxBytes)),
    sha256File: (target: string) => guarded(() => readOnly.sha256File(target)),

    listDirectory: (target: string) => guarded(async (): Promise<readonly CollectorDirectoryEntry[] | null> => {
      let names: string[];
      try {
        names = await readdir(target);
      } catch (error: unknown) {
        if (codeOf(error) === "ENOENT") return null;
        throw error;
      }
      const entries: CollectorDirectoryEntry[] = [];
      for (const name of names) {
        const info = await lstatOrNull(path.join(target, name));
        if (info === null) continue; // vanished between readdir and lstat
        entries.push(Object.freeze({
          name,
          kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
          isReparsePoint: info.isSymbolicLink(),
          size: info.size,
          mtimeMs: info.mtimeMs,
        } as const));
      }
      return Object.freeze(entries);
    }),

    makeDirectory: (target: string) => guarded(async () => {
      try {
        await mkdir(target);
        return "created" as const;
      } catch (error: unknown) {
        if (codeOf(error) === "EEXIST") return "exists" as const;
        throw error;
      }
    }),

    createPrivateDirectory: (target: string) => guarded(async () => options.createPrivateDirectory(target)),

    writeFileExclusive: (target: string, bytes: Uint8Array) => guarded(async () => {
      const handle = await open(target, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }),

    copyFileExclusive: (source: string, destination: string) => guarded(async (): Promise<CollectorCopyResult> => {
      const before = await lstat(source);
      // A link or non-regular source is never copied (design 8.3: no reparse points).
      if (before.isSymbolicLink() || !before.isFile()) throw new CollectorFileSystemError("failed");
      const input = await open(source, "r");
      let output;
      try {
        const opened = await input.stat();
        output = await open(destination, "wx");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          // Hash exactly the bytes handed to the destination.
          hash.update(chunk);
          await output.write(chunk);
          total += bytesRead;
        }
        await output.sync();
        const after = await input.stat();
        const pathAfter = await lstatOrNull(source);
        const sourceChanged = after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || total !== opened.size
          || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
          || pathAfter === null || pathAfter.isSymbolicLink() || pathAfter.ino !== before.ino || pathAfter.mtimeMs !== before.mtimeMs;
        return Object.freeze({ sha256: hash.digest("hex"), size: total, sourceChanged });
      } finally {
        await output?.close();
        await input.close();
      }
    }),

    renameFile: (from: string, to: string, renameOptions: { readonly replace: boolean }) => guarded(async () => {
      if (!renameOptions.replace && (await lstatOrNull(to)) !== null) throw new CollectorFileSystemError("exists");
      const source = await lstat(from);
      if (source.isSymbolicLink() || !source.isFile()) throw new CollectorFileSystemError("failed");
      await rename(from, to);
    }),

    renameDirectory: (from: string, to: string) => guarded(async () => {
      if ((await lstatOrNull(to)) !== null) throw new CollectorFileSystemError("exists");
      const source = await lstat(from);
      if (source.isSymbolicLink() || !source.isDirectory()) throw new CollectorFileSystemError("failed");
      await rename(from, to);
    }),

    removeFile: (target: string) => guarded(async () => {
      const info = await lstatOrNull(target);
      if (info === null) return "missing" as const;
      if (info.isSymbolicLink() || !info.isFile()) throw new CollectorFileSystemError("failed");
      await unlink(target);
      return "removed" as const;
    }),

    removeEmptyDirectory: (target: string) => guarded(async () => {
      const info = await lstatOrNull(target);
      if (info === null) return "missing" as const;
      if (info.isSymbolicLink() || !info.isDirectory()) throw new CollectorFileSystemError("failed");
      await rmdir(target); // never recursive
      return "removed" as const;
    }),
  });
}
