/**
 * `CollectorRegistryAdapter`: the only seam through which the Collector integration
 * (WP-5a/5b/7) touches the Windows registry and known folders.
 *
 * Production code uses `createProductCollectorRegistryAdapter()` (no parameters), which
 * is backed by the addon wrapper in `windows-integration.ts`. Tests inject an in-memory
 * fake (`collector-registry-adapter.test-helper.ts`) so no unit or integration test ever
 * writes to the real HKCU. The adapter exposes no generic registry write: the three
 * mutating methods take exactly one writable target id (`chrome` | `edge`, validated by the
 * wrapper and again by the addon's compile-time table) and act on that target's fixed host
 * key only (multi-browser design 3.2).
 *
 * This module returns raw facts. Interpreting them (policy-blocked, foreign-registration,
 * Chrome candidate validation, ...) belongs to the state machine, not here.
 */
import type { CollectorRegistryTargetId } from "./collector-browser-table.js";
import {
  WindowsIntegrationError,
  loadWindowsIntegration,
  type HostRegistrationOwnership,
  type KnownFolderId,
  type RegisterOutcome,
  type RegistryHive,
  type UnregisterOutcome,
  type WindowsIntegration,
} from "./windows-integration.js";

/**
 * Ownership of the fixed host key, decided by the addon in ONE place (no JS re-classification):
 * `absent` (no key, no default value, or an empty default value: repairable by `register`),
 * `ours` (default equals our manifest path), `foreign` (anything else).
 */
export type CollectorHostRegistration = HostRegistrationOwnership;

/**
 * Chrome policy facts for one hive (`SOFTWARE\Policies\Google\Chrome`). `null` means the
 * value or list is not present. Lists hold the string entries only, in numeric name order.
 */
export interface ChromePolicyHiveFacts {
  readonly hive: RegistryHive;
  readonly nativeMessagingUserLevelHosts: number | null;
  readonly nativeMessagingBlocklist: readonly string[] | null;
  readonly nativeMessagingAllowlist: readonly string[] | null;
  readonly developerToolsAvailability: number | null;
  readonly extensionInstallBlocklist: readonly string[] | null;
  readonly extensionInstallAllowlist: readonly string[] | null;
}

export interface ChromePolicySnapshot {
  readonly hkcu: ChromePolicyHiveFacts;
  readonly hklm: ChromePolicyHiveFacts;
}

/** A raw `chrome.exe` App Paths default value, before any path validation. */
export interface ChromeAppPathValue {
  readonly source: "hkcu" | "hklm-64" | "hklm-32";
  readonly value: string;
}

/**
 * Policy root below `SOFTWARE\Policies\` for a browser row (design 1.2 `policyRoot`). A fixed
 * enumeration: only these two are ever read, and a caller cannot pass a path.
 */
export const BROWSER_POLICY_ROOTS = ["Google\\Chrome", "Microsoft\\Edge"] as const;
export type BrowserPolicyRoot = (typeof BROWSER_POLICY_ROOTS)[number];
/** Same shape for every policy root. */
export type BrowserPolicySnapshot = ChromePolicySnapshot;
export type BrowserAppPathValue = ChromeAppPathValue;

/** Where a default-browser ProgId was read from (`UserChoiceLatest` wins over `UserChoice`). */
export interface DefaultBrowserProgIdFact {
  readonly progId: string;
  readonly source: "user-choice-latest" | "user-choice";
}

export interface CollectorRegistryAdapter {
  /** `SHGetKnownFolderPath` for the fixed folder set; a local-drive absolute path. */
  getKnownFolderPath(id: KnownFolderId): string;
  /**
   * Ownership of one target's `HKCU\...\NativeMessagingHosts\org.maginalia.collector` key
   * (`chrome`, `edge`, `chromium`; `vivaldi` is not in the addon's table yet and is
   * `invalid-argument`). Decided in the addon, not here.
   */
  readCollectorHostRegistration(target: CollectorRegistryTargetId): CollectorHostRegistration;
  /** One writable target (`chrome` | `edge`); fixed key and value. Never overwrites a foreign registration. */
  registerCollectorHost(target: CollectorRegistryTargetId): RegisterOutcome;
  /** One writable target; value-matched delete of that target's fixed key. */
  unregisterCollectorHost(target: CollectorRegistryTargetId): UnregisterOutcome;
  /** One writable target; same write as `registerCollectorHost`, after the user confirmed replacing a foreign value. */
  replaceForeignCollectorHostRegistration(target: CollectorRegistryTargetId): RegisterOutcome;
  /** Policy facts for one policy root from HKCU and HKLM (design 8.4). Read-only. `root` is one of `BROWSER_POLICY_ROOTS`. */
  readBrowserPolicies(root: BrowserPolicyRoot): BrowserPolicySnapshot;
  /**
   * `App Paths\<appPathsName>` default values: HKCU, then HKLM 64-bit view, then HKLM 32-bit view
   * (design 1.5). `appPathsName` is a bare `*.exe` file name (no separators). Read-only.
   */
  readBrowserAppPaths(appPathsName: string): readonly BrowserAppPathValue[];
  /**
   * `ProgId` of the default `https` handler and which key it came from: the `ProgId` subkey of
   * `UserChoiceLatest` first, then `UserChoice` (design 2.1), or `null`.
   */
  readDefaultBrowserProgId(): DefaultBrowserProgIdFact | null;
  /**
   * The raw `shell\open\command` default value of a ProgId (HKCU `Software\Classes` first, then
   * HKLM), never expanded and never executed; only used to pick between installed candidates
   * (design 11.1). A ProgId with characters outside `[A-Za-z0-9._-]` yields `null`.
   */
  readProgIdOpenCommand(progId: string): string | null;
  /** @deprecated Use `readBrowserPolicies("Google\\Chrome")`; kept for WP-5a until S3. */
  readChromePolicies(): ChromePolicySnapshot;
  /** @deprecated Use `readBrowserAppPaths("chrome.exe")`; kept for WP-5a until S3. */
  readChromeAppPaths(): readonly ChromeAppPathValue[];
}

const POLICY_SUBKEY_PREFIX = "SOFTWARE\\Policies\\";
const APP_PATHS_HKLM_PREFIX = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\";
const APP_PATHS_HKCU_PREFIX = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\";
const HTTPS_ASSOCIATION_SUBKEY = "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\";
/** `UserChoiceLatest` holds a `ProgId` SUBKEY (with a `ProgId` value); `UserChoice` holds the value directly. */
const USER_CHOICE_LATEST_PROGID_SUBKEY = `${HTTPS_ASSOCIATION_SUBKEY}UserChoiceLatest\\ProgId`;
const USER_CHOICE_SUBKEY = `${HTTPS_ASSOCIATION_SUBKEY}UserChoice`;
/** Shared with the test fake so both validate input identically. */
export const APP_PATHS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.exe$/u;
export const PROG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

function adapterArgumentError(message: string): never {
  throw new WindowsIntegrationError("windows-integration-invalid-argument", message);
}

function readDword(integration: WindowsIntegration, hive: RegistryHive, policySubkey: string, name: string): number | null {
  const value = integration.readRegistryValue(hive, policySubkey, name, "64");
  return value !== null && value.type === "dword" ? value.value : null;
}

/** List policies are stored as values named "1", "2", ... under a subkey named after the policy. */
function readList(integration: WindowsIntegration, hive: RegistryHive, policySubkey: string, policy: string): readonly string[] | null {
  const subkey = `${policySubkey}\\${policy}`;
  const names = integration.readRegistryValueNames(hive, subkey, "64");
  if (names === null) return null;
  const ordered = [...names].sort((left, right) => {
    const a = Number(left);
    const b = Number(right);
    return Number.isNaN(a) || Number.isNaN(b) ? left.localeCompare(right) : a - b;
  });
  const entries: string[] = [];
  for (const name of ordered) {
    const value = integration.readRegistryValue(hive, subkey, name, "64");
    if (value !== null && (value.type === "sz" || value.type === "expand-sz")) entries.push(value.value);
  }
  return Object.freeze(entries);
}

function readHiveFacts(integration: WindowsIntegration, hive: RegistryHive, root: BrowserPolicyRoot): ChromePolicyHiveFacts {
  const subkey = `${POLICY_SUBKEY_PREFIX}${root}`;
  return Object.freeze({
    hive,
    nativeMessagingUserLevelHosts: readDword(integration, hive, subkey, "NativeMessagingUserLevelHosts"),
    nativeMessagingBlocklist: readList(integration, hive, subkey, "NativeMessagingBlocklist"),
    nativeMessagingAllowlist: readList(integration, hive, subkey, "NativeMessagingAllowlist"),
    developerToolsAvailability: readDword(integration, hive, subkey, "DeveloperToolsAvailability"),
    extensionInstallBlocklist: readList(integration, hive, subkey, "ExtensionInstallBlocklist"),
    extensionInstallAllowlist: readList(integration, hive, subkey, "ExtensionInstallAllowlist"),
  });
}

function readPolicies(integration: WindowsIntegration, root: unknown): BrowserPolicySnapshot {
  if (typeof root !== "string" || !(BROWSER_POLICY_ROOTS as readonly string[]).includes(root)) {
    adapterArgumentError("Invalid browser policy root.");
  }
  const checked = root as BrowserPolicyRoot;
  return Object.freeze({ hkcu: readHiveFacts(integration, "HKCU", checked), hklm: readHiveFacts(integration, "HKLM", checked) });
}

function readAppPaths(integration: WindowsIntegration, name: unknown): readonly BrowserAppPathValue[] {
  if (typeof name !== "string" || !APP_PATHS_NAME_PATTERN.test(name)) adapterArgumentError("Invalid App Paths name.");
  const checked = name as string;
  const found: BrowserAppPathValue[] = [];
  const probes: ReadonlyArray<{ source: BrowserAppPathValue["source"]; hive: RegistryHive; subkey: string; view: "64" | "32" }> = [
    { source: "hkcu", hive: "HKCU", subkey: `${APP_PATHS_HKCU_PREFIX}${checked}`, view: "64" },
    { source: "hklm-64", hive: "HKLM", subkey: `${APP_PATHS_HKLM_PREFIX}${checked}`, view: "64" },
    { source: "hklm-32", hive: "HKLM", subkey: `${APP_PATHS_HKLM_PREFIX}${checked}`, view: "32" },
  ];
  for (const probe of probes) {
    const value = integration.readRegistryValue(probe.hive, probe.subkey, "", probe.view);
    if (value !== null && (value.type === "sz" || value.type === "expand-sz") && value.value.length > 0) {
      found.push(Object.freeze({ source: probe.source, value: value.value }));
    }
  }
  return Object.freeze(found);
}

function readHttpsProgId(integration: WindowsIntegration): DefaultBrowserProgIdFact | null {
  // Measured on Windows 11: `UserChoiceLatest` has a `Hash` value and a `ProgId` SUBKEY whose `ProgId`
  // value is the answer; it is read first. Then the older `UserChoice` `ProgId` value (design 2.1).
  const probes: ReadonlyArray<{ source: DefaultBrowserProgIdFact["source"]; subkey: string }> = [
    { source: "user-choice-latest", subkey: USER_CHOICE_LATEST_PROGID_SUBKEY },
    { source: "user-choice", subkey: USER_CHOICE_SUBKEY },
  ];
  for (const probe of probes) {
    const value = integration.readRegistryValue("HKCU", probe.subkey, "ProgId", "default");
    if (value !== null && value.type === "sz" && value.value.length > 0) return Object.freeze({ progId: value.value, source: probe.source });
  }
  return null;
}

function readOpenCommand(integration: WindowsIntegration, progId: unknown): string | null {
  // The ProgId comes from the registry (untrusted): anything that is not a plain name is "no command".
  if (typeof progId !== "string" || !PROG_ID_PATTERN.test(progId)) return null;
  const probes: ReadonlyArray<{ hive: RegistryHive; subkey: string }> = [
    { hive: "HKCU", subkey: `Software\\Classes\\${progId}\\shell\\open\\command` },
    { hive: "HKLM", subkey: `SOFTWARE\\Classes\\${progId}\\shell\\open\\command` },
  ];
  for (const probe of probes) {
    const value = integration.readRegistryValue(probe.hive, probe.subkey, "", "64");
    if (value !== null && (value.type === "sz" || value.type === "expand-sz") && value.value.length > 0) return value.value;
  }
  return null;
}

/** Production adapter over the native addon. Takes no parameters: nothing can redirect it. */
export function createProductCollectorRegistryAdapter(): CollectorRegistryAdapter {
  return createCollectorRegistryAdapterOver(loadWindowsIntegration());
}

/**
 * Build the adapter over an already-wrapped integration. Exported for the wrapper's own
 * tests (a fake native module); product code uses `createProductCollectorRegistryAdapter`.
 */
export function createCollectorRegistryAdapterOver(integration: WindowsIntegration): CollectorRegistryAdapter {
  return Object.freeze({
    getKnownFolderPath: (id: KnownFolderId) => integration.getKnownFolderPath(id),

    // Target validation (enumeration, writable subset) is done by the wrapper, once.
    readCollectorHostRegistration: (target: CollectorRegistryTargetId) => integration.inspectCollectorHostRegistration(target),

    registerCollectorHost: (target: CollectorRegistryTargetId) => integration.registerCollectorHost(target),
    unregisterCollectorHost: (target: CollectorRegistryTargetId) => integration.unregisterCollectorHost(target),
    replaceForeignCollectorHostRegistration: (target: CollectorRegistryTargetId) =>
      integration.replaceForeignCollectorHostRegistration(target),

    readBrowserPolicies: (root: BrowserPolicyRoot): BrowserPolicySnapshot => readPolicies(integration, root),
    readBrowserAppPaths: (appPathsName: string): readonly BrowserAppPathValue[] => readAppPaths(integration, appPathsName),
    readDefaultBrowserProgId: (): DefaultBrowserProgIdFact | null => readHttpsProgId(integration),
    readProgIdOpenCommand: (progId: string): string | null => readOpenCommand(integration, progId),

    readChromePolicies: (): ChromePolicySnapshot => readPolicies(integration, "Google\\Chrome"),
    readChromeAppPaths: (): readonly ChromeAppPathValue[] => readAppPaths(integration, "chrome.exe"),
  });
}
