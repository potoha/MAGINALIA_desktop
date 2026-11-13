import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_HOST_LICENSE_FILES,
  COLLECTOR_MANIFEST_PATH_FORM,
  applyCollectorIntegration,
  buildCollectorHostManifest,
  deriveExtensionIdFromManifestKey,
  reasonForError,
  sha256Hex,
} from "./collector-integration-apply";
import { CollectorFileSystemError, type CollectorApplyRequest, type CollectorApplyResult } from "./collector-integration-apply-types";
import { expectedHostManifest, inspectCollectorIntegration, parseIntegrationStateFile } from "./collector-integration";
import { COLLECTOR_ALLOWED_ORIGINS, COLLECTOR_HOST_ADDON_NAME, COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_PROTOCOL } from "./collector-payload";
import {
  COLLECTOR_TEST_KEY,
  HOST_SOURCE_FILES,
  SOURCE_EXTENSION_FOLDER,
  SOURCE_HOST_FOLDER,
  applyDescriptor,
  createApplyFixture,
  extensionSourceFiles,
  type ApplyFixture,
} from "./collector-integration-apply.test-helper";
import { fakeKey } from "./collector-integration.test-helper";
import { EMPTY_CHROME_POLICIES_FOR_HIVE } from "./collector-registry-adapter.test-helper";
import { safeFacts } from "./collector-host-fixture.test-helper";

const run = (fixture: ApplyFixture, request: CollectorApplyRequest): Promise<CollectorApplyResult> => applyCollectorIntegration(request, fixture.deps);
const p = (fixture: ApplyFixture, ...parts: string[]): string => path.win32.join(fixture.programFolder, ...parts);

async function installed(fixture: ApplyFixture): Promise<ApplyFixture> {
  const result = await run(fixture, { action: "setup" });
  if (result.outcome !== "applied") throw new Error(`fixture setup failed: ${result.reason}`);
  fixture.fileSystem.mutations.length = 0;
  fixture.registry.calls.length = 0;
  return fixture;
}

/** Install an older payload, then switch the packaged payload to a newer one (state `outdated`). */
async function outdated(fixture: ApplyFixture): Promise<ApplyFixture> {
  await installed(fixture);
  fixture.fileSystem.setBytes(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), "host-executable-bytes-v2");
  fixture.payload = applyDescriptor({
    payloadId: "1.3.0+def5678",
    hostVersion: "1.3.0",
    extensionVersion: "0.4.0",
    host: { ...HOST_SOURCE_FILES, [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes-v2" },
  });
  const files = extensionSourceFiles("0.4.0");
  for (const [name, content] of Object.entries(files)) fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, ...name.split("/")), content);
  return fixture;
}

const writesTo = (fixture: ApplyFixture): string[] => fixture.fileSystem.mutations;
const registryWrites = (fixture: ApplyFixture): string[] => fixture.registry.calls.filter((call) => /^(register|unregister|replace)/u.test(call));

describe("pure helpers", () => {
  it("derives the compiled extension ID from the real public key", () => {
    expect(deriveExtensionIdFromManifestKey(COLLECTOR_TEST_KEY)).toBe("blgmoddncpknfnikdfnjelmdmphfgknf");
  });

  it.each([undefined, null, 5, "", "not base64!", "AAAA%", {}, []])("rejects manifest key %j", (key) => {
    expect(deriveExtensionIdFromManifestKey(key)).toBeUndefined();
  });

  it("builds the relative manifest of design 3.4", () => {
    expect(buildCollectorHostManifest("b", "C:\\x\\MAGINALIA Collector", "relative")).toEqual({
      name: "org.maginalia.collector",
      description: "MAGINALIA Collector Native Messaging Host",
      path: "host-b\\MAGINALIA-Collector-Host.exe",
      type: "stdio",
      allowed_origins: ["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"],
    });
  });

  it("the default form is relative and equals the WP-5a expected manifest for both slots", () => {
    expect(COLLECTOR_MANIFEST_PATH_FORM).toBe("relative");
    for (const slot of ["a", "b"] as const) expect(buildCollectorHostManifest(slot, "C:\\x")).toEqual(expectedHostManifest(slot));
  });

  it("the absolute fallback is one constant away and JSON-escapes non-ASCII folders", () => {
    const folder = "C:\\Users\\山田\\AppData\\Local\\Programs\\MAGINALIA Collector";
    const manifest = buildCollectorHostManifest("a", folder, "absolute");
    expect(manifest.path).toBe(`${folder}\\host-a\\MAGINALIA-Collector-Host.exe`);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("uses exactly one allowed origin", () => {
    expect(buildCollectorHostManifest("a", "C:\\x").allowed_origins).toEqual([...COLLECTOR_ALLOWED_ORIGINS]);
  });

  it("maps errors to opaque reasons and never forwards a message", () => {
    expect(reasonForError(new CollectorFileSystemError("locked"))).toBe("file-locked");
    expect(reasonForError(new CollectorFileSystemError("exists"))).toBe("write-failed");
    expect(reasonForError(new Error("C:\\Users\\secret\\file.txt"))).toBe("write-failed");
    expect(reasonForError("C:\\secret")).toBe("write-failed");
  });

  it("file-system errors carry fixed text without paths", () => {
    for (const code of ["locked", "exists", "missing", "not-empty", "failed"] as const) {
      expect(new CollectorFileSystemError(code).message).toBe(`Collector file-system operation failed (${code}).`);
    }
  });

  it("hashes text and bytes alike", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex(new TextEncoder().encode("abc")));
  });
});

describe("setup from nothing (design 3.5 order of side effects)", () => {
  it("applies, ends ready and verified", async () => {
    const fixture = createApplyFixture();
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ action: "setup", outcome: "applied", reason: null, state: "ready", selfCheck: "ok" });
    expect(result.inspection.filesVerified).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("places slot a, extension, manifest, state and registers", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    const fs = fixture.fileSystem;
    for (const name of [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME, ...COLLECTOR_HOST_LICENSE_FILES]) {
      expect(fs.has(p(fixture, "host-a", name))).toBe(true);
    }
    expect(fs.has(p(fixture, "host-b"))).toBe(false);
    expect(fs.text(p(fixture, "extension", "pages", "onboarding.html"))).toBe("<html></html>");
    expect(fs.has(p(fixture, "extension.next"))).toBe(false);
    expect(fs.has(p(fixture, "extension.prev"))).toBe(false);
    expect(fixture.registry.registration).toBe("ours");
  });

  it("writes the generated manifest and a state file of exactly five fields", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    expect(JSON.parse(fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json")))).toEqual(expectedHostManifest("a"));
    const state = parseIntegrationStateFile(fixture.fileSystem.text(p(fixture, "integration-state.json")));
    expect(state).toEqual({ version: 1, payloadId: "1.2.0+abc1234", activeSlot: "a", extensionVersion: "0.3.0", placedAt: fixture.now.toISOString() });
  });

  it("leaves no temp name behind", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    const names = (await fixture.fileSystem.listDirectory(fixture.programFolder) ?? []).map((entry) => entry.name).sort();
    expect(names).toEqual(["extension", "host-a", "integration-state.json", "org.maginalia.collector.json"]);
    const slot = (await fixture.fileSystem.listDirectory(p(fixture, "host-a")) ?? []).map((entry) => entry.name);
    expect(slot.every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("orders the side effects: slot, extension, manifest, registry, state", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    const log = writesTo(fixture);
    const index = (needle: string): number => log.findIndex((entry) => entry.includes(needle));
    const lastIndex = (needle: string): number => log.map((entry, at) => (entry.includes(needle) ? at : -1)).filter((at) => at >= 0).pop() ?? -1;
    expect(index("host-a\\maginalia-collector-host.exe")).toBeGreaterThan(-1);
    expect(lastIndex("host-a\\")).toBeLessThan(index("extension.next"));
    expect(lastIndex("extension.next")).toBeLessThan(index("-> c:\\users\\tester\\appdata\\local\\programs\\maginalia collector\\org.maginalia.collector.json"));
    const manifestRename = log.findIndex((entry) => entry.startsWith("rename-file") && entry.endsWith("org.maginalia.collector.json"));
    const stateRename = log.findIndex((entry) => entry.startsWith("rename-file") && entry.endsWith("integration-state.json"));
    expect(manifestRename).toBeGreaterThan(-1);
    expect(stateRename).toBeGreaterThan(manifestRename);
  });

  it("registers only after the manifest is on disk, and the state file comes after the registry write", async () => {
    const fixture = createApplyFixture();
    const seen: string[] = [];
    const original = fixture.registry.registerCollectorHost.bind(fixture.registry);
    fixture.registry.registerCollectorHost = () => {
      seen.push(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json")) ? "manifest-present" : "manifest-absent");
      seen.push(fixture.fileSystem.has(p(fixture, "integration-state.json")) ? "state-present" : "state-absent");
      seen.push(fixture.fileSystem.has(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME)) ? "slot-present" : "slot-absent");
      return original();
    };
    await run(fixture, { action: "setup" });
    expect(seen).toEqual(["manifest-present", "state-absent", "slot-present"]);
  });

  it("calls register exactly once and reads the registration back", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    expect(fixture.registry.calls.filter((call) => call === "registerCollectorHost")).toHaveLength(1);
    expect(fixture.registry.calls.filter((call) => call === "replaceForeignCollectorHostRegistration")).toHaveLength(0);
    const registerAt = fixture.registry.calls.indexOf("registerCollectorHost");
    expect(fixture.registry.calls.slice(registerAt + 1)).toContain("readCollectorHostRegistration");
  });

  it("creates the Programs parent and the program folder with the private-DACL helper", async () => {
    const fixture = createApplyFixture({ programsExists: false });
    const result = await run(fixture, { action: "setup" });
    expect(result.outcome).toBe("applied");
    expect(fixture.fileSystem.privateDirectories).toContain(fakeKey(fixture.userProgramFiles));
    expect(fixture.fileSystem.privateDirectories).toContain(fakeKey(fixture.programFolder));
  });

  it("does not re-create an existing Programs parent", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.privateDirectories).not.toContain(fakeKey(fixture.userProgramFiles));
    expect(fixture.fileSystem.privateDirectories).toContain(fakeKey(fixture.programFolder));
  });

  it("checks the program folder and both parents with the ACL helper", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    const checked = fixture.securityCalls.map(fakeKey);
    expect(checked).toContain(fakeKey(fixture.userProgramFiles));
    expect(checked).toContain(fakeKey(path.win32.dirname(fixture.userProgramFiles)));
    expect(checked).toContain(fakeKey(fixture.programFolder));
  });

  it("creates the integration folder (and the application root) with the private-DACL helper", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.privateDirectories).toContain(fakeKey(fixture.applicationRoot));
    expect(fixture.fileSystem.privateDirectories).toContain(fakeKey(fixture.integrationDirectory));
  });

  it("never re-creates an existing integration folder", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.integrationDirectory);
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.privateDirectories).not.toContain(fakeKey(fixture.integrationDirectory));
    expect(fixture.fileSystem.privateDirectories).not.toContain(fakeKey(fixture.applicationRoot));
  });

  it("self-checks the exact executable the manifest names, with the allowed origin", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    expect(fixture.selfChecks).toEqual([{ executablePath: p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), allowedOrigin: "chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/" }]);
  });

  it("a second setup is a no-op that writes nothing and returns ready", async () => {
    const fixture = await installed(createApplyFixture());
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "noop", state: "ready", reason: null });
    expect(writesTo(fixture)).toEqual([]);
    expect(registryWrites(fixture)).toEqual([]);
    expect(fixture.selfChecks).toHaveLength(1);
  });

  it("repair and refresh on a ready installation are no-ops too", async () => {
    const fixture = await installed(createApplyFixture());
    expect((await run(fixture, { action: "repair" })).outcome).toBe("noop");
    expect((await run(fixture, { action: "refresh" })).outcome).toBe("noop");
    expect(writesTo(fixture)).toEqual([]);
  });

  it("changes nothing outside the program folder, Programs, and the integration folders", async () => {
    const fixture = createApplyFixture();
    const before = fixture.fileSystem.snapshot();
    await run(fixture, { action: "setup" });
    const allowed = [fakeKey(fixture.programFolder), fakeKey(fixture.applicationRoot)];
    for (const [key, value] of fixture.fileSystem.snapshot()) {
      if (allowed.some((root) => key === root || key.startsWith(`${root}\\`))) continue;
      expect(before.get(key)).toBe(value);
    }
  });

  it("the result carries no absolute path except the extension display folder", async () => {
    const fixture = createApplyFixture();
    const result = await run(fixture, { action: "setup" });
    const copy = JSON.parse(JSON.stringify(result)) as { inspection: Record<string, unknown> };
    expect(copy.inspection.extensionFolderDisplay).toBe(p(fixture, "extension"));
    delete copy.inspection.extensionFolderDisplay;
    expect(JSON.stringify(copy)).not.toMatch(/[A-Za-z]:\\|tester|Users/u);
  });
});

describe("preconditions (refuse, write nothing)", () => {
  const writers: ReadonlyArray<CollectorApplyRequest["action"]> = ["setup", "repair", "refresh", "remove"];

  it.each(writers)("e2eIsolationActive refuses %s without any write or registry call", async (action) => {
    const fixture = createApplyFixture();
    fixture.isolated = true;
    const result = await run(fixture, { action });
    expect(result).toMatchObject({ outcome: "refused", reason: "e2e-isolation" });
    expect(writesTo(fixture)).toEqual([]);
    expect(registryWrites(fixture)).toEqual([]);
    expect(result.inspection.writesAllowed).toBe(false);
  });

  it.each(writers)("e2e isolation refuses %s even on a ready installation", async (action) => {
    const fixture = await installed(createApplyFixture());
    fixture.isolated = true;
    expect((await run(fixture, { action })).reason).toBe("e2e-isolation");
    expect(writesTo(fixture)).toEqual([]);
  });

  it.each([
    ["user-level hosts disabled", { nativeMessagingUserLevelHosts: 0 }],
    ["host blocklisted by name", { nativeMessagingBlocklist: ["org.maginalia.collector"] }],
    ["everything blocklisted", { nativeMessagingBlocklist: ["*"] }],
  ])("policy-blocked (%s) refuses setup, repair and refresh and writes nothing", async (_name, hive) => {
    for (const action of ["setup", "repair", "refresh"] as const) {
      const fixture = createApplyFixture();
      fixture.registry.policies = { hkcu: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"), ...hive }, hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM") };
      const result = await run(fixture, { action });
      expect(result).toMatchObject({ outcome: "refused", reason: "policy-blocked", state: "policy-blocked" });
      expect(writesTo(fixture)).toEqual([]);
      expect(registryWrites(fixture)).toEqual([]);
    }
  });

  it("a policy that appears between the inspection and the first write stops the action", async () => {
    const fixture = createApplyFixture();
    let reads = 0;
    const original = fixture.registry.readChromePolicies.bind(fixture.registry);
    fixture.registry.readChromePolicies = () => {
      reads += 1;
      if (reads > 1) return { hkcu: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"), nativeMessagingUserLevelHosts: 0 }, hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM") };
      return original();
    };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "policy-blocked" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it.each(["setup", "repair"] as const)("%s over a foreign registration without confirmation is refused", async (action) => {
    const fixture = createApplyFixture();
    fixture.registry.registration = "foreign";
    const result = await run(fixture, { action });
    expect(result).toMatchObject({ outcome: "refused", reason: "foreign-confirmation-required", state: "foreign-registration" });
    expect(writesTo(fixture)).toEqual([]);
    expect(registryWrites(fixture)).toEqual([]);
    expect(fixture.registry.registration).toBe("foreign");
  });

  it.each(["setup", "repair"] as const)("%s with confirmReplaceForeign:false is refused", async (action) => {
    const fixture = createApplyFixture();
    fixture.registry.registration = "foreign";
    expect((await run(fixture, { action, confirmReplaceForeign: false })).reason).toBe("foreign-confirmation-required");
  });

  it.each(["setup", "repair"] as const)("%s with confirmation replaces the foreign value (never plain register)", async (action) => {
    const fixture = createApplyFixture();
    fixture.registry.registration = "foreign";
    const result = await run(fixture, { action, confirmReplaceForeign: true });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(fixture.registry.calls).toContain("replaceForeignCollectorHostRegistration");
    expect(fixture.registry.calls).not.toContain("registerCollectorHost");
  });

  it("refresh never replaces a foreign registration", async () => {
    const fixture = createApplyFixture();
    fixture.registry.registration = "foreign";
    const result = await run(fixture, { action: "refresh" });
    expect(result.outcome).toBe("refused");
    expect(registryWrites(fixture)).toEqual([]);
  });

  it("confirmation is ignored when there is nothing foreign: plain register is used", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup", confirmReplaceForeign: true });
    expect(fixture.registry.calls).toContain("registerCollectorHost");
    expect(fixture.registry.calls).not.toContain("replaceForeignCollectorHostRegistration");
  });

  it("a registration that turns foreign after the inspection stops before the manifest switch", async () => {
    const fixture = createApplyFixture();
    const original = fixture.fileSystem.renameDirectory.bind(fixture.fileSystem);
    fixture.fileSystem.renameDirectory = async (from, to) => {
      await original(from, to);
      fixture.registry.registration = "foreign"; // another program wrote the key mid-run
    };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registration-changed" });
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
    expect(registryWrites(fixture)).toEqual([]);
  });

  type Matrix = [CollectorApplyRequest["action"], string, boolean];
  it.each<Matrix>([
    ["setup", "registration-missing", false],
    ["setup", "damaged", false],
    ["setup", "outdated", false],
    ["repair", "not-set-up", false],
    ["repair", "outdated", false],
    ["refresh", "not-set-up", false],
    ["refresh", "damaged", false],
    ["refresh", "registration-missing", false],
  ])("%s from %s is refused as wrong-state", async (action, state) => {
    const fixture = createApplyFixture();
    if (state === "registration-missing") {
      await installed(fixture);
      fixture.registry.registration = "absent";
    } else if (state === "damaged") {
      await installed(fixture);
      fixture.fileSystem.remove(p(fixture, "org.maginalia.collector.json"));
    } else if (state === "outdated") {
      await outdated(fixture);
    }
    fixture.fileSystem.mutations.length = 0;
    const result = await run(fixture, { action });
    expect(result).toMatchObject({ outcome: "refused", reason: "wrong-state", state });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses when the inspection cannot finish (known folder unavailable)", async () => {
    const fixture = createApplyFixture();
    fixture.registry.failNext.getKnownFolderPath = new Error("injected");
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "inspection-incomplete" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses when the registry cannot be read", async () => {
    const fixture = createApplyFixture();
    fixture.registry.failNext.readCollectorHostRegistration = new Error("injected");
    expect((await run(fixture, { action: "setup" })).reason).toBe("inspection-incomplete");
  });

  it.each([
    ["unavailable", () => { throw new Error("no descriptor"); }],
    ["invalid", () => ({ version: 1 })],
  ])("refuses with payload-unavailable when the descriptor is %s", async (_label, make) => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.remove(p(fixture, "org.maginalia.collector.json"));
    const deps = { ...fixture.deps, readPayloadDescriptor: async () => make() };
    const result = await applyCollectorIntegration({ action: "repair" }, deps);
    expect(result).toMatchObject({ outcome: "refused", reason: "payload-unavailable" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses when the packaged source folders are not local absolute paths", async () => {
    const fixture = createApplyFixture();
    const deps = { ...fixture.deps, payloadSource: { hostFolder: "relative\\host", extensionFolder: SOURCE_EXTENSION_FOLDER } };
    expect((await applyCollectorIntegration({ action: "setup" }, deps)).reason).toBe("payload-unavailable");
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses an existing program folder that fails the ACL check, without re-permissioning it", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.programFolder);
    fixture.securityFacts.set(fakeKey(fixture.programFolder), { ...safeFacts(true), ownerSid: "S-1-5-21-9-9-9-1" } as never);
    const result = await run(fixture, { action: "setup" });
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("program-folder-unsafe");
    expect(writesTo(fixture)).toEqual([]);
    expect(fixture.fileSystem.privateDirectories).toEqual([]);
  });

  it("refuses when the ACL inspection itself throws", async () => {
    const fixture = createApplyFixture();
    fixture.securityFacts.set(fakeKey(fixture.userProgramFiles), "throw");
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "program-folder-unsafe" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses when the Programs parent fails the ACL check", async () => {
    const fixture = createApplyFixture();
    fixture.securityFacts.set(fakeKey(fixture.userProgramFiles), { ...safeFacts(true), aces: [{ type: "allow", sid: "S-1-1-0", mask: 0x1f01ff, inheritOnly: false }] } as never);
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "program-folder-unsafe" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses when the grand-parent (LocalAppData) fails the ACL check", async () => {
    const fixture = createApplyFixture();
    fixture.securityFacts.set(fakeKey(path.win32.dirname(fixture.userProgramFiles)), { ...safeFacts(true), isReparsePoint: true } as never);
    expect((await run(fixture, { action: "setup" })).reason).toBe("program-folder-unsafe");
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses a program folder that is a reparse point and writes through nothing", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.programFolder, { reparse: true });
    const result = await run(fixture, { action: "setup" });
    expect(result.outcome).toBe("refused");
    expect(writesTo(fixture)).toEqual([]);
  });

  it("refuses a Programs folder that is a reparse point", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.setReparse(fixture.userProgramFiles, true);
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "program-folder-unsafe" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("repair refuses when an entry inside the folder is a reparse point", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.setReparse(p(fixture, "extension"), true);
    const result = await run(fixture, { action: "repair" });
    expect(result).toMatchObject({ outcome: "refused", reason: "reparse-point-found" });
    expect(writesTo(fixture)).toEqual([]);
  });

  it("repair refuses an unsafe program folder reported by the inspection", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.securityFacts.set(fakeKey(fixture.programFolder), { ...safeFacts(true), daclPresent: false } as never);
    const result = await run(fixture, { action: "repair" });
    expect(result).toMatchObject({ outcome: "refused", reason: "program-folder-unsafe" });
    expect(writesTo(fixture)).toEqual([]);
  });
});

describe("Host slots (design 8.3)", () => {
  it("alternates slots on refresh and prunes the previous one", async () => {
    const fixture = await outdated(createApplyFixture());
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.inspection.installed.activeSlot).toBe("b");
    expect(fixture.fileSystem.has(p(fixture, "host-a"))).toBe(false);
    expect(fixture.fileSystem.text(p(fixture, "host-b", COLLECTOR_HOST_EXECUTABLE_NAME))).toBe("host-executable-bytes-v2");
  });

  it("goes back to slot a on the following refresh", async () => {
    const fixture = await outdated(createApplyFixture());
    await run(fixture, { action: "refresh" });
    fixture.fileSystem.setBytes(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), "host-executable-bytes-v3");
    fixture.payload = applyDescriptor({ payloadId: "1.4.0+aaa0001", hostVersion: "1.4.0", extensionVersion: "0.4.0", host: { ...HOST_SOURCE_FILES, [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes-v3" } });
    const result = await run(fixture, { action: "refresh" });
    expect(result.inspection.installed.activeSlot).toBe("a");
    expect(fixture.fileSystem.has(p(fixture, "host-b"))).toBe(false);
  });

  it("a locked file in the previous slot is a warning, not an error", async () => {
    const fixture = await outdated(createApplyFixture());
    fixture.fileSystem.lock(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME));
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.warnings).toContain("previous-slot-retained");
    expect(fixture.fileSystem.has(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME))).toBe(true);
  });

  it("a locked file in the target slot leaves the previous state unchanged (file-locked)", async () => {
    const fixture = await outdated(createApplyFixture());
    // The slot that would be written (b) holds a stale, running Host.
    fixture.fileSystem.addFile(p(fixture, "host-b", COLLECTOR_HOST_EXECUTABLE_NAME), "stale");
    fixture.fileSystem.lock(p(fixture, "host-b", COLLECTOR_HOST_EXECUTABLE_NAME));
    const beforeManifest = fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json"));
    const beforeState = fixture.fileSystem.text(p(fixture, "integration-state.json"));
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "failed", reason: "file-locked", state: "outdated" });
    expect(fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json"))).toBe(beforeManifest);
    expect(fixture.fileSystem.text(p(fixture, "integration-state.json"))).toBe(beforeState);
    expect(registryWrites(fixture)).toEqual([]);
  });

  it("clears stale files in the target slot before writing", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addFile(p(fixture, "host-a", "left-over.dll"), "stale");
    // no state file, no manifest: slot a is the default target
    const result = await run(fixture, { action: "setup" });
    expect(result.outcome).toBe("applied");
    expect(fixture.fileSystem.has(p(fixture, "host-a", "left-over.dll"))).toBe(false);
  });

  it("aborts when the target slot is a reparse point and writes nothing through it", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(p(fixture, "host-a"), { reparse: true });
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "reparse-point-found" });
    expect(writesTo(fixture).filter((entry) => entry.includes("host-a"))).toEqual([]);
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });

  it("aborts when the target slot contains a reparse entry or a sub-directory", async () => {
    for (const reparse of [true, false]) {
      const fixture = createApplyFixture();
      fixture.fileSystem.addDirectory(p(fixture, "host-a", "sub"), { reparse });
      expect((await run(fixture, { action: "setup" })).reason).toBe("reparse-point-found");
    }
  });

  it.each([COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME, ...COLLECTOR_HOST_LICENSE_FILES])("refuses a source that changes during the copy of %s (TOCTOU)", async (name) => {
    const fixture = createApplyFixture();
    fixture.fileSystem.onCopy = (source) => source.endsWith(name);
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "source-changed" });
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
    expect(registryWrites(fixture)).toEqual([]);
  });

  it("removes the temp copy when the source changed", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.onCopy = () => true;
    await run(fixture, { action: "setup" });
    const names = (await fixture.fileSystem.listDirectory(p(fixture, "host-a")) ?? []).map((entry) => entry.name);
    expect(names).toEqual([]);
  });

  it("refuses a source whose hash differs from the compiled descriptor", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.setBytes(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), "tampered");
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "hash-mismatch" });
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });

  it("refuses when the written file is corrupted after the copy (re-read hash)", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.afterCopy = (destination) => {
      if (destination.includes(COLLECTOR_HOST_ADDON_NAME)) fixture.fileSystem.setBytes(destination, "bit rot");
    };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "hash-mismatch" });
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });

  it("refuses when a missing packaged source file is reported", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.remove(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_ADDON_NAME));
    expect((await run(fixture, { action: "setup" })).reason).toBe("payload-unavailable");
  });

  it("refuses a packaged source that is a link", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.setReparse(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), true);
    const result = await run(fixture, { action: "setup" });
    expect(result.outcome).toBe("failed");
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });

  it("temp names are exclusive-create names inside the slot", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    const temps = fixture.fileSystem.mutations.filter((entry) => entry.startsWith("copy ") && entry.includes("host-a"));
    expect(temps.length).toBe(5);
    expect(temps.every((entry) => /\.[0-9a-f]{16}\.tmp$/u.test(entry))).toBe(true);
  });

  it("an invalid random suffix aborts instead of writing", async () => {
    const fixture = createApplyFixture();
    const deps = { ...fixture.deps, randomSuffix: () => "../../x" };
    const result = await applyCollectorIntegration({ action: "setup" }, deps);
    expect(result.outcome).toBe("failed");
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });
});

describe("extension folder (design 4.5, 6.4)", () => {
  it("verifies every descriptor file and keeps nested names", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    for (const [name, content] of Object.entries(extensionSourceFiles())) {
      expect(fixture.fileSystem.text(p(fixture, "extension", ...name.split("/")))).toBe(content);
    }
  });

  it("swaps through extension.next and keeps the previous folder until the swap succeeded", async () => {
    const fixture = await outdated(createApplyFixture());
    await run(fixture, { action: "refresh" });
    const renames = fixture.fileSystem.mutations.filter((entry) => entry.startsWith("rename-dir"));
    expect(renames).toEqual([
      expect.stringContaining("extension -> "),
      expect.stringContaining("extension.next -> "),
    ]);
    expect(renames[0]).toContain("extension.prev");
    expect(fixture.fileSystem.has(p(fixture, "extension.prev"))).toBe(false);
    expect(JSON.parse(fixture.fileSystem.text(p(fixture, "extension", "manifest.json"))).version).toBe("0.4.0");
  });

  it("refuses an extension whose manifest key derives to another ID", async () => {
    const fixture = createApplyFixture();
    const files = { ...extensionSourceFiles(), "manifest.json": JSON.stringify({ manifest_version: 3, version: "0.3.0", key: Buffer.from("other key").toString("base64") }) };
    fixture.payload = applyDescriptor({ extension: files });
    fixture.fileSystem.addFile(path.win32.join(SOURCE_EXTENSION_FOLDER, "manifest.json"), files["manifest.json"]);
    fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, "manifest.json"), files["manifest.json"]);
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "extension-verification-failed" });
    expect(fixture.fileSystem.has(p(fixture, "extension"))).toBe(false);
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });

  it.each([
    ["no key", { manifest_version: 3, version: "0.3.0" }],
    ["version differs from the descriptor", { manifest_version: 3, version: "9.9.9", key: COLLECTOR_TEST_KEY }],
    ["not an object", [1, 2]],
  ])("refuses an extension manifest with %s", async (_label, manifest) => {
    const fixture = createApplyFixture();
    const text = JSON.stringify(manifest);
    fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, "manifest.json"), text);
    fixture.payload = applyDescriptor({ extension: { ...extensionSourceFiles(), "manifest.json": text } });
    expect((await run(fixture, { action: "setup" })).reason).toBe("extension-verification-failed");
  });

  it("refuses an extension manifest that is not valid JSON", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, "manifest.json"), "{nope");
    fixture.payload = applyDescriptor({ extension: { ...extensionSourceFiles(), "manifest.json": "{nope" } });
    expect((await run(fixture, { action: "setup" })).reason).toBe("extension-verification-failed");
  });

  it("refuses an extension file whose hash differs from the descriptor", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, "service-worker.js"), "evil();");
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "hash-mismatch" });
    expect(fixture.fileSystem.has(p(fixture, "extension"))).toBe(false);
  });

  it("refuses an extension source file that changes during the copy", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.onCopy = (source) => source.endsWith("service-worker.js");
    expect((await run(fixture, { action: "setup" })).reason).toBe("source-changed");
  });

  it("a locked extension folder leaves the previous complete folder and the state untouched", async () => {
    const fixture = await outdated(createApplyFixture());
    fixture.fileSystem.lock(p(fixture, "extension"));
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "failed", reason: "file-locked" });
    expect(JSON.parse(fixture.fileSystem.text(p(fixture, "extension", "manifest.json"))).version).toBe("0.3.0");
    expect(fixture.fileSystem.has(p(fixture, "extension", "pages", "onboarding.html"))).toBe(true);
    expect(fixture.fileSystem.text(p(fixture, "integration-state.json"))).toContain("1.2.0+abc1234");
    expect(result.state).toBe("outdated");
  });

  it("restores the previous folder when the second rename fails", async () => {
    const fixture = await outdated(createApplyFixture());
    const original = fixture.fileSystem.renameDirectory.bind(fixture.fileSystem);
    let calls = 0;
    fixture.fileSystem.renameDirectory = async (from, to) => {
      calls += 1;
      if (calls === 2) throw new CollectorFileSystemError("locked");
      await original(from, to);
    };
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "failed", reason: "file-locked" });
    expect(fixture.fileSystem.has(p(fixture, "extension", "manifest.json"))).toBe(true);
    expect(JSON.parse(fixture.fileSystem.text(p(fixture, "extension", "manifest.json"))).version).toBe("0.3.0");
    expect(fixture.fileSystem.has(p(fixture, "extension.prev"))).toBe(false);
  });

  it("an interrupted swap (extension missing, extension.prev present) is restored first", async () => {
    const fixture = await outdated(createApplyFixture());
    const original = fixture.fileSystem.renameDirectory.bind(fixture.fileSystem);
    let calls = 0;
    fixture.fileSystem.renameDirectory = async (from, to) => {
      calls += 1;
      if (calls >= 2) throw new CollectorFileSystemError("failed"); // the process died after the first rename; restore also fails
      await original(from, to);
    };
    await run(fixture, { action: "refresh" });
    expect(fixture.fileSystem.has(p(fixture, "extension"))).toBe(false);
    expect(fixture.fileSystem.has(p(fixture, "extension.prev"))).toBe(true);
    fixture.fileSystem.renameDirectory = original;
    const inspection = await inspectCollectorIntegration(fixture.deps);
    expect(inspection.state).toBe("damaged");
    expect(inspection.reasons).toContain("extension-folder-missing");
    const repaired = await run(fixture, { action: "repair" });
    expect(repaired).toMatchObject({ outcome: "applied", state: "ready" });
    expect(fixture.fileSystem.has(p(fixture, "extension.prev"))).toBe(false);
  });

  it("removes a stale extension.next and a stale extension.prev before staging", async () => {
    const fixture = await outdated(createApplyFixture());
    fixture.fileSystem.addFile(p(fixture, "extension.next", "junk.txt"), "junk");
    fixture.fileSystem.addFile(p(fixture, "extension.prev", "old.txt"), "old");
    const result = await run(fixture, { action: "refresh" });
    expect(result.outcome).toBe("applied");
    expect(fixture.fileSystem.has(p(fixture, "extension.next"))).toBe(false);
    expect(fixture.fileSystem.has(p(fixture, "extension.prev"))).toBe(false);
  });

  it("aborts when the current extension folder is a reparse point", async () => {
    const fixture = await outdated(createApplyFixture());
    fixture.fileSystem.setReparse(p(fixture, "extension"), true);
    const result = await run(fixture, { action: "refresh" });
    expect(["refused", "failed"]).toContain(result.outcome);
    expect(fixture.fileSystem.mutations.filter((entry) => entry.includes("extension.prev"))).toEqual([]);
  });

  it("aborts when extension.next is a reparse point", async () => {
    const fixture = await outdated(createApplyFixture());
    fixture.fileSystem.addDirectory(p(fixture, "extension.next"), { reparse: true });
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "failed", reason: "reparse-point-found" });
  });

  it("a locked extension.prev after a successful swap is a warning", async () => {
    const fixture = await outdated(createApplyFixture());
    fixture.fileSystem.lock(p(fixture, "extension.prev"));
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.warnings).toContain("previous-extension-retained");
  });
});

describe("registry and read-back (design 3.3)", () => {
  it("access-denied keeps the files, writes the state, reports registration-missing", async () => {
    const fixture = createApplyFixture();
    fixture.registry.nextRegisterOutcome = "access-denied";
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-write-denied", state: "registration-missing", selfCheck: "skipped" });
    expect(fixture.fileSystem.has(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME))).toBe(true);
    expect(fixture.selfChecks).toEqual([]);
  });

  it("a failed registry write is reported the same way", async () => {
    const fixture = createApplyFixture();
    fixture.registry.nextRegisterOutcome = "failed";
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ reason: "registry-write-failed", state: "registration-missing" });
  });

  it("a throwing registry adapter is a failed write", async () => {
    const fixture = createApplyFixture();
    fixture.registry.failNext.registerCollectorHost = new Error("C:\\secret path");
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-write-failed", state: "registration-missing" });
    expect(JSON.stringify({ ...result, inspection: undefined })).not.toContain("secret");
  });

  it("registry-write-denied is recoverable: repair registers and reaches ready", async () => {
    const fixture = createApplyFixture();
    fixture.registry.nextRegisterOutcome = "access-denied";
    await run(fixture, { action: "setup" });
    const repaired = await run(fixture, { action: "repair" });
    expect(repaired).toMatchObject({ outcome: "applied", state: "ready" });
  });

  it("a register call that loses a race to a foreign writer fails with registration-changed", async () => {
    const fixture = createApplyFixture();
    fixture.registry.nextRegisterOutcome = "foreign";
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registration-changed" });
    expect(fixture.fileSystem.has(p(fixture, "integration-state.json"))).toBe(false);
  });

  it("a registration that does not read back as ours fails and writes no state file", async () => {
    const fixture = createApplyFixture();
    fixture.registry.registerCollectorHost = () => "ok"; // claims success, writes nothing
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-readback-mismatch" });
    expect(fixture.fileSystem.has(p(fixture, "integration-state.json"))).toBe(false);
    expect(result.state).toBe("not-set-up");
    expect(fixture.selfChecks).toEqual([]);
  });

  it("a read-back mismatch is recoverable by a fresh setup", async () => {
    const fixture = createApplyFixture();
    const original = fixture.registry.registerCollectorHost.bind(fixture.registry);
    fixture.registry.registerCollectorHost = () => "ok";
    await run(fixture, { action: "setup" });
    fixture.registry.registerCollectorHost = original;
    expect(await run(fixture, { action: "setup" })).toMatchObject({ outcome: "applied", state: "ready" });
  });

  it("a read-back that throws counts as a mismatch", async () => {
    const fixture = createApplyFixture();
    const original = fixture.registry.registerCollectorHost.bind(fixture.registry);
    fixture.registry.registerCollectorHost = () => {
      const outcome = original();
      fixture.registry.failNext.readCollectorHostRegistration = new Error("injected");
      return outcome;
    };
    expect((await run(fixture, { action: "setup" })).reason).toBe("registry-readback-mismatch");
  });

  it("a refresh keeps the registry value and never writes to the registry", async () => {
    const fixture = await outdated(createApplyFixture());
    await run(fixture, { action: "refresh" });
    expect(registryWrites(fixture)).toEqual([]);
  });

  it("a refresh whose registration stops being ours fails before the state is written", async () => {
    const fixture = await outdated(createApplyFixture());
    const original = fixture.fileSystem.renameFile.bind(fixture.fileSystem);
    fixture.fileSystem.renameFile = async (from, to, options) => {
      await original(from, to, options);
      if (to.endsWith("org.maginalia.collector.json")) fixture.registry.registration = "absent";
    };
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-readback-mismatch" });
    expect(fixture.fileSystem.text(p(fixture, "integration-state.json"))).toContain("1.2.0+abc1234");
  });
});

describe("self-check (design 3.5, 4.3)", () => {
  it("a failed health keeps the files and the registration, reports damaged", async () => {
    const fixture = createApplyFixture();
    fixture.selfCheckResult = { status: "failed" };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "self-check-failed", state: "damaged", selfCheck: "failed" });
    expect(fixture.registry.registration).toBe("ours");
    expect(fixture.fileSystem.has(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME))).toBe(true);
    expect(result.inspection.state).toBe("ready");
  });

  it("a throwing runner is a failed self-check", async () => {
    const fixture = createApplyFixture();
    fixture.selfCheckResult = "throw";
    expect(await run(fixture, { action: "setup" })).toMatchObject({ reason: "self-check-failed", state: "damaged" });
  });

  it("a different protocol is a failed self-check", async () => {
    const fixture = createApplyFixture();
    fixture.selfCheckResult = { status: "ok", protocol: "maginalia.collector.experimental.v2" };
    expect((await run(fixture, { action: "setup" })).reason).toBe("self-check-failed");
  });

  it("a different Host version is a failed self-check; a matching one passes", async () => {
    const wrong = createApplyFixture();
    wrong.selfCheckResult = { status: "ok", protocol: COLLECTOR_PROTOCOL, hostVersion: "0.0.1" };
    expect((await run(wrong, { action: "setup" })).reason).toBe("self-check-failed");
    const right = createApplyFixture();
    right.selfCheckResult = { status: "ok", protocol: COLLECTOR_PROTOCOL, hostVersion: "1.2.0" };
    expect((await run(right, { action: "setup" })).selfCheck).toBe("ok");
  });

  it("the absolute manifest form is resolved the way Chrome would", async () => {
    const fixture = createApplyFixture();
    const result = await run(fixture, { action: "setup" });
    fixture.fileSystem.setBytes(p(fixture, "org.maginalia.collector.json"), JSON.stringify({ ...expectedHostManifest("a"), path: p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME) }));
    expect(result.selfCheck).toBe("ok");
    expect((await inspectCollectorIntegration(fixture.deps)).state).toBe("ready");
  });

  it("the state after a failed self-check is repairable by a fresh run of the check only through repair when damaged for real", async () => {
    const fixture = createApplyFixture();
    fixture.selfCheckResult = { status: "failed" };
    await run(fixture, { action: "setup" });
    fixture.selfCheckResult = { status: "ok", protocol: COLLECTOR_PROTOCOL };
    const again = await run(fixture, { action: "setup" });
    expect(again.outcome).toBe("noop"); // files are fine; the caller re-runs the check separately
  });
});

describe("repair", () => {
  const damage: ReadonlyArray<readonly [string, (fixture: ApplyFixture) => void, string]> = [
    ["a missing manifest", (f) => f.fileSystem.remove(p(f, "org.maginalia.collector.json")), "damaged"],
    ["a manifest for the wrong slot", (f) => f.fileSystem.setBytes(p(f, "org.maginalia.collector.json"), JSON.stringify(expectedHostManifest("b"))), "damaged"],
    ["an invalid manifest", (f) => f.fileSystem.setBytes(p(f, "org.maginalia.collector.json"), "{"), "damaged"],
    ["a missing state file", (f) => f.fileSystem.remove(p(f, "integration-state.json")), "damaged"],
    ["a corrupted state file", (f) => f.fileSystem.setBytes(p(f, "integration-state.json"), "nope"), "damaged"],
    ["a tampered Host executable", (f) => f.fileSystem.setBytes(p(f, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), "tampered"), "damaged"],
    ["a missing addon", (f) => f.fileSystem.remove(p(f, "host-a", COLLECTOR_HOST_ADDON_NAME)), "damaged"],
    ["a missing slot", (f) => { for (const name of [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME, ...COLLECTOR_HOST_LICENSE_FILES]) f.fileSystem.remove(p(f, "host-a", name)); f.fileSystem.remove(p(f, "host-a")); }, "damaged"],
    ["a tampered extension file", (f) => f.fileSystem.setBytes(p(f, "extension", "service-worker.js"), "evil"), "damaged"],
    ["a missing extension file", (f) => f.fileSystem.remove(p(f, "extension", "pages", "onboarding.html")), "damaged"],
    ["a missing extension folder", (f) => { for (const name of Object.keys(extensionSourceFiles())) f.fileSystem.remove(p(f, "extension", ...name.split("/"))); f.fileSystem.remove(p(f, "extension", "pages")); f.fileSystem.remove(p(f, "extension")); }, "damaged"],
    ["a missing registration", (f) => { f.registry.registration = "absent"; }, "registration-missing"],
  ];

  it.each(damage)("repairs %s deterministically", async (_label, harm, state) => {
    const fixture = await installed(createApplyFixture());
    harm(fixture);
    expect((await inspectCollectorIntegration(fixture.deps)).state).toBe(state);
    const result = await run(fixture, { action: "repair" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready", reason: null });
    expect((await inspectCollectorIntegration(fixture.deps)).filesVerified).toBe(true);
  });

  it("repair of a missing registration registers again and reads it back", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.registration = "absent";
    await run(fixture, { action: "repair" });
    expect(fixture.registry.calls).toContain("registerCollectorHost");
  });

  it("repair writes the slot that is NOT the damaged active one", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.setBytes(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), "tampered");
    const result = await run(fixture, { action: "repair" });
    expect(result.inspection.installed.activeSlot).toBe("b");
  });

  it("repair never touches the Shelf-side integration folder content", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(path.win32.join(fixture.integrationDirectory, "private-shelf-binding.json"), "{}");
    fixture.fileSystem.remove(p(fixture, "org.maginalia.collector.json"));
    const before = fixture.fileSystem.text(path.win32.join(fixture.integrationDirectory, "private-shelf-binding.json"));
    await run(fixture, { action: "repair" });
    expect(fixture.fileSystem.text(path.win32.join(fixture.integrationDirectory, "private-shelf-binding.json"))).toBe(before);
  });

  it("repair over a foreign registration with confirmation reaches ready", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.registration = "foreign";
    const result = await run(fixture, { action: "repair", confirmReplaceForeign: true });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
  });
});

describe("refresh (design 6, Q3)", () => {
  it("brings an outdated installation to the compiled payload without touching the registry", async () => {
    const fixture = await outdated(createApplyFixture());
    expect((await inspectCollectorIntegration(fixture.deps)).state).toBe("outdated");
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready", selfCheck: "ok" });
    expect(result.inspection.installed).toMatchObject({ payloadId: "1.3.0+def5678", extensionVersion: "0.4.0", activeSlot: "b" });
    expect(registryWrites(fixture)).toEqual([]);
  });

  it("the old Host keeps working until the manifest switch (old slot untouched before it)", async () => {
    const fixture = await outdated(createApplyFixture());
    const oldExe = fixture.fileSystem.text(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME));
    const log = fixture.fileSystem.mutations;
    await run(fixture, { action: "refresh" });
    const manifestSwitch = log.findIndex((entry) => entry.startsWith("rename-file") && entry.endsWith("org.maginalia.collector.json"));
    expect(log.slice(0, manifestSwitch).some((entry) => entry.includes("host-a"))).toBe(false);
    expect(oldExe).toBe("host-executable-bytes");
  });

  it("does not run for a foreign registration, a missing registration or damage", async () => {
    for (const harm of [
      (f: ApplyFixture) => { f.registry.registration = "foreign"; },
      (f: ApplyFixture) => { f.registry.registration = "absent"; },
      (f: ApplyFixture) => f.fileSystem.remove(p(f, "integration-state.json")),
    ]) {
      const fixture = await outdated(createApplyFixture());
      harm(fixture);
      fixture.fileSystem.mutations.length = 0;
      expect((await run(fixture, { action: "refresh" })).outcome).toBe("refused");
      expect(writesTo(fixture)).toEqual([]);
    }
  });
});

describe("standalone migration (design 2.5)", () => {
  it("reports standalone-leftover and leaves the old folder and its files alone", async () => {
    const fixture = createApplyFixture();
    const standalone = path.win32.join(fixture.userProgramFiles, "MAGINALIA Collector Host");
    fixture.fileSystem.addFile(path.win32.join(standalone, "MAGINALIA-Collector-Host.exe"), "old host");
    fixture.fileSystem.addFile(path.win32.join(standalone, "uninstall.exe"), "uninstaller");
    fixture.registry.registration = "foreign";
    const result = await run(fixture, { action: "setup", confirmReplaceForeign: true });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.warnings).toContain("standalone-leftover");
    expect(fixture.fileSystem.text(path.win32.join(standalone, "MAGINALIA-Collector-Host.exe"))).toBe("old host");
    expect(fixture.fileSystem.has(path.win32.join(standalone, "uninstall.exe"))).toBe(true);
    expect(fixture.fileSystem.mutations.some((entry) => entry.includes("collector host"))).toBe(false);
  });

  it("does not warn when there is no standalone folder", async () => {
    const fixture = createApplyFixture();
    expect((await run(fixture, { action: "setup" })).warnings).not.toContain("standalone-leftover");
  });
});

describe("integration folder and stale contact temp files", () => {
  const stale = (fixture: ApplyFixture, name: string, ageMs: number, options: { reparse?: boolean } = {}): string => {
    const target = path.win32.join(fixture.integrationDirectory, name);
    fixture.fileSystem.addFile(target, "x", options);
    fixture.fileSystem.touch(target, fixture.now.getTime() - ageMs);
    return target;
  };

  it("removes contact temp files older than ten minutes", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.integrationDirectory);
    const old = stale(fixture, ".collector-contact.json.ab12cd.tmp", 11 * 60_000);
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.has(old)).toBe(false);
  });

  it.each([
    ["a young temp file", ".collector-contact.json.ab12cd.tmp", 60_000],
    ["exactly ten minutes old", ".collector-contact.json.ab12cd.tmp", 10 * 60_000],
    ["another name", "collector-contact.json", 999_999],
    ["a different temp pattern", ".collector-contact.json.tmp", 999_999],
    ["the binding file", "private-shelf-binding.json", 999_999],
    ["a traversal-looking name", ".collector-contact.json..tmp", 999_999],
  ])("keeps %s", async (_label, name, age) => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.integrationDirectory);
    const target = stale(fixture, name, age);
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.has(target)).toBe(true);
  });

  it("keeps a stale-named temp that is a link or a directory", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.integrationDirectory);
    const link = stale(fixture, ".collector-contact.json.l1.tmp", 999_999, { reparse: true });
    const directory = path.win32.join(fixture.integrationDirectory, ".collector-contact.json.d1.tmp");
    fixture.fileSystem.addDirectory(directory);
    fixture.fileSystem.touch(directory, 0);
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.has(link)).toBe(true);
    expect(fixture.fileSystem.has(directory)).toBe(true);
  });

  it("an unsafe existing integration folder is a warning; nothing is removed or re-permissioned", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.integrationDirectory);
    fixture.securityFacts.set(fakeKey(fixture.integrationDirectory), { ...safeFacts(true), ownerSid: "S-1-5-21-9-9-9-9" } as never);
    const old = stale(fixture, ".collector-contact.json.ab12cd.tmp", 999_999);
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.warnings).toContain("integration-folder-unsafe");
    expect(fixture.fileSystem.has(old)).toBe(true);
    expect(fixture.fileSystem.privateDirectories).not.toContain(fakeKey(fixture.integrationDirectory));
  });

  it("the Host-side contact record is never read or written by the apply module", async () => {
    const fixture = createApplyFixture();
    fixture.fileSystem.addDirectory(fixture.integrationDirectory);
    fixture.fileSystem.addFile(path.win32.join(fixture.integrationDirectory, "collector-contact.json"), "{}");
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.mutations.some((entry) => entry.includes("collector-contact.json") && !entry.includes(".tmp"))).toBe(false);
  });
});
