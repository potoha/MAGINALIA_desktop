import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncRemoteRegistry, normalizeFolderRoot, type SyncRemoteEntry } from "./sync-remotes.js";

const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-sync-remotes-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRegistry(): Promise<{ registry: SyncRemoteRegistry; configDirectory: string; parent: string }> {
  const parent = await temporaryDirectory();
  const configDirectory = path.join(parent, "userData");
  return { registry: new SyncRemoteRegistry(configDirectory), configDirectory, parent };
}

function entry(overrides: Partial<Record<keyof SyncRemoteEntry, unknown>> = {}): unknown {
  return {
    folderId: FOLDER_ID,
    kind: "project",
    host: "github.com",
    owner: "example-owner",
    repo: "maginalia-project-11111111",
    accountId: "1234567",
    lastSyncedCommit: null,
    lastSyncAt: null,
    ...overrides,
  };
}

describe("SyncRemoteRegistry: storage", () => {
  it("treats a missing file as an empty registry", async () => {
    const { registry } = await createRegistry();
    expect(await registry.load()).toEqual({ kind: "loaded", records: [] });
    expect(await registry.resolveFolder(FOLDER_ID, path.join(os.tmpdir(), "x"))).toEqual({ kind: "unregistered" });
  });

  it("round-trips an entry through a fresh instance and writes a versioned file with the agreed fields only", async () => {
    const { registry, configDirectory } = await createRegistry();
    const root = path.join(configDirectory, "..", "研究", "卒論");
    const stored = entry({ lastSyncedCommit: COMMIT, lastSyncAt: "2026-11-29T10:00:00.000Z", kind: "workdesk" });
    expect(await registry.register(stored, root)).toEqual({ kind: "done" });

    const reopened = new SyncRemoteRegistry(configDirectory);
    const resolved = await reopened.resolveFolder(FOLDER_ID, root);
    expect(resolved).toEqual({ kind: "registered", entry: stored });

    const file = JSON.parse(await readFile(path.join(configDirectory, "sync-remotes.json"), "utf8")) as { version: number; remotes: Record<string, unknown>[] };
    expect(file.version).toBe(1);
    expect(Object.keys(file.remotes[0]!).sort()).toEqual(
      ["accountId", "folderId", "host", "kind", "lastSyncAt", "lastSyncedCommit", "owner", "repo", "root"],
    );
  });

  it("updates the entry for the same folder instead of duplicating it", async () => {
    const { registry } = await createRegistry();
    const root = path.join(os.tmpdir(), "folder-a");
    await registry.register(entry(), root);
    await registry.register(entry({ lastSyncedCommit: COMMIT, lastSyncAt: "2026-11-29T10:00:00Z" }), root);
    const loaded = await registry.load();
    expect(loaded.kind === "loaded" && loaded.records).toHaveLength(1);
    expect(loaded.kind === "loaded" && loaded.records[0]!.lastSyncedCommit).toBe(COMMIT);
  });

  it("keeps every write when many registrations run at once and leaves no temporary file", async () => {
    const { registry, configDirectory } = await createRegistry();
    const ids = Array.from({ length: 20 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const results = await Promise.all(ids.map((folderId, index) => registry.register(entry({ folderId }), path.join(os.tmpdir(), `folder-${index}`))));
    expect(results.every((result) => result.kind === "done")).toBe(true);
    const loaded = await registry.load();
    expect(loaded.kind === "loaded" && loaded.records.map((record) => record.folderId).sort()).toEqual([...ids].sort());
    expect(await readdir(configDirectory)).toEqual(["sync-remotes.json"]);
  });

  it("removes only the registered location's entry", async () => {
    const { registry } = await createRegistry();
    const root = path.join(os.tmpdir(), "folder-a");
    await registry.register(entry(), root);
    await registry.register(entry({ folderId: OTHER_ID }), path.join(os.tmpdir(), "folder-b"));
    expect(await registry.remove(FOLDER_ID, path.join(os.tmpdir(), "copy-of-a"))).toMatchObject({ kind: "needs-review" });
    expect(await registry.remove(FOLDER_ID, root)).toEqual({ kind: "done" });
    expect(await registry.remove(FOLDER_ID, root)).toEqual({ kind: "not-registered" });
    expect(await registry.resolveFolder(OTHER_ID, path.join(os.tmpdir(), "folder-b"))).toMatchObject({ kind: "registered" });
  });

  it("requires an absolute configuration directory and folder root", async () => {
    expect(() => new SyncRemoteRegistry("relative/dir")).toThrow();
    const { registry } = await createRegistry();
    expect(await registry.register(entry(), "relative/folder")).toEqual({ kind: "invalid-input" });
    expect(await registry.resolveFolder(FOLDER_ID, "relative/folder")).toEqual({ kind: "invalid-input" });
  });
});

describe("SyncRemoteRegistry: input validation", () => {
  const invalid: readonly (readonly [string, unknown])[] = [
    ["a token field", { ...(entry() as object), token: "gho_secret" }],
    ["a missing field", (({ accountId: _removed, ...rest }) => rest)(entry() as Record<string, unknown>)],
    ["a non-UUID folderId", entry({ folderId: "not-a-uuid" })],
    ["an unknown kind", entry({ kind: "library" })],
    ["a URL as host", entry({ host: "https://github.com" })],
    ["a host with a path", entry({ host: "github.com/owner" })],
    ["a path separator in owner", entry({ owner: "a/b" })],
    ["a parent segment as repo", entry({ repo: ".." })],
    ["an email as accountId", entry({ accountId: "someone@example.com" })],
    ["a short commit", entry({ lastSyncedCommit: "abc123" })],
    ["a non-ISO timestamp", entry({ lastSyncAt: "yesterday" })],
    ["an impossible date", entry({ lastSyncAt: "2026-13-45T10:00:00Z" })],
    ["February 31st", entry({ lastSyncAt: "2026-02-31T10:00:00Z" })],
    ["hour 24", entry({ lastSyncAt: "2026-11-29T24:00:00Z" })],
    ["a non-object", "text"],
    ["null", null],
  ];

  it.each(invalid)("rejects %s and writes nothing", async (_name, value) => {
    const { registry, configDirectory } = await createRegistry();
    expect(await registry.register(value, path.join(os.tmpdir(), "folder-a"))).toEqual({ kind: "invalid-input" });
    expect(await registry.load()).toEqual({ kind: "loaded", records: [] });
    await expect(readFile(path.join(configDirectory, "sync-remotes.json"))).rejects.toThrow();
  });
});

describe("SyncRemoteRegistry: damaged files", () => {
  const record = { ...(entry() as object), root: path.join(os.tmpdir(), "folder-a") };
  const damaged: readonly (readonly [string, string, string])[] = [
    ["not JSON", "{ nope", "corrupt"],
    ["empty file", "", "corrupt"],
    ["a JSON array", "[]", "corrupt"],
    ["no version", JSON.stringify({ remotes: [] }), "corrupt"],
    ["an unknown version", JSON.stringify({ version: 2, remotes: [] }), "unsupported-version"],
    ["a string version", JSON.stringify({ version: "1", remotes: [] }), "unsupported-version"],
    ["remotes not an array", JSON.stringify({ version: 1, remotes: {} }), "corrupt"],
    ["an extra top-level key", JSON.stringify({ version: 1, remotes: [], token: "x" }), "corrupt"],
    ["an extra key in a record", JSON.stringify({ version: 1, remotes: [{ ...record, token: "x" }] }), "corrupt"],
    ["a record missing root", JSON.stringify({ version: 1, remotes: [{ ...record, root: undefined }] }), "corrupt"],
    ["a relative root", JSON.stringify({ version: 1, remotes: [{ ...record, root: "relative" }] }), "corrupt"],
    ["a root that is not normalized", JSON.stringify({ version: 1, remotes: [{ ...record, root: `${record.root}${path.sep}sub${path.sep}..` }] }), "corrupt"],
    ["a duplicate folderId", JSON.stringify({ version: 1, remotes: [record, record] }), "corrupt"],
    ["a record with a bad host", JSON.stringify({ version: 1, remotes: [{ ...record, host: "a b" }] }), "corrupt"],
  ];

  it.each(damaged)("reports %s without throwing, and never overwrites it", async (_name, text, code) => {
    const { registry, configDirectory } = await createRegistry();
    await mkdir(configDirectory, { recursive: true });
    const file = path.join(configDirectory, "sync-remotes.json");
    await writeFile(file, text, "utf8");

    expect(await registry.load()).toEqual({ kind: "error", code });
    expect(await registry.resolveFolder(FOLDER_ID, path.join(os.tmpdir(), "folder-a"))).toEqual({ kind: "error", code });
    expect(await registry.register(entry(), path.join(os.tmpdir(), "folder-a"))).toEqual({ kind: "error", code });
    expect(await registry.remove(FOLDER_ID, path.join(os.tmpdir(), "folder-a"))).toEqual({ kind: "error", code });
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("reports a directory in place of the file as unreadable", async () => {
    const { registry, configDirectory } = await createRegistry();
    await mkdir(path.join(configDirectory, "sync-remotes.json"), { recursive: true });
    expect(await registry.load()).toEqual({ kind: "error", code: "unreadable" });
  });
});

describe("SyncRemoteRegistry: same UUID in another place (copied folder)", () => {
  it("never hands the remote to a different location and reports where it is registered", async () => {
    const { registry, parent } = await createRegistry();
    const original = path.join(parent, "研究資料", "卒論");
    const copy = path.join(parent, "研究資料", "卒論 のコピー");
    await registry.register(entry(), original);

    expect(await registry.resolveFolder(FOLDER_ID, original)).toMatchObject({ kind: "registered" });
    expect(await registry.resolveFolder(FOLDER_ID, copy)).toEqual({
      kind: "needs-review",
      reason: "same-id-elsewhere",
      recordedRoot: normalizeFolderRoot(original),
    });
  });

  it("refuses to register the same UUID at a second location and keeps the first registration", async () => {
    const { registry, parent } = await createRegistry();
    const original = path.join(parent, "a");
    const copy = path.join(parent, "b");
    await registry.register(entry(), original);
    expect(await registry.register(entry({ repo: "other-repo" }), copy)).toMatchObject({ kind: "needs-review", recordedRoot: original });
    const resolved = await registry.resolveFolder(FOLDER_ID, original);
    expect(resolved.kind === "registered" && resolved.entry.repo).toBe("maginalia-project-11111111");
  });

  it("moves the registration to the new location only after an explicit confirmation", async () => {
    const { registry, parent } = await createRegistry();
    const before = path.join(parent, "before");
    const after = path.join(parent, "after");
    await registry.register(entry(), before);
    expect(await registry.confirmRelocation(FOLDER_ID, after)).toEqual({ kind: "done" });
    expect(await registry.resolveFolder(FOLDER_ID, after)).toMatchObject({ kind: "registered" });
    expect(await registry.resolveFolder(FOLDER_ID, before)).toMatchObject({ kind: "needs-review" });
    expect(await registry.confirmRelocation(OTHER_ID, after)).toEqual({ kind: "not-registered" });
  });

  it("matches the same Japanese folder written in NFC or NFD, and a UUID in upper case", async () => {
    const { registry, parent } = await createRegistry();
    const nfc = path.join(parent, "がくもん".normalize("NFC"));
    const nfd = path.join(parent, "がくもん".normalize("NFD"));
    expect(nfc).not.toBe(nfd);
    await registry.register(entry(), nfc);
    expect(await registry.resolveFolder(FOLDER_ID.toUpperCase(), nfd)).toMatchObject({ kind: "registered" });
  });

  it("ignores a trailing separator and dot segments in the root", async () => {
    const { registry, parent } = await createRegistry();
    const root = path.join(parent, "folder");
    await registry.register(entry(), root);
    expect(await registry.resolveFolder(FOLDER_ID, `${root}${path.sep}`)).toMatchObject({ kind: "registered" });
    expect(await registry.resolveFolder(FOLDER_ID, path.join(root, "sub", ".."))).toMatchObject({ kind: "registered" });
  });

  it.runIf(process.platform === "win32")("treats Windows paths that differ only in case as the same folder", async () => {
    const { registry, parent } = await createRegistry();
    const root = path.join(parent, "Folder");
    await registry.register(entry(), root);
    expect(await registry.resolveFolder(FOLDER_ID, root.toUpperCase())).toMatchObject({ kind: "registered" });
  });
});

describe("SyncRemoteRegistry: file handling details", () => {
  it("accepts a file that starts with a UTF-8 BOM (saved by Notepad)", async () => {
    const { registry, configDirectory } = await createRegistry();
    const root = path.join(os.tmpdir(), "folder-a");
    await registry.register(entry(), root);
    const file = path.join(configDirectory, "sync-remotes.json");
    await writeFile(file, `﻿${await readFile(file, "utf8")}`, "utf8");
    expect(await registry.resolveFolder(FOLDER_ID, root)).toMatchObject({ kind: "registered" });
  });

  it("serializes writes across instances that point at the same directory", async () => {
    const { configDirectory } = await createRegistry();
    const first = new SyncRemoteRegistry(configDirectory);
    const second = new SyncRemoteRegistry(configDirectory);
    const ids = Array.from({ length: 20 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await Promise.all(ids.map((folderId, index) => (index % 2 === 0 ? first : second).register(entry({ folderId }), path.join(os.tmpdir(), `folder-${index}`))));
    const loaded = await first.load();
    expect(loaded.kind === "loaded" && loaded.records).toHaveLength(20);
  });

  it("round-trips a valid timestamp and rejects a root without a drive on Windows", async () => {
    const { registry } = await createRegistry();
    expect(await registry.register(entry({ lastSyncAt: "2028-02-29T23:59:59.999Z" }), path.join(os.tmpdir(), "leap"))).toEqual({ kind: "done" });
    if (process.platform === "win32") {
      expect(normalizeFolderRoot("\foo")).toBeUndefined();
      expect(await registry.register(entry(), "\foo")).toEqual({ kind: "invalid-input" });
    }
  });
});
