/**
 * Test-only E2E isolation gate (Desktop issue #93).
 *
 * A Desktop E2E run (Collector-only or first-run scenario) must keep every
 * Desktop-controlled destination — Electron userData, Downloads, the default
 * Documents-based Workdesk/Private Shelf location, and any explicitly supplied
 * Workdesk/Shelf/Downloads smoke path — inside one disposable, test-owned root.
 * If any of them resolves outside that root, the process must stop before
 * Electron app initialization and before any write.
 *
 * Activation and why it is safe in product runs:
 *
 * - The gate is inert unless `MAGINALIA_E2E_ISOLATION_ROOT` is present in the
 *   process environment. Normal launches (Start menu, shortcut, file
 *   association) never set it, and without it this module reads nothing and
 *   changes nothing.
 * - The gate never chooses Electron's userData. userData still comes only from
 *   Electron's own `--user-data-dir` switch (or Electron's default). The gate
 *   only checks the value Electron already selected and stops the process when
 *   it is not inside the root. It can therefore only refuse a launch, never
 *   relocate an existing profile.
 * - The only paths it redirects are Electron's `downloads` and `documents`
 *   path keys, and only into `<root>/Downloads` and `<root>/Documents`, after
 *   the root itself was validated: an absolute local directory that is not a
 *   drive root, contains neither the user's home directory nor any protected
 *   location, has no symbolic link or junction in any path component, and
 *   carries the harness-created marker file `maginalia-e2e-isolation-root.json`.
 *   An accidental or hostile variable therefore either fails closed (exit 78)
 *   or confines first-run copies inside a test-owned directory; it cannot widen
 *   data access.
 * - It does not redirect the native per-user coordination/binding root
 *   (`SHGetKnownFolderPath(FOLDERID_LocalAppData)`), which is intentionally not
 *   configurable. The E2E harness audits that location instead.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";

export const E2E_ISOLATION_ROOT_ENV = "MAGINALIA_E2E_ISOLATION_ROOT";
export const E2E_ISOLATION_MARKER_FILE = "maginalia-e2e-isolation-root.json";
export const E2E_ISOLATION_MARKER_KIND = "maginalia-e2e-isolation-root";
export const E2E_ISOLATION_EVIDENCE_DIRECTORY = "evidence";
/** EX_CONFIG: the run was refused before any Desktop side effect. */
export const E2E_ISOLATION_EXIT_CODE = 78;

/** Smoke environment variables whose paths must also stay inside the root. */
export const E2E_ISOLATION_GUARDED_ENV = Object.freeze([
  "MAGINALIA_FIRST_RUN_SMOKE_WORKDESK",
  "MAGINALIA_FIRST_RUN_SMOKE_SHELF",
  "MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS",
  "MAGINALIA_FIRST_RUN_SMOKE_OUTPUT",
] as const);

export type E2EIsolationErrorCode =
  | "root-missing"
  | "root-not-absolute"
  | "root-unsupported-form"
  | "root-not-directory"
  | "root-reparse-point"
  | "root-too-broad"
  | "root-marker-invalid"
  | "destination-not-absolute"
  | "destination-unsupported-form"
  | "destination-outside-root"
  | "destination-reparse-point"
  | "destination-missing";

export class E2EIsolationError extends Error {
  constructor(readonly code: E2EIsolationErrorCode, message: string) {
    super(message);
    this.name = "E2EIsolationError";
  }
}

type Platform = NodeJS.Platform;

interface PathModule {
  readonly sep: string;
  isAbsolute(value: string): boolean;
  resolve(...values: string[]): string;
  normalize(value: string): string;
  relative(from: string, to: string): string;
  parse(value: string): path.ParsedPath;
  join(...values: string[]): string;
  dirname(value: string): string;
}

function pathModule(platform: Platform): PathModule {
  return platform === "win32" ? path.win32 : path.posix;
}

function trimTrailingSeparators(value: string, platform: Platform): string {
  const p = pathModule(platform);
  const root = p.parse(value).root;
  let result = value;
  while (result.length > root.length && (result.endsWith("\\") || result.endsWith("/"))) result = result.slice(0, -1);
  return result;
}

/** Comparable form of an absolute path: normalized, no trailing separator, case-folded on Windows. */
export function comparablePath(value: string, platform: Platform = process.platform): string {
  const p = pathModule(platform);
  const normalized = trimTrailingSeparators(p.normalize(value), platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when `candidate` is strictly below `root` (the root itself does not count). */
export function isStrictlyInside(root: string, candidate: string, platform: Platform = process.platform): boolean {
  const p = pathModule(platform);
  const relative = p.relative(comparablePath(root, platform), comparablePath(candidate, platform));
  if (relative === "" || p.isAbsolute(relative)) return false;
  const first = relative.split(/[\\/]/u)[0];
  return first !== "..";
}

/** True when `candidate` is `root` or below it. */
export function isSameOrInside(root: string, candidate: string, platform: Platform = process.platform): boolean {
  return comparablePath(root, platform) === comparablePath(candidate, platform) || isStrictlyInside(root, candidate, platform);
}

/**
 * Reject path spellings whose meaning is not an ordinary local absolute path:
 * relative paths, `..` segments, Win32 device / long-path namespaces, UNC
 * shares and drive-relative paths such as `C:foo`.
 */
function assertOrdinaryAbsolutePath(
  value: unknown,
  platform: Platform,
  notAbsolute: E2EIsolationErrorCode,
  unsupported: E2EIsolationErrorCode,
  label: string,
): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || value.includes("\0")) {
    throw new E2EIsolationError(notAbsolute, `${label} is not a non-empty absolute path.`);
  }
  const p = pathModule(platform);
  if (!p.isAbsolute(value)) throw new E2EIsolationError(notAbsolute, `${label} must be absolute.`);
  if (platform === "win32") {
    if (/^[\\/]{2}/u.test(value)) {
      throw new E2EIsolationError(unsupported, `${label} must be a local drive path, not a UNC or device path.`);
    }
    if (!/^[A-Za-z]:[\\/]/u.test(value)) {
      throw new E2EIsolationError(notAbsolute, `${label} must start with a drive letter and separator.`);
    }
  }
  if (value.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new E2EIsolationError(unsupported, `${label} must not contain parent-directory segments.`);
  }
  return trimTrailingSeparators(p.normalize(value), platform);
}

export interface E2EIsolationFileSystem {
  lstat(value: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean } | undefined;
  realpath(value: string): string;
  readText(value: string): string;
}

export const nodeIsolationFileSystem: E2EIsolationFileSystem = Object.freeze({
  lstat(value: string) {
    try {
      return lstatSync(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
      throw error;
    }
  },
  realpath(value: string) {
    return realpathSync.native(value);
  },
  readText(value: string) {
    return readFileSync(value, "utf8");
  },
});

/** Every ancestor of an absolute path, from the filesystem root down to the path itself. */
function componentsOf(value: string, platform: Platform): string[] {
  const p = pathModule(platform);
  const chain: string[] = [];
  let current = value;
  for (;;) {
    chain.push(current);
    const parent = p.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * Node reports both symbolic links and NTFS junctions (mount points) as
 * symbolic links from `lstat`. Other reparse tags (for example cloud-file
 * placeholders) are reported as ordinary entries; they are still caught by the
 * canonical-path containment check because `realpath` resolves them.
 */
function assertNoLinkComponents(
  value: string,
  platform: Platform,
  fs: E2EIsolationFileSystem,
  code: E2EIsolationErrorCode,
  label: string,
): void {
  for (const component of componentsOf(value, platform)) {
    const info = fs.lstat(component);
    if (info === undefined) return;
    if (info.isSymbolicLink()) {
      throw new E2EIsolationError(code, `${label} passes through a symbolic link or junction.`);
    }
  }
}

/**
 * Canonical spelling of an absolute path whose tail may not exist yet: the
 * nearest existing ancestor is resolved with `realpath` (expanding 8.3 short
 * names, case and any redirection), then the missing tail is appended.
 */
function canonicalize(value: string, platform: Platform, fs: E2EIsolationFileSystem): { canonical: string; exists: boolean } {
  const p = pathModule(platform);
  const missing: string[] = [];
  let current = value;
  for (;;) {
    if (fs.lstat(current) !== undefined) {
      const resolved = fs.realpath(current);
      return { canonical: missing.length === 0 ? resolved : p.join(resolved, ...missing.reverse()), exists: missing.length === 0 };
    }
    const parent = p.dirname(current);
    if (parent === current) return { canonical: value, exists: false };
    missing.push(p.parse(current).base);
    current = parent;
  }
}

export interface ValidateIsolationRootOptions {
  readonly platform?: Platform;
  readonly fs?: E2EIsolationFileSystem;
  /** Locations the root must neither equal nor contain (home, real profile folders). */
  readonly protectedPaths?: readonly string[];
}

export interface ValidatedIsolationRoot {
  /** Canonical (realpath) spelling used for every containment comparison. */
  readonly root: string;
  /** The spelling supplied by the harness, normalized. */
  readonly requested: string;
}

export function validateIsolationRoot(input: unknown, options: ValidateIsolationRootOptions = {}): ValidatedIsolationRoot {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeIsolationFileSystem;
  if (input === undefined || input === null || input === "") {
    throw new E2EIsolationError("root-missing", "The E2E isolation root is not set.");
  }
  const requested = assertOrdinaryAbsolutePath(input, platform, "root-not-absolute", "root-unsupported-form", "The E2E isolation root");
  const p = pathModule(platform);
  if (p.parse(requested).root.length >= requested.length) {
    throw new E2EIsolationError("root-too-broad", "The E2E isolation root must not be a filesystem root.");
  }
  const info = fs.lstat(requested);
  if (info === undefined) throw new E2EIsolationError("root-missing", "The E2E isolation root does not exist.");
  if (info.isSymbolicLink()) throw new E2EIsolationError("root-reparse-point", "The E2E isolation root is a symbolic link or junction.");
  if (!info.isDirectory()) throw new E2EIsolationError("root-not-directory", "The E2E isolation root is not a directory.");
  assertNoLinkComponents(requested, platform, fs, "root-reparse-point", "The E2E isolation root");
  const root = trimTrailingSeparators(fs.realpath(requested), platform);
  if (p.parse(root).root.length >= root.length) {
    throw new E2EIsolationError("root-too-broad", "The E2E isolation root must not be a filesystem root.");
  }
  for (const protectedPath of options.protectedPaths ?? []) {
    if (typeof protectedPath !== "string" || !p.isAbsolute(protectedPath)) continue;
    const canonicalProtected = canonicalize(protectedPath, platform, fs).canonical;
    if (isSameOrInside(root, canonicalProtected, platform) || isSameOrInside(root, protectedPath, platform)) {
      throw new E2EIsolationError("root-too-broad", "The E2E isolation root contains a protected user location.");
    }
  }
  const markerPath = p.join(root, E2E_ISOLATION_MARKER_FILE);
  const marker = fs.lstat(markerPath);
  if (marker === undefined || marker.isSymbolicLink() || !marker.isFile()) {
    throw new E2EIsolationError("root-marker-invalid", "The E2E isolation root has no harness marker file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readText(markerPath));
  } catch {
    throw new E2EIsolationError("root-marker-invalid", "The E2E isolation root marker is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null
    || (parsed as Record<string, unknown>).kind !== E2E_ISOLATION_MARKER_KIND
    || (parsed as Record<string, unknown>).version !== 1) {
    throw new E2EIsolationError("root-marker-invalid", "The E2E isolation root marker has an unexpected kind or version.");
  }
  return Object.freeze({ root, requested });
}

export interface AssertDestinationOptions {
  readonly platform?: Platform;
  readonly fs?: E2EIsolationFileSystem;
  /** Require the destination to exist already (the gate never creates directories). */
  readonly mustExist?: boolean;
}

/**
 * Verify that `candidate` names a location strictly inside the validated root,
 * in both its supplied and its canonical spelling, with no link or junction in
 * any existing component. Returns the canonical spelling.
 */
export function assertDestinationInsideRoot(
  isolation: ValidatedIsolationRoot,
  label: string,
  candidate: unknown,
  options: AssertDestinationOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeIsolationFileSystem;
  const normalized = assertOrdinaryAbsolutePath(candidate, platform, "destination-not-absolute", "destination-unsupported-form", label);
  assertNoLinkComponents(normalized, platform, fs, "destination-reparse-point", label);
  const { canonical, exists } = canonicalize(normalized, platform, fs);
  assertNoLinkComponents(canonical, platform, fs, "destination-reparse-point", label);
  const suppliedInside = isStrictlyInside(isolation.root, normalized, platform) || isStrictlyInside(isolation.requested, normalized, platform);
  if (!suppliedInside || !isStrictlyInside(isolation.root, canonical, platform)) {
    throw new E2EIsolationError("destination-outside-root", `${label} resolves outside the E2E isolation root.`);
  }
  if (options.mustExist === true && !exists) {
    throw new E2EIsolationError("destination-missing", `${label} must be created by the harness before launch.`);
  }
  return canonical;
}

export interface E2EIsolationApp {
  getPath(name: "userData" | "downloads" | "documents" | "home" | "appData"): string;
  setPath(name: "downloads" | "documents", value: string): void;
}

export interface E2EIsolationState {
  readonly root: string;
  readonly userData: string;
  readonly downloads: string;
  readonly documents: string;
  readonly guardedEnvironment: Readonly<Record<string, string>>;
}

export interface EnforceE2EIsolationOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: Platform;
  readonly fs?: E2EIsolationFileSystem;
  readonly writeEvidence?: (file: string, text: string) => void;
  readonly log?: (line: string) => void;
}

/**
 * Validate every Desktop-controlled destination against the isolation root.
 * Returns `undefined` (and touches nothing) when the gate is not requested.
 * Throws `E2EIsolationError` on any mismatch; callers must stop the process.
 */
export function establishE2EIsolation(app: E2EIsolationApp, options: EnforceE2EIsolationOptions = {}): E2EIsolationState | undefined {
  const env = options.env ?? process.env;
  if (!Object.prototype.hasOwnProperty.call(env, E2E_ISOLATION_ROOT_ENV)) return undefined;
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeIsolationFileSystem;
  const p = pathModule(platform);
  const protectedPaths = [os.homedir(), safeGetPath(app, "home"), safeGetPath(app, "appData")]
    .filter((value): value is string => typeof value === "string" && value !== "");
  const isolation = validateIsolationRoot(env[E2E_ISOLATION_ROOT_ENV], { platform, fs, protectedPaths });
  const destination = (label: string, value: unknown, mustExist = false) =>
    assertDestinationInsideRoot(isolation, label, value, { platform, fs, mustExist });

  // userData is chosen by Electron (the --user-data-dir switch). Check it
  // before establishApplicationIdentity() creates the directory.
  const userData = destination("Electron userData", app.getPath("userData"));
  const downloads = destination("Downloads", p.join(isolation.root, "Downloads"), true);
  const documents = destination("Documents", p.join(isolation.root, "Documents"), true);
  const evidenceDirectory = destination("Evidence directory", p.join(isolation.root, E2E_ISOLATION_EVIDENCE_DIRECTORY), true);
  const guardedEnvironment: Record<string, string> = {};
  for (const name of E2E_ISOLATION_GUARDED_ENV) {
    const value = env[name];
    if (value === undefined) continue;
    guardedEnvironment[name] = destination(name, value);
  }

  app.setPath("downloads", downloads);
  app.setPath("documents", documents);
  // Re-read what Electron will actually hand to first-run and default
  // Workdesk/Shelf resolution; never trust the value we tried to set.
  const effectiveDownloads = destination("Electron downloads path", app.getPath("downloads"));
  const effectiveDocuments = destination("Electron documents path", app.getPath("documents"));
  if (comparablePath(effectiveDownloads, platform) !== comparablePath(downloads, platform)
    || comparablePath(effectiveDocuments, platform) !== comparablePath(documents, platform)) {
    throw new E2EIsolationError("destination-outside-root", "Electron did not accept the isolated Downloads/Documents paths.");
  }

  const state: E2EIsolationState = Object.freeze({
    root: isolation.root,
    userData,
    downloads: effectiveDownloads,
    documents: effectiveDocuments,
    guardedEnvironment: Object.freeze(guardedEnvironment),
  });
  const text = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, verifiedAt: new Date().toISOString(), ...state }, null, 2)}\n`;
  (options.writeEvidence ?? ((file, contents) => writeFileSync(file, contents, { encoding: "utf8", flag: "wx" })))(
    p.join(evidenceDirectory, `startup-isolation-${process.pid}.json`),
    text,
  );
  (options.log ?? ((line) => process.stdout.write(`${line}\n`)))(`MAGINALIA_E2E_ISOLATION_OK root=${JSON.stringify(state.root)} userData=${JSON.stringify(state.userData)}`);
  return state;
}

function safeGetPath(app: E2EIsolationApp, name: "home" | "appData"): string | undefined {
  try {
    return app.getPath(name);
  } catch {
    return undefined;
  }
}

/**
 * Main-process startup hook. Call before `establishApplicationIdentity()` and
 * before any store is constructed. On failure the process exits with code 78
 * synchronously; nothing after the call runs.
 */
export function enforceE2EIsolationBeforeStartup(
  app: E2EIsolationApp,
  exit: (code: number) => never = (code) => process.exit(code),
): E2EIsolationState | undefined {
  try {
    return establishE2EIsolation(app);
  } catch (error) {
    const code = error instanceof E2EIsolationError ? error.code : "unexpected";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`MAGINALIA_E2E_ISOLATION_FAILED code=${code} ${message}\n`);
    return exit(E2E_ISOLATION_EXIT_CODE);
  }
}
