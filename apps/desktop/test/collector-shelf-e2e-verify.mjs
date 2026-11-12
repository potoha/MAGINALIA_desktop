#!/usr/bin/env node
/**
 * Read-only verifier for the isolated Collector → Private Shelf E2E result
 * (Desktop #93 scenarios). Asserts per-request deltas, never a global count:
 *
 *   collector-only: +1 Book / +1 Annotation since the pre-Collector baseline;
 *   first-run:      tutorial seed records (+3/+3 for the bundled sample) since
 *                   the pre-first-run baseline, plus the Collector +1/+1.
 *
 * Every file present in a baseline must stay byte-identical (SHA-256). The
 * only file this script writes is a `snapshot` output, outside the Shelf.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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

function parseArguments(argv) {
  const [first, ...rest] = argv;
  if (first === "snapshot") return { command: "snapshot", shelfRoot: rest[0], out: rest[1], allowMissing: rest.includes("--allow-missing") };
  if (first === "collector-only" || first === "first-run") {
    const options = { command: "verify", scenario: first, expectedUrl: "https://example.com/" };
    const names = { "--descriptor": "descriptorPath", "--baseline": "baselinePath", "--first-run-baseline": "firstRunBaselinePath", "--expected-quote": "expectedQuote", "--expected-url": "expectedUrl", "--tutorial-seed": "tutorialSeed" };
    for (let index = 0; index < rest.length; index += 2) {
      const key = names[rest[index]];
      assert.ok(key && rest[index + 1] !== undefined, `unknown or incomplete option ${rest[index]}`);
      options[key] = rest[index + 1];
    }
    return options;
  }
  // Legacy positional form: <descriptor.json> <before-snapshot.json> <expected-quote> (Collector-only).
  return { command: "verify", scenario: "collector-only", descriptorPath: first, baselinePath: rest[0], expectedQuote: rest[1], expectedUrl: "https://example.com/" };
}

function readBaseline(value) {
  assert.equal(value.version, 1, "unsupported snapshot version");
  assert.ok(Array.isArray(value.files), "snapshot has no file list");
  return new Map(value.files.map((entry) => [entry.path, { size: entry.size, sha256: entry.sha256 }]));
}

/** Assert every baseline file is byte-identical in `afterFiles`; return the paths added since. */
function deltaSince(beforeFiles, afterFiles, label) {
  for (const [name, digest] of beforeFiles) assert.deepEqual(afterFiles.get(name), digest, `${label}: an existing Shelf file changed or disappeared`);
  return [...afterFiles.keys()].filter((name) => !beforeFiles.has(name));
}

async function readSeedRecords(seedRoot, kind) {
  const library = JSON.parse(await readFile(path.join(seedRoot, "library.json"), "utf8"));
  const relative = kind === "book" ? (library.booksPath ?? "books") : (library.annotationsPath ?? "annotations");
  const records = new Map();
  for (const name of await readdir(path.join(seedRoot, relative))) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const value = JSON.parse(await readFile(path.join(seedRoot, relative, name), "utf8"));
    records.set(value.id, value);
  }
  return records;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "snapshot") {
    assert.ok(path.isAbsolute(options.shelfRoot ?? "") && path.isAbsolute(options.out ?? ""), "usage: snapshot <absolute shelf root> <absolute out.json> [--allow-missing]");
    const relative = path.relative(path.resolve(options.shelfRoot), path.resolve(options.out));
    assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "the snapshot file must be written outside the Shelf");
    let files = [];
    let exists = true;
    try {
      files = [...(await snapshot(path.resolve(options.shelfRoot))).entries()].map(([name, digest]) => ({ path: name, ...digest }));
    } catch (error) {
      if (!options.allowMissing || error?.code !== "ENOENT") throw error;
      exists = false;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(path.resolve(options.out), `${JSON.stringify({ version: 1, exists, files }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: "SNAPSHOT", exists, files: files.length })}\n`);
    return;
  }

  const { descriptorPath, baselinePath, expectedQuote, expectedUrl, scenario } = options;
  assert.ok(descriptorPath && baselinePath && expectedQuote, "usage: node test/collector-shelf-e2e-verify.mjs <collector-only|first-run> --descriptor <d.json> --baseline <pre-collector.json> --expected-quote <text> [--first-run-baseline <pre-first-run.json>] [--expected-url <url>] [--tutorial-seed <dir>]");
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
  const bookPrefix = `${(library.booksPath ?? "books").replace(/\\/gu, "/")}/`;
  const annotationPrefix = `${(library.annotationsPath ?? "annotations").replace(/\\/gu, "/")}/`;
  const beforeFiles = readBaseline(JSON.parse(await readFile(path.resolve(baselinePath), "utf8")));
  const afterFiles = await snapshot(root);

  // Collector request delta, relative to the pre-Collector baseline: exactly
  // one new Book and one new Annotation, nothing else, nothing changed.
  const addedPaths = deltaSince(beforeFiles, afterFiles, "Collector delta");
  const newBookPaths = addedPaths.filter((name) => name.startsWith(bookPrefix));
  const newAnnotationPaths = addedPaths.filter((name) => name.startsWith(annotationPrefix));
  assert.equal(newBookPaths.length, 1, "exactly one add-only Book file is required");
  assert.equal(newAnnotationPaths.length, 1, "exactly one add-only Annotation file is required");
  assert.equal(addedPaths.length, 2, "the Shelf must contain no other new files");

  const books = await readRecords(root, library.booksPath ?? "books", "book");
  const annotations = await readRecords(root, library.annotationsPath ?? "annotations", "annotation");
  const newBook = JSON.parse(await readFile(path.join(root, newBookPaths[0]), "utf8"));
  const newAnnotation = JSON.parse(await readFile(path.join(root, newAnnotationPaths[0]), "utf8"));
  assert.equal(path.posix.basename(newBookPaths[0]), `${newBook.id.replace(":", "-")}.json`);
  assert.equal(path.posix.basename(newAnnotationPaths[0]), `${newAnnotation.id.replace(":", "-")}.json`);
  assert.equal(newBook.version, "0.4");
  assert.equal(newAnnotation.version, "0.4");
  assert.equal(newBook.source.kind, "website");
  assert.equal(newBook.url, expectedUrl);
  assert.equal(newAnnotation.source.kind, "website");
  assert.equal(newAnnotation.source.id, newBook.id);
  assert.equal(newAnnotation.quote, expectedQuote);
  assert.equal(newAnnotation.url, expectedUrl);
  assert.ok(books.has(newBook.id));
  assert.ok(annotations.has(newAnnotation.id));

  const { inspectShelfWriteJournal } = await import(pathToFileURL(nativeMain("shelf-write-coordination.js")).href);
  const journal = await inspectShelfWriteJournal({ shelfRoot: root, expectedShelfId: descriptor.expectedShelfId, coordinationRoot: descriptor.coordinationRoot });
  assert.equal(journal.length, 1, "the isolated request journal must contain one request");
  assert.equal(journal[0].record.state, "committed");
  assert.equal(journal[0].record.bookId, newBook.id);
  assert.equal(journal[0].record.annotationId, newAnnotation.id);
  assert.equal(journal[0].matchesDisk, true);

  const result = {
    status: "PASS",
    scenario,
    existingFilesUnchanged: true,
    collector: { requestId: journal[0].record.requestId ?? null, bookId: newBook.id, annotationId: newAnnotation.id, addedBooks: 1, addedAnnotations: 1 },
    newRecordsV04: true,
    durableReceipt: "committed",
  };

  if (scenario === "first-run") {
    // First-run delta, relative to the pre-first-run baseline: the tutorial
    // seed adds exactly its own Books/Annotations (+3/+3 for the bundled
    // sample), identical to the seed content, before the Collector request.
    assert.ok(options.firstRunBaselinePath, "first-run requires --first-run-baseline <pre-first-run snapshot>");
    const seedRoot = path.resolve(options.tutorialSeed ?? path.join(desktopRoot, "..", "..", "Tutorial_sample_setup", "private-shelf-seed"));
    const seedBooks = await readSeedRecords(seedRoot, "book");
    const seedAnnotations = await readSeedRecords(seedRoot, "annotation");
    const firstRunFiles = readBaseline(JSON.parse(await readFile(path.resolve(options.firstRunBaselinePath), "utf8")));
    const sinceFirstRun = deltaSince(firstRunFiles, afterFiles, "first-run delta");
    const firstRunBookPaths = sinceFirstRun.filter((name) => name.startsWith(bookPrefix) && !newBookPaths.includes(name));
    const firstRunAnnotationPaths = sinceFirstRun.filter((name) => name.startsWith(annotationPrefix) && !newAnnotationPaths.includes(name));
    const tutorialBookIds = [];
    for (const name of firstRunBookPaths) {
      assert.ok(beforeFiles.has(name), "a first-run Book file appeared after the pre-Collector baseline");
      const value = JSON.parse(await readFile(path.join(root, name), "utf8"));
      assert.ok(seedBooks.has(value.id), "a Book added during first-run is not a tutorial seed record");
      assert.deepEqual(value, seedBooks.get(value.id), "a tutorial Book differs from its seed record");
      tutorialBookIds.push(value.id);
    }
    const tutorialAnnotationIds = [];
    for (const name of firstRunAnnotationPaths) {
      assert.ok(beforeFiles.has(name), "a first-run Annotation file appeared after the pre-Collector baseline");
      const value = JSON.parse(await readFile(path.join(root, name), "utf8"));
      assert.ok(seedAnnotations.has(value.id), "an Annotation added during first-run is not a tutorial seed record");
      assert.deepEqual(value, seedAnnotations.get(value.id), "a tutorial Annotation differs from its seed record");
      tutorialAnnotationIds.push(value.id);
    }
    assert.deepEqual([...tutorialBookIds].sort(), [...seedBooks.keys()].sort(), "first-run must add exactly the tutorial Books");
    assert.deepEqual([...tutorialAnnotationIds].sort(), [...seedAnnotations.keys()].sort(), "first-run must add exactly the tutorial Annotations");
    assert.equal(seedBooks.has(newBook.id) || seedAnnotations.has(newAnnotation.id), false, "the Collector request reused a tutorial ID");
    result.tutorial = { addedBooks: tutorialBookIds.length, addedAnnotations: tutorialAnnotationIds.length, bookIds: tutorialBookIds.sort(), annotationIds: tutorialAnnotationIds.sort() };
  }

  process.stdout.write(JSON.stringify(result) + "\n");
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
