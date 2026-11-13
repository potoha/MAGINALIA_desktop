/**
 * Typed wrapper for the Desktop-only `windows_integration.node` addon (Collector wizard
 * integration design, section 3.3, WP-3).
 *
 * What this module is and is not:
 *
 * - It exposes exactly the addon's functions with validated arguments and mapped errors.
 *   `registerCollectorHost`, `unregisterCollectorHost` and
 *   `replaceForeignCollectorHostRegistration` accept NO arguments, here and in the
 *   addon, so no caller can choose a key, a value or a path. Registry reads are
 *   read-only. There is no generic registry write or delete.
 * - It does not implement the integration state machine, any UI or any file placement
 *   (WP-5a/5b/7); those inject a `CollectorRegistryAdapter` (see
 *   `collector-registry-adapter.ts`).
 * - Addon location is code, not configuration: packaged builds load exactly
 *   `<resources>/windows-integration/windows_integration.node`; development builds load
 *   exactly the `node-gyp` output relative to this compiled module. No environment
 *   variable, working directory or argv participates (a source-scan test enforces it).
 */
import { createRequire } from "node:module";
import { lstatSync } from "node:fs";
import path from "node:path";

/** The Native Messaging host name (design 3.3, pinned constant). */
export const COLLECTOR_HOST_NAME = "org.maginalia.collector";
/** `HKCU` key whose default value is the manifest path. Used only for READING here; the addon owns the write. */
export const COLLECTOR_HOST_REGISTRY_SUBKEY =
  "Software\\Google\\Chrome\\NativeMessagingHosts\\org.maginalia.collector";
export const COLLECTOR_PROGRAM_FOLDER_NAME = "MAGINALIA Collector";
export const COLLECTOR_MANIFEST_FILE_NAME = "org.maginalia.collector.json";

export const WINDOWS_INTEGRATION_ADDON_FILE_NAME = "windows_integration.node";
export const WINDOWS_INTEGRATION_RESOURCE_DIRECTORY = "windows-integration";

export type KnownFolderId = "UserProgramFiles" | "LocalAppData" | "ProgramFiles" | "ProgramFilesX86";
export const KNOWN_FOLDER_IDS: readonly KnownFolderId[] = Object.freeze([
  "UserProgramFiles",
  "LocalAppData",
  "ProgramFiles",
  "ProgramFilesX86",
]);
export type RegistryHive = "HKCU" | "HKLM";
export type RegistryView = "default" | "64" | "32";

/** A registry value as read. `expand-sz` is never expanded; `other` carries no value. */
export type RegistryValue =
  | { readonly type: "sz" | "expand-sz"; readonly value: string }
  | { readonly type: "dword"; readonly value: number }
  | { readonly type: "other"; readonly value: null };

export type RegisterOutcome = "ok" | "foreign" | "access-denied" | "failed";
export type UnregisterOutcome = "ok" | "not-registered" | "foreign" | "access-denied" | "failed";

export type WindowsIntegrationErrorCode =
  | "windows-integration-unavailable"
  | "windows-integration-invalid-argument"
  | "windows-integration-known-folder-unavailable"
  | "windows-integration-access-denied"
  | "windows-integration-failed";

export class WindowsIntegrationError extends Error {
  public constructor(
    public readonly code: WindowsIntegrationErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "WindowsIntegrationError";
  }
}

function fail(code: WindowsIntegrationErrorCode, message: string, detail?: string): never {
  throw new WindowsIntegrationError(code, message, detail);
}

/** Raw shape of the addon. Wrapper tests supply a fake of this. */
export interface WindowsIntegrationNative {
  readonly apiVersion: number;
  getKnownFolderPath(id: string): unknown;
  readRegistryValue(hive: string, subkey: string, name: string, view: string): unknown;
  readRegistryValueNames(hive: string, subkey: string, view: string): unknown;
  registerCollectorHost(): unknown;
  unregisterCollectorHost(): unknown;
  replaceForeignCollectorHostRegistration(): unknown;
}

/** The exact property names the product addon exports (plus `apiVersion`). */
export const WINDOWS_INTEGRATION_NATIVE_EXPORTS: readonly string[] = Object.freeze([
  "apiVersion",
  "getKnownFolderPath",
  "readRegistryValue",
  "readRegistryValueNames",
  "registerCollectorHost",
  "replaceForeignCollectorHostRegistration",
  "unregisterCollectorHost",
]);

export interface WindowsIntegration {
  /** `SHGetKnownFolderPath` for a fixed set of folders; always a local-drive absolute path. */
  getKnownFolderPath(id: KnownFolderId): string;
  /** Read-only. `null` when the key or value does not exist. Strings are UTF-16 decoded. */
  readRegistryValue(hive: RegistryHive, subkey: string, name: string, view: RegistryView): RegistryValue | null;
  /** Read-only. Value names directly under a key; `null` when the key does not exist. */
  readRegistryValueNames(hive: RegistryHive, subkey: string, view: RegistryView): readonly string[] | null;
  /** No arguments. Writes the fixed HKCU key to the fixed manifest path. Never overwrites a foreign value. */
  registerCollectorHost(): RegisterOutcome;
  /** No arguments. Deletes the fixed key only when its default value is our manifest path. */
  unregisterCollectorHost(): UnregisterOutcome;
  /** No arguments. Same write as `registerCollectorHost`, replacing a foreign value (after user confirmation). */
  replaceForeignCollectorHostRegistration(): RegisterOutcome;
}

const MAX_SUBKEY_LENGTH = 1024;
const MAX_VALUE_NAME_LENGTH = 16383;

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail("windows-integration-invalid-argument", `Invalid ${label}.`);
  }
  return value as T;
}

function assertText(value: unknown, label: string, options: { readonly nonEmpty: boolean; readonly max: number }): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > options.max || (options.nonEmpty && value.length === 0)) {
    fail("windows-integration-invalid-argument", `Invalid ${label}.`);
  }
  return value;
}

function nativeCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Map an addon exception to a `WindowsIntegrationError`. The addon never throws for expected outcomes. */
export function translateNativeError(error: unknown): WindowsIntegrationError {
  if (error instanceof WindowsIntegrationError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  switch (nativeCode(error)) {
    case "invalid-argument":
      return new WindowsIntegrationError("windows-integration-invalid-argument", "The Windows integration addon rejected an argument.", detail);
    case "known-folder-unavailable":
      return new WindowsIntegrationError("windows-integration-known-folder-unavailable", "A Windows known folder is unavailable.", detail);
    case "registry-access-denied":
      return new WindowsIntegrationError("windows-integration-access-denied", "Windows denied access to the registry key.", detail);
    default:
      return new WindowsIntegrationError("windows-integration-failed", "A Windows integration call failed.", detail);
  }
}

function isLocalDriveAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) && !value.includes("\0");
}

function interpretStatus<T extends string>(raw: unknown, allowed: readonly T[], label: string): T {
  const status = typeof raw === "object" && raw !== null ? (raw as { readonly status?: unknown }).status : undefined;
  if (typeof status !== "string" || !(allowed as readonly string[]).includes(status)) {
    fail("windows-integration-failed", `The Windows integration addon returned an unexpected ${label} result.`);
  }
  return status as T;
}

const REGISTER_STATUSES = ["ok", "foreign", "access-denied", "failed"] as const;
const UNREGISTER_STATUSES = ["ok", "not-registered", "foreign", "access-denied", "failed"] as const;

/** Wrap a native module with argument validation and error mapping. */
export function createWindowsIntegration(native: WindowsIntegrationNative): WindowsIntegration {
  const guarded = <T>(call: () => T): T => {
    try {
      return call();
    } catch (error: unknown) {
      throw translateNativeError(error);
    }
  };

  return Object.freeze({
    getKnownFolderPath(id: KnownFolderId): string {
      const checked = assertOneOf(id, KNOWN_FOLDER_IDS, "known folder id");
      const value = guarded(() => native.getKnownFolderPath(checked));
      if (typeof value !== "string" || !isLocalDriveAbsolutePath(value)) {
        fail("windows-integration-known-folder-unavailable", "A Windows known folder did not resolve to a local absolute path.");
      }
      return value;
    },

    readRegistryValue(hive: RegistryHive, subkey: string, name: string, view: RegistryView): RegistryValue | null {
      const checkedHive = assertOneOf(hive, ["HKCU", "HKLM"] as const, "registry hive");
      const checkedSubkey = assertText(subkey, "registry subkey", { nonEmpty: true, max: MAX_SUBKEY_LENGTH });
      const checkedName = assertText(name, "registry value name", { nonEmpty: false, max: MAX_VALUE_NAME_LENGTH });
      const checkedView = assertOneOf(view, ["default", "64", "32"] as const, "registry view");
      const raw = guarded(() => native.readRegistryValue(checkedHive, checkedSubkey, checkedName, checkedView));
      if (raw === null) return null;
      if (typeof raw === "object" && raw !== undefined) {
        const { type, value } = raw as { readonly type?: unknown; readonly value?: unknown };
        if ((type === "sz" || type === "expand-sz") && typeof value === "string") return Object.freeze({ type, value });
        if (type === "dword" && typeof value === "number" && Number.isInteger(value) && value >= 0) return Object.freeze({ type, value });
        if (type === "other") return Object.freeze({ type, value: null });
      }
      return fail("windows-integration-failed", "The Windows integration addon returned an unexpected registry value.");
    },

    readRegistryValueNames(hive: RegistryHive, subkey: string, view: RegistryView): readonly string[] | null {
      const checkedHive = assertOneOf(hive, ["HKCU", "HKLM"] as const, "registry hive");
      const checkedSubkey = assertText(subkey, "registry subkey", { nonEmpty: true, max: MAX_SUBKEY_LENGTH });
      const checkedView = assertOneOf(view, ["default", "64", "32"] as const, "registry view");
      const raw = guarded(() => native.readRegistryValueNames(checkedHive, checkedSubkey, checkedView));
      if (raw === null) return null;
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
        fail("windows-integration-failed", "The Windows integration addon returned unexpected registry value names.");
      }
      return Object.freeze([...(raw as string[])]);
    },

    // These three are declared without parameters and refuse any argument at runtime, so
    // there is no way to hand a path, key or value to the writer (`arguments` is deliberate).
    registerCollectorHost(this: void): RegisterOutcome {
      if (arguments.length > 0) fail("windows-integration-invalid-argument", "registerCollectorHost takes no arguments.");
      return interpretStatus(guarded(() => native.registerCollectorHost()), REGISTER_STATUSES, "register");
    },

    unregisterCollectorHost(this: void): UnregisterOutcome {
      if (arguments.length > 0) fail("windows-integration-invalid-argument", "unregisterCollectorHost takes no arguments.");
      return interpretStatus(guarded(() => native.unregisterCollectorHost()), UNREGISTER_STATUSES, "unregister");
    },

    replaceForeignCollectorHostRegistration(this: void): RegisterOutcome {
      if (arguments.length > 0) fail("windows-integration-invalid-argument", "replaceForeignCollectorHostRegistration takes no arguments.");
      return interpretStatus(guarded(() => native.replaceForeignCollectorHostRegistration()), REGISTER_STATUSES, "replace");
    },
  });
}

/** Where `<programFiles>\MAGINALIA Collector\org.maginalia.collector.json` lives for a given UserProgramFiles folder. */
export function collectorManifestPathFor(userProgramFilesFolder: string): string {
  return path.win32.join(userProgramFilesFolder, COLLECTOR_PROGRAM_FOLDER_NAME, COLLECTOR_MANIFEST_FILE_NAME);
}

// ----- Addon location ("addon location is code, not configuration") ----------------------

const ADDON_DEVELOPMENT_PATH = path.join("native", "windows-integration", "build", "Release", WINDOWS_INTEGRATION_ADDON_FILE_NAME);
const ADDON_RESOURCE_PATH = path.join(WINDOWS_INTEGRATION_RESOURCE_DIRECTORY, WINDOWS_INTEGRATION_ADDON_FILE_NAME);

export interface WindowsIntegrationAddonCandidateOptions {
  /** Electron's `process.resourcesPath`, or undefined in plain Node. */
  readonly resourcesPath?: string | undefined;
  /** Electron's `process.defaultApp`; `true` means "dev Electron launched with a script". */
  readonly defaultApp?: boolean | undefined;
  /** `__dirname` of the compiled module (`dist/main`). */
  readonly moduleDirectory?: string | undefined;
}

export interface WindowsIntegrationAddonResolution {
  readonly mode: "packaged" | "development";
  readonly candidates: readonly string[];
}

/**
 * Packaged: exactly one path, `<resources>/windows-integration/windows_integration.node`.
 * Development (plain Node, tests, `electron <script>`): exactly one path, the `node-gyp`
 * output relative to the compiled module. There is no environment override and no
 * working-directory lookup.
 */
export function resolveWindowsIntegrationAddonCandidates(
  options: WindowsIntegrationAddonCandidateOptions,
): WindowsIntegrationAddonResolution {
  const { resourcesPath, defaultApp, moduleDirectory } = options;
  if (typeof resourcesPath === "string" && resourcesPath.length > 0 && defaultApp !== true) {
    return Object.freeze({ mode: "packaged", candidates: Object.freeze([path.resolve(resourcesPath, ADDON_RESOURCE_PATH)]) });
  }
  const candidates = typeof moduleDirectory === "string" && moduleDirectory.length > 0
    ? [path.resolve(moduleDirectory, "..", "..", ADDON_DEVELOPMENT_PATH)]
    : [];
  return Object.freeze({ mode: "development", candidates: Object.freeze(candidates) });
}

function isRegularFileInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    const info = lstatSync(candidate);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export interface WindowsIntegrationLoaderDeps {
  /** Loads one `.node` file. Defaults to `createRequire`. */
  readonly requireNative?: (candidate: string) => unknown;
  /** Checks a packaged candidate is a real file inside resources. Defaults to an `lstat` check. */
  readonly isTrustedPackagedFile?: (resources: string, candidate: string) => boolean;
}

/** Load and wrap the addon from the resolved candidates. Throws `windows-integration-unavailable`. */
export function loadWindowsIntegrationFrom(
  resolution: WindowsIntegrationAddonResolution,
  resourcesPath: string | undefined,
  deps: WindowsIntegrationLoaderDeps = {},
): WindowsIntegration {
  const load = deps.requireNative ?? ((candidate: string) => createRequire(candidate)(candidate));
  const trusted = deps.isTrustedPackagedFile ?? isRegularFileInside;
  const attempts: string[] = [];
  for (const candidate of resolution.candidates) {
    if (resolution.mode === "packaged" && !trusted(resourcesPath ?? "", candidate)) {
      attempts.push(`${candidate}: not a trusted file inside the packaged resources directory`);
      continue;
    }
    try {
      const loaded = load(candidate) as Partial<WindowsIntegrationNative> | null;
      const missing = loaded === null || typeof loaded !== "object"
        ? WINDOWS_INTEGRATION_NATIVE_EXPORTS
        : WINDOWS_INTEGRATION_NATIVE_EXPORTS.filter((name) => name === "apiVersion"
          ? typeof loaded.apiVersion !== "number"
          : typeof (loaded as Record<string, unknown>)[name] !== "function");
      if (missing.length > 0) {
        attempts.push(`${candidate}: not a Windows integration addon (missing ${missing.join(", ")})`);
        continue;
      }
      return createWindowsIntegration(loaded as WindowsIntegrationNative);
    } catch (error: unknown) {
      attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fail("windows-integration-unavailable", "The Windows integration addon could not be loaded.", attempts.join("; "));
}

let cached: WindowsIntegration | undefined;

/** Load the addon once for the process. A missing binary reports `windows-integration-unavailable`. */
export function loadWindowsIntegration(): WindowsIntegration {
  if (cached !== undefined) return cached;
  const processLike = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  const resolution = resolveWindowsIntegrationAddonCandidates({
    resourcesPath: processLike.resourcesPath,
    defaultApp: processLike.defaultApp,
    moduleDirectory: typeof __dirname === "string" ? __dirname : undefined,
  });
  cached = loadWindowsIntegrationFrom(resolution, processLike.resourcesPath);
  return cached;
}
