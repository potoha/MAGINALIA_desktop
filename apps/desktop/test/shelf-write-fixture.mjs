/**
 * Isolated Private Shelf fixture for the cross-process writer PoC.
 *
 * Every fixture is created in a task-specific temporary directory and removed by
 * the caller. It never touches a real user Shelf, `Documents/MAGINALIA`, the
 * machine-local `shelf_location.yml`, or any repository file.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function markerText(shelfId) {
  return `version = 1\ntype = shelf\nid = ${shelfId}\n`;
}

export async function createShelfFixture(label = "shelf-write") {
  const base = await mkdtemp(path.join(os.tmpdir(), `maginalia-${label}-日本語-`));
  const shelfId = randomUUID();
  const shelfRoot = path.join(base, "Private Shelf 本棚");
  const coordinationRoot = path.join(base, "coordination");
  await mkdir(path.join(shelfRoot, "books"), { recursive: true });
  await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
  await mkdir(coordinationRoot, { recursive: true });
  await writeFile(path.join(shelfRoot, "shelf.magi"), markerText(shelfId), "utf8");
  await writeFile(
    path.join(shelfRoot, "library.json"),
    `${JSON.stringify({ type: "library", version: "0.1", name: "研究用本棚", booksPath: "books", annotationsPath: "annotations" }, null, 2)}\n`,
    "utf8"
  );
  return {
    base,
    shelfId,
    shelfRoot,
    coordinationRoot,
    booksDirectory: path.join(shelfRoot, "books"),
    annotationsDirectory: path.join(shelfRoot, "annotations")
  };
}

export async function listJsonFiles(directory) {
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith(".json")).sort();
}

export async function readJsonFiles(directory) {
  const names = await listJsonFiles(directory);
  const records = [];
  for (const name of names) records.push(JSON.parse(await readFile(path.join(directory, name), "utf8")));
  return records;
}
