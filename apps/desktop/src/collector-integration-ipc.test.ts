import { describe, expect, it } from "vitest";
import {
  buildAlpha1MigrationNotice,
  buildRepairNotice,
  buildUpdatedNotice,
  COLLECTOR_NOTICE_IDS,
} from "./collector-integration-notices.js";
import { COLLECTOR_BROWSER_IDS } from "./collector-browser-table.js";
import {
  COLLECTOR_INTEGRATION_INTENTS,
  COLLECTOR_NOTICE_ID_VALUES,
  isCollectorIntegrationRequest,
  isCollectorNoticeId,
  isCollectorNoticeList,
} from "./collector-integration-ipc.js";

describe("Collector integration IPC contract", () => {
  it("accepts every intent with no extra fields", () => {
    for (const intent of COLLECTOR_INTEGRATION_INTENTS) expect(isCollectorIntegrationRequest({ intent })).toBe(true);
    expect(isCollectorIntegrationRequest({ intent: "setup", confirmReplaceForeign: true, proceedWithoutSupportedBrowser: false })).toBe(true);
    expect(isCollectorIntegrationRequest({ intent: "repair", confirmReplaceForeign: true })).toBe(true);
  });

  it("accepts a browser row id on setup, openBrowserExtensions and openBrowserDownloadPage only", () => {
    const allowed = ["setup", "openBrowserExtensions", "openBrowserDownloadPage"];
    expect(COLLECTOR_INTEGRATION_INTENTS as readonly string[]).toContain("openBrowserDownloadPage");
    for (const id of COLLECTOR_BROWSER_IDS) {
      for (const intent of COLLECTOR_INTEGRATION_INTENTS) {
        expect(isCollectorIntegrationRequest({ intent, browser: id })).toBe(allowed.includes(intent));
      }
    }
  });

  it("rejects a browser that is not a table row id, in any spelling, or that carries a path or URL", () => {
    const bad: unknown[] = ["", "Chrome", "CHROME", "brave", "chromium", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome://extensions/", "https://example.test", "chrome ", null, 1, true, {}, ["chrome"]];
    for (const intent of ["setup", "openBrowserExtensions", "openBrowserDownloadPage"] as const) {
      for (const browser of bad) expect(isCollectorIntegrationRequest({ intent, browser })).toBe(false);
      expect(isCollectorIntegrationRequest({ intent, browser: undefined })).toBe(true);
    }
  });

  it("no longer knows the Chrome-only intent or flag", () => {
    expect(COLLECTOR_INTEGRATION_INTENTS as readonly string[]).not.toContain("openChromeExtensions");
    expect(isCollectorIntegrationRequest({ intent: "openChromeExtensions" })).toBe(false);
    expect(isCollectorIntegrationRequest({ intent: "setup", proceedWithoutChrome: true })).toBe(false);
  });

  it("rejects paths, commands, unknown intents and misplaced flags", () => {
    const bad: unknown[] = [
      undefined, null, 1, "setup", [], [{ intent: "setup" }], {}, { intent: "unknown" }, { intent: "SETUP" },
      { intent: "setup", path: "C:\\Windows" }, { intent: "openBrowserExtensions", url: "https://example.test" },
      { intent: "openBrowserDownloadPage", url: "https://example.test" }, { intent: "openBrowserDownloadPage", browser: "chrome", url: "https://example.test" },
      { intent: "openBrowserDownloadPage", confirmReplaceForeign: true }, { intent: "openBrowserDownloadPage", proceedWithoutSupportedBrowser: true },
      { intent: "setup", browser: "chrome", path: "C:\\x" },
      { intent: "copyExtensionPath", target: "x" }, { intent: "setup", confirmReplaceForeign: 1 },
      { intent: "remove", proceedWithoutSupportedBrowser: true }, { intent: "inspect", confirmReplaceForeign: false },
      { intent: "repair", proceedWithoutSupportedBrowser: false }, Object.create({ intent: "setup" }),
    ];
    for (const value of bad) expect(isCollectorIntegrationRequest(value)).toBe(false);
  });

  it("keeps the preload-safe notice id list equal to the notice module", () => {
    expect([...COLLECTOR_NOTICE_ID_VALUES].sort()).toEqual(Object.values(COLLECTOR_NOTICE_IDS).sort());
    expect(isCollectorNoticeId(COLLECTOR_NOTICE_IDS.repair)).toBe(true);
    expect(isCollectorNoticeId("collector.notice.other")).toBe(false);
    expect(isCollectorNoticeId(undefined)).toBe(false);
  });

  it("accepts the real notices and rejects malformed lists", () => {
    const notices = [buildUpdatedNotice("0.4.0", "2026-11-16T09:00:00.000Z"), buildRepairNotice("damaged"), buildAlpha1MigrationNotice()];
    expect(isCollectorNoticeList(notices)).toBe(true);
    expect(isCollectorNoticeList([])).toBe(true);
    expect(isCollectorNoticeList("x")).toBe(false);
    expect(isCollectorNoticeList([null])).toBe(false);
    expect(isCollectorNoticeList([{ ...notices[0], id: "collector.notice.x" }])).toBe(false);
    expect(isCollectorNoticeList([{ ...notices[0], actions: [{ commandId: "evil.command", label: "x" }] }])).toBe(false);
    expect(isCollectorNoticeList([{ ...notices[0], actions: [{ commandId: "maginalia.collector.dismissNotice", label: "x", argument: { noticeId: "nope" } }] }])).toBe(false);
  });
});
