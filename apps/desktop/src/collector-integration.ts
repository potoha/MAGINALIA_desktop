/**
 * Read-only inspection of the Collector integration (design 3.5, WP-5a).
 *
 * `inspectCollectorIntegration()` computes one of the seven states of design 3.5 from
 * injected adapters only:
 *
 * - `CollectorRegistryAdapter`: known folders, the native per-target registration verdicts,
 *   per-browser policies, App Paths and the default-browser ProgId;
 * - `CollectorIntegrationFileSystem`: `lstat`, bounded reads and SHA-256 (read-only);
 * - `PathSecurityInspector` + `evaluatePathSecurity`: the existing ACL checks;
 * - `readPayloadDescriptor()`: the packaged payload descriptor (validated here).
 *
 * Rules this module keeps (a source-scan test enforces the mechanical ones):
 *
 * - no environment, cwd, argv or Electron path reads; no write of any kind; no process
 *   spawn; no registry write (the adapter's mutating methods are never referenced);
 * - the result carries opaque reason codes, never paths. The one exception is
 *   `extensionFolderDisplay`. A browser's real location is returned only by
 *   `locateBrowserExecutable()`, for the main process (design 4.5 launches it), never by
 *   `inspectCollectorIntegration()`;
 * - the contact record is displayed, never trusted for any decision;
 * - an inspection that cannot finish fails closed to `damaged` with
 *   `inspectionComplete: false`; it never throws.
 *
 * Multi-browser (design 4, S3): ownership is read per registry target; the expected set `E`
 * (design 3.1) is derived from the `verified` rows of the browser table; the aggregate
 * `registration` is taken over `E` only. The seven states and their precedence are unchanged.
 *
 * State precedence: `policy-blocked` first (every verified browser ignores the registration, and
 * a write cannot fix it), then `foreign-registration`, then the program-folder and file checks.
 * Within a healthy installation, a recorded registration that is gone is `registration-missing`,
 * and an expected target that was never recorded is `outdated(registration-target-added)`.
 */
import * as path from "node:path";
import { COLLECTOR_HOST_NAME, COLLECTOR_MANIFEST_FILE_NAME, COLLECTOR_PROGRAM_FOLDER_NAME, type HostRegistrationOwnership } from "./windows-integration.js";
import type { BrowserAppPathValue, ChromePolicyHiveFacts, ChromePolicySnapshot, CollectorRegistryAdapter } from "./collector-registry-adapter.js";
import {
  COLLECTOR_BROWSERS,
  COLLECTOR_REGISTRY_TARGETS,
  COLLECTOR_REGISTRY_TARGET_IDS,
  classifyDefaultBrowser,
  effectiveRegistration,
  recommendCollectorBrowser,
  type CollectorBrowserId,
  type CollectorBrowserInstalled,
  type CollectorBrowserSpec,
  type CollectorKnownFolder,
  type CollectorRegistryTargetId,
  type CollectorTargetOwnership,
} from "./collector-browser-table.js";
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
  BrowserExecutableSource,
  BrowserLocation,
  BrowserRejectedCandidate,
  ChromeCandidateRejection,
  ChromePolicyEvaluation,
  CollectorBrowserStatus,
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
  /** The browser table the inspection reads. Defaults to the product table; tests inject variants (for example with Edge verified). */
  readonly browserTable?: readonly CollectorBrowserSpec[];
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

// ----- Browser locator (design 1.5, 4.2) ----------------------------------------------------

interface BrowserCandidate {
  readonly source: BrowserExecutableSource;
  readonly value: string;
}

const APP_PATH_SOURCES: Readonly<Record<BrowserAppPathValue["source"], BrowserExecutableSource>> = {
  hkcu: "app-paths-hkcu",
  "hklm-64": "app-paths-hklm-64",
  "hklm-32": "app-paths-hklm-32",
};

const KNOWN_FOLDER_SOURCES: Readonly<Record<CollectorKnownFolder, BrowserExecutableSource>> = {
  LocalAppData: "known-local-app-data",
  ProgramFiles: "known-program-files",
  ProgramFilesX86: "known-program-files-x86",
};

async function validateBrowserCandidate(
  fileSystem: CollectorIntegrationFileSystem,
  rawValue: string,
  fileName: string,
): Promise<{ readonly ok: true; readonly executablePath: string } | { readonly ok: false; readonly reason: ChromeCandidateRejection }> {
  // App Paths values are sometimes quoted. A REG_EXPAND_SZ value is never expanded here.
  const value = rawValue.length >= 2 && rawValue.startsWith("\"") && rawValue.endsWith("\"") ? rawValue.slice(1, -1) : rawValue;
  if (value.includes("%")) return { ok: false, reason: "unexpanded-variable" };
  if (!isLocalAbsoluteWindowsPath(value)) return { ok: false, reason: "not-absolute-local" };
  if (path.win32.basename(value).toLowerCase() !== fileName.toLowerCase()) return { ok: false, reason: "wrong-basename" };
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
 * The executable named by a `shell\open\command` value: up to the closing quote when it starts with
 * `"`, otherwise up to the first whitespace (design 1.5). Used ONLY to pick between candidates that
 * were already validated; the string is never launched.
 */
function openCommandExecutable(command: string): string | null {
  const text = command.trim();
  if (text.startsWith("\"")) {
    const end = text.indexOf("\"", 1);
    return end > 1 ? text.slice(1, end) : null;
  }
  return /^\S+/u.exec(text)?.[0] ?? null;
}

const pathKey = (value: string): string => path.win32.normalize(value).toLowerCase();

export interface BrowserLocatorDependencies extends Pick<CollectorIntegrationInspectDependencies, "registry" | "fileSystem"> {
  /** Defaults to the product table; tests inject variants. */
  readonly browserTable?: readonly CollectorBrowserSpec[];
}

export interface BrowserLocatorOptions {
  /** The default `https` ProgId when the caller already read it (`null`: none). Omitted: read here. */
  readonly defaultProgId?: string | null;
}

/**
 * Main-process locator for one table row. Candidate order (design 1.5): when this browser is the
 * default and the default ProgId's open command names one of the VALIDATED candidates, that
 * candidate; otherwise App Paths HKCU, HKLM 64-bit, HKLM 32-bit, then the row's known folders.
 * Every candidate must pass the same checks (local absolute path, row basename, no reparse point,
 * regular file). Returns the validated path for the main process only: callers must not log it or
 * send it to the renderer.
 */
export async function locateBrowserExecutable(
  id: CollectorBrowserId,
  dependencies: BrowserLocatorDependencies,
  options: BrowserLocatorOptions = {},
): Promise<BrowserLocation> {
  const table = dependencies.browserTable ?? COLLECTOR_BROWSERS;
  const row = table.find((entry) => entry.id === id);
  if (row === undefined) return { status: "unknown" };
  const { fileName, appPathsName, knownFolderCandidates } = row.executable;

  const candidates: BrowserCandidate[] = [];
  try {
    for (const entry of dependencies.registry.readBrowserAppPaths(appPathsName)) {
      candidates.push({ source: APP_PATH_SOURCES[entry.source], value: entry.value });
    }
    for (const known of knownFolderCandidates) {
      const base = dependencies.registry.getKnownFolderPath(known.folder);
      candidates.push({ source: KNOWN_FOLDER_SOURCES[known.folder], value: path.win32.join(base, ...known.relative, fileName) });
    }
  } catch {
    return { status: "unknown" };
  }

  // The default browser's own open command prefers one of several installs (never launched).
  let preferred: string | null = null;
  try {
    const progId = options.defaultProgId !== undefined ? options.defaultProgId : (dependencies.registry.readDefaultBrowserProgId()?.progId ?? null);
    if (progId !== null && classifyDefaultBrowser(progId, table) === row.id) {
      const command = dependencies.registry.readProgIdOpenCommand(progId);
      const executable = command === null ? null : openCommandExecutable(command);
      preferred = executable === null ? null : pathKey(executable);
    }
  } catch {
    preferred = null; // tailoring only; never blocks
  }

  const rejected: BrowserRejectedCandidate[] = [];
  const valid: Array<{ readonly source: BrowserExecutableSource; readonly executablePath: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await validateBrowserCandidate(dependencies.fileSystem, candidate.value, fileName);
    if (!result.ok) {
      rejected.push(Object.freeze({ source: candidate.source, reason: result.reason }));
      continue;
    }
    valid.push({ source: candidate.source, executablePath: result.executablePath });
    if (preferred === null) break; // first valid candidate wins; later ones are not examined
  }
  const chosen = (preferred === null ? undefined : valid.find((entry) => pathKey(entry.executablePath) === preferred)) ?? valid[0];
  if (chosen !== undefined) {
    return { status: "found", source: chosen.source, executablePath: chosen.executablePath, rejected: Object.freeze(rejected) };
  }
  return { status: "not-found", rejected: Object.freeze(rejected) };
}

/** What the inspection learns about one table row (never contains a path). */
interface DetectedBrowser {
  readonly installed: CollectorBrowserInstalled;
  readonly source: BrowserExecutableSource | null;
  readonly policy: ChromePolicyEvaluation;
  readonly policyStatus: "read" | "unavailable" | "not-applicable";
}

const NO_POLICY: ChromePolicyEvaluation = Object.freeze({ userLevelHostsDisabled: false, hostBlocked: false, blocked: false, extensionLoadMayBeBlocked: false });

async function detectBrowsers(
  dependencies: CollectorIntegrationInspectDependencies,
  table: readonly CollectorBrowserSpec[],
  defaultProgId: string | null,
): Promise<ReadonlyMap<CollectorBrowserId, DetectedBrowser>> {
  const detected = new Map<CollectorBrowserId, DetectedBrowser>();
  for (const row of table) {
    let policy: ChromePolicyEvaluation = NO_POLICY;
    let policyStatus: DetectedBrowser["policyStatus"] = "not-applicable";
    if (row.policyRoot !== null) {
      try {
        policy = evaluateChromePolicies(dependencies.registry.readBrowserPolicies(row.policyRoot));
        policyStatus = "read";
      } catch {
        policyStatus = "unavailable"; // the browser stays the authority; this never blocks by itself
      }
    }
    const location = await locateBrowserExecutable(row.id, { ...dependencies, browserTable: table }, { defaultProgId });
    detected.set(row.id, Object.freeze({
      installed: location.status,
      source: location.status === "found" ? location.source : null,
      policy,
      policyStatus,
    }));
  }
  return detected;
}

// ----- Registration targets and the expected set E (design 3.1, 4.2) -------------------------

type TargetOwnerships = Readonly<Partial<Record<CollectorRegistryTargetId, CollectorTargetOwnership>>>;

/**
 * Per-target ownership for every target some table row looks up or owns (in registry order). A
 * target no row mentions (`vivaldi` today) is never read: the addon's table does not contain it.
 */
function readTargetOwnerships(registry: CollectorRegistryAdapter, table: readonly CollectorBrowserSpec[]): TargetOwnerships {
  const wanted = new Set<CollectorRegistryTargetId>();
  for (const row of table) {
    for (const target of [...row.nativeMessaging.lookupOrder, ...row.nativeMessaging.ownTargets]) wanted.add(target);
  }
  const result: Partial<Record<CollectorRegistryTargetId, CollectorTargetOwnership>> = {};
  for (const target of COLLECTOR_REGISTRY_TARGET_IDS) {
    if (!wanted.has(target)) continue;
    try {
      result[target] = registry.readCollectorHostRegistration(target);
    } catch {
      result[target] = "unknown";
    }
  }
  return Object.freeze(result);
}

/**
 * The expected set `E`: the writable targets MAGINALIA must have registered. Only `verified` rows
 * count; a policy-blocked row contributes nothing; a `when-present` row contributes a target only
 * when the browser was found or the state file says it was registered. Registry order, no duplicates.
 */
export function computeExpectedTargets(
  table: readonly CollectorBrowserSpec[],
  detected: ReadonlyMap<CollectorBrowserId, Pick<DetectedBrowser, "installed" | "policy">>,
  registeredTargets: readonly CollectorRegistryTargetId[] | null,
): readonly CollectorRegistryTargetId[] {
  const expected = new Set<CollectorRegistryTargetId>();
  for (const row of table) {
    if (row.verification !== "verified") continue;
    const facts = detected.get(row.id);
    if (facts?.policy.blocked === true) continue;
    for (const target of row.nativeMessaging.ownTargets) {
      if (row.nativeMessaging.registration === "always" || facts?.installed === "found" || registeredTargets?.includes(target) === true) {
        expected.add(target);
      }
    }
  }
  return Object.freeze(COLLECTOR_REGISTRY_TARGET_IDS.filter((target) => expected.has(target)));
}

/**
 * The registration scope: every target of every verified row, ignoring policy and detection (E_all).
 * Used for the unreadable check and for the `registration` aggregate while policy blocks every browser
 * (E is empty then, but our keys may still exist). Registry order, no duplicates.
 */
export function computeScopeTargets(
  table: readonly CollectorBrowserSpec[],
  registeredTargets: readonly CollectorRegistryTargetId[] | null,
): readonly CollectorRegistryTargetId[] {
  const scope = new Set<CollectorRegistryTargetId>();
  for (const row of table) {
    if (row.verification !== "verified") continue;
    for (const target of row.nativeMessaging.ownTargets) scope.add(target);
  }
  for (const target of registeredTargets ?? []) scope.add(target);
  return Object.freeze(COLLECTOR_REGISTRY_TARGET_IDS.filter((target) => scope.has(target)));
}

/** Aggregate over `E` (design 4.2): any unknown, else any foreign, else any ours, else absent. */
function aggregateRegistration(expected: readonly CollectorRegistryTargetId[], ownerships: TargetOwnerships): HostRegistrationOwnership | "unknown" {
  const values = expected.map((target) => ownerships[target] ?? "unknown");
  if (values.includes("unknown")) return "unknown";
  if (values.includes("foreign")) return "foreign";
  if (values.includes("ours")) return "ours";
  return "absent";
}

/** `blocked` only when every verified browser is blocked (design 4.4-1); a partial block stays per browser. */
function aggregatePolicy(
  table: readonly CollectorBrowserSpec[],
  detected: ReadonlyMap<CollectorBrowserId, DetectedBrowser>,
): ChromePolicyEvaluation & { readonly status: "read" | "unavailable" } {
  const verified = table.filter((row) => row.verification === "verified").flatMap((row) => {
    const facts = detected.get(row.id);
    return facts === undefined ? [] : [facts];
  });
  const allBlocked = verified.length > 0 && verified.every((facts) => facts.policy.blocked);
  const userLevelHostsDisabled = allBlocked && verified.some((facts) => facts.policy.userLevelHostsDisabled);
  const hostBlocked = allBlocked && verified.some((facts) => facts.policy.hostBlocked);
  return Object.freeze({
    userLevelHostsDisabled,
    hostBlocked,
    blocked: userLevelHostsDisabled || hostBlocked,
    extensionLoadMayBeBlocked: verified.some((facts) => facts.policy.extensionLoadMayBeBlocked),
    status: verified.some((facts) => facts.policyStatus === "unavailable") ? ("unavailable" as const) : ("read" as const),
  });
}

/**
 * Would registering `target` make some verified row stop using a FOREIGN registration it uses today?
 * (Edge looks up its own key first, then the Chromium key, then the Chrome key; a foreign Chromium
 * key is what Edge uses while its own key is absent.) Only the first present key after `target` in
 * a row's lookup order counts, exactly as the browser reads it; an unreadable one counts as foreign. Setup/repair accept this shadowing
 * after the user confirmed (design 11.1); an automatic refresh must not do it silently.
 */
export function registrationWouldShadowForeign(
  table: readonly CollectorBrowserSpec[],
  target: CollectorRegistryTargetId,
  ownerships: TargetOwnerships,
): boolean {
  for (const row of table) {
    if (row.verification !== "verified" || !row.nativeMessaging.ownTargets.includes(target)) continue;
    const order = row.nativeMessaging.lookupOrder;
    for (const next of order.slice(order.indexOf(target) + 1)) {
      const ownership = ownerships[next] ?? "unknown";
      if (ownership === "absent") continue;
      // Fail closed: a fallback key that cannot be read might be foreign, so it counts as shadowing.
      // The inspection then reports `foreign-registration` (the user confirms; the repair still
      // registers Edge) rather than `damaged` (which a repair refuses while a read keeps failing),
      // because this key is a lookup target, not part of E, whose unreadability design 4.4-2 makes incomplete.
      if (ownership === "foreign" || ownership === "unknown") return true;
      break;
    }
  }
  return false;
}

function sameTargets(left: readonly CollectorRegistryTargetId[], right: readonly CollectorRegistryTargetId[]): boolean {
  return left.length === right.length && left.every((target, index) => target === right[index]);
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

export interface IntegrationStateFile {
  /** `1` is the pre-multi-browser shape (read only); S4 writes `2` (design 4.3). */
  readonly version: 1 | 2;
  readonly payloadId: string;
  readonly activeSlot: CollectorHostSlot;
  readonly extensionVersion: string;
  readonly placedAt: string;
  /** Writable targets the last apply registered, in registry order. A v1 file means `["chrome"]`. */
  readonly registeredTargets: readonly CollectorRegistryTargetId[];
}

const STATE_V1_FIELDS = ["version", "payloadId", "activeSlot", "extensionVersion", "placedAt"] as const;
const STATE_V2_FIELDS = [...STATE_V1_FIELDS, "registeredTargets"] as const;
const WRITABLE_TARGET_IDS: readonly CollectorRegistryTargetId[] = COLLECTOR_REGISTRY_TARGETS.filter((target) => target.writable).map((target) => target.id);

function parseRegisteredTargets(value: unknown): readonly CollectorRegistryTargetId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || !(WRITABLE_TARGET_IDS as readonly string[]).includes(entry) || seen.has(entry)) return undefined;
    seen.add(entry);
  }
  return Object.freeze(WRITABLE_TARGET_IDS.filter((target) => seen.has(target)));
}

export function parseIntegrationStateFile(text: string): IntegrationStateFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) return undefined;
  const fields: readonly string[] = record.version === 1 ? STATE_V1_FIELDS : STATE_V2_FIELDS;
  if (Object.keys(record).length !== fields.length || !fields.every((field) => Object.hasOwn(record, field))) return undefined;
  if (typeof record.payloadId !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}\+[0-9A-Za-z]{1,40}$/u.test(record.payloadId)) return undefined;
  if (record.activeSlot !== "a" && record.activeSlot !== "b") return undefined;
  if (parseCollectorVersion(record.extensionVersion) === undefined) return undefined;
  if (typeof record.placedAt !== "string" || !CONTACT_TIMESTAMP_PATTERN.test(record.placedAt)) return undefined;
  const registeredTargets = record.version === 1 ? Object.freeze(["chrome" as const]) : parseRegisteredTargets(record.registeredTargets);
  if (registeredTargets === undefined) return undefined;
  return Object.freeze({
    version: record.version,
    payloadId: record.payloadId,
    activeSlot: record.activeSlot,
    extensionVersion: record.extensionVersion as string,
    placedAt: record.placedAt,
    registeredTargets,
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

/**
 * The slot a generated manifest points at, or `null` when the value is not exactly a manifest this
 * app generates. This is the authority for "which Host slot does Chrome run" (design 3.5, 6.3).
 */
export function collectorManifestSlot(value: unknown, programFolder: string): CollectorHostSlot | null {
  for (const slot of COLLECTOR_HOST_SLOTS) if (manifestMatches(value, slot, programFolder) === "ok") return slot;
  return null;
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
  const table = dependencies.browserTable ?? COLLECTOR_BROWSERS;
  const sink = new ReasonSink();
  let complete = true;
  const incomplete = (reason: CollectorIntegrationReason): void => {
    complete = false;
    sink.add(reason);
  };

  const paths = resolveIntegrationPaths(dependencies.registry);
  if (paths === undefined) incomplete("known-folder-unavailable");

  // Default browser (tailoring only; a failing read yields `unknown` and never blocks).
  let defaultProgId: string | null = null;
  let defaultBrowser: DefaultBrowserKind = "unknown";
  try {
    defaultProgId = dependencies.registry.readDefaultBrowserProgId()?.progId ?? null;
    defaultBrowser = classifyDefaultBrowser(defaultProgId, table);
  } catch {
    defaultProgId = null;
    defaultBrowser = "unknown";
  }

  // Per-target ownership (decided in the addon), per-browser detection and policy.
  const ownerships = readTargetOwnerships(dependencies.registry, table);
  const detected = await detectBrowsers(dependencies, table, defaultProgId);
  const policy = aggregatePolicy(table, detected);

  // The expected set E and the aggregate over it. `registeredTargets` of a `when-present` row is only
  // known after the state file is read; E is recomputed then.
  let expected = computeExpectedTargets(table, detected, null);
  const noteUnreadable = (targets: readonly CollectorRegistryTargetId[]): void => {
    if (targets.some((target) => (ownerships[target] ?? "unknown") === "unknown")) incomplete("registry-read-failed");
  };
  let scope = computeScopeTargets(table, null);
  noteUnreadable(scope);
  // While policy blocks every browser E is empty; the aggregate then runs over the whole scope.
  let registration = aggregateRegistration(policy.blocked ? scope : expected, ownerships);

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

          // A `when-present` browser registered earlier can widen E now that the state file is known.
          if (installedState !== null) {
            const refined = computeExpectedTargets(table, detected, installedState.registeredTargets);
            if (!sameTargets(refined, expected)) {
              expected = refined;
              scope = computeScopeTargets(table, installedState.registeredTargets);
              noteUnreadable(scope);
              registration = aggregateRegistration(policy.blocked ? scope : expected, ownerships);
            }
          }
          const registered = installedState?.registeredTargets ?? [];
          const absentTargets = expected.filter((target) => ownerships[target] === "absent");
          const missingTargets = absentTargets.filter((target) => registered.includes(target));
          const addedTargets = absentTargets.filter((target) => !registered.includes(target));

          if (!complete) {
            state = "damaged";
          } else if (registration === "foreign") {
            state = "foreign-registration";
            sink.add("registration-foreign");
          } else if (registration === "absent" && installedState === null) {
            state = "not-set-up";
            sink.add("program-folder-unrecognized");
          } else if (registration === "absent" && installedState !== null && missingTargets.length > 0) {
            // Everything expected is gone but something was registered before: someone removed it.
            state = "registration-missing";
            sink.add("registration-absent");
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
            if (sink.reasons.length > 0 || payload === null) {
              state = "damaged"; // structure or payload problems
            } else {
              const payloadDiffers = installedState.payloadId !== payload.payloadId;
              if (!payloadDiffers) await verifyAgainstPayload(dependencies.fileSystem, paths, installedState, payload, hashes, sink);
              if (sink.reasons.length > 0) {
                state = "damaged";
              } else if (missingTargets.length > 0) {
                // Healthy installation, but a registration that was made is gone: never repaired silently.
                state = "registration-missing";
                sink.add("registration-absent");
              } else if (addedTargets.some((target) => registrationWouldShadowForeign(table, target, ownerships))) {
                // The new registration would take over from a foreign one that a browser uses now
                // (Edge key absent, a foreign Chromium key present). Never done by an automatic refresh:
                // the repair notice asks first (design 11.1; S4 decision d).
                state = "foreign-registration";
                sink.add("registration-foreign");
              } else if (payloadDiffers || addedTargets.length > 0) {
                state = "outdated";
                if (payloadDiffers) {
                  sink.add("payload-id-differs");
                  if (hostVersionComparison === "older" || extensionVersionComparison === "older") sink.add("installed-older");
                  else if (hostVersionComparison === "newer" || extensionVersionComparison === "newer") sink.add("installed-newer");
                  else if (hostVersionComparison === "unparseable" || extensionVersionComparison === "unparseable") sink.add("installed-version-unparseable");
                }
                // A new version registers more targets, or a `when-present` browser appeared (design 4.4-5).
                if (addedTargets.length > 0) sink.add("registration-target-added");
              } else if (expected.length === 0) {
                // Nothing is expected to be registered: a healthy-looking installation is not "ready".
                state = "damaged";
                sink.add("registration-absent");
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

  const recommendation = recommendCollectorBrowser({
    defaultBrowser,
    detections: Object.fromEntries(table.map((row) => {
      const facts = detected.get(row.id);
      return [row.id, { installed: facts?.installed ?? "unknown", policyBlocked: facts?.policy.blocked ?? false }];
    })),
  }, table);
  const entries: readonly CollectorBrowserStatus[] = Object.freeze(table.map((row) => {
    const facts = detected.get(row.id) as DetectedBrowser;
    return Object.freeze({
      id: row.id,
      verification: row.verification,
      installed: facts.installed,
      source: facts.source,
      effective: effectiveRegistration(row.nativeMessaging.lookupOrder, ownerships),
      policy: Object.freeze({ ...facts.policy, status: facts.policyStatus }),
    });
  }));
  const registrations = Object.freeze(Object.fromEntries(COLLECTOR_REGISTRY_TARGET_IDS.map((target) => [target, ownerships[target] ?? "unknown"]))) as Readonly<Record<CollectorRegistryTargetId, CollectorTargetOwnership>>;

  return Object.freeze({
    state,
    reasons: Object.freeze([...sink.reasons]),
    inspectionComplete: complete,
    registration,
    registrations,
    expectedTargets: expected,
    registeredTargets: installedState?.registeredTargets ?? null,
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
    policy,
    browsers: Object.freeze({
      defaultBrowser,
      recommended: recommendation.recommended,
      recommendationReason: recommendation.reason,
      entries,
    }),
    contact,
    extensionFolderDisplay: paths?.extensionFolder ?? null,
    writesAllowed: !dependencies.e2eIsolationActive,
  });
}
