/**
 * `CollectorRegistryAdapter`: the only seam through which the Collector integration
 * (WP-5a/5b/7) touches the Windows registry and known folders.
 *
 * Production code uses `createProductCollectorRegistryAdapter()` (no parameters), which
 * is backed by the addon wrapper in `windows-integration.ts`. Tests inject an in-memory
 * fake (`collector-registry-adapter.test-helper.ts`) so no unit or integration test ever
 * writes to the real HKCU. The adapter exposes no generic registry write: the three
 * mutating methods take no arguments and act on the fixed host key only (design 3.3).
 *
 * This module returns raw facts. Interpreting them (policy-blocked, foreign-registration,
 * Chrome candidate validation, ...) belongs to the state machine, not here.
 */
import {
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

export interface CollectorRegistryAdapter {
  /** `SHGetKnownFolderPath` for the fixed folder set; a local-drive absolute path. */
  getKnownFolderPath(id: KnownFolderId): string;
  /** Ownership of `HKCU\Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector`. */
  readCollectorHostRegistration(): CollectorHostRegistration;
  /** No arguments; fixed key and value. Never overwrites a foreign registration. */
  registerCollectorHost(): RegisterOutcome;
  /** No arguments; value-matched delete of the fixed key. */
  unregisterCollectorHost(): UnregisterOutcome;
  /** No arguments; same write as `registerCollectorHost`, after the user confirmed replacing a foreign value. */
  replaceForeignCollectorHostRegistration(): RegisterOutcome;
  /** Chrome policy facts from HKCU and HKLM (design 8.4). Read-only. */
  readChromePolicies(): ChromePolicySnapshot;
  /** `App Paths\chrome.exe` default values: HKCU, then HKLM 64-bit view, then HKLM 32-bit view (design 4.2). */
  readChromeAppPaths(): readonly ChromeAppPathValue[];
  /** `ProgId` of the default `https` handler, or `null` (design 4.2). */
  readDefaultBrowserProgId(): string | null;
}

const CHROME_POLICY_SUBKEY = "SOFTWARE\\Policies\\Google\\Chrome";
const APP_PATHS_CHROME_SUBKEY = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
const HKCU_APP_PATHS_CHROME_SUBKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
const HTTPS_USER_CHOICE_SUBKEY = "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

function readDword(integration: WindowsIntegration, hive: RegistryHive, name: string): number | null {
  const value = integration.readRegistryValue(hive, CHROME_POLICY_SUBKEY, name, "64");
  return value !== null && value.type === "dword" ? value.value : null;
}

/** List policies are stored as values named "1", "2", ... under a subkey named after the policy. */
function readList(integration: WindowsIntegration, hive: RegistryHive, policy: string): readonly string[] | null {
  const subkey = `${CHROME_POLICY_SUBKEY}\\${policy}`;
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

function readHiveFacts(integration: WindowsIntegration, hive: RegistryHive): ChromePolicyHiveFacts {
  return Object.freeze({
    hive,
    nativeMessagingUserLevelHosts: readDword(integration, hive, "NativeMessagingUserLevelHosts"),
    nativeMessagingBlocklist: readList(integration, hive, "NativeMessagingBlocklist"),
    nativeMessagingAllowlist: readList(integration, hive, "NativeMessagingAllowlist"),
    developerToolsAvailability: readDword(integration, hive, "DeveloperToolsAvailability"),
    extensionInstallBlocklist: readList(integration, hive, "ExtensionInstallBlocklist"),
    extensionInstallAllowlist: readList(integration, hive, "ExtensionInstallAllowlist"),
  });
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

    readCollectorHostRegistration: () => integration.inspectCollectorHostRegistration(),

    registerCollectorHost: () => integration.registerCollectorHost(),
    unregisterCollectorHost: () => integration.unregisterCollectorHost(),
    replaceForeignCollectorHostRegistration: () => integration.replaceForeignCollectorHostRegistration(),

    readChromePolicies(): ChromePolicySnapshot {
      return Object.freeze({ hkcu: readHiveFacts(integration, "HKCU"), hklm: readHiveFacts(integration, "HKLM") });
    },

    readChromeAppPaths(): readonly ChromeAppPathValue[] {
      const found: ChromeAppPathValue[] = [];
      const probes: ReadonlyArray<{ source: ChromeAppPathValue["source"]; hive: RegistryHive; subkey: string; view: "64" | "32" }> = [
        { source: "hkcu", hive: "HKCU", subkey: HKCU_APP_PATHS_CHROME_SUBKEY, view: "64" },
        { source: "hklm-64", hive: "HKLM", subkey: APP_PATHS_CHROME_SUBKEY, view: "64" },
        { source: "hklm-32", hive: "HKLM", subkey: APP_PATHS_CHROME_SUBKEY, view: "32" },
      ];
      for (const probe of probes) {
        const value = integration.readRegistryValue(probe.hive, probe.subkey, "", probe.view);
        if (value !== null && (value.type === "sz" || value.type === "expand-sz") && value.value.length > 0) {
          found.push(Object.freeze({ source: probe.source, value: value.value }));
        }
      }
      return Object.freeze(found);
    },

    readDefaultBrowserProgId(): string | null {
      const value = integration.readRegistryValue("HKCU", HTTPS_USER_CHOICE_SUBKEY, "ProgId", "default");
      return value !== null && value.type === "sz" && value.value.length > 0 ? value.value : null;
    },
  });
}
