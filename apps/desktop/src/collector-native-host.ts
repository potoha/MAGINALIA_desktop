/**
 * Developer / isolated test-only Native Messaging Host entry
 * (`node dist/main/collector-native-host.js`).
 *
 * Writes require both the descriptor's `testOnlyWritesEnabled` and
 * `MAGINALIA_COLLECTOR_TEST_ONLY=1`; the descriptor also supplies the coordination
 * root, and an env-gated recovery probe exists for E2E. None of this is reachable from
 * the production entry (`collector-native-host-product.ts`), which shares only the
 * protocol core.
 */
import { open } from "node:fs/promises";
import * as path from "node:path";
import { inspectFolderMarkers } from "./folder-identity.js";
import { parseShelfLocationSource } from "./shelf-location-registry.js";
import { commitShelfQuoteWithNativeLock } from "./shelf-native-write-lock.js";
import { readBoundedTextFile as readBoundedFile } from "./collector-shelf-configuration.js";
import {
  COLLECTOR_PROTOCOL as PROTOCOL,
  CollectorFrameDecoder,
  classifyCollectorRequest,
  hasExactKeys as keys,
  healthResponse,
  isRecordValue as record,
  isValidSaveWebQuoteRequest as validSaveRequest,
  optionalQuoteFields,
  parseCollectorFrame,
  protocolError as error,
  runCollectorMessageLoop,
  type RecordValue,
} from "./collector-native-host-core.js";

/** Kept for existing callers and tests; identical to the shared core decoder. */
export const ExperimentalFrameDecoder = CollectorFrameDecoder;
export const parseExperimentalFrame = parseCollectorFrame;

interface Descriptor {
  shelfLocationPath: string;
  expectedShelfId: string;
  allowedOrigin: string;
  testOnlyWritesEnabled: boolean;
  coordinationRoot?: string;
}
async function descriptor(file: string | undefined, origin: string | undefined): Promise<Descriptor | undefined> {
  try {
    if (!file || !path.isAbsolute(file)) return undefined;
    const value: unknown = JSON.parse(await readBoundedFile(file, 16 * 1024));
    if (!record(value) || value.experimental !== true
      || typeof value.shelfLocationPath !== "string" || !path.isAbsolute(value.shelfLocationPath)
      || typeof value.expectedShelfId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.expectedShelfId)
      || typeof value.allowedOrigin !== "string" || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(value.allowedOrigin)
      || origin !== value.allowedOrigin) return undefined;
    if (keys(value, ["experimental", "shelfLocationPath", "expectedShelfId", "allowedOrigin"])) {
      return {
        shelfLocationPath: value.shelfLocationPath,
        expectedShelfId: value.expectedShelfId,
        allowedOrigin: value.allowedOrigin,
        testOnlyWritesEnabled: false
      };
    }
    if (keys(value, ["experimental", "shelfLocationPath", "expectedShelfId", "allowedOrigin", "testOnlyWritesEnabled", "coordinationRoot"])
      && value.testOnlyWritesEnabled === true && typeof value.coordinationRoot === "string" && path.isAbsolute(value.coordinationRoot)) {
      return {
        shelfLocationPath: value.shelfLocationPath,
        expectedShelfId: value.expectedShelfId,
        allowedOrigin: value.allowedOrigin,
        testOnlyWritesEnabled: true,
        coordinationRoot: value.coordinationRoot
      };
    }
    return undefined;
  } catch { return undefined; }
}

interface ConfiguredShelf { readonly root: string; readonly id: string; readonly name: string }
type ShelfLoadResult = { readonly shelf: ConfiguredShelf } | { readonly error: string };

async function loadConfiguredShelf(config: Descriptor): Promise<ShelfLoadResult> {
  let location: ReturnType<typeof parseShelfLocationSource>;
  try { location = parseShelfLocationSource(await readBoundedFile(config.shelfLocationPath, 64 * 1024)); }
  catch { return { error: "configuration_unavailable" }; }
  if (!location) return { error: "configuration_unavailable" };
  try {
    const root = location.privateShelf.registry;
    if (root === null) return { error: "shelf_unconfigured" };
    const marker = await inspectFolderMarkers(root);
    if (marker.kind !== "valid" || marker.marker.type !== "shelf") return { error: "shelf_identity_unavailable" };
    if (marker.marker.id.toLowerCase() !== config.expectedShelfId.toLowerCase()) return { error: "shelf_identity_mismatch" };
    const libraryText = await readBoundedFile(path.join(root, "library.json"), 1024 * 1024);
    const format = await import("@maginalia/format");
    const library = format.parseAndValidate("library", libraryText);
    if (!library.valid) return { error: "shelf_unavailable" };
    return { shelf: { root, id: marker.marker.id, name: library.value.name } };
  } catch { return { error: "shelf_unavailable" }; }
}

function testOnlyWritesEnabled(config: Descriptor, env: NodeJS.ProcessEnv): boolean {
  return config.testOnlyWritesEnabled && env.MAGINALIA_COLLECTOR_TEST_ONLY === "1";
}

async function shelfStatus(config: Descriptor, writesEnabled: boolean): Promise<RecordValue> {
  const loaded = await loadConfiguredShelf(config);
  if ("error" in loaded) return error(loaded.error);
  return {
    protocol: PROTOCOL,
    ok: true,
    shelf: { id: loaded.shelf.id, name: loaded.shelf.name, type: "private", writesEnabled }
  };
}

type QuoteWriter = typeof commitShelfQuoteWithNativeLock;

async function saveWebQuote(config: Descriptor, value: RecordValue, env: NodeJS.ProcessEnv, writeQuote: QuoteWriter): Promise<RecordValue> {
  if (!testOnlyWritesEnabled(config, env) || !config.coordinationRoot) return error("unsupported_operation");
  if (!validSaveRequest(value)) return error("invalid_request");
  const loaded = await loadConfiguredShelf(config);
  if ("error" in loaded) return error(loaded.error);
  try {
    let recoveryProbe = false;
    if (env.MAGINALIA_COLLECTOR_TEST_RECOVERY_PROBE_ONCE === "1") {
      try {
        const probe = await open(path.join(config.coordinationRoot, ".collector-e2e-recovery-probe-used"), "wx", 0o600);
        try { await probe.writeFile("used\n", "utf8"); await probe.sync(); }
        finally { await probe.close(); }
        recoveryProbe = true;
      } catch (cause) {
        if (cause === null || typeof cause !== "object" || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      }
    }
    const receipt = await writeQuote({
      requestId: value.requestId,
      shelfRoot: loaded.shelf.root,
      expectedShelfId: loaded.shelf.id,
      coordinationRoot: config.coordinationRoot,
      quote: value.quote,
      url: value.url,
      getDate: value.getDate,
      ...optionalQuoteFields(value),
      processLabel: "collector-native-host-test-only",
      ...(recoveryProbe ? { faults: { beforeAnnotationPublish: async () => { throw new Error("test-only recovery probe"); } } } : {})
    });
    return { protocol: PROTOCOL, ok: true, receipt };
  } catch {
    // Shelf paths, quote text and filesystem diagnostics never cross Native Messaging.
    return error("save_failed");
  }
}

export async function handleExperimentalRequest(
  value: unknown,
  file: string | undefined,
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  writeQuote: QuoteWriter = commitShelfQuoteWithNativeLock
): Promise<RecordValue> {
  const config = await descriptor(file, origin);
  if (!config) return error("host_configuration_or_origin_invalid");
  const request = classifyCollectorRequest(value);
  if (request.kind === "error") return request.response;
  const writesEnabled = testOnlyWritesEnabled(config, env);
  if (request.kind === "health") return healthResponse(writesEnabled);
  if (request.kind === "configured_shelf") return shelfStatus(config, writesEnabled);
  // `host_info` and its contact record exist only in the production Host.
  if (request.kind === "host_info") return error("unsupported_operation");
  return saveWebQuote(config, request.value, env, writeQuote);
}

async function main(): Promise<void> {
  await runCollectorMessageLoop((value) =>
    handleExperimentalRequest(value, process.env.MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR, process.argv[2]));
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch(() => { process.stderr.write("Experimental host failed.\n"); process.exitCode = 1; });
}
