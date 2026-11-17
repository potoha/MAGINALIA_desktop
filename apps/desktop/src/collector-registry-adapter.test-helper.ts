/**
 * In-memory `CollectorRegistryAdapter` for unit tests (WP-5a/5b/7 inject it).
 *
 * It never touches the real registry. `register`/`unregister` follow the addon's rules:
 * the registered value is always `<UserProgramFiles>\MAGINALIA Collector\org.maginalia.collector.json`,
 * `register` refuses to overwrite a foreign value, `unregister` is value-matched.
 * Tests seed foreign values and inject faults through the public fields.
 *
 * Multi-browser S2: ownership is kept per target (`registrations`). The registry methods take a
 * target id; for compatibility with the pre-S2 tests the argument defaults to `chrome`, and
 * `registration` is a shorthand for `registrations.chrome`. Like the real wrapper, the writers
 * reject a target that is not writable (`chromium`, `vivaldi`) and the reader rejects a target
 * the addon's table does not contain (`vivaldi`) with `windows-integration-invalid-argument`.
 */
import type {
  BrowserAppPathValue,
  BrowserPolicyRoot,
  BrowserPolicySnapshot,
  ChromeAppPathValue,
  ChromePolicyHiveFacts,
  ChromePolicySnapshot,
  CollectorHostRegistration,
  CollectorRegistryAdapter,
} from "./collector-registry-adapter.js";
import type { CollectorRegistryTargetId } from "./collector-browser-table.js";
import {
  WindowsIntegrationError,
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
  | "readDefaultBrowserProgId"
  | "readBrowserPolicies"
  | "readBrowserAppPaths"
  | "readProgIdOpenCommand";

/** The targets the real addon's compile-time table contains / allows to be written (S2). */
const FAKE_INSPECTABLE_TARGETS: readonly CollectorRegistryTargetId[] = ["chrome", "edge", "chromium"];
const FAKE_WRITABLE_TARGETS: readonly CollectorRegistryTargetId[] = ["chrome", "edge"];

export class FakeCollectorRegistryAdapter implements CollectorRegistryAdapter {
  public knownFolders: Record<KnownFolderId, string> = {
    UserProgramFiles: "C:\\Users\\tester\\AppData\\Local\\Programs",
    LocalAppData: "C:\\Users\\tester\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    ProgramFilesX86: "C:\\Program Files (x86)",
  };
  /**
   * Ownership per target key, exactly the classes the addon produces. The addon treats a key
   * with no default value or an EMPTY default value as `absent`; tests model that by setting
   * `"absent"`. Case folding and path variants are decided natively and are not simulated here.
   */
  public registrations: Record<CollectorRegistryTargetId, CollectorHostRegistration> = {
    chrome: "absent",
    edge: "absent",
    chromium: "absent",
    vivaldi: "absent",
  };
  /** Shorthand for `registrations.chrome` (the only target the pre-S2 tests use). */
  public get registration(): CollectorHostRegistration {
    return this.registrations.chrome;
  }
  public set registration(value: CollectorHostRegistration) {
    this.registrations.chrome = value;
  }
  public policies: ChromePolicySnapshot = {
    hkcu: EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"),
    hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM"),
  };
  /** Policy facts for the Edge root (`Microsoft\Edge`). */
  public edgePolicies: ChromePolicySnapshot = {
    hkcu: EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"),
    hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM"),
  };
  /** `chrome.exe` App Paths (kept for the pre-S2 tests). Other names: `appPathsByName`. */
  public appPaths: readonly ChromeAppPathValue[] = [];
  public appPathsByName: Record<string, readonly BrowserAppPathValue[]> = {};
  public defaultBrowserProgId: string | null = null;
  /** `shell\open\command` default value per ProgId. */
  public progIdOpenCommands: Record<string, string> = {};
  /** When set, the next call of that kind throws this error (then clears). */
  public failNext: Partial<Record<FakeAdapterCall, Error>> = {};
  /** When set, the next write returns this outcome without changing state (then clears). */
  public nextRegisterOutcome: RegisterOutcome | undefined;
  public nextUnregisterOutcome: UnregisterOutcome | undefined;
  public readonly calls: FakeAdapterCall[] = [];
  /** Every registry call that takes a target, in order (for S3/S4 tests). */
  public readonly targetCalls: Array<{ readonly call: FakeAdapterCall; readonly target: CollectorRegistryTargetId }> = [];

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

  private checkTarget(call: FakeAdapterCall, target: CollectorRegistryTargetId, allowed: readonly CollectorRegistryTargetId[]): void {
    this.targetCalls.push({ call, target });
    if (!allowed.includes(target)) {
      throw new WindowsIntegrationError("windows-integration-invalid-argument", `${call} rejected the target.`);
    }
  }

  public getKnownFolderPath(id: KnownFolderId): string {
    this.enter("getKnownFolderPath");
    return this.knownFolders[id];
  }

  public readCollectorHostRegistration(target: CollectorRegistryTargetId = "chrome"): CollectorHostRegistration {
    this.enter("readCollectorHostRegistration");
    this.checkTarget("readCollectorHostRegistration", target, FAKE_INSPECTABLE_TARGETS);
    return this.registrations[target];
  }

  private write(target: CollectorRegistryTargetId, replaceForeign: boolean): RegisterOutcome {
    const forced = this.nextRegisterOutcome;
    if (forced !== undefined) {
      this.nextRegisterOutcome = undefined;
      return forced;
    }
    if (this.registrations[target] === "foreign" && !replaceForeign) return "foreign";
    this.registrations[target] = "ours";
    return "ok";
  }

  public registerCollectorHost(target: CollectorRegistryTargetId = "chrome"): RegisterOutcome {
    this.enter("registerCollectorHost");
    this.checkTarget("registerCollectorHost", target, FAKE_WRITABLE_TARGETS);
    return this.write(target, false);
  }

  public replaceForeignCollectorHostRegistration(target: CollectorRegistryTargetId = "chrome"): RegisterOutcome {
    this.enter("replaceForeignCollectorHostRegistration");
    this.checkTarget("replaceForeignCollectorHostRegistration", target, FAKE_WRITABLE_TARGETS);
    return this.write(target, true);
  }

  public unregisterCollectorHost(target: CollectorRegistryTargetId = "chrome"): UnregisterOutcome {
    this.enter("unregisterCollectorHost");
    this.checkTarget("unregisterCollectorHost", target, FAKE_WRITABLE_TARGETS);
    const forced = this.nextUnregisterOutcome;
    if (forced !== undefined) {
      this.nextUnregisterOutcome = undefined;
      return forced;
    }
    const current = this.registrations[target];
    if (current === "absent") return "not-registered";
    if (current === "foreign") return "foreign";
    this.registrations[target] = "absent";
    return "ok";
  }

  public readBrowserPolicies(root: BrowserPolicyRoot): BrowserPolicySnapshot {
    this.enter("readBrowserPolicies");
    return root === "Microsoft\\Edge" ? this.edgePolicies : this.policies;
  }

  public readBrowserAppPaths(appPathsName: string): readonly BrowserAppPathValue[] {
    this.enter("readBrowserAppPaths");
    if (appPathsName === "chrome.exe" && this.appPathsByName[appPathsName] === undefined) return this.appPaths;
    return this.appPathsByName[appPathsName] ?? [];
  }

  public readProgIdOpenCommand(progId: string): string | null {
    this.enter("readProgIdOpenCommand");
    return this.progIdOpenCommands[progId] ?? null;
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
