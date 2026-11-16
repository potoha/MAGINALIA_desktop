import { describe, expect, it } from "vitest";
import {
  buildAlpha1MigrationNotice,
  buildRepairNotice,
  buildUpdatedNotice,
  COLLECTOR_NOTICE_IDS,
} from "./collector-integration-notices.js";
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
    expect(isCollectorIntegrationRequest({ intent: "setup", confirmReplaceForeign: true, proceedWithoutChrome: false })).toBe(true);
    expect(isCollectorIntegrationRequest({ intent: "repair", confirmReplaceForeign: true })).toBe(true);
  });

  it("rejects paths, commands, unknown intents and misplaced flags", () => {
    const bad: unknown[] = [
      undefined, null, 1, "setup", [], [{ intent: "setup" }], {}, { intent: "unknown" }, { intent: "SETUP" },
      { intent: "setup", path: "C:\\Windows" }, { intent: "openChromeExtensions", url: "https://example.test" },
      { intent: "copyExtensionPath", target: "x" }, { intent: "setup", confirmReplaceForeign: 1 },
      { intent: "remove", proceedWithoutChrome: true }, { intent: "inspect", confirmReplaceForeign: false },
      { intent: "repair", proceedWithoutChrome: false }, Object.create({ intent: "setup" }),
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
