import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCollectorIntegration } from "./collector-integration-apply";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types";
import { COLLECTOR_HOST_ADDON_NAME, COLLECTOR_HOST_EXECUTABLE_NAME } from "./collector-payload";
import { createApplyFixture, type ApplyFixture } from "./collector-integration-apply.test-helper";
import { fakeKey } from "./collector-integration.test-helper";
import { EMPTY_CHROME_POLICIES_FOR_HIVE } from "./collector-registry-adapter.test-helper";
import { safeFacts } from "./collector-host-fixture.test-helper";

const run = (fixture: ApplyFixture, request: CollectorApplyRequest): Promise<CollectorApplyResult> => applyCollectorIntegration(request, fixture.deps);
const p = (fixture: ApplyFixture, ...parts: string[]): string => path.win32.join(fixture.programFolder, ...parts);

async function installed(fixture: ApplyFixture): Promise<ApplyFixture> {
  const result = await run(fixture, { action: "setup" });
  if (result.outcome !== "applied") throw new Error("fixture setup failed");
  fixture.fileSystem.mutations.length = 0;
  fixture.registry.calls.length = 0;
  return fixture;
}

/** Sentinels that a removal must never touch (design 8.5). */
function plantSentinels(fixture: ApplyFixture): Record<string, string> {
  const base = fixture.registry.knownFolders.LocalAppData;
  const sentinels = {
    binding: path.win32.join(fixture.integrationDirectory, "private-shelf-binding.json"),
    contact: path.win32.join(fixture.integrationDirectory, "collector-contact.json"),
    coordination: path.win32.join(fixture.applicationRoot, "coordination", "lock"),
    journal: path.win32.join(fixture.applicationRoot, "first-run-journal.json"),
    shelf: "C:\\Users\\tester\\Documents\\Shelf\\note.md",
    workdesk: "C:\\Users\\tester\\Documents\\Workdesk\\workdesk.yaml",
    project: "C:\\Users\\tester\\Projects\\p1\\main.md",
    chrome: path.win32.join(base, "Google", "Chrome", "User Data", "Default", "Local Extension Settings", "x.ldb"),
    otherProgram: path.win32.join(fixture.userProgramFiles, "Other App", "app.exe"),
    standalone: path.win32.join(fixture.userProgramFiles, "MAGINALIA Collector Host", "MAGINALIA-Collector-Host.exe"),
  };
  for (const target of Object.values(sentinels)) fixture.fileSystem.addFile(target, `sentinel ${target}`);
  return sentinels;
}

const everythingUnder = (fixture: ApplyFixture): string[] => [...fixture.fileSystem.snapshot().keys()].filter((key) => key.startsWith(`${fakeKey(fixture.programFolder)}\\`) || key === fakeKey(fixture.programFolder));

describe("remove (design 3.5, 8.5)", () => {
  it("removes registration and every fixed file, leaving state not-set-up", async () => {
    const fixture = await installed(createApplyFixture());
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ action: "remove", outcome: "applied", reason: null, state: "not-set-up" });
    expect(fixture.registry.registration).toBe("absent");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("unregisters first, then deletes the manifest, slots, extension, state file, folder", async () => {
    const fixture = await installed(createApplyFixture());
    const order: string[] = [];
    const original = fixture.registry.unregisterCollectorHost.bind(fixture.registry);
    fixture.registry.unregisterCollectorHost = () => {
      order.push(`unregister(files=${fixture.fileSystem.mutations.length})`);
      return original();
    };
    await run(fixture, { action: "remove" });
    expect(order).toEqual(["unregister(files=0)"]);
    const log = fixture.fileSystem.mutations;
    const at = (needle: string): number => log.findIndex((entry) => entry.includes(needle));
    expect(at("org.maginalia.collector.json")).toBeLessThan(at("host-a"));
    expect(at("host-a")).toBeLessThan(at("extension"));
    expect(at("remove-file") ).toBeGreaterThan(-1);
    const stateAt = log.findIndex((entry) => entry.includes("integration-state.json"));
    expect(stateAt).toBeGreaterThan(at("extension\\"));
    expect(log[log.length - 1]).toBe(`remove-dir ${fakeKey(fixture.programFolder)}`);
  });

  it("never deletes anything outside the program folder", async () => {
    const fixture = await installed(createApplyFixture());
    const sentinels = plantSentinels(fixture);
    const before = fixture.fileSystem.snapshot();
    await run(fixture, { action: "remove" });
    for (const target of Object.values(sentinels)) expect(fixture.fileSystem.has(target)).toBe(true);
    for (const entry of fixture.fileSystem.mutations) {
      const targets = entry.slice(entry.indexOf(" ") + 1).split(" -> ");
      for (const target of targets) expect(target.startsWith(fakeKey(fixture.programFolder))).toBe(true);
    }
    for (const [key, value] of fixture.fileSystem.snapshot()) {
      if (key.startsWith(fakeKey(fixture.programFolder))) continue;
      expect(before.get(key)).toBe(value);
    }
    expect(fixture.fileSystem.has(fixture.integrationDirectory)).toBe(true);
    expect(fixture.fileSystem.has(fixture.userProgramFiles)).toBe(true);
  });

  it("never calls register or replace", async () => {
    const fixture = await installed(createApplyFixture());
    await run(fixture, { action: "remove" });
    expect(fixture.registry.calls).not.toContain("registerCollectorHost");
    expect(fixture.registry.calls).not.toContain("replaceForeignCollectorHostRegistration");
    expect(fixture.registry.calls.filter((call) => call === "unregisterCollectorHost")).toHaveLength(1);
  });

  it("is idempotent: a second remove is a no-op", async () => {
    const fixture = await installed(createApplyFixture());
    await run(fixture, { action: "remove" });
    fixture.fileSystem.mutations.length = 0;
    fixture.registry.calls.length = 0;
    const second = await run(fixture, { action: "remove" });
    expect(second).toMatchObject({ outcome: "noop", state: "not-set-up" });
    expect(fixture.fileSystem.mutations).toEqual([]);
    expect(fixture.registry.calls).not.toContain("unregisterCollectorHost");
  });

  it("on a machine that never had it, remove is a no-op", async () => {
    const fixture = createApplyFixture();
    expect((await run(fixture, { action: "remove" })).outcome).toBe("noop");
    expect(fixture.fileSystem.mutations).toEqual([]);
  });

  it("with only a registration left (folder gone), remove still unregisters", async () => {
    const fixture = createApplyFixture();
    fixture.registry.registration = "ours";
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "applied", state: "not-set-up" });
    expect(fixture.registry.registration).toBe("absent");
  });

  it("a foreign registration is left alone while our files are removed", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.registration = "foreign";
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("applied");
    expect(result.warnings).toContain("foreign-registration-left");
    expect(fixture.registry.calls).not.toContain("unregisterCollectorHost");
    expect(fixture.registry.registration).toBe("foreign");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("a registry value that turns foreign between read and delete is left alone, files are removed", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.nextUnregisterOutcome = "foreign";
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("applied");
    expect(result.warnings).toContain("foreign-registration-left");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("not-registered is not an error", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.nextUnregisterOutcome = "not-registered";
    expect((await run(fixture, { action: "remove" })).outcome).toBe("applied");
  });

  it.each(["access-denied", "failed"] as const)("unregister %s stops before deleting any file", async (outcome) => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.nextUnregisterOutcome = outcome;
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "failed", reason: "unregister-failed" });
    expect(fixture.fileSystem.mutations).toEqual([]);
    expect(result.state).toBe("ready");
  });

  it("a throwing unregister stops before deleting any file", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.failNext.unregisterCollectorHost = new Error("C:\\secret");
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "failed", reason: "unregister-failed" });
    expect(JSON.stringify({ ...result, inspection: undefined })).not.toContain("secret");
    expect(fixture.fileSystem.mutations).toEqual([]);
  });

  it("is allowed under a Chrome policy block (it only deletes our own fixed names)", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.policies = { hkcu: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"), nativeMessagingUserLevelHosts: 0 }, hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM") };
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("applied");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("is refused under E2E isolation without any call", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.isolated = true;
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "refused", reason: "e2e-isolation" });
    expect(fixture.fileSystem.mutations).toEqual([]);
    expect(fixture.registry.calls).not.toContain("unregisterCollectorHost");
  });

  it("is refused when the inspection cannot finish", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.registry.failNext.readCollectorHostRegistration = new Error("injected");
    expect((await run(fixture, { action: "remove" })).reason).toBe("inspection-incomplete");
    expect(fixture.fileSystem.mutations).toEqual([]);
  });

  it("is refused for an unsafe program folder", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.securityFacts.set(fakeKey(fixture.programFolder), { ...safeFacts(true), ownerSid: "S-1-5-21-9-9-9-9" } as never);
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "refused", reason: "program-folder-unsafe" });
    expect(fixture.fileSystem.mutations).toEqual([]);
    expect(fixture.registry.calls).not.toContain("unregisterCollectorHost");
  });

  it("is refused when the program folder itself is a reparse point", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.setReparse(fixture.programFolder, true);
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("refused");
    expect(fixture.fileSystem.mutations).toEqual([]);
  });

  it("removes leftover temp names and staging folders", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(p(fixture, "org.maginalia.collector.json.00000000000000aa.tmp"), "x");
    fixture.fileSystem.addFile(p(fixture, "integration-state.json.00000000000000bb.tmp"), "x");
    fixture.fileSystem.addFile(p(fixture, "host-a", `${COLLECTOR_HOST_EXECUTABLE_NAME}.00000000000000cc.tmp`), "x");
    fixture.fileSystem.addFile(p(fixture, "extension.next", "nested", "file.js"), "x");
    fixture.fileSystem.addFile(p(fixture, "extension.prev", "manifest.json"), "x");
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("applied");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("removes both slots when both exist", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(p(fixture, "host-b", COLLECTOR_HOST_EXECUTABLE_NAME), "x");
    fixture.fileSystem.addFile(p(fixture, "host-b", COLLECTOR_HOST_ADDON_NAME), "x");
    expect((await run(fixture, { action: "remove" })).outcome).toBe("applied");
    expect(fixture.fileSystem.has(p(fixture, "host-b"))).toBe(false);
  });

  it("removes nested extension folders of any previously placed version", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(p(fixture, "extension", "old", "deep", "legacy.js"), "x");
    expect((await run(fixture, { action: "remove" })).outcome).toBe("applied");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("leaves an unknown file in the program folder: the safe failure", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(p(fixture, "notes-by-user.txt"), "mine");
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("partial");
    expect(result.warnings).toContain("leftovers-remain");
    expect(fixture.fileSystem.text(p(fixture, "notes-by-user.txt"))).toBe("mine");
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
  });

  it("leaves an unknown file inside a slot and keeps the state file so a retry can recognize it", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(p(fixture, "host-a", "user-notes.txt"), "mine");
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("partial");
    expect(fixture.fileSystem.has(p(fixture, "host-a", "user-notes.txt"))).toBe(true);
    expect(fixture.fileSystem.has(p(fixture, "integration-state.json"))).toBe(true);
  });

  it("a locked Host file is retried later: partial now, applied after the unlock", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.lock(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME));
    const first = await run(fixture, { action: "remove" });
    expect(first).toMatchObject({ outcome: "partial", reason: "file-locked" });
    expect(first.warnings).toContain("leftovers-remain");
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
    expect(fixture.fileSystem.has(p(fixture, "integration-state.json"))).toBe(true);
    fixture.fileSystem.locked.clear();
    const second = await run(fixture, { action: "remove" });
    expect(second.outcome).toBe("applied");
    expect(everythingUnder(fixture)).toEqual([]);
  });

  it("a locked extension file leaves the folder and the state file; other entries are still removed", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.lock(p(fixture, "extension", "service-worker.js"));
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "partial", reason: "file-locked" });
    expect(fixture.fileSystem.has(p(fixture, "host-a"))).toBe(false);
    expect(fixture.fileSystem.has(p(fixture, "extension", "service-worker.js"))).toBe(true);
  });
});

describe("junction / reparse canary (design 8.5)", () => {
  const canary = "C:\\canary\\sentinel.txt";

  function plant(fixture: ApplyFixture, junction: string): void {
    fixture.fileSystem.addFile(canary, "do not delete");
    fixture.fileSystem.setReparse(junction, true);
  }

  const targets: ReadonlyArray<readonly [string, (fixture: ApplyFixture) => string]> = [
    ["the extension folder", (f) => p(f, "extension")],
    ["a directory inside the extension folder", (f) => p(f, "extension", "pages")],
    ["host slot a", (f) => p(f, "host-a")],
    ["extension.next", (f) => p(f, "extension.next")],
  ];

  it.each(targets)("a junction as %s is never entered, deleted through or removed; the canary survives", async (_label, pick) => {
    const fixture = await installed(createApplyFixture());
    if (_label === "extension.next") fixture.fileSystem.addDirectory(p(fixture, "extension.next"));
    const junction = pick(fixture);
    plant(fixture, junction);
    fixture.fileSystem.mutations.length = 0;
    const result = await run(fixture, { action: "remove" });
    expect(fixture.fileSystem.text(canary)).toBe("do not delete");
    expect(result.outcome).toBe("partial");
    expect(result.warnings).toContain("leftovers-remain");
    expect(fixture.fileSystem.has(junction)).toBe(true);
    // No mutation names the junction or anything below it.
    expect(fixture.fileSystem.mutations.some((entry) => entry.includes(`${fakeKey(junction)}\\`))).toBe(false);
    expect(fixture.fileSystem.mutations.some((entry) => entry === `remove-dir ${fakeKey(junction)}`)).toBe(false);
    // The rest of our files are still removed; the state file stays for a later retry.
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(false);
    expect(fixture.fileSystem.has(p(fixture, "integration-state.json"))).toBe(true);
  });

  it("a link as the manifest file or the state file is skipped, not deleted", async () => {
    for (const name of ["org.maginalia.collector.json", "integration-state.json"]) {
      const fixture = await installed(createApplyFixture());
      fixture.fileSystem.addFile(canary, "do not delete");
      fixture.fileSystem.setReparse(p(fixture, name), true);
      const result = await run(fixture, { action: "remove" });
      expect(result.outcome).toBe("partial");
      expect(fixture.fileSystem.text(canary)).toBe("do not delete");
      expect(fixture.fileSystem.has(p(fixture, name))).toBe(true);
    }
  });

  it("a link as a file inside a slot is skipped", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(canary, "do not delete");
    fixture.fileSystem.setReparse(p(fixture, "host-a", COLLECTOR_HOST_ADDON_NAME), true);
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("partial");
    expect(fixture.fileSystem.text(canary)).toBe("do not delete");
  });

  it("a repair or setup does not write through a junction either (extension)", async () => {
    const fixture = await installed(createApplyFixture());
    fixture.fileSystem.addFile(canary, "do not delete");
    fixture.fileSystem.setReparse(p(fixture, "extension"), true);
    fixture.fileSystem.mutations.length = 0;
    await run(fixture, { action: "repair" });
    await run(fixture, { action: "setup" });
    expect(fixture.fileSystem.mutations).toEqual([]);
    expect(fixture.fileSystem.text(canary)).toBe("do not delete");
  });
});

describe("remove then setup (re-placement)", () => {
  it("setup after remove reaches ready again", async () => {
    const fixture = await installed(createApplyFixture());
    await run(fixture, { action: "remove" });
    expect(await run(fixture, { action: "setup" })).toMatchObject({ outcome: "applied", state: "ready" });
  });
});
