/**
 * Build-time self-test for the Collector Host bundle (not shipped).
 *
 * `build-collector-host.mjs` bundles this entry with the same bundler configuration
 * and plugins as the shipped Host, then runs it with Node against a disposable
 * profile. The shipped single executable cannot be pointed at a disposable profile
 * by design. This test proves that the bundled code paths work in CommonJS bundle
 * form: inlined `@maginalia/format` schemas, the `@maginalia/repository-core` marker
 * parser, the binding reader and ACL policy, and the common native-lock writer.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { validateShelfEntity } from "@maginalia/format";
import { COLLECTOR_ALLOWED_ORIGIN, handleCollectorProductRequest } from "../src/collector-native-host-product";
import { readCollectorShelfConfiguration } from "../src/collector-shelf-configuration";
import { createShelfBindingFromConfirmedSelection, persistShelfBinding } from "../src/shelf-binding";
import { createShelfBindingFileStore, resolveShelfBindingStoragePaths } from "../src/shelf-binding-store";
import { createNativePrivateDirectory, inspectNativePathSecurity } from "../src/shelf-native-mutex";
import { commitShelfQuoteWithNativeLock } from "../src/shelf-native-write-lock";

const protocol = "maginalia.collector.experimental.v1";
const id = "750e8400-e29b-41d4-a716-446655440000";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Collector Host bundle self-test failed: ${message}`);
}

async function main(): Promise<void> {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "collector-host-bundle-")));
  try {
    const localAppData = path.join(temp, "Local");
    await mkdir(localAppData);
    const shelf = path.join(temp, "本棚");
    await mkdir(path.join(shelf, "books"), { recursive: true });
    await mkdir(path.join(shelf, "annotations"), { recursive: true });
    await writeFile(path.join(shelf, "shelf.magi"), `version = 1\ntype = shelf\nid = ${id}\n`);
    await writeFile(path.join(shelf, "library.json"), JSON.stringify({ type: "library", version: "0.1", name: "Self-test Shelf", booksPath: "books", annotationsPath: "annotations" }));
    const shelfLocationPath = path.join(temp, "shelf_location.yml");
    await writeFile(shelfLocationPath, `version: 1\nprivate_shelf:\n  registry: ${JSON.stringify(shelf)}\npublic_shelf:\n  registry: null\n`);
    const paths = resolveShelfBindingStoragePaths(localAppData);
    const store = createShelfBindingFileStore(paths.bindingDirectory, {
      createDirectory: async (directory) => { createNativePrivateDirectory(directory); },
    });
    const created = createShelfBindingFromConfirmedSelection({ shelfLocationPath, privateShelfLocator: shelf, confirmedMarker: { version: 1, type: "shelf", id } });
    check(created.kind === "valid", "binding creation");
    if (created.kind !== "valid") return;
    const persisted = await persistShelfBinding(store, created.binding, null);
    check(persisted.kind === "valid", `binding persistence ${JSON.stringify(persisted)}`);

    const dependencies = {
      readConfiguration: () => readCollectorShelfConfiguration({ resolveLocalAppDataPath: () => localAppData, inspectPathSecurity: inspectNativePathSecurity }),
      writeQuote: commitShelfQuoteWithNativeLock,
    };
    const shelfStatus = await handleCollectorProductRequest({ protocol, operation: "configured_shelf" }, COLLECTOR_ALLOWED_ORIGIN, dependencies);
    check(shelfStatus.ok === true, `configured_shelf ${JSON.stringify(shelfStatus)}`);
    const save = { protocol, operation: "save_web_quote", requestId: "00000000-0000-4000-8000-0000000000f1", quote: "Bundle self-test quotation", url: "https://example.com/", getDate: "202611130000", title: "Self-test" };
    const first = await handleCollectorProductRequest(save, COLLECTOR_ALLOWED_ORIGIN, dependencies);
    check(first.ok === true && (first.receipt as { state?: string }).state === "committed", `first save ${JSON.stringify(first)}`);
    const again = await handleCollectorProductRequest(save, COLLECTOR_ALLOWED_ORIGIN, dependencies);
    check(again.ok === true && (again.receipt as { state?: string }).state === "already-committed", "idempotent resend");
    const annotations = await readdir(path.join(shelf, "annotations"));
    check(annotations.length === 1, "one annotation");
    const annotation = JSON.parse(await readFile(path.join(shelf, "annotations", annotations[0]!), "utf8")) as unknown;
    check(validateShelfEntity("annotation", annotation).valid, "annotation validates with inlined schemas");
    process.stdout.write("COLLECTOR_HOST_BUNDLE_SELFTEST_OK\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
