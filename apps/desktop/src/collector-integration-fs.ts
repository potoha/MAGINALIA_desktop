/**
 * Product implementation of the read-only `CollectorIntegrationFileSystem`.
 *
 * It imports only read primitives (`lstat`, `open` for reading, `createReadStream`). It
 * takes whatever absolute path the inspection computed from native known folders and fixed
 * names; it chooses no location itself. A source-scan test pins that no write API is used.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { CollectorFileEntry, CollectorFileRead, CollectorIntegrationFileSystem } from "./collector-integration-types.js";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function createNodeCollectorIntegrationFileSystem(): CollectorIntegrationFileSystem {
  return Object.freeze({
    async stat(target: string): Promise<CollectorFileEntry | null> {
      try {
        const info = await lstat(target);
        // libuv reports symbolic links and junctions as symbolic links; neither is followed.
        const reparse = info.isSymbolicLink();
        const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
        return Object.freeze({ kind, isReparsePoint: reparse, size: info.size });
      } catch (error: unknown) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async readSmallFile(target: string, maxBytes: number): Promise<CollectorFileRead> {
      let handle;
      try {
        handle = await open(target, "r");
      } catch (error: unknown) {
        if (isMissing(error)) return { kind: "missing" };
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Not a regular file.");
        if (info.size > maxBytes) return { kind: "too-large" };
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        return { kind: "ok", bytes: new Uint8Array(buffer.subarray(0, offset)) };
      } finally {
        await handle.close();
      }
    },

    async sha256File(target: string): Promise<string | null> {
      try {
        const info = await lstat(target);
        if (!info.isFile()) return null;
      } catch (error: unknown) {
        if (isMissing(error)) return null;
        throw error;
      }
      const hash = createHash("sha256");
      try {
        for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
      } catch (error: unknown) {
        if (isMissing(error)) return null;
        throw error;
      }
      return hash.digest("hex");
    },
  });
}
