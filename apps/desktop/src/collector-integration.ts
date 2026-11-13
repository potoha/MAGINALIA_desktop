/**
 * Read-only inspection of the Collector integration (design 3.5, WP-5a).
 *
 * `inspectCollectorIntegration()` computes one of the seven states of design 3.5 from
 * injected adapters only:
 *
 * - `CollectorRegistryAdapter`: known folders, the single native registration verdict,
 *   Chrome policies, App Paths and the default-browser ProgId;
 * - `CollectorIntegrationFileSystem`: `lstat`, bounded reads and SHA-256 (read-only);
 * - `PathSecurityInspector` + `evaluatePathSecurity`: the existing ACL checks;
 * - `readPayloadDescriptor()`: the packaged payload descriptor (validated here).
 *
 * Rules this module keeps (a source-scan test enforces the mechanical ones):
 *
 * - no environment, cwd, argv or Electron path reads; no write of any kind; no process
 *   spawn; no registry write (the adapter's mutating methods are never referenced);
 * - the result carries opaque reason codes, never paths. The one exception is
 *   `extensionFolderDisplay`. Chrome's real location is returned only by
 *   `locateChromeExecutable()`, for the main process (design 4.5 launches it), never by
 *   `inspectCollectorIntegration()`;
 * - the contact record is displayed, never trusted for any decision;
 * - an inspection that cannot finish fails closed to `damaged` with
 *   `inspectionComplete: false`; it never throws.
 *
 * State precedence: `policy-blocked` first (Chrome ignores the registration, and a write
 * cannot fix it), then `foreign-registration`, then the program-folder and file checks.
 */
import * as path from "node:path";
import { COLLECTOR_HOST_NAME, COLLECTOR_MANIFEST_FILE_NAME, COLLECTOR_PROGRAM_FOLDER_NAME, type HostRegistrationOwnership } from "./windows-integration.js";
import type { ChromeAppPathValue, ChromePolicyHiveFacts, ChromePolicySnapshot, CollectorRegistryAdapter } from "./collector-registry-adapter.js";
import {
  inspectAndEvaluatePathSecurity,
  type PathSecurityInspector,
  type PathSecurityViolation,
} from "./collector-path-security.js";
import { resolveShelfBindingStoragePaths } from "./shelf-binding-store.js";
import {
  COLLECTOR_ALLOWED_ORIGINS,
  COLLECTOR_EXTENSION_ID,
  COLLECTOR_HOST_ADDON_NAME,
  COLLECTOR_HOST_EXECUTABLE_NAME,
  COLLECTOR_PROTOCOL,
  parseCollectorPayloadDescriptor,
  type CollectorPayloadDescriptor,
} from "./collector-payload.js";
import { compareCollectorVersions, parseCollectorVersion, type VersionComparison } from "./collector-version.js";
import type {
  ChromeCandidateRejection,
  ChromeDetection,
  ChromeLocation,
  ChromePolicyEvaluation,
  ChromeRejectedCandidate,
  ChromeSource,
  CollectorContactInvalidReason,
  CollectorContactRecord,
  CollectorContactStatus,
  CollectorFileEntry,
  CollectorInspectOptions,
  CollectorIntegrationFileSystem,
  CollectorIntegrationInspection,
  CollectorIntegrationReason,
  CollectorIntegrationState,
  DefaultBrowserKind,
} from "./collector-integration-types.js";

export const COLLECTOR_STATE_FILE_NAME = "integration-state.json";
export const COLLECTOR_EXTENSION_FOLDER_NAME = "extension";
export const COLLECTOR_CONTACT_FILE_NAME = "collector-contact.json";
export const COLLECTOR_HOST_SLOTS = ["a", "b"] as const;
export type CollectorHostSlot = (typeof COLLECTOR_HOST_SLOTS)[number];

const MAX_STATE_BYTES = 4096;
const MAX_MANIFEST_BYTES = 8192;
const MAX_CONTACT_BYTES = 4096;
const MAX_EXTENSION_MANIFEST_BYTES = 64 * 1024;
/** A contact timestamp this far ahead of the injected clock is treated as invalid. */
const CONTACT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface CollectorIntegrationInspectDependencies {
  readonly registry: CollectorRegistryAdapter;
  readonly fileSystem: CollectorIntegrationFileSystem;
  /** Native `inspectPathSecurity` (or a fake): the existing ACL / reparse facts. */
  readonly inspectPathSecurity: PathSecurityInspector;
  /** Returns the parsed JSON of `collector-payload.json`; may throw when unavailable. */
  readonly readPayloadDescriptor: () => Promise<unknown>;
  readonly now: () => Date;
  /**
   * `true` when the launch is the E2E-isolated one. The composition root decides (this module
   * reads no environment). Inspection works unchanged; only `writesAllowed` reflects it.
   */
  readonly e2eIsolationActive: boolean;
}

// ----- Paths --------------------------------------------------------------------------------

/** Absolute, local, drive-letter, canonical Windows path. No UNC, device, relative or variable forms. */
export function isLocalAbsoluteWindowsPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 260) return false;
  if (!/^[A-Za-z]:\\/u.test(value)) return false;
  if (value.includes("/") || value.includes("%") || /[\u0000-\u001f"<>|*?]/u.test(value) || value.indexOf(":", 2) !== -1) return false;
  return path.win32.normalize(value) === value && !value.endsWith("\\");
}

export interface IntegrationPaths {
  readonly programFolder: string;
  readonly manifestPath: string;
  readonly statePath: string;
  readonly extensionFolder: string;
  readonly applicationRoot: string;
  readonly integrationDirectory: string;
  readonly contactPath: string;
  readonly localAppData: string;
}

export function slotFolder(paths: IntegrationPaths, slot: CollectorHostSlot): string {
  return path.win32.join(paths.programFolder, `host-${slot}`);
}

export function resolveIntegrationPaths(registry: CollectorRegistryAdapter): IntegrationPaths | undefined {
  try {
    const userProgramFiles = registry.getKnownFolderPath("UserProgramFiles");
    const localAppData = registry.getKnownFolderPath("LocalAppData");
    if (!isLocalAbsoluteWindowsPath(userProgramFiles) || !isLocalAbsoluteWindowsPath(localAppData)) return undefined;
    const storage = resolveShelfBindingStoragePaths(localAppData);
    const programFolder = path.win32.join(userProgramFiles, COLLECTOR_PROGRAM_FOLDER_NAME);
    return Object.freeze({
      programFolder,
      manifestPath: path.win32.join(programFolder, COLLECTOR_MANIFEST_FILE_NAME),
      statePath: path.win32.join(programFolder, COLLECTOR_STATE_FILE_NAME),
      extensionFolder: path.win32.join(programFolder, COLLECTOR_EXTENSION_FOLDER_NAME),
      applicationRoot: path.win32.dirname(storage.bindingDirectory),
      integrationDirectory: storage.bindingDirectory,
      contactPath: path.win32.join(storage.bindingDirectory, COLLECTOR_CONTACT_FILE_NAME),
      localAppData: storage.localAppData,
    });
  } catch {
    return undefined;
  }
}

// ----- Policies (design 8.4) ----------------------------------------------------------------

function effectiveScalar(snapshot: ChromePolicySnapshot, pick: (facts: ChromePolicyHiveFacts) => number | null): number | null {
  // Machine policy wins over user policy.
  return pick(snapshot.hklm) ?? pick(snapshot.hkcu);
}

function unionList(snapshot: ChromePolicySnapshot, pick: (facts: ChromePolicyHiveFacts) => readonly string[] | null): readonly string[] {
  return [...(pick(snapshot.hklm) ?? []), ...(pick(snapshot.hkcu) ?? [])];
}

export function evaluateChromePolicies(snapshot: ChromePolicySnapshot): ChromePolicyEvaluation {
  const userLevelHostsDisabled = effectiveScalar(snapshot, (facts) => facts.nativeMessagingUserLevelHosts) === 0;
  const blocklist = unionList(snapshot, (facts) => facts.nativeMessagingBlocklist);
  const allowlist = unionList(snapshot, (facts) => facts.nativeMessagingAllowlist);
  const hostBlocked = (blocklist.includes("*") || blocklist.includes(COLLECTOR_HOST_NAME)) && !allowlist.includes(COLLECTOR_HOST_NAME);
  const extensionBlocklist = unionList(snapshot, (facts) => facts.extensionInstallBlocklist);
  const extensionAllowlist = unionList(snapshot, (facts) => facts.extensionInstallAllowlist);
  const extensionLoadMayBeBlocked = effectiveScalar(snapshot, (facts) => facts.developerToolsAvailability) === 2
    || ((extensionBlocklist.includes("*") || extensionBlocklist.includes(COLLECTOR_EXTENSION_ID)) && !extensionAllowlist.includes(COLLECTOR_EXTENSION_ID));
  return Object.freeze({
    userLevelHostsDisabled,
    hostBlocked,
    blocked: userLevelHostsDisabled || hostBlocked,
    extensionLoadMayBeBlocked,
  });
}

// ----- Chrome locator (design 4.2) ----------------------------------------------------------

interface ChromeCandidate {
  readonly source: ChromeSource;
  readonly value: string;
}

const APP_PATH_SOURCES: Readonly<Record<ChromeAppPathValue["source"], ChromeSource>> = {
  hkcu: "app-paths-hkcu",
  "hklm-64": "app-paths-hklm-64",
  "hklm-32": "app-paths-hklm-32",
};

const CHROME_RELATIVE = ["Google", "Chrome", "Application", "chrome.exe"] as const;

async function validateChromeCandidate(
  fileSystem: CollectorIntegrationFileSystem,
  rawValue: string,
): Promise<{ readonly ok: true; readonly executablePath: string } | { readonly ok: false; readonly reason: ChromeCandidateRejection }> {
  // App Paths values are sometimes quoted. A REG_EXPAND_SZ value is never expanded here.
  const value = rawValue.length >= 2 && rawValue.startsWith("\"") && rawValue.endsWith("\"") ? rawValue.slice(1, -1) : rawValue;
  if (value.includes("%")) return { ok: false, reason: "unexpanded-variable" };
  if (!isLocalAbsoluteWindowsPath(value)) return { ok: false, reason: "not-absolute-local" };
  if (path.win32.basename(value).toLowerCase() !== "chrome.exe") return { ok: false, reason: "wrong-basename" };
  try {
    // Every component below the drive root must exist, be a directory (the last: a regular
    // file) and not be a reparse point.
    const parsed = path.win32.parse(value);
    const components = value.slice(parsed.root.length).split("\\");
    let current = parsed.root;
    for (let index = 0; index < components.length; index += 1) {
      current = path.win32.join(current, components[index] as string);
      const entry = await fileSystem.stat(current);
      if (entry === null) return { ok: false, reason: "missing" };
      if (entry.isReparsePoint) return { ok: false, reason: "reparse-point" };
      const last = index === components.length - 1;
      if (last ? entry.kind !== "file" : entry.kind !== "directory") return { ok: false, reason: "not-regular-file" };
    }
  } catch {
    return { ok: false, reason: "read-failed" };
  }
  return { ok: true, executablePath: value };
}

/**
 * Main-process Chrome locator. Candidate order follows design 4.2. Returns the validated
 * path for the main process only: callers must not log it or send it to the renderer.
 */
export async function locateChromeExecutable(
  dependencies: Pick<CollectorIntegrationInspectDependencies, "registry" | "fileSystem">,
): Promise<ChromeLocation> {
  const candidates: ChromeCandidate[] = [];
  try {
    for (const entry of dependencies.registry.readChromeAppPaths()) {
      candidates.push({ source: APP_PATH_SOURCES[entry.source], value: entry.value });
    }
    const known: ReadonlyArray<readonly [ChromeSource, "LocalAppData" | "ProgramFiles" | "ProgramFilesX86"]> = [
      ["known-local-app-data", "LocalAppData"],
      ["known-program-files", "ProgramFiles"],
      ["known-program-files-x86", "ProgramFilesX86"],
    ];
    for (const [source, id] of known) {
      const base = dependencies.registry.getKnownFolderPath(id);
      candidates.push({ source, value: path.win32.join(base, ...CHROME_RELATIVE) });
    }
  } catch {
    return { status: "unknown" };
  }
  const rejected: ChromeRejectedCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await validateChromeCandidate(dependencies.fileSystem, candidate.value);
    if (result.ok) return { status: "found", source: candidate.source, executablePath: result.executablePath, rejected: Object.freeze(rejected) };
    rejected.push(Object.freeze({ source: candidate.source, reason: result.reason }));
  }
  return { status: "not-found", rejected: Object.freeze(rejected) };
}

/** Classifies the `https` handler ProgId. Only used to tailor copy; never blocks. */
export function classifyDefaultBrowser(progId: string | null): DefaultBrowserKind {
  if (progId === null) return "unknown";
  if (/^ChromeHTML(?:\.|$)/iu.test(progId)) return "chrome";
  if (/^MSEdge(?:HTM|HTML)(?:\.|$)/iu.test(progId)) return "edge";
  if (/^(?:BraveHTML|BraveFile|VivaldiHTM|OperaStable|Opera|ChromiumHTM|ArcHTML|ChromeBHTML|ChromeSSHTM|YandexHTML|CocCocHTML)/iu.test(progId)) return "other-chromium";
  return "other";
}

async function detectChrome(
  dependencies: CollectorIntegrationInspectDependencies,
): Promise<ChromeDetection> {
  let defaultBrowser: DefaultBrowserKind = "unknown";
  try {
    defaultBrowser = classifyDefaultBrowser(dependencies.registry.readDefaultBrowserProgId());
  } catch {
    defaultBrowser = "unknown"; // tailoring only; never blocks
  }
  const location = await locateChromeExecutable(dependencies);
  if (location.status === "found") return Object.freeze({ status: "found", source: location.source, rejected: location.rejected, defaultBrowser });
  if (location.status === "not-found") return Object.freeze({ status: "not-found", source: null, rejected: location.rejected, defaultBrowser });
  return Object.freeze({ status: "unknown", source: null, rejected: Object.freeze([]), defaultBrowser });
}

// ----- Contact record (display only) --------------------------------------------------------

const CONTACT_FIELDS = ["version", "protocol", "hostVersion", "extensionVersion", "contactedAt"] as const;
const CONTACT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function parseCollectorContactRecord(
  text: string,
  now: Date,
): { readonly ok: true; readonly record: CollectorContactRecord } | { readonly ok: false; readonly reason: CollectorContactInvalidReason } {
  const fail = (reason: CollectorContactInvalidReason): { ok: false; reason: CollectorContactInvalidReason } => ({ ok: false, reason });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("not-json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("not-an-object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CONTACT_FIELDS.length || !CONTACT_FIELDS.every((field) => Object.hasOwn(record, field))) return fail("unexpected-fields");
  if (record.version !== 1) return fail("wrong-version");
  if (record.protocol !== COLLECTOR_PROTOCOL) return fail("wrong-protocol");
  if (parseCollectorVersion(record.hostVersion) === undefined) return fail("invalid-host-version");
  if (parseCollectorVersion(record.extensionVersion) === undefined) return fail("invalid-extension-version");
  const stamp = record.contactedAt;
  if (typeof stamp !== "string" || !CONTACT_TIMESTAMP_PATTERN.test(stamp)) return fail("invalid-timestamp");
  const parsed = new Date(stamp);
  // Round-trip the date and time so that impossible dates (February 30) are rejected.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== stamp.slice(0, 19)) return fail("invalid-timestamp");
  if (parsed.getTime() > now.getTime() + CONTACT_FUTURE_TOLERANCE_MS) return fail("future-timestamp");
  return {
    ok: true,
    record: Object.freeze({
      version: 1 as const,
      protocol: record.protocol as string,
      hostVersion: record.hostVersion as string,
      extensionVersion: record.extensionVersion as string,
      contactedAt: stamp,
    }),
  };
}

async function readContact(
  dependencies: CollectorIntegrationInspectDependencies,
  paths: IntegrationPaths,
  placedExtensionVersion: string | null,
  payload: CollectorPayloadDescriptor | null,
): Promise<CollectorContactStatus> {
  // The record is only read when the integration folder passes the existing ACL checks
  // (design 4.6). Missing folders are "absent", not a violation.
  for (const folder of [paths.applicationRoot, paths.integrationDirectory]) {
    const result = inspectAndEvaluatePathSecurity(dependencies.inspectPathSecurity, folder, "directory", { optional: true });
    if (!result.ok) return Object.freeze({ status: "unavailable", violation: result.violation });
  }
  try {
    const entry = await dependencies.fileSystem.stat(paths.contactPath);
    if (entry === null) return Object.freeze({ status: "absent" });
    if (entry.isReparsePoint || entry.kind !== "file") return Object.freeze({ status: "invalid", reason: "reparse-point" });
    const read = await dependencies.fileSystem.readSmallFile(paths.contactPath, MAX_CONTACT_BYTES);
    if (read.kind === "missing") return Object.freeze({ status: "absent" });
    if (read.kind === "too-large") return Object.freeze({ status: "invalid", reason: "too-large" });
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return Object.freeze({ status: "invalid", reason: "not-json" });
    }
    const parsed = parseCollectorContactRecord(text, dependencies.now());
    if (!parsed.ok) return Object.freeze({ status: "invalid", reason: parsed.reason });
    return Object.freeze({
      status: "present",
      record: parsed.record,
      extensionVersionVsPlaced: placedExtensionVersion === null ? "not-placed" : compareCollectorVersions(parsed.record.extensionVersion, placedExtensionVersion),
      hostVersionVsPayload: payload === null ? "no-payload" : compareCollectorVersions(parsed.record.hostVersion, payload.host.version),
    });
  } catch {
    return Object.freeze({ status: "invalid", reason: "unreadable" });
  }
}

// ----- Installed state ----------------------------------------------------------------------

interface IntegrationStateFile {
  readonly version: 1;
  readonly payloadId: string;
  readonly activeSlot: CollectorHostSlot;
  readonly extensionVersion: string;
  readonly placedAt: string;
}

const STATE_FIELDS = ["version", "payloadId", "activeSlot", "extensionVersion", "placedAt"] as const;

export function parseIntegrationStateFile(text: string): IntegrationStateFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== STATE_FIELDS.length || !STATE_FIELDS.every((field) => Object.hasOwn(record, field))) return undefined;
  if (record.version !== 1 || typeof record.payloadId !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}\+[0-9A-Za-z]{1,40}$/u.test(record.payloadId)) return undefined;
  if (record.activeSlot !== "a" && record.activeSlot !== "b") return undefined;
  if (parseCollectorVersion(record.extensionVersion) === undefined) return undefined;
  if (typeof record.placedAt !== "string" || !CONTACT_TIMESTAMP_PATTERN.test(record.placedAt)) return undefined;
  return Object.freeze({
    version: 1 as const,
    payloadId: record.payloadId,
    activeSlot: record.activeSlot,
    extensionVersion: record.extensionVersion as string,
    placedAt: record.placedAt,
  });
}

/** The manifest the app generates (design 3.4). Content, not bytes, is compared. */
export function expectedHostManifest(slot: CollectorHostSlot): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: COLLECTOR_HOST_NAME,
    description: "MAGINALIA Collector Native Messaging Host",
    path: `host-${slot}\\${COLLECTOR_HOST_EXECUTABLE_NAME}`,
    type: "stdio",
    allowed_origins: COLLECTOR_ALLOWED_ORIGINS,
  });
}

function manifestMatches(value: unknown, slot: CollectorHostSlot, programFolder: string): "ok" | "invalid" | "mismatch" {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const record = value as Record<string, unknown>;
  const expected = expectedHostManifest(slot);
  const expectedKeys = Object.keys(expected);
  if (Object.keys(record).length !== expectedKeys.length || !expectedKeys.every((key) => Object.hasOwn(record, key))) return "mismatch";
  for (const key of ["name", "description", "type"]) if (record[key] !== expected[key]) return "mismatch";
  const origins = record.allowed_origins;
  if (!Array.isArray(origins) || origins.length !== COLLECTOR_ALLOWED_ORIGINS.length || !origins.every((origin, index) => origin === COLLECTOR_ALLOWED_ORIGINS[index])) return "mismatch";
  const relative = expected.path as string;
  const absolute = path.win32.join(programFolder, relative);
  // The relative form is the design; the absolute form is the documented fallback (design 3.4).
  return record.path === relative || (typeof record.path === "string" && record.path.toLowerCase() === absolute.toLowerCase()) ? "ok" : "mismatch";
}

// ----- Inspection ---------------------------------------------------------------------------

class ReasonSink {
  public readonly reasons: CollectorIntegrationReason[] = [];
  public add(reason: CollectorIntegrationReason): void {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }
}

interface StructureResult {
  readonly extensionVersionOnDisk: string | null;
}

async function checkStructure(
  fileSystem: CollectorIntegrationFileSystem,
  paths: IntegrationPaths,
  state: IntegrationStateFile,
  sink: ReasonSink,
): Promise<StructureResult> {
  // Generated manifest content (design 3.4).
  const manifestEntry = await fileSystem.stat(paths.manifestPath);
  if (manifestEntry === null) {
    sink.add("manifest-missing");
  } else if (manifestEntry.isReparsePoint) {
    sink.add("reparse-point-found");
  } else if (manifestEntry.kind !== "file") {
    sink.add("manifest-invalid");
  } else {
    const read = await fileSystem.readSmallFile(paths.manifestPath, MAX_MANIFEST_BYTES);
    if (read.kind !== "ok") {
      sink.add(read.kind === "missing" ? "manifest-missing" : "manifest-invalid");
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
      } catch {
        parsed = undefined;
      }
      const verdict = parsed === undefined ? "invalid" : manifestMatches(parsed, state.activeSlot, paths.programFolder);
      if (verdict === "invalid") sink.add("manifest-invalid");
      else if (verdict === "mismatch") sink.add("manifest-mismatch");
    }
  }

  // Active slot and its files.
  const slot = slotFolder(paths, state.activeSlot);
  const slotEntry = await fileSystem.stat(slot);
  if (slotEntry === null || slotEntry.kind !== "directory") {
    sink.add("slot-missing");
  } else if (slotEntry.isReparsePoint) {
    sink.add("reparse-point-found");
  } else {
    for (const name of [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME]) {
      const entry = await fileSystem.stat(path.win32.join(slot, name));
      if (entry === null) sink.add("slot-file-missing");
      else if (entry.isReparsePoint) sink.add("reparse-point-found");
      else if (entry.kind !== "file") sink.add("slot-file-missing");
    }
  }

  // Extension folder and its manifest version.
  let extensionVersionOnDisk: string | null = null;
  const extensionEntry = await fileSystem.stat(paths.extensionFolder);
  if (extensionEntry === null || extensionEntry.kind !== "directory") {
    sink.add("extension-folder-missing");
  } else if (extensionEntry.isReparsePoint) {
    sink.add("reparse-point-found");
  } else {
    const manifestPath = path.win32.join(paths.extensionFolder, "manifest.json");
    const entry = await fileSystem.stat(manifestPath);
    if (entry === null) {
      sink.add("extension-file-missing");
    } else if (entry.isReparsePoint) {
      sink.add("reparse-point-found");
    } else if (entry.kind !== "file") {
      sink.add("extension-manifest-invalid");
    } else {
      const read = await fileSystem.readSmallFile(manifestPath, MAX_EXTENSION_MANIFEST_BYTES);
      let version: unknown;
      if (read.kind === "ok") {
        try {
          version = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as { version?: unknown }).version;
        } catch {
          version = undefined;
        }
      }
      if (typeof version !== "string" || parseCollectorVersion(version) === undefined) {
        sink.add("extension-manifest-invalid");
      } else {
        extensionVersionOnDisk = version;
        if (version !== state.extensionVersion) sink.add("extension-version-mismatch");
      }
    }
  }
  return { extensionVersionOnDisk };
}

async function verifyAgainstPayload(
  fileSystem: CollectorIntegrationFileSystem,
  paths: IntegrationPaths,
  state: IntegrationStateFile,
  payload: CollectorPayloadDescriptor,
  hashes: boolean,
  sink: ReasonSink,
): Promise<void> {
  const slot = slotFolder(paths, state.activeSlot);
  for (const [name, expected] of Object.entries(payload.host.files)) {
    if (!hashes) break; // presence was checked structurally
    const target = path.win32.join(slot, name);
    const actual = await fileSystem.sha256File(target);
    if (actual === null) sink.add("slot-file-missing");
    else if (actual !== expected) sink.add("slot-file-hash-mismatch");
  }
  for (const [name, expected] of Object.entries(payload.extension.files)) {
    const target = path.win32.join(paths.extensionFolder, ...name.split("/"));
    const entry = await fileSystem.stat(target);
    if (entry === null || entry.kind !== "file") {
      sink.add("extension-file-missing");
    } else if (entry.isReparsePoint) {
      sink.add("reparse-point-found");
    } else if (hashes) {
      const actual = await fileSystem.sha256File(target);
      if (actual === null) sink.add("extension-file-missing");
      else if (actual !== expected) sink.add("extension-file-hash-mismatch");
    }
  }
}

function hostVersionOf(payloadId: string): string {
  return payloadId.split("+")[0] as string;
}

/**
 * Read-only inspection. Never throws; never writes; never spawns. See the module comment
 * for the state precedence.
 */
export async function inspectCollectorIntegration(
  dependencies: CollectorIntegrationInspectDependencies,
  options: CollectorInspectOptions = {},
): Promise<CollectorIntegrationInspection> {
  const hashes = options.verifyFileHashes !== false;
  const sink = new ReasonSink();
  let complete = true;
  const incomplete = (reason: CollectorIntegrationReason): void => {
    complete = false;
    sink.add(reason);
  };

  const paths = resolveIntegrationPaths(dependencies.registry);
  if (paths === undefined) incomplete("known-folder-unavailable");

  let registration: HostRegistrationOwnership | "unknown" = "unknown";
  try {
    registration = dependencies.registry.readCollectorHostRegistration();
  } catch {
    incomplete("registry-read-failed");
  }

  let policy: ChromePolicyEvaluation = { userLevelHostsDisabled: false, hostBlocked: false, blocked: false, extensionLoadMayBeBlocked: false };
  let policyStatus: "read" | "unavailable" = "read";
  try {
    policy = evaluateChromePolicies(dependencies.registry.readChromePolicies());
  } catch {
    policyStatus = "unavailable"; // Chrome stays the authority; this never blocks by itself
  }

  const chrome = await detectChrome(dependencies);

  let payloadStatus: "valid" | "invalid" | "unavailable" = "unavailable";
  let payload: CollectorPayloadDescriptor | null = null;
  try {
    const parsed = parseCollectorPayloadDescriptor(await dependencies.readPayloadDescriptor());
    if (parsed.ok) {
      payload = parsed.descriptor;
      payloadStatus = "valid";
    } else {
      payloadStatus = "invalid";
    }
  } catch {
    payloadStatus = "unavailable";
  }

  let folderViolation: PathSecurityViolation | null = null;
  let state: CollectorIntegrationState = "damaged";
  let installedState: IntegrationStateFile | null = null;
  let extensionVersionOnDisk: string | null = null;
  let filesVerified = false;
  let hostVersionComparison: VersionComparison | "not-installed" = "not-installed";
  let extensionVersionComparison: VersionComparison | "not-installed" = "not-installed";

  if (policy.blocked) {
    state = "policy-blocked";
    if (policy.userLevelHostsDisabled) sink.add("policy-user-level-hosts-disabled");
    if (policy.hostBlocked) sink.add("policy-host-blocklisted");
  } else if (!complete || paths === undefined) {
    state = "damaged";
  } else if (registration === "foreign") {
    state = "foreign-registration";
    sink.add("registration-foreign");
  } else {
    try {
      const folderEntry = await dependencies.fileSystem.stat(paths.programFolder);
      if (folderEntry === null) {
        if (registration === "ours") {
          state = "damaged";
          sink.add("program-folder-missing");
        } else {
          state = "not-set-up";
        }
      } else {
        const security = inspectAndEvaluatePathSecurity(dependencies.inspectPathSecurity, paths.programFolder, "directory");
        if (!security.ok || folderEntry.kind !== "directory" || folderEntry.isReparsePoint) {
          state = "damaged";
          if (!security.ok && security.violation === "missing") {
            sink.add("program-folder-missing");
          } else {
            folderViolation = security.ok ? "wrong-entry-type" : security.violation;
            sink.add("program-folder-unsafe");
          }
        } else {
          const stateRead = await dependencies.fileSystem.readSmallFile(paths.statePath, MAX_STATE_BYTES);
          let stateProblem: "state-file-missing" | "state-file-invalid" | null = null;
          if (stateRead.kind === "missing") {
            stateProblem = "state-file-missing";
          } else if (stateRead.kind === "too-large") {
            stateProblem = "state-file-invalid";
          } else {
            try {
              const parsed = parseIntegrationStateFile(new TextDecoder("utf-8", { fatal: true }).decode(stateRead.bytes));
              if (parsed === undefined) stateProblem = "state-file-invalid";
              else installedState = parsed;
            } catch {
              stateProblem = "state-file-invalid";
            }
          }

          if (registration === "absent") {
            if (installedState !== null) {
              state = "registration-missing";
              sink.add("registration-absent");
            } else {
              state = "not-set-up";
              sink.add("program-folder-unrecognized");
            }
          } else if (installedState === null) {
            state = "damaged";
            sink.add(stateProblem ?? "state-file-invalid");
          } else {
            const structure = await checkStructure(dependencies.fileSystem, paths, installedState, sink);
            extensionVersionOnDisk = structure.extensionVersionOnDisk;
            if (payload === null) {
              sink.add(payloadStatus === "invalid" ? "payload-descriptor-invalid" : "payload-descriptor-unavailable");
            } else {
              hostVersionComparison = compareCollectorVersions(hostVersionOf(installedState.payloadId), payload.host.version);
              extensionVersionComparison = compareCollectorVersions(extensionVersionOnDisk ?? installedState.extensionVersion, payload.extension.version);
            }
            if (sink.reasons.length > 0) {
              state = "damaged"; // structure or payload problems
            } else if (payload !== null && installedState.payloadId !== payload.payloadId) {
              state = "outdated";
              sink.add("payload-id-differs");
              if (hostVersionComparison === "older" || extensionVersionComparison === "older") sink.add("installed-older");
              else if (hostVersionComparison === "newer" || extensionVersionComparison === "newer") sink.add("installed-newer");
              else if (hostVersionComparison === "unparseable" || extensionVersionComparison === "unparseable") sink.add("installed-version-unparseable");
            } else if (payload !== null) {
              await verifyAgainstPayload(dependencies.fileSystem, paths, installedState, payload, hashes, sink);
              if (sink.reasons.length > 0) {
                state = "damaged";
              } else {
                state = "ready";
                filesVerified = hashes;
              }
            }
          }
        }
      }
    } catch {
      state = "damaged";
      incomplete("filesystem-read-failed");
    }
  }

  const contact = paths === undefined
    ? Object.freeze({ status: "absent" } as const)
    : await readContact(dependencies, paths, installedState?.extensionVersion ?? null, payload);

  return Object.freeze({
    state,
    reasons: Object.freeze([...sink.reasons]),
    inspectionComplete: complete,
    registration,
    folderSecurityViolation: folderViolation,
    payload: Object.freeze({ status: payloadStatus, payloadId: payload?.payloadId ?? null }),
    installed: Object.freeze({
      payloadId: installedState?.payloadId ?? null,
      activeSlot: installedState?.activeSlot ?? null,
      hostVersion: installedState === null ? null : hostVersionOf(installedState.payloadId),
      extensionVersion: extensionVersionOnDisk ?? installedState?.extensionVersion ?? null,
    }),
    versions: Object.freeze({ host: hostVersionComparison, extension: extensionVersionComparison }),
    filesVerified,
    policy: Object.freeze({ ...policy, status: policyStatus }),
    chrome,
    contact,
    extensionFolderDisplay: paths?.extensionFolder ?? null,
    writesAllowed: !dependencies.e2eIsolationActive,
  });
}
