/**
 * Write side of the Collector integration (design 3.5, 6, 8; WP-5b): setup, repair, refresh
 * and remove.
 *
 * Every side effect goes through an injected adapter (`CollectorApplyFileSystem`, the WP-3
 * `CollectorRegistryAdapter`, the Host self-check runner, the clock). This module reads no
 * environment, cwd, argv or Electron path, spawns nothing and imports no file-system API. The
 * product adapters (`collector-integration-apply-fs.ts`, `collector-integration-apply-self-check.ts`)
 * are the only code touching real locations. It fails closed and never throws: every outcome is
 * an opaque reason code plus the post-action inspection.
 *
 * Transitions (design 3.5):
 *
 * | action  | runs from                                       | no-op from |
 * | ------- | ----------------------------------------------- | ---------- |
 * | setup   | not-set-up, foreign-registration (confirmed)    | ready      |
 * | repair  | registration-missing, damaged, foreign (confirmed) | ready   |
 * | refresh | outdated (ours; automatic for opted-in users)   | ready      |
 * | remove  | any state with a recognizable program folder    | not-set-up |
 *
 * Single run at a time: `applyCollectorIntegration` rejects a second call while one is running
 * (`refused` / `busy`); it does not queue. WP-7 must serialize the UI actions that lead here
 * (disable the buttons while a run is in progress, and do not fire repair/refresh from automatic
 * triggers while a user-started run is open); the guard is the safety net, not the UX.
 *
 * Notes for WP-7 / WP-8 (not implemented here):
 *  - Hash the compiled constants, not only the packaged `collector-payload.json`: the descriptor
 *    file is informational, the constants in the main bundle are authoritative (design 2.1).
 *  - Persist "the user asked for remove" so that repair notifications / automatic refresh stay
 *    quiet after a remove that ended `partial` (the state file of an interrupted removal still
 *    looks like a damaged installation).
 *  - The NSIS uninstaller must know our private temp names, `<name>.<16 hex>.tmp`, in the program
 *    folder and in `host-a` / `host-b`, besides the fixed names, `extension`, `extension.next`
 *    and `extension.prev`; anything else in the folder is the user's and must be left alone.
 *
 * Order of side effects for setup / repair / refresh (each step is verified before the next):
 *  1. preconditions (inspect; E2E isolation; policy; payload; state matrix; foreign confirmation).
 *     The inspection also fixes the expected set E (design 3.1) and a per-target ownership snapshot;
 *     every guard re-reads each target and stops on any difference (design 3.3, 5.6).
 *  2. program folder (protected DACL; parents checked; existing unsafe folder is never re-permissioned)
 *  3. integration folder (protected DACL) and stale contact temp files
 *  4. recover a pending extension swap; guard re-check
 *  5. write the INACTIVE Host slot (exclusive temp, hash of written bytes, rename, re-read hash)
 *  6. stage `extension.next`, verify manifest key -> ID and every file hash, swap folders
 *  7. guard re-check (point of no return), then write the manifest (temp + rename) for the new slot
 *  8. registry, one target at a time (design 5.2): `absent` is registered, a confirmed `foreign` value
 *     is replaced, each write is read back (`ours`). A refused or failed target is recorded and the
 *     next target is still tried. A refresh only registers targets that were never registered before.
 *  9. `integration-state.json` v2 with `registeredTargets` (temp + rename)
 * 10. Host self-check. The previous slot is NOT pruned: it stays complete until the next update
 *     writes it (design 6.3), so a Chrome that still runs the old Host keeps working.
 *
 * Registration-only refresh (design 5.4): state `outdated` for the single reason
 * `registration-target-added` with the same payload: steps 2-7 and the extension swap are skipped,
 * only steps 8-10 run, and the result reports `filesChanged: false`.
 *
 * Remove: every WRITABLE target (not only E), read fresh and value-matched, reverse registry order; a
 * foreign value is left alone, an unreadable key refuses the run before anything changed, and a key that
 * cannot be removed keeps all files (this also runs when the program folder is unsafe, in which case
 * nothing on disk is touched and the outcome is `partial`),
 * then ONLY names we own: the manifest, the slots' fixed file names (and our private temp names), the
 * files the packaged descriptor lists in the extension folders, the state file, then a
 * non-recursive rmdir. Unknown entries (user files, files of an older extension version) stay and
 * make the outcome `partial`; nothing is deleted by listing a folder and removing what is found.
 * Links and reparse points are skipped, never followed.
 *
 * Content safety for setup / repair / refresh: Host slots may only hold our fixed names, and the
 * extension folders may only hold descriptor files unless ownership is confirmed. Ownership is
 * confirmed by a VALID STATE FILE inside the (already verified safe, protected) program folder, and
 * by nothing else: not by the registration (it can be deleted or replaced by someone else while the
 * folder is still ours) and not by the manifest. Without such a state file, anything unrecognized is
 * refused with `program-folder-unrecognized-content` before the first write. Remove follows the
 * same rule: with a valid state file the extension folders are removed by listing (links are
 * skipped, never followed); without one only descriptor-listed names are deleted.
 *
 * FUTURE (permanent fix, design 2.4): ship `collector-extension-files.json`, an append-only union of
 * every extension file name ever pinned, and recognize an extension folder by that list instead of
 * by the state file alone. Until then a state file is the ownership evidence.
 *
 * A swap of the extension folder that cannot happen (a locked leftover `extension.prev`) fails the
 * whole run with `file-locked` BEFORE the manifest switch: the previous installation (manifest,
 * state file, slot, extension) is untouched, the newly written slot is not pointed at, and the next
 * refresh / repair retries (it rewrites that same slot).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  COLLECTOR_ALLOWED_ORIGINS,
  COLLECTOR_EXTENSION_ID,
  COLLECTOR_HOST_ADDON_NAME,
  COLLECTOR_HOST_EXECUTABLE_NAME,
  COLLECTOR_PROTOCOL,
  isSafeRelativeFileName,
  parseCollectorPayloadDescriptor,
  type CollectorPayloadDescriptor,
} from "./collector-payload.js";
import {
  COLLECTOR_BROWSERS,
  COLLECTOR_REGISTRY_TARGETS,
  COLLECTOR_REGISTRY_TARGET_IDS,
  type CollectorBrowserId,
  type CollectorBrowserSpec,
  type CollectorRegistryTargetId,
} from "./collector-browser-table.js";
import {
  COLLECTOR_EXTENSION_FOLDER_NAME,
  COLLECTOR_HOST_SLOTS,
  COLLECTOR_STATE_FILE_NAME,
  evaluateChromePolicies,
  inspectCollectorIntegration,
  isLocalAbsoluteWindowsPath,
  resolveIntegrationPaths,
  slotFolder,
  collectorManifestSlot,
  parseIntegrationStateFile,
  type CollectorHostSlot,
  type IntegrationPaths,
  type IntegrationStateFile,
} from "./collector-integration.js";
import { inspectAndEvaluatePathSecurity } from "./collector-path-security.js";
import {
  collectorManifestPathFor,
  COLLECTOR_HOST_NAME,
  type HostRegistrationOwnership,
} from "./windows-integration.js";
import {
  CollectorFileSystemError,
  type CollectorApplyAction,
  type CollectorApplyReason,
  type CollectorApplyRequest,
  type CollectorApplyResult,
  type CollectorApplyTargetResult,
  type CollectorApplyWarning,
  type CollectorApplyOutcome,
  type CollectorIntegrationApplyDependencies,
} from "./collector-integration-apply-types.js";
import type { CollectorIntegrationInspection, CollectorIntegrationState } from "./collector-integration-types.js";

export const COLLECTOR_EXTENSION_STAGING_NAME = "extension.next";
export const COLLECTOR_EXTENSION_PREVIOUS_NAME = "extension.prev";
export const COLLECTOR_STANDALONE_FOLDER_NAME = "MAGINALIA Collector Host";
/** Files copied next to the Host executable. They carry no descriptor hash; the copy is still verified. */
export const COLLECTOR_HOST_LICENSE_FILES: readonly string[] = Object.freeze(["LICENSE.txt", "NOTICE.txt", "NODE-LICENSE.txt"]);
/**
 * `path` form written into the generated manifest (design 3.4). `relative` is the design default;
 * the WP-2 spike decides whether Chrome resolves a relative path with a subdirectory. Changing
 * this one constant switches the generator to the absolute, JSON-escaped fallback.
 */
export const COLLECTOR_MANIFEST_PATH_FORM: "relative" | "absolute" = "relative";
/** Contact-record temp files older than this are removed from the integration folder. */
export const COLLECTOR_STALE_TEMP_AGE_MS = 10 * 60 * 1000;

const MAX_TREE_ENTRIES = 2000;
const MAX_TREE_DEPTH = 8;
const MAX_MANIFEST_BYTES = 8192;
const MAX_STATE_BYTES = 4096;
const SUFFIX_PATTERN = /^[0-9a-f]{16}$/u;
const TEMP_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}\.[0-9a-f]{16}\.tmp$/u;
const CONTACT_TEMP_PATTERN = /^\.collector-contact\.json\.[A-Za-z0-9._-]{1,64}\.tmp$/u;

// ----- Pure helpers -------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Chrome's extension ID: SHA-256 of the DER public key, first 32 hex digits mapped 0-f -> a-p. */
export function deriveExtensionIdFromManifestKey(manifestKey: unknown): string | undefined {
  if (typeof manifestKey !== "string" || manifestKey.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(manifestKey)) return undefined;
  const der = Buffer.from(manifestKey, "base64");
  if (der.length === 0) return undefined;
  return [...sha256Hex(der).slice(0, 32)].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

/** The manifest the app generates (design 3.4). One generator; one path-form constant. */
export function buildCollectorHostManifest(
  slot: CollectorHostSlot,
  programFolder: string,
  form: "relative" | "absolute" = COLLECTOR_MANIFEST_PATH_FORM,
): Readonly<Record<string, unknown>> {
  const relative = `host-${slot}\\${COLLECTOR_HOST_EXECUTABLE_NAME}`;
  return Object.freeze({
    name: COLLECTOR_HOST_NAME,
    description: "MAGINALIA Collector Native Messaging Host",
    path: form === "relative" ? relative : path.win32.join(programFolder, relative),
    type: "stdio",
    allowed_origins: COLLECTOR_ALLOWED_ORIGINS,
  });
}

function manifestBytes(slot: CollectorHostSlot, programFolder: string): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(buildCollectorHostManifest(slot, programFolder), null, 2)}\n`);
}

/** State file v2 (design 4.3). Always written as v2; v1 is only ever read. */
function stateBytes(
  fields: { readonly payloadId: string; readonly extensionVersion: string; readonly placedAt: string },
  slot: CollectorHostSlot,
  registeredTargets: readonly CollectorRegistryTargetId[],
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    version: 2,
    payloadId: fields.payloadId,
    activeSlot: slot,
    extensionVersion: fields.extensionVersion,
    placedAt: fields.placedAt,
    registeredTargets,
  }, null, 2)}\n`);
}

const join = (...parts: string[]): string => path.win32.join(...parts);
const sameLocation = (left: string, right: string): boolean => path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

class Abort extends Error {
  public readonly reason: CollectorApplyReason;
  public constructor(reason: CollectorApplyReason) {
    super(`Collector apply stopped (${reason}).`);
    this.name = "CollectorApplyAbort";
    this.reason = reason;
  }
}

/** Maps anything thrown to an opaque reason. Never forwards a message. */
export function reasonForError(error: unknown): CollectorApplyReason {
  if (error instanceof Abort) return error.reason;
  if (error instanceof CollectorFileSystemError) return error.code === "locked" ? "file-locked" : "write-failed";
  return "write-failed";
}

// ----- Context ------------------------------------------------------------------------------

interface Context {
  readonly deps: CollectorIntegrationApplyDependencies;
  readonly paths: IntegrationPaths;
  readonly warnings: CollectorApplyWarning[];
}

function warn(context: Context, warning: CollectorApplyWarning): void {
  if (!context.warnings.includes(warning)) context.warnings.push(warning);
}

function temporaryName(context: Context, name: string): string {
  const suffix = context.deps.randomSuffix();
  if (typeof suffix !== "string" || !SUFFIX_PATTERN.test(suffix)) throw new Abort("write-failed");
  return `${name}.${suffix}.tmp`;
}

function userProgramFilesOf(paths: IntegrationPaths): string {
  return path.win32.dirname(paths.programFolder);
}

/** Resolve the fixed layout and require that the manifest path equals the one the native registrar writes. */
function resolveLayout(deps: CollectorIntegrationApplyDependencies): IntegrationPaths | undefined {
  const paths = resolveIntegrationPaths(deps.registry);
  if (paths === undefined) return undefined;
  try {
    const registered = collectorManifestPathFor(deps.registry.getKnownFolderPath("UserProgramFiles"));
    if (!sameLocation(registered, paths.manifestPath)) return undefined;
  } catch {
    return undefined;
  }
  return paths;
}

// ----- Folder preparation (design 3.5, 8.3) -------------------------------------------------

/** `parent`: a folder above ours that an installer or an elevated process may have created (SYSTEM / Administrators may own it). */
function requireSafeDirectory(context: Context, target: string, parent = false): void {
  const result = inspectAndEvaluatePathSecurity(context.deps.inspectPathSecurity, target, "directory", { allowSystemOrAdministratorOwner: parent });
  if (!result.ok) throw new Abort("program-folder-unsafe");
}

/**
 * Create the per-user program folder with the protected DACL, or verify the existing one. The
 * parents are checked by the same rule. An unsafe existing folder is NEVER repaired or
 * re-permissioned: it aborts.
 */
async function ensureProgramFolder(context: Context): Promise<void> {
  const { deps, paths } = context;
  const programs = userProgramFilesOf(paths);
  const parent = path.win32.dirname(programs);
  // A drive root has no owner we can reason about; any real parent is checked.
  if (parent !== programs && path.win32.dirname(parent) !== parent) requireSafeDirectory(context, parent, true);
  const programsEntry = await deps.fileSystem.stat(programs);
  if (programsEntry === null) {
    await deps.fileSystem.createPrivateDirectory(programs);
  } else if (programsEntry.isReparsePoint || programsEntry.kind !== "directory") {
    throw new Abort("program-folder-unsafe");
  }
  requireSafeDirectory(context, programs, true);

  const entry = await deps.fileSystem.stat(paths.programFolder);
  if (entry === null) {
    await deps.fileSystem.createPrivateDirectory(paths.programFolder);
  } else if (entry.isReparsePoint || entry.kind !== "directory") {
    throw new Abort("program-folder-unsafe");
  }
  requireSafeDirectory(context, paths.programFolder);
}

/**
 * Before the first write: none of our fixed names may be a link. (The inspection reports a
 * linked directory as "missing", so this closes the gap and keeps the refusal write-free.)
 */
async function refuseLinkedNames(context: Context): Promise<void> {
  const { fileSystem } = context.deps;
  const { paths } = context;
  const names = [
    paths.manifestPath,
    join(paths.programFolder, COLLECTOR_STATE_FILE_NAME),
    paths.extensionFolder,
    join(paths.programFolder, COLLECTOR_EXTENSION_STAGING_NAME),
    join(paths.programFolder, COLLECTOR_EXTENSION_PREVIOUS_NAME),
    ...COLLECTOR_HOST_SLOTS.map((slot) => slotFolder(paths, slot)),
  ];
  for (const name of names) {
    const entry = await fileSystem.stat(name);
    if (entry !== null && entry.isReparsePoint) throw new Abort("reparse-point-found");
  }
}

/** `%LOCALAPPDATA%\MAGINALIA\integration`: the Host never creates it (design 4.6). Non-fatal when unsafe. */
async function ensureIntegrationDirectory(context: Context): Promise<void> {
  const { deps, paths } = context;
  try {
    for (const directory of [paths.applicationRoot, paths.integrationDirectory]) {
      const entry = await deps.fileSystem.stat(directory);
      if (entry === null) await deps.fileSystem.createPrivateDirectory(directory);
      const result = inspectAndEvaluatePathSecurity(deps.inspectPathSecurity, directory, "directory");
      if (!result.ok) {
        warn(context, "integration-folder-unsafe");
        return;
      }
    }
    const entries = await deps.fileSystem.listDirectory(paths.integrationDirectory);
    const threshold = deps.now().getTime() - COLLECTOR_STALE_TEMP_AGE_MS;
    for (const entry of entries ?? []) {
      if (entry.kind !== "file" || entry.isReparsePoint || !CONTACT_TEMP_PATTERN.test(entry.name) || entry.mtimeMs >= threshold) continue;
      try {
        await deps.fileSystem.removeFile(join(paths.integrationDirectory, entry.name));
      } catch {
        // stale temp cleanup is best effort
      }
    }
  } catch {
    warn(context, "integration-folder-unsafe");
  }
}

// ----- Guard (re-evaluated before the first write and before the point of no return) --------

/**
 * What the precondition inspection saw, per registry target (design 3.3, 5.6). The guard compares
 * the live registry against exactly this: a target that changed since the user confirmed (for
 * example a replacement confirmed for Edge while Chrome turned foreign meanwhile) is never touched.
 */
interface TargetPlan {
  readonly table: readonly CollectorBrowserSpec[];
  /** The expected set E (design 3.1), registry order. */
  readonly expected: readonly CollectorRegistryTargetId[];
  /** Ownership of every target the inspection could read (an `unknown` target is not compared). */
  readonly snapshot: Readonly<Partial<Record<CollectorRegistryTargetId, HostRegistrationOwnership>>>;
  /** `registeredTargets` of the state file the inspection read (empty when none). */
  readonly registered: readonly CollectorRegistryTargetId[];
  /** Verified browsers whose policy blocked per-user hosts at the precondition. */
  readonly blockedBrowsers: readonly CollectorBrowserId[];
}

const WRITABLE_TARGET_IDS: readonly CollectorRegistryTargetId[] = COLLECTOR_REGISTRY_TARGET_IDS.filter((id) => COLLECTOR_REGISTRY_TARGETS.some((target) => target.id === id && target.writable));

/** Verified rows that a policy blocks right now. A policy that cannot be read never blocks (design 8.4). */
function readBlockedBrowsers(deps: CollectorIntegrationApplyDependencies, table: readonly CollectorBrowserSpec[]): { readonly blocked: readonly CollectorBrowserId[]; readonly verified: number } {
  const blocked: CollectorBrowserId[] = [];
  let verified = 0;
  for (const row of table) {
    if (row.verification !== "verified") continue;
    verified += 1;
    if (row.policyRoot === null) continue;
    try {
      if (evaluateChromePolicies(deps.registry.readBrowserPolicies(row.policyRoot)).blocked) blocked.push(row.id);
    } catch {
      // not blocked by itself
    }
  }
  return { blocked, verified };
}

function buildTargetPlan(deps: CollectorIntegrationApplyDependencies, first: CollectorIntegrationInspection): TargetPlan {
  const table = deps.browserTable ?? COLLECTOR_BROWSERS;
  const snapshot: Partial<Record<CollectorRegistryTargetId, HostRegistrationOwnership>> = {};
  for (const target of COLLECTOR_REGISTRY_TARGET_IDS) {
    const ownership = first.registrations[target];
    if (ownership !== "unknown") snapshot[target] = ownership;
  }
  return Object.freeze({
    table,
    expected: first.expectedTargets,
    snapshot: Object.freeze(snapshot),
    registered: first.registeredTargets ?? [],
    blockedBrowsers: Object.freeze(first.browsers.entries.filter((entry) => entry.verification === "verified" && entry.policy.blocked).map((entry) => entry.id)),
  });
}

async function guard(context: Context, plan: TargetPlan, options: { readonly folderExists: boolean }): Promise<void> {
  const { deps, paths } = context;
  if (deps.e2eIsolationActive) throw new Abort("e2e-isolation");
  const { blocked, verified } = readBlockedBrowsers(deps, plan.table);
  if (verified > 0 && blocked.length === verified) throw new Abort("policy-blocked");
  // A browser became (un)blocked: E is no longer the set the user confirmed.
  if (blocked.length !== plan.blockedBrowsers.length || blocked.some((id) => !plan.blockedBrowsers.includes(id))) throw new Abort("expected-targets-changed");
  // Every target, read fresh: one that changed since the precondition stops the run (never overwritten).
  for (const [target, expected] of Object.entries(plan.snapshot) as Array<[CollectorRegistryTargetId, HostRegistrationOwnership]>) {
    let ownership: HostRegistrationOwnership;
    try {
      ownership = deps.registry.readCollectorHostRegistration(target);
    } catch {
      throw new Abort("inspection-incomplete");
    }
    if (ownership !== expected) throw new Abort("registration-changed");
  }
  if (options.folderExists) requireSafeDirectory(context, paths.programFolder);
}

// ----- Content recognition (design 2.4, 8.3) ------------------------------------------------

/** What a recognized extension tree may contain: the descriptor's files and their parent directories. */
interface ExtensionLayout {
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

function extensionLayoutOf(descriptor: CollectorPayloadDescriptor): ExtensionLayout {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const name of Object.keys(descriptor.extension.files)) {
    const segments = name.toLowerCase().split("/");
    files.add(segments.join("/"));
    for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
  }
  return { files, directories };
}

/** A Host slot may hold only the fixed names (and our private temp names). Anything else is not ours to delete. */
async function requireRecognizedSlotContent(context: Context, slot: CollectorHostSlot): Promise<void> {
  const children = await context.deps.fileSystem.listDirectory(slotFolder(context.paths, slot));
  for (const child of children ?? []) {
    if (child.isReparsePoint || child.kind === "other") throw new Abort("reparse-point-found");
    if (child.kind !== "file" || !(SLOT_FIXED_NAMES.includes(child.name) || TEMP_NAME_PATTERN.test(child.name))) throw new Abort("program-folder-unrecognized-content");
  }
}

/** An extension folder may hold only the files the packaged descriptor lists. */
async function requireRecognizedExtensionContent(context: Context, directory: string, layout: ExtensionLayout, relative = "", budget: TreeBudget = { entries: 0 }, depth = 0): Promise<void> {
  if (depth >= MAX_TREE_DEPTH) throw new Abort("program-folder-unrecognized-content");
  const children = await context.deps.fileSystem.listDirectory(directory);
  for (const child of children ?? []) {
    budget.entries += 1;
    if (budget.entries > MAX_TREE_ENTRIES) throw new Abort("program-folder-unrecognized-content");
    if (child.isReparsePoint || child.kind === "other") throw new Abort("reparse-point-found");
    const key = relative === "" ? child.name.toLowerCase() : `${relative}/${child.name.toLowerCase()}`;
    if (child.kind === "directory") {
      if (!layout.directories.has(key)) throw new Abort("program-folder-unrecognized-content");
      await requireRecognizedExtensionContent(context, join(directory, child.name), layout, key, budget, depth + 1);
    } else if (!layout.files.has(key)) {
      throw new Abort("program-folder-unrecognized-content");
    }
  }
}

/** The parsed `integration-state.json` when it is a readable, valid plain file; otherwise `undefined`. */
async function readValidStateFile(context: Context): Promise<IntegrationStateFile | undefined> {
  const { fileSystem } = context.deps;
  try {
    const entry = await fileSystem.stat(context.paths.statePath);
    if (entry === null || entry.isReparsePoint || entry.kind !== "file") return undefined;
    const read = await fileSystem.readSmallFile(context.paths.statePath, MAX_STATE_BYTES);
    if (read.kind !== "ok") return undefined;
    return parseIntegrationStateFile(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  } catch {
    return undefined;
  }
}

/**
 * Ownership evidence: a readable, valid `integration-state.json` (a plain file) in the program
 * folder. Callers have already verified that the folder is a safe, protected directory.
 */
async function hasValidStateFile(context: Context): Promise<boolean> {
  return (await readValidStateFile(context)) !== undefined;
}

/**
 * Before the first write: refuse when a folder we are about to reuse or replace holds anything we
 * cannot account for. Host slots are always checked against the fixed names. The extension
 * folders are checked against the descriptor unless ownership is CONFIRMED by a valid state file
 * (see `hasValidStateFile`): only then is the previous extension tree, whatever version it came
 * from, ours to replace wholesale.
 */
async function requireRecognizedContent(context: Context, descriptor: CollectorPayloadDescriptor, ownershipConfirmed: boolean): Promise<void> {
  for (const slot of COLLECTOR_HOST_SLOTS) await requireRecognizedSlotContent(context, slot);
  if (ownershipConfirmed) return;
  const layout = extensionLayoutOf(descriptor);
  for (const name of [COLLECTOR_EXTENSION_FOLDER_NAME, COLLECTOR_EXTENSION_STAGING_NAME, COLLECTOR_EXTENSION_PREVIOUS_NAME]) {
    await requireRecognizedExtensionContent(context, join(context.paths.programFolder, name), layout);
  }
}

// ----- Tree removal (own folders only; never follows a link) --------------------------------

interface TreeBudget { entries: number }

/**
 * Remove one of OUR folders by listing it. Regular files and plain directories are removed;
 * a reparse point or an unusual entry is skipped (the folder then stays). `strict` throws on
 * the first problem (staging cleanup); otherwise it reports `leftover` (remove).
 */
async function removeTree(
  context: Context,
  directory: string,
  strict: boolean,
  state: { locked: boolean },
  budget: TreeBudget = { entries: 0 },
  depth = 0,
): Promise<"removed" | "missing" | "leftover"> {
  const { fileSystem } = context.deps;
  const entry = await fileSystem.stat(directory);
  if (entry === null) return "missing";
  if (entry.isReparsePoint || entry.kind !== "directory") {
    if (strict) throw new Abort("reparse-point-found");
    return "leftover";
  }
  if (depth >= MAX_TREE_DEPTH) {
    if (strict) throw new Abort("write-failed");
    return "leftover";
  }
  const entries = await fileSystem.listDirectory(directory);
  if (entries === null) return "missing";
  let clean = true;
  for (const child of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_TREE_ENTRIES) {
      if (strict) throw new Abort("write-failed");
      return "leftover";
    }
    const target = join(directory, child.name);
    if (child.isReparsePoint || child.kind === "other") {
      if (strict) throw new Abort("reparse-point-found");
      clean = false;
      continue;
    }
    try {
      if (child.kind === "directory") {
        const result = await removeTree(context, target, strict, state, budget, depth + 1);
        if (result === "leftover") clean = false;
      } else {
        await fileSystem.removeFile(target);
      }
    } catch (error: unknown) {
      if (strict) throw error;
      if (error instanceof CollectorFileSystemError && error.code === "locked") state.locked = true;
      clean = false;
    }
  }
  if (!clean) return "leftover";
  try {
    const removed = await fileSystem.removeEmptyDirectory(directory);
    return removed === "removed" ? "removed" : "missing";
  } catch (error: unknown) {
    if (strict) throw error;
    if (error instanceof CollectorFileSystemError && error.code === "locked") state.locked = true;
    return "leftover";
  }
}

// ----- Host slot (design 3.5, 8.3) ----------------------------------------------------------

const SLOT_FIXED_NAMES: readonly string[] = Object.freeze([COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME, ...COLLECTOR_HOST_LICENSE_FILES]);

async function copyVerified(
  context: Context,
  source: string,
  destination: string,
  expectedSha256: string | null,
): Promise<string> {
  let result;
  try {
    result = await context.deps.fileSystem.copyFileExclusive(source, destination);
  } catch (error: unknown) {
    if (error instanceof CollectorFileSystemError && error.code === "missing") throw new Abort("payload-unavailable");
    throw error;
  }
  if (result.sourceChanged) throw new Abort("source-changed");
  if (expectedSha256 !== null && result.sha256 !== expectedSha256) throw new Abort("hash-mismatch");
  return result.sha256;
}

async function removeIfPresent(context: Context, target: string): Promise<void> {
  try {
    await context.deps.fileSystem.removeFile(target);
  } catch {
    // best-effort cleanup of our own private temp name
  }
}

/** Make `host-<slot>` exist and be empty. A pre-existing reparse point aborts (design 8.3). */
async function prepareEmptySlot(context: Context, slot: CollectorHostSlot): Promise<string> {
  const { fileSystem } = context.deps;
  const directory = slotFolder(context.paths, slot);
  const entry = await fileSystem.stat(directory);
  if (entry === null) {
    if ((await fileSystem.makeDirectory(directory)) !== "created") throw new Abort("write-failed");
    return directory;
  }
  if (entry.isReparsePoint) throw new Abort("reparse-point-found");
  if (entry.kind !== "directory") throw new Abort("write-failed");
  const children = await fileSystem.listDirectory(directory);
  for (const child of children ?? []) {
    if (child.isReparsePoint || child.kind === "other") throw new Abort("reparse-point-found");
    // Re-checked here (the pre-write check can be stale): only our own names are ever deleted.
    if (child.kind !== "file" || !(SLOT_FIXED_NAMES.includes(child.name) || TEMP_NAME_PATTERN.test(child.name))) throw new Abort("program-folder-unrecognized-content");
    await fileSystem.removeFile(join(directory, child.name));
  }
  return directory;
}

async function writeSlot(context: Context, slot: CollectorHostSlot, descriptor: CollectorPayloadDescriptor): Promise<void> {
  const { fileSystem } = context.deps;
  const directory = await prepareEmptySlot(context, slot);
  for (const name of SLOT_FIXED_NAMES) {
    const expected = Object.hasOwn(descriptor.host.files, name) ? descriptor.host.files[name as keyof typeof descriptor.host.files] : null;
    const temporary = join(directory, temporaryName(context, name));
    const final = join(directory, name);
    let writtenHash: string;
    try {
      writtenHash = await copyVerified(context, join(context.deps.payloadSource.hostFolder, name), temporary, expected);
      await fileSystem.renameFile(temporary, final, { replace: false });
    } catch (error: unknown) {
      await removeIfPresent(context, temporary);
      throw error;
    }
    // Re-open the final file: regular, not a link, and the bytes on disk are the verified bytes.
    const entry = await fileSystem.stat(final);
    if (entry === null || entry.isReparsePoint || entry.kind !== "file") throw new Abort("hash-mismatch");
    const reference = expected ?? writtenHash;
    if (writtenHash !== reference || (await fileSystem.sha256File(final)) !== reference) throw new Abort("hash-mismatch");
  }
}

/**
 * Re-hash the Host executable and add-on of a slot against the descriptor. Called right before the
 * manifest switch (the slot is about to become what Chrome runs) and right before the self-check
 * spawn, so a swap of the files after `writeSlot` verified them is caught (TOCTOU).
 */
async function slotHostFilesMatch(context: Context, slot: CollectorHostSlot, descriptor: CollectorPayloadDescriptor): Promise<boolean> {
  const { fileSystem } = context.deps;
  for (const name of [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME] as const) {
    const target = join(slotFolder(context.paths, slot), name);
    const entry = await fileSystem.stat(target);
    if (entry === null || entry.isReparsePoint || entry.kind !== "file") return false;
    if ((await fileSystem.sha256File(target)) !== descriptor.host.files[name]) return false;
  }
  return true;
}

// ----- Extension folder (design 4.5, 6.4) ---------------------------------------------------

/**
 * Returns `false` when a leftover `extension.prev` could not be cleaned up (a locked file). The
 * current extension folder cannot then be moved out of the way, so the caller must NOT report the
 * extension as updated (see `swapExtension`). A restore of an interrupted swap stays strict.
 */
async function recoverPendingExtensionSwap(context: Context): Promise<boolean> {
  const { fileSystem } = context.deps;
  const { paths } = context;
  const previous = join(paths.programFolder, COLLECTOR_EXTENSION_PREVIOUS_NAME);
  const previousEntry = await fileSystem.stat(previous);
  if (previousEntry === null) return true;
  if (previousEntry.isReparsePoint || previousEntry.kind !== "directory") throw new Abort("reparse-point-found");
  const current = await fileSystem.stat(paths.extensionFolder);
  if (current === null) {
    // A swap was interrupted between the two renames: put the previous complete folder back.
    await fileSystem.renameDirectory(previous, paths.extensionFolder);
    return true;
  }
  try {
    if ((await removeTree(context, previous, false, { locked: false })) === "leftover") return false;
  } catch {
    return false;
  }
  return true;
}

async function stageExtension(context: Context, descriptor: CollectorPayloadDescriptor, staging: string): Promise<void> {
  const { fileSystem } = context.deps;
  const existing = await fileSystem.stat(staging);
  if (existing !== null) await removeTree(context, staging, true, { locked: false });
  if ((await fileSystem.makeDirectory(staging)) !== "created") throw new Abort("write-failed");
  const madeDirectories = new Set<string>();
  const names = Object.keys(descriptor.extension.files).sort();
  for (const name of names) {
    if (!isSafeRelativeFileName(name)) throw new Abort("payload-unavailable");
    const segments = name.split("/");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const directory = join(staging, ...segments.slice(0, index + 1));
      if (madeDirectories.has(directory)) continue;
      await fileSystem.makeDirectory(directory);
      madeDirectories.add(directory);
    }
    const expected = descriptor.extension.files[name] as string;
    const destination = join(staging, ...segments);
    await copyVerified(context, join(context.deps.payloadSource.extensionFolder, ...segments), destination, expected);
    // Re-read what was written.
    const entry = await fileSystem.stat(destination);
    if (entry === null || entry.isReparsePoint || entry.kind !== "file") throw new Abort("hash-mismatch");
    if ((await fileSystem.sha256File(destination)) !== expected) throw new Abort("hash-mismatch");
  }
  // Manifest key -> ID and version, from the bytes now on disk.
  const manifest = await fileSystem.readSmallFile(join(staging, "manifest.json"), 64 * 1024);
  if (manifest.kind !== "ok") throw new Abort("extension-verification-failed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes));
  } catch {
    throw new Abort("extension-verification-failed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Abort("extension-verification-failed");
  const record = parsed as Record<string, unknown>;
  if (deriveExtensionIdFromManifestKey(record.key) !== COLLECTOR_EXTENSION_ID) throw new Abort("extension-verification-failed");
  if (record.version !== descriptor.extension.version) throw new Abort("extension-verification-failed");
}

/**
 * Staged swap: `extension.next` -> verify -> `extension` -> `extension.prev`, `extension.next` ->
 * `extension`. The current folder is only ever renamed, never deleted, until the swap succeeded.
 */
async function swapExtension(context: Context, descriptor: CollectorPayloadDescriptor): Promise<void> {
  const { fileSystem } = context.deps;
  const { paths } = context;
  const staging = join(paths.programFolder, COLLECTOR_EXTENSION_STAGING_NAME);
  const previous = join(paths.programFolder, COLLECTOR_EXTENSION_PREVIOUS_NAME);
  // A locked `extension.prev` cannot be cleaned, and the current folder cannot be moved on top of
  // it. The extension would stay at the old version while the run claims the new one, so the run
  // FAILS (`file-locked`) here, before the manifest switch and before the state file is written:
  // nothing the previous installation depends on has changed, and the next refresh / repair
  // retries from the same point.
  if (!(await recoverPendingExtensionSwap(context))) throw new Abort("file-locked");
  await stageExtension(context, descriptor, staging);

  const current = await fileSystem.stat(paths.extensionFolder);
  if (current !== null && (current.isReparsePoint || current.kind !== "directory")) throw new Abort("reparse-point-found");
  if (current !== null) await fileSystem.renameDirectory(paths.extensionFolder, previous);
  try {
    await fileSystem.renameDirectory(staging, paths.extensionFolder);
  } catch (error: unknown) {
    if (current !== null) {
      try {
        await fileSystem.renameDirectory(previous, paths.extensionFolder);
      } catch {
        // `extension.prev` stays; the next repair restores it (recoverPendingExtensionSwap)
      }
    }
    throw error;
  }
  if (current !== null) {
    try {
      const result = await removeTree(context, previous, false, { locked: false });
      if (result === "leftover") warn(context, "previous-extension-retained");
    } catch {
      warn(context, "previous-extension-retained");
    }
  }
}

// ----- Manifest and state file --------------------------------------------------------------

async function writeAtomically(context: Context, finalPath: string, bytes: Uint8Array): Promise<void> {
  const { fileSystem } = context.deps;
  const existing = await fileSystem.stat(finalPath);
  if (existing !== null && (existing.isReparsePoint || existing.kind !== "file")) throw new Abort("reparse-point-found");
  const temporary = join(path.win32.dirname(finalPath), temporaryName(context, path.win32.basename(finalPath)));
  try {
    await fileSystem.writeFileExclusive(temporary, bytes);
    if ((await fileSystem.sha256File(temporary)) !== sha256Hex(bytes)) throw new Abort("hash-mismatch");
    await fileSystem.renameFile(temporary, finalPath, { replace: true });
  } catch (error: unknown) {
    await removeIfPresent(context, temporary);
    throw error;
  }
}

// ----- Registry -----------------------------------------------------------------------------

/** Read one target back and require `ours`. The native verdict is "default value equals <UserProgramFiles>\MAGINALIA Collector\<manifest>"; `resolveLayout` already required that this equals the folder verified above. */
function readBackTarget(context: Context, target: CollectorRegistryTargetId): void {
  let verdict: HostRegistrationOwnership;
  try {
    verdict = context.deps.registry.readCollectorHostRegistration(target);
  } catch {
    throw new Abort("registry-readback-mismatch");
  }
  if (verdict !== "ours") throw new Abort("registry-readback-mismatch");
}

/**
 * Registry step (design 5.2 step 8): every target of E, in registry order, each one independently.
 * `ours` is left alone; `absent` is registered; a `foreign` value (the user confirmed replacing it;
 * the guard proved it is still the same value) is replaced. A write that is refused or throws is
 * recorded for that target and the next target is still tried: the keys are independent and one
 * refusal is no reason to leave another browser unregistered. Nothing is rolled back (design 5.3):
 * a target that was written points at a complete slot (invariant I'), so removing it again would only
 * break a working browser. A target that comes back `foreign` from the addon (someone wrote it after
 * the guard) aborts the run. Every target that is `ours` afterwards is read back.
 *
 * A refresh never writes a target that was registered before (that key was removed by someone: a
 * repair decides) and never replaces anything.
 */
function registerExpectedTargets(
  context: Context,
  plan: TargetPlan,
  action: "setup" | "repair" | "refresh",
  targets: CollectorApplyTargetResult[],
): "ok" | "registry-write-denied" | "registry-write-failed" {
  const { registry } = context.deps;
  let denied = false;
  let failed = false;
  for (const target of plan.expected) {
    const initial = plan.snapshot[target] ?? "absent";
    if (initial === "ours") {
      readBackTarget(context, target);
      targets.push({ target, result: "ours-already" });
      continue;
    }
    if (action === "refresh" && initial === "foreign") throw new Abort("registration-changed"); // a refresh never replaces
    if (action === "refresh" && plan.registered.includes(target)) {
      targets.push({ target, result: "left-absent" });
      continue;
    }
    let outcome;
    try {
      outcome = initial === "foreign" ? registry.replaceForeignCollectorHostRegistration(target) : registry.registerCollectorHost(target);
    } catch {
      failed = true;
      targets.push({ target, result: "failed" });
      continue;
    }
    if (outcome === "foreign") throw new Abort("registration-changed");
    if (outcome !== "ok") {
      if (outcome === "access-denied") denied = true;
      else failed = true;
      targets.push({ target, result: outcome === "access-denied" ? "denied" : "failed" });
      continue;
    }
    readBackTarget(context, target);
    targets.push({ target, result: initial === "foreign" ? "replaced" : "registered" });
  }
  return denied ? "registry-write-denied" : failed ? "registry-write-failed" : "ok";
}

/**
 * Targets that did not take part in the registry step, for the result (design 5.2): a writable
 * target whose browser is policy-blocked is `skipped-policy`, any other one that E does not contain
 * is `not-expected`. Registry order.
 */
function completeTargetResults(plan: TargetPlan, done: readonly CollectorApplyTargetResult[]): readonly CollectorApplyTargetResult[] {
  return Object.freeze(WRITABLE_TARGET_IDS.map((target) => {
    const known = done.find((entry) => entry.target === target);
    if (known !== undefined) return Object.freeze(known);
    const blockedRow = plan.table.some((row) => row.verification === "verified" && plan.blockedBrowsers.includes(row.id) && row.nativeMessaging.ownTargets.includes(target));
    return Object.freeze({ target, result: blockedRow ? ("skipped-policy" as const) : ("not-expected" as const) });
  }));
}

/**
 * `registeredTargets` for the state file (design 4.3, S4 decision a). It records every target this
 * run was responsible for, `ours` or not: E (including a target whose write was refused) and what
 * the previous state file already listed. A refused write therefore stays `registration-missing`
 * (a repair notice) on the next inspection instead of turning into `outdated(registration-target-added)`,
 * which would re-run an automatic refresh at every start without anyone being told. Registry order.
 */
function nextRegisteredTargets(plan: TargetPlan): readonly CollectorRegistryTargetId[] {
  const wanted = new Set<CollectorRegistryTargetId>([...plan.registered, ...plan.expected]);
  return Object.freeze(WRITABLE_TARGET_IDS.filter((target) => wanted.has(target)));
}

// ----- Self-check (design 3.5, 4.3) ---------------------------------------------------------

async function runSelfCheck(context: Context, slot: CollectorHostSlot, descriptor: CollectorPayloadDescriptor): Promise<boolean> {
  const { deps, paths } = context;
  try {
    // Resolve the registration exactly as Chrome would: registry value -> manifest -> `path`.
    const read = await deps.fileSystem.readSmallFile(paths.manifestPath, MAX_MANIFEST_BYTES);
    if (read.kind !== "ok") return false;
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as { path?: unknown };
    if (typeof manifest.path !== "string") return false;
    const resolved = path.win32.isAbsolute(manifest.path) ? manifest.path : join(paths.programFolder, manifest.path);
    const expected = join(slotFolder(paths, slot), COLLECTOR_HOST_EXECUTABLE_NAME);
    if (!sameLocation(resolved, expected)) return false;
    const entry = await deps.fileSystem.stat(expected);
    if (entry === null || entry.kind !== "file" || entry.isReparsePoint) return false;
    // Re-hash immediately before spawning. The hash is taken by path and the spawn is by path, so
    // this only narrows the window for a same-user swap of the file (accepted, design 8.3); it is
    // not an atomic bind between the verified bytes and the process.
    if (!(await slotHostFilesMatch(context, slot, descriptor))) return false;
    const result = await deps.runHostSelfCheck({ executablePath: expected, allowedOrigin: COLLECTOR_ALLOWED_ORIGINS[0] as string });
    if (result.status !== "ok" || result.protocol !== COLLECTOR_PROTOCOL) return false;
    // TODO(WP-6): the Host does not report its version in `health` until `host_info` lands, so
    // `hostVersion` is `undefined` today and this comparison never rejects anything. Once WP-6
    // ships, make a missing `hostVersion` a failure as well.
    return result.hostVersion === undefined || result.hostVersion === descriptor.host.version;
  } catch {
    return false;
  }
}

// ----- Orchestration ------------------------------------------------------------------------

async function result(
  deps: CollectorIntegrationApplyDependencies,
  action: CollectorApplyAction,
  outcome: CollectorApplyOutcome,
  reason: CollectorApplyReason | null,
  warnings: readonly CollectorApplyWarning[],
  selfCheck: "ok" | "failed" | "skipped",
  existing?: CollectorIntegrationInspection,
  details: { readonly targets?: readonly CollectorApplyTargetResult[]; readonly filesChanged?: boolean } = {},
): Promise<CollectorApplyResult> {
  const inspection = existing ?? await inspectCollectorIntegration(deps);
  const state: CollectorIntegrationState = selfCheck === "failed" ? "damaged" : inspection.state;
  return Object.freeze({
    action,
    outcome,
    reason,
    warnings: Object.freeze([...warnings]),
    targets: Object.freeze([...(details.targets ?? [])]),
    filesChanged: details.filesChanged === true,
    state,
    selfCheck,
    inspection,
  });
}

/** Reads the manifest on disk and returns the slot it points at, or `null` when absent/invalid/unrecognized. */
async function readManifestSlot(context: Context): Promise<CollectorHostSlot | null> {
  try {
    const read = await context.deps.fileSystem.readSmallFile(context.paths.manifestPath, MAX_MANIFEST_BYTES);
    if (read.kind !== "ok") return null;
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown;
    return collectorManifestSlot(manifest, context.paths.programFolder);
  } catch {
    return null;
  }
}

/**
 * The slot to write is always the one the manifest on disk does NOT point at: that is the slot
 * Chrome runs, and it must stay complete (invariant: registration ours and manifest valid => the
 * pointed slot is hash-complete at every crash point). The state file is only a fallback for a
 * missing or invalid manifest, because a crash between the manifest switch and the state write
 * leaves the state file stale while the manifest is already current.
 */
async function chooseTargetSlot(context: Context, first: CollectorIntegrationInspection): Promise<CollectorHostSlot> {
  const pointed = await readManifestSlot(context);
  const active: CollectorHostSlot | null = pointed ?? first.installed.activeSlot;
  return active === "a" ? "b" : "a";
}

async function standaloneLeftover(context: Context): Promise<boolean> {
  try {
    const entry = await context.deps.fileSystem.stat(join(userProgramFilesOf(context.paths), COLLECTOR_STANDALONE_FOLDER_NAME));
    return entry !== null && entry.kind === "directory";
  } catch {
    return false;
  }
}

interface Precondition {
  readonly kind: "refuse" | "noop" | "run";
  readonly reason?: CollectorApplyReason;
}

const RUN_FROM: Readonly<Record<"setup" | "repair" | "refresh", readonly CollectorIntegrationState[]>> = {
  setup: ["not-set-up", "foreign-registration"],
  repair: ["registration-missing", "damaged", "foreign-registration"],
  refresh: ["outdated"],
};

function evaluatePreconditions(deps: CollectorIntegrationApplyDependencies, request: CollectorApplyRequest, first: CollectorIntegrationInspection): Precondition {
  if (deps.e2eIsolationActive) return { kind: "refuse", reason: "e2e-isolation" };
  const { action } = request;
  if (action === "remove") {
    // Removal is allowed under a Chrome policy block: it only deletes names we own.
    if (!first.inspectionComplete) return { kind: "refuse", reason: "inspection-incomplete" };
    // An unsafe program folder does not refuse: remove still unregisters (value-matched) and then
    // reports `partial` without touching the folder.
    return { kind: "run" };
  }
  if (first.state === "policy-blocked") return { kind: "refuse", reason: "policy-blocked" };
  if (!first.inspectionComplete) return { kind: "refuse", reason: "inspection-incomplete" };
  if (first.state === "ready") return { kind: "noop" };
  if (first.reasons.includes("program-folder-unsafe")) return { kind: "refuse", reason: "program-folder-unsafe" };
  if (!RUN_FROM[action].includes(first.state)) return { kind: "refuse", reason: "wrong-state" };
  if (first.reasons.includes("reparse-point-found")) return { kind: "refuse", reason: "reparse-point-found" };
  if (first.payload.status !== "valid") return { kind: "refuse", reason: "payload-unavailable" };
  if (first.state === "foreign-registration" && !("confirmReplaceForeign" in request && request.confirmReplaceForeign === true)) {
    return { kind: "refuse", reason: "foreign-confirmation-required" };
  }
  return { kind: "run" };
}

async function converge(
  deps: CollectorIntegrationApplyDependencies,
  request: Exclude<CollectorApplyRequest, { action: "remove" }>,
  first: CollectorIntegrationInspection,
): Promise<CollectorApplyResult> {
  // `applyExclusive` routes `remove` elsewhere; the union type cannot express that.
  const action = request.action as "setup" | "repair" | "refresh";
  const paths = resolveLayout(deps);
  if (paths === undefined) return result(deps, request.action, "refused", "layout-unresolved", [], "skipped", first);
  const context: Context = { deps, paths, warnings: [] };
  if (first.registration === "unknown") return result(deps, request.action, "refused", "inspection-incomplete", [], "skipped", first);
  const plan = buildTargetPlan(deps, first);
  // Nothing to register (no verified, unblocked browser needs a key): a setup would place files that
  // no browser can ever start. Refused before anything is written.
  if (plan.expected.length === 0) return result(deps, request.action, "refused", "wrong-state", [], "skipped", first);

  let descriptor: CollectorPayloadDescriptor;
  try {
    const parsed = parseCollectorPayloadDescriptor(await deps.readPayloadDescriptor());
    if (!parsed.ok || parsed.descriptor.payloadId !== first.payload.payloadId) throw new Abort("payload-unavailable");
    descriptor = parsed.descriptor;
    if (!isLocalAbsoluteWindowsPath(deps.payloadSource.hostFolder) || !isLocalAbsoluteWindowsPath(deps.payloadSource.extensionFolder)) throw new Abort("payload-unavailable");
  } catch {
    return result(deps, request.action, "refused", "payload-unavailable", [], "skipped", first);
  }

  // Registration-only refresh (design 5.4): the installation is current and healthy and only a
  // registry target was added (a new version registers more browsers, or a `when-present` browser
  // appeared). No slot, extension or manifest is written, so nothing the browsers run changes.
  const registrationOnly = request.action === "refresh"
    && first.reasons.length === 1
    && first.reasons[0] === "registration-target-added"
    && first.installed.payloadId === descriptor.payloadId;

  let reason: CollectorApplyReason | null = null;
  let wrote = false;
  let placed = false;
  let selfCheck: "ok" | "failed" | "skipped" = "skipped";
  const targets: CollectorApplyTargetResult[] = [];
  const finish = (outcome: CollectorApplyOutcome, why: CollectorApplyReason | null): Promise<CollectorApplyResult> =>
    result(deps, request.action, outcome, why, context.warnings, selfCheck, undefined, {
      targets: targets.length > 0 ? completeTargetResults(plan, targets) : [],
      filesChanged: placed,
    });
  try {
    let slot: CollectorHostSlot;
    let stateFields: { readonly payloadId: string; readonly extensionVersion: string; readonly placedAt: string };
    if (registrationOnly) {
      await guard(context, plan, { folderExists: true });
      const current = await readValidStateFile(context);
      if (current === undefined) throw new Abort("program-folder-unrecognized-content");
      wrote = true;
      slot = current.activeSlot;
      // Files are not placed: the state file keeps what it says about them.
      stateFields = { payloadId: current.payloadId, extensionVersion: current.extensionVersion, placedAt: current.placedAt };
      await guard(context, plan, { folderExists: true });
    } else {
      await guard(context, plan, { folderExists: false });
      await ensureProgramFolder(context);
      await refuseLinkedNames(context);
      await requireRecognizedContent(context, descriptor, await hasValidStateFile(context));
      wrote = true;
      await ensureIntegrationDirectory(context);
      await guard(context, plan, { folderExists: true });
      slot = await chooseTargetSlot(context, first);

      placed = true;
      await writeSlot(context, slot, descriptor);
      await swapExtension(context, descriptor);

      // Last check before the manifest switch: the Host files are re-hashed (not trusted from
      // `writeSlot`) and the guard is re-evaluated. After the manifest rename succeeds Chrome runs the
      // new Host and nothing is rolled back: a later failure (registry, state file, self-check) is
      // reported as `failed` with the files left in place, the previous slot stays complete as the
      // fallback, and a repair converges. Until that rename the previous installation is untouched.
      if (!(await slotHostFilesMatch(context, slot, descriptor))) throw new Abort("hash-mismatch");
      await guard(context, plan, { folderExists: true });
      await writeAtomically(context, paths.manifestPath, manifestBytes(slot, paths.programFolder));
      stateFields = { payloadId: descriptor.payloadId, extensionVersion: descriptor.extension.version, placedAt: deps.now().toISOString() };
    }

    const registryStep = registerExpectedTargets(context, plan, action, targets);
    // Files are complete and verified: record them even when a registry write was denied, so the
    // state is the deterministic `registration-missing` (or still-foreign) with a repair.
    await writeAtomically(context, join(paths.programFolder, COLLECTOR_STATE_FILE_NAME), stateBytes(stateFields, slot, nextRegisteredTargets(plan)));
    if (registryStep !== "ok") {
      reason = registryStep;
    } else {
      if (await standaloneLeftover(context)) warn(context, "standalone-leftover");
      selfCheck = (await runSelfCheck(context, slot, descriptor)) ? "ok" : "failed";
      if (selfCheck === "failed") reason = "self-check-failed";
    }
  } catch (error: unknown) {
    reason = reasonForError(error);
  }
  if (reason === null) return finish("applied", null);
  // `refused` = a precondition failed before anything of the installation was changed. `wrote`
  // turns true once the program folder is verified and every content check passed; creating the
  // empty program folder itself does not count (a refusal may leave an empty protected folder).
  // Any failure after that point is `failed`, with the post-action inspection showing what is on disk.
  const refusedBeforeWrite = !wrote && (reason === "e2e-isolation" || reason === "policy-blocked" || reason === "registration-changed" || reason === "expected-targets-changed" || reason === "program-folder-unsafe" || reason === "inspection-incomplete" || reason === "reparse-point-found" || reason === "program-folder-unrecognized-content");
  return finish(refusedBeforeWrite ? "refused" : "failed", reason);
}

// ----- Remove (design 3.5, 2.4, 8.5) --------------------------------------------------------

async function removeFixedFile(context: Context, target: string, state: { locked: boolean; leftover: boolean }): Promise<void> {
  const { fileSystem } = context.deps;
  try {
    const entry = await fileSystem.stat(target);
    if (entry === null) return;
    if (entry.isReparsePoint || entry.kind !== "file") {
      state.leftover = true;
      return;
    }
    await fileSystem.removeFile(target);
  } catch (error: unknown) {
    if (error instanceof CollectorFileSystemError && error.code === "locked") state.locked = true;
    state.leftover = true;
  }
}

async function removeSlot(context: Context, slot: CollectorHostSlot, state: { locked: boolean; leftover: boolean }): Promise<void> {
  const { fileSystem } = context.deps;
  const directory = slotFolder(context.paths, slot);
  try {
    const entry = await fileSystem.stat(directory);
    if (entry === null) return;
    if (entry.isReparsePoint || entry.kind !== "directory") {
      state.leftover = true;
      return;
    }
    const children = await fileSystem.listDirectory(directory);
    for (const child of children ?? []) {
      if (SLOT_FIXED_NAMES.includes(child.name) || TEMP_NAME_PATTERN.test(child.name)) {
        await removeFixedFile(context, join(directory, child.name), state);
      }
    }
    await fileSystem.removeEmptyDirectory(directory);
  } catch (error: unknown) {
    if (error instanceof CollectorFileSystemError && error.code === "locked") state.locked = true;
    state.leftover = true;
  }
}

/**
 * Delete the files a descriptor lists below `directory`, then the directories that become empty.
 * Never lists-and-deletes: a file the descriptor does not name is never touched, and an ancestor
 * that is a link (or not a directory) stops the walk so nothing is deleted through it. Anything
 * left over (user files, unlisted names, a locked file) marks the tally `leftover`.
 */
async function removeNamedExtensionFiles(
  context: Context,
  directory: string,
  descriptor: CollectorPayloadDescriptor | null,
  owned: boolean,
  tally: { locked: boolean; leftover: boolean },
): Promise<void> {
  const { fileSystem } = context.deps;
  try {
    const root = await fileSystem.stat(directory);
    if (root === null) return;
    if (root.isReparsePoint || root.kind !== "directory") {
      tally.leftover = true; // never followed
      return;
    }
    if (owned) {
      // A valid state file marks the folder as ours, whichever version's files it holds. Links
      // and unusual entries inside are skipped (the folder then stays), never followed.
      const state = { locked: false };
      const outcome = await removeTree(context, directory, false, state);
      if (state.locked) tally.locked = true;
      if (outcome === "leftover") tally.leftover = true;
      return;
    }
    if (descriptor === null) {
      tally.leftover = true; // not provably ours by name: it stays
      return;
    }
    const directories = new Map<string, number>();
    const plain = new Set<string>();
    const isPlainDirectory = async (target: string): Promise<boolean> => {
      if (plain.has(target)) return true;
      const entry = await fileSystem.stat(target);
      if (entry === null || entry.isReparsePoint || entry.kind !== "directory") return false;
      plain.add(target);
      return true;
    };
    for (const name of Object.keys(descriptor.extension.files).sort()) {
      const segments = name.split("/");
      let current = directory;
      let reachable = true;
      for (let index = 0; index < segments.length - 1; index += 1) {
        current = join(current, segments[index] as string);
        directories.set(current, index + 1);
        if (reachable && !(await isPlainDirectory(current))) reachable = false;
      }
      if (reachable) await removeFixedFile(context, join(directory, ...segments), tally);
    }
    for (const [target] of [...directories].sort((left, right) => right[1] - left[1])) {
      if (!plain.has(target)) continue;
      try {
        await fileSystem.removeEmptyDirectory(target);
      } catch (error: unknown) {
        if (error instanceof CollectorFileSystemError && error.code === "locked") tally.locked = true;
        tally.leftover = true;
      }
    }
    try {
      await fileSystem.removeEmptyDirectory(directory);
    } catch (error: unknown) {
      if (error instanceof CollectorFileSystemError && error.code === "locked") tally.locked = true;
      tally.leftover = true;
    }
  } catch {
    tally.leftover = true;
  }
}

async function packagedDescriptorOrNull(deps: CollectorIntegrationApplyDependencies): Promise<CollectorPayloadDescriptor | null> {
  try {
    const parsed = parseCollectorPayloadDescriptor(await deps.readPayloadDescriptor());
    return parsed.ok ? parsed.descriptor : null;
  } catch {
    return null;
  }
}

/** The targets a remove run reached, in registry order (a refusal before the unregister step lists none). */
function completeRemoveResults(targets: readonly CollectorApplyTargetResult[]): readonly CollectorApplyTargetResult[] {
  return Object.freeze(WRITABLE_TARGET_IDS.flatMap((target) => {
    const known = targets.find((entry) => entry.target === target);
    return known === undefined ? [] : [Object.freeze(known)];
  }));
}

async function remove(
  deps: CollectorIntegrationApplyDependencies,
  first: CollectorIntegrationInspection,
): Promise<CollectorApplyResult> {
  const paths = resolveLayout(deps);
  if (paths === undefined) return result(deps, "remove", "refused", "layout-unresolved", [], "skipped", first);
  const context: Context = { deps, paths, warnings: [] };
  const { fileSystem } = deps;
  const tally = { locked: false, leftover: false };
  const targets: CollectorApplyTargetResult[] = [];
  const done = (outcome: CollectorApplyOutcome, reason: CollectorApplyReason | null, selfCheck: "skipped" = "skipped", existing?: CollectorIntegrationInspection): Promise<CollectorApplyResult> =>
    result(deps, "remove", outcome, reason, context.warnings, selfCheck, existing, { targets: completeRemoveResults(targets) });
  let folderIsSafe = true;
  let unregistered = false;
  try {
    const folder = await fileSystem.stat(paths.programFolder);
    // Every WRITABLE target, whatever the expected set E is now (a policy block or an unverified
    // browser row must not leave our key behind), each one read fresh: nothing from the first
    // inspection is trusted here. A key that cannot be read is never reported as removed: nothing has
    // been changed yet, so the run is refused and can be repeated.
    const ownerships = new Map<CollectorRegistryTargetId, HostRegistrationOwnership>();
    for (const target of WRITABLE_TARGET_IDS) {
      try {
        ownerships.set(target, deps.registry.readCollectorHostRegistration(target));
      } catch {
        return done("refused", "inspection-incomplete", "skipped", first);
      }
    }
    if (folder === null && ![...ownerships.values()].includes("ours")) return result(deps, "remove", "noop", null, [], "skipped", first);

    // 1. Registry first, value-matched by the native layer; a foreign value is left untouched. Reverse
    //    registry order, and every target is tried even after one failed (the keys are independent).
    //    This runs even when the program folder is not safe to touch: removing our registration
    //    stops the browser from starting whatever is in that folder, and it deletes nothing on disk.
    let unregisterFailed = false;
    for (const target of [...WRITABLE_TARGET_IDS].reverse()) {
      const ownership = ownerships.get(target);
      if (ownership === "foreign") {
        warn(context, "foreign-registration-left");
        targets.push({ target, result: "foreign-left" });
      } else if (ownership === "absent") {
        targets.push({ target, result: "not-registered" });
      } else {
        let outcome;
        try {
          outcome = deps.registry.unregisterCollectorHost(target);
        } catch {
          unregisterFailed = true;
          targets.push({ target, result: "failed" });
          continue;
        }
        if (outcome === "foreign") {
          warn(context, "foreign-registration-left");
          targets.push({ target, result: "foreign-left" });
        } else if (outcome === "not-registered") {
          targets.push({ target, result: "not-registered" });
        } else if (outcome === "ok") {
          unregistered = true;
          targets.push({ target, result: "removed" });
        } else {
          unregisterFailed = true;
          targets.push({ target, result: outcome === "access-denied" ? "denied" : "failed" });
        }
      }
    }
    // A key that is still ours keeps the files: the browser that uses it must find a complete Host
    // (design 5.5). Whatever was removed stays removed; running remove again converges.
    if (unregisterFailed) return done("failed", "unregister-failed");

    // 2. Only then decide whether the folder may be touched at all.
    if (folder !== null) {
      if (folder.isReparsePoint || folder.kind !== "directory") {
        folderIsSafe = false;
      } else {
        try {
          requireSafeDirectory(context, paths.programFolder);
        } catch {
          folderIsSafe = false;
        }
      }
    }
  } catch {
    return result(deps, "remove", "failed", "write-failed", [], "skipped");
  }
  if (!folderIsSafe) {
    // Nothing on disk was touched. If a registration was removed, that much was done: `partial`.
    // If nothing at all changed (absent or foreign registration), this is a plain refusal.
    if (!unregistered) return done("refused", "program-folder-unsafe");
    warn(context, "leftovers-remain");
    return done("partial", "program-folder-unsafe");
  }

  // 3. Names we own, inside the program folder only. Nothing is deleted by listing a folder and
  //    removing what is found: unknown names (user files) stay and make the outcome `partial`.
  const descriptor = await packagedDescriptorOrNull(deps);
  const owned = await hasValidStateFile(context);
  try {
    if ((await fileSystem.stat(paths.programFolder)) !== null) {
      await removeFixedFile(context, paths.manifestPath, tally);
      const top = await fileSystem.listDirectory(paths.programFolder);
      for (const entry of top ?? []) {
        if (entry.kind === "file" && !entry.isReparsePoint && TEMP_NAME_PATTERN.test(entry.name)) {
          await removeFixedFile(context, join(paths.programFolder, entry.name), tally);
        }
      }
      for (const slot of COLLECTOR_HOST_SLOTS) await removeSlot(context, slot, tally);
      for (const name of [COLLECTOR_EXTENSION_FOLDER_NAME, COLLECTOR_EXTENSION_STAGING_NAME, COLLECTOR_EXTENSION_PREVIOUS_NAME]) {
        await removeNamedExtensionFiles(context, join(paths.programFolder, name), descriptor, owned, tally);
      }
      // The state file goes last so that an interrupted removal can still be recognized as ours.
      if (!tally.leftover) {
        await removeFixedFile(context, join(paths.programFolder, COLLECTOR_STATE_FILE_NAME), tally);
      }
      if (!tally.leftover) {
        try {
          await fileSystem.removeEmptyDirectory(paths.programFolder);
        } catch (error: unknown) {
          if (error instanceof CollectorFileSystemError && error.code === "locked") tally.locked = true;
          tally.leftover = true; // unknown files stay: the safe failure (design 2.4)
        }
      }
    }
  } catch {
    tally.leftover = true;
  }
  if (tally.leftover) warn(context, "leftovers-remain");
  return done(tally.leftover ? "partial" : "applied", tally.locked ? "file-locked" : null);
}

// ----- Entry point --------------------------------------------------------------------------

/**
 * Apply one integration action. Never throws. See the module comment for the transitions and
 * the order of side effects.
 */
export async function applyCollectorIntegration(
  request: CollectorApplyRequest,
  deps: CollectorIntegrationApplyDependencies,
): Promise<CollectorApplyResult> {
  // Set synchronously, before the first await: two overlapping calls can never both pass this line.
  if (applyInFlight) return result(deps, request.action, "refused", "busy", [], "skipped");
  applyInFlight = true;
  try {
    return await applyExclusive(request, deps);
  } finally {
    applyInFlight = false;
  }
}

/** Process-wide: there is one program folder, one manifest and one registry value per user. */
let applyInFlight = false;

async function applyExclusive(
  request: CollectorApplyRequest,
  deps: CollectorIntegrationApplyDependencies,
): Promise<CollectorApplyResult> {
  const first = await inspectCollectorIntegration(deps); // never throws
  const precondition = evaluatePreconditions(deps, request, first);
  if (precondition.kind === "refuse") return result(deps, request.action, "refused", precondition.reason ?? "wrong-state", [], "skipped", first);
  if (precondition.kind === "noop") return result(deps, request.action, "noop", null, [], "skipped", first);
  try {
    if (request.action === "remove") return await remove(deps, first);
    return await converge(deps, request, first);
  } catch {
    return result(deps, request.action, "failed", "write-failed", [], "skipped");
  }
}
