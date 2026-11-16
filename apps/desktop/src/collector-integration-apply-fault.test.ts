/**
 * Fault injection after EACH write step (WP-5b requirement 8). A "crash" lets the Nth mutation
 * run and then makes every later mutation fail (the process died); a "failure" makes only the
 * Nth mutation fail while the module keeps running its own error handling.
 *
 * After every injected fault:
 *  (a) the previous working installation still works, or the state is registration-missing /
 *      damaged / not-set-up / outdated with a deterministic one-step recovery;
 *  (b) no partial manifest or state file is ever readable under its final name;
 *  (c) nothing outside the program folder and the integration folders changed.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCollectorIntegration } from "./collector-integration-apply";
import type { CollectorApplyRequest, CollectorApplyResult } from "./collector-integration-apply-types";
import { expectedHostManifest, inspectCollectorIntegration, parseIntegrationStateFile } from "./collector-integration";
import { COLLECTOR_HOST_EXECUTABLE_NAME } from "./collector-payload";
import { HOST_SOURCE_FILES, SOURCE_EXTENSION_FOLDER, SOURCE_HOST_FOLDER, applyDescriptor, createApplyFixture, extensionSourceFiles, type ApplyFixture } from "./collector-integration-apply.test-helper";
import { fakeKey, sha256 } from "./collector-integration.test-helper";
import { COLLECTOR_HOST_ADDON_NAME } from "./collector-payload";

const run = (fixture: ApplyFixture, request: CollectorApplyRequest): Promise<CollectorApplyResult> => applyCollectorIntegration(request, fixture.deps);
const p = (fixture: ApplyFixture, ...parts: string[]): string => path.win32.join(fixture.programFolder, ...parts);

async function installed(fixture: ApplyFixture): Promise<ApplyFixture> {
  expect((await run(fixture, { action: "setup" })).outcome).toBe("applied");
  return fixture;
}

async function outdated(fixture: ApplyFixture): Promise<ApplyFixture> {
  await installed(fixture);
  fixture.fileSystem.setBytes(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), "host-executable-bytes-v2");
  fixture.payload = applyDescriptor({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0", extensionVersion: "0.4.0", host: { ...HOST_SOURCE_FILES, [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes-v2" } });
  for (const [name, content] of Object.entries(extensionSourceFiles("0.4.0"))) fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, ...name.split("/")), content);
  return fixture;
}

function damagedSlot(fixture: ApplyFixture): void {
  fixture.fileSystem.setBytes(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME), "tampered");
}

/** Total mutations of one fault-free run of the scenario. */
async function countMutations(prepare: () => Promise<ApplyFixture>, request: CollectorApplyRequest): Promise<number> {
  const fixture = await prepare();
  fixture.fileSystem.mutations.length = 0;
  const before = fixture.fileSystem.mutationCount;
  const result = await run(fixture, request);
  expect(result.outcome).toBe("applied");
  return fixture.fileSystem.mutationCount - before;
}

function allowedRoots(fixture: ApplyFixture): string[] {
  return [fakeKey(fixture.programFolder), fakeKey(fixture.applicationRoot)];
}

/** Contents a Host file may legitimately have at any point: the packaged bytes of either payload. */
const HOST_BYTES_ACCEPTABLE = [HOST_SOURCE_FILES[COLLECTOR_HOST_EXECUTABLE_NAME] as string, "host-executable-bytes-v2", HOST_SOURCE_FILES[COLLECTOR_HOST_ADDON_NAME] as string];

/**
 * Design 6.3 invariant, checked at every crash point: registration is ours AND the manifest on
 * disk is a valid generated one => the slot it points at holds a complete Host (both files present
 * and the exact packaged bytes). `tolerated` lists contents that were already there before the
 * scenario started (for example a tampered file that a repair is meant to fix).
 */
function assertPointedSlotComplete(fixture: ApplyFixture, label: string, tolerated: readonly string[] = []): void {
  if (fixture.registry.registration !== "ours") return;
  const manifestPath = p(fixture, "org.maginalia.collector.json");
  if (!fixture.fileSystem.has(manifestPath)) return;
  const manifest = JSON.parse(fixture.fileSystem.text(manifestPath)) as unknown;
  const slot = ([["a", expectedHostManifest("a")], ["b", expectedHostManifest("b")]] as const).find(([, expected]) => JSON.stringify(expected) === JSON.stringify(manifest))?.[0];
  if (slot === undefined) return;
  const acceptable = new Set([...HOST_BYTES_ACCEPTABLE, ...tolerated].map(sha256));
  for (const name of [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME]) {
    const target = p(fixture, `host-${slot}`, name);
    expect(fixture.fileSystem.has(target), `${label}: pointed slot ${slot} lacks ${name}`).toBe(true);
    expect(acceptable.has(sha256(fixture.fileSystem.bytes(target))), `${label}: pointed slot ${slot} holds foreign/partial ${name}`).toBe(true);
  }
}

function assertInvariants(fixture: ApplyFixture, before: Map<string, string>, label: string, tolerated: readonly string[] = []): void {
  assertPointedSlotComplete(fixture, label, tolerated);
  // (b) manifest and state under their final names are always complete and valid
  const manifestPath = p(fixture, "org.maginalia.collector.json");
  if (fixture.fileSystem.has(manifestPath)) {
    const manifest = JSON.parse(fixture.fileSystem.text(manifestPath)) as unknown;
    expect([expectedHostManifest("a"), expectedHostManifest("b")], `${label}: manifest`).toContainEqual(manifest);
  }
  const statePath = p(fixture, "integration-state.json");
  if (fixture.fileSystem.has(statePath)) expect(parseIntegrationStateFile(fixture.fileSystem.text(statePath)), `${label}: state`).toBeDefined();
  // (c) nothing outside the program folder and the integration folders changed
  for (const [key, value] of fixture.fileSystem.snapshot()) {
    if (allowedRoots(fixture).some((root) => key === root || key.startsWith(`${root}\\`))) continue;
    expect(before.get(key), `${label}: ${key}`).toBe(value);
  }
  for (const key of before.keys()) {
    if (allowedRoots(fixture).some((root) => key === root || key.startsWith(`${root}\\`))) continue;
    expect(fixture.fileSystem.snapshot().has(key), `${label}: lost ${key}`).toBe(true);
  }
  // the registry only ever holds our value or nothing, never a foreign one
  expect(fixture.registry.registration, label).not.toBe("foreign");
}

/** The single deterministic recovery step for whatever state the fault left behind. */
async function recover(fixture: ApplyFixture, label: string): Promise<void> {
  fixture.fileSystem.crashAfter = null;
  fixture.fileSystem.failAt = null;
  const inspection = await inspectCollectorIntegration(fixture.deps);
  const action: CollectorApplyRequest["action"] | null = ({
    "not-set-up": "setup",
    "registration-missing": "repair",
    damaged: "repair",
    outdated: "refresh",
    ready: null,
  } as Record<string, CollectorApplyRequest["action"] | null>)[inspection.state] ?? null;
  expect(["not-set-up", "registration-missing", "damaged", "outdated", "ready"], `${label}: state ${inspection.state}`).toContain(inspection.state);
  if (action !== null) {
    const result = await run(fixture, { action });
    expect(result.outcome, `${label}: ${action} from ${inspection.state} -> ${result.reason}`).toBe("applied");
  }
  const final = await inspectCollectorIntegration(fixture.deps);
  expect(final.state, `${label}: after recovery`).toBe("ready");
  expect(final.filesVerified, label).toBe(true);
  expect(fixture.fileSystem.has(p(fixture, "extension.next")), label).toBe(false);
}

describe("crash after each write step of a first setup", () => {
  it("every crash point is recoverable in one step", async () => {
    const total = await countMutations(async () => createApplyFixture(), { action: "setup" });
    expect(total).toBeGreaterThan(20);
    for (let step = 0; step < total; step += 1) {
      const fixture = createApplyFixture();
      const before = fixture.fileSystem.snapshot();
      fixture.fileSystem.crashAfter = step;
      const result = await run(fixture, { action: "setup" });
      const label = `crash after mutation ${step}`;
      expect(["applied", "failed", "refused"], label).toContain(result.outcome);
      assertInvariants(fixture, before, label);
      const state = (await inspectCollectorIntegration(fixture.deps)).state;
      // Chrome only ever sees a registration once manifest and slot are complete.
      if (fixture.registry.registration === "ours") {
        expect(fixture.fileSystem.has(p(fixture, "org.maginalia.collector.json")), label).toBe(true);
        expect(fixture.fileSystem.has(p(fixture, "host-a", COLLECTOR_HOST_EXECUTABLE_NAME)), label).toBe(true);
      }
      expect(["not-set-up", "damaged", "registration-missing"], `${label}: ${state}`).toContain(state);
      await recover(fixture, label);
    }
  });

  it("a single failed write at each step is reported, leaves valid files, and a second run converges", async () => {
    const total = await countMutations(async () => createApplyFixture(), { action: "setup" });
    for (let step = 1; step <= total; step += 1) {
      const fixture = createApplyFixture();
      const before = fixture.fileSystem.snapshot();
      fixture.fileSystem.failAt = step;
      const result = await run(fixture, { action: "setup" });
      const label = `failure of mutation ${step}`;
      expect(["applied", "failed", "refused"], label).toContain(result.outcome);
      assertInvariants(fixture, before, label);
      if (result.outcome === "failed") expect(result.reason, label).not.toBeNull();
      await recover(fixture, label);
    }
  });

  it("results never leak a path through the reason or warnings after any fault", async () => {
    const total = await countMutations(async () => createApplyFixture(), { action: "setup" });
    for (let step = 0; step < total; step += 1) {
      const fixture = createApplyFixture();
      fixture.fileSystem.crashAfter = step;
      const result = await run(fixture, { action: "setup" });
      expect(JSON.stringify({ outcome: result.outcome, reason: result.reason, warnings: result.warnings, state: result.state })).not.toMatch(/[A-Za-z]:\\|tester/u);
    }
  });
});

describe("crash after each write step of a refresh (previous installation keeps working)", () => {
  it("until the manifest switch the previous manifest, state and Host are untouched", async () => {
    const total = await countMutations(async () => outdated(createApplyFixture()), { action: "refresh" });
    expect(total).toBeGreaterThan(20);
    for (let step = 0; step < total; step += 1) {
      const fixture = await outdated(createApplyFixture());
      const before = fixture.fileSystem.snapshot();
      const oldManifest = fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json"));
      const oldState = fixture.fileSystem.text(p(fixture, "integration-state.json"));
      const oldHost = [...fixture.fileSystem.snapshot()].filter(([key]) => key.startsWith(fakeKey(p(fixture, "host-a"))));
      fixture.fileSystem.mutations.length = 0;
      fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + step;
      const result = await run(fixture, { action: "refresh" });
      const label = `refresh crash after mutation ${step}`;
      expect(["applied", "failed", "refused"], label).toContain(result.outcome);
      assertInvariants(fixture, before, label);
      const manifestSwitched = fixture.fileSystem.mutations.some((entry) => entry.startsWith("rename-file") && entry.endsWith("org.maginalia.collector.json"));
      if (!manifestSwitched) {
        expect(fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json")), label).toBe(oldManifest);
        expect(fixture.fileSystem.text(p(fixture, "integration-state.json")), label).toBe(oldState);
        expect([...fixture.fileSystem.snapshot()].filter(([key]) => key.startsWith(fakeKey(p(fixture, "host-a")))), label).toEqual(oldHost);
        expect(fixture.registry.registration, label).toBe("ours");
        // the old Host is still the one Chrome would start
        expect(JSON.parse(fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json")))).toEqual(expectedHostManifest("a"));
      }
      // the previous extension folder is complete or restorable
      const hasExtension = fixture.fileSystem.has(p(fixture, "extension", "manifest.json"));
      const hasPrevious = fixture.fileSystem.has(p(fixture, "extension.prev", "manifest.json"));
      expect(hasExtension || hasPrevious, label).toBe(true);
      await recover(fixture, label);
      expect((await inspectCollectorIntegration(fixture.deps)).installed.payloadId, label).toBe("1.3.0+def5678");
    }
  });

  it("a single failed write at each step never loses the previous extension folder", async () => {
    const total = await countMutations(async () => outdated(createApplyFixture()), { action: "refresh" });
    for (let step = 1; step <= total; step += 1) {
      const fixture = await outdated(createApplyFixture());
      const before = fixture.fileSystem.snapshot();
      fixture.fileSystem.failAt = fixture.fileSystem.mutationCount + step;
      const result = await run(fixture, { action: "refresh" });
      const label = `refresh failure of mutation ${step}`;
      expect(["applied", "failed", "refused"], label).toContain(result.outcome);
      assertInvariants(fixture, before, label);
      expect(fixture.fileSystem.has(p(fixture, "extension", "manifest.json")) || fixture.fileSystem.has(p(fixture, "extension.prev", "manifest.json")), label).toBe(true);
      await recover(fixture, label);
    }
  });
});

describe("crash after each write step of a repair", () => {
  it("repair of a tampered Host slot is recoverable after every crash point", async () => {
    const prepare = async (): Promise<ApplyFixture> => {
      const fixture = await installed(createApplyFixture());
      damagedSlot(fixture);
      return fixture;
    };
    const total = await countMutations(prepare, { action: "repair" });
    for (let step = 0; step < total; step += 1) {
      const fixture = await prepare();
      const before = fixture.fileSystem.snapshot();
      fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + step;
      const result = await run(fixture, { action: "repair" });
      const label = `repair crash after mutation ${step}`;
      expect(["applied", "failed", "refused"], label).toContain(result.outcome);
      assertInvariants(fixture, before, label, ["tampered"]);
      await recover(fixture, label);
    }
  });

  it("repair of a missing registration (registry write is the only step that matters) is recoverable", async () => {
    const prepare = async (): Promise<ApplyFixture> => {
      const fixture = await installed(createApplyFixture());
      fixture.registry.registration = "absent";
      return fixture;
    };
    const total = await countMutations(prepare, { action: "repair" });
    for (let step = 0; step < total; step += 1) {
      const fixture = await prepare();
      const before = fixture.fileSystem.snapshot();
      fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + step;
      await run(fixture, { action: "repair" });
      assertInvariants(fixture, before, `registration repair crash ${step}`);
      await recover(fixture, `registration repair crash ${step}`);
    }
  });

  it("an interrupted repair that already replaced a foreign registration is still converged by repair", async () => {
    const prepare = async (): Promise<ApplyFixture> => {
      const fixture = await installed(createApplyFixture());
      fixture.registry.registration = "foreign";
      return fixture;
    };
    const fixture = await prepare();
    fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + 1000; // never reached
    expect((await run(fixture, { action: "repair", confirmReplaceForeign: true })).outcome).toBe("applied");
  });
});

describe("a crash inside the repair that follows a crash (design 6.3 invariant at every point)", () => {
  const recommended = (state: string): CollectorApplyRequest["action"] | null => ({
    "not-set-up": "setup",
    "registration-missing": "repair",
    damaged: "repair",
    outdated: "refresh",
  } as Record<string, CollectorApplyRequest["action"]>)[state] ?? null;

  async function crashed(prepare: () => Promise<ApplyFixture>, request: CollectorApplyRequest, step: number): Promise<ApplyFixture> {
    const fixture = await prepare();
    fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + step;
    await run(fixture, request);
    fixture.fileSystem.crashAfter = null;
    fixture.fileSystem.failAt = null;
    return fixture;
  }

  async function nestedCrashes(prepare: () => Promise<ApplyFixture>, request: CollectorApplyRequest, tolerated: readonly string[] = []): Promise<number> {
    const total = await countMutations(prepare, request);
    let exercised = 0;
    for (let first = 0; first < total; first += 1) {
      const probe = await crashed(prepare, request, first);
      assertPointedSlotComplete(probe, `first crash ${first}`, tolerated);
      const action = recommended((await inspectCollectorIntegration(probe.deps)).state);
      if (action === null) continue;
      const before = probe.fileSystem.mutationCount;
      expect((await run(probe, { action })).outcome, `first crash ${first}: ${action}`).toBe("applied");
      const repairTotal = probe.fileSystem.mutationCount - before;
      for (let second = 0; second < repairTotal; second += 1) {
        const fixture = await crashed(prepare, request, first);
        const label = `crash ${first} then ${action} crash ${second}`;
        const snapshot = fixture.fileSystem.snapshot();
        fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + second;
        await run(fixture, { action });
        assertInvariants(fixture, snapshot, label, tolerated);
        await recover(fixture, label);
        exercised += 1;
      }
    }
    return exercised;
  }

  it("refresh: crash, then crash again at every step of the repair", async () => {
    expect(await nestedCrashes(async () => outdated(createApplyFixture()), { action: "refresh" })).toBeGreaterThan(100);
  }, 120_000);

  it("first setup: crash, then crash again at every step of the recovery", async () => {
    expect(await nestedCrashes(async () => createApplyFixture(), { action: "setup" })).toBeGreaterThan(100);
  }, 120_000);

  it("the manifest-switched-but-state-stale window never empties the slot Chrome runs", async () => {
    const prepare = async (): Promise<ApplyFixture> => {
      const fixture = await outdated(createApplyFixture());
      const original = fixture.fileSystem.renameFile.bind(fixture.fileSystem);
      fixture.fileSystem.renameFile = async (from, to, options) => {
        await original(from, to, options);
        if (to.endsWith("org.maginalia.collector.json")) fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount; // died right after the manifest switch
      };
      await run(fixture, { action: "refresh" });
      fixture.fileSystem.renameFile = original;
      fixture.fileSystem.crashAfter = null;
      return fixture;
    };
    const baseline = await prepare();
    expect(JSON.parse(baseline.fileSystem.text(p(baseline, "org.maginalia.collector.json")))).toEqual(expectedHostManifest("b"));
    expect(parseIntegrationStateFile(baseline.fileSystem.text(p(baseline, "integration-state.json")))?.activeSlot).toBe("a");
    const probe = await prepare();
    const before = probe.fileSystem.mutationCount;
    expect((await run(probe, { action: "repair" })).outcome).toBe("applied");
    const total = probe.fileSystem.mutationCount - before;
    for (let step = 0; step < total; step += 1) {
      const fixture = await prepare();
      fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount + step;
      await run(fixture, { action: "repair" });
      assertPointedSlotComplete(fixture, `stale-state repair crash ${step}`);
      await recover(fixture, `stale-state repair crash ${step}`);
    }
  });
});

describe("faults around the registry", () => {
  it("a crash right after the registry write leaves a registered folder with no state file, repairable", async () => {
    const fixture = createApplyFixture();
    const original = fixture.registry.registerCollectorHost.bind(fixture.registry);
    fixture.registry.registerCollectorHost = () => {
      const outcome = original();
      fixture.fileSystem.crashAfter = fixture.fileSystem.mutationCount; // everything after the registry call fails
      return outcome;
    };
    const result = await run(fixture, { action: "setup" });
    expect(result.outcome).toBe("failed");
    expect(fixture.registry.registration).toBe("ours");
    const inspection = await inspectCollectorIntegration(fixture.deps);
    expect(inspection.state).toBe("damaged");
    expect(inspection.reasons).toContain("state-file-missing");
    await recover(fixture, "after registry write");
  });

  it("a crash between the extension swap and the manifest write keeps the previous Host and is repaired", async () => {
    const fixture = await outdated(createApplyFixture());
    const original = fixture.fileSystem.renameFile.bind(fixture.fileSystem);
    fixture.fileSystem.renameFile = async (from, to, options) => {
      if (to.endsWith("org.maginalia.collector.json")) throw new Error("process died");
      await original(from, to, options);
    };
    await run(fixture, { action: "refresh" });
    fixture.fileSystem.renameFile = original;
    expect(JSON.parse(fixture.fileSystem.text(p(fixture, "org.maginalia.collector.json")))).toEqual(expectedHostManifest("a"));
    const inspection = await inspectCollectorIntegration(fixture.deps);
    expect(inspection.state).toBe("damaged");
    expect(inspection.reasons).toContain("extension-version-mismatch");
    await recover(fixture, "between swap and manifest");
  });
});
