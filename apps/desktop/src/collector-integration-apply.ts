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
 * Order of side effects for setup / repair / refresh (each step is verified before the next):
 *  1. preconditions (inspect; E2E isolation; policy; payload; state matrix; foreign confirmation)
 *  2. program folder (protected DACL; parents checked; existing unsafe folder is never re-permissioned)
 *  3. integration folder (protected DACL) and stale contact temp files
 *  4. recover a pending extension swap; guard re-check
 *  5. write the INACTIVE Host slot (exclusive temp, hash of written bytes, rename, re-read hash)
 *  6. stage `extension.next`, verify manifest key -> ID and every file hash, swap folders
 *  7. guard re-check (point of no return), then write the manifest (temp + rename) for the new slot
 *  8. registry (setup/repair only), then read back: ownership `ours`
 *  9. `integration-state.json` (temp + rename)
 * 10. prune the previous slot and `extension.prev` (a locked file is a warning, never an error)
 * 11. Host self-check
 *
 * Remove: value-matched unregister first (a foreign value is left alone), then fixed names only:
 * manifest, slots (fixed file names), extension folders, state file, then a non-recursive rmdir.
 * Links and reparse points are skipped, never followed.
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
  COLLECTOR_EXTENSION_FOLDER_NAME,
  COLLECTOR_HOST_SLOTS,
  COLLECTOR_STATE_FILE_NAME,
  evaluateChromePolicies,
  inspectCollectorIntegration,
  isLocalAbsoluteWindowsPath,
  resolveIntegrationPaths,
  slotFolder,
  type CollectorHostSlot,
  type IntegrationPaths,
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

function stateBytes(descriptor: CollectorPayloadDescriptor, slot: CollectorHostSlot, now: Date): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    version: 1,
    payloadId: descriptor.payloadId,
    activeSlot: slot,
    extensionVersion: descriptor.extension.version,
    placedAt: now.toISOString(),
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

function requireSafeDirectory(context: Context, target: string): void {
  const result = inspectAndEvaluatePathSecurity(context.deps.inspectPathSecurity, target, "directory");
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
  if (parent !== programs && path.win32.dirname(parent) !== parent) requireSafeDirectory(context, parent);
  const programsEntry = await deps.fileSystem.stat(programs);
  if (programsEntry === null) {
    await deps.fileSystem.createPrivateDirectory(programs);
  } else if (programsEntry.isReparsePoint || programsEntry.kind !== "directory") {
    throw new Abort("program-folder-unsafe");
  }
  requireSafeDirectory(context, programs);

  const entry = await deps.fileSystem.stat(paths.programFolder);
  if (entry === null) {
    await deps.fileSystem.createPrivateDirectory(paths.programFolder);
  } else if (entry.isReparsePoint || entry.kind !== "directory") {
    throw new Abort("program-folder-unsafe");
  }
  requireSafeDirectory(context, paths.programFolder);
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

async function guard(context: Context, expectedRegistration: HostRegistrationOwnership, options: { readonly folderExists: boolean }): Promise<void> {
  const { deps, paths } = context;
  if (deps.e2eIsolationActive) throw new Abort("e2e-isolation");
  try {
    if (evaluateChromePolicies(deps.registry.readChromePolicies()).blocked) throw new Abort("policy-blocked");
  } catch (error: unknown) {
    if (error instanceof Abort) throw error;
    // Unreadable policies never block by themselves (design 8.4: Chrome is the authority).
  }
  let registration: HostRegistrationOwnership;
  try {
    registration = deps.registry.readCollectorHostRegistration();
  } catch {
    throw new Abort("inspection-incomplete");
  }
  if (registration !== expectedRegistration) throw new Abort("registration-changed");
  if (options.folderExists) requireSafeDirectory(context, paths.programFolder);
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
    if (child.isReparsePoint || child.kind !== "file") throw new Abort("reparse-point-found");
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

// ----- Extension folder (design 4.5, 6.4) ---------------------------------------------------

async function recoverPendingExtensionSwap(context: Context): Promise<void> {
  const { fileSystem } = context.deps;
  const { paths } = context;
  const previous = join(paths.programFolder, COLLECTOR_EXTENSION_PREVIOUS_NAME);
  const previousEntry = await fileSystem.stat(previous);
  if (previousEntry === null) return;
  if (previousEntry.isReparsePoint || previousEntry.kind !== "directory") throw new Abort("reparse-point-found");
  const current = await fileSystem.stat(paths.extensionFolder);
  if (current === null) {
    // A swap was interrupted between the two renames: put the previous complete folder back.
    await fileSystem.renameDirectory(previous, paths.extensionFolder);
  } else {
    await removeTree(context, previous, true, { locked: false });
  }
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
  await recoverPendingExtensionSwap(context);
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

type RegistryStep = "ok" | "registry-write-denied" | "registry-write-failed";

function writeRegistration(context: Context, initial: HostRegistrationOwnership): RegistryStep {
  const { registry } = context.deps;
  if (initial === "ours") return "ok";
  let outcome;
  try {
    outcome = initial === "foreign" ? registry.replaceForeignCollectorHostRegistration() : registry.registerCollectorHost();
  } catch {
    return "registry-write-failed";
  }
  if (outcome === "ok") return "ok";
  if (outcome === "foreign") throw new Abort("registration-changed");
  return outcome === "access-denied" ? "registry-write-denied" : "registry-write-failed";
}

function readBackRegistration(context: Context): void {
  let verdict: HostRegistrationOwnership;
  try {
    verdict = context.deps.registry.readCollectorHostRegistration();
  } catch {
    throw new Abort("registry-readback-mismatch");
  }
  // The native verdict is "default value equals <UserProgramFiles>\MAGINALIA Collector\<manifest>";
  // `resolveLayout` already required that this equals the folder verified above.
  if (verdict !== "ours") throw new Abort("registry-readback-mismatch");
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
    const result = await deps.runHostSelfCheck({ executablePath: expected, allowedOrigin: COLLECTOR_ALLOWED_ORIGINS[0] as string });
    if (result.status !== "ok" || result.protocol !== COLLECTOR_PROTOCOL) return false;
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
): Promise<CollectorApplyResult> {
  const inspection = existing ?? await inspectCollectorIntegration(deps);
  const state: CollectorIntegrationState = selfCheck === "failed" ? "damaged" : inspection.state;
  return Object.freeze({ action, outcome, reason, warnings: Object.freeze([...warnings]), state, selfCheck, inspection });
}

async function chooseTargetSlot(context: Context, first: CollectorIntegrationInspection): Promise<CollectorHostSlot> {
  let active: CollectorHostSlot | null = first.installed.activeSlot;
  if (active === null) {
    // No usable state file: fall back to the slot the manifest on disk points at, if any.
    try {
      const read = await context.deps.fileSystem.readSmallFile(context.paths.manifestPath, MAX_MANIFEST_BYTES);
      if (read.kind === "ok") {
        const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as { path?: unknown };
        const match = typeof manifest.path === "string" ? /(?:^|[\\/])host-([ab])[\\/]/iu.exec(manifest.path) : null;
        if (match !== null) active = (match[1] as string).toLowerCase() as CollectorHostSlot;
      }
    } catch {
      active = null;
    }
  }
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

async function pruneSlot(context: Context, slot: CollectorHostSlot): Promise<void> {
  const { fileSystem } = context.deps;
  const directory = slotFolder(context.paths, slot);
  try {
    const entry = await fileSystem.stat(directory);
    if (entry === null) return;
    if (entry.isReparsePoint || entry.kind !== "directory") {
      warn(context, "previous-slot-retained");
      return;
    }
    const children = await fileSystem.listDirectory(directory);
    let clean = true;
    for (const child of children ?? []) {
      if (child.isReparsePoint || child.kind !== "file" || !(SLOT_FIXED_NAMES.includes(child.name) || TEMP_NAME_PATTERN.test(child.name))) {
        clean = false;
        continue;
      }
      try {
        await fileSystem.removeFile(join(directory, child.name));
      } catch {
        clean = false;
      }
    }
    if (clean) await fileSystem.removeEmptyDirectory(directory);
    else warn(context, "previous-slot-retained");
  } catch {
    warn(context, "previous-slot-retained");
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
    // Removal is allowed under a Chrome policy block: it only deletes our own fixed names.
    if (!first.inspectionComplete) return { kind: "refuse", reason: "inspection-incomplete" };
    if (first.reasons.includes("program-folder-unsafe")) return { kind: "refuse", reason: "program-folder-unsafe" };
    return { kind: "run" };
  }
  if (first.state === "policy-blocked") return { kind: "refuse", reason: "policy-blocked" };
  if (!first.inspectionComplete) return { kind: "refuse", reason: "inspection-incomplete" };
  if (first.state === "ready") return { kind: "noop" };
  if (!RUN_FROM[action].includes(first.state)) return { kind: "refuse", reason: "wrong-state" };
  if (first.reasons.includes("program-folder-unsafe")) return { kind: "refuse", reason: "program-folder-unsafe" };
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
  const paths = resolveLayout(deps);
  if (paths === undefined) return result(deps, request.action, "refused", "layout-unresolved", [], "skipped", first);
  const context: Context = { deps, paths, warnings: [] };
  const initialRegistration: HostRegistrationOwnership = first.registration === "unknown" ? "absent" : first.registration;
  if (first.registration === "unknown") return result(deps, request.action, "refused", "inspection-incomplete", [], "skipped", first);

  let descriptor: CollectorPayloadDescriptor;
  try {
    const parsed = parseCollectorPayloadDescriptor(await deps.readPayloadDescriptor());
    if (!parsed.ok || parsed.descriptor.payloadId !== first.payload.payloadId) throw new Abort("payload-unavailable");
    descriptor = parsed.descriptor;
    if (!isLocalAbsoluteWindowsPath(deps.payloadSource.hostFolder) || !isLocalAbsoluteWindowsPath(deps.payloadSource.extensionFolder)) throw new Abort("payload-unavailable");
  } catch {
    return result(deps, request.action, "refused", "payload-unavailable", [], "skipped", first);
  }

  let reason: CollectorApplyReason | null = null;
  let wrote = false;
  let selfCheck: "ok" | "failed" | "skipped" = "skipped";
  try {
    await guard(context, initialRegistration, { folderExists: false });
    await ensureProgramFolder(context);
    wrote = true;
    await ensureIntegrationDirectory(context);
    await guard(context, initialRegistration, { folderExists: true });
    const slot = await chooseTargetSlot(context, first);
    const previousSlot: CollectorHostSlot = slot === "a" ? "b" : "a";

    await writeSlot(context, slot, descriptor);
    await swapExtension(context, descriptor);

    // Point of no return: the manifest switch makes Chrome use the new Host.
    await guard(context, initialRegistration, { folderExists: true });
    await writeAtomically(context, paths.manifestPath, manifestBytes(slot, paths.programFolder));

    let registryStep: RegistryStep = "ok";
    if (request.action !== "refresh") {
      registryStep = writeRegistration(context, initialRegistration);
      if (registryStep === "ok") readBackRegistration(context);
    } else {
      readBackRegistration(context); // a refresh keeps the same value; it must still be ours
    }
    // Files are complete and verified: record them even when the registry write was denied, so
    // the state is the deterministic `registration-missing` (or still-foreign) with a repair.
    await writeAtomically(context, join(paths.programFolder, COLLECTOR_STATE_FILE_NAME), stateBytes(descriptor, slot, deps.now()));
    if (registryStep !== "ok") {
      reason = registryStep;
    } else {
      await pruneSlot(context, previousSlot);
      if (await standaloneLeftover(context)) warn(context, "standalone-leftover");
      selfCheck = (await runSelfCheck(context, slot, descriptor)) ? "ok" : "failed";
      if (selfCheck === "failed") reason = "self-check-failed";
    }
  } catch (error: unknown) {
    reason = reasonForError(error);
  }
  if (reason === null) return result(deps, request.action, "applied", null, context.warnings, selfCheck);
  const refusedBeforeWrite = !wrote && (reason === "e2e-isolation" || reason === "policy-blocked" || reason === "registration-changed" || reason === "program-folder-unsafe" || reason === "inspection-incomplete");
  return result(deps, request.action, refusedBeforeWrite ? "refused" : "failed", reason, context.warnings, selfCheck);
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

async function remove(
  deps: CollectorIntegrationApplyDependencies,
  first: CollectorIntegrationInspection,
): Promise<CollectorApplyResult> {
  const paths = resolveLayout(deps);
  if (paths === undefined) return result(deps, "remove", "refused", "layout-unresolved", [], "skipped", first);
  const context: Context = { deps, paths, warnings: [] };
  const { fileSystem } = deps;
  const tally = { locked: false, leftover: false };
  try {
    const folder = await fileSystem.stat(paths.programFolder);
    if (folder !== null) {
      if (folder.isReparsePoint || folder.kind !== "directory") return result(deps, "remove", "refused", "program-folder-unsafe", [], "skipped", first);
      requireSafeDirectory(context, paths.programFolder);
    }
    let registration: HostRegistrationOwnership;
    try {
      registration = deps.registry.readCollectorHostRegistration();
    } catch {
      return result(deps, "remove", "refused", "inspection-incomplete", [], "skipped", first);
    }
    if (folder === null && registration !== "ours") return result(deps, "remove", "noop", null, [], "skipped", first);

    // 1. Registry first, value-matched by the native layer. A foreign value is left untouched.
    if (registration === "foreign") {
      warn(context, "foreign-registration-left");
    } else if (registration === "ours") {
      let outcome;
      try {
        outcome = deps.registry.unregisterCollectorHost();
      } catch {
        return result(deps, "remove", "failed", "unregister-failed", context.warnings, "skipped");
      }
      if (outcome === "foreign") warn(context, "foreign-registration-left");
      else if (outcome !== "ok" && outcome !== "not-registered") return result(deps, "remove", "failed", "unregister-failed", context.warnings, "skipped");
    }
  } catch (error: unknown) {
    return result(deps, "remove", error instanceof Abort ? "refused" : "failed", reasonForError(error), [], "skipped");
  }

  // 2. Fixed names inside the program folder only.
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
        const outcome = await removeTreeTolerant(context, join(paths.programFolder, name), tally);
        if (outcome === "leftover") tally.leftover = true;
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
  return result(deps, "remove", tally.leftover ? "partial" : "applied", tally.locked ? "file-locked" : null, context.warnings, "skipped");
}

async function removeTreeTolerant(context: Context, directory: string, tally: { locked: boolean; leftover: boolean }): Promise<"removed" | "missing" | "leftover"> {
  const state = { locked: false };
  try {
    const outcome = await removeTree(context, directory, false, state);
    if (state.locked) tally.locked = true;
    return outcome;
  } catch (error: unknown) {
    if (error instanceof CollectorFileSystemError && error.code === "locked") tally.locked = true;
    return "leftover";
  }
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
