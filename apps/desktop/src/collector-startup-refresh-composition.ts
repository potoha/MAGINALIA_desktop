/**
 * Composition for the Collector startup refresh (WP-5c). NOT wired into `main.ts` yet.
 *
 * It assembles the production dependencies of WP-5b (registry adapter, native path security,
 * protected-directory creation, Host self-check runner with a clean environment, random suffix)
 * around `createCollectorStartupRefresh`. Everything environment-specific is a parameter so the
 * caller decides, in one place, what is real:
 *
 *  - `e2eIsolationActive`: when true nothing is constructed (`createRegistry` is never called, so
 *    the native addon is not even loaded) and the returned orchestrator does nothing.
 *  - `readPayloadDescriptor`: left to the caller on purpose. The design says the compiled constants
 *    of the main bundle, not the informational `collector-payload.json`, are authoritative
 *    (design 2.1, apply-module note). Those constants do not exist yet (open design point, see the
 *    WP-5c report), so reading the resource file here would silently settle that question.
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
  /** Returns the parsed payload descriptor; see the module comment. */
  readonly readPayloadDescriptor: () => Promise<unknown>;
  /** Product: `process.env` (reduced to an allowlist before it reaches the Host). */
  readonly processEnvironment: Readonly<Record<string, string | undefined>>;
  /** Desktop userData file for the notice state. */
  readonly noticeStatePath: string;
  readonly now?: () => Date;
  /** Test seams. */
  readonly noticeStore?: CollectorNoticeStore;
  readonly randomSuffix?: () => string;
}

const inertDependencies = (now: () => Date, noticeStore: CollectorNoticeStore): CollectorStartupRefreshDependencies => ({
  inspect: () => Promise.reject(new Error("unavailable under E2E isolation")),
  apply: () => Promise.reject(new Error("unavailable under E2E isolation")),
  hasOptedIn: () => Promise.resolve(false),
  noticeStore,
  now,
  e2eIsolationActive: true,
});

export function createCollectorStartupRefreshFromParts(options: CollectorStartupCompositionOptions): CollectorStartupRefresh {
  const now = options.now ?? (() => new Date());
  const noticeStore = options.noticeStore ?? createFileCollectorNoticeStore(options.noticeStatePath);
  if (options.e2eIsolationActive) return createCollectorStartupRefresh(inertDependencies(now, noticeStore));

  const registry = options.createRegistry();
  const fileSystem = createNodeCollectorApplyFileSystem({ createPrivateDirectory: options.createPrivateDirectory });
  const applyDependencies: CollectorIntegrationApplyDependencies = {
    registry,
    fileSystem,
    inspectPathSecurity: options.inspectPathSecurity,
    readPayloadDescriptor: options.readPayloadDescriptor,
    now,
    e2eIsolationActive: false,
    payloadSource: {
      hostFolder: path.join(options.resourcesPath, "collector-host"),
      extensionFolder: path.join(options.resourcesPath, "collector-extension"),
    },
    runHostSelfCheck: createNodeHostSelfCheckRunner({ environment: buildCleanHostEnvironment(options.processEnvironment) }),
    randomSuffix: options.randomSuffix ?? (() => randomBytes(8).toString("hex")),
  };

  return createCollectorStartupRefresh({
    inspect: (inspectOptions) => inspectCollectorIntegration(applyDependencies, inspectOptions),
    apply: (request) => applyCollectorIntegration(request, applyDependencies),
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
}
