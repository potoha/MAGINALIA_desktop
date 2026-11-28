import * as path from "node:path";

/**
 * Schema of the machine-local `sync-remotes.json`. It maps a folder's `.magi`
 * UUID to its backup location. It never holds credentials: the token store is
 * a separate module, and unknown fields (including `token`) are rejected.
 */

export const SYNC_REMOTES_FILE_NAME = "sync-remotes.json";
export const SYNC_REMOTES_VERSION = 1;

export type SyncFolderKind = "project" | "workdesk" | "shelf";

export interface SyncRemoteEntry {
  /** UUID from the folder's `.magi` marker, lower-case. */
  readonly folderId: string;
  readonly kind: SyncFolderKind;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  /** Opaque hosting-service account ID (not a login name, not a secret). */
  readonly accountId: string;
  readonly lastSyncedCommit: string | null;
  /** UTC ISO 8601, e.g. 2026-11-29T10:00:00.000Z. */
  readonly lastSyncAt: string | null;
}

/** A stored entry plus the machine-local folder location it was registered at. */
export interface SyncRemoteRecord extends SyncRemoteEntry {
  /** Normalized absolute folder root (machine-local; never written into the folder). */
  readonly root: string;
}

export type SyncRemotesParseResult =
  | { readonly kind: "ok"; readonly records: readonly SyncRemoteRecord[] }
  | { readonly kind: "invalid"; readonly reason: "corrupt" | "unsupported-version" };

const MAX_FILE_CHARS = 1_000_000;
const ENTRY_KEYS = ["folderId", "kind", "host", "owner", "repo", "accountId", "lastSyncedCommit", "lastSyncAt"] as const;
const RECORD_KEYS = [...ENTRY_KEYS, "root"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSegment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT_PATTERN.test(value) && value !== "." && value !== "..";
}

function parseEntryFields(value: Record<string, unknown>): SyncRemoteEntry | undefined {
  const { folderId, kind, host, owner, repo, accountId, lastSyncedCommit, lastSyncAt } = value;
  if (typeof folderId !== "string" || !UUID_PATTERN.test(folderId.toLowerCase())) return undefined;
  if (kind !== "project" && kind !== "workdesk" && kind !== "shelf") return undefined;
  if (typeof host !== "string" || !HOST_PATTERN.test(host.toLowerCase())) return undefined;
  if (!isSegment(owner) || !isSegment(repo)) return undefined;
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) return undefined;
  if (lastSyncedCommit !== null && (typeof lastSyncedCommit !== "string" || !COMMIT_PATTERN.test(lastSyncedCommit))) return undefined;
  if (lastSyncAt !== null && (typeof lastSyncAt !== "string" || !TIMESTAMP_PATTERN.test(lastSyncAt) || Number.isNaN(Date.parse(lastSyncAt)))) {
    return undefined;
  }
  return Object.freeze({
    folderId: folderId.toLowerCase(),
    kind,
    host: host.toLowerCase(),
    owner,
    repo,
    accountId,
    lastSyncedCommit,
    lastSyncAt,
  });
}

/** Validate caller input. Missing, extra (e.g. `token`) or malformed fields give `undefined`. */
export function validateSyncRemoteEntry(value: unknown): SyncRemoteEntry | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) return undefined;
  return parseEntryFields(value);
}

/**
 * Parse file text. Anything doubtful is rejected as a whole: the caller must
 * not rewrite a file it could not understand.
 */
export function parseSyncRemotes(source: string): SyncRemotesParseResult {
  if (source.length > MAX_FILE_CHARS) return { kind: "invalid", reason: "corrupt" };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { kind: "invalid", reason: "corrupt" };
  }
  if (!isPlainRecord(value) || !Object.hasOwn(value, "version")) return { kind: "invalid", reason: "corrupt" };
  if (value.version !== SYNC_REMOTES_VERSION) return { kind: "invalid", reason: "unsupported-version" };
  if (!hasExactKeys(value, ["version", "remotes"]) || !Array.isArray(value.remotes)) return { kind: "invalid", reason: "corrupt" };

  const records: SyncRemoteRecord[] = [];
  const seen = new Set<string>();
  for (const item of value.remotes as unknown[]) {
    if (!isPlainRecord(item) || !hasExactKeys(item, RECORD_KEYS)) return { kind: "invalid", reason: "corrupt" };
    const entry = parseEntryFields(item);
    const root = item.root;
    if (entry === undefined || typeof root !== "string" || !path.isAbsolute(root) || seen.has(entry.folderId)) {
      return { kind: "invalid", reason: "corrupt" };
    }
    seen.add(entry.folderId);
    records.push(Object.freeze({ ...entry, root }));
  }
  return { kind: "ok", records: Object.freeze(records) };
}

export function serializeSyncRemotes(records: readonly SyncRemoteRecord[]): string {
  return `${JSON.stringify({ version: SYNC_REMOTES_VERSION, remotes: records.map((record) => ({ ...record })) }, null, 2)}\n`;
}
