import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyDefaultBrowser,
  evaluateChromePolicies,
  expectedHostManifest,
  inspectCollectorIntegration,
  isLocalAbsoluteWindowsPath,
  locateChromeExecutable,
  parseCollectorContactRecord,
  parseIntegrationStateFile,
} from "./collector-integration";
import { createNodeCollectorIntegrationFileSystem } from "./collector-integration-fs";
import { COLLECTOR_INTEGRATION_STATES, type CollectorIntegrationInspection, type CollectorIntegrationState } from "./collector-integration-types";
import { COLLECTOR_PROTOCOL } from "./collector-payload";
import { EMPTY_CHROME_POLICIES_FOR_HIVE } from "./collector-registry-adapter.test-helper";
import {
  EXTENSION_FILES,
  FIXTURE_NOW,
  HOST_ADDON_BYTES,
  HOST_EXE_BYTES,
  contactText,
  createIntegrationFixture,
  expectedManifestText,
  payloadDescriptorFixture,
  securityKey,
  stateFileText,
  type IntegrationFixture,
} from "./collector-integration.test-helper";
import { safeFacts } from "./collector-host-fixture.test-helper";
import type { ChromePolicySnapshot } from "./collector-registry-adapter";
import type { ChromePolicyHiveFacts } from "./collector-registry-adapter";

const here = path.dirname(fileURLToPath(import.meta.url));

async function inspect(fixture: IntegrationFixture, options?: { verifyFileHashes?: boolean }): Promise<CollectorIntegrationInspection> {
  return inspectCollectorIntegration(fixture.dependencies, options);
}

function p(fixture: IntegrationFixture, ...parts: string[]): string {
  return path.win32.join(fixture.programFolder, ...parts);
}

function policies(hkcu: Partial<ChromePolicyHiveFacts> = {}, hklm: Partial<ChromePolicyHiveFacts> = {}): ChromePolicySnapshot {
  return { hkcu: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"), ...hkcu }, hklm: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM"), ...hklm } };
}

describe("integration state table (design 3.5)", () => {
  it("defines exactly the seven design states", () => {
    expect([...COLLECTOR_INTEGRATION_STATES].sort()).toEqual(
      ["damaged", "foreign-registration", "not-set-up", "outdated", "policy-blocked", "ready", "registration-missing"],
    );
  });

  type Row = {
    readonly name: string;
    readonly arrange: (fixture: IntegrationFixture) => void;
    readonly state: CollectorIntegrationState;
    readonly reasons: readonly string[];
    readonly installed?: boolean;
  };
  const rows: readonly Row[] = [
    { name: "nothing installed, no registration", installed: false, arrange: () => {}, state: "not-set-up", reasons: [] },
    { name: "fully installed and matching", arrange: () => {}, state: "ready", reasons: [] },
    {
      name: "policy disables user-level hosts (nothing installed)", installed: false,
      arrange: (f) => { f.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 }); },
      state: "policy-blocked", reasons: ["policy-user-level-hosts-disabled"],
    },
    {
      name: "policy blocklists the host while ready",
      arrange: (f) => { f.registry.policies = policies({}, { nativeMessagingBlocklist: ["*"] }); },
      state: "policy-blocked", reasons: ["policy-host-blocklisted"],
    },
    {
      name: "policy beats a foreign registration",
      arrange: (f) => { f.registry.registration = "foreign"; f.registry.policies = policies({ nativeMessagingBlocklist: ["org.maginalia.collector"] }); },
      state: "policy-blocked", reasons: ["policy-host-blocklisted"],
    },
    {
      name: "foreign registration, no program folder", installed: false,
      arrange: (f) => { f.registry.registration = "foreign"; },
      state: "foreign-registration", reasons: ["registration-foreign"],
    },
    {
      name: "foreign registration with our folder present",
      arrange: (f) => { f.registry.registration = "foreign"; },
      state: "foreign-registration", reasons: ["registration-foreign"],
    },
    {
      name: "registration absent (or empty value, which the addon reports as absent) with a valid state file",
      arrange: (f) => { f.registry.registration = "absent"; },
      state: "registration-missing", reasons: ["registration-absent"],
    },
    {
      name: "registration absent, folder without a valid state file (unrecognized)",
      arrange: (f) => { f.registry.registration = "absent"; f.fileSystem.remove(p(f, "integration-state.json")); },
      state: "not-set-up", reasons: ["program-folder-unrecognized"],
    },
    {
      name: "registration ours but the program folder is gone", installed: false,
      arrange: (f) => { f.registry.registration = "ours"; },
      state: "damaged", reasons: ["program-folder-missing"],
    },
    {
      name: "state file missing",
      arrange: (f) => { f.fileSystem.remove(p(f, "integration-state.json")); },
      state: "damaged", reasons: ["state-file-missing"],
    },
    {
      name: "state file garbled",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), "{not json"); },
      state: "damaged", reasons: ["state-file-invalid"],
    },
    {
      name: "state file with an unknown slot",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ activeSlot: "c" })); },
      state: "damaged", reasons: ["state-file-invalid"],
    },
    {
      name: "state file with a path-like extra field",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ path: "C:\\x" })); },
      state: "damaged", reasons: ["state-file-invalid"],
    },
    {
      name: "oversized state file",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), "x".repeat(5000)); },
      state: "damaged", reasons: ["state-file-invalid"],
    },
    {
      name: "manifest missing",
      arrange: (f) => { f.fileSystem.remove(p(f, "org.maginalia.collector.json")); },
      state: "damaged", reasons: ["manifest-missing"],
    },
    {
      name: "manifest points at the other slot",
      arrange: (f) => { f.fileSystem.addFile(p(f, "org.maginalia.collector.json"), expectedManifestText("a")); },
      state: "damaged", reasons: ["manifest-mismatch"],
    },
    {
      name: "manifest widened allowed_origins",
      arrange: (f) => {
        const manifest = JSON.parse(expectedManifestText("b"));
        manifest.allowed_origins.push("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
        f.fileSystem.addFile(p(f, "org.maginalia.collector.json"), JSON.stringify(manifest));
      },
      state: "damaged", reasons: ["manifest-mismatch"],
    },
    {
      name: "manifest redirected path",
      arrange: (f) => {
        const manifest = JSON.parse(expectedManifestText("b"));
        manifest.path = "C:\\evil\\host.exe";
        f.fileSystem.addFile(p(f, "org.maginalia.collector.json"), JSON.stringify(manifest));
      },
      state: "damaged", reasons: ["manifest-mismatch"],
    },
    {
      name: "manifest with an extra key",
      arrange: (f) => {
        const manifest = JSON.parse(expectedManifestText("b"));
        manifest.extra = true;
        f.fileSystem.addFile(p(f, "org.maginalia.collector.json"), JSON.stringify(manifest));
      },
      state: "damaged", reasons: ["manifest-mismatch"],
    },
    {
      name: "manifest not JSON",
      arrange: (f) => { f.fileSystem.addFile(p(f, "org.maginalia.collector.json"), "garbage"); },
      state: "damaged", reasons: ["manifest-invalid"],
    },
    {
      name: "manifest absolute path to the active slot is accepted (design 3.4 fallback)",
      arrange: (f) => {
        const manifest = JSON.parse(expectedManifestText("b"));
        manifest.path = p(f, "host-b", "MAGINALIA-Collector-Host.exe");
        f.fileSystem.addFile(p(f, "org.maginalia.collector.json"), JSON.stringify(manifest));
      },
      state: "ready", reasons: [],
    },
    {
      name: "active slot directory missing",
      arrange: (f) => { for (const n of ["MAGINALIA-Collector-Host.exe", "shelf_mutex.node"]) f.fileSystem.remove(p(f, "host-b", n)); f.fileSystem.remove(p(f, "host-b")); },
      state: "damaged", reasons: ["slot-missing"],
    },
    {
      name: "Host executable missing",
      arrange: (f) => { f.fileSystem.remove(p(f, "host-b", "MAGINALIA-Collector-Host.exe")); },
      state: "damaged", reasons: ["slot-file-missing"],
    },
    {
      name: "Host addon is a reparse point",
      arrange: (f) => { f.fileSystem.setReparse(p(f, "host-b", "shelf_mutex.node"), true); },
      state: "damaged", reasons: ["reparse-point-found"],
    },
    {
      name: "slot directory is a reparse point",
      arrange: (f) => { f.fileSystem.setReparse(p(f, "host-b"), true); },
      state: "damaged", reasons: ["reparse-point-found"],
    },
    {
      name: "Host executable bytes differ from the payload",
      arrange: (f) => { f.fileSystem.addFile(p(f, "host-b", "MAGINALIA-Collector-Host.exe"), "tampered"); },
      state: "damaged", reasons: ["slot-file-hash-mismatch"],
    },
    {
      name: "extension folder missing",
      arrange: (f) => { for (const n of Object.keys(EXTENSION_FILES)) f.fileSystem.remove(p(f, "extension", ...n.split("/"))); f.fileSystem.remove(p(f, "extension")); },
      state: "damaged", reasons: ["extension-folder-missing"],
    },
    {
      name: "extension folder is a reparse point",
      arrange: (f) => { f.fileSystem.setReparse(p(f, "extension"), true); },
      state: "damaged", reasons: ["reparse-point-found"],
    },
    {
      name: "extension file missing",
      arrange: (f) => { f.fileSystem.remove(p(f, "extension", "background.js")); },
      state: "damaged", reasons: ["extension-file-missing"],
    },
    {
      name: "extension file changed",
      arrange: (f) => { f.fileSystem.addFile(p(f, "extension", "background.js"), "evil();"); },
      state: "damaged", reasons: ["extension-file-hash-mismatch"],
    },
    {
      name: "extension manifest.json changed (its version no longer matches the state file)",
      arrange: (f) => { f.fileSystem.addFile(p(f, "extension", "manifest.json"), JSON.stringify({ version: "0.2.0" })); },
      state: "damaged", reasons: ["extension-version-mismatch"],
    },
    {
      name: "extension manifest.json not JSON",
      arrange: (f) => { f.fileSystem.addFile(p(f, "extension", "manifest.json"), "{"); },
      state: "damaged", reasons: ["extension-manifest-invalid"],
    },
    {
      name: "unknown extra file in the extension folder is tolerated",
      arrange: (f) => { f.fileSystem.addFile(p(f, "extension", "notes.txt"), "user file"); },
      state: "ready", reasons: [],
    },
    {
      name: "program folder is a reparse point per the file system",
      arrange: (f) => { f.fileSystem.setReparse(f.programFolder, true); },
      state: "damaged", reasons: ["program-folder-unsafe"],
    },
    {
      name: "program folder has a foreign writer in its ACL",
      arrange: (f) => {
        const facts = safeFacts(true);
        if (!facts.exists) throw new Error("fixture");
        f.securityFacts.set(securityKey(f.programFolder), { ...facts, aces: [...facts.aces, { type: "allow", sid: "S-1-5-21-9-9-9-2002", mask: 0x2, inheritOnly: false }] });
      },
      state: "damaged", reasons: ["program-folder-unsafe"],
    },
    {
      name: "program folder not owned by the current user",
      arrange: (f) => {
        const facts = safeFacts(true);
        if (!facts.exists) throw new Error("fixture");
        f.securityFacts.set(securityKey(f.programFolder), { ...facts, ownerSid: "S-1-5-21-9-9-9-2002" });
      },
      state: "damaged", reasons: ["program-folder-unsafe"],
    },
    {
      name: "program folder security inspection throws",
      arrange: (f) => { f.securityFacts.set(securityKey(f.programFolder), "throw"); },
      state: "damaged", reasons: ["program-folder-unsafe"],
    },
    {
      name: "unrecognized unsafe folder (registration absent) fails closed too",
      arrange: (f) => {
        f.registry.registration = "absent";
        f.fileSystem.remove(p(f, "integration-state.json"));
        f.fileSystem.setReparse(f.programFolder, true);
      },
      state: "damaged", reasons: ["program-folder-unsafe"],
    },
    {
      name: "payload id differs (older install)",
      arrange: (f) => { f.payload = payloadDescriptorFixture({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0" }); },
      state: "outdated", reasons: ["payload-id-differs", "installed-older"],
    },
    {
      name: "payload id differs (installed is newer: rollback)",
      arrange: (f) => { f.payload = payloadDescriptorFixture({ payloadId: "1.1.0+0000001", hostVersion: "1.1.0", extensionVersion: "0.2.0" }); },
      state: "outdated", reasons: ["payload-id-differs", "installed-newer"],
    },
    {
      name: "payload id differs but same versions (rebuild of the same version)",
      arrange: (f) => { f.payload = payloadDescriptorFixture({ payloadId: "1.2.0+zzz9999" }); },
      state: "outdated", reasons: ["payload-id-differs"],
    },
    {
      name: "outdated is reported even though file hashes no longer match the new payload",
      arrange: (f) => { f.payload = payloadDescriptorFixture({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0", extensionVersion: "0.4.0" }); },
      state: "outdated", reasons: ["payload-id-differs", "installed-older"],
    },
    {
      name: "payload descriptor invalid while installed",
      arrange: (f) => { f.payload = { version: 1 }; },
      state: "damaged", reasons: ["payload-descriptor-invalid"],
    },
    {
      name: "payload descriptor unreadable while installed",
      arrange: (f) => { f.payloadFails = true; },
      state: "damaged", reasons: ["payload-descriptor-unavailable"],
    },
    {
      name: "payload descriptor invalid does not make a clean machine damaged", installed: false,
      arrange: (f) => { f.payload = "garbage"; },
      state: "not-set-up", reasons: [],
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      const fixture = createIntegrationFixture({ installed: row.installed });
      row.arrange(fixture);
      const result = await inspect(fixture);
      expect(result.state).toBe(row.state);
      expect([...result.reasons].sort()).toEqual([...row.reasons].sort());
      expect(result.inspectionComplete).toBe(true);
    });
  }

  it("every state of the design is reachable through the table", () => {
    const reached = new Set(rows.map((row) => row.state));
    for (const state of COLLECTOR_INTEGRATION_STATES) expect(reached.has(state)).toBe(true);
  });

  it("reports the installed and packaged facts for a ready install", async () => {
    const result = await inspect(createIntegrationFixture());
    expect(result.registration).toBe("ours");
    expect(result.installed).toEqual({ payloadId: "1.2.0+abc1234", activeSlot: "b", hostVersion: "1.2.0", extensionVersion: "0.3.0" });
    expect(result.versions).toEqual({ host: "equal", extension: "equal" });
    expect(result.payload).toEqual({ status: "valid", payloadId: "1.2.0+abc1234" });
    expect(result.filesVerified).toBe(true);
    expect(result.folderSecurityViolation).toBeNull();
  });

  it("records the ACL violation code for an unsafe folder", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.setReparse(fixture.programFolder, true);
    expect((await inspect(fixture)).folderSecurityViolation).toBe("wrong-entry-type");
    const second = createIntegrationFixture();
    const facts = safeFacts(true);
    if (!facts.exists) throw new Error("fixture");
    second.securityFacts.set(securityKey(second.programFolder), { ...facts, daclPresent: false });
    expect((await inspect(second)).folderSecurityViolation).toBe("null-dacl");
  });
});

describe("cheap mode (design 6: hashes only when writing or repairing)", () => {
  it("skips every hash, still finds missing files and reports filesVerified=false", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(p(fixture, "extension", "background.js"), "tampered but present");
    const result = await inspect(fixture, { verifyFileHashes: false });
    expect(result.state).toBe("ready");
    expect(result.filesVerified).toBe(false);
    expect(fixture.fileSystem.calls.some((call) => call.method === "sha256File")).toBe(false);
    fixture.fileSystem.remove(p(fixture, "extension", "background.js"));
    expect((await inspect(fixture, { verifyFileHashes: false })).reasons).toEqual(["extension-file-missing"]);
  });

  it("outdated is decided without hashing", async () => {
    const fixture = createIntegrationFixture();
    fixture.payload = payloadDescriptorFixture({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0" });
    expect((await inspect(fixture)).state).toBe("outdated");
    expect(fixture.fileSystem.calls.some((call) => call.method === "sha256File")).toBe(false);
  });
});

describe("version comparison payload vs installed", () => {
  const rows: ReadonlyArray<readonly [string, { payloadId: string; hostVersion: string; extensionVersion?: string }, string, string]> = [
    ["equal", { payloadId: "1.2.0+abc1234", hostVersion: "1.2.0" }, "equal", "equal"],
    ["installed older", { payloadId: "1.3.0+x1", hostVersion: "1.3.0", extensionVersion: "0.4.0" }, "older", "older"],
    ["installed newer", { payloadId: "1.0.0+x1", hostVersion: "1.0.0", extensionVersion: "0.1.0" }, "newer", "newer"],
    ["host older, extension equal", { payloadId: "1.3.0+x1", hostVersion: "1.3.0" }, "older", "equal"],
  ];
  for (const [name, payload, host, extension] of rows) {
    it(name, async () => {
      const fixture = createIntegrationFixture();
      fixture.payload = payloadDescriptorFixture(payload);
      const result = await inspect(fixture);
      expect(result.versions).toEqual({ host, extension });
    });
  }

  it("unparseable installed version is reported as such, never equal", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(p(fixture, "integration-state.json"), stateFileText({ payloadId: "weird+abc1234" }));
    fixture.payload = payloadDescriptorFixture({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0" });
    const result = await inspect(fixture);
    expect(result.state).toBe("outdated");
    expect(result.versions.host).toBe("unparseable");
    expect(result.reasons).toContain("installed-version-unparseable");
  });
});

describe("Chrome policy detection (design 8.4)", () => {
  const rows: ReadonlyArray<readonly [string, ChromePolicySnapshot, { blocked: boolean; userLevel?: boolean; host?: boolean; extension?: boolean }]> = [
    ["no policies", policies(), { blocked: false }],
    ["user-level hosts = 0 in HKCU", policies({ nativeMessagingUserLevelHosts: 0 }), { blocked: true, userLevel: true }],
    ["user-level hosts = 0 in HKLM", policies({}, { nativeMessagingUserLevelHosts: 0 }), { blocked: true, userLevel: true }],
    ["user-level hosts = 1", policies({ nativeMessagingUserLevelHosts: 1 }), { blocked: false }],
    ["HKLM = 1 wins over HKCU = 0 (machine policy first)", policies({ nativeMessagingUserLevelHosts: 0 }, { nativeMessagingUserLevelHosts: 1 }), { blocked: false }],
    ["blocklist *", policies({}, { nativeMessagingBlocklist: ["*"] }), { blocked: true, host: true }],
    ["blocklist by name", policies({ nativeMessagingBlocklist: ["org.maginalia.collector"] }), { blocked: true, host: true }],
    ["blocklist other host", policies({ nativeMessagingBlocklist: ["com.other.host"] }), { blocked: false }],
    ["blocklist * with allowlist name", policies({ nativeMessagingBlocklist: ["*"], nativeMessagingAllowlist: ["org.maginalia.collector"] }), { blocked: false }],
    ["blocklist * in HKLM, allowlist name in HKCU", policies({ nativeMessagingAllowlist: ["org.maginalia.collector"] }, { nativeMessagingBlocklist: ["*"] }), { blocked: false }],
    ["blocklist * with allowlist for another host", policies({ nativeMessagingBlocklist: ["*"], nativeMessagingAllowlist: ["com.other.host"] }), { blocked: true, host: true }],
    ["allowlist alone", policies({ nativeMessagingAllowlist: ["org.maginalia.collector"] }), { blocked: false }],
    ["both reasons", policies({ nativeMessagingUserLevelHosts: 0, nativeMessagingBlocklist: ["*"] }), { blocked: true, userLevel: true, host: true }],
    ["devtools disabled: warning only", policies({}, { developerToolsAvailability: 2 }), { blocked: false, extension: true }],
    ["devtools allowed", policies({ developerToolsAvailability: 1 }), { blocked: false }],
    ["extension blocklist *", policies({ extensionInstallBlocklist: ["*"] }), { blocked: false, extension: true }],
    ["extension blocklist * with allowlist for the id", policies({ extensionInstallBlocklist: ["*"], extensionInstallAllowlist: ["blgmoddncpknfnikdfnjelmdmphfgknf"] }), { blocked: false }],
    ["extension blocklist names the id", policies({ extensionInstallBlocklist: ["blgmoddncpknfnikdfnjelmdmphfgknf"] }), { blocked: false, extension: true }],
    ["extension blocklist other id", policies({ extensionInstallBlocklist: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }), { blocked: false }],
  ];
  for (const [name, snapshot, expected] of rows) {
    it(name, () => {
      expect(evaluateChromePolicies(snapshot)).toEqual({
        userLevelHostsDisabled: expected.userLevel === true,
        hostBlocked: expected.host === true,
        blocked: expected.blocked,
        extensionLoadMayBeBlocked: expected.extension === true,
      });
    });
  }

  it("an extension-load warning never changes the state", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.policies = policies({ developerToolsAvailability: 2 });
    const result = await inspect(fixture);
    expect(result.state).toBe("ready");
    expect(result.policy.extensionLoadMayBeBlocked).toBe(true);
    expect(result.policy.status).toBe("read");
  });

  it("an unreadable policy snapshot is reported and never blocks", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.failNext.readChromePolicies = new Error("denied");
    const result = await inspect(fixture);
    expect(result.state).toBe("ready");
    expect(result.policy).toMatchObject({ status: "unavailable", blocked: false });
  });
});

describe("Chrome locator (design 4.2)", () => {
  const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  function setup(): IntegrationFixture {
    return createIntegrationFixture({ installed: false });
  }

  it("prefers HKCU App Paths, then HKLM 64, HKLM 32, then known folders", async () => {
    const fixture = setup();
    const hkcu = "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    fixture.fileSystem.addFile(hkcu, "x");
    fixture.fileSystem.addFile(CHROME, "x");
    fixture.registry.appPaths = [{ source: "hkcu", value: hkcu }, { source: "hklm-64", value: CHROME }];
    const found = await locateChromeExecutable(fixture.dependencies);
    expect(found).toMatchObject({ status: "found", source: "app-paths-hkcu", executablePath: hkcu });
  });

  it("falls back to the known folders when App Paths are absent", async () => {
    const fixture = setup();
    fixture.fileSystem.addFile(CHROME, "x");
    const found = await locateChromeExecutable(fixture.dependencies);
    expect(found).toMatchObject({ status: "found", source: "known-program-files", executablePath: CHROME });
  });

  it("accepts a quoted App Paths value", async () => {
    const fixture = setup();
    fixture.fileSystem.addFile(CHROME, "x");
    fixture.registry.appPaths = [{ source: "hklm-32", value: `"${CHROME}"` }];
    expect(await locateChromeExecutable(fixture.dependencies)).toMatchObject({ status: "found", source: "app-paths-hklm-32" });
  });

  const rejects: ReadonlyArray<readonly [string, string, string, (f: IntegrationFixture) => void]> = [
    ["UNC path", "\\\\server\\share\\Chrome\\chrome.exe", "not-absolute-local", () => {}],
    ["device path", "\\\\?\\C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "not-absolute-local", () => {}],
    ["relative path", "Google\\Chrome\\Application\\chrome.exe", "not-absolute-local", () => {}],
    ["drive-relative path", "C:chrome.exe", "not-absolute-local", () => {}],
    ["forward slashes", "C:/Program Files/Google/Chrome/Application/chrome.exe", "not-absolute-local", () => {}],
    ["dot-dot segments", "C:\\Program Files\\Google\\..\\Google\\Chrome\\Application\\chrome.exe", "not-absolute-local", () => {}],
    ["alternate data stream", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe:evil", "not-absolute-local", () => {}],
    ["unexpanded variable", "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe", "unexpanded-variable", () => {}],
    ["wrong basename", "C:\\Program Files\\Google\\Chrome\\Application\\chrome2.exe", "wrong-basename", (f) => f.fileSystem.addFile("C:\\Program Files\\Google\\Chrome\\Application\\chrome2.exe", "x")],
    ["wrong basename (msedge)", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "wrong-basename", (f) => f.fileSystem.addFile("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "x")],
    ["missing file", CHROME, "missing", () => {}],
    ["a directory named chrome.exe", CHROME, "not-regular-file", (f) => f.fileSystem.addDirectory(CHROME)],
    ["reparse point at the file", CHROME, "reparse-point", (f) => { f.fileSystem.addFile(CHROME, "x"); f.fileSystem.setReparse(CHROME, true); }],
    ["reparse point in the chain", CHROME, "reparse-point", (f) => { f.fileSystem.addFile(CHROME, "x"); f.fileSystem.setReparse("C:\\Program Files\\Google", true); }],
    ["file where a directory is expected", CHROME, "not-regular-file", (f) => { f.fileSystem.addFile("C:\\Program Files\\Google", "x"); }],
  ];
  for (const [name, value, reason, arrange] of rejects) {
    it(`rejects ${name}`, async () => {
      const fixture = setup();
      arrange(fixture);
      fixture.registry.appPaths = [{ source: "hkcu", value }];
      const result = await locateChromeExecutable(fixture.dependencies);
      expect(result.status).toBe("not-found");
      if (result.status !== "not-found") return;
      expect(result.rejected[0]).toEqual({ source: "app-paths-hkcu", reason });
    });
  }

  it("a rejected first candidate does not stop a valid later one", async () => {
    const fixture = setup();
    fixture.fileSystem.addFile(CHROME, "x");
    fixture.registry.appPaths = [{ source: "hkcu", value: "\\\\server\\x\\chrome.exe" }];
    const result = await locateChromeExecutable(fixture.dependencies);
    expect(result).toMatchObject({ status: "found", source: "known-program-files" });
    if (result.status === "found") expect(result.rejected).toContainEqual({ source: "app-paths-hkcu", reason: "not-absolute-local" });
  });

  it("is not-found when there is no candidate at all, and unknown when the registry read fails", async () => {
    const fixture = setup();
    expect((await locateChromeExecutable(fixture.dependencies)).status).toBe("not-found");
    fixture.registry.failNext.readChromeAppPaths = new Error("denied");
    expect(await locateChromeExecutable(fixture.dependencies)).toEqual({ status: "unknown" });
  });

  it("a file-system failure rejects only that candidate", async () => {
    const fixture = setup();
    fixture.fileSystem.addFile(CHROME, "x");
    fixture.fileSystem.failing.add(securityKey("C:\\Program Files\\Google"));
    const result = await locateChromeExecutable(fixture.dependencies);
    expect(result.status).toBe("not-found");
    if (result.status === "not-found") expect(result.rejected.some((entry) => entry.reason === "read-failed")).toBe(true);
  });

  it("the inspection result carries Chrome status and source but never its path", async () => {
    const fixture = setup();
    fixture.fileSystem.addFile(CHROME, "x");
    const result = await inspect(fixture);
    expect(result.chrome).toMatchObject({ status: "found", source: "known-program-files" });
    expect(JSON.stringify(result.chrome)).not.toMatch(/Program Files|chrome\.exe/iu);
  });

  it("Chrome absence never changes the integration state", async () => {
    const fixture = createIntegrationFixture();
    const result = await inspect(fixture);
    expect(result.chrome.status).toBe("not-found");
    expect(result.state).toBe("ready");
  });

  const progIds: ReadonlyArray<readonly [string | null, string]> = [
    [null, "unknown"], ["ChromeHTML", "chrome"], ["ChromeHTML.ABC123", "chrome"], ["MSEdgeHTM", "edge"], ["MSEdgeHTM.x", "edge"],
    ["BraveHTML", "other-chromium"], ["VivaldiHTM", "other-chromium"], ["OperaStable", "other-chromium"],
    ["FirefoxURL-308046B0AF4A39CB", "other"], ["SafariHTML", "other"], ["ChromeHTMLevil", "other"],
  ];
  for (const [progId, kind] of progIds) {
    it(`default browser ${String(progId)} is ${kind}`, () => {
      expect(classifyDefaultBrowser(progId)).toBe(kind);
    });
  }

  it("default browser is reported and a failing read only yields unknown", async () => {
    const fixture = setup();
    fixture.registry.defaultBrowserProgId = "MSEdgeHTM";
    expect((await inspect(fixture)).chrome.defaultBrowser).toBe("edge");
    fixture.registry.failNext.readDefaultBrowserProgId = new Error("denied");
    expect((await inspect(fixture)).chrome.defaultBrowser).toBe("unknown");
  });

  it("local absolute path rule", () => {
    expect(isLocalAbsoluteWindowsPath("C:\\Program Files\\x\\chrome.exe")).toBe(true);
    for (const bad of ["", "C:", "C:\\", "C:\\x\\", "\\\\h\\s\\a", "relative", "C:\\a\\..\\b", "C:\\a\\\\b", "c:\\a%b", 5, null]) expect(isLocalAbsoluteWindowsPath(bad)).toBe(false);
  });
});

describe("contact record (display only)", () => {
  async function contactOf(fixture: IntegrationFixture) {
    return (await inspect(fixture)).contact;
  }
  const contactPath = (fixture: IntegrationFixture): string => path.win32.join(fixture.integrationDirectory, "collector-contact.json");

  it("absent when the file does not exist", async () => {
    expect(await contactOf(createIntegrationFixture())).toEqual({ status: "absent" });
  });

  it("present and compared with the placed and packaged versions", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(contactPath(fixture), contactText());
    expect(await contactOf(fixture)).toMatchObject({
      status: "present",
      record: { version: 1, hostVersion: "1.2.0", extensionVersion: "0.3.0" },
      extensionVersionVsPlaced: "equal",
      hostVersionVsPayload: "equal",
    });
    fixture.fileSystem.addFile(contactPath(fixture), contactText({ extensionVersion: "0.2.0", hostVersion: "1.3.0" }));
    expect(await contactOf(fixture)).toMatchObject({ extensionVersionVsPlaced: "older", hostVersionVsPayload: "newer" });
  });

  it("is displayed even when nothing is installed and never changes the state", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    fixture.fileSystem.addFile(contactPath(fixture), contactText());
    const result = await inspect(fixture);
    expect(result.state).toBe("not-set-up");
    expect(result.contact).toMatchObject({ status: "present", extensionVersionVsPlaced: "not-placed" });
  });

  const invalid: ReadonlyArray<readonly [string, string, string]> = [
    ["garbled JSON", "{{{", "not-json"],
    ["a JSON array", "[]", "not-an-object"],
    ["null", "null", "not-an-object"],
    ["an extra field", contactText({ extra: "x" }), "unexpected-fields"],
    ["a path-like extra field", contactText({ shelfPath: "C:\\Shelf" }), "unexpected-fields"],
    ["a missing field", JSON.stringify({ version: 1, protocol: COLLECTOR_PROTOCOL, hostVersion: "1.2.0", extensionVersion: "0.3.0" }), "unexpected-fields"],
    ["version 2", contactText({ version: 2 }), "wrong-version"],
    ["another protocol", contactText({ protocol: "other.v1" }), "wrong-protocol"],
    ["garbled host version", contactText({ hostVersion: "latest" }), "invalid-host-version"],
    ["garbled extension version", contactText({ extensionVersion: 3 }), "invalid-extension-version"],
    ["a non-ISO timestamp", contactText({ contactedAt: "yesterday" }), "invalid-timestamp"],
    ["a timestamp without Z", contactText({ contactedAt: "2026-11-14T08:00:00" }), "invalid-timestamp"],
    ["an impossible date", contactText({ contactedAt: "2026-02-30T08:00:00.000Z" }), "invalid-timestamp"],
    ["a numeric timestamp", contactText({ contactedAt: 1 }), "invalid-timestamp"],
    ["a future timestamp", contactText({ contactedAt: "2026-11-15T09:00:00.000Z" }), "future-timestamp"],
    ["an oversized file", contactText({ pad: "x".repeat(5000) }), "too-large"],
  ];
  for (const [name, text, reason] of invalid) {
    it(`invalid: ${name}`, async () => {
      const fixture = createIntegrationFixture();
      fixture.fileSystem.addFile(contactPath(fixture), text);
      expect(await contactOf(fixture)).toEqual({ status: "invalid", reason });
    });
  }

  it("a timestamp within the clock-skew tolerance is accepted", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(contactPath(fixture), contactText({ contactedAt: "2026-11-14T09:03:00.000Z" }));
    expect((await contactOf(fixture)).status).toBe("present");
  });

  it("a reparse-point contact file is invalid and not read", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(contactPath(fixture), contactText(), { reparse: true });
    expect(await contactOf(fixture)).toEqual({ status: "invalid", reason: "reparse-point" });
    expect(fixture.fileSystem.readPaths).not.toContain(securityKey(contactPath(fixture)));
  });

  it("is unavailable when the integration folder fails the ACL checks", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(contactPath(fixture), contactText());
    const facts = safeFacts(true);
    if (!facts.exists) throw new Error("fixture");
    fixture.securityFacts.set(securityKey(fixture.integrationDirectory), { ...facts, aces: [...facts.aces, { type: "allow", sid: "S-1-1-0", mask: 0x2, inheritOnly: false }] });
    expect(await contactOf(fixture)).toEqual({ status: "unavailable", violation: "foreign-writer" });
  });

  it("is unavailable when the ACL inspection throws", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(contactPath(fixture), contactText());
    fixture.securityFacts.set(securityKey(path.win32.dirname(fixture.integrationDirectory)), "throw");
    expect(await contactOf(fixture)).toEqual({ status: "unavailable", violation: "inspection-failed" });
  });

  it("parseCollectorContactRecord is strict about the five fields", () => {
    const ok = parseCollectorContactRecord(contactText(), FIXTURE_NOW);
    expect(ok.ok).toBe(true);
    expect(parseCollectorContactRecord("{", FIXTURE_NOW)).toEqual({ ok: false, reason: "not-json" });
  });

  it("parseIntegrationStateFile accepts only the five-field shape", () => {
    expect(parseIntegrationStateFile(stateFileText())).toMatchObject({ activeSlot: "b" });
    for (const text of [stateFileText({ extra: 1 }), stateFileText({ version: 2 }), stateFileText({ payloadId: "nocommit" }), stateFileText({ extensionVersion: "x" }), stateFileText({ placedAt: "x" }), "[]", "x"]) {
      expect(parseIntegrationStateFile(text)).toBeUndefined();
    }
  });
});

describe("fail-closed inspection and privacy of the result", () => {
  it("an unavailable known folder gives damaged, incomplete, and never throws", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.failNext.getKnownFolderPath = new Error("E_FAIL");
    const result = await inspect(fixture);
    expect(result).toMatchObject({ state: "damaged", inspectionComplete: false, extensionFolderDisplay: null });
    expect(result.reasons).toContain("known-folder-unavailable");
  });

  it("a known folder that is not a local absolute path is refused", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.knownFolders.UserProgramFiles = "\\\\server\\share";
    const result = await inspect(fixture);
    expect(result).toMatchObject({ state: "damaged", inspectionComplete: false });
  });

  it("a failing registration read gives damaged, incomplete", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.failNext.readCollectorHostRegistration = new Error("denied");
    const result = await inspect(fixture);
    expect(result).toMatchObject({ state: "damaged", inspectionComplete: false, registration: "unknown" });
    expect(result.reasons).toContain("registry-read-failed");
  });

  it("a file-system failure gives damaged, incomplete", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.failing.add(securityKey(p(fixture, "org.maginalia.collector.json")));
    const result = await inspect(fixture);
    expect(result).toMatchObject({ state: "damaged", inspectionComplete: false });
    expect(result.reasons).toContain("filesystem-read-failed");
  });

  it("policy-blocked still wins when other reads fail", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 });
    fixture.registry.failNext.readCollectorHostRegistration = new Error("denied");
    expect((await inspect(fixture)).state).toBe("policy-blocked");
  });

  it("no path appears in the result except extensionFolderDisplay", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.appPaths = [{ source: "hkcu", value: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }];
    fixture.fileSystem.addFile("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "x");
    fixture.fileSystem.addFile(path.win32.join(fixture.integrationDirectory, "collector-contact.json"), contactText());
    const results = [
      await inspect(fixture),
      await inspect(Object.assign(createIntegrationFixture(), {})),
    ];
    // also an unsafe and a damaged variant
    const unsafe = createIntegrationFixture();
    unsafe.fileSystem.setReparse(unsafe.programFolder, true);
    results.push(await inspect(unsafe));
    const damaged = createIntegrationFixture();
    damaged.fileSystem.remove(p(damaged, "org.maginalia.collector.json"));
    results.push(await inspect(damaged));
    for (const result of results) {
      const { extensionFolderDisplay, ...rest } = result;
      expect(extensionFolderDisplay).toBe(path.win32.join(fixture.programFolder, "extension"));
      const text = JSON.stringify(rest);
      expect(text).not.toMatch(/[A-Za-z]:\\|tester|AppData|Program Files|\.exe|\\\\/iu);
    }
  });

  it("the extension folder display is available even before setup", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    expect((await inspect(fixture)).extensionFolderDisplay).toBe(path.win32.join(fixture.programFolder, "extension"));
  });
});

describe("no-write guarantee", () => {
  it("only read methods are called, across every state", async () => {
    const mutatingRegistryCalls = ["registerCollectorHost", "unregisterCollectorHost", "replaceForeignCollectorHostRegistration"];
    const readOnlyRegistry = new Set(["getKnownFolderPath", "readCollectorHostRegistration", "readChromePolicies", "readChromeAppPaths", "readDefaultBrowserProgId"]);
    const arrangements: Array<(f: IntegrationFixture) => void> = [
      () => {},
      (f) => { f.registry.registration = "absent"; },
      (f) => { f.registry.registration = "foreign"; },
      (f) => { f.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 }); },
      (f) => { f.payload = payloadDescriptorFixture({ payloadId: "9.9.9+aaaaaaa", hostVersion: "9.9.9" }); },
      (f) => { f.fileSystem.remove(p(f, "org.maginalia.collector.json")); },
    ];
    for (const arrange of arrangements) {
      const fixture = createIntegrationFixture();
      arrange(fixture);
      const before = fixture.fileSystem.text(p(fixture, "integration-state.json"));
      await inspect(fixture);
      for (const call of fixture.registry.calls) {
        expect(mutatingRegistryCalls).not.toContain(call);
        expect(readOnlyRegistry.has(call)).toBe(true);
      }
      expect(fixture.fileSystem.calls.every((call) => ["stat", "readSmallFile", "sha256File"].includes(call.method))).toBe(true);
      expect(fixture.fileSystem.text(p(fixture, "integration-state.json"))).toBe(before);
    }
  });

  it("the file-system interface offers no mutating method", () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(createIntegrationFixture().fileSystem)).filter((name) => name !== "constructor");
    const interfaceMethods = ["stat", "readSmallFile", "sha256File"];
    for (const name of interfaceMethods) expect(methods).toContain(name);
    expect(Object.keys(createNodeCollectorIntegrationFileSystem()).sort()).toEqual([...interfaceMethods].sort());
  });
});

describe("E2E isolation (MAGINALIA_E2E_ISOLATION_ROOT)", () => {
  it("inspection works unchanged and read-only; only writesAllowed reflects it", async () => {
    const normal = createIntegrationFixture();
    const isolated = createIntegrationFixture();
    isolated.isolated = true;
    const a = await inspect(normal);
    const b = await inspect(isolated);
    expect(a.writesAllowed).toBe(true);
    expect(b.writesAllowed).toBe(false);
    expect({ ...b, writesAllowed: true }).toEqual(a);
    expect(isolated.registry.calls.every((call) => call.startsWith("get") || call.startsWith("read"))).toBe(true);
  });

  it("an isolated launch on a clean machine still reports not-set-up", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    fixture.isolated = true;
    expect(await inspect(fixture)).toMatchObject({ state: "not-set-up", writesAllowed: false });
  });
});

describe("expected manifest (design 3.4)", () => {
  it("is generated from constants only", () => {
    expect(expectedHostManifest("a")).toEqual({
      name: "org.maginalia.collector",
      description: "MAGINALIA Collector Native Messaging Host",
      path: "host-a\\MAGINALIA-Collector-Host.exe",
      type: "stdio",
      allowed_origins: ["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"],
    });
  });
});

describe("source scan: no environment, cwd, argv, Electron path, write or spawn", () => {
  const files = ["collector-integration.ts", "collector-integration-types.ts", "collector-integration-fs.ts", "collector-payload.ts", "collector-version.ts"];
  const forbiddenAccess = [/process\s*\.\s*env\b/u, /process\s*\.\s*cwd\b/u, /process\s*\.\s*argv\b/u, /\bapp\s*\.\s*getPath\b/u, /\bprocess\s*\[\s*["']env["']\s*\]/u, /\bprocess\s*\.\s*resourcesPath\b/u];
  const forbiddenWrites = [
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rmdir|rmdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|chmod|chown|truncate|utimes|createWriteStream|mkdtemp)\b\s*[(,]/u,
    /\bchild_process\b/u, /(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/u,
    /\bregisterCollectorHost\b/u, /\bunregisterCollectorHost\b/u, /\breplaceForeignCollectorHostRegistration\b/u,
    /\bimport\s*\(/u,
  ];
  for (const file of files) {
    it(`${file} has none of them`, () => {
      const source = readFileSync(path.join(here, file), "utf8");
      for (const pattern of forbiddenAccess) expect(source).not.toMatch(pattern);
      for (const pattern of forbiddenWrites) expect(source).not.toMatch(pattern);
    });
  }

  it("the product file-system adapter imports only read primitives", () => {
    const source = readFileSync(path.join(here, "collector-integration-fs.ts"), "utf8");
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(node:[^"]+)"/gu)].map((match) => `${match[2]}:${(match[1] as string).split(",").map((name) => name.trim()).sort().join(",")}`);
    expect(imports.sort()).toEqual(["node:crypto:createHash", "node:fs:createReadStream", "node:fs/promises:lstat,open"].sort());
  });
});

describe("product file-system adapter against a temp directory (read-only)", () => {
  const temps: string[] = [];
  afterEach(async () => {
    for (const temp of temps.splice(0)) await rm(temp, { recursive: true, force: true });
  });

  async function temp(): Promise<string> {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "collector-inspect-")));
    temps.push(root);
    return root;
  }

  it("stat, bounded read and SHA-256", async () => {
    const root = await temp();
    const file = path.join(root, "a.txt");
    await writeFile(file, "hello");
    await mkdir(path.join(root, "d"));
    const fs = createNodeCollectorIntegrationFileSystem();
    expect(await fs.stat(file)).toMatchObject({ kind: "file", isReparsePoint: false, size: 5 });
    expect(await fs.stat(path.join(root, "d"))).toMatchObject({ kind: "directory" });
    expect(await fs.stat(path.join(root, "missing"))).toBeNull();
    expect(await fs.stat(path.join(file, "below-a-file"))).toBeNull();
    const read = await fs.readSmallFile(file, 10);
    expect(read.kind).toBe("ok");
    expect(await fs.readSmallFile(file, 4)).toEqual({ kind: "too-large" });
    expect(await fs.readSmallFile(path.join(root, "missing"), 10)).toEqual({ kind: "missing" });
    expect(await fs.sha256File(file)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await fs.sha256File(path.join(root, "missing"))).toBeNull();
    expect(await fs.sha256File(path.join(root, "d"))).toBeNull();
  });

  it("reports a junction as a reparse point and does not follow it", async () => {
    const root = await temp();
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "x.txt"), "x");
    const link = path.join(root, "link");
    try {
      await symlink(target, link, "junction");
    } catch {
      return; // junction creation unavailable on this platform: nothing to assert
    }
    const fs = createNodeCollectorIntegrationFileSystem();
    expect(await fs.stat(link)).toMatchObject({ isReparsePoint: true });
  });

  it.runIf(process.platform === "win32")("runs the whole inspection over a real temp tree (registry and ACL facts are fakes)", async () => {
    const root = await temp();
    const fixture = createIntegrationFixture({ installed: false });
    const programFiles = path.join(root, "Programs");
    fixture.registry.knownFolders.UserProgramFiles = programFiles;
    fixture.registry.knownFolders.LocalAppData = path.join(root, "Local");
    const real = createNodeCollectorIntegrationFileSystem();
    const probe = (target: string): unknown => {
      try {
        return safeFacts(lstatSync(target).isDirectory());
      } catch {
        return { exists: false };
      }
    };
    const dependencies = { ...fixture.dependencies, fileSystem: real, inspectPathSecurity: probe };
    expect((await inspectCollectorIntegration(dependencies)).state).toBe("not-set-up");

    const program = path.join(programFiles, "MAGINALIA Collector");
    await mkdir(path.join(program, "host-b"), { recursive: true });
    await mkdir(path.join(program, "extension", "pages"), { recursive: true });
    await writeFile(path.join(program, "org.maginalia.collector.json"), expectedManifestText("b"));
    await writeFile(path.join(program, "integration-state.json"), stateFileText());
    await writeFile(path.join(program, "host-b", "MAGINALIA-Collector-Host.exe"), HOST_EXE_BYTES);
    await writeFile(path.join(program, "host-b", "shelf_mutex.node"), HOST_ADDON_BYTES);
    for (const [name, content] of Object.entries(EXTENSION_FILES)) await writeFile(path.join(program, "extension", ...name.split("/")), content);
    fixture.registry.registration = "ours";
    expect(await inspectCollectorIntegration(dependencies)).toMatchObject({ state: "ready", filesVerified: true });

    await writeFile(path.join(program, "extension", "background.js"), "tampered");
    expect((await inspectCollectorIntegration(dependencies)).reasons).toEqual(["extension-file-hash-mismatch"]);
  });
});
