/**
 * In-memory `CollectorRegistryAdapter` for unit tests (WP-5a/5b/7 inject it).
 *
 * It never touches the real registry. `register`/`unregister` follow the addon's rules:
 * the registered value is always `<UserProgramFiles>\MAGINALIA Collector\org.maginalia.collector.json`,
 * `register` refuses to overwrite a foreign value, `unregister` is value-matched.
 * Tests seed foreign values and inject faults through the public fields.
 */
import type {
  ChromeAppPathValue,
  ChromePolicyHiveFacts,
  ChromePolicySnapshot,
  CollectorHostRegistration,
  CollectorRegistryAdapter,
} from "./collector-registry-adapter.js";
import {
  collectorManifestPathFor,
  type KnownFolderId,
  type RegisterOutcome,
  type UnregisterOutcome,
} from "./windows-integration.js";

export const EMPTY_CHROME_POLICIES_FOR_HIVE = (hive: "HKCU" | "HKLM"): ChromePolicyHiveFacts => ({
  hive,
  nativeMessagingUserLevelHosts: null,
  nativeMessagingBlocklist: null,
  nativeMessagingAllowlist: null,
  developerToolsAvailability: null,
  extensionInstallBlocklist: null,
  extensionInstallAllowlist: null,
});

export type FakeAdapterCall =
  | "getKnownFolderPath"
  | "readCollectorHostRegistration"
  | "registerCollectorHost"
  | "unregisterCollectorHost"
  | "replaceForeignCollectorHostRegistration"
  | "readChromePolicies"
  | "readChromeAppPaths"
  | "readDefaultBrowserProgId";

export class FakeCollectorRegistryAdapter implements CollectorRegistryAdapter {
  public knownFolders: Record<KnownFolderId, string> = {
    UserProgramFiles: "C:\\Users\\tester\\AppData\\Local\\Programs",
    LocalAppData: "C:\\Users\\tester\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    ProgramFilesX86: "C:\\Program Files (x86)",
  };
  /**
   * Ownership of the fixed key, exactly the classes the addon produces. The addon treats a key
   * with no default value or an EMPTY default value as `absent`; tests model that by setting
   * `"absent"`. Case folding and path variants are decided natively and are not simulated here.
   */
  public registration: CollectorHostRegistration = "absent";
  public policies: ChromePolicySnapshot = {
    hkcu: EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"),
    hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM"),
  };
  public appPaths: readonly ChromeAppPathValue[] = [];
  public defaultBrowserProgId: string | null = null;
  /** When set, the next call of that kind throws this error (then clears). */
  public failNext: Partial<Record<FakeAdapterCall, Error>> = {};
  /** When set, the next write returns this outcome without changing state (then clears). */
  public nextRegisterOutcome: RegisterOutcome | undefined;
  public nextUnregisterOutcome: UnregisterOutcome | undefined;
  public readonly calls: FakeAdapterCall[] = [];

  public get manifestPath(): string {
    return collectorManifestPathFor(this.knownFolders.UserProgramFiles);
  }

  private enter(call: FakeAdapterCall): void {
    this.calls.push(call);
    const error = this.failNext[call];
    if (error !== undefined) {
      delete this.failNext[call];
      throw error;
    }
  }

  public getKnownFolderPath(id: KnownFolderId): string {
    this.enter("getKnownFolderPath");
    return this.knownFolders[id];
  }

  public readCollectorHostRegistration(): CollectorHostRegistration {
    this.enter("readCollectorHostRegistration");
    return this.registration;
  }

  private write(replaceForeign: boolean): RegisterOutcome {
    const forced = this.nextRegisterOutcome;
    if (forced !== undefined) {
      this.nextRegisterOutcome = undefined;
      return forced;
    }
    if (this.registration === "foreign" && !replaceForeign) return "foreign";
    this.registration = "ours";
    return "ok";
  }

  public registerCollectorHost(): RegisterOutcome {
    this.enter("registerCollectorHost");
    return this.write(false);
  }

  public replaceForeignCollectorHostRegistration(): RegisterOutcome {
    this.enter("replaceForeignCollectorHostRegistration");
    return this.write(true);
  }

  public unregisterCollectorHost(): UnregisterOutcome {
    this.enter("unregisterCollectorHost");
    const forced = this.nextUnregisterOutcome;
    if (forced !== undefined) {
      this.nextUnregisterOutcome = undefined;
      return forced;
    }
    if (this.registration === "absent") return "not-registered";
    if (this.registration === "foreign") return "foreign";
    this.registration = "absent";
    return "ok";
  }

  public readChromePolicies(): ChromePolicySnapshot {
    this.enter("readChromePolicies");
    return this.policies;
  }

  public readChromeAppPaths(): readonly ChromeAppPathValue[] {
    this.enter("readChromeAppPaths");
    return this.appPaths;
  }

  public readDefaultBrowserProgId(): string | null {
    this.enter("readDefaultBrowserProgId");
    return this.defaultBrowserProgId;
  }
}
