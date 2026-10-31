/**
 * Main-process publication primitives shared by every approved Private Shelf
 * writer.
 *
 * This module owns no workflow policy and no Shelf format of its own: it is the
 * single implementation of "publish a Shelf v0.4 record without replacing user
 * data" and "reuse an existing compatible Book" that the Reviewer materializer
 * and any future cross-process coordinator both use. Adding a second copy of
 * these rules anywhere else would fork the Shelf write contract.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import * as path from "node:path";
import type {
  ShelfBookV04,
  ShelfSourceFileV04,
  ShelfSourceKind
} from "@maginalia/format" with { "resolution-mode": "import" };

export const SHELF_LIBRARY_FILENAME = "library.json";
export const SHELF_BOOKS_DIRECTORY = "books";
export const SHELF_ANNOTATIONS_DIRECTORY = "annotations";

export function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Reject configured child directories that could escape the Shelf root.
 * `library.json` may only carry a relative, non-traversing subdirectory.
 */
export function resolveConfiguredShelfDirectory(root: string, value: unknown, fallback: string): string | null {
  const part = typeof value === "string" ? value : fallback;
  if (part.length === 0 || part.includes("\0") || path.isAbsolute(part)
    || /^[A-Za-z]:/u.test(part) || /^(?:[\\/]{1,2})/u.test(part)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(part)) return null;
  const resolved = path.resolve(root, part);
  return isInsideDirectory(root, resolved) ? resolved : null;
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST";
}

export async function ensureShelfDirectory(root: string, directory: string): Promise<boolean> {
  if (!isInsideDirectory(root, directory)) return false;
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    try { await mkdir(current); } catch (error: unknown) { if (!isExists(error)) return false; }
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const canonical = await realpath(current);
      if (!isInsideDirectory(root, canonical)) return false;
    } catch { return false; }
  }
  return true;
}

export type ShelfPublishState = "written" | "same" | "conflict";

/**
 * Publish a new Shelf file without ever replacing an existing one.
 *
 * The bytes are written and fsynced to a unique temporary file, then hard-linked
 * into place. A hard link fails with EEXIST when the destination exists, so two
 * writers can never overwrite each other; the loser compares bytes and reports
 * "same" or "conflict". The temporary file is always removed.
 */
export async function publishShelfFileNoReplace(target: string, contents: Uint8Array): Promise<ShelfPublishState> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
      return "written";
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) return "conflict";
        const current = await readFile(target);
        return Buffer.from(current).equals(Buffer.from(contents)) ? "same" : "conflict";
      } catch { return "conflict"; }
    }
  } finally {
    try { await unlink(temporary); } catch { /* The link is already removed or moved. */ }
  }
}

export interface ResolvedShelfDirectories {
  readonly booksDirectory: string;
  readonly annotationsDirectory: string;
}

export type ShelfDirectoryResolution =
  | { readonly kind: "ok"; readonly directories: ResolvedShelfDirectories }
  | { readonly kind: "library-unreadable" }
  | { readonly kind: "library-invalid" }
  | { readonly kind: "paths-invalid" }
  | { readonly kind: "paths-unsafe" };

/**
 * Read `library.json` and resolve the record directories it configures.
 *
 * This is strictly read-only: no file or directory is created, so a caller can
 * validate identity and path overlap before touching the filesystem.
 */
export async function readShelfDirectoryConfig(root: string): Promise<ShelfDirectoryResolution> {
  let library: unknown;
  try {
    library = JSON.parse(await readFile(path.join(root, SHELF_LIBRARY_FILENAME), "utf8"));
  } catch {
    return { kind: "library-unreadable" };
  }
  if (library === null || typeof library !== "object" || Array.isArray(library)) return { kind: "library-invalid" };
  const config = library as { booksPath?: unknown; annotationsPath?: unknown };
  const booksDirectory = resolveConfiguredShelfDirectory(root, config.booksPath, SHELF_BOOKS_DIRECTORY);
  const annotationsDirectory = resolveConfiguredShelfDirectory(root, config.annotationsPath, SHELF_ANNOTATIONS_DIRECTORY);
  if (booksDirectory === null || annotationsDirectory === null) return { kind: "paths-invalid" };
  return { kind: "ok", directories: Object.freeze({ booksDirectory, annotationsDirectory }) };
}

/**
 * Resolve the record directories and make sure they exist.
 * Callers that must not mutate the Shelf before validation use
 * `readShelfDirectoryConfig` first and call this only afterwards.
 */
export async function resolveShelfDirectories(root: string): Promise<ShelfDirectoryResolution> {
  const config = await readShelfDirectoryConfig(root);
  if (config.kind !== "ok") return config;
  const { booksDirectory, annotationsDirectory } = config.directories;
  if (!await ensureShelfDirectory(root, booksDirectory) || !await ensureShelfDirectory(root, annotationsDirectory)) {
    return { kind: "paths-unsafe" };
  }
  return config;
}

export function isMissingFileError(error: unknown): boolean {
  return isMissingFile(error);
}

/** Enumerate Shelf record files, never following symlinks or reparse points. */
export async function listShelfRecordFiles(root: string, directory: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) continue;
        const canonical = await realpath(candidate);
        if (!isInsideDirectory(root, canonical)) continue;
        if (info.isDirectory()) pending.push(candidate);
        else if (info.isFile() && [".json", ".yaml", ".yml"].includes(path.extname(entry.name).toLowerCase())) output.push(candidate);
      } catch { /* Malformed/unreadable Shelf entries remain untouched. */ }
    }
  }
  return output;
}

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });

export async function readExistingShelfBooks(directory: string, format: FormatCore): Promise<ShelfBookV04[]> {
  const books: ShelfBookV04[] = [];
  for (const filename of await listShelfRecordFiles(directory, directory)) {
    try {
      const validated = format.parseShelfEntity("book", await readFile(filename, "utf8"));
      if (validated.valid && validated.value.version === "0.4") books.push(validated.value);
    } catch { /* Unknown or malformed files remain untouched. */ }
  }
  return books;
}

/** The subset of a write request that decides Book identity. */
export interface ShelfBookLocator {
  readonly sourceKind: ShelfSourceKind;
  readonly isbn13?: string;
  readonly url?: string;
  readonly sourceFiles: readonly ShelfSourceFileV04[];
}

export type ShelfBookMatch =
  | { readonly kind: "new" }
  | { readonly kind: "match"; readonly book: ShelfBookV04 }
  | { readonly kind: "conflict" };

function fileDigests(book: ShelfBookV04): readonly string[] {
  return Object.freeze((book.source.files ?? []).map((file) => `${file.mediaType}:${file.sha256}`).sort());
}

function hasLocatorOverlap(candidate: ShelfBookLocator, book: ShelfBookV04): boolean {
  if (candidate.isbn13 !== undefined && candidate.isbn13 === book.isbn13) return true;
  if (candidate.url !== undefined && candidate.url === book.url) return true;
  const existingHashes = new Set(fileDigests(book));
  return candidate.sourceFiles.some((file) => existingHashes.has(`${file.mediaType}:${file.sha256}`));
}

function booksAreCompatible(candidate: ShelfBookLocator, book: ShelfBookV04): boolean {
  if (candidate.sourceKind !== book.source.kind) return false;
  if (candidate.isbn13 !== undefined && book.isbn13 !== undefined && candidate.isbn13 !== book.isbn13) return false;
  if (candidate.url !== undefined && book.url !== undefined && candidate.url !== book.url) return false;
  const requested = candidate.sourceFiles.map((file) => `${file.mediaType}:${file.sha256}`).sort();
  const existing = [...fileDigests(book)];
  if (requested.length > 0 && existing.length > 0 && requested.join("\n") !== existing.join("\n")) return false;
  if (requested.length > 0 && existing.length === 0) return false;
  return true;
}

/**
 * Locate the single existing Book a request belongs to.
 *
 * A locator (URL/ISBN/source digest) is never sufficient on its own: the
 * candidate must also be compatible. More than one overlapping Book is a
 * conflict rather than an arbitrary choice, so a web URL that acquired two
 * distinct records is never silently merged.
 */
export function matchShelfBook(candidate: ShelfBookLocator, books: readonly ShelfBookV04[]): ShelfBookMatch {
  const matches: ShelfBookV04[] = [];
  for (const book of books) {
    if (!hasLocatorOverlap(candidate, book)) continue;
    if (!booksAreCompatible(candidate, book)) return { kind: "conflict" };
    matches.push(book);
  }
  if (matches.length > 1) return { kind: "conflict" };
  return matches.length === 0 ? { kind: "new" } : { kind: "match", book: matches[0]! };
}

export function shelfRecordFilename(id: string): string {
  return `${id.replace(":", "-")}.json`;
}

export function shelfBookFilename(book: ShelfBookV04): string {
  return shelfRecordFilename(book.id);
}

export function serializeShelfRecord(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
