import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-scan guard for the main.ts wiring (Electron cannot be started in a unit test). It pins the
 * properties the wiring must keep: non-blocking startup, sender checks, E2E / smoke inertness and
 * handler cleanup. Real Electron behaviour is NOT VERIFIED by this test.
 */
const source = readFileSync(path.join(__dirname, "main.ts"), "utf8");

describe("main.ts Collector integration wiring (source scan)", () => {
  it("starts after the main window is opened and never awaits the startup run", () => {
    expect(source).toMatch(/openMainWindow\(\);\s*app\.on\("activate", openMainWindow\);\s*startCollectorIntegration\(\);/u);
    expect(source).toMatch(/void service\.runStartup\(\);/u);
    expect(source).not.toMatch(/await [\w.]*runStartup\(/u);
  });

  it("is off in smoke runs and passes the E2E isolation decision to the composition", () => {
    expect(source).toMatch(/if \(smokeMode\) return;[^\n]*\n\s*collectorIntegration = createCollectorIntegrationForMain\(\)/u);
    expect(source).toMatch(/e2eIsolationActive: e2eIsolationState !== undefined \|\| process\.env\[E2E_ISOLATION_ROOT_ENV\] !== undefined/u);
    expect(source).toMatch(/createRegistry: createProductCollectorRegistryAdapter/u);
    expect(source).toMatch(/wrapApply: \(apply\) => \(request\) => collectorApplyGate\.queue/u);
  });

  it("a composition failure is caught and logged by code, leaving the app starting", () => {
    expect(source).toMatch(/catch \(error: unknown\) \{\s*logCollectorIntegrationError\("MAGINALIA_COLLECTOR_INTEGRATION_UNAVAILABLE", error\);\s*return undefined;/u);
  });

  it("every Collector integration handler checks the live main-window sender and is removed on shutdown", () => {
    const handlers = ["COLLECTOR_INTEGRATION_CHANNEL", "GET_COLLECTOR_NOTICES_CHANNEL", "DISMISS_COLLECTOR_NOTICE_CHANNEL"];
    for (const channel of handlers) {
      expect(source).toContain(`ipcMain.handle(${channel}`);
      expect(source).toContain(`ipcMain.removeHandler(${channel})`);
    }
    expect(source).toMatch(/handleCollectorIntegrationRequest[\s\S]{0,200}isLiveMainWindowSender\(event\.sender\)/u);
    expect(source.match(/ipcMain\.handle\((?:GET_COLLECTOR_NOTICES_CHANNEL|DISMISS_COLLECTOR_NOTICE_CHANNEL)[\s\S]{0,400}?isLiveMainWindowSender\(event\.sender\)/gu)?.length).toBe(2);
  });
});
