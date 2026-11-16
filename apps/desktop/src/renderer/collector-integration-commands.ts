import type { CollectorIntegrationRequest, CollectorIntegrationResponse } from "../collector-integration-ipc";
import type { CollectorNoticeAction } from "../collector-integration-notices";
import type { CommandArgs, CommandRegistry } from "./command-registry";

/**
 * Collector integration commands (design 5, WP-7 slice A).
 *
 * Every handler only forwards an enumerated intent to the main-process Collector integration
 * service (preload `runCollectorIntegration`). Menus, the Palette, notice buttons and the future
 * wizard panel (slice B) all dispatch these same command IDs; none of them carries a second
 * implementation. Slice B replaces the `setup` / `repair` handlers with "open the panel", and the
 * panel itself calls `runCollectorIntegration` with the same intents.
 */
export const COLLECTOR_SETUP_COMMAND = "maginalia.collector.setup";
export const COLLECTOR_REPAIR_COMMAND = "maginalia.collector.repair";
export const COLLECTOR_REMOVE_INTEGRATION_COMMAND = "maginalia.collector.removeIntegration";
export const COLLECTOR_OPEN_CHROME_EXTENSIONS_COMMAND = "maginalia.collector.openChromeExtensions";
export const COLLECTOR_DISMISS_NOTICE_COMMAND = "maginalia.collector.dismissNotice";

export interface CollectorIntegrationCommandDependencies {
  /** `window.maginalia.runCollectorIntegration`; `null` when this runtime has none. */
  readonly run: ((request: CollectorIntegrationRequest) => Promise<CollectorIntegrationResponse>) | null;
  /** `window.maginalia.dismissCollectorNotice`; `null` when this runtime has none. */
  readonly dismiss: ((noticeId: string) => Promise<unknown>) | null;
}

/**
 * The failure line for a response, or `null` when there is nothing to report. A successful setup is
 * reported by the wizard (slice B); until then only problems surface.
 */
export function collectorResponseProblem(response: CollectorIntegrationResponse): string | null {
  switch (response.kind) {
    case "unavailable":
      return "Collector 連携はこの環境では使えません。";
    case "invalid-request":
    case "error":
      return "Collector 連携の操作を実行できませんでした。";
    case "busy":
      return "別の Collector 連携の操作を実行中です。終わってからもう一度お試しください。";
    case "chrome-required":
      return "Google Chrome が見つからないため、Collector 連携を設定していません。";
    case "chrome-extensions":
      return response.result === "opened" ? null : "Chrome の拡張機能の画面を開けませんでした。Chrome のアドレスバーに chrome://extensions と入力してください。";
    case "apply":
      return response.outcome === "failed" || response.outcome === "refused" || response.outcome === "partial"
        ? "Collector 連携の操作を完了できませんでした。「Collector 連携を確認・修復…」で状態を確認してください。"
        : null;
    default:
      return null;
  }
}

export function registerCollectorIntegrationCommands(registry: CommandRegistry, dependencies: CollectorIntegrationCommandDependencies): void {
  const run = async (request: CollectorIntegrationRequest): Promise<void> => {
    if (dependencies.run === null) throw new Error("Collector 連携はこの環境では使えません。");
    const problem = collectorResponseProblem(await dependencies.run(request));
    if (problem !== null) throw new Error(problem);
  };

  registry.register({
    id: COLLECTOR_SETUP_COMMAND,
    title: "Collector 連携を設定",
    description: "Set up the MAGINALIA Collector integration for Google Chrome.",
    category: "Collector",
    keywords: ["collector", "chrome", "extension", "setup", "連携", "設定"]
  }, () => run({ intent: "setup" }));

  registry.register({
    id: COLLECTOR_REPAIR_COMMAND,
    title: "Collector 連携を確認・修復",
    description: "Check the MAGINALIA Collector integration and repair what is missing.",
    category: "Collector",
    keywords: ["collector", "chrome", "extension", "repair", "check", "確認", "修復"]
  }, () => run({ intent: "repair" }));

  registry.register({
    id: COLLECTOR_REMOVE_INTEGRATION_COMMAND,
    title: "Collector 連携を解除",
    description: "Remove the MAGINALIA Collector integration registration and extension folder after confirmation.",
    category: "Collector",
    keywords: ["collector", "chrome", "extension", "remove", "uninstall", "解除"]
  }, () => run({ intent: "remove" }));

  registry.register({
    id: COLLECTOR_OPEN_CHROME_EXTENSIONS_COMMAND,
    title: "Chrome で拡張機能の画面を開く",
    description: "Open Chrome's extensions page so the MAGINALIA Collector can be loaded or updated.",
    category: "Collector",
    keywords: ["collector", "chrome", "extensions", "拡張機能"]
  }, () => run({ intent: "openChromeExtensions" }));

  registry.register({
    id: COLLECTOR_DISMISS_NOTICE_COMMAND,
    title: "Collector の通知を閉じる",
    description: "Close one Collector notice.",
    category: "Collector",
    visibility: "internal"
  }, async (args?: CommandArgs) => {
    const noticeId = args?.noticeId;
    if (noticeId === undefined || dependencies.dismiss === null) throw new Error("The Collector notice cannot be closed.");
    await dependencies.dismiss(noticeId);
  });
}

/**
 * Runs one notice button: its command, then (for the alpha1 "設定する" button) closes the notice.
 * The caller supplies `execute` (the renderer's `executeCommand`).
 */
export async function dispatchCollectorNoticeAction(
  action: CollectorNoticeAction,
  execute: (commandId: string, args?: CommandArgs) => Promise<void>,
): Promise<void> {
  await execute(action.commandId, action.argument === undefined ? undefined : { noticeId: action.argument.noticeId });
  if (action.closesNoticeId !== undefined) await execute(COLLECTOR_DISMISS_NOTICE_COMMAND, { noticeId: action.closesNoticeId });
}
