/**
 * Production MAGINALIA Collector Native Messaging Host (`org.maginalia.collector`).
 *
 * Desktop #86 design memo, sections 1 to 4:
 *
 * - The caller is authorized only when Chrome's caller-origin argument is
 *   exactly a member of the compiled list {@link COLLECTOR_ALLOWED_ORIGINS}.
 * - The configuration is the Desktop-written #87 Shelf binding, read through
 *   `readCollectorShelfConfiguration`. Paths come only from the native LocalAppData
 *   known folder. This entry reads no environment variable, cwd or descriptor file;
 *   it has no test gate and no recovery probe (those stay in `collector-native-host.ts`).
 * - The protocol is `maginalia.collector.experimental.v1` (`health`, `configured_shelf`,
 *   `save_web_quote`, and the additive `host_info`, which also records the fixed,
 *   data-free contact record in `collector-contact-record.ts`) and uses the shared core.
 *   `health.writesEnabled` and the advertised `save_web_quote` operation are present
 *   only while the binding is fully valid.
 * - Writes go through the unchanged `commitShelfQuoteWithNativeLock` (D071 mutex,
 *   shared coordination root, journal and `writer-recovery.json`, with #92 fail-closed
 *   markers). A receipt is returned only after the writer has cleared the recovery
 *   marker, and only in state `committed` or `already-committed`.
 * - Responses carry no paths, quote text or diagnostics. Nothing is logged, and
 *   stdout carries frames only.
 */
import { createCollectorContactRecorder, type CollectorContactRecorder } from "./collector-contact-record.js";
import { readCollectorShelfConfiguration, type CollectorShelfConfigurationResult } from "./collector-shelf-configuration.js";
import {
  COLLECTOR_HOST_VERSION,
  COLLECTOR_PROTOCOL,
  classifyCollectorRequest,
  healthResponse,
  hostInfoResponse,
  isValidSaveWebQuoteRequest,
  optionalQuoteFields,
  protocolError,
  runCollectorMessageLoop,
  type CollectorHostStreams,
  type RecordValue,
} from "./collector-native-host-core.js";
import { commitShelfQuoteWithNativeLock } from "./shelf-native-write-lock.js";
import { ShelfWriteCoordinationError } from "./shelf-write-coordination.js";
import {
  ShelfNativeMutexError,
  getNativeLocalAppDataPath,
  inspectNativePathSecurity,
  useProductNativeAddonLocation,
  type ProductNativeAddonLocation,
} from "./shelf-native-mutex.js";

export const COLLECTOR_HOST_NAME = "org.maginalia.collector";
/** Fixed Collector extension ID, derived from the public key committed to its manifest. */
export const COLLECTOR_EXTENSION_ID = "blgmoddncpknfnikdfnjelmdmphfgknf";
/**
 * Compiled list of allowed caller origins (exact membership, no normalization). A Web
 * Store ID is added here later; the manifest generator uses the same list. No
 * environment, cwd or descriptor input reaches it.
 */
export const COLLECTOR_ALLOWED_ORIGINS = Object.freeze([
  `chrome-extension://${COLLECTOR_EXTENSION_ID}/`,
] as const);

export interface CollectorProductHostDependencies {
  readonly readConfiguration: () => Promise<CollectorShelfConfigurationResult>;
  readonly writeQuote: typeof commitShelfQuoteWithNativeLock;
  /** Best-effort contact record for `host_info`; absent in tests that do not exercise it. */
  readonly recordContact?: CollectorContactRecorder;
}

/** Exact comparison only: no prefix, case folding or trailing-slash normalization. */
export function isAllowedCollectorOrigin(origin: unknown): boolean {
  return typeof origin === "string" && COLLECTOR_ALLOWED_ORIGINS.some((allowed) => allowed === origin);
}

function isMutexBusy(error: unknown): boolean {
  return error instanceof ShelfNativeMutexError && error.code === "shelf-write-busy";
}

/** The request itself can never succeed; retrying the same bytes cannot help. */
function isPermanentRequestError(error: unknown): boolean {
  return error instanceof ShelfWriteCoordinationError
    && (error.code === "shelf-write-invalid-request" || error.code === "shelf-write-request-mismatch");
}

async function saveWebQuote(value: RecordValue, dependencies: CollectorProductHostDependencies): Promise<RecordValue> {
  if (!isValidSaveWebQuoteRequest(value)) return protocolError("invalid_request");
  const configuration = await dependencies.readConfiguration();
  if (configuration.kind === "error") return protocolError(configuration.code);
  let receipt: Awaited<ReturnType<typeof commitShelfQuoteWithNativeLock>>;
  try {
    receipt = await dependencies.writeQuote({
      requestId: value.requestId,
      shelfRoot: configuration.shelf.root,
      expectedShelfId: configuration.shelf.id,
      coordinationRoot: configuration.coordinationRoot,
      quote: value.quote,
      url: value.url,
      getDate: value.getDate,
      ...optionalQuoteFields(value),
      processLabel: "collector-native-host",
    });
  } catch (error: unknown) {
    // Shelf paths, quote text and filesystem diagnostics never cross Native Messaging.
    if (isPermanentRequestError(error)) return protocolError("invalid_request");
    return protocolError(isMutexBusy(error) ? "shelf_write_busy" : "save_failed");
  }
  if (receipt === null || typeof receipt !== "object"
    || (receipt.state !== "committed" && receipt.state !== "already-committed")
    || receipt.requestId !== value.requestId
    || receipt.shelfId.toLowerCase() !== configuration.shelf.id.toLowerCase()) {
    return protocolError("save_failed");
  }
  return { protocol: COLLECTOR_PROTOCOL, ok: true, receipt };
}

/** Handle one decoded request from the caller identified by `origin`. */
export async function handleCollectorProductRequest(
  value: unknown,
  origin: unknown,
  dependencies: CollectorProductHostDependencies,
): Promise<RecordValue> {
  if (!isAllowedCollectorOrigin(origin)) return protocolError("host_configuration_or_origin_invalid");
  const request = classifyCollectorRequest(value);
  if (request.kind === "error") return request.response;
  if (request.kind === "health") {
    return healthResponse((await dependencies.readConfiguration()).kind === "valid", true);
  }
  if (request.kind === "host_info") {
    try {
      await dependencies.recordContact?.({
        protocol: COLLECTOR_PROTOCOL,
        hostVersion: COLLECTOR_HOST_VERSION,
        extensionVersion: request.extensionVersion,
      });
    } catch {
      // The contact record is best-effort and never changes the response.
    }
    return hostInfoResponse();
  }
  if (request.kind === "configured_shelf") {
    const configuration = await dependencies.readConfiguration();
    if (configuration.kind === "error") return protocolError(configuration.code);
    return {
      protocol: COLLECTOR_PROTOCOL,
      ok: true,
      shelf: { id: configuration.shelf.id, name: configuration.shelf.name, type: "private", writesEnabled: true },
    };
  }
  return saveWebQuote(request.value, dependencies);
}

/** Production dependencies: the native known folder, native ACL inspection, the common writer. */
export function createCollectorProductHostDependencies(): CollectorProductHostDependencies {
  return Object.freeze({
    readConfiguration: () => readCollectorShelfConfiguration({
      resolveLocalAppDataPath: getNativeLocalAppDataPath,
      inspectPathSecurity: inspectNativePathSecurity,
    }),
    writeQuote: commitShelfQuoteWithNativeLock,
    recordContact: createCollectorContactRecorder({
      resolveLocalAppDataPath: getNativeLocalAppDataPath,
      inspectPathSecurity: inspectNativePathSecurity,
    }),
  });
}

/**
 * Chrome starts the Host with the caller origin as its first argument (on Windows a
 * `--parent-window=` argument may follow). `firstArgumentIndex` is 2 for
 * `node <script>` and is set by the standalone executable entry.
 */
export function collectorCallerOrigin(argv: readonly string[], firstArgumentIndex: number): string | undefined {
  return argv[firstArgumentIndex];
}

export interface CollectorProductHostRunOptions {
  readonly origin: string | undefined;
  readonly addonLocation: ProductNativeAddonLocation;
  readonly dependencies?: CollectorProductHostDependencies;
  readonly streams?: CollectorHostStreams;
}

export async function runCollectorProductHost(options: CollectorProductHostRunOptions): Promise<void> {
  useProductNativeAddonLocation(options.addonLocation);
  const dependencies = options.dependencies ?? createCollectorProductHostDependencies();
  await runCollectorMessageLoop(
    (value) => handleCollectorProductRequest(value, options.origin, dependencies),
    options.streams,
  );
}
