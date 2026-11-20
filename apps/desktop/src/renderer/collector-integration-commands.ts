import { COLLECTOR_BROWSERS } from "../collector-browser-table";
import type { CollectorIntegrationRequest, CollectorIntegrationResponse } from "../collector-integration-ipc";
import type { CollectorNoticeAction } from "../collector-integration-notices";
import type { CollectorSaveDestinationIpcResult } from "../collector-save-destination-ipc";
import type { CommandArgs, CommandRegistry } from "./command-registry";
import { openCollectorWizard, type CollectorWizardDeps } from "./collector-wizard-controller";

/**
 * Collector integration commands (design 5, WP-7 slice A).
 *
 * Every handler only forwards an enumerated intent to the main-process Collector integration
 * service (preload `runCollectorIntegration`). Menus, the Palette and notice buttons all dispatch
 * these same command IDs; none of them carries a second implementation.
 *
 * Slice B4: `setup` and `repair` OPEN THE WIZARD PANEL (the wizard inspects the installation and
 * itself runs `setup` or `repair`), so both IDs share one handler. `removeIntegration` still sends the
 * `remove` intent directly: the wizard model has no remove path, and the main process owns the single
 * native confirmation. `openBrowserExtensions` stays a command for the notice button; the wizard's own
 * "open the browser page" / "open the download page" buttons are wizard-internal (they send the
 * `openBrowserExtensions` / `openBrowserDownloadPage` intents through the controller's
 * `runCollectorIntegration` dependency), so `openBrowserDownloadPage` has no command ID of its own.
 */
export const COLLECTOR_SETUP_COMMAND = "maginalia.collector.setup";
export const COLLECTOR_REPAIR_COMMAND = "maginalia.collector.repair";
export const COLLECTOR_REMOVE_INTEGRATION_COMMAND = "maginalia.collector.removeIntegration";
export const COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND = "maginalia.collector.openBrowserExtensions";
export const COLLECTOR_DISMISS_NOTICE_COMMAND = "maginalia.collector.dismissNotice";

export interface CollectorIntegrationCommandDependencies {
  /** `window.maginalia.runCollectorIntegration`; `null` when this runtime has none. */
  readonly run: ((request: CollectorIntegrationRequest) => Promise<CollectorIntegrationResponse>) | null;
  /** `window.maginalia.dismissCollectorNotice`; `null` when this runtime has none. */
  readonly dismiss: ((noticeId: string) => Promise<unknown>) | null;
  /**
   * Opens the wizard panel; `null` when this runtime lacks `runCollectorIntegration` or
   * `configureCollectorSaveDestination` (both are optional in the preload API).
   */
  readonly openWizard: (() => void) | null;
}

const UNAVAILABLE_MESSAGE = "Collector 連携はこの環境では使えません。";

/**
 * The wizard opener for the preload API of this runtime, or `null` when the wizard cannot work
 * (it needs both calls). `open` is injectable for tests.
 */
export function createCollectorWizardOpener(
  api: {
    readonly runCollectorIntegration?: CollectorWizardDeps["runCollectorIntegration"];
    readonly configureCollectorSaveDestination?: () => Promise<CollectorSaveDestinationIpcResult>;
  },
  open: (deps: CollectorWizardDeps) => unknown = openCollectorWizard,
): (() => void) | null {
  const run = api.runCollectorIntegration;
  const configure = api.configureCollectorSaveDestination;
  if (typeof run !== "function" || typeof configure !== "function") return null;
  return () => {
    open({
      runCollectorIntegration: (request) => run.call(api, request),
      configureCollectorSaveDestination: () => configure.call(api),
    });
  };
}

/** The names of the browsers a setup accepts today (verified rows of the table, in table order). */
function supportedBrowserNames(): string {
  return COLLECTOR_BROWSERS.filter((entry) => entry.verification === "verified").map((entry) => entry.displayName).join("、");
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
    case "browser-required":
      return `対応しているブラウザー（${supportedBrowserNames()}）が見つからないため、Collector 連携を設定していません。`;
    case "browser-extensions": {
      if (response.result === "opened") return null;
      const row = response.browser === null ? undefined : COLLECTOR_BROWSERS.find((entry) => entry.id === response.browser);
      return row === undefined
        ? "ブラウザーの拡張機能の画面を開けませんでした。対応しているブラウザーが見つかりません。"
        : `${row.displayName} の拡張機能の画面を開けませんでした。${row.displayName} のアドレスバーに ${row.extensionsPage.displayUrl} と入力してください。`;
    }
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
    if (dependencies.run === null) throw new Error(UNAVAILABLE_MESSAGE);
    const problem = collectorResponseProblem(await dependencies.run(request));
    if (problem !== null) throw new Error(problem);
  };

  const openWizard = (): void => {
    if (dependencies.openWizard === null) throw new Error(UNAVAILABLE_MESSAGE);
    dependencies.openWizard();
  };

  registry.register({
    id: COLLECTOR_SETUP_COMMAND,
    title: "Collector 連携を設定",
    description: "Open the wizard that sets up the MAGINALIA Collector integration for a supported browser.",
    category: "Collector",
    keywords: ["collector", "chrome", "browser", "extension", "setup", "ブラウザー", "連携", "設定"]
  }, openWizard);

  registry.register({
    id: COLLECTOR_REPAIR_COMMAND,
    title: "Collector 連携を確認・修復",
    description: "Open the wizard that checks the MAGINALIA Collector integration and repairs what is missing.",
    category: "Collector",
    keywords: ["collector", "chrome", "extension", "repair", "check", "確認", "修復"]
  }, openWizard);

  registry.register({
    id: COLLECTOR_REMOVE_INTEGRATION_COMMAND,
    title: "Collector 連携を解除",
    description: "Remove the MAGINALIA Collector integration registration and extension folder after confirmation.",
    category: "Collector",
    keywords: ["collector", "chrome", "extension", "remove", "uninstall", "解除"]
  }, () => run({ intent: "remove" }));

  registry.register({
    id: COLLECTOR_OPEN_BROWSER_EXTENSIONS_COMMAND,
    title: "ブラウザーで拡張機能の画面を開く",
    description: "Open the browser's extensions page so the MAGINALIA Collector can be loaded or updated.",
    category: "Collector",
    keywords: ["collector", "chrome", "browser", "extensions", "ブラウザー", "拡張機能"]
  }, () => run({ intent: "openBrowserExtensions" }));

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
 * Runs one notice button: its command, then (for the alpha1 "設定する" button) closes the notice, but only
 * when the command did not fail.
 * The caller supplies `execute` (the renderer's `executeCommand`).
 */
export async function dispatchCollectorNoticeAction(
  action: CollectorNoticeAction,
  /** Resolves `false` when the command failed; `void` / `true` count as success. */
  execute: (commandId: string, args?: CommandArgs) => Promise<boolean | void>,
): Promise<void> {
  const ok = await execute(action.commandId, action.argument === undefined ? undefined : { noticeId: action.argument.noticeId });
  // A failed command (for example the wizard cannot open) must not close the notice that offered it.
  if (ok !== false && action.closesNoticeId !== undefined) await execute(COLLECTOR_DISMISS_NOTICE_COMMAND, { noticeId: action.closesNoticeId });
}
