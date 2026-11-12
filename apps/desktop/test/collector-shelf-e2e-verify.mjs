#!/usr/bin/env node
/** Read-only verifier for the isolated Collector → Private Shelf E2E result. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAndValidate, parseShelfEntity, validateShelfEntity } from "@maginalia/format";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeMain = (name) => path.join(desktopRoot, "dist", "main", name);

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function snapshot(root) {
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  assert.equal(samePath(await realpath(root), root), true);
  const files = new Map();
  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.posix.join(relativeDirectory, child.name);
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, "Shelf contains a link or reparse point");
      if (info.isDirectory()) await walk(absolute, relative);
      else {
        assert.equal(info.isFile(), true, "Shelf contains an unsupported filesystem entry");
        files.set(relative, { size: info.size, sha256: await hashFile(absolute) });
      }
    }
  }
  await walk(root, "");
  return files;
}

async function readRecords(root, relativeDirectory, kind) {
  const directory = path.join(root, relativeDirectory);
  const result = new Map();
  for (const name of await readdir(directory)) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const file = path.join(directory, name);
    const info = await lstat(file);
    assert.equal(info.isFile() && !info.isSymbolicLink(), true);
    const text = await readFile(file, "utf8");
    const parsed = parseShelfEntity(kind, text);
    assert.equal(parsed.valid, true, `${kind} schema validation failed`);
    const value = parsed.value;
    if (value.version === "0.4") assert.equal(validateShelfEntity(kind, value).valid, true);
    assert.equal(result.has(value.id), false, `${kind} ID is duplicated`);
    result.set(value.id, value);
  }
  return result;
}

async function main() {
  const [descriptorPath, baselinePath, expectedQuote] = process.argv.slice(2);
  assert.ok(descriptorPath && baselinePath && expectedQuote, "usage: node test/collector-shelf-e2e-verify.mjs <descriptor.json> <before-snapshot.json> <expected-quote>");
  const descriptor = JSON.parse(await readFile(path.resolve(descriptorPath), "utf8"));
  assert.equal(descriptor.experimental, true);
  assert.equal(descriptor.testOnlyWritesEnabled, true);
  assert.equal(path.isAbsolute(descriptor.coordinationRoot), true);
  const { parseShelfLocationSource } = await import(pathToFileURL(nativeMain("shelf-location-registry.js")).href);
  const { inspectFolderMarkers } = await import(pathToFileURL(nativeMain("folder-identity.js")).href);
  const location = parseShelfLocationSource(await readFile(descriptor.shelfLocationPath, "utf8"));
  assert.ok(location?.privateShelf.registry, "MAGINALIA test profile has no selected Private Shelf");
  const root = path.resolve(location.privateShelf.registry);
  const marker = await inspectFolderMarkers(root);
  assert.equal(marker.kind, "valid");
  assert.equal(marker.marker.type, "shelf");
  assert.equal(marker.marker.id.toLowerCase(), descriptor.expectedShelfId.toLowerCase());

  const libraryText = await readFile(path.join(root, "library.json"), "utf8");
  const libraryResult = parseAndValidate("library", libraryText);
  assert.equal(libraryResult.valid, true, "library.json schema validation failed");
  const library = libraryResult.value;
  const before = JSON.parse(await readFile(path.resolve(baselinePath), "utf8"));
  assert.equal(before.version, 1);
  assert.ok(Array.isArray(before.files));
  const beforeFiles = new Map(before.files.map((entry) => [entry.path, { size: entry.size, sha256: entry.sha256 }]));
  const afterFiles = await snapshot(root);

  for (const [name, digest] of beforeFiles) assert.deepEqual(afterFiles.get(name), digest, "an existing Shelf file changed or disappeared");
  const addedPaths = [...afterFiles.keys()].filter((name) => !beforeFiles.has(name));
  const bookPrefix = `${library.booksPath.replace(/\\/gu, "/")}/`;
  const annotationPrefix = `${library.annotationsPath.replace(/\\/gu, "/")}/`;
  const newBookPaths = addedPaths.filter((name) => name.startsWith(bookPrefix));
  const newAnnotationPaths = addedPaths.filter((name) => name.startsWith(annotationPrefix));
  assert.equal(newBookPaths.length, 1, "exactly one add-only Book file is required");
  assert.equal(newAnnotationPaths.length, 1, "exactly one add-only Annotation file is required");
  assert.equal(addedPaths.length, 2, "the Shelf must contain no other new files");

  const books = await readRecords(root, library.booksPath, "book");
  const annotations = await readRecords(root, library.annotationsPath, "annotation");
  const newBook = JSON.parse(await readFile(path.join(root, newBookPaths[0]), "utf8"));
  const newAnnotation = JSON.parse(await readFile(path.join(root, newAnnotationPaths[0]), "utf8"));
  assert.equal(path.posix.basename(newBookPaths[0]), `${newBook.id.replace(":", "-")}.json`);
  assert.equal(path.posix.basename(newAnnotationPaths[0]), `${newAnnotation.id.replace(":", "-")}.json`);
  assert.equal(newBook.version, "0.4");
  assert.equal(newAnnotation.version, "0.4");
  assert.equal(newBook.source.kind, "website");
  assert.equal(newBook.url, "https://example.com/");
  assert.equal(newAnnotation.source.kind, "website");
  assert.equal(newAnnotation.source.id, newBook.id);
  assert.equal(newAnnotation.quote, expectedQuote);
  assert.equal(newAnnotation.url, "https://example.com/");
  assert.ok(books.has(newBook.id));
  assert.ok(annotations.has(newAnnotation.id));

  const { inspectShelfWriteJournal } = await import(pathToFileURL(nativeMain("shelf-write-coordination.js")).href);
  const journal = await inspectShelfWriteJournal({ shelfRoot: root, expectedShelfId: descriptor.expectedShelfId, coordinationRoot: descriptor.coordinationRoot });
  assert.equal(journal.length, 1, "the isolated request journal must contain one request");
  assert.equal(journal[0].record.state, "committed");
  assert.equal(journal[0].record.bookId, newBook.id);
  assert.equal(journal[0].record.annotationId, newAnnotation.id);
  assert.equal(journal[0].matchesDisk, true);

  process.stdout.write(JSON.stringify({ status: "PASS", existingFilesUnchanged: true, addedBooks: 1, addedAnnotations: 1, newRecordsV04: true, durableReceipt: "committed" }) + "\n");
}

main().catch((error) => {
  const frames = String(error?.stack ?? "").split("\n").flatMap((frame) => {
    const matches = [...frame.matchAll(/:(\d+):(\d+)/gu)];
    return matches.length === 0 ? [] : [`${matches.at(-1)[1]}:${matches.at(-1)[2]}`];
  });
  const location = frames.length === 0 ? "" : ` at ${frames.slice(0, 2).join(",")}`;
  process.stderr.write(`verify: Shelf E2E verification failed${location}; no Shelf files were changed by the verifier.\n`);
  process.exitCode = 1;
});
