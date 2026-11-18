/**
 * Per-browser inspection (multi-browser design S3: sections 1.5, 3.1, 4.2-4.5).
 *
 * The product table has only Chrome `verified`, so most cases inject a table in which Edge is also
 * `verified` (a one-field change in the real table). Nothing here touches a real registry or path.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  COLLECTOR_BROWSERS,
  type CollectorBrowserSpec,
  type CollectorRegistryTargetId,
} from "./collector-browser-table";
import {
  computeExpectedTargets,
  inspectCollectorIntegration,
  locateBrowserExecutable,
  parseIntegrationStateFile,
} from "./collector-integration";
import type { CollectorIntegrationInspection, CollectorIntegrationState } from "./collector-integration-types";
import { EMPTY_CHROME_POLICIES_FOR_HIVE } from "./collector-registry-adapter.test-helper";
import type { ChromePolicySnapshot, ChromePolicyHiveFacts } from "./collector-registry-adapter";
import {
  createIntegrationFixture,
  payloadDescriptorFixture,
  stateFileText,
  type IntegrationFixture,
} from "./collector-integration.test-helper";

// ----- helpers ------------------------------------------------------------------------------

/** The product table with one row switched to `verified` (the real change is the same one field). */
function tableWithVerified(...ids: readonly string[]): readonly CollectorBrowserSpec[] {
  return COLLECTOR_BROWSERS.map((row) =>
    ids.includes(row.id)
      ? ({ ...row, verification: "verified", evidence: { ...row.evidence, progIdPattern: "measured", lookupOrder: "vendor-doc", ownTargets: "vendor-doc", registration: "vendor-doc", policyRoot: "vendor-doc" } } as CollectorBrowserSpec)
      : row);
}

const CHROME_EDGE = tableWithVerified("chrome", "edge");

function inspectWith(fixture: IntegrationFixture, table?: readonly CollectorBrowserSpec[], options?: { verifyFileHashes?: boolean }): Promise<CollectorIntegrationInspection> {
  return inspectCollectorIntegration(table === undefined ? fixture.dependencies : { ...fixture.dependencies, browserTable: table }, options);
}

const p = (fixture: IntegrationFixture, ...parts: string[]): string => path.win32.join(fixture.programFolder, ...parts);

function policies(hkcu: Partial<ChromePolicyHiveFacts> = {}, hklm: Partial<ChromePolicyHiveFacts> = {}): ChromePolicySnapshot {
  return { hkcu: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKCU"), ...hkcu }, hklm: { ...EMPTY_CHROME_POLICIES_FOR_HIVE("HKLM"), ...hklm } };
}

/** A ready installation whose state file is v2 with these registered targets and both Chrome and Edge `ours`. */
function readyBoth(registered: readonly CollectorRegistryTargetId[] = ["chrome", "edge"]): IntegrationFixture {
  const fixture = createIntegrationFixture();
  fixture.fileSystem.addFile(p(fixture, "integration-state.json"), stateFileText({ version: 2, registeredTargets: registered }));
  fixture.registry.registrations.chrome = "ours";
  fixture.registry.registrations.edge = "ours";
  return fixture;
}

const edgeEntry = (result: CollectorIntegrationInspection) => result.browsers.entries.find((entry) => entry.id === "edge");
const chromeEntry = (result: CollectorIntegrationInspection) => result.browsers.entries.find((entry) => entry.id === "chrome");

// ----- the seven states, per target (Chrome and Edge both verified) ---------------------------

describe("inspection with Chrome and Edge verified (design 4.4)", () => {
  type Row = {
    readonly name: string;
    readonly arrange: (fixture: IntegrationFixture) => void;
    readonly state: CollectorIntegrationState;
    readonly reasons: readonly string[];
    readonly installed?: boolean;
  };
  const olderPayload = payloadDescriptorFixture({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0" });
  const rows: readonly Row[] = [
    { name: "not-set-up: nothing installed, no registration", installed: false, arrange: () => {}, state: "not-set-up", reasons: [] },
    { name: "ready: both ours and both recorded", arrange: () => {}, state: "ready", reasons: [] },
    {
      name: "policy-blocked: every verified browser blocked", installed: false,
      arrange: (f) => { f.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 }); f.registry.edgePolicies = policies({}, { nativeMessagingBlocklist: ["*"] }); },
      state: "policy-blocked", reasons: ["policy-user-level-hosts-disabled", "policy-host-blocklisted"],
    },
    {
      name: "policy-blocked beats a foreign registration",
      arrange: (f) => { f.registry.registrations.edge = "foreign"; f.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 }); f.registry.edgePolicies = policies({ nativeMessagingUserLevelHosts: 0 }); },
      state: "policy-blocked", reasons: ["policy-user-level-hosts-disabled"],
    },
    {
      name: "4.4-1: only Edge blocked leaves E = [chrome]: ready (Edge absent is ignored)",
      arrange: (f) => { f.registry.edgePolicies = policies({ nativeMessagingUserLevelHosts: 0 }); f.registry.registrations.edge = "absent"; },
      state: "ready", reasons: [],
    },
    {
      name: "4.4-1: only Chrome blocked leaves E = [edge]: ready (Chrome foreign is ignored)",
      arrange: (f) => { f.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 }); f.registry.registrations.chrome = "foreign"; },
      state: "ready", reasons: [],
    },
    {
      name: "foreign-registration: Edge foreign, Chrome ours",
      arrange: (f) => { f.registry.registrations.edge = "foreign"; },
      state: "foreign-registration", reasons: ["registration-foreign"],
    },
    {
      name: "foreign-registration: Chrome foreign, Edge ours", installed: false,
      arrange: (f) => { f.registry.registrations.chrome = "foreign"; f.registry.registrations.edge = "ours"; },
      state: "foreign-registration", reasons: ["registration-foreign"],
    },
    {
      name: "registration-missing: Edge was registered (recorded) and is gone",
      arrange: (f) => { f.registry.registrations.edge = "absent"; },
      state: "registration-missing", reasons: ["registration-absent"],
    },
    {
      name: "registration-missing: both recorded and both gone",
      arrange: (f) => { f.registry.registrations.chrome = "absent"; f.registry.registrations.edge = "absent"; },
      state: "registration-missing", reasons: ["registration-absent"],
    },
    {
      name: "registration-missing: Chrome recorded and gone while Edge is ours",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ version: 2, registeredTargets: ["chrome"] })); f.registry.registrations.chrome = "absent"; },
      state: "registration-missing", reasons: ["registration-absent"],
    },
    {
      name: "4.4-5: registration-missing wins over a not-yet-registered target",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ version: 2, registeredTargets: ["chrome"] })); f.registry.registrations.chrome = "absent"; f.registry.registrations.edge = "absent"; },
      state: "registration-missing", reasons: ["registration-absent"],
    },
    {
      name: "4.4-5: v1 state + Edge now expected -> outdated(registration-target-added)",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText()); f.registry.registrations.edge = "absent"; },
      state: "outdated", reasons: ["registration-target-added"],
    },
    {
      name: "4.4-5: v2 state that never recorded Edge -> outdated(registration-target-added)",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ version: 2, registeredTargets: ["chrome"] })); f.registry.registrations.edge = "absent"; },
      state: "outdated", reasons: ["registration-target-added"],
    },
    {
      name: "4.4-5: nothing recorded and everything absent -> outdated(registration-target-added)",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ version: 2, registeredTargets: [] })); f.registry.registrations.chrome = "absent"; f.registry.registrations.edge = "absent"; },
      state: "outdated", reasons: ["registration-target-added"],
    },
    {
      name: "outdated with both a new payload and a new target",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText()); f.registry.registrations.edge = "absent"; f.payload = olderPayload; },
      state: "outdated", reasons: ["payload-id-differs", "installed-older", "registration-target-added"],
    },
    {
      name: "a new payload with every target recorded is still outdated(payload-id-differs) only",
      arrange: (f) => { f.payload = olderPayload; },
      state: "outdated", reasons: ["payload-id-differs", "installed-older"],
    },
    {
      name: "registration-missing wins over a new payload",
      arrange: (f) => { f.registry.registrations.edge = "absent"; f.payload = olderPayload; },
      state: "registration-missing", reasons: ["registration-absent"],
    },
    {
      name: "4.4-4: a damaged structure stays damaged even with a missing Edge registration",
      arrange: (f) => { f.registry.registrations.edge = "absent"; f.fileSystem.remove(p(f, "org.maginalia.collector.json")); },
      state: "damaged", reasons: ["manifest-missing"],
    },
    {
      name: "4.4-4: tampered files are damaged, not outdated(registration-target-added)",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText()); f.registry.registrations.edge = "absent"; f.fileSystem.addFile(p(f, "extension", "background.js"), "evil();"); },
      state: "damaged", reasons: ["extension-file-hash-mismatch"],
    },
    {
      name: "4.4-4: ours with no program folder is damaged", installed: false,
      arrange: (f) => { f.registry.registrations.edge = "ours"; },
      state: "damaged", reasons: ["program-folder-missing"],
    },
    {
      name: "4.4-4: Edge ours only (Chrome absent) with a valid state is not registration-missing when Chrome was never recorded",
      arrange: (f) => { f.fileSystem.addFile(p(f, "integration-state.json"), stateFileText({ version: 2, registeredTargets: ["edge"] })); f.registry.registrations.chrome = "absent"; },
      state: "outdated", reasons: ["registration-target-added"],
    },
    {
      name: "4.4-4: absent registration with an unrecognized folder is not-set-up", installed: false,
      arrange: (f) => { f.fileSystem.addDirectory(f.programFolder); },
      state: "not-set-up", reasons: ["program-folder-unrecognized"],
    },
  ];
  for (const row of rows) {
    it(row.name, async () => {
      const fixture = row.installed === false ? createIntegrationFixture({ installed: false }) : readyBoth();
      row.arrange(fixture);
      const result = await inspectWith(fixture, CHROME_EDGE);
      expect(result.state).toBe(row.state);
      expect([...result.reasons].sort()).toEqual([...row.reasons].sort());
      expect(result.inspectionComplete).toBe(true);
    });
  }

  it("every one of the seven states is reached", () => {
    const reached = new Set(rows.map((row) => row.state));
    for (const state of ["not-set-up", "policy-blocked", "foreign-registration", "registration-missing", "outdated", "damaged", "ready"]) expect(reached.has(state as CollectorIntegrationState)).toBe(true);
  });

  it("reports E, the per-target ownership, the aggregate and the recorded targets", async () => {
    const fixture = readyBoth();
    fixture.registry.registrations.chromium = "foreign";
    const result = await inspectWith(fixture, CHROME_EDGE);
    expect(result.expectedTargets).toEqual(["chrome", "edge"]);
    expect(result.registrations).toEqual({ chrome: "ours", edge: "ours", chromium: "foreign", vivaldi: "unknown" });
    expect(result.registration).toBe("ours");
    expect(result.registeredTargets).toEqual(["chrome", "edge"]);
    expect(result.state).toBe("ready");
  });

  it("the aggregate over E: mixed ours/absent is ours; foreign beats ours; an unreadable target in E is unknown and damaged", async () => {
    const mixed = readyBoth();
    mixed.registry.registrations.edge = "absent";
    expect((await inspectWith(mixed, CHROME_EDGE)).registration).toBe("ours");

    const foreign = readyBoth();
    foreign.registry.registrations.edge = "foreign";
    expect((await inspectWith(foreign, CHROME_EDGE)).registration).toBe("foreign");

    const unreadable = readyBoth();
    const original = unreadable.registry.readCollectorHostRegistration.bind(unreadable.registry);
    unreadable.registry.readCollectorHostRegistration = (target) => {
      if (target === "edge") throw new Error("denied");
      return original(target);
    };
    const result = await inspectWith(unreadable, CHROME_EDGE);
    expect(result).toMatchObject({ state: "damaged", inspectionComplete: false, registration: "unknown" });
    expect(result.reasons).toContain("registry-read-failed");
    expect(result.registrations.edge).toBe("unknown");
  });

  it("an unreadable target OUTSIDE E (Edge is unverified in the product table) does not make the inspection incomplete", async () => {
    const fixture = readyBoth(["chrome"]);
    const original = fixture.registry.readCollectorHostRegistration.bind(fixture.registry);
    fixture.registry.readCollectorHostRegistration = (target) => {
      if (target === "edge") throw new Error("denied");
      return original(target);
    };
    const result = await inspectWith(fixture);
    expect(result).toMatchObject({ state: "ready", inspectionComplete: true });
    expect(result.registrations.edge).toBe("unknown");
  });
});

describe("policy-blocked scope (E_all) and an empty E", () => {
  it("policy-blocked with our Chrome key: registration is ours, state policy-blocked, expectedTargets stays empty", async () => {
    const fixture = readyBoth(["chrome"]);
    fixture.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 });
    const result = await inspectWith(fixture);
    expect(result).toMatchObject({ state: "policy-blocked", registration: "ours", inspectionComplete: true, expectedTargets: [] });
  });

  it("policy-blocked with an unreadable Chrome key: inspection is incomplete (registry-read-failed) and registration unknown", async () => {
    const fixture = readyBoth(["chrome"]);
    fixture.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 });
    const original = fixture.registry.readCollectorHostRegistration.bind(fixture.registry);
    fixture.registry.readCollectorHostRegistration = (target) => {
      if (target === "chrome") throw new Error("denied");
      return original(target);
    };
    const result = await inspectWith(fixture);
    expect(result).toMatchObject({ state: "policy-blocked", inspectionComplete: false, registration: "unknown" });
    expect(result.reasons).toContain("registry-read-failed");
  });

  it("an empty E with an otherwise healthy installation is never ready", async () => {
    const fixture = readyBoth(["chrome"]);
    fixture.registry.registrations.chrome = "absent";
    const result = await inspectWith(fixture, COLLECTOR_BROWSERS.map((row) => ({ ...row, verification: "unverified" }) as CollectorBrowserSpec));
    expect(result.expectedTargets).toEqual([]);
    expect(result.state).not.toBe("ready");
  });
});

// ----- the product table: only Chrome counts today -------------------------------------------

describe("inspection with the product table (Chrome verified, Edge unverified)", () => {
  it("E is [chrome]; Edge and Chromium are read for display and never change the state", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.registrations.edge = "foreign";
    fixture.registry.registrations.chromium = "foreign";
    const result = await inspectWith(fixture);
    expect(result).toMatchObject({ state: "ready", expectedTargets: ["chrome"], registration: "ours" });
    expect(result.registrations).toMatchObject({ chrome: "ours", edge: "foreign", chromium: "foreign" });
  });

  it("a v1 state file with Chrome only is ready: nothing was added (S3 does not change today's behaviour)", async () => {
    const result = await inspectWith(createIntegrationFixture());
    expect(result).toMatchObject({ state: "ready", registeredTargets: ["chrome"], reasons: [] });
  });

  it("a v2 state file is read and its targets reported", async () => {
    const fixture = readyBoth(["chrome", "edge"]);
    const result = await inspectWith(fixture);
    expect(result).toMatchObject({ state: "ready", registeredTargets: ["chrome", "edge"] });
  });

  it("registeredTargets is null when no valid state file was read", async () => {
    expect((await inspectWith(createIntegrationFixture({ installed: false }))).registeredTargets).toBeNull();
    const garbled = createIntegrationFixture();
    garbled.fileSystem.addFile(p(garbled, "integration-state.json"), "{");
    expect((await inspectWith(garbled)).registeredTargets).toBeNull();
  });

  it("flipping Edge to verified is the only change that adds it (registry order, no duplicates)", async () => {
    const fixture = readyBoth();
    expect((await inspectWith(fixture)).expectedTargets).toEqual(["chrome"]);
    expect((await inspectWith(fixture, CHROME_EDGE)).expectedTargets).toEqual(["chrome", "edge"]);
  });

  it("Vivaldi is never inspected as a registration target (the addon table has no such target)", async () => {
    const fixture = readyBoth();
    const result = await inspectWith(fixture);
    expect(fixture.registry.targetCalls.some((call) => call.target === "vivaldi")).toBe(false);
    expect(result.registrations.vivaldi).toBe("unknown");
    expect(result.browsers.entries.find((entry) => entry.id === "vivaldi")?.effective).toEqual({ target: null, ownership: "absent" });
    // The same under a table that verifies Chrome and Edge.
    const again = readyBoth();
    await inspectWith(again, CHROME_EDGE);
    expect(again.registry.targetCalls.some((call) => call.target === "vivaldi")).toBe(false);
  });
});

// ----- Edge's fallback (design 3.5, 4.5) --------------------------------------------------------

describe("effective registration per browser", () => {
  it("Edge uses its own key, then the Chromium key, then the Chrome key", async () => {
    const own = createIntegrationFixture();
    own.registry.registrations.edge = "ours";
    expect(edgeEntry(await inspectWith(own))?.effective).toEqual({ target: "edge", ownership: "ours" });

    const viaChrome = createIntegrationFixture(); // Chrome ours, Edge and Chromium absent
    expect(edgeEntry(await inspectWith(viaChrome))?.effective).toEqual({ target: "chrome", ownership: "ours" });
    expect(chromeEntry(await inspectWith(viaChrome))?.effective).toEqual({ target: "chrome", ownership: "ours" });

    const chromiumFirst = createIntegrationFixture();
    chromiumFirst.registry.registrations.chromium = "foreign";
    expect(edgeEntry(await inspectWith(chromiumFirst))?.effective).toEqual({ target: "chromium", ownership: "foreign" });

    const nothing = createIntegrationFixture({ installed: false });
    expect(edgeEntry(await inspectWith(nothing))?.effective).toEqual({ target: null, ownership: "absent" });
  });

  it("an unreadable target on the way yields unknown rather than the next target", async () => {
    const fixture = createIntegrationFixture();
    const original = fixture.registry.readCollectorHostRegistration.bind(fixture.registry);
    fixture.registry.readCollectorHostRegistration = (target) => {
      if (target === "chromium") throw new Error("denied");
      return original(target);
    };
    const result = await inspectWith(fixture);
    expect(edgeEntry(result)?.effective).toEqual({ target: null, ownership: "unknown" });
    expect(result.state).toBe("ready"); // Chromium is outside E
  });

  it("a foreign Edge key is reported for Edge but is not an aggregate problem while Edge is unverified", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.registrations.edge = "foreign";
    const result = await inspectWith(fixture);
    expect(edgeEntry(result)?.effective).toEqual({ target: "edge", ownership: "foreign" });
    expect(result.state).toBe("ready");
  });
});

// ----- per-browser policy ------------------------------------------------------------------------

describe("per-browser policy (design 4.4-1, 8.4)", () => {
  it("reads each row's own policy root", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.edgePolicies = policies({ nativeMessagingUserLevelHosts: 0 });
    const result = await inspectWith(fixture);
    expect(edgeEntry(result)?.policy).toMatchObject({ blocked: true, userLevelHostsDisabled: true, status: "read" });
    expect(chromeEntry(result)?.policy).toMatchObject({ blocked: false, status: "read" });
    expect(result.browsers.entries.find((entry) => entry.id === "vivaldi")?.policy).toMatchObject({ blocked: false, status: "not-applicable" });
    // Edge is not verified: its block does not touch the aggregate.
    expect(result.policy).toMatchObject({ blocked: false, status: "read" });
    expect(result.state).toBe("ready");
  });

  it("the aggregate blocks only when every verified browser is blocked", async () => {
    const both = readyBoth();
    both.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 });
    both.registry.edgePolicies = policies({}, { nativeMessagingBlocklist: ["org.maginalia.collector"] });
    expect((await inspectWith(both, CHROME_EDGE)).policy).toMatchObject({ blocked: true, userLevelHostsDisabled: true, hostBlocked: true });

    const one = readyBoth();
    one.registry.policies = policies({ nativeMessagingUserLevelHosts: 0 });
    const partial = await inspectWith(one, CHROME_EDGE);
    expect(partial.policy).toMatchObject({ blocked: false, userLevelHostsDisabled: false, hostBlocked: false });
    expect(chromeEntry(partial)?.policy.blocked).toBe(true);
    expect(partial.state).toBe("ready");
    expect(partial.expectedTargets).toEqual(["edge"]);
  });

  it("an unreadable policy of one browser never blocks and is reported as unavailable", async () => {
    const fixture = readyBoth();
    const original = fixture.registry.readBrowserPolicies.bind(fixture.registry);
    fixture.registry.readBrowserPolicies = (root) => {
      if (root === "Microsoft\\Edge") throw new Error("denied");
      return original(root);
    };
    const result = await inspectWith(fixture, CHROME_EDGE);
    expect(edgeEntry(result)?.policy).toMatchObject({ blocked: false, status: "unavailable" });
    expect(result.policy.status).toBe("unavailable");
    expect(result.state).toBe("ready");
  });

  it("a verified row without a policy root never blocks", async () => {
    const table = tableWithVerified("vivaldi");
    const fixture = createIntegrationFixture();
    const result = await inspectWith(fixture, table);
    expect(result.policy).toMatchObject({ blocked: false, status: "read" });
  });
});

// ----- expected set E (design 3.1) ----------------------------------------------------------------

describe("computeExpectedTargets", () => {
  type Facts = { installed: "found" | "not-found" | "unknown"; policy: { userLevelHostsDisabled: boolean; hostBlocked: boolean; blocked: boolean; extensionLoadMayBeBlocked: boolean } };
  const found: Facts = { installed: "found", policy: { userLevelHostsDisabled: false, hostBlocked: false, blocked: false, extensionLoadMayBeBlocked: false } };
  const missing: Facts = { ...found, installed: "not-found" };
  const blocked = { ...found, policy: { ...found.policy, blocked: true } };
  const detected = (entries: Record<string, Facts>) => new Map(Object.entries(entries)) as never;

  /** A verified Vivaldi row that owns the `vivaldi` target and registers only when present. */
  const vivaldiWhenPresent: CollectorBrowserSpec = {
    ...(tableWithVerified("vivaldi").find((row) => row.id === "vivaldi") as CollectorBrowserSpec),
    nativeMessaging: { lookupOrder: ["vivaldi", "chrome"], ownTargets: ["vivaldi"], registration: "when-present" },
  };
  const withVivaldi = [...tableWithVerified("chrome", "edge").filter((row) => row.id !== "vivaldi"), vivaldiWhenPresent];

  it("always-rows count regardless of installation; unverified rows never count", () => {
    expect(computeExpectedTargets(COLLECTOR_BROWSERS, detected({ chrome: missing, edge: missing, vivaldi: missing }), null)).toEqual(["chrome"]);
    expect(computeExpectedTargets(CHROME_EDGE, detected({ chrome: missing, edge: missing, vivaldi: missing }), null)).toEqual(["chrome", "edge"]);
  });

  it("a policy-blocked row contributes nothing", () => {
    expect(computeExpectedTargets(CHROME_EDGE, detected({ chrome: blocked, edge: found, vivaldi: found }), null)).toEqual(["edge"]);
    expect(computeExpectedTargets(CHROME_EDGE, detected({ chrome: blocked, edge: blocked, vivaldi: found }), null)).toEqual([]);
  });

  it("a when-present row counts when the browser is found or its target was registered before", () => {
    const base = { chrome: found, edge: found };
    expect(computeExpectedTargets(withVivaldi, detected({ ...base, vivaldi: missing }), null)).toEqual(["chrome", "edge"]);
    expect(computeExpectedTargets(withVivaldi, detected({ ...base, vivaldi: found }), null)).toEqual(["chrome", "edge", "vivaldi"]);
    expect(computeExpectedTargets(withVivaldi, detected({ ...base, vivaldi: missing }), ["chrome"])).toEqual(["chrome", "edge"]);
    expect(computeExpectedTargets(withVivaldi, detected({ ...base, vivaldi: missing }), ["chrome", "vivaldi"])).toEqual(["chrome", "edge", "vivaldi"]);
    expect(computeExpectedTargets(withVivaldi, detected({ ...base, vivaldi: { ...found, policy: { ...found.policy, blocked: true } } }), ["vivaldi"])).toEqual(["chrome", "edge"]);
  });
});

describe("inspection of a verified when-present browser", () => {
  const vivaldi: CollectorBrowserSpec = {
    ...(tableWithVerified("vivaldi").find((row) => row.id === "vivaldi") as CollectorBrowserSpec),
    nativeMessaging: { lookupOrder: ["vivaldi", "chrome"], ownTargets: ["vivaldi"], registration: "when-present" },
  };
  const table = [...COLLECTOR_BROWSERS.filter((row) => row.id !== "vivaldi"), vivaldi];

  function withAddon(fixture: IntegrationFixture): IntegrationFixture {
    fixture.registry.inspectableTargets = ["chrome", "edge", "chromium", "vivaldi"];
    return fixture;
  }

  it("an absent Vivaldi key matters only once Vivaldi is installed", async () => {
    const without = withAddon(createIntegrationFixture());
    expect(await inspectWith(without, table)).toMatchObject({ state: "ready", expectedTargets: ["chrome"] });

    const installed = withAddon(createIntegrationFixture());
    const exe = "C:\\Users\\tester\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe";
    installed.fileSystem.addFile(exe, "x");
    installed.registry.appPathsByName["vivaldi.exe"] = [{ source: "hkcu", value: exe }];
    const result = await inspectWith(installed, table);
    expect(result.expectedTargets).toEqual(["chrome", "vivaldi"]);
    // v1 state records Chrome only: the new target means a (refreshable) outdated installation.
    expect(result).toMatchObject({ state: "outdated", reasons: ["registration-target-added"] });
    installed.registry.registrations.vivaldi = "ours";
    expect((await inspectWith(installed, table)).state).toBe("ready");
  });

  it("a foreign Vivaldi key is ignored until Vivaldi is expected, then is a foreign-registration", async () => {
    const fixture = withAddon(createIntegrationFixture());
    fixture.registry.registrations.vivaldi = "foreign";
    expect((await inspectWith(fixture, table)).state).toBe("ready");
    const exe = "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe";
    fixture.fileSystem.addFile(exe, "x");
    fixture.registry.appPathsByName["vivaldi.exe"] = [{ source: "hklm-64", value: exe }];
    expect(await inspectWith(fixture, table)).toMatchObject({ state: "foreign-registration", reasons: ["registration-foreign"] });
  });
});

// ----- state file v2 -------------------------------------------------------------------------------

describe("integration state file v1 and v2 (design 4.3)", () => {
  it("v1 (five fields) reads as registeredTargets = [chrome]", () => {
    expect(parseIntegrationStateFile(stateFileText())).toMatchObject({ version: 1, registeredTargets: ["chrome"] });
  });

  it("v2 carries registeredTargets, normalized to registry order", () => {
    expect(parseIntegrationStateFile(stateFileText({ version: 2, registeredTargets: ["edge", "chrome"] }))).toMatchObject({ version: 2, registeredTargets: ["chrome", "edge"] });
    expect(parseIntegrationStateFile(stateFileText({ version: 2, registeredTargets: [] }))).toMatchObject({ version: 2, registeredTargets: [] });
  });

  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["v2 without registeredTargets", stateFileText({ version: 2 })],
    ["v1 with registeredTargets (six fields)", stateFileText({ registeredTargets: ["chrome"] })],
    ["v2 with a seventh field", stateFileText({ version: 2, registeredTargets: ["chrome"], extra: 1 })],
    ["v3", stateFileText({ version: 3, registeredTargets: ["chrome"] })],
    ["an unknown target id", stateFileText({ version: 2, registeredTargets: ["brave"] })],
    ["a read-only target (chromium)", stateFileText({ version: 2, registeredTargets: ["chromium"] })],
    ["a target that is not writable yet (vivaldi)", stateFileText({ version: 2, registeredTargets: ["vivaldi"] })],
    ["a duplicate", stateFileText({ version: 2, registeredTargets: ["chrome", "chrome"] })],
    ["a non-array", stateFileText({ version: 2, registeredTargets: "chrome" })],
    ["a non-string entry", stateFileText({ version: 2, registeredTargets: [1] })],
    ["a path-like entry", stateFileText({ version: 2, registeredTargets: ["C:\\x"] })],
  ];
  for (const [name, text] of invalid) {
    it(`rejects ${name}`, () => {
      expect(parseIntegrationStateFile(text)).toBeUndefined();
    });
  }

  it("an invalid v2 file in the installation is a damaged state-file-invalid", async () => {
    const fixture = createIntegrationFixture();
    fixture.fileSystem.addFile(p(fixture, "integration-state.json"), stateFileText({ version: 2, registeredTargets: ["brave"] }));
    expect(await inspectWith(fixture)).toMatchObject({ state: "damaged", reasons: ["state-file-invalid"] });
  });
});

// ----- browsers, default and recommendation -----------------------------------------------------------

describe("browsers: default browser, detection and recommendation", () => {
  function installEdge(fixture: IntegrationFixture): void {
    const exe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    fixture.fileSystem.addFile(exe, "x");
    fixture.registry.appPathsByName["msedge.exe"] = [{ source: "hklm-32", value: exe }];
  }
  function installChrome(fixture: IntegrationFixture): void {
    fixture.fileSystem.addFile("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "x");
  }

  it("detects each row and reports where it was found (never a path)", async () => {
    const fixture = createIntegrationFixture();
    installEdge(fixture);
    installChrome(fixture);
    const result = await inspectWith(fixture);
    expect(edgeEntry(result)).toMatchObject({ verification: "unverified", installed: "found", source: "app-paths-hklm-32" });
    expect(chromeEntry(result)).toMatchObject({ verification: "verified", installed: "found", source: "known-program-files" });
    expect(result.browsers.entries.find((entry) => entry.id === "vivaldi")).toMatchObject({ installed: "not-found", source: null });
    expect(result.browsers.entries.map((entry) => entry.id)).toEqual(["edge", "chrome", "vivaldi"]);
    expect(JSON.stringify(result.browsers)).not.toMatch(/[A-Za-z]:\\|tester|AppData|Program Files|\.exe|\\\\/iu);
  });

  it("default Vivaldi (unverified) with Chrome installed recommends Chrome, the only verified row", async () => {
    const fixture = createIntegrationFixture();
    installChrome(fixture);
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    const result = await inspectWith(fixture);
    expect(result.browsers).toMatchObject({ defaultBrowser: "vivaldi", recommended: "chrome", recommendationReason: "default-unverified" });
  });

  it("with Edge verified and installed, a Vivaldi default recommends Edge (owner decision 2)", async () => {
    const fixture = createIntegrationFixture();
    installEdge(fixture);
    installChrome(fixture);
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    expect((await inspectWith(fixture, CHROME_EDGE)).browsers).toMatchObject({ defaultBrowser: "vivaldi", recommended: "edge", recommendationReason: "default-unverified" });
    fixture.registry.defaultBrowserProgId = "ChromeHTML";
    expect((await inspectWith(fixture, CHROME_EDGE)).browsers).toMatchObject({ defaultBrowser: "chrome", recommended: "chrome", recommendationReason: "default-supported" });
  });

  it("a policy-blocked default is not recommended", async () => {
    const fixture = readyBoth();
    installEdge(fixture);
    installChrome(fixture);
    fixture.registry.defaultBrowserProgId = "MSEdgeHTM";
    fixture.registry.edgePolicies = policies({ nativeMessagingUserLevelHosts: 0 });
    expect((await inspectWith(fixture, CHROME_EDGE)).browsers).toMatchObject({ defaultBrowser: "edge", recommended: "chrome" });
  });

  it("nothing installed: no recommendation; a failing default read is unknown and never blocks", async () => {
    const fixture = createIntegrationFixture();
    fixture.registry.failNext.readDefaultBrowserProgId = new Error("denied");
    const result = await inspectWith(fixture);
    expect(result.browsers).toMatchObject({ defaultBrowser: "unknown", recommended: null, recommendationReason: "none-installed" });
    expect(result.state).toBe("ready");
  });

  it("the Chrome row and the default browser are read from the browsers view alone", async () => {
    const fixture = createIntegrationFixture();
    installChrome(fixture);
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    const result = await inspectWith(fixture);
    expect(result.browsers.entries.find((entry) => entry.id === "chrome")).toMatchObject({ installed: "found", source: "known-program-files" });
    expect(result.browsers.defaultBrowser).toBe("vivaldi");
    expect(result).not.toHaveProperty("chrome");
  });
});

// ----- locateBrowserExecutable (design 1.5) -----------------------------------------------------------------

describe("locateBrowserExecutable", () => {
  const USER = "C:\\Users\\tester\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe";
  const MACHINE = "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe";

  /** The owner's machine: Vivaldi installed per user (HKCU App Paths) and machine-wide (HKLM App Paths). */
  function twoInstalls(): IntegrationFixture {
    const fixture = createIntegrationFixture({ installed: false });
    fixture.fileSystem.addFile(USER, "x");
    fixture.fileSystem.addFile(MACHINE, "x");
    fixture.registry.appPathsByName["vivaldi.exe"] = [{ source: "hkcu", value: USER }, { source: "hklm-64", value: MACHINE }];
    return fixture;
  }
  const locate = (fixture: IntegrationFixture, options?: { defaultProgId?: string | null }) => locateBrowserExecutable("vivaldi", fixture.dependencies, options);

  it("without a matching default ProgId the order is App Paths HKCU, HKLM 64, HKLM 32, then known folders", async () => {
    const fixture = twoInstalls();
    expect(await locate(fixture)).toMatchObject({ status: "found", source: "app-paths-hkcu", executablePath: USER });
    fixture.fileSystem.remove(USER);
    expect(await locate(fixture)).toMatchObject({ status: "found", source: "app-paths-hklm-64", executablePath: MACHINE });
  });

  it("the default ProgId's open command picks the machine-wide install when it names that candidate", async () => {
    const fixture = twoInstalls();
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}" --single-argument %1`;
    expect(await locate(fixture)).toMatchObject({ status: "found", source: "app-paths-hklm-64", executablePath: MACHINE });
  });

  it("the open command may match case-insensitively", async () => {
    const fixture = twoInstalls();
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE.toUpperCase()}" -- %1`;
    expect(await locate(fixture)).toMatchObject({ status: "found", executablePath: MACHINE });
  });

  it("an unquoted open command is cut at the first space (design 1.5)", async () => {
    const fixture = twoInstalls();
    fixture.registry.appPathsByName["vivaldi.exe"] = [{ source: "hkcu", value: MACHINE }, { source: "hklm-64", value: USER }];
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `${USER} -- %1`; // no spaces in this path
    expect(await locate(fixture)).toMatchObject({ source: "app-paths-hklm-64", executablePath: USER });
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `${MACHINE} -- %1`; // cut at "C:\Program": no candidate
    expect(await locate(fixture)).toMatchObject({ source: "app-paths-hkcu", executablePath: MACHINE });
  });

  it("the open command may pick a known-folder candidate that is not in App Paths", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    fixture.fileSystem.addFile(USER, "x");
    fixture.fileSystem.addFile(MACHINE, "x");
    fixture.registry.appPathsByName["vivaldi.exe"] = [{ source: "hkcu", value: USER }];
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}" "%1"`;
    expect(await locate(fixture)).toMatchObject({ status: "found", source: "known-program-files", executablePath: MACHINE });
  });

  const fallbacks: ReadonlyArray<readonly [string, (f: IntegrationFixture) => void]> = [
    ["the command names an executable that is not a candidate", (f) => { f.registry.progIdOpenCommands["VivaldiHTM"] = "\"C:\\Elsewhere\\vivaldi.exe\" %1"; }],
    ["the command names a candidate that fails validation", (f) => { f.fileSystem.setReparse(MACHINE, true); f.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}" %1`; }],
    ["there is no open command", () => {}],
    ["the open command is empty or unterminated", (f) => { f.registry.progIdOpenCommands["VivaldiHTM"] = "\""; }],
    ["the open command read fails", (f) => { f.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}"`; f.registry.failNext.readProgIdOpenCommand = new Error("denied"); }],
    ["the default ProgId is another browser's", (f) => { f.registry.defaultBrowserProgId = "ChromeHTML"; f.registry.progIdOpenCommands["ChromeHTML"] = `"${MACHINE}"`; }],
    ["the default ProgId read fails", (f) => { f.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}"`; f.registry.failNext.readDefaultBrowserProgId = new Error("denied"); }],
  ];
  for (const [name, arrange] of fallbacks) {
    it(`falls back to HKCU App Paths when ${name}`, async () => {
      const fixture = twoInstalls();
      fixture.registry.defaultBrowserProgId = "VivaldiHTM";
      arrange(fixture);
      expect(await locate(fixture)).toMatchObject({ status: "found", source: "app-paths-hkcu", executablePath: USER });
    });
  }

  it("a caller that already read the ProgId passes it and the registry is not asked again", async () => {
    const fixture = twoInstalls();
    fixture.registry.defaultBrowserProgId = "ChromeHTML";
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}"`;
    expect(await locate(fixture, { defaultProgId: "VivaldiHTM" })).toMatchObject({ executablePath: MACHINE });
    expect(fixture.registry.calls.filter((call) => call === "readDefaultBrowserProgId")).toHaveLength(0);
    expect(await locate(fixture, { defaultProgId: null })).toMatchObject({ executablePath: USER });
  });

  it("a ProgId that is not a plain name yields no preference (the fake mirrors the real adapter's check)", async () => {
    const fixture = twoInstalls();
    fixture.registry.progIdOpenCommands["Evil\\..\\X"] = `"${MACHINE}"`;
    expect(await locate(fixture, { defaultProgId: "VivaldiHTM\\..\\X" })).toMatchObject({ executablePath: USER });
  });

  it("each row validates its own file name, and is not-found or unknown like the Chrome locator", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    fixture.fileSystem.addFile("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "x");
    fixture.registry.appPathsByName["vivaldi.exe"] = [{ source: "hkcu", value: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }];
    const result = await locate(fixture);
    expect(result).toMatchObject({ status: "not-found" });
    if (result.status === "not-found") expect(result.rejected[0]).toEqual({ source: "app-paths-hkcu", reason: "wrong-basename" });
    fixture.registry.failNext.readBrowserAppPaths = new Error("denied");
    expect(await locate(fixture)).toEqual({ status: "unknown" });
  });

  it("Edge: known folders are searched in the row's order (Program Files (x86) first)", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    const x86 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const x64 = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
    fixture.fileSystem.addFile(x64, "x");
    fixture.fileSystem.addFile(x86, "x");
    expect(await locateBrowserExecutable("edge", fixture.dependencies)).toMatchObject({ source: "known-program-files-x86", executablePath: x86 });
  });

  it("an id that is not in the table is unknown", async () => {
    const fixture = createIntegrationFixture({ installed: false });
    expect(await locateBrowserExecutable("brave" as never, fixture.dependencies)).toEqual({ status: "unknown" });
  });

  it("the locator reads the registry and file system only (no write call)", async () => {
    const fixture = twoInstalls();
    fixture.registry.defaultBrowserProgId = "VivaldiHTM";
    fixture.registry.progIdOpenCommands["VivaldiHTM"] = `"${MACHINE}"`;
    await locate(fixture);
    expect(fixture.registry.calls.every((call) => call.startsWith("get") || call.startsWith("read"))).toBe(true);
    expect(fixture.fileSystem.calls.every((call) => call.method === "stat")).toBe(true);
  });
});

describe("privacy of the per-browser result", () => {
  it("no path appears anywhere except extensionFolderDisplay", async () => {
    const fixture = readyBoth();
    fixture.fileSystem.addFile("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "x");
    fixture.fileSystem.addFile("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "x");
    fixture.registry.defaultBrowserProgId = "MSEdgeHTM";
    const result = await inspectWith(fixture, CHROME_EDGE);
    const { extensionFolderDisplay, ...rest } = result;
    expect(extensionFolderDisplay).toBe(path.win32.join(fixture.programFolder, "extension"));
    expect(JSON.stringify(rest)).not.toMatch(/[A-Za-z]:\\|tester|AppData|Program Files|\.exe|\\\\/iu);
  });
});
