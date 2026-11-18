/**
 * Multi-browser apply (design S4: sections 3.3, 5.2, 5.4, 5.5, 5.6, 5.7 and the review findings
 * a-d of S3). The product table has only Chrome `verified`; these cases inject a table in which Edge
 * is verified too (a one-field change in the real table). Nothing touches a real registry or path.
 *
 * Crash-point sweeps (design 5.7 scenarios 1, 3, 4, 5) live in `collector-integration-apply-fault.test.ts`.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCollectorIntegration } from "./collector-integration-apply";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types";
import { inspectCollectorIntegration, parseIntegrationStateFile } from "./collector-integration";
import { createCollectorStartupRefresh } from "./collector-startup-refresh";
import { DEFAULT_COLLECTOR_NOTICE_STATE, type CollectorNoticeState } from "./collector-integration-notices";
import { COLLECTOR_BROWSERS, type CollectorBrowserSpec, type CollectorRegistryTargetId } from "./collector-browser-table";
import { EMPTY_CHROME_POLICIES_FOR_HIVE } from "./collector-registry-adapter.test-helper";
import { HOST_SOURCE_FILES, SOURCE_EXTENSION_FOLDER, SOURCE_HOST_FOLDER, applyDescriptor, createApplyFixture, extensionSourceFiles, tableWithVerified, tableWithWhenPresentEdge, type ApplyFixture } from "./collector-integration-apply.test-helper";
import { COLLECTOR_HOST_EXECUTABLE_NAME } from "./collector-payload";

const CHROME_EDGE = tableWithVerified("chrome", "edge");
const run = (fixture: ApplyFixture, request: CollectorApplyRequest): Promise<CollectorApplyResult> => applyCollectorIntegration(request, fixture.deps);
const inspect = (fixture: ApplyFixture) => inspectCollectorIntegration(fixture.deps);
const p = (fixture: ApplyFixture, ...parts: string[]): string => path.win32.join(fixture.programFolder, ...parts);
const registeredTargetsOf = (fixture: ApplyFixture): readonly CollectorRegistryTargetId[] | undefined =>
  parseIntegrationStateFile(fixture.fileSystem.text(p(fixture, "integration-state.json")))?.registeredTargets;
const writeCalls = (fixture: ApplyFixture) => fixture.registry.targetCalls.filter((entry) => /^(register|unregister|replaceForeign)/u.test(entry.call));
const blockUserLevelHosts = { hkcu: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"), nativeMessagingUserLevelHosts: 0 }, hklm: EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM") };

async function setupBoth(): Promise<ApplyFixture> {
  const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
  expect((await run(fixture, { action: "setup" })).outcome).toBe("applied");
  return fixture;
}

/** An RC3-style installation: Chrome only, v1 state file; the table then grows to Chrome + Edge. */
async function rc3Installation(): Promise<ApplyFixture> {
  const fixture = createApplyFixture();
  expect((await run(fixture, { action: "setup" })).outcome).toBe("applied");
  const state = JSON.parse(fixture.fileSystem.text(p(fixture, "integration-state.json"))) as Record<string, unknown>;
  delete state.registeredTargets;
  fixture.fileSystem.setBytes(p(fixture, "integration-state.json"), `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`);
  fixture.browserTable = CHROME_EDGE;
  return fixture;
}

function installEdge(fixture: ApplyFixture): void {
  const exe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  fixture.fileSystem.addFile(exe, "x");
  fixture.registry.appPathsByName["msedge.exe"] = [{ source: "hklm-32", value: exe }];
}

function newerPayload(fixture: ApplyFixture): void {
  fixture.fileSystem.setBytes(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), "host-executable-bytes-v2");
  fixture.payload = applyDescriptor({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0", extensionVersion: "0.4.0", host: { ...HOST_SOURCE_FILES, [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes-v2" } });
  for (const [name, content] of Object.entries(extensionSourceFiles("0.4.0"))) fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, ...name.split("/")), content);
}

// ----- scenario-independent behavior of setup over E = [chrome, edge] ----------------------------

describe("setup registers every target of the expected set (design 5.2)", () => {
  it("registers chrome then edge, records both in a v2 state file and reports each target", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "applied", reason: null, state: "ready", filesChanged: true });
    expect(result.targets).toEqual([{ target: "chrome", result: "registered" }, { target: "edge", result: "registered" }]);
    expect(fixture.fileSystem.registryLog).toEqual(["register chrome", "register edge"]);
    expect(JSON.parse(fixture.fileSystem.text(p(fixture, "integration-state.json")))).toMatchObject({ version: 2, registeredTargets: ["chrome", "edge"] });
    expect(result.inspection.expectedTargets).toEqual(["chrome", "edge"]);
  });

  it("with the product table (only Chrome verified) it writes exactly one key, as before", async () => {
    const fixture = createApplyFixture();
    const result = await run(fixture, { action: "setup" });
    expect(result.targets).toEqual([{ target: "chrome", result: "registered" }, { target: "edge", result: "not-expected" }]);
    expect(fixture.registry.registrations).toMatchObject({ chrome: "ours", edge: "absent" });
    expect(registeredTargetsOf(fixture)).toEqual(["chrome"]);
  });

  it("is idempotent: a second run is a noop and writes nothing", async () => {
    const fixture = await setupBoth();
    const before = fixture.fileSystem.mutationCount;
    expect((await run(fixture, { action: "setup" })).outcome).toBe("noop");
    expect(fixture.fileSystem.mutationCount).toBe(before);
  });

  it("nothing to register (no verified browser): refused before anything is written (empty E)", async () => {
    const fixture = createApplyFixture({ browserTable: COLLECTOR_BROWSERS.map((row) => ({ ...row, verification: "unverified" }) as CollectorBrowserSpec) });
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "wrong-state", targets: [] });
    expect(fixture.fileSystem.mutationCount).toBe(0);
  });
});

// ----- (a) registeredTargets semantics for a refused write; scenario 2 ----------------------------

describe("design 5.7 scenario 2 / S3 finding (a): a refused write stays registration-missing and never loops", () => {
  it.each([["chrome", "edge"], ["edge", "chrome"]] as const)("%s denied: failed, per-target result, recorded as attempted, %s keeps working", async (denied, working) => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registerOutcomes[denied] = "access-denied";
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-write-denied", state: "registration-missing" });
    expect(result.targets).toEqual(expect.arrayContaining([{ target: denied, result: "denied" }, { target: working, result: "registered" }]));
    expect(fixture.registry.registrations[denied]).toBe("absent");
    expect(fixture.registry.registrations[working]).toBe("ours");
    // The attempted E is recorded, so the next inspection is a repair, not `outdated(registration-target-added)`.
    expect(registeredTargetsOf(fixture)).toEqual(["chrome", "edge"]);
    const after = await inspect(fixture);
    expect(after.state).toBe("registration-missing");
    expect(after.reasons).toContain("registration-absent");
    expect(after.reasons).not.toContain("registration-target-added");
    // The selected browser's effective registration: Edge falls back to the Chrome key when its own key was refused.
    const edge = after.browsers.entries.find((entry) => entry.id === "edge");
    expect(edge?.effective).toEqual(denied === "edge" ? { target: "chrome", ownership: "ours" } : { target: "edge", ownership: "ours" });
  });

  it("an automatic refresh does not run for it (wrong-state, no write), and repair converges once the key is writable", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registerOutcomes.edge = "access-denied";
    await run(fixture, { action: "setup" });
    const before = fixture.fileSystem.mutationCount;
    expect(await run(fixture, { action: "refresh" })).toMatchObject({ outcome: "refused", reason: "wrong-state" });
    expect(fixture.fileSystem.mutationCount).toBe(before);
    delete fixture.registry.registerOutcomes.edge;
    expect(await run(fixture, { action: "repair" })).toMatchObject({ outcome: "applied", state: "ready" });
    expect(fixture.registry.registrations).toMatchObject({ chrome: "ours", edge: "ours" });
  });

  it("through the real startup orchestrator: a repair notice at every start, never a silent refresh", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registerOutcomes.edge = "access-denied";
    await run(fixture, { action: "setup" });
    const applies: CollectorApplyRequest[] = [];
    let stored: CollectorNoticeState = DEFAULT_COLLECTOR_NOTICE_STATE;
    for (let start = 0; start < 3; start += 1) {
      const startup = createCollectorStartupRefresh({
        inspect: (options) => inspectCollectorIntegration(fixture.deps, options),
        apply: (request) => { applies.push(request); return applyCollectorIntegration(request, fixture.deps); },
        hasOptedIn: async () => true,
        noticeStore: { read: async () => stored, write: async (state) => { stored = state; } },
        now: () => fixture.now,
        e2eIsolationActive: false,
      });
      const outcome = await startup.runStartup();
      expect(outcome.outcome).toBe("no-action");
      expect(outcome.notices.map((notice) => notice.kind)).toEqual(["repair"]);
    }
    expect(applies).toEqual([]);
  });

  it("a thrown registry write is recorded like a refused one", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registerOutcomes.chrome = "failed";
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-write-failed" });
    expect(result.targets).toContainEqual({ target: "chrome", result: "failed" });
    expect(result.targets).toContainEqual({ target: "edge", result: "registered" });
  });

  it("registeredTargets only grows: a target skipped by policy stays recorded", async () => {
    const fixture = await setupBoth();
    fixture.registry.policies = blockUserLevelHosts; // Chrome blocked: E = [edge]
    fixture.registry.registrations.edge = "absent"; // someone removed the Edge key
    const result = await run(fixture, { action: "repair" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.targets).toEqual([{ target: "chrome", result: "skipped-policy" }, { target: "edge", result: "registered" }]);
    expect(registeredTargetsOf(fixture)).toEqual(["chrome", "edge"]);
  });
});

// ----- registration-only refresh (design 5.4); scenario 3 detail ----------------------------------

describe("registration-only refresh (design 5.4)", () => {
  it("RC3 install (v1 state, Chrome only) + Edge added: outdated(target-added), refresh touches no slot, extension or manifest", async () => {
    const fixture = await rc3Installation();
    const first = await inspect(fixture);
    expect(first).toMatchObject({ state: "outdated", reasons: ["registration-target-added"], registeredTargets: ["chrome"] });
    const stateBefore = parseIntegrationStateFile(fixture.fileSystem.text(p(fixture, "integration-state.json")));
    fixture.fileSystem.mutations.length = 0;
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready", filesChanged: false });
    expect(result.targets).toEqual([{ target: "chrome", result: "ours-already" }, { target: "edge", result: "registered" }]);
    // Only the state file (temp + rename) was written besides the registry.
    expect(fixture.fileSystem.mutations.every((entry) => entry.includes("integration-state.json"))).toBe(true);
    expect(fixture.fileSystem.mutations.some((entry) => /host-[ab]|extension|org\.maginalia\.collector\.json/u.test(entry))).toBe(false);
    expect(fixture.fileSystem.registryLog).toContain("register edge");
    const stateAfter = parseIntegrationStateFile(fixture.fileSystem.text(p(fixture, "integration-state.json")));
    expect(stateAfter).toEqual({ ...stateBefore, version: 2, registeredTargets: ["chrome", "edge"] });
  });

  it("the Host self-check still runs once, against the active slot", async () => {
    const fixture = await rc3Installation();
    fixture.selfChecks.length = 0;
    await run(fixture, { action: "refresh" });
    expect(fixture.selfChecks).toHaveLength(1);
  });

  it("a payload update that also adds a target is a normal refresh: files placed and the target registered", async () => {
    const fixture = await rc3Installation();
    newerPayload(fixture);
    const first = await inspect(fixture);
    expect(first.state).toBe("outdated");
    expect(first.reasons).toEqual(expect.arrayContaining(["payload-id-differs", "registration-target-added"]));
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready", filesChanged: true });
    expect(result.targets).toContainEqual({ target: "edge", result: "registered" });
    expect(result.inspection.installed.payloadId).toBe("1.3.0+def5678");
  });

  it("a plain refresh (payload only) reports filesChanged and registers nothing new", async () => {
    const fixture = await setupBoth();
    newerPayload(fixture);
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "applied", filesChanged: true });
    expect(result.targets).toEqual([{ target: "chrome", result: "ours-already" }, { target: "edge", result: "ours-already" }]);
    expect(fixture.fileSystem.registryLog).toEqual(["register chrome", "register edge"]); // from the setup only
  });

  it("a refresh never re-registers a target that was registered before (that is a repair)", async () => {
    const fixture = await setupBoth();
    fixture.registry.registrations.edge = "absent";
    expect(await run(fixture, { action: "refresh" })).toMatchObject({ outcome: "refused", reason: "wrong-state" });
    expect(fixture.registry.registrations.edge).toBe("absent");
  });

  it("a refused add leaves the target recorded (repair notice) and does not loop (S3 finding a)", async () => {
    const fixture = await rc3Installation();
    fixture.registry.registerOutcomes.edge = "access-denied";
    const result = await run(fixture, { action: "refresh" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registry-write-denied", filesChanged: false, state: "registration-missing" });
    expect(registeredTargetsOf(fixture)).toEqual(["chrome", "edge"]);
    expect(await run(fixture, { action: "refresh" })).toMatchObject({ outcome: "refused", reason: "wrong-state" });
  });
});

// ----- (b) remove covers every writable target; scenario 5 ----------------------------------------

describe("design 5.7 scenario 5 / S3 finding (b): remove over all writable targets", () => {
  it("removes our Edge key even though Edge is not verified (E = [chrome]); reverse registry order", async () => {
    const fixture = createApplyFixture(); // product table: E = [chrome]
    await run(fixture, { action: "setup" });
    fixture.registry.registrations.edge = "ours";
    fixture.fileSystem.registryLog.length = 0;
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "applied", reason: null });
    expect(result.targets).toEqual([{ target: "chrome", result: "removed" }, { target: "edge", result: "removed" }]);
    expect(fixture.fileSystem.registryLog).toEqual(["unregister edge", "unregister chrome"]);
    expect(fixture.fileSystem.has(fixture.programFolder)).toBe(false);
  });

  it("removes our Chrome key while a policy blocks Chrome (E excludes it)", async () => {
    const fixture = await setupBoth();
    fixture.registry.policies = blockUserLevelHosts;
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("applied");
    expect(fixture.registry.registrations).toMatchObject({ chrome: "absent", edge: "absent" });
  });

  it("a key that cannot be read is never reported as removed: refused before anything changed", async () => {
    const fixture = createApplyFixture(); // Edge not in E, so the inspection does not need it
    await run(fixture, { action: "setup" });
    fixture.registry.registrations.edge = "ours";
    fixture.registry.unreadableTargets.add("edge");
    const mutations = fixture.fileSystem.mutationCount;
    const snapshot = fixture.fileSystem.snapshot();
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "refused", reason: "inspection-incomplete", targets: [] });
    expect(fixture.fileSystem.mutationCount).toBe(mutations);
    expect(fixture.fileSystem.snapshot()).toEqual(snapshot);
    expect(fixture.registry.registrations).toMatchObject({ chrome: "ours", edge: "ours" });
  });

  it("an unregister that is denied keeps every file, the other key is still removed, and a second remove converges", async () => {
    const fixture = await setupBoth();
    fixture.registry.unregisterOutcomes.edge = "access-denied";
    const snapshot = fixture.fileSystem.snapshot();
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "failed", reason: "unregister-failed" });
    expect(result.targets).toEqual([{ target: "chrome", result: "removed" }, { target: "edge", result: "denied" }]);
    expect(fixture.registry.registrations).toMatchObject({ chrome: "absent", edge: "ours" });
    expect(fixture.fileSystem.snapshot()).toEqual(snapshot); // files untouched while a key is still ours
    delete fixture.registry.unregisterOutcomes.edge;
    expect(await run(fixture, { action: "remove" })).toMatchObject({ outcome: "applied" });
    expect(fixture.registry.registrations).toMatchObject({ chrome: "absent", edge: "absent" });
    expect(fixture.fileSystem.has(fixture.programFolder)).toBe(false);
  });

  it("a thrown unregister is a failure too (the key is still ours)", async () => {
    const fixture = await setupBoth();
    fixture.registry.unregisterOutcomes.chrome = "failed";
    const result = await run(fixture, { action: "remove" });
    expect(result).toMatchObject({ outcome: "failed", reason: "unregister-failed" });
    expect(result.targets).toContainEqual({ target: "chrome", result: "failed" });
    expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json"))).toBe(true);
  });

  it("a foreign Edge value is left alone with a warning; the Chrome key and the files go", async () => {
    const fixture = createApplyFixture();
    await run(fixture, { action: "setup" });
    fixture.registry.registrations.edge = "foreign";
    const result = await run(fixture, { action: "remove" });
    expect(result.warnings).toContain("foreign-registration-left");
    expect(result.targets).toEqual([{ target: "chrome", result: "removed" }, { target: "edge", result: "foreign-left" }]);
    expect(fixture.registry.registrations.edge).toBe("foreign");
    expect(fixture.registry.registrations.chrome).toBe("absent");
  });

  it("noop when there is no folder and no key of ours; chromium and vivaldi are never read for removal", async () => {
    const fixture = createApplyFixture();
    const result = await run(fixture, { action: "remove" });
    expect(result.outcome).toBe("noop");
    expect(writeCalls(fixture)).toEqual([]);
  });
});

// ----- (c) the guard compares a snapshot per target; scenario 6 -----------------------------------

describe("design 5.7 scenario 6 / S3 finding (c): foreign targets and the per-target guard", () => {
  it("Edge foreign, no confirmation: refused, nothing written", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registrations.edge = "foreign";
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "refused", reason: "foreign-confirmation-required", state: "foreign-registration" });
    expect(fixture.fileSystem.mutationCount).toBe(0);
    expect(fixture.registry.registrations).toMatchObject({ chrome: "absent", edge: "foreign" });
  });

  it("Edge foreign, confirmed: Edge is replaced, Chrome registered", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registrations.edge = "foreign";
    const result = await run(fixture, { action: "setup", confirmReplaceForeign: true });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.targets).toEqual([{ target: "chrome", result: "registered" }, { target: "edge", result: "replaced" }]);
  });

  it("Chrome turns foreign between the precondition and the guard: nothing is replaced, not even the confirmed Edge key", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registrations.edge = "foreign";
    fixture.fileSystem.onCopy = () => { fixture.registry.registrations.chrome = "foreign"; };
    const result = await run(fixture, { action: "setup", confirmReplaceForeign: true });
    expect(result).toMatchObject({ outcome: "failed", reason: "registration-changed" });
    expect(fixture.registry.registrations).toMatchObject({ chrome: "foreign", edge: "foreign" });
    expect(fixture.fileSystem.registryLog).toEqual([]);
  });

  it("the same flip before the FIRST guard is a refusal (nothing of the installation was written)", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    let payloadReads = 0;
    const deps = { ...fixture.deps, readPayloadDescriptor: async () => { payloadReads += 1; if (payloadReads === 2) fixture.registry.registrations.chrome = "foreign"; return fixture.payload; } };
    const result = await applyCollectorIntegration({ action: "setup" }, deps);
    expect(result).toMatchObject({ outcome: "refused", reason: "registration-changed" });
    expect(fixture.fileSystem.mutationCount).toBe(0);
    expect(fixture.registry.registrations.chrome).toBe("foreign");
  });

  it("a read-only lookup target (chromium) that changes after the precondition stops the run too", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.fileSystem.onCopy = () => { fixture.registry.registrations.chromium = "foreign"; };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "registration-changed" });
    expect(fixture.fileSystem.registryLog).toEqual([]);
  });

  it("a key that cannot be read at the guard is inspection-incomplete, not a silent pass", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.fileSystem.onCopy = () => { fixture.registry.unreadableTargets.add("edge"); };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "inspection-incomplete" });
    expect(fixture.fileSystem.registryLog).toEqual([]);
  });
});

// ----- scenario 7: policy per browser -------------------------------------------------------------

describe("design 5.7 scenario 7: policy per browser", () => {
  it("Chrome blocked, Edge not: Chrome's key is never written, E = [edge], and the installation is ready", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.policies = blockUserLevelHosts;
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.targets).toEqual([{ target: "chrome", result: "skipped-policy" }, { target: "edge", result: "registered" }]);
    expect(fixture.registry.registrations).toMatchObject({ chrome: "absent", edge: "ours" });
    expect(fixture.fileSystem.registryLog).toEqual(["register edge"]);
    expect(result.inspection.expectedTargets).toEqual(["edge"]);
    expect(registeredTargetsOf(fixture)).toEqual(["edge"]);
  });

  it("every verified browser blocked: policy-blocked refusal, nothing written", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.policies = blockUserLevelHosts;
    fixture.registry.edgePolicies = blockUserLevelHosts;
    expect(await run(fixture, { action: "setup" })).toMatchObject({ outcome: "refused", reason: "policy-blocked" });
    expect(fixture.fileSystem.mutationCount).toBe(0);
  });

  it("a browser becomes blocked mid-run: expected-targets-changed, no key written", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.fileSystem.onCopy = () => { fixture.registry.policies = blockUserLevelHosts; };
    const result = await run(fixture, { action: "setup" });
    expect(result).toMatchObject({ outcome: "failed", reason: "expected-targets-changed" });
    expect(fixture.fileSystem.registryLog).toEqual([]);
  });

  it("every browser becomes blocked mid-run: policy-blocked, no key written", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.fileSystem.onCopy = () => { fixture.registry.policies = blockUserLevelHosts; fixture.registry.edgePolicies = blockUserLevelHosts; };
    expect(await run(fixture, { action: "setup" })).toMatchObject({ outcome: "failed", reason: "policy-blocked" });
    expect(fixture.fileSystem.registryLog).toEqual([]);
  });
});

// ----- scenario 8: when-present ---------------------------------------------------------------------

describe("design 5.7 scenario 8: a when-present browser", () => {
  it("not detected: not written. Detected later: added by a registration-only refresh. Removed key: repair, not refresh", async () => {
    const fixture = createApplyFixture({ browserTable: tableWithWhenPresentEdge() });
    const setup = await run(fixture, { action: "setup" });
    expect(setup.targets).toEqual([{ target: "chrome", result: "registered" }, { target: "edge", result: "not-expected" }]);
    expect(fixture.registry.registrations.edge).toBe("absent");
    expect((await inspect(fixture)).state).toBe("ready");

    installEdge(fixture);
    const outdated = await inspect(fixture);
    expect(outdated).toMatchObject({ state: "outdated", reasons: ["registration-target-added"], expectedTargets: ["chrome", "edge"] });
    const refresh = await run(fixture, { action: "refresh" });
    expect(refresh).toMatchObject({ outcome: "applied", state: "ready", filesChanged: false });
    expect(registeredTargetsOf(fixture)).toEqual(["chrome", "edge"]);

    fixture.registry.registrations.edge = "absent";
    expect(await inspect(fixture)).toMatchObject({ state: "registration-missing" });
    expect(await run(fixture, { action: "refresh" })).toMatchObject({ outcome: "refused", reason: "wrong-state" });
    expect(await run(fixture, { action: "repair" })).toMatchObject({ outcome: "applied", state: "ready" });
  });

  it("a browser that was registered stays expected after it is uninstalled", async () => {
    const fixture = createApplyFixture({ browserTable: tableWithWhenPresentEdge() });
    installEdge(fixture);
    await run(fixture, { action: "setup" });
    fixture.fileSystem.remove("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect((await inspect(fixture)).expectedTargets).toEqual(["chrome", "edge"]);
  });
});

// ----- scenario 9 and (d): the read-only Chromium key ---------------------------------------------

describe("design 5.7 scenario 9 / S3 finding (d): the read-only chromium key", () => {
  it("is never written or removed in a full cycle, and Edge reports it as its effective (foreign) registration until Edge has its own key", async () => {
    const fixture = createApplyFixture({ browserTable: CHROME_EDGE });
    fixture.registry.registrations.chromium = "foreign";
    const edgeBefore = (await inspect(fixture)).browsers.entries.find((entry) => entry.id === "edge");
    expect(edgeBefore?.effective).toEqual({ target: "chromium", ownership: "foreign" });
    // A user-started setup accepts shadowing (design 11.1): Edge gets its own key, the foreign one is untouched.
    expect(await run(fixture, { action: "setup" })).toMatchObject({ outcome: "applied", state: "ready" });
    expect((await inspect(fixture)).browsers.entries.find((entry) => entry.id === "edge")?.effective).toEqual({ target: "edge", ownership: "ours" });
    await run(fixture, { action: "remove" });
    expect(fixture.registry.registrations.chromium).toBe("foreign");
    expect(writeCalls(fixture).filter((entry) => entry.target === "chromium")).toEqual([]);
    expect(writeCalls(fixture).length).toBeGreaterThan(0);
  });

  it("(d) an automatic target-added refresh never shadows a foreign Chromium key: the inspection says foreign-registration", async () => {
    const fixture = await rc3Installation();
    fixture.registry.registrations.chromium = "foreign";
    const first = await inspect(fixture);
    expect(first).toMatchObject({ state: "foreign-registration", reasons: ["registration-foreign"] });
    const before = fixture.fileSystem.mutationCount;
    expect(await run(fixture, { action: "refresh" })).toMatchObject({ outcome: "refused", reason: "wrong-state" });
    expect(fixture.fileSystem.mutationCount).toBe(before);
    expect(fixture.registry.registrations.edge).toBe("absent");
  });

  it("(d) the repair that follows needs the user's confirmation and then registers Edge without touching Chromium", async () => {
    const fixture = await rc3Installation();
    fixture.registry.registrations.chromium = "foreign";
    expect(await run(fixture, { action: "repair" })).toMatchObject({ outcome: "refused", reason: "foreign-confirmation-required" });
    expect(fixture.registry.registrations.edge).toBe("absent");
    const result = await run(fixture, { action: "repair", confirmReplaceForeign: true });
    expect(result).toMatchObject({ outcome: "applied", state: "ready" });
    expect(result.targets).toContainEqual({ target: "edge", result: "registered" });
    expect(fixture.registry.registrations).toMatchObject({ edge: "ours", chromium: "foreign" });
    expect(writeCalls(fixture).filter((entry) => entry.target === "chromium")).toEqual([]);
  });

  it("(d) through the real startup orchestrator: a repair notice and no apply (not even a refresh attempt)", async () => {
    const fixture = await rc3Installation();
    fixture.registry.registrations.chromium = "foreign";
    const applies: CollectorApplyRequest[] = [];
    let stored: CollectorNoticeState = DEFAULT_COLLECTOR_NOTICE_STATE;
    const startup = createCollectorStartupRefresh({
      inspect: (options) => inspectCollectorIntegration(fixture.deps, options),
      apply: (request) => { applies.push(request); return applyCollectorIntegration(request, fixture.deps); },
      hasOptedIn: async () => true,
      noticeStore: { read: async () => stored, write: async (state) => { stored = state; } },
      now: () => fixture.now,
      e2eIsolationActive: false,
    });
    const outcome = await startup.runStartup();
    expect(outcome.outcome).toBe("no-action");
    expect(outcome.notices.map((notice) => notice.kind)).toEqual(["repair"]);
    expect(applies).toEqual([]);
  });

  it("control: without the foreign Chromium key the same installation refreshes automatically", async () => {
    const fixture = await rc3Installation();
    expect(await inspect(fixture)).toMatchObject({ state: "outdated", reasons: ["registration-target-added"] });
    expect(await run(fixture, { action: "refresh" })).toMatchObject({ outcome: "applied" });
  });

  it("an OURS Chrome key behind Edge (the normal fallback) is not shadowing", async () => {
    const fixture = await rc3Installation();
    expect(fixture.registry.registrations.chrome).toBe("ours");
    expect((await inspect(fixture)).state).toBe("outdated");
  });
});
