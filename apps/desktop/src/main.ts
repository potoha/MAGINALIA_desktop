import {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type LoadFileOptions,
  type MessageBoxOptions,
  type OpenDialogReturnValue,
  type WebContents
} from "electron";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { findApplicationIconPath, findBrandAssetPath } from "./brand-assets";
import {
  brandProgressUpdateScript,
  createBrandProgressState,
  renderBrandProgressHtml,
  type BrandProgressState,
} from "./brand-progress";
import { runBrandProgressElectronSmoke } from "./brand-progress-smoke";
import { RendererStartupGate, StartupProgressReadiness } from "./startup-progress-lifecycle";
import { DocumentWorkspaceService } from "./document-workspace";
import {
  createDocumentWorkspaceHandlers,
  createExplorerHandlers,
  CREATE_EXPLORER_FOLDER_CHANNEL,
  DELETE_EXPLORER_FILE_CHANNEL,
  LIST_EXPLORER_CHANNEL,
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL
} from "./document-workspace-ipc";
import { MarkdownFileService } from "./markdown-file-service";
import {
  CREATE_PROJECT_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  RESTORE_PROJECT_CHANNEL,
  createProjectHandlers
} from "./project-ipc";
import { FileProjectPathStore, ProjectService } from "./project-service";
import { FileWorkdeskPathStore, WorkdeskService } from "./workdesk-service";
import {
  COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL,
  CREATE_WORKDESK_CHANNEL,
  CREATE_WORKDESK_FILE_CHANNEL,
  CREATE_WORKDESK_PROJECT_CHANNEL,
  OPEN_WORKDESK_CHANNEL,
  OPEN_WORKDESK_PROJECT_CHANNEL,
  REMOVE_WORKDESK_PROJECT_CHANNEL,
  REGISTER_WORKDESK_PROJECT_CHANNEL,
  RESTORE_WORKDESK_CHANNEL,
  RETURN_TO_WORKDESK_CHANNEL,
  SAVE_WORKDESK_CONTEXT_CHANNEL,
  createWorkdeskHandlers
} from "./workdesk-ipc";
import type { ExistingProjectRegistrationChoice } from "./workdesk-ipc";
import {
  WORKDESK_PROJECT_REGISTRATION_DIALOG_BUTTONS,
  workdeskProjectRegistrationChoice,
} from "./workdesk-registration-dialog";
import {
  SEARCH_PROJECT_MARKDOWN_CHANNEL,
  createProjectSearchHandlers
} from "./project-search-ipc";
import { ProjectAssetService } from "./project-assets";
import {
  IMPORT_DROPPED_IMAGE_CHANNEL,
  RESOLVE_PROJECT_ASSET_CHANNEL,
  createProjectAssetHandlers
} from "./project-assets-ipc";
import {
  OPEN_EXTERNAL_LINK_CHANNEL,
  OPEN_INTERNAL_LINK_CHANNEL,
  RESOLVE_INTERNAL_LINK_CHANNEL,
  createProjectLinkHandlers
} from "./project-link-ipc";
import {
  RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL,
  createSyncedBlockHandlers
} from "./synced-block-ipc";
import {
  OPEN_LIBRARY_CHANNEL,
  OPEN_MARKDOWN_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  RESOLVE_REFERENCES_CHANNEL,
  SAVE_MARKDOWN_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
} from "./preload-api";
import {
  isSaveMarkdownRequest,
  type MarkdownFailure,
  type OpenMarkdownResult,
  type SaveMarkdownResult
} from "./markdown-ipc";
import { LibraryService } from "./library-service";
import { inspectFolderMarkers } from "./folder-identity";
import { createLibraryHandlers } from "./library-ipc";
import { createShelfHandlers, REFRESH_SHELF_CHANNEL, SEARCH_SHELF_CHANNEL } from "./shelf-ipc";
import { ConfiguredPrivateShelf } from "./configured-private-shelf";
import { ShelfLocationRegistry } from "./shelf-location-registry";
import { resolveDesktopConfigurationPaths, type DesktopConfigurationPaths } from "./desktop-configuration";
import { createReviewerShelfSyncAdapter } from "./reviewer-shelf-sync";
import { materializeApprovedReviewerRecords } from "./reviewer-approval-materializer";
import { createShelfBindingFileStore, removeShelfBindingFile, resolveShelfBindingStoragePaths, type ShelfBindingStoragePaths } from "./shelf-binding-store";
import { resolveReviewerShelfWriteCoordination } from "./reviewer-shelf-write-binding";
import { createNativePrivateDirectory, getNativeLocalAppDataPath, inspectNativePathSecurity } from "./shelf-native-mutex";
import {
  clearCollectorSaveDestination,
  collectorSaveDestinationConfirmationText,
  configureCollectorSaveDestination,
  type CollectorSaveDestinationDependencies,
} from "./collector-save-destination";
import {
  CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL,
  CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL,
  type CollectorSaveDestinationIpcResult,
} from "./collector-save-destination-ipc";
import { createReferenceHandlers } from "./reference-ipc";
import { resolveShelfQuoteRefs } from "./shelf-resolution";
import { PackagedReviewerLaunchStrategy, ReviewerProcessManager, UserDataReviewerWorkspaceLocator } from "./reviewer-process-manager";
import { createReviewerEmbeddedHost, isSafeReviewerViewBounds } from "./reviewer-embedded-view-host";
import {
  CLOSE_REVIEWER_VIEW_CHANNEL,
  OPEN_REVIEWER_VIEW_CHANNEL,
  REVIEWER_APPROVAL_NOTIFICATION_CHANNEL,
  SET_REVIEWER_VIEW_BOUNDS_CHANNEL,
  ReviewerViewController
} from "./reviewer-view-controller";
import {
  RESOLVE_EXPORT_CHANNEL,
  WRITE_EXPORT_CHANNEL,
  createExportHandlers
} from "./export-ipc";
import { writePdfWithElectron, writePdfWithVivliostyle } from "./export-pdf";
import { writeDocxWithPandoc } from "./export-docx";
import {
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_MODS_CHANNEL,
  MOD_CAPABILITY_REQUEST_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  RELOAD_MODS_CHANNEL,
  RESPOND_MOD_CAPABILITY_CHANNEL,
  isModCapabilityResponseRequest,
  isModCommandRequest,
  type ModCapabilityResponse,
  type ModCapabilityResponseRequest
} from "./mod-ipc";
import { ModHost } from "./mod-host";
import {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  createRepositoryHandlers
} from "./repository-ipc";
import { LocalRepositoryService } from "./repository-service";
import { createSecureWebPreferences } from "./security";
import {
  parseQuotationSmokeMode,
  parseD5SmokeMode,
  parseExportSmokeMode,
  parseGSmokeMode,
  parseH5SmokeMode,
  parseHSmokeMode,
  parseProjectSmokeMode,
  parseRepositorySmokeMode,
  parseShelfSmokeMode,
  parseWritingSmokeMode,
  parseWorkspaceSmokeMode,
  parseWorkdeskPersistenceSmokeMode
} from "./smoke-mode";
import { runQuotationSmoke } from "./quotation-smoke";
import { runProjectRestoreSmoke, runProjectSmoke } from "./project-smoke";
import { runRepositorySmoke } from "./repository-smoke";
import { runShelfSmoke } from "./shelf-smoke";
import { runWorkspaceSmoke } from "./workspace-smoke";
import { runWritingSmoke } from "./writing-smoke";
import { runD5Smoke, runD5RestoreSmoke } from "./d5-smoke";
import { runExportSmoke } from "./export-smoke";
import { runGRestoreSmoke, runGSmoke } from "./g-smoke";
import { runHNavigationAcceptanceSmoke, runHSmoke } from "./h-smoke";
import { runH5Smoke } from "./h5-smoke";
import { runWorkdeskPersistenceSmoke } from "./workdesk-persistence-smoke";
import {
  LOAD_WORKSPACE_STATE_CHANNEL,
  SAVE_WORKSPACE_STATE_CHANNEL,
  createWorkspaceStateHandlers
} from "./workspace-state-ipc";
import { FileWorkspaceStateStore } from "./workspace-state-service";
import {
  AUTOSAVE_FLUSH_REQUEST_CHANNEL,
  AUTOSAVE_FLUSH_RESPONSE_CHANNEL,
  isAutosaveFlushResponseRequest,
  type AutosaveFlushResponseResult
} from "./autosave-ipc";
import { AutosaveShutdownCoordinator } from "./autosave-shutdown";
import { establishApplicationIdentity, MAGINALIA_APPLICATION_NAME } from "./application-identity";
import { enforceE2EIsolationBeforeStartup } from "./e2e-isolation";
import { FirstRunCoordinator } from "./first-run-coordinator";
import { FirstRunJournalStore } from "./first-run-setup";
import { runFirstRunRestoreSmoke, runFirstRunSmoke } from "./first-run-smoke";
import { runSettingsSmoke } from "./settings-smoke";
import {
  createApplicationMenuTemplate,
  createApplicationMenuUpdateHandler,
  dispatchApplicationMenuCommand,
  UPDATE_APPLICATION_MENU_CHANNEL
} from "./application-menu";
import { resolvePackagedRuntimePaths } from "./packaged-runtime-paths";
import { ensureNdlocrConfiguration } from "./ndlocr-runtime-configuration";
import { OPEN_BUNDLED_MANUAL_CHANNEL } from "./manual-ipc";
import {
  FIRST_RUN_PROGRESS_CHANNEL,
  GET_FIRST_RUN_STATUS_CHANNEL,
  RUN_FIRST_RUN_SETUP_CHANNEL,
  isFirstRunChoices,
} from "./first-run-ipc";

// Test-only E2E isolation gate (#93). Inert unless MAGINALIA_E2E_ISOLATION_ROOT
// is set; otherwise it exits with code 78 before any Desktop side effect when a
// Desktop-controlled destination resolves outside the disposable test root.
enforceE2EIsolationBeforeStartup(app);

// Set a product-stable Electron identity before resolving any local stores.
// Retain the profile Electron selected before this upgrade so existing state
// is not silently moved to a new MAGINALIA-named directory.
const applicationIdentity = establishApplicationIdentity(app);
const userDataPath = applicationIdentity.userDataPath;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Do not construct services, register IPC, or touch app state in a second
  // process. The first process remains the sole owner of the app data root.
  app.quit();
} else {
const quickSmokeMode = process.argv.includes("--smoke");
const brandProgressSmoke = process.argv.includes("--brand-progress-smoke");
const firstRunSmoke = process.argv.includes("--first-run-smoke");
const firstRunRestoreSmoke = process.argv.includes("--first-run-restore-smoke");
const settingsSmokeRequested = process.argv.includes("--smoke-settings") || process.argv.includes("--smoke-settings-restore");
const settingsSmokeRestore = process.argv.includes("--smoke-settings-restore");
const writingSmoke = parseWritingSmokeMode(process.argv);
const workspaceSmoke = parseWorkspaceSmokeMode(process.argv);
const quotationSmoke = parseQuotationSmokeMode(process.argv);
const projectSmoke = parseProjectSmokeMode(process.argv);
const repositorySmoke = parseRepositorySmokeMode(process.argv);
const shelfSmoke = parseShelfSmokeMode(process.argv);
const d5Smoke = parseD5SmokeMode(process.argv);
const exportSmoke = parseExportSmokeMode(process.argv);
const gSmoke = parseGSmokeMode(process.argv);
const hSmoke = parseHSmokeMode(process.argv);
const h5Smoke = parseH5SmokeMode(process.argv);
const workdeskPersistenceSmoke = parseWorkdeskPersistenceSmokeMode(process.argv);
let workdeskPersistencePickerInvocationCount = 0;
let hSmokePickerInvocationCount = 0;
let hSmokeProjectPickerInvocationCount = 0;
let hSmokeRegistrationPromptInvocationCount = 0;
let hSmokeWorkdeskRoot: string | null = hSmoke.acceptance ? hSmoke.rootPath ?? null : null;
let hSmokeProjectRoot: string | null = hSmoke.acceptance ? hSmoke.projectRootPath ?? null : null;
const hSmokeProjectRoots: string[] = [];
const smokeMode = quickSmokeMode
  || settingsSmokeRequested
  || writingSmoke.requested
  || workspaceSmoke.requested
  || quotationSmoke.requested
  || projectSmoke.requested
  || repositorySmoke.requested
  || shelfSmoke.requested
  || d5Smoke.requested
  || exportSmoke.requested
  || gSmoke.requested
  || hSmoke.requested
  || h5Smoke.requested
  || workdeskPersistenceSmoke.requested
  || brandProgressSmoke
  || firstRunSmoke
  || firstRunRestoreSmoke;
const markdownFileService = new MarkdownFileService();
const workspaceStateStore = new FileWorkspaceStateStore(path.join(userDataPath, "workspace-state.json"));
const workspaceStateHandlers = createWorkspaceStateHandlers({
  load: () => workspaceStateStore.load(),
  save: (state) => workspaceStateStore.save(state)
});
const documentWorkspaceService = new DocumentWorkspaceService();
const projectPathStore = new FileProjectPathStore(path.join(userDataPath, "last-project.json"));
const projectService = new ProjectService(
  documentWorkspaceService,
  markdownFileService,
  projectPathStore
);
const projectAssetService = new ProjectAssetService(documentWorkspaceService);
const libraryService = new LibraryService();
let desktopConfigurationPaths: DesktopConfigurationPaths | undefined;
let shelfBindingStoragePaths: ShelfBindingStoragePaths | undefined;
let shelfBindingStore: ReturnType<typeof createShelfBindingFileStore> | undefined;
function getDesktopConfigurationPaths(): DesktopConfigurationPaths {
  // Electron chooses userData; resolving lazily ensures that path is final and
  // avoids accidentally binding Shelf discovery to bootstrap cwd/state.
  desktopConfigurationPaths ??= resolveDesktopConfigurationPaths(userDataPath);
  return desktopConfigurationPaths;
}

function getShelfBindingStorage(): {
  readonly paths: ShelfBindingStoragePaths;
  readonly store: ReturnType<typeof createShelfBindingFileStore>;
} {
  shelfBindingStoragePaths ??= resolveShelfBindingStoragePaths(getNativeLocalAppDataPath());
  // Missing integration directories are created with a protected current-user /
  // SYSTEM / Administrators DACL so the Collector ACL check can pass even when the
  // inherited LocalAppData ACL grants other principals write access.
  shelfBindingStore ??= createShelfBindingFileStore(shelfBindingStoragePaths.bindingDirectory, {
    createDirectory: async (directory) => { createNativePrivateDirectory(directory); },
  });
  return { paths: shelfBindingStoragePaths, store: shelfBindingStore };
}

let collectorSaveDestinationBusy = false;

async function showCollectorSaveDestinationDialog(options: MessageBoxOptions) {
  return mainWindow === null || mainWindow.isDestroyed()
    ? dialog.showMessageBox(options)
    : dialog.showMessageBox(mainWindow, options);
}

/** Runs one Collector save-destination command; dialogs are owned by the main process. */
async function runCollectorSaveDestinationCommand(
  command: (dependencies: CollectorSaveDestinationDependencies) => Promise<CollectorSaveDestinationIpcResult>,
): Promise<CollectorSaveDestinationIpcResult> {
  if (collectorSaveDestinationBusy) return { kind: "busy" };
  collectorSaveDestinationBusy = true;
  try {
    let storage: ReturnType<typeof getShelfBindingStorage>;
    try {
      storage = getShelfBindingStorage();
    } catch {
      await showCollectorSaveDestinationDialog({
        type: "error",
        title: "Collector の保存先",
        message: "Collector 連携の設定場所を確認できません。",
        detail: "Windows のユーザー用ローカルアプリデータフォルダーを確認できませんでした。Collector の保存先の設定は変更されていません。",
        noLink: true,
      });
      return { kind: "error" };
    }
    return await command({
      shelfLocationPath: getDesktopConfigurationPaths().shelfLocationPath,
      storagePaths: storage.paths,
      store: storage.store,
      inspectPathSecurity: inspectNativePathSecurity,
      removeBinding: () => removeShelfBindingFile(storage.paths.bindingDirectory),
      confirm: async (request) => {
        const text = collectorSaveDestinationConfirmationText(request);
        const result = await showCollectorSaveDestinationDialog({
          type: "question",
          title: text.title,
          message: text.message,
          detail: text.detail,
          buttons: [text.confirmLabel, "キャンセル"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      },
      notify: async (notice) => {
        await showCollectorSaveDestinationDialog({
          type: notice.type,
          title: "Collector の保存先",
          message: notice.message,
          ...(notice.detail === undefined ? {} : { detail: notice.detail }),
          noLink: true,
        });
      },
    });
  } catch {
    return { kind: "error" };
  } finally {
    collectorSaveDestinationBusy = false;
  }
}

let configuredPrivateShelf: ConfiguredPrivateShelf | undefined;
function getConfiguredPrivateShelf(): ConfiguredPrivateShelf {
  configuredPrivateShelf ??= new ConfiguredPrivateShelf(
    new ShelfLocationRegistry(getDesktopConfigurationPaths().shelfLocationPath),
    libraryService,
  );
  return configuredPrivateShelf;
}

async function getActivePrivateShelfForDesktop(owner: object) {
  const configured = getConfiguredPrivateShelf();
  const active = await configured.getActive(owner);
  if (active.kind !== "error" || !await configured.isPrivateShelfUnconfigured()) return active;

  // This is intentionally a one-purpose recovery path, not a Settings UI.
  // It runs only after a user invokes the normal Shelf flow and only when the
  // explicit registry says its Private Shelf is null.
  let selection: OpenDialogReturnValue;
  try {
    selection = await dialog.showOpenDialog({
      title: "Choose Private Shelf",
      properties: ["openDirectory"],
    });
  } catch {
    return active;
  }
  if (selection.canceled || selection.filePaths.length !== 1) return active;
  return configured.configureAndOpen(owner, selection.filePaths[0]);
}

async function getReviewerShelfWriteCoordination(shelfRoot: string) {
  const owner = mainWindow?.webContents;
  if (owner === undefined || owner.isDestroyed()) throw new Error("The Desktop window is unavailable.");
  const active = await getConfiguredPrivateShelf().getActive(owner);
  if (active.kind !== "private-shelf" || active.folderIdentityRecovery !== undefined) {
    throw new Error("The configured Private Shelf identity cannot be verified.");
  }
  const configurationPath = getDesktopConfigurationPaths().shelfLocationPath;
  const location = await new ShelfLocationRegistry(configurationPath).load();
  if (location.kind !== "loaded" || typeof location.config.privateShelf.registry !== "string") {
    throw new Error("The configured Private Shelf location cannot be read.");
  }
  const privateShelfLocator = location.config.privateShelf.registry;
  let canonicalConfiguredRoot: string;
  let canonicalRequestedRoot: string;
  try {
    [canonicalConfiguredRoot, canonicalRequestedRoot] = await Promise.all([
      realpath(privateShelfLocator),
      realpath(shelfRoot),
    ]);
  } catch {
    throw new Error("The configured Private Shelf is unavailable.");
  }
  if (path.resolve(canonicalConfiguredRoot) !== path.resolve(active.canonicalRoot)
    || path.resolve(canonicalRequestedRoot) !== path.resolve(active.canonicalRoot)) {
    throw new Error("The configured Private Shelf changed before Reviewer materialization.");
  }
  const markerInspection = await inspectFolderMarkers(active.canonicalRoot);
  if (markerInspection.kind !== "valid" || markerInspection.marker.type !== "shelf"
    || (active.folderIdentityId !== undefined && active.folderIdentityId.toLowerCase() !== markerInspection.marker.id.toLowerCase())) {
    throw new Error("The configured Private Shelf marker is missing, conflicting, or changed.");
  }

  const storage = getShelfBindingStorage();
  const context = {
    shelfName: active.library.displayName,
    shelfRoot: active.canonicalRoot,
    shelfLocationPath: configurationPath,
    privateShelfLocator,
    typedMarker: markerInspection.marker,
  };
  return resolveReviewerShelfWriteCoordination({
    storagePaths: storage.paths,
    store: storage.store,
    context,
    confirmRebind: async (reason, shelf) => {
      const detail = reason === "binding-missing"
        ? "MAGINALIA will remember this explicitly selected Private Shelf for Reviewer writes and shared Windows coordination. It will not change Shelf files or its identity marker."
        : "The configured Shelf path or identity differs from the saved connection. Reconfirm this Shelf to update MAGINALIA's binding. No Shelf files or identity markers will be changed.";
      const options: MessageBoxOptions = {
        type: "question",
        title: "Confirm Private Shelf connection",
        message: `Use ${shelf.shelfName} for Reviewer writes?`,
        detail,
        buttons: ["Confirm Shelf", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result = mainWindow === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(mainWindow, options);
      return result.response === 0;
    },
    reloadConfiguration: async () => {
      const latest = await new ShelfLocationRegistry(configurationPath).load();
      return latest.kind === "loaded" ? latest.config.privateShelf.registry : null;
    },
    reloadTypedMarker: async () => {
      const latest = await inspectFolderMarkers(active.canonicalRoot).catch(() => undefined);
      return latest?.kind === "valid" && latest.marker.type === "shelf" ? latest.marker : null;
    },
  });
}
// The main process is the only owner of the Reviewer process, workspace, and
// loopback origin.  It is deliberately lazy: ordinary Project/Workdesk work
// never needs a Python runtime merely to open MAGINALIA.
let reviewerProcessManager: ReviewerProcessManager | undefined;
function getReviewerProcessManager(): ReviewerProcessManager {
  const packagedRuntime = app.isPackaged ? resolvePackagedRuntimePaths(process.resourcesPath) : null;
  reviewerProcessManager ??= new ReviewerProcessManager({
    ...(packagedRuntime === null ? {} : {
      launchStrategy: new PackagedReviewerLaunchStrategy(packagedRuntime.reviewerExecutable),
      contractsDir: packagedRuntime.contractsDirectory,
    }),
    workspaceLocator: new UserDataReviewerWorkspaceLocator(userDataPath),
    // Reviewer keeps its existing explicit CLI/config boundary. The Desktop
    // supplies the deterministic, absolute application configuration path.
    ndlocrConfigPath: getDesktopConfigurationPaths().ndlocrConfigPath,
    // Normal Desktop operation never adopts a renderer- or developer-selected
    // endpoint. The two pre-existing deterministic Electron smoke harnesses
    // are the sole exception: their process command line explicitly selects
    // a local fixture server, and this is never exposed to product renderers.
    envOverrideUrl: (shelfSmoke.requested || exportSmoke.requested)
      ? (process.env.MAGINALIA_REVIEWER_BASE_URL ?? "")
      : ""
  });
  return reviewerProcessManager;
}

async function getManagedReviewerBaseUrl(): Promise<string> {
  return (await getReviewerProcessManager().ensureReady()).href;
}

// A Reviewer window is deliberately separate from DocumentSession/tabs. Its
// preload reports approval only; the manager supplies the loopback origin.
let reviewerViewController: ReviewerViewController | undefined;
let reviewerWebContentsForH5Smoke: WebContents | undefined;
function getReviewerViewController(): ReviewerViewController {
  reviewerViewController ??= new ReviewerViewController({
    getManagedReviewerBaseUrl,
    hostFactory: {
      create: () => createReviewerEmbeddedHostForMain()
    }
  });
  return reviewerViewController;
}

/**
 * Mount the Reviewer as one bounded central service View inside the existing
 * Workbench window. It never becomes a BrowserWindow or DocumentSession.
 */
function createReviewerEmbeddedHostForMain() {
  const owner = mainWindow;
  if (owner === null || owner.isDestroyed()) throw new Error("No Workbench window is available.");
  return createReviewerEmbeddedHost<WebContentsView>(owner, () => {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "reviewer-preload.js")
      }
    });
    reviewerWebContentsForH5Smoke = view.webContents;
    return view;
  });
}
const workdeskPathStorePath = path.join(userDataPath, "workdesk-paths.json");
const workdeskPathStore = new FileWorkdeskPathStore(workdeskPathStorePath);
const workdeskService = new WorkdeskService(workdeskPathStore);
const firstRunJournal = new FirstRunJournalStore(path.join(userDataPath, "first-run-setup.json"));
let firstRunOnLaunch = false;

function getTutorialResourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "tutorial-sample")
    : path.resolve(__dirname, "..", "..", "..", "..", "Tutorial_sample_setup");
}

function createFirstRunCoordinator(owner: WebContents): FirstRunCoordinator {
  const defaultWorkdeskRoot = path.join(app.getPath("documents"), "MAGINALIA", "Workdesk");
  const defaultShelfRoot = path.join(app.getPath("documents"), "MAGINALIA", "Private Shelf");
  return new FirstRunCoordinator({
    journal: firstRunJournal,
    workdesks: workdeskService,
    libraries: libraryService,
    shelfLocations: new ShelfLocationRegistry(getDesktopConfigurationPaths().shelfLocationPath),
    tutorialRoot: getTutorialResourceRoot(),
    downloadsRoot: firstRunSmoke && process.env.MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS
      ? process.env.MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS
      : app.getPath("downloads"),
    defaultWorkdeskRoot,
    defaultShelfRoot,
    pickFolder: async (title, defaultPath) => {
      if (firstRunSmoke) {
        if (title.includes("Workdesk")) return process.env.MAGINALIA_FIRST_RUN_SMOKE_WORKDESK;
        if (title.includes("Shelf")) return process.env.MAGINALIA_FIRST_RUN_SMOKE_SHELF;
      }
      const options = { title, defaultPath, properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
      const window = BrowserWindow.fromWebContents(owner);
      const selection = window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
      return selection.canceled || selection.filePaths.length !== 1 ? undefined : selection.filePaths[0];
    },
    confirmAdoption: async (kind, folderName) => {
      const isWorkdesk = kind === "workdesk";
      const options: MessageBoxOptions = {
        type: "warning",
        title: "管理情報を作成しますか",
        message: `「${folderName}」を${isWorkdesk ? "Workdesk" : "Private Shelf"}として使いますか？`,
        detail: isWorkdesk
          ? "この場所には、利用できる管理情報がありません。新しい管理情報を追加します。ファイルはそのまま残りますが、以前のProject登録や前回の作業場所とはつながらない可能性があります。"
          : "Shelfの記録を読み取れます。新しい管理情報だけを追加します。引用や書籍の記録、画像はそのまま残ります。",
        buttons: ["管理情報を作成して続ける", "別の場所を選ぶ"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const window = BrowserWindow.fromWebContents(owner);
      const response = window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
      return response.response === 0;
    },
    onProgress: (message) => {
      if (!owner.isDestroyed()) owner.send(FIRST_RUN_PROGRESS_CHANNEL, { message });
    },
    onError: (error) => console.error("MAGINALIA_FIRST_RUN_SETUP_FAILED", error),
  });
}

async function shouldOpenFirstRunSetup(): Promise<boolean> {
  if (firstRunSmoke) return true;
  if (smokeMode) return false;
  const journal = await firstRunJournal.load();
  if (journal?.stage === "complete") return false;
  if (journal !== undefined) return true;
  try {
    const saved = await workdeskPathStore.loadForRestore();
    if (saved?.primaryWorkdesk) return false;
  } catch {
    // Preserve damaged app-local state and leave the existing recovery path available.
    return false;
  }
  return true;
}
const repositoryService = new LocalRepositoryService({
  // Repository History asks only the main-process Workdesk coordinator for
  // validated direct-child boundaries; renderer paths never become ignores.
  workdeskHistoryExclusionResolver: (root, identity) => workdeskService.historyExcludedChildDirectories(root, identity),
});
const documentWorkspaceHandlers = createDocumentWorkspaceHandlers({
  pickDocumentFolder: async () => {
    if (workspaceSmoke.requested || quotationSmoke.requested || shelfSmoke.requested || d5Smoke.requested) {
      const rootPath = workspaceSmoke.requested
        ? workspaceSmoke.rootPath
        : quotationSmoke.requested
          ? quotationSmoke.documentRoot
          : shelfSmoke.requested
            ? shelfSmoke.rootPath
            : d5Smoke.rootPath;
      return {
        canceled: false,
        filePaths: rootPath ? [rootPath] : []
      };
    }
    return dialog.showOpenDialog({
      title: "Open Document",
      properties: ["openDirectory"]
    });
  },
  openDocumentRoot: (owner, rootPath) => documentWorkspaceService.openForOwner(owner, rootPath),
  resolveManuscriptPath: (owner, documentId, manuscriptId) =>
    documentWorkspaceService.resolveManuscriptPath(owner, documentId, manuscriptId),
  openMarkdown: (owner, filePath) => markdownFileService.openForOwner(owner, filePath)
});
/** Workdesk child Projects are independent authorities, never loose Explorer entries. */
async function explorerExcludedRelativeRoots(owner: object, documentId: string): Promise<readonly string[]> {
  const root = await documentWorkspaceService.resolveDocumentRoot(owner, documentId);
  if (root.kind !== "resolved") return [];
  try {
    await workdeskService.open(root.canonicalRoot);
    return ["projects"];
  } catch {
    return [];
  }
}

async function isPermittedExplorerFolder(owner: object, documentId: string, parentEntryId: string | null): Promise<boolean> {
  if (parentEntryId === null) return true;
  const listed = await documentWorkspaceService.listExplorerForOwner(
    owner,
    documentId,
    await explorerExcludedRelativeRoots(owner, documentId)
  );
  return listed.kind === "listed" && listed.entries.some((entry) => entry.entryId === parentEntryId && entry.kind === "folder");
}

const explorerHandlers = createExplorerHandlers({
  listExplorer: async (owner, documentId) =>
    documentWorkspaceService.listExplorerForOwner(owner, documentId, await explorerExcludedRelativeRoots(owner, documentId)),
  createFolder: async (owner, documentId, parentEntryId, name) => {
    if (!await isPermittedExplorerFolder(owner, documentId, parentEntryId)) {
      return { kind: "error" as const, code: "explorer-entry-unavailable" as const, message: "Choose a folder in the Explorer." };
    }
    return documentWorkspaceService.createFolderForOwner(owner, documentId, parentEntryId, name);
  },
  deleteFile: async (owner, documentId, entryId) => {
    const resolved = await documentWorkspaceService.resolveExplorerFilePath(
      owner,
      documentId,
      entryId,
      await explorerExcludedRelativeRoots(owner, documentId)
    );
    if (resolved.kind !== "resolved") return resolved;
    try {
      await shell.trashItem(resolved.canonicalPath);
      return { kind: "deleted" as const, entryId };
    } catch {
      return { kind: "error" as const, code: "explorer-entry-unavailable" as const, message: "The file could not be moved to the Recycle Bin. It was not deleted." };
    }
  }
});
const projectHandlers = createProjectHandlers({
  pickProjectFolder: () => ((projectSmoke.requested && !projectSmoke.restore)
      || shelfSmoke.requested
      || (d5Smoke.requested && !d5Smoke.restore)
      || exportSmoke.requested
      || gSmoke.requested)
    ? Promise.resolve({
      canceled: false,
      filePaths: projectSmoke.requested && !projectSmoke.restore
        ? projectSmoke.rootPath ? [projectSmoke.rootPath] : []
        : shelfSmoke.requested
          ? shelfSmoke.rootPath ? [shelfSmoke.rootPath] : []
          : d5Smoke.requested
            ? d5Smoke.rootPath ? [d5Smoke.rootPath] : []
            : exportSmoke.requested
              ? exportSmoke.rootPath ? [exportSmoke.rootPath] : []
              : gSmoke.rootPath ? [gSmoke.rootPath] : []
    })
    : dialog.showOpenDialog({
      title: "Open Project",
      properties: ["openDirectory"]
    }),
  pickProjectParent: () => dialog.showOpenDialog({
      title: "Choose a folder for the new Project",
      properties: ["openDirectory"]
    }),
  openProjectRoot: (owner, rootPath) => projectService.openForOwner(owner, rootPath),
  createProject: (owner, parentPath, title) => projectService.createForOwner(owner, parentPath, title),
  restoreProject: (owner) => projectService.restoreForOwner(owner),
  openProjectFile: (owner, projectId, fileId) => projectService.openFileForOwner(owner, projectId, fileId),
  createProjectFile: (owner, request) => projectService.createFileForOwner(
    owner,
    request.projectId,
    request.fileName,
    request.title,
    request.documentType,
    request.parentEntryId ?? null
  )
});
const workdeskHandlers = createWorkdeskHandlers({
  pickWorkdeskFolder: () => {
    if (workdeskPersistenceSmoke.requested) {
      workdeskPersistencePickerInvocationCount += 1;
      const rootPath = workdeskPersistenceSmoke.rootPath;
      return Promise.resolve(workdeskPersistenceSmoke.restore !== true && rootPath
        ? { canceled: false, filePaths: [rootPath] }
        : { canceled: true, filePaths: [] });
    }
    if (hSmoke.requested) {
      hSmokePickerInvocationCount += 1;
      const rootPath = hSmokeWorkdeskRoot ?? hSmoke.rootPath;
      return Promise.resolve({ canceled: false, filePaths: rootPath ? [rootPath] : [] });
    }
    return dialog.showOpenDialog({
      title: "Open Workdesk",
      properties: ["openDirectory"]
    });
  },
  pickWorkdeskParent: () => hSmoke.requested && !hSmoke.restore
    ? Promise.resolve({ canceled: false, filePaths: hSmoke.rootPath ? [hSmoke.rootPath] : [] })
    : dialog.showOpenDialog({
    title: "Choose a folder for the new Workdesk",
    properties: ["openDirectory"]
  }),
  pickExistingProjectFolder: () => {
    if (hSmoke.requested) {
      hSmokeProjectPickerInvocationCount += 1;
      const rootPath = hSmokeProjectRoots[hSmokeProjectPickerInvocationCount - 1] ?? hSmokeProjectRoot;
      return Promise.resolve({
        canceled: !rootPath,
        filePaths: rootPath ? [rootPath] : [],
      });
    }
    return dialog.showOpenDialog({
      title: "Add existing Project",
      properties: ["openDirectory"]
    });
  },
  confirmAdoptWorkdesk: async () => {
    const options: MessageBoxOptions = {
      type: "warning",
      title: "Use this folder as Workdesk?",
      message: "This folder is not set up as a Workdesk yet.",
      detail: "MAGINALIA will add only the Workdesk identity marker. If no reusable legacy identity exists, it will assign a new identity that will not reconnect the former Workdesk's Project links, registrations, or saved context. To recover that identity, cancel and restore its original marker. Existing files and Git state will remain unchanged.",
      buttons: ["Use this folder", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const response = mainWindow === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
    return response.response === 0;
  },
  confirmRegisterExistingProject: async (): Promise<ExistingProjectRegistrationChoice> => {
    if (hSmoke.requested) {
      hSmokeRegistrationPromptInvocationCount += 1;
      if (hSmokeRegistrationPromptInvocationCount === 2) return "cancel";
      if (hSmokeRegistrationPromptInvocationCount === 3) return "open-without-registration";
      return "register";
    }
    const options: MessageBoxOptions = {
      type: "question",
      title: "WorkdeskにProjectを追加",
      message: "このプロジェクトをWorkdeskに登録しますか？",
      detail: "「はい」は登録して開きます。「いいえ」はWorkdeskに戻ります。「登録せずに開く」は一覧に登録せず、このProjectだけを開きます。",
      buttons: [...WORKDESK_PROJECT_REGISTRATION_DIALOG_BUTTONS],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const response = mainWindow === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
    return workdeskProjectRegistrationChoice(response.response);
  },
  service: workdeskService,
  projects: projectService,
  isPermittedWorkdeskFolder: isPermittedExplorerFolder
});
const projectLinkHandlers = createProjectLinkHandlers({
  resolveInternalLink: (owner, projectId, target) => projectService.resolveInternalLinkForOwner(owner, projectId, target),
  openInternalLink: (owner, projectId, fileId) => projectService.openInternalLinkedFileForOwner(owner, projectId, fileId),
  openExternal: async (url) => {
    await shell.openExternal(url, { activate: true });
  }
});
const syncedBlockHandlers = createSyncedBlockHandlers({
  resolveSyncedBlockDocument: (owner, projectId, target) => projectService.resolveSyncedDocumentForOwner(owner, projectId, target),
});
const projectSearchHandlers = createProjectSearchHandlers({
  searchProjectMarkdown: (owner, projectId, query) => projectService.searchMarkdownForOwner(owner, projectId, query)
});
const projectAssetHandlers = createProjectAssetHandlers({
  resolve: (owner, projectId, relativePath) => projectAssetService.resolveForOwner(owner, projectId, relativePath),
  importDroppedImage: (owner, projectId, sourcePath, optimize) =>
    projectAssetService.importDroppedImageForOwner(owner, projectId, sourcePath, optimize)
});
const libraryHandlers = createLibraryHandlers({
  pickLibraryFolder: () => quotationSmoke.requested
    ? Promise.resolve({
      canceled: false,
      filePaths: quotationSmoke.libraryRoot ? [quotationSmoke.libraryRoot] : []
    })
    : dialog.showOpenDialog({
      title: "Choose Library",
      properties: ["openDirectory"]
    }),
  openLibraryRoot: (owner, rootPath) => libraryService.openForOwner(owner, rootPath),
  searchLibrary: (owner, libraryId, query) => libraryService.searchForOwner(owner, libraryId, query),
  resolveQuotationForInsert: (owner, libraryId, annotationId) =>
    libraryService.resolveQuotationForInsertForOwner(owner, libraryId, annotationId)
});
const reviewerShelfSync = createReviewerShelfSyncAdapter({
  // Reviewer is started only for Shelf materialization or explicit refresh.
  // Its origin and process token stay in the main process.
  getBaseUrl: getManagedReviewerBaseUrl,
  getDesktopRequestToken: () => getReviewerProcessManager().getDesktopRequestToken(),
  getWriteCoordination: getReviewerShelfWriteCoordination,
});
let reviewerApprovalMaterialization: Promise<void> = Promise.resolve();
function handleReviewerCaptureApproved(event: Electron.IpcMainEvent, annotationId: unknown): void {
  if (typeof annotationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(annotationId)
    || !getReviewerViewController().ownsWebContents(event.sender)) return;
  reviewerApprovalMaterialization = reviewerApprovalMaterialization.then(async () => {
    const owner = mainWindow?.webContents;
    if (owner === undefined || owner.isDestroyed()) return;
    await materializeApprovedReviewerRecords(owner, getConfiguredPrivateShelf(), reviewerShelfSync);
  }).catch(() => {
    // Approval is authoritative in Reviewer; Shelf can be retried from Refresh Shelf.
  });
}
const shelfHandlers = createShelfHandlers({
  getActivePrivateShelf: (owner) => getActivePrivateShelfForDesktop(owner),
  searchPrivateShelf: (owner, libraryId, query) => libraryService.searchForOwner(owner, libraryId, query),
  synchronizePrivateShelf: reviewerShelfSync,
  reloadPrivateShelf: (owner) => getConfiguredPrivateShelf().reload(owner)
});
const referenceResolution = async (owner: object, documentText: string) => {
  const activeShelf = await getConfiguredPrivateShelf().getActive(owner);
  if (activeShelf.kind === "error") {
    return {
      kind: "error" as const,
      code: "invalid-request" as const,
      message: activeShelf.message
    };
  }
  return resolveShelfQuoteRefs(documentText, activeShelf.entities);
};
const referenceHandlers = createReferenceHandlers({ resolve: referenceResolution });
let exportDialogSequence = 0;
function createIsolatedPdfWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      partition: `maginalia-pdf-${randomUUID()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!destination.startsWith("file:")) event.preventDefault();
  });
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  return window;
}

const exportHandlers = createExportHandlers({
  sessions: markdownFileService,
  resolve: referenceResolution,
  showSaveDialog: (defaultPath, event, format) => {
    if (exportSmoke.requested && exportSmoke.rootPath) {
      exportDialogSequence += 1;
      return Promise.resolve({
        canceled: false,
        filePath: path.join(exportSmoke.rootPath, `export-${exportDialogSequence}.resolved.${format === "markdown" ? "md" : format}`)
      });
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender as WebContents);
    const options = {
      title: `Export ${format === "markdown" ? "Markdown" : format.toUpperCase()}`,
      defaultPath,
      filters: [{
        name: format === "markdown" ? "Markdown" : format.toUpperCase(),
        extensions: [format === "markdown" ? "md" : format]
      }]
    };
    return ownerWindow === null
      ? dialog.showSaveDialog(options)
      : dialog.showSaveDialog(ownerWindow, options);
  },
  resolveProjectAsset: (owner, projectId, relativePath) =>
    projectAssetService.resolveForOwner(owner, projectId, relativePath),
  writePdf: (outputPath, document, settings, images) => app.isPackaged || process.env.MAGINALIA_SMOKE_ELECTRON_PDF === "1"
    ? writePdfWithElectron(outputPath, document, settings, createIsolatedPdfWindow, undefined, images)
    : writePdfWithVivliostyle(outputPath, document, settings, undefined, {}, images),
  writeDocx: (outputPath, document, settings, images) => app.isPackaged
    ? writeDocxWithPandoc(outputPath, document, settings, resolvePackagedRuntimePaths(process.resourcesPath).pandocExecutable, images)
    : writeDocxWithPandoc(outputPath, document, settings, undefined, images)
});
const repositoryHandlers = createRepositoryHandlers({
  pickParentFolder: () => repositorySmoke.requested
    ? Promise.resolve({
      canceled: false,
      filePaths: repositorySmoke.rootPath
        ? [path.join(repositorySmoke.rootPath, "repository-parent")]
        : []
    })
    : dialog.showOpenDialog({
      title: "Create Repository",
      properties: ["openDirectory"]
    }),
  pickRepositoryFolder: () => repositorySmoke.requested
    ? Promise.resolve({ canceled: true, filePaths: [] })
    : dialog.showOpenDialog({
      title: "Open Repository",
      properties: ["openDirectory"]
    }),
  createRepository: (owner, parentRoot, kind, title) =>
    repositoryService.createForOwner(owner, parentRoot, kind, title),
  openRepository: (owner, root) => repositoryService.openForOwner(owner, root),
  resolveRepository: (owner, repositoryId) => repositoryService.resolveForOwner(owner, repositoryId),
  createHistory: (owner, repositoryId) => repositoryService.createHistoryForOwner(owner, repositoryId),
  listHistory: (owner, repositoryId) => repositoryService.listHistoryForOwner(owner, repositoryId),
  pickHistoryDestinationParent: () => repositorySmoke.requested
    ? Promise.resolve({
      canceled: false,
      filePaths: repositorySmoke.rootPath
        ? [path.join(repositorySmoke.rootPath, "history-destination")]
        : []
    })
    : dialog.showOpenDialog({
      title: "Open History Copy",
      properties: ["openDirectory"]
    }),
  openHistoryCopy: (owner, repositoryId, historyId, destinationParentRoot) => {
    return repositoryService.openHistoryCopyForOwner(owner, repositoryId, historyId, destinationParentRoot);
  },
  openDocument: (owner, root) => documentWorkspaceService.openForOwner(owner, root),
  openLibrary: (owner, root) => libraryService.openPrivateShelfForOwner(owner, root)
});
const INVALID_REQUEST: MarkdownFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Markdown save request was invalid."
};
let mainWindow: BrowserWindow | null = null;
let autosaveQuitSequence = 0;
type PendingAutosaveQuit = {
  readonly resolve: (ok: boolean) => void;
  readonly timer: NodeJS.Timeout;
};
const pendingAutosaveQuit = new Map<string, PendingAutosaveQuit>();
type PendingModCapability = {
  readonly modId: string;
  readonly resolve: (response: ModCapabilityResponse) => void;
  readonly timer: NodeJS.Timeout;
};

const pendingModCapabilities = new Map<string, PendingModCapability>();
let modCapabilitySequence = 0;

function installNativeApplicationMenu(snapshot: Parameters<typeof createApplicationMenuTemplate>[0]): void {
  const template = createApplicationMenuTemplate(snapshot, (commandId) => {
    dispatchApplicationMenuCommand(commandId, (channel, validatedCommandId) => {
      const window = mainWindow;
      if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(channel, validatedCommandId);
    });
  }, process.platform);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveModCapability(requestId: string, response: ModCapabilityResponse): boolean {
  const pending = pendingModCapabilities.get(requestId);
  if (pending === undefined) return false;
  pendingModCapabilities.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(response);
  return true;
}

function requestRendererModCapability(
  modId: string,
  request: { readonly kind: "open-document-view" | "close-view" | "get-active-document"; readonly requestId: string; readonly value: unknown }
): Promise<ModCapabilityResponse> {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    return Promise.resolve({ kind: "error", message: "The editor window is unavailable." });
  }
  const requestId = `renderer-${Date.now()}-${modCapabilitySequence++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingModCapabilities.delete(requestId);
      resolve({ kind: "error", message: "The Mod capability request timed out." });
    }, 5_000);
    pendingModCapabilities.set(requestId, { modId, resolve, timer });
    try {
      window.webContents.send(MOD_CAPABILITY_REQUEST_CHANNEL, {
        modId,
        kind: request.kind,
        requestId,
        value: request.value
      });
    } catch {
      clearTimeout(timer);
      pendingModCapabilities.delete(requestId);
      resolve({ kind: "error", message: "The editor window is unavailable." });
    }
  });
}

const modHost = new ModHost({
  userDataPath,
  onCapabilityRequest: (modId, request) => requestRendererModCapability(modId, request),
  onError: (message, error) => console.error(
    `MAGINALIA_MOD_ERROR ${message}${error instanceof Error ? ` ${error.message}` : error === undefined ? "" : ` ${JSON.stringify(error)}`}`
  )
});
// The renderer may request the initial snapshot as soon as its preload is
// ready. Keep that request behind the one startup discovery pass so a valid
// first-party Mod cannot appear to be missing merely because utility-process
// activation is still in flight.
let modHostReady: Promise<unknown> | undefined;

let writingSmokeFinished = false;
let settingsSmokeFinished = false;
let workspaceSmokeFinished = false;
let projectSmokeFinished = false;
let quotationSmokeFinished = false;
let repositorySmokeFinished = false;
let shelfSmokeFinished = false;
let d5SmokeFinished = false;
let exportSmokeFinished = false;
let gSmokeFinished = false;
let hSmokeFinished = false;
let h5SmokeFinished = false;
let workdeskPersistenceSmokeFinished = false;

function isLiveMainWindowSender(owner: object): owner is WebContents {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return false;
  const sender = window.webContents;
  return sender === owner && !sender.isDestroyed();
}

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function failWritingSmoke(error: unknown): void {
  if (writingSmokeFinished) return;
  writingSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_WRITING_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeWritingSmoke(): void {
  if (writingSmokeFinished) return;
  writingSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_WRITING_SMOKE_OK");
  app.quit();
}

function failSettingsSmoke(error: unknown): void {
  if (settingsSmokeFinished) return;
  settingsSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_SETTINGS_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeSettingsSmoke(): void {
  if (settingsSmokeFinished) return;
  settingsSmokeFinished = true;
  console.log("MAGINALIA_SETTINGS_SMOKE_OK");
  app.exit(0);
}

function failWorkspaceSmoke(error: unknown): void {
  if (workspaceSmokeFinished) return;
  workspaceSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_WORKSPACE_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeWorkspaceSmoke(): void {
  if (workspaceSmokeFinished) return;
  workspaceSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_WORKSPACE_SMOKE_OK");
  app.quit();
}

function failProjectSmoke(error: unknown): void {
  if (projectSmokeFinished) return;
  projectSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_PROJECT_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeProjectSmoke(): void {
  if (projectSmokeFinished) return;
  projectSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_PROJECT_SMOKE_OK");
  app.quit();
}

function failQuotationSmoke(error: unknown): void {
  if (quotationSmokeFinished) return;
  quotationSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_QUOTATION_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeQuotationSmoke(): void {
  if (quotationSmokeFinished) return;
  quotationSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_QUOTATION_SMOKE_OK");
  app.quit();
}

function failRepositorySmoke(error: unknown): void {
  if (repositorySmokeFinished) return;
  repositorySmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_REPOSITORY_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeRepositorySmoke(): void {
  if (repositorySmokeFinished) return;
  repositorySmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_REPOSITORY_SMOKE_OK");
  app.quit();
}

function failShelfSmoke(error: unknown): void {
  if (shelfSmokeFinished) return;
  shelfSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_SHELF_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeShelfSmoke(): void {
  if (shelfSmokeFinished) return;
  shelfSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_SHELF_SMOKE_OK");
  app.quit();
}

function failD5Smoke(error: unknown): void {
  if (d5SmokeFinished) return;
  d5SmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_D5_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeD5Smoke(): void {
  if (d5SmokeFinished) return;
  d5SmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_D5_SMOKE_OK");
  app.quit();
}

function failExportSmoke(error: unknown): void {
  if (exportSmokeFinished) return;
  exportSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_EXPORT_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeExportSmoke(): void {
  if (exportSmokeFinished) return;
  exportSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_EXPORT_SMOKE_OK");
  app.quit();
}

function failGSmoke(error: unknown): void {
  if (gSmokeFinished) return;
  gSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_G_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeGSmoke(): void {
  if (gSmokeFinished) return;
  gSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_G_SMOKE_OK");
  app.quit();
}

function failHSmoke(error: unknown): void {
  if (hSmokeFinished) return;
  hSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_H_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeHSmoke(): void {
  if (hSmokeFinished) return;
  hSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_H_SMOKE_OK");
  app.quit();
}

function failWorkdeskPersistenceSmoke(error: unknown): void {
  if (workdeskPersistenceSmokeFinished) return;
  workdeskPersistenceSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_WORKDESK_PERSISTENCE_FAILED ${message}`);
  app.exit(1);
}

function completeWorkdeskPersistenceSmoke(): void {
  if (workdeskPersistenceSmokeFinished) return;
  workdeskPersistenceSmokeFinished = true;
  const stage = workdeskPersistenceSmoke.restore ? "restore" : "first-run";
  console.log(`MAGINALIA_ELECTRON_WORKDESK_PERSISTENCE_OK appName=${JSON.stringify(applicationIdentity.applicationName)} stage=${stage} pickerCalls=${workdeskPersistencePickerInvocationCount} userData=${JSON.stringify(userDataPath)} pathStore=${JSON.stringify(workdeskPathStorePath)}`);
  app.quit();
}

function failH5Smoke(error: unknown): void {
  if (h5SmokeFinished) return;
  h5SmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_H5_SMOKE_FAILED ${message}`);
  // H.5 may already own Python. Stop it through the production graceful path
  // before failing the smoke process, rather than using immediate app.exit.
  void getReviewerProcessManager().shutdown().finally(() => app.exit(1));
}

function completeH5Smoke(): void {
  if (h5SmokeFinished) return;
  h5SmokeFinished = true;
  app.quit();
}

async function handleOpenMarkdown(event: IpcMainInvokeEvent): Promise<OpenMarkdownResult> {
  if (writingSmoke.requested) {
    if (!writingSmoke.filePath) {
      return {
        kind: "error",
        code: "invalid-request",
        message: "The writing smoke fixture path was not provided."
      };
    }
    return markdownFileService.openForOwner(event.sender, writingSmoke.filePath);
  }

  const selection = await dialog.showOpenDialog({
    title: "Open Markdown",
    properties: ["openFile"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }]
  });
  if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
  return markdownFileService.openForOwner(event.sender, selection.filePaths[0]);
}

function handleSaveMarkdown(event: IpcMainInvokeEvent, value: unknown): Promise<SaveMarkdownResult> {
  if (!isSaveMarkdownRequest(value)) return Promise.resolve(INVALID_REQUEST);
  return markdownFileService.saveForOwner(event.sender, value);
}

async function handleLoadMods(event: IpcMainInvokeEvent, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender)) {
    return modHost.snapshot();
  }
  await modHostReady;
  return modHost.snapshot();
}

async function handleReloadMods(event: IpcMainInvokeEvent, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender)) {
    return modHost.snapshot();
  }
  await modHostReady;
  return modHost.reload();
}

async function handleOpenModsFolder(event: IpcMainInvokeEvent, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender)) {
    return { kind: "error" as const, message: "The Mods request was invalid." };
  }
  try {
    await modHost.openModsFolder();
    return { kind: "opened" as const };
  } catch {
    return { kind: "error" as const, message: "The Mods folder could not be opened." };
  }
}

async function handleInvokeModCommand(event: IpcMainInvokeEvent, value: unknown, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender) || !isModCommandRequest(value)) {
    return { kind: "error" as const, code: "invalid-request" as const, message: "The Mod request was invalid." };
  }
  try {
    const result = await modHost.invokeCommand(value.modId, value.commandId, value.args);
    return { kind: "result" as const, value: result };
  } catch {
    return { kind: "error" as const, code: "mod-unavailable" as const, message: "The Mod command is unavailable." };
  }
}

async function handleRespondModCapability(
  event: IpcMainInvokeEvent,
  value: unknown,
  ...args: readonly unknown[]
) {
  if (args.length !== 0
    || !isLiveMainWindowSender(event.sender)
    || !isModCapabilityResponseRequest(value)) {
    return { kind: "error" as const, message: "The Mod capability response was invalid." };
  }
  const accepted = resolveModCapability(value.requestId, value.response);
  return accepted
    ? { kind: "accepted" as const }
    : { kind: "error" as const, message: "The Mod capability request is no longer pending." };
}

function handleAutosaveFlushResponse(
  event: IpcMainInvokeEvent,
  value: unknown,
  ...args: readonly unknown[]
): AutosaveFlushResponseResult {
  if (args.length !== 0
    || !isLiveMainWindowSender(event.sender)
    || !isAutosaveFlushResponseRequest(value)) {
    return { kind: "error", message: "The Autosave response was invalid." };
  }
  const pending = pendingAutosaveQuit.get(value.requestId);
  if (pending === undefined) {
    return { kind: "error", message: "The Autosave request is no longer pending." };
  }
  pendingAutosaveQuit.delete(value.requestId);
  clearTimeout(pending.timer);
  pending.resolve(value.ok);
  return { kind: "accepted" };
}

async function logWorkdeskPersistenceDiagnostic(action: "open" | "restore", result: unknown): Promise<void> {
  if (process.env.MAGINALIA_WORKDESK_DIAGNOSTICS !== "1" && !workdeskPersistenceSmoke.requested) return;
  let savedState: Awaited<ReturnType<FileWorkdeskPathStore["loadForRestore"]>>;
  let stateStatus = "readable";
  try {
    savedState = await workdeskPathStore.loadForRestore();
    if (savedState === undefined) stateStatus = "missing";
  } catch (error) {
    savedState = undefined;
    stateStatus = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "unreadable";
  }
  const record = typeof result === "object" && result !== null
    ? result as { readonly kind?: unknown; readonly lastActiveContext?: unknown }
    : undefined;
  const resultKind = typeof record?.kind === "string" ? record.kind : "unknown";
  console.info(`MAGINALIA_WORKDESK_${action.toUpperCase()}_DIAGNOSTIC ${JSON.stringify({
    appName: applicationIdentity.applicationName,
    userDataPath,
    pathStorePath: workdeskPathStorePath,
    pathStoreState: stateStatus,
    primaryWorkdesk: savedState?.primaryWorkdesk ?? null,
    lastActiveContext: record?.lastActiveContext ?? null,
    action,
    result: resultKind,
    reason: action === "open"
      ? (resultKind === "opened" ? "folder-selected-and-opened" : "folder-selection-did-not-open")
      : (resultKind === "none" ? "no-saved-primary" : resultKind === "opened" ? "remembered-primary-restored" : "restore-failed"),
  })}`);
}

function registerMarkdownIpc(): void {
  ipcMain.handle(UPDATE_APPLICATION_MENU_CHANNEL, createApplicationMenuUpdateHandler(
    () => mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.webContents,
    installNativeApplicationMenu
  ));
  ipcMain.handle(CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL, async (event): Promise<CollectorSaveDestinationIpcResult> => {
    if (event.sender !== mainWindow?.webContents) return { kind: "error" };
    return runCollectorSaveDestinationCommand(configureCollectorSaveDestination);
  });
  ipcMain.handle(CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL, async (event): Promise<CollectorSaveDestinationIpcResult> => {
    if (event.sender !== mainWindow?.webContents) return { kind: "error" };
    return runCollectorSaveDestinationCommand(clearCollectorSaveDestination);
  });
  ipcMain.handle(OPEN_BUNDLED_MANUAL_CHANNEL, async (event) => {
    if (event.sender !== mainWindow?.webContents) return { kind: "error" as const };
    const manualPath = app.isPackaged
      ? resolvePackagedRuntimePaths(process.resourcesPath).manualPdfPath
      : path.resolve(__dirname, "..", "..", "packaging", "manual", "マニュアル.pdf");
    if (!existsSync(manualPath)) return { kind: "missing" as const };
    try {
      const error = await shell.openPath(manualPath);
      return error.length === 0 ? { kind: "opened" as const } : { kind: "error" as const };
    } catch {
      return { kind: "error" as const };
    }
  });
  ipcMain.handle(GET_FIRST_RUN_STATUS_CHANNEL, async (event) => {
    if (event.sender !== mainWindow?.webContents) return { kind: "error" as const, message: "設定画面を確認できませんでした。" };
    try {
      const journal = await firstRunJournal.load();
      return journal?.stage === "complete"
        ? { kind: "complete" as const, stage: "complete" }
        : { kind: "ready" as const, stage: journal?.stage ?? "start" };
    } catch {
      return { kind: "error" as const, message: "設定を読み取れませんでした。選んだ場所のデータは変更していません。もう一度お試しください。" };
    }
  });
  ipcMain.handle(RUN_FIRST_RUN_SETUP_CHANNEL, async (event, choices: unknown) => {
    if (event.sender !== mainWindow?.webContents || !isFirstRunChoices(choices)) {
      return { kind: "error" as const, message: "設定内容を確認できませんでした。画面を閉じず、もう一度お試しください。" };
    }
    return createFirstRunCoordinator(event.sender).run(event.sender, choices);
  });
  ipcMain.handle(OPEN_MARKDOWN_CHANNEL, handleOpenMarkdown);
  ipcMain.handle(SAVE_MARKDOWN_CHANNEL, handleSaveMarkdown);
  ipcMain.handle(OPEN_DOCUMENT_CHANNEL, documentWorkspaceHandlers.openDocument);
  ipcMain.handle(OPEN_MANUSCRIPT_CHANNEL, documentWorkspaceHandlers.openManuscript);
  ipcMain.handle(LIST_EXPLORER_CHANNEL, explorerHandlers.listExplorer);
  ipcMain.handle(CREATE_EXPLORER_FOLDER_CHANNEL, explorerHandlers.createFolder);
  ipcMain.handle(DELETE_EXPLORER_FILE_CHANNEL, explorerHandlers.deleteFile);
  ipcMain.handle(OPEN_PROJECT_CHANNEL, projectHandlers.openProject);
  ipcMain.handle(CREATE_PROJECT_CHANNEL, projectHandlers.createProject);
  ipcMain.handle(RESTORE_PROJECT_CHANNEL, projectHandlers.restoreProject);
  ipcMain.handle(OPEN_PROJECT_FILE_CHANNEL, projectHandlers.openProjectFile);
  ipcMain.handle(CREATE_PROJECT_FILE_CHANNEL, projectHandlers.createProjectFile);
  // Workdesk responses are explicit data-transfer objects. Cloning here also
  // makes the main/preload boundary reject any accidental service object
  // before Electron attempts to serialize it for a renderer.
  const workdeskIpc = <T>(handler: (event: Electron.IpcMainInvokeEvent, ...args: readonly unknown[]) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, ...args: readonly unknown[]): Promise<T> =>
      structuredClone(await handler(event, ...args));
  ipcMain.handle(OPEN_WORKDESK_CHANNEL, async (event, ...args) => {
    const result = await workdeskIpc(workdeskHandlers.openWorkdesk)(event, ...args);
    await logWorkdeskPersistenceDiagnostic("open", result);
    return result;
  });
  ipcMain.handle(CREATE_WORKDESK_CHANNEL, workdeskIpc(workdeskHandlers.createWorkdesk));
  ipcMain.handle(RESTORE_WORKDESK_CHANNEL, async (event, ...args) => {
    const result = await workdeskIpc(workdeskHandlers.restoreWorkdesk)(event, ...args);
    await logWorkdeskPersistenceDiagnostic("restore", result);
    return result;
  });
  ipcMain.handle(RETURN_TO_WORKDESK_CHANNEL, workdeskIpc(workdeskHandlers.returnToWorkdesk));
  ipcMain.handle(SAVE_WORKDESK_CONTEXT_CHANNEL, workdeskIpc(workdeskHandlers.saveWorkdeskContext));
  ipcMain.handle(CREATE_WORKDESK_FILE_CHANNEL, workdeskIpc(workdeskHandlers.createWorkdeskFile));
  ipcMain.handle(CREATE_WORKDESK_PROJECT_CHANNEL, workdeskIpc(workdeskHandlers.createWorkdeskProject));
  ipcMain.handle(REGISTER_WORKDESK_PROJECT_CHANNEL, workdeskIpc(workdeskHandlers.registerWorkdeskProject));
  ipcMain.handle(REMOVE_WORKDESK_PROJECT_CHANNEL, workdeskIpc(workdeskHandlers.removeWorkdeskProject));
  ipcMain.handle(OPEN_WORKDESK_PROJECT_CHANNEL, workdeskIpc(workdeskHandlers.openWorkdeskProject));
  ipcMain.handle(COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL, workdeskIpc(workdeskHandlers.copyWorkdeskFileToProject));
  ipcMain.handle(RESOLVE_INTERNAL_LINK_CHANNEL, projectLinkHandlers.resolveInternalLink);
  ipcMain.handle(OPEN_INTERNAL_LINK_CHANNEL, projectLinkHandlers.openInternalLink);
  ipcMain.handle(OPEN_EXTERNAL_LINK_CHANNEL, projectLinkHandlers.openExternalLink);
  ipcMain.handle(RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL, syncedBlockHandlers.resolveSyncedBlockDocument);
  ipcMain.handle(SEARCH_PROJECT_MARKDOWN_CHANNEL, projectSearchHandlers.searchProjectMarkdown);
  ipcMain.handle(RESOLVE_PROJECT_ASSET_CHANNEL, projectAssetHandlers.resolveAsset);
  ipcMain.handle(IMPORT_DROPPED_IMAGE_CHANNEL, projectAssetHandlers.importDroppedImage);
  ipcMain.handle(OPEN_LIBRARY_CHANNEL, libraryHandlers.openLibrary);
  ipcMain.handle(SEARCH_LIBRARY_CHANNEL, libraryHandlers.searchLibrary);
  ipcMain.handle(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL, libraryHandlers.resolveQuotationForInsert);
  ipcMain.handle(SEARCH_SHELF_CHANNEL, shelfHandlers.searchShelf);
  ipcMain.handle(REFRESH_SHELF_CHANNEL, shelfHandlers.refreshShelf);
  ipcMain.handle(OPEN_REVIEWER_VIEW_CHANNEL, () => getReviewerViewController().open());
  ipcMain.handle(CLOSE_REVIEWER_VIEW_CHANNEL, () => getReviewerViewController().close());
  ipcMain.handle(SET_REVIEWER_VIEW_BOUNDS_CHANNEL, (event, bounds: unknown) => {
    if (event.sender !== mainWindow?.webContents || !isSafeReviewerViewBounds(bounds)) return;
    getReviewerViewController().setBounds(bounds);
  });
  ipcMain.on(REVIEWER_APPROVAL_NOTIFICATION_CHANNEL, handleReviewerCaptureApproved);
  ipcMain.handle(RESOLVE_REFERENCES_CHANNEL, referenceHandlers.resolveReferences);
  ipcMain.handle(RESOLVE_EXPORT_CHANNEL, exportHandlers.resolveExport);
  ipcMain.handle(WRITE_EXPORT_CHANNEL, exportHandlers.writeExport);
  ipcMain.handle(LOAD_MODS_CHANNEL, handleLoadMods);
  ipcMain.handle(RELOAD_MODS_CHANNEL, handleReloadMods);
  ipcMain.handle(OPEN_MODS_FOLDER_CHANNEL, handleOpenModsFolder);
  ipcMain.handle(INVOKE_MOD_COMMAND_CHANNEL, handleInvokeModCommand);
  ipcMain.handle(RESPOND_MOD_CAPABILITY_CHANNEL, handleRespondModCapability);
  ipcMain.handle(AUTOSAVE_FLUSH_RESPONSE_CHANNEL, handleAutosaveFlushResponse);
  ipcMain.handle(LOAD_WORKSPACE_STATE_CHANNEL, workspaceStateHandlers.loadWorkspaceState);
  ipcMain.handle(SAVE_WORKSPACE_STATE_CHANNEL, workspaceStateHandlers.saveWorkspaceState);
  ipcMain.handle(CREATE_REPOSITORY_CHANNEL, repositoryHandlers.createRepository);
  ipcMain.handle(CREATE_REPOSITORY_HISTORY_CHANNEL, repositoryHandlers.createRepositoryHistory);
  ipcMain.handle(LIST_REPOSITORY_HISTORY_CHANNEL, repositoryHandlers.listRepositoryHistory);
  ipcMain.handle(OPEN_REPOSITORY_CHANNEL, repositoryHandlers.openRepository);
  ipcMain.handle(OPEN_REPOSITORY_HISTORY_CHANNEL, repositoryHandlers.openRepositoryHistory);
  ipcMain.handle(OPEN_REPOSITORY_DOCUMENT_CHANNEL, repositoryHandlers.openRepositoryDocument);
  ipcMain.handle(USE_REPOSITORY_SHELF_CHANNEL, repositoryHandlers.useRepositoryShelf);
}

function unregisterMarkdownIpc(): void {
  ipcMain.removeHandler(UPDATE_APPLICATION_MENU_CHANNEL);
  ipcMain.removeHandler(OPEN_BUNDLED_MANUAL_CHANNEL);
  ipcMain.removeHandler(CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL);
  ipcMain.removeHandler(CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL);
  ipcMain.removeHandler(GET_FIRST_RUN_STATUS_CHANNEL);
  ipcMain.removeHandler(RUN_FIRST_RUN_SETUP_CHANNEL);
  ipcMain.removeHandler(OPEN_MARKDOWN_CHANNEL);
  ipcMain.removeHandler(SAVE_MARKDOWN_CHANNEL);
  ipcMain.removeHandler(OPEN_DOCUMENT_CHANNEL);
  ipcMain.removeHandler(OPEN_MANUSCRIPT_CHANNEL);
  ipcMain.removeHandler(OPEN_PROJECT_CHANNEL);
  ipcMain.removeHandler(CREATE_PROJECT_CHANNEL);
  ipcMain.removeHandler(RESTORE_PROJECT_CHANNEL);
  ipcMain.removeHandler(OPEN_PROJECT_FILE_CHANNEL);
  ipcMain.removeHandler(CREATE_PROJECT_FILE_CHANNEL);
  ipcMain.removeHandler(OPEN_WORKDESK_CHANNEL);
  ipcMain.removeHandler(CREATE_WORKDESK_CHANNEL);
  ipcMain.removeHandler(RESTORE_WORKDESK_CHANNEL);
  ipcMain.removeHandler(RETURN_TO_WORKDESK_CHANNEL);
  ipcMain.removeHandler(SAVE_WORKDESK_CONTEXT_CHANNEL);
  ipcMain.removeHandler(CREATE_WORKDESK_FILE_CHANNEL);
  ipcMain.removeHandler(RESOLVE_INTERNAL_LINK_CHANNEL);
  ipcMain.removeHandler(OPEN_INTERNAL_LINK_CHANNEL);
  ipcMain.removeHandler(OPEN_EXTERNAL_LINK_CHANNEL);
  ipcMain.removeHandler(RESOLVE_PROJECT_ASSET_CHANNEL);
  ipcMain.removeHandler(IMPORT_DROPPED_IMAGE_CHANNEL);
  ipcMain.removeHandler(OPEN_LIBRARY_CHANNEL);
  ipcMain.removeHandler(SEARCH_LIBRARY_CHANNEL);
  ipcMain.removeHandler(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL);
  ipcMain.removeHandler(SEARCH_SHELF_CHANNEL);
  ipcMain.removeHandler(REFRESH_SHELF_CHANNEL);
  ipcMain.removeHandler(OPEN_REVIEWER_VIEW_CHANNEL);
  ipcMain.removeHandler(CLOSE_REVIEWER_VIEW_CHANNEL);
  ipcMain.removeHandler(SET_REVIEWER_VIEW_BOUNDS_CHANNEL);
  ipcMain.removeListener(REVIEWER_APPROVAL_NOTIFICATION_CHANNEL, handleReviewerCaptureApproved);
  ipcMain.removeHandler(RESOLVE_REFERENCES_CHANNEL);
  ipcMain.removeHandler(RESOLVE_EXPORT_CHANNEL);
  ipcMain.removeHandler(WRITE_EXPORT_CHANNEL);
  ipcMain.removeHandler(LOAD_MODS_CHANNEL);
  ipcMain.removeHandler(RELOAD_MODS_CHANNEL);
  ipcMain.removeHandler(OPEN_MODS_FOLDER_CHANNEL);
  ipcMain.removeHandler(INVOKE_MOD_COMMAND_CHANNEL);
  ipcMain.removeHandler(RESPOND_MOD_CAPABILITY_CHANNEL);
  ipcMain.removeHandler(AUTOSAVE_FLUSH_RESPONSE_CHANNEL);
  ipcMain.removeHandler(LOAD_WORKSPACE_STATE_CHANNEL);
  ipcMain.removeHandler(SAVE_WORKSPACE_STATE_CHANNEL);
  ipcMain.removeHandler(CREATE_REPOSITORY_CHANNEL);
  ipcMain.removeHandler(CREATE_REPOSITORY_HISTORY_CHANNEL);
  ipcMain.removeHandler(LIST_REPOSITORY_HISTORY_CHANNEL);
  ipcMain.removeHandler(OPEN_REPOSITORY_CHANNEL);
  ipcMain.removeHandler(OPEN_REPOSITORY_HISTORY_CHANNEL);
  ipcMain.removeHandler(OPEN_REPOSITORY_DOCUMENT_CHANNEL);
  ipcMain.removeHandler(USE_REPOSITORY_SHELF_CHANNEL);
  markdownFileService.dispose();
  documentWorkspaceService.dispose();
  libraryService.dispose();
  repositoryService.dispose();
}

let startupProgressWindow: BrowserWindow | null = null;
let startupProgressWindowReady = false;
let startupProgressWindowShown = false;
let startupProgressState: BrandProgressState = createBrandProgressState("MAGINALIA desktop α1 を起動しています", 0);
let startupOutcome: "pending" | "succeeded" | "failed" = "pending";
let startupProgressTimer: NodeJS.Timeout | null = null;
const startupProgressReadiness = new StartupProgressReadiness<BrowserWindow>(10_000);
let startupProgressWindowListenerCleanup: (() => void) | null = null;

function brandAssetRoots(): string[] {
  const roots = [
    path.join(__dirname, "..", "branding"),
    path.join(app.getAppPath(), "dist", "branding"),
    path.join(process.resourcesPath, "branding"),
    path.resolve(app.getAppPath(), "../../assets"),
  ];
  return [...new Set(roots)];
}

function resolveBrandAsset(...fileNames: string[]): string | null {
  const roots = brandAssetRoots();
  for (const fileName of fileNames) {
    const resolved = findBrandAssetPath(fileName, roots);
    if (resolved !== null) return resolved;
  }
  return null;
}

function readBrandPngDataUrl(...fileNames: string[]): string | null {
  const resolved = resolveBrandAsset(...fileNames);
  if (resolved === null) return null;
  try {
    return `data:image/png;base64,${readFileSync(resolved).toString("base64")}`;
  } catch {
    return null;
  }
}

function applicationIconPath(): string | null {
  return findApplicationIconPath(process.platform, brandAssetRoots());
}

function updateStartupProgress(message: string, progress: number | null): void {
  startupProgressState = createBrandProgressState(message, progress);
  const window = startupProgressWindow;
  if (window !== null && !window.isDestroyed() && startupProgressWindowReady) {
    void window.webContents.executeJavaScript(brandProgressUpdateScript(startupProgressState)).catch(() => undefined);
  }
}

function waitForStartupProgressWindow(): Promise<BrowserWindow> {
  if (startupProgressWindow !== null && startupProgressWindowReady && !startupProgressWindow.isDestroyed()) {
    return Promise.resolve(startupProgressWindow);
  }
  if (startupProgressReadiness.state === "ready") {
    startupProgressReadiness.invalidate(new Error("The startup progress window closed before it could be used."));
  }
  return startupProgressReadiness.wait();
}

function cleanupStartupProgressWindowListeners(): void {
  const cleanup = startupProgressWindowListenerCleanup;
  startupProgressWindowListenerCleanup = null;
  cleanup?.();
}

function failStartupProgressWindow(window: BrowserWindow, error: unknown): void {
  startupProgressWindowReady = false;
  startupProgressWindowShown = false;
  if (startupProgressWindow === window) startupProgressWindow = null;
  startupProgressReadiness.invalidate(error);
  cleanupStartupProgressWindowListeners();
  if (!window.isDestroyed()) window.destroy();
}

function startStartupProgressWindow(delayMs: number): void {
  if (smokeMode && !brandProgressSmoke) return;
  const createWindow = () => {
    if ((startupOutcome !== "pending" && !brandProgressSmoke) || (startupProgressWindow !== null && !startupProgressWindow.isDestroyed())) return;
    const icon = applicationIconPath();
    const window = new BrowserWindow({
      width: 610,
      height: 390,
      title: MAGINALIA_APPLICATION_NAME,
      ...(icon === null ? {} : { icon }),
      center: true,
      show: false,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: "#fffdf3",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    startupProgressWindow = window;
    const splashContents = window.webContents;
    const html = renderBrandProgressHtml({
      logoDataUrl: readBrandPngDataUrl("splash.png", "header.png", "icon.png"),
      markerDataUrl: readBrandPngDataUrl("marker-stroke.png"),
    });
    const onReadyToShow = () => {
      if (window.isDestroyed()) {
        failStartupProgressWindow(window, new Error("The startup progress window was destroyed before it became ready."));
        return;
      }
      if (!startupProgressReadiness.markReady(window)) return;
      startupProgressWindowReady = true;
      void window.webContents.executeJavaScript(brandProgressUpdateScript(startupProgressState)).catch(() => undefined);
      if (startupOutcome !== "succeeded" || brandProgressSmoke) {
        startupProgressWindowShown = true;
        window.show();
      }
    };
    const onClosed = () => {
      if (startupProgressWindow === window) startupProgressWindow = null;
      startupProgressWindowReady = false;
      startupProgressWindowShown = false;
      if (startupOutcome !== "succeeded") {
        startupProgressReadiness.invalidate(new Error("The startup progress window closed before startup completed."));
      }
      cleanupStartupProgressWindowListeners();
    };
    const onDidFailLoad = (_event: Electron.Event, errorCode: number, errorDescription: string, _validatedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      failStartupProgressWindow(window, new Error(`Branded startup splash failed to load (${errorCode}): ${errorDescription}`));
    };
    window.on("ready-to-show", onReadyToShow);
    window.on("closed", onClosed);
    splashContents.on("did-fail-load", onDidFailLoad);
    startupProgressWindowListenerCleanup = () => {
      window.removeListener("ready-to-show", onReadyToShow);
      window.removeListener("closed", onClosed);
      splashContents.removeListener("did-fail-load", onDidFailLoad);
    };
    if (brandProgressSmoke && process.env.MAGINALIA_BRAND_SMOKE_DESTROY_SPLASH === "1") {
      window.destroy();
      return;
    }
    const splashUrl = brandProgressSmoke && process.env.MAGINALIA_BRAND_SMOKE_FAIL_SPLASH === "1"
      ? "maginalia-startup-smoke://invalid-splash"
      : `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
    void window.loadURL(splashUrl).catch((error: unknown) => {
      failStartupProgressWindow(window, new Error("Branded startup splash failed to load.", { cause: error }));
    });
  };

  if (delayMs <= 0) {
    createWindow();
    return;
  }
  startupProgressTimer = setTimeout(createWindow, delayMs);
}

function completeStartupProgress(window: BrowserWindow): void {
  if (startupOutcome === "failed" || window.isDestroyed()) return;
  const completesInitialStartup = startupOutcome === "pending";
  if (completesInitialStartup) {
    startupOutcome = "succeeded";
    if (startupProgressTimer !== null) {
      clearTimeout(startupProgressTimer);
      startupProgressTimer = null;
    }
    updateStartupProgress("MAGINALIA desktop α1 の準備ができました", 1);
  }
  window.show();
  if (!completesInitialStartup) return;
  const splash = startupProgressWindow;
  if (splash !== null && !splash.isDestroyed()) {
    if (startupProgressWindowShown && splash.isVisible()) {
      setTimeout(() => {
        if (!splash.isDestroyed()) splash.close();
      }, 140);
    } else {
      splash.close();
    }
  }
}

function failMainRendererLoad(window: BrowserWindow, error: unknown): void {
  startupOutcome = "failed";
  console.error("MAGINALIA renderer failed to load", error);
  if (startupProgressTimer !== null) {
    clearTimeout(startupProgressTimer);
    startupProgressTimer = null;
  }
  const splash = startupProgressWindow;
  if (splash !== null) failStartupProgressWindow(splash, new Error("Main Renderer loading failed.", { cause: error }));

  if (brandProgressSmoke) {
    console.error("MAGINALIA_BRAND_RENDERER_LOAD_FAILED", error);
    app.exit(1);
  } else if (settingsSmokeRequested) {
    failSettingsSmoke(error);
  } else if (writingSmoke.requested) {
    failWritingSmoke(error);
  } else if (workspaceSmoke.requested) {
    failWorkspaceSmoke(error);
  } else if (projectSmoke.requested) {
    failProjectSmoke(error);
  } else if (quotationSmoke.requested) {
    failQuotationSmoke(error);
  } else if (repositorySmoke.requested) {
    failRepositorySmoke(error);
  } else if (shelfSmoke.requested) {
    failShelfSmoke(error);
  } else if (d5Smoke.requested) {
    failD5Smoke(error);
  } else if (exportSmoke.requested) {
    failExportSmoke(error);
  } else if (hSmoke.requested) {
    failHSmoke(error);
  } else if (h5Smoke.requested) {
    failH5Smoke(error);
  } else if (gSmoke.requested) {
    failGSmoke(error);
  } else if (quickSmokeMode) {
    app.exit(1);
  } else if (!smokeMode) {
    dialog.showErrorBox(
      "MAGINALIAを起動できませんでした",
      "編集画面を読み込めませんでした。MAGINALIAを終了します。\nもう一度起動してください。問題が続く場合は、アプリのインストール状態を確認してください。",
    );
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
}

function createMainWindow(): BrowserWindow {
  const icon = applicationIconPath();
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    title: MAGINALIA_APPLICATION_NAME,
    ...(icon === null ? {} : { icon }),
    show: writingSmoke.requested
      || workspaceSmoke.requested
      || projectSmoke.requested
      || quotationSmoke.requested
      || repositorySmoke.requested
      || shelfSmoke.requested
      || d5Smoke.requested
      || exportSmoke.requested
      || gSmoke.requested
      || workdeskPersistenceSmoke.requested
      || h5Smoke.requested
      || firstRunSmoke,
    webPreferences: createSecureWebPreferences(path.join(__dirname, "preload.js"))
  });
  if (!smokeMode) updateStartupProgress("編集画面を準備しています", 0.82);
  const rendererStartupGate = new RendererStartupGate(
    () => {
      if (brandProgressSmoke) {
        void waitForStartupProgressWindow().then(async (splash) => {
          const outputDirectory = process.env.MAGINALIA_BRAND_SMOKE_OUTPUT
            ?? path.join(app.getPath("temp"), "maginalia-brand-progress-smoke");
          await runBrandProgressElectronSmoke({
            splash,
            mainWindow: window,
            outputDirectory,
            applicationName: app.getName(),
            userDataPath,
            expectedUserDataPath: process.env.MAGINALIA_SMOKE_EXPECTED_USER_DATA,
            update: updateStartupProgress,
            complete: () => completeStartupProgress(window),
          });
          console.log("MAGINALIA_BRAND_PROGRESS_SMOKE_OK");
          app.exit(0);
        }).catch((error: unknown) => {
          console.error("MAGINALIA_BRAND_PROGRESS_SMOKE_FAILED", error);
          const splash = startupProgressWindow;
          if (splash !== null && !splash.isDestroyed()) failStartupProgressWindow(splash, error);
          app.exit(1);
        });
      } else if (!smokeMode) {
        completeStartupProgress(window);
      }
    },
    (error) => failMainRendererLoad(window, error),
  );
  window.once("ready-to-show", () => rendererStartupGate.markWindowReady());
  // Resolve once at window creation so an existing explicit registry is ready
  // for normal Shelf use. The shared binding also reloads it on demand.
  void getConfiguredPrivateShelf().getActive(window.webContents);

  const rendererPath = brandProgressSmoke && process.env.MAGINALIA_BRAND_SMOKE_FAIL_RENDERER === "1"
    ? path.join(app.getPath("temp"), `maginalia-missing-renderer-${process.pid}.html`)
    : path.join(__dirname, "..", "renderer", "index.html");

  if (firstRunSmoke) {
    const smokeOptions = {
      window,
      workdeskRoot: process.env.MAGINALIA_FIRST_RUN_SMOKE_WORKDESK ?? "",
      shelfRoot: process.env.MAGINALIA_FIRST_RUN_SMOKE_SHELF ?? "",
      downloadsRoot: process.env.MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS ?? "",
      userDataRoot: userDataPath,
      expectedUserDataRoot: process.env.MAGINALIA_SMOKE_EXPECTED_USER_DATA,
      outputDirectory: process.env.MAGINALIA_FIRST_RUN_SMOKE_OUTPUT ?? app.getPath("temp"),
      exit: (code: number) => app.exit(code),
    };
    if (!smokeOptions.workdeskRoot || !smokeOptions.shelfRoot || !smokeOptions.downloadsRoot) {
      console.error("MAGINALIA_FIRST_RUN_SMOKE_FAILED Temporary Workdesk, Shelf, or Downloads path was not provided.");
      app.exit(1);
    } else {
      window.webContents.once("did-finish-load", () => {
        void runFirstRunSmoke(smokeOptions).catch((error: unknown) => {
          console.error(`MAGINALIA_FIRST_RUN_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) {
          console.error(`MAGINALIA_FIRST_RUN_SMOKE_FAILED Renderer load ${errorCode}: ${errorDescription}`);
          app.exit(1);
        }
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        console.error(`MAGINALIA_FIRST_RUN_SMOKE_FAILED Renderer process exited: ${details.reason}`);
        app.exit(1);
      });
    }
  } else if (firstRunRestoreSmoke) {
    const workdeskRoot = process.env.MAGINALIA_FIRST_RUN_SMOKE_WORKDESK ?? "";
    if (!workdeskRoot) {
      console.error("MAGINALIA_FIRST_RUN_RESTORE_SMOKE_FAILED Temporary Workdesk path was not provided.");
      app.exit(1);
    } else {
      window.webContents.once("did-finish-load", () => {
        void runFirstRunRestoreSmoke({
          window,
          workdeskRoot,
          userDataRoot: userDataPath,
          expectedUserDataRoot: process.env.MAGINALIA_SMOKE_EXPECTED_USER_DATA,
          exit: (code: number) => app.exit(code),
        }).catch((error: unknown) => {
          console.error(`MAGINALIA_FIRST_RUN_RESTORE_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) {
          console.error(`MAGINALIA_FIRST_RUN_RESTORE_SMOKE_FAILED Renderer load ${errorCode}: ${errorDescription}`);
          app.exit(1);
        }
      });
    }
  } else if (workdeskPersistenceSmoke.requested) {
    if (!workdeskPersistenceSmoke.rootPath) {
      failWorkdeskPersistenceSmoke(new Error("The Workdesk persistence fixture path was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runWorkdeskPersistenceSmoke({
          window,
          rootPath: workdeskPersistenceSmoke.rootPath!,
          userDataPath,
          expectedUserDataPath: process.env.MAGINALIA_SMOKE_EXPECTED_USER_DATA,
          restore: workdeskPersistenceSmoke.restore === true,
          pickerInvocationCount: () => workdeskPersistencePickerInvocationCount
        }).then(
          () => completeWorkdeskPersistenceSmoke(),
          (error: unknown) => failWorkdeskPersistenceSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failWorkdeskPersistenceSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failWorkdeskPersistenceSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failWorkdeskPersistenceSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
    }
  } else if (settingsSmokeRequested) {
    if (!writingSmoke.requested || !writingSmoke.filePath) {
      failSettingsSmoke(new Error("The Settings smoke requires the writing smoke fixture path."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runSettingsSmoke(window, settingsSmokeRestore).then(
          () => completeSettingsSmoke(),
          (error: unknown) => failSettingsSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failSettingsSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failSettingsSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failSettingsSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failSettingsSmoke(new Error("Renderer became unresponsive."));
      });
    }
  } else if (writingSmoke.requested) {
    if (!writingSmoke.filePath) {
      failWritingSmoke(new Error("The writing smoke fixture path was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runWritingSmoke(window, writingSmoke.filePath!).then(
          () => completeWritingSmoke(),
          (error: unknown) => failWritingSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failWritingSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failWritingSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failWritingSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failWritingSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failWritingSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (workspaceSmoke.requested) {
    if (!workspaceSmoke.rootPath) {
      failWorkspaceSmoke(new Error("The workspace smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runWorkspaceSmoke(window, workspaceSmoke.rootPath!).then(
          () => completeWorkspaceSmoke(),
          (error: unknown) => failWorkspaceSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failWorkspaceSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failWorkspaceSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failWorkspaceSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failWorkspaceSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failWorkspaceSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (projectSmoke.requested) {
    if (!projectSmoke.rootPath) {
      failProjectSmoke(new Error("The project smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        const smoke = projectSmoke.restore
          ? runProjectRestoreSmoke(window, projectSmoke.rootPath!)
          : runProjectSmoke(window, projectSmoke.rootPath!);
        void smoke.then(
          () => completeProjectSmoke(),
          (error: unknown) => failProjectSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failProjectSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failProjectSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failProjectSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failProjectSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failProjectSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (quotationSmoke.requested) {
    if (!quotationSmoke.documentRoot || !quotationSmoke.libraryRoot) {
      failQuotationSmoke(new Error("The quotation smoke fixture roots were not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runQuotationSmoke(
          window,
          quotationSmoke.documentRoot!,
          quotationSmoke.libraryRoot!
        ).then(
          () => completeQuotationSmoke(),
          (error: unknown) => failQuotationSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failQuotationSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failQuotationSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failQuotationSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failQuotationSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failQuotationSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (repositorySmoke.requested) {
    if (!repositorySmoke.rootPath) {
      failRepositorySmoke(new Error("The repository smoke fixture root was not provided."));
    } else {
      const security = createSecureWebPreferences(path.join(__dirname, "preload.js"));
      if (!security.contextIsolation || security.nodeIntegration || !security.sandbox) {
        failRepositorySmoke(new Error("Repository smoke security preferences are not strict."));
      }
      window.webContents.once("did-finish-load", () => {
        void runRepositorySmoke(window, repositorySmoke.rootPath!).then(
          () => completeRepositorySmoke(),
          (error: unknown) => failRepositorySmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failRepositorySmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failRepositorySmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failRepositorySmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failRepositorySmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failRepositorySmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (shelfSmoke.requested) {
    if (!shelfSmoke.rootPath) {
      failShelfSmoke(new Error("The Shelf smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runShelfSmoke(window, shelfSmoke.rootPath!).then(
          () => completeShelfSmoke(),
          (error: unknown) => failShelfSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failShelfSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failShelfSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failShelfSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failShelfSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failShelfSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (d5Smoke.requested) {
    if (!d5Smoke.rootPath) {
      failD5Smoke(new Error("The D.5 smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        const smoke = d5Smoke.restore
          ? runD5RestoreSmoke(window, d5Smoke.rootPath!, modHost.modsDirectory)
          : runD5Smoke(window, d5Smoke.rootPath!, modHost.modsDirectory);
        void smoke.then(
          () => completeD5Smoke(),
          (error: unknown) => failD5Smoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failD5Smoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failD5Smoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failD5Smoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failD5Smoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failD5Smoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (exportSmoke.requested) {
    if (!exportSmoke.rootPath) {
      failExportSmoke(new Error("The Export smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        const shelfRoot = path.join(exportSmoke.rootPath!, "private-shelf");
        void libraryService.openPrivateShelfForOwner(window.webContents, shelfRoot).then((openedShelf) => {
          if (openedShelf.kind !== "opened") {
            throw new Error("The Export smoke canonical Private Shelf could not be opened.");
          }
          return runExportSmoke(window, exportSmoke.rootPath!);
        }).then(
          () => completeExportSmoke(),
          (error: unknown) => failExportSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failExportSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failExportSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failExportSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failExportSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failExportSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (h5Smoke.requested) {
    window.webContents.once("did-finish-load", () => {
      void runH5Smoke({
        reviewer: getReviewerProcessManager(),
        reviewerView: getReviewerViewController(),
        userDataPath,
        owner: window.webContents,
        configuredShelf: getConfiguredPrivateShelf(),
        libraryService,
        notifyReviewerApproval: async (annotationId) => {
          const reviewerWebContents = reviewerWebContentsForH5Smoke;
          if (reviewerWebContents === undefined || reviewerWebContents.isDestroyed()) {
            throw new Error("The embedded Reviewer WebContents is unavailable to the smoke harness.");
          }
          const safeAnnotationId = JSON.stringify(annotationId);
          await reviewerWebContents.executeJavaScript(`window.notifyDesktopShelfApproval(${safeAnnotationId})`);
        }
      }).then(
        () => completeH5Smoke(),
        (error: unknown) => failH5Smoke(error)
      );
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame) failH5Smoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
    });
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      failH5Smoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      failH5Smoke(new Error(`Renderer process exited: ${details.reason}`));
    });
  } else if (hSmoke.requested) {
    if (!hSmoke.rootPath || (hSmoke.acceptance && !hSmoke.projectRootPath)) {
      failHSmoke(new Error("The Workdesk smoke root or acceptance Project root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        const smoke = hSmoke.acceptance
          ? runHNavigationAcceptanceSmoke({
            window,
            workdeskRoot: hSmoke.rootPath!,
            projectRoot: hSmoke.projectRootPath!,
            restore: hSmoke.restore === true,
            workdesks: workdeskService,
            workdeskPickerInvocationCount: () => hSmokePickerInvocationCount,
            projectPickerInvocationCount: () => hSmokeProjectPickerInvocationCount,
            registrationPromptInvocationCount: () => hSmokeRegistrationPromptInvocationCount,
          })
          : runHSmoke({
          window,
          fixtureRoot: hSmoke.rootPath!,
          restore: hSmoke.restore === true,
          workdesks: workdeskService,
          repositories: repositoryService,
          projects: projectService,
          workdeskPickerInvocationCount: () => hSmokePickerInvocationCount,
          projectPickerInvocationCount: () => hSmokeProjectPickerInvocationCount,
          registrationPromptInvocationCount: () => hSmokeRegistrationPromptInvocationCount,
          rememberWorkdeskRoot: (rootPath) => { hSmokeWorkdeskRoot = rootPath; },
          rememberProjectRoot: (rootPath) => {
            if (hSmoke.acceptance) hSmokeProjectRoot = rootPath;
            else hSmokeProjectRoots.push(rootPath);
          }
        });
        void smoke.then(
          () => completeHSmoke(),
          (error: unknown) => failHSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failHSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failHSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failHSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => failHSmoke(new Error("Renderer became unresponsive.")));
    }
  } else if (gSmoke.requested) {
    if (!gSmoke.rootPath) {
      failGSmoke(new Error("The G smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void (gSmoke.restore ? runGRestoreSmoke(window) : runGSmoke(window, gSmoke.rootPath!)).then(
          () => completeGSmoke(),
          (error: unknown) => failGSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failGSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failGSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failGSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failGSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failGSmoke(new Error(`Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`));
        }
      });
    }
  } else if (quickSmokeMode) {
    const failQuickSmoke = (message: string) => {
      console.error(`MAGINALIA_ELECTRON_SMOKE_FAILED ${message}`);
      app.exit(1);
    };
    window.webContents.once("did-finish-load", () => {
      const expectedUserData = process.env.MAGINALIA_SMOKE_EXPECTED_USER_DATA;
      if (expectedUserData && path.resolve(userDataPath) !== path.resolve(expectedUserData)) {
        failQuickSmoke("Electron did not use the requested isolated userData directory");
        return;
      }
      console.log(`MAGINALIA_ELECTRON_SMOKE_OK userData=${JSON.stringify(userDataPath)}`);
      app.quit();
    });
    window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      failQuickSmoke(`renderer load ${errorCode}: ${errorDescription}`);
    });
    window.webContents.once("preload-error", (_event, preloadPath, error) => {
      failQuickSmoke(`preload ${preloadPath}: ${error.message}`);
    });
    window.webContents.once("render-process-gone", (_event, details) => {
      failQuickSmoke(`renderer process ${details.reason} (exit ${details.exitCode})`);
    });
    window.webContents.once("unresponsive", () => failQuickSmoke("renderer became unresponsive"));
  }

  const loadOptions: LoadFileOptions | undefined = writingSmoke.requested
    ? { query: { smoke: "writing" } }
    : workspaceSmoke.requested
      ? { query: { smoke: "workspace" } }
      : projectSmoke.requested
        ? { query: { smoke: projectSmoke.restore ? "project-restore" : "project" } }
      : quotationSmoke.requested
      ? { query: { smoke: "quotation" } }
        : repositorySmoke.requested
          ? { query: { smoke: "repository" } }
          : shelfSmoke.requested
            ? { query: { smoke: "shelf" } }
            : d5Smoke.requested
              ? { query: { smoke: d5Smoke.restore ? "d5-restore" : "d5" } }
              : exportSmoke.requested
                ? { query: { smoke: "export" } }
                : h5Smoke.requested
                  ? { query: { smoke: "h5" } }
                : hSmoke.requested
                  ? { query: { smoke: hSmoke.acceptance
                    ? hSmoke.restore ? "h-acceptance-restore" : "h-acceptance"
                    : hSmoke.restore ? "h-restore" : "h" } }
                : gSmoke.requested
                  ? { query: { smoke: gSmoke.restore ? "g-restore" : "g" } }
                  : firstRunOnLaunch
                    ? { query: { setup: "first-run" } }
                    : undefined;
  void window.loadFile(rendererPath, loadOptions).then(
    () => rendererStartupGate.markRendererLoaded(),
    (error: unknown) => rendererStartupGate.failRendererLoad(error),
  );

  window.on("closed", () => {
    if (settingsSmokeRequested && !settingsSmokeFinished) {
      failSettingsSmoke(new Error("Settings smoke window closed before completion."));
    }
    if (writingSmoke.requested && !settingsSmokeRequested && !writingSmokeFinished) {
      failWritingSmoke(new Error("Writing smoke window closed before completion."));
    }
    if (workspaceSmoke.requested && !workspaceSmokeFinished) {
      failWorkspaceSmoke(new Error("Workspace smoke window closed before completion."));
    }
    if (projectSmoke.requested && !projectSmokeFinished) {
      failProjectSmoke(new Error("Project smoke window closed before completion."));
    }
    if (quotationSmoke.requested && !quotationSmokeFinished) {
      failQuotationSmoke(new Error("Quotation smoke window closed before completion."));
    }
    if (repositorySmoke.requested && !repositorySmokeFinished) {
      failRepositorySmoke(new Error("Repository smoke window closed before completion."));
    }
    if (shelfSmoke.requested && !shelfSmokeFinished) {
      failShelfSmoke(new Error("Shelf smoke window closed before completion."));
    }
    if (d5Smoke.requested && !d5SmokeFinished) {
      failD5Smoke(new Error("D.5 smoke window closed before completion."));
    }
    if (exportSmoke.requested && !exportSmokeFinished) {
      failExportSmoke(new Error("Export smoke window closed before completion."));
    }
    if (hSmoke.requested && !hSmokeFinished) {
      failHSmoke(new Error("Workdesk smoke window closed before completion."));
    }
    if (workdeskPersistenceSmoke.requested && !workdeskPersistenceSmokeFinished) {
      failWorkdeskPersistenceSmoke(new Error("Workdesk persistence smoke window closed before completion."));
    }
    if (h5Smoke.requested && !h5SmokeFinished) {
      failH5Smoke(new Error("Reviewer smoke window closed before completion."));
    }
    if (gSmoke.requested && !gSmokeFinished) {
      failGSmoke(new Error("G smoke window closed before completion."));
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function openMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = createMainWindow();
}

const AUTOSAVE_QUIT_TIMEOUT_MS = 15_000;

function requestRendererAutosaveFlush(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(true);
  const requestId = `autosave-quit-${Date.now()}-${autosaveQuitSequence++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAutosaveQuit.delete(requestId);
      resolve(false);
    }, AUTOSAVE_QUIT_TIMEOUT_MS);
    pendingAutosaveQuit.set(requestId, { resolve, timer });
    try {
      window.webContents.send(AUTOSAVE_FLUSH_REQUEST_CHANNEL, { requestId });
    } catch {
      clearTimeout(timer);
      pendingAutosaveQuit.delete(requestId);
      resolve(false);
    }
  });
}

const autosaveShutdown = new AutosaveShutdownCoordinator({
  requestFlush: async () => {
    const window = mainWindow;
    const autosaveFlushed = window === null || window.isDestroyed()
      ? true
      : await requestRendererAutosaveFlush(window);
    if (!autosaveFlushed) return false;
    // before-quit is the real awaitable lifecycle boundary. The manager first
    // requests graceful sidecar shutdown and escalates only after its bound.
    try {
      await reviewerProcessManager?.shutdown();
      return true;
    } catch {
      return false;
    }
  },
  quit: () => app.quit(),
  onFailure: () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.focus();
  }
});

// Electron's before-quit event is the awaitable main/renderer boundary. The
// renderer flushes DocumentSession saves here; beforeunload is intentionally
// not used because its async work is not reliable.
app.on("before-quit", (event) => autosaveShutdown.beforeQuit(event));

void app.whenReady().then(async () => {
  if (app.isPackaged) {
    const configuration = await ensureNdlocrConfiguration(
      getDesktopConfigurationPaths().ndlocrConfigPath,
      process.resourcesPath,
    );
    if (configuration.status === "conflict" || configuration.status === "invalid") {
      console.warn("MAGINALIA_NDLOCR_CONFIGURATION_REQUIRES_ATTENTION", configuration.message);
    } else if (configuration.status === "migrated") {
      console.info("MAGINALIA_NDLOCR_LEGACY_CONFIGURATION_MIGRATED", configuration.backupPath);
    }
  }
  try {
    firstRunOnLaunch = await shouldOpenFirstRunSetup();
  } catch (error: unknown) {
    // A damaged first-run journal must not prevent readable existing user data from opening.
    firstRunOnLaunch = false;
    console.error("MAGINALIA_FIRST_RUN_JOURNAL_UNAVAILABLE", error);
  }
  if (!smokeMode || brandProgressSmoke) {
    updateStartupProgress("MAGINALIA desktop α1 を起動しています", 0.08);
    startStartupProgressWindow(140);
    if (process.platform === "darwin") {
      const dockIcon = resolveBrandAsset("icon.v2.png");
      if (dockIcon !== null) app.dock?.setIcon(dockIcon);
    }
  }
  try {
    await projectPathStore.ensureDefaultCreationParentPlaceholder();
  } catch {
    // A malformed/unreadable app-local record is preserved for recovery.
    console.error("MAGINALIA_PROJECT_PATH_SETTINGS_NOT_INITIALIZED");
  }
  if (!smokeMode || brandProgressSmoke) updateStartupProgress("Workdesk の保存情報を確認しています", 0.28);
  installNativeApplicationMenu([]);
  registerMarkdownIpc();
  if (!smokeMode || brandProgressSmoke) updateStartupProgress("作業環境を準備しています", 0.52);
  modHostReady = modHost.start().catch((error: unknown) => {
    console.error("MAGINALIA_MOD_START_FAILED", error);
    return modHost.snapshot();
  });
  if (!smokeMode || brandProgressSmoke) updateStartupProgress("編集画面を読み込んでいます", 0.72);
  openMainWindow();
  app.on("activate", openMainWindow);
});

app.on("will-quit", () => {
  // Normally shutdown completed in the before-quit coordinator. This is a
  // final best-effort guard for platform-forced paths; it never starts one.
  if (startupProgressTimer !== null) {
    clearTimeout(startupProgressTimer);
    startupProgressTimer = null;
  }
  startupProgressReadiness.abort();
  cleanupStartupProgressWindowListeners();
  if (reviewerProcessManager !== undefined) void reviewerProcessManager.shutdown();
  void modHost.dispose();
  unregisterMarkdownIpc();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
}
