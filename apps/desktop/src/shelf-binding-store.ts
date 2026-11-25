import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type { SecureShelfBindingPersistenceAdapter } from "./shelf-binding.js";

const BINDING_DIRECTORY = "integration";
const APPLICATION_DIRECTORY = "MAGINALIA";
const COORDINATION_DIRECTORY = "coordination";
const BINDING_FILE = "private-shelf-binding.json";
const MAX_BINDING_BYTES = 16 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ShelfBindingStoragePaths {
  readonly localAppData: string;
  readonly bindingDirectory: string;
  readonly bindingPath: string;
  readonly coordinationRoot: string;
}

/**
 * The input comes directly from the native Windows known-folder API. Reject
 * non-local, relative, device and non-canonical paths instead of guessing from
 * environment variables, cwd, install location, or searching.
 */
export function resolveShelfBindingStoragePaths(localAppDataPath: string): ShelfBindingStoragePaths {
  if (typeof localAppDataPath !== "string" || localAppDataPath.length === 0
    || localAppDataPath.startsWith("\\\\") || localAppDataPath.startsWith("\\\\?\\")
    || !/^[A-Za-z]:\\/u.test(localAppDataPath)
    || path.win32.normalize(localAppDataPath.replace(/[\\/]+$/u, "")) !== localAppDataPath.replace(/[\\/]+$/u, "")) {
    throw new Error("The Windows per-user local application-data location is unavailable or unsupported.");
  }
  const localAppData = localAppDataPath.replace(/[\\/]+$/u, "");
  const applicationRoot = path.win32.join(localAppData, APPLICATION_DIRECTORY);
  const bindingDirectory = path.win32.join(applicationRoot, BINDING_DIRECTORY);
  return Object.freeze({
    localAppData,
    bindingDirectory,
    bindingPath: path.win32.join(bindingDirectory, BINDING_FILE),
    coordinationRoot: path.win32.join(applicationRoot, COORDINATION_DIRECTORY),
  });
}

async function assertExistingDirectoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The Shelf binding directory contains an unsafe path component.");
    }
    if (path.resolve(await realpath(current)) !== path.resolve(current)) {
      throw new Error("The Shelf binding directory resolves through a reparse point.");
    }
  }
}

/**
 * Creates one missing directory component. Product Desktop injects the native
 * protected-DACL creator; tests and non-Windows builds use plain `mkdir`.
 */
export type ShelfBindingDirectoryCreator = (directory: string) => Promise<void>;

async function defaultCreateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory); } catch (createError: unknown) {
    if (createError === null || typeof createError !== "object" || !("code" in createError)
      || (createError as { readonly code?: unknown }).code !== "EEXIST") throw createError;
  }
}

async function ensureSafeDirectoryChain(
  directory: string,
  createDirectory: ShelfBindingDirectoryCreator = defaultCreateDirectory,
): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await lstat(current);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      await createDirectory(current);
    }
    let info;
    try { info = await lstat(current); } catch { throw new Error("The Shelf binding directory could not be opened."); }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The Shelf binding directory contains an unsafe path component.");
    }
    if (path.resolve(await realpath(current)) !== path.resolve(current)) {
      throw new Error("The Shelf binding directory resolves through a reparse point.");
    }
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOTDIR";
}

async function readBoundedBinding(file: string): Promise<string | null> {
  let before;
  try { before = await lstat(file); } catch (error: unknown) {
    if (isMissing(error) || isNotDirectory(error)) return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BINDING_BYTES) {
    throw new Error("The Shelf binding file is unsafe or exceeds its size limit.");
  }
  const handle = await open(file, "r");
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error("The Shelf binding changed while it was read.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== before.size || bytes.byteLength > MAX_BINDING_BYTES) {
      throw new Error("The Shelf binding changed while it was read.");
    }
    return decoder.decode(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Fixed-root store for the main process. Production passes paths derived only
 * from the native Windows LocalAppData known folder; tests may inject a
 * disposable directory. The directory inherits the current user's LocalAppData
 * ACL and all existing path components are checked before use.
 */
export interface ShelfBindingFileStoreOptions {
  /** Creates missing directory components (defaults to plain `mkdir`). */
  readonly createDirectory?: ShelfBindingDirectoryCreator;
}

export function createShelfBindingFileStore(
  bindingDirectory: string,
  options: ShelfBindingFileStoreOptions = {},
): SecureShelfBindingPersistenceAdapter {
  const directory = path.resolve(bindingDirectory);
  const file = path.join(directory, BINDING_FILE);
  const createDirectory = options.createDirectory ?? defaultCreateDirectory;

  return Object.freeze({
    async readBindingText(): Promise<string | null> {
      await assertExistingDirectoryChain(directory);
      return readBoundedBinding(file);
    },

    async replaceBindingAtomically(serializedBinding: string, expectedGeneration: number | null): Promise<void> {
      if (Buffer.byteLength(serializedBinding, "utf8") > MAX_BINDING_BYTES) {
        throw new Error("The Shelf binding is too large.");
      }
      await ensureSafeDirectoryChain(directory, createDirectory);
      // Single-writer limitation (#87 P1): this generation check and the recheck
      // below are not a cross-process compare-and-swap. Two Desktop processes can both
      // pass them and the later rename wins. Accepted for alpha because only an explicit
      // Desktop UI action writes the binding; see docs/collector-host-binding.md.
      const current = await readBoundedBinding(file);
      const currentGeneration = current === null ? null : bindingGeneration(current);
      if (currentGeneration !== expectedGeneration) throw new Error("The Shelf binding generation changed.");

      const temporary = path.join(directory, `.${BINDING_FILE}.${randomUUID()}.tmp`);
      let created = false;
      try {
        const handle = await open(temporary, "wx", 0o600);
        created = true;
        try {
          await handle.writeFile(serializedBinding, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Recheck before replacement; this guards ordinary path changes without
        // claiming protection against a malicious same-user filesystem writer.
        await assertExistingDirectoryChain(directory);
        if ((await readBoundedBinding(file)) !== current) throw new Error("The Shelf binding changed during its update.");
        await rename(temporary, file);
        created = false;
      } finally {
        if (created) await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      }
    },
  });
}

/**
 * Remove only the binding descriptor (explicit Desktop "clear" action). The Shelf,
 * its journal, the coordination directory and the binding directory itself are never
 * touched. Returns false when there was no descriptor. A non-regular entry or an
 * unsafe directory chain is refused instead of being followed.
 */
export async function removeShelfBindingFile(bindingDirectory: string): Promise<boolean> {
  const directory = path.resolve(bindingDirectory);
  const file = path.join(directory, BINDING_FILE);
  await assertExistingDirectoryChain(directory);
  let info;
  try { info = await lstat(file); } catch (error: unknown) {
    if (isMissing(error) || isNotDirectory(error)) return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("The Shelf binding entry is not a regular file; refusing to remove it.");
  }
  try {
    await unlink(file);
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
  return true;
}

function bindingGeneration(text: string): number {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error("The existing Shelf binding is corrupt."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || !("generation" in parsed) || typeof parsed.generation !== "number"
    || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1) {
    throw new Error("The existing Shelf binding generation is invalid.");
  }
  return parsed.generation;
}
