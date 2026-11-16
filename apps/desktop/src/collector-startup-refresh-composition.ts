/**
 * Composition for the Collector startup refresh (WP-5c) and the main-process Collector integration
 * runtime (WP-7 slice A).
 *
 * It assembles the production dependencies of WP-5b (registry adapter, native path security,
 * protected-directory creation, Host self-check runner with a clean environment, random suffix)
 * around `createCollectorStartupRefresh`. Everything environment-specific is a parameter so the
 * caller decides, in one place, what is real:
 *
 *  - `e2eIsolationActive`: when true nothing is constructed (`createRegistry` is never called, so
 *    the native addon is not even loaded) and the returned orchestrator does nothing.
 *  - The payload descriptor comes from the compiled constant (`collector-payload-compiled.ts`,
 *    embedded by `scripts/embed-collector-payload.mjs` when the Windows app is staged), never from
 *    the informational `collector-payload.json`. Not embedded: a packaged app throws
 *    `CollectorPayloadNotEmbeddedError` here (fail loudly); a development build gets an inert
 *    orchestrator (`skipped-no-payload`). Nothing is silently replaced by an empty payload.
 *
 * The opt-in probe (`hasOptedIn`) is read-only.
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  buildCleanHostEnvironment,
  createNodeHostSelfCheckRunner,
} from "./collector-integration-apply-self-check.js";
import { createNodeCollectorApplyFileSystem } from "./collector-integration-apply-fs.js";
import { applyCollectorIntegration } from "./collector-integration-apply.js";
import type { CollectorIntegrationApplyDependencies } from "./collector-integration-apply-types.js";
import {
  inspectCollectorIntegration,
  parseIntegrationStateFile,
  resolveIntegrationPaths,
} from "./collector-integration.js";
import type { CollectorRegistryAdapter } from "./collector-registry-adapter.js";
import type { PathSecurityInspector } from "./collector-path-security.js";
import { COLLECTOR_PAYLOAD_EMBEDDED, COMPILED_COLLECTOR_PAYLOAD } from "./collector-payload-compiled.js";
import { locateChromeExecutable } from "./collector-integration.js";
import type { ChromeLocation, CollectorInspectOptions, CollectorIntegrationInspection } from "./collector-integration-types.js";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types.js";
import { createFileCollectorNoticeStore, type CollectorNoticeStore } from "./collector-integration-notices.js";
import {
  createCollectorStartupRefresh,
  type CollectorStartupRefresh,
  type CollectorStartupRefreshDependencies,
} from "./collector-startup-refresh.js";

const MAX_STATE_BYTES = 4096;

export interface CollectorStartupCompositionOptions {
  readonly e2eIsolationActive: boolean;
  /** Called only when `e2eIsolationActive` is false. Product: `createProductCollectorRegistryAdapter`. */
  readonly createRegistry: () => CollectorRegistryAdapter;
  /** Product: `inspectNativePathSecurity`. */
  readonly inspectPathSecurity: PathSecurityInspector;
  /** Product: `createNativePrivateDirectory`. */
  readonly createPrivateDirectory: (target: string) => "created" | "exists" | Promise<"created" | "exists">;
  /** Electron's `process.resourcesPath` (holds `collector-host` and `collector-extension`). */
  readonly resourcesPath: string;
  /** `app.isPackaged`. A packaged app without an embedded payload is a build defect and throws. */
  readonly isPackaged: boolean;
  /** Test seam; default is the compiled constant. */
  readonly compiledPayload?: { readonly embedded: boolean; readonly value: unknown };
  /** Product: `process.env` (reduced to an allowlist before it reaches the Host). */
  readonly processEnvironment: Readonly<Record<string, string | undefined>>;
  /** Desktop userData file for the notice state. */
  readonly noticeStatePath: string;
  readonly now?: () => Date;
  /** Test seams. */
  readonly noticeStore?: CollectorNoticeStore;
  readonly randomSuffix?: () => string;
  /**
   * Wraps every apply the orchestrator starts (startup refresh) so it shares one serialization gate
   * with the user-started applies. Default: no wrapping.
   */
  readonly wrapApply?: (apply: (request: CollectorApplyRequest) => Promise<CollectorApplyResult>) => (request: CollectorApplyRequest) => Promise<CollectorApplyResult>;
}

/** `active`: real dependencies. `inert-*`: nothing was constructed and every operation rejects. */
export type CollectorIntegrationRuntimeMode = "active" | "inert-e2e-isolation" | "inert-no-payload";

export interface CollectorIntegrationRuntime {
  readonly mode: CollectorIntegrationRuntimeMode;
  readonly startupRefresh: CollectorStartupRefresh;
  /** Read-only inspection. Rejects in an inert runtime. */
  readonly inspect: (options?: CollectorInspectOptions) => Promise<CollectorIntegrationInspection>;
  /** Raw apply (not wrapped by `wrapApply`). Rejects in an inert runtime. */
  readonly apply: (request: CollectorApplyRequest) => Promise<CollectorApplyResult>;
  /** Main-process only: the validated `chrome.exe` path must never reach the renderer or a log. Rejects in an inert runtime. */
  readonly locateChrome: () => Promise<ChromeLocation>;
}

export class CollectorPayloadNotEmbeddedError extends Error {
  public constructor() {
    super("The packaged app has no embedded Collector payload descriptor (build defect).");
    this.name = "CollectorPayloadNotEmbeddedError";
  }
}

const inertDependencies = (now: () => Date, noticeStore: CollectorNoticeStore, isolated: boolean): CollectorStartupRefreshDependencies => ({
  inspect: () => Promise.reject(new Error("unavailable under E2E isolation")),
  apply: () => Promise.reject(new Error("unavailable under E2E isolation")),
  hasOptedIn: () => Promise.resolve(false),
  noticeStore,
  now,
  e2eIsolationActive: isolated,
  payloadUnavailable: !isolated,
});

const rejectInert = (): Promise<never> => Promise.reject(new Error("The Collector integration is inert in this process."));

function inertRuntime(mode: "inert-e2e-isolation" | "inert-no-payload", startupRefresh: CollectorStartupRefresh): CollectorIntegrationRuntime {
  return Object.freeze({ mode, startupRefresh, inspect: rejectInert, apply: rejectInert, locateChrome: rejectInert });
}

export function createCollectorIntegrationRuntimeFromParts(options: CollectorStartupCompositionOptions): CollectorIntegrationRuntime {
  const now = options.now ?? (() => new Date());
  const noticeStore = options.noticeStore ?? createFileCollectorNoticeStore(options.noticeStatePath);
  if (options.e2eIsolationActive) {
    return inertRuntime("inert-e2e-isolation", createCollectorStartupRefresh(inertDependencies(now, noticeStore, true)));
  }
  const compiled = options.compiledPayload ?? { embedded: COLLECTOR_PAYLOAD_EMBEDDED, value: COMPILED_COLLECTOR_PAYLOAD };
  if (!compiled.embedded || compiled.value === null || compiled.value === undefined) {
    if (options.isPackaged) throw new CollectorPayloadNotEmbeddedError();
    return inertRuntime("inert-no-payload", createCollectorStartupRefresh(inertDependencies(now, noticeStore, false)));
  }
  const compiledValue = compiled.value;

  const registry = options.createRegistry();
  const fileSystem = createNodeCollectorApplyFileSystem({ createPrivateDirectory: options.createPrivateDirectory });
  const applyDependencies: CollectorIntegrationApplyDependencies = {
    registry,
    fileSystem,
    inspectPathSecurity: options.inspectPathSecurity,
    readPayloadDescriptor: async () => compiledValue,
    now,
    e2eIsolationActive: false,
    payloadSource: {
      hostFolder: path.join(options.resourcesPath, "collector-host"),
      extensionFolder: path.join(options.resourcesPath, "collector-extension"),
    },
    runHostSelfCheck: createNodeHostSelfCheckRunner({ environment: buildCleanHostEnvironment(options.processEnvironment) }),
    randomSuffix: options.randomSuffix ?? (() => randomBytes(8).toString("hex")),
  };

  const inspect = (inspectOptions?: CollectorInspectOptions): Promise<CollectorIntegrationInspection> => inspectCollectorIntegration(applyDependencies, inspectOptions);
  const apply = (request: CollectorApplyRequest): Promise<CollectorApplyResult> => applyCollectorIntegration(request, applyDependencies);
  const startupRefresh = createCollectorStartupRefresh({
    inspect: (inspectOptions) => inspect(inspectOptions),
    apply: options.wrapApply === undefined ? apply : options.wrapApply(apply),
    hasOptedIn: async () => {
      const paths = resolveIntegrationPaths(registry);
      if (paths === undefined) return false;
      const read = await fileSystem.readSmallFile(paths.statePath, MAX_STATE_BYTES);
      if (read.kind !== "ok") return false;
      try {
        return parseIntegrationStateFile(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) !== undefined;
      } catch {
        return false;
      }
    },
    noticeStore,
    now,
    e2eIsolationActive: false,
  });
  return Object.freeze({
    mode: "active" as const,
    startupRefresh,
    inspect,
    apply,
    locateChrome: () => locateChromeExecutable({ registry, fileSystem }),
  });
}

export function createCollectorStartupRefreshFromParts(options: CollectorStartupCompositionOptions): CollectorStartupRefresh {
  return createCollectorIntegrationRuntimeFromParts(options).startupRefresh;
}
