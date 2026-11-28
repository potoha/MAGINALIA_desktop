import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncRemoteRegistry } from "./sync-remotes.js";

const FOLDER_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "example-owner";
const REPO = "maginalia-shelf-33333333";
const ACCOUNT_ID = "98765432";
const COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A folder with a marker, ordinary portable files and a local Git directory, all neutral. */
async function createFolder(parent: string, name: string): Promise<string> {
  const root = path.join(parent, name);
  await mkdir(path.join(root, "notes"), { recursive: true });
  await mkdir(path.join(root, ".git", "refs"), { recursive: true });
  await writeFile(path.join(root, "shelf.magi"), `# MAGINALIA\nversion = 1\ntype = shelf\nid = ${FOLDER_ID}\n`, "utf8");
  await writeFile(path.join(root, "library.json"), JSON.stringify({ name: "私の本棚", books: [] }), "utf8");
  await writeFile(path.join(root, "README.md"), "# 私の本棚\n", "utf8");
  await writeFile(path.join(root, "notes", "メモ.md"), "本文です。\n", "utf8");
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n", "utf8");
  return root;
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) await walk(full);
      else files.set(path.relative(root, full), await readFile(full, "utf8"));
    }
  };
  await walk(root);
  return files;
}

describe("portable / machine-local boundary", () => {
  it("never writes into the folder and leaves no path, account, remote URL or token in any folder file", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "maginalia-sync-portable-"));
    temporaryDirectories.push(parent);
    const configDirectory = path.join(parent, "userData");
    const root = await createFolder(parent, "卒論・引用棚");
    const registry = new SyncRemoteRegistry(configDirectory);
    const before = await snapshot(root);

    await registry.register(
      { folderId: FOLDER_ID, kind: "shelf", host: "github.com", owner: OWNER, repo: REPO, accountId: ACCOUNT_ID, lastSyncedCommit: COMMIT, lastSyncAt: "2026-11-29T10:00:00.000Z" },
      root,
    );
    await registry.resolveFolder(FOLDER_ID, root);
    await registry.confirmRelocation(FOLDER_ID, root);

    const after = await snapshot(root);
    expect(after).toEqual(before);

    const forbidden = [
      root,
      root.replaceAll("\\", "/"),
      parent,
      configDirectory,
      "github.com",
      OWNER,
      REPO,
      ACCOUNT_ID,
      COMMIT,
      "https://",
      "http://",
      "[remote",
      "url =",
      "token",
      "gho_",
    ];
    for (const [file, text] of after) {
      for (const value of forbidden) expect(text, `${file} must not contain ${value}`).not.toContain(value);
    }

    // The registry lives outside the folder, and the only place the values appear.
    expect(path.relative(root, configDirectory).startsWith("..")).toBe(true);
    const registryText = await readFile(path.join(configDirectory, "sync-remotes.json"), "utf8");
    expect(registryText).toContain(REPO);
    expect(registryText.toLowerCase()).not.toContain("token");
  });

  it("does not carry the connection to a copied folder, even though the copy has the same UUID", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "maginalia-sync-copy-"));
    temporaryDirectories.push(parent);
    const registry = new SyncRemoteRegistry(path.join(parent, "userData"));
    const original = await createFolder(parent, "原本フォルダ");
    const copy = path.join(parent, "原本フォルダ のコピー");
    await registry.register(
      { folderId: FOLDER_ID, kind: "shelf", host: "github.com", owner: OWNER, repo: REPO, accountId: ACCOUNT_ID, lastSyncedCommit: null, lastSyncAt: null },
      original,
    );

    await cp(original, copy, { recursive: true });
    const marker = await readFile(path.join(copy, "shelf.magi"), "utf8");
    expect(marker).toContain(FOLDER_ID);

    const resolved = await registry.resolveFolder(FOLDER_ID, copy);
    expect(resolved.kind).toBe("needs-review");
    expect(JSON.stringify(resolved)).not.toContain(REPO);
    expect(await readFile(path.join(copy, ".git", "config"), "utf8")).not.toContain("remote");
    expect(await registry.resolveFolder(FOLDER_ID, original)).toMatchObject({ kind: "registered" });
  });
});
