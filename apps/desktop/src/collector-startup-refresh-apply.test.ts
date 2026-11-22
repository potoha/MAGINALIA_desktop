/**
 * Startup refresh orchestrator (S6) over the REAL apply (S4) with the in-memory registry / file
 * system fakes. Pins that a registration-only refresh keeps `installed.payloadId` and therefore
 * raises no "updated" notice, while a payload replacement changes it and does. Nothing touches a
 * real registry, path, browser or Electron.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCollectorIntegration } from "./collector-integration-apply";
import type { CollectorApplyRequest } from "./collector-integration-apply-types";
import { inspectCollectorIntegration } from "./collector-integration";
import { createCollectorStartupRefresh } from "./collector-startup-refresh";
import { DEFAULT_COLLECTOR_NOTICE_STATE, type CollectorNoticeState } from "./collector-integration-notices";
import { HOST_SOURCE_FILES, SOURCE_EXTENSION_FOLDER, SOURCE_HOST_FOLDER, applyDescriptor, createApplyFixture, extensionSourceFiles, type ApplyFixture } from "./collector-integration-apply.test-helper";
import { COLLECTOR_HOST_EXECUTABLE_NAME } from "./collector-payload";

const statePath = (fixture: ApplyFixture): string => path.win32.join(fixture.programFolder, "integration-state.json");

/** An RC3-style installation (Chrome only, v1 state); the product table (Chrome and Edge verified) then expects Edge too. */
async function rc3Installation(): Promise<ApplyFixture> {
  const fixture = createApplyFixture();
  expect((await applyCollectorIntegration({ action: "setup" }, fixture.deps)).outcome).toBe("applied");
  const state = JSON.parse(fixture.fileSystem.text(statePath(fixture))) as Record<string, unknown>;
  delete state.registeredTargets;
  fixture.fileSystem.setBytes(statePath(fixture), `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`);
  fixture.browserTable = undefined; // the product table
  return fixture;
}

function newerPayload(fixture: ApplyFixture): void {
  fixture.fileSystem.setBytes(path.win32.join(SOURCE_HOST_FOLDER, COLLECTOR_HOST_EXECUTABLE_NAME), "host-executable-bytes-v2");
  fixture.payload = applyDescriptor({ payloadId: "1.3.0+def5678", hostVersion: "1.3.0", extensionVersion: "0.4.0", host: { ...HOST_SOURCE_FILES, [COLLECTOR_HOST_EXECUTABLE_NAME]: "host-executable-bytes-v2" } });
  for (const [name, content] of Object.entries(extensionSourceFiles("0.4.0"))) fixture.fileSystem.setBytes(path.win32.join(SOURCE_EXTENSION_FOLDER, ...name.split("/")), content);
}

function launcher(fixture: ApplyFixture) {
  const applies: CollectorApplyRequest[] = [];
  let stored: CollectorNoticeState = DEFAULT_COLLECTOR_NOTICE_STATE;
  const start = () => createCollectorStartupRefresh({
    inspect: (options) => inspectCollectorIntegration(fixture.deps, options),
    apply: (request) => { applies.push(request); return applyCollectorIntegration(request, fixture.deps); },
    hasOptedIn: async () => true,
    noticeStore: { read: async () => stored, write: async (state) => { stored = state; } },
    now: () => fixture.now,
    e2eIsolationActive: false,
  }).runStartup();
  return { applies, start, stored: () => stored };
}

const payloadIdOf = async (fixture: ApplyFixture): Promise<string | null> => (await inspectCollectorIntegration(fixture.deps)).installed.payloadId;

describe("startup refresh over the real apply: updated notice only when installed.payloadId changes", () => {
  it("(a) a target added to the expected set refreshes registration only: payloadId unchanged, no updated notice", async () => {
    const fixture = await rc3Installation();
    const before = await payloadIdOf(fixture);
    expect(before).not.toBeNull();
    const launch = launcher(fixture);
    const result = await launch.start();
    expect(launch.applies).toEqual([{ action: "refresh" }]);
    expect(result.outcome).toBe("refreshed");
    expect(fixture.fileSystem.registryLog).toContain("register edge");
    expect(await payloadIdOf(fixture)).toBe(before);
    expect(result.notices.map((notice) => notice.kind)).toEqual([]);
    expect(launch.stored().updated).toBeNull();
  });

  it("(b) a refresh that replaces the payload changes payloadId and raises the updated notice", async () => {
    const fixture = await rc3Installation();
    newerPayload(fixture);
    const launch = launcher(fixture);
    const result = await launch.start();
    expect(result.outcome).toBe("refreshed");
    expect(await payloadIdOf(fixture)).toBe("1.3.0+def5678");
    expect(result.notices.map((notice) => notice.kind)).toEqual(["updated"]);
    expect(launch.stored().updated).toMatchObject({ extensionVersion: "0.4.0" });
  });

  it("(c) three launches after a registration-only refresh never add a notice", async () => {
    const fixture = await rc3Installation();
    const launch = launcher(fixture);
    for (let start = 0; start < 3; start += 1) {
      const result = await launch.start();
      expect(result.notices.map((notice) => notice.kind)).toEqual([]);
      expect(launch.stored().updated).toBeNull();
    }
    // Only the first launch had anything to refresh; the rest inspect `ready`.
    expect(launch.applies).toEqual([{ action: "refresh" }]);
  });
});
