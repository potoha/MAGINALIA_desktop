import { describe, expect, it } from "vitest";
import { ContextKeyService } from "./command-context";
import { CommandRegistry } from "./command-registry";
import { buildAlpha1MigrationNotice, COLLECTOR_NOTICE_IDS } from "../collector-integration-notices";
import type { CollectorIntegrationRequest, CollectorIntegrationResponse } from "../collector-integration-ipc";
import {
  collectorResponseProblem,
  COLLECTOR_DISMISS_NOTICE_COMMAND,
  COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND,
  COLLECTOR_REMOVE_INTEGRATION_COMMAND,
  COLLECTOR_REPAIR_COMMAND,
  COLLECTOR_SETUP_COMMAND,
  dispatchCollectorNoticeAction,
  registerCollectorIntegrationCommands,
} from "./collector-integration-commands";

function harness(response: CollectorIntegrationResponse = { kind: "browser-extensions", browser: "chrome", result: "opened" }) {
  const registry = new CommandRegistry();
  const requests: CollectorIntegrationRequest[] = [];
  const dismissed: string[] = [];
  registerCollectorIntegrationCommands(registry, {
    run: async (request) => { requests.push(request); return response; },
    dismiss: async (noticeId) => { dismissed.push(noticeId); return []; },
  });
  const context = new ContextKeyService().snapshot();
  return { registry, requests, dismissed, context };
}

describe("Collector integration commands", () => {
  it("registers the stable command IDs (palette-visible except the argument-only dismiss)", () => {
    const { registry, context } = harness();
    for (const id of [COLLECTOR_SETUP_COMMAND, COLLECTOR_REPAIR_COMMAND, COLLECTOR_REMOVE_INTEGRATION_COMMAND, COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND, COLLECTOR_DISMISS_NOTICE_COMMAND]) {
      expect(registry.get(id)).not.toBeNull();
    }
    expect(COLLECTOR_SETUP_COMMAND).toBe("maginalia.collector.setup");
    expect(COLLECTOR_REPAIR_COMMAND).toBe("maginalia.collector.repair");
    expect(COLLECTOR_REMOVE_INTEGRATION_COMMAND).toBe("maginalia.collector.removeIntegration");
    expect(COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND).toBe("maginalia.collector.openBrowserExtensions");
    expect(COLLECTOR_DISMISS_NOTICE_COMMAND).toBe("maginalia.collector.dismissNotice");
    const publicIds = registry.list(context).map((descriptor) => descriptor.id);
    expect(publicIds).toContain(COLLECTOR_SETUP_COMMAND);
    expect(publicIds).not.toContain(COLLECTOR_DISMISS_NOTICE_COMMAND);
  });

  it("forwards only the enumerated intent", async () => {
    const { registry, requests, context } = harness();
    await registry.execute(COLLECTOR_SETUP_COMMAND, context);
    await registry.execute(COLLECTOR_REPAIR_COMMAND, context);
    await registry.execute(COLLECTOR_REMOVE_INTEGRATION_COMMAND, context);
    await registry.execute(COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND, context);
    expect(requests).toEqual([{ intent: "setup" }, { intent: "repair" }, { intent: "remove" }, { intent: "openBrowserExtensions" }]);
  });

  it("surfaces a problem as a failed command, and nothing for a clean result", async () => {
    const busy = harness({ kind: "busy" });
    expect((await busy.registry.execute(COLLECTOR_SETUP_COMMAND, busy.context)).kind).toBe("failed");
    const ok = harness({ kind: "cancelled" });
    expect((await ok.registry.execute(COLLECTOR_REMOVE_INTEGRATION_COMMAND, ok.context)).kind).toBe("executed");
    expect(collectorResponseProblem({ kind: "unavailable", reason: "e2e-isolation" })).not.toBeNull();
    expect(collectorResponseProblem({ kind: "browser-extensions", browser: "chrome", result: "opened" })).toBeNull();
  });

  it("names the browser in the failure lines (from the table, never from the response)", () => {
    expect(collectorResponseProblem({ kind: "browser-extensions", browser: "chrome", result: "failed" }))
      .toBe("Google Chrome の拡張機能の画面を開けませんでした。Google Chrome のアドレスバーに chrome://extensions と入力してください。");
    expect(collectorResponseProblem({ kind: "browser-extensions", browser: "edge", result: "browser-not-found" }))
      .toBe("Microsoft Edge の拡張機能の画面を開けませんでした。Microsoft Edge のアドレスバーに edge://extensions と入力してください。");
    expect(collectorResponseProblem({ kind: "browser-extensions", browser: null, result: "browser-not-found" }))
      .toBe("ブラウザーの拡張機能の画面を開けませんでした。対応しているブラウザーが見つかりません。");
  });

  it("browser-required lists the browsers a setup accepts today", () => {
    const status = { applyInProgress: false } as never;
    const line = collectorResponseProblem({ kind: "browser-required", status });
    expect(line).toBe("対応しているブラウザー（Google Chrome）が見つからないため、Collector 連携を設定していません。");
  });

  it("dismiss needs a notice id argument", async () => {
    const { registry, dismissed, context } = harness();
    expect((await registry.execute(COLLECTOR_DISMISS_NOTICE_COMMAND, context)).kind).toBe("failed");
    await registry.execute(COLLECTOR_DISMISS_NOTICE_COMMAND, context, { noticeId: COLLECTOR_NOTICE_IDS.repair });
    expect(dismissed).toEqual([COLLECTOR_NOTICE_IDS.repair]);
  });

  it("without the preload API the commands fail instead of doing nothing silently", async () => {
    const registry = new CommandRegistry();
    registerCollectorIntegrationCommands(registry, { run: null, dismiss: null });
    const context = new ContextKeyService().snapshot();
    expect((await registry.execute(COLLECTOR_SETUP_COMMAND, context)).kind).toBe("failed");
  });

  it("the alpha1 'set up' button runs setup and then closes the notice; the other button only dismisses", async () => {
    const notice = buildAlpha1MigrationNotice();
    const executed: Array<[string, unknown]> = [];
    const execute = async (id: string, args?: Readonly<Record<string, string>>) => { executed.push([id, args]); };
    await dispatchCollectorNoticeAction(notice.actions[0]!, execute);
    await dispatchCollectorNoticeAction(notice.actions[1]!, execute);
    expect(executed).toEqual([
      [COLLECTOR_SETUP_COMMAND, undefined],
      [COLLECTOR_DISMISS_NOTICE_COMMAND, { noticeId: COLLECTOR_NOTICE_IDS.alpha1Migration }],
      [COLLECTOR_DISMISS_NOTICE_COMMAND, { noticeId: COLLECTOR_NOTICE_IDS.alpha1Migration }],
    ]);
  });
});
