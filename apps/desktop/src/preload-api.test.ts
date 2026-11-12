import { describe, expect, it } from "vitest";
import {
  createMarkdownPreloadApi,
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MARKDOWN_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  LIST_EXPLORER_CHANNEL,
  CREATE_EXPLORER_FOLDER_CHANNEL,
  DELETE_EXPLORER_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  CREATE_PROJECT_CHANNEL,
  RESTORE_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_WORKDESK_CHANNEL,
  CREATE_WORKDESK_CHANNEL,
  RESTORE_WORKDESK_CHANNEL,
  RETURN_TO_WORKDESK_CHANNEL,
  SAVE_WORKDESK_CONTEXT_CHANNEL,
  CREATE_WORKDESK_FILE_CHANNEL,
  CREATE_WORKDESK_PROJECT_CHANNEL,
  REGISTER_WORKDESK_PROJECT_CHANNEL,
  REMOVE_WORKDESK_PROJECT_CHANNEL,
  OPEN_WORKDESK_PROJECT_CHANNEL,
  COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL,
  SAVE_MARKDOWN_CHANNEL,
  OPEN_LIBRARY_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  SEARCH_SHELF_CHANNEL,
  REFRESH_SHELF_CHANNEL,
  CLOSE_REVIEWER_VIEW_CHANNEL,
  OPEN_REVIEWER_VIEW_CHANNEL,
  SET_REVIEWER_VIEW_BOUNDS_CHANNEL,
  RESOLVE_REFERENCES_CHANNEL,
  RESOLVE_EXPORT_CHANNEL,
  WRITE_EXPORT_CHANNEL,
  RESOLVE_INTERNAL_LINK_CHANNEL,
  OPEN_INTERNAL_LINK_CHANNEL,
  OPEN_EXTERNAL_LINK_CHANNEL,
  RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL,
  RESOLVE_PROJECT_ASSET_CHANNEL,
  IMPORT_DROPPED_IMAGE_CHANNEL,
  SEARCH_PROJECT_MARKDOWN_CHANNEL,
  LOAD_MODS_CHANNEL,
  RELOAD_MODS_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_WORKSPACE_STATE_CHANNEL,
  SAVE_WORKSPACE_STATE_CHANNEL,
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL
} from "./preload-api";
import { GET_FIRST_RUN_STATUS_CHANNEL, RUN_FIRST_RUN_SETUP_CHANNEL } from "./first-run-ipc";
import { OPEN_BUNDLED_MANUAL_CHANNEL } from "./manual-ipc";
import { CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL, CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL } from "./collector-save-destination-ipc";
import { APPLICATION_MENU_COMMAND_CHANNEL, UPDATE_APPLICATION_MENU_CHANNEL } from "./application-menu-contract";

describe("preload boundary", () => {
  it("exposes only the narrow semantic methods", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const api = createMarkdownPreloadApi(async (channel, ...args) => {
      calls.push({ channel, args: [...args] });
      return { kind: "cancelled" };
    }, undefined, () => "C:\\drop\\figure.png");

    expect(Object.keys(api)).toEqual([
      "getFirstRunStatus",
      "runFirstRunSetup",
      "onFirstRunProgress",
      "updateApplicationMenu",
      "onApplicationCommand",
      "openBundledManual",
      "configureCollectorSaveDestination",
      "clearCollectorSaveDestination",
      "openMarkdown",
      "saveMarkdown",
      "openDocument",
      "openManuscript",
      "listExplorer",
      "createExplorerFolder",
      "deleteExplorerFile",
      "openProject",
      "createProject",
      "restoreProject",
      "openProjectFile",
      "createProjectFile",
      "openWorkdesk",
      "createWorkdesk",
      "restoreWorkdesk",
      "returnToWorkdesk",
      "saveWorkdeskContext",
      "createWorkdeskFile",
      "createWorkdeskProject",
      "registerWorkdeskProject",
      "removeWorkdeskProject",
      "openWorkdeskProject",
      "copyWorkdeskFileToProject",
      "openLibrary",
      "searchLibrary",
      "resolveQuotationForInsert",
      "searchShelf",
      "refreshShelf",
      "openReviewerView",
      "closeReviewerView",
      "setReviewerViewBounds",
      "resolveReferences",
      "resolveExport",
      "writeExport",
      "resolveInternalLink",
      "openInternalLink",
      "openExternalLink",
      "resolveSyncedBlockDocument",
      "resolveProjectAsset",
      "importDroppedImageFile",
      "searchProjectMarkdown",
      "loadMods",
      "reloadMods",
      "openModsFolder",
      "invokeModCommand",
      "onModCapabilityRequest",
      "loadWorkspaceState",
      "saveWorkspaceState",
      "createRepository",
      "createRepositoryHistory",
      "listRepositoryHistory",
      "openRepositoryHistory",
      "openRepository",
      "openRepositoryDocument",
      "useRepositoryShelf",
      "onAutosaveFlushRequest"
    ]);
    await api.getFirstRunStatus();
    await api.runFirstRunSetup({ workdeskMode: "new", privateShelfMode: "existing", registerPublicShelf: false });
    api.onFirstRunProgress(() => undefined);
    await api.openBundledManual();
    await api.configureCollectorSaveDestination();
    await api.clearCollectorSaveDestination();
    await api.openMarkdown();
    await api.saveMarkdown({ sessionId: "opaque-session", text: "# Draft\r\n" });
    await api.openDocument();
    await api.openManuscript({
      documentId: "00000000-0000-4000-8000-000000000000",
      manuscriptId: "11111111-1111-4111-8111-111111111111"
    });
    await api.listExplorer({ documentId: "00000000-0000-4000-8000-000000000000" });
    await api.createExplorerFolder({ documentId: "00000000-0000-4000-8000-000000000000", parentEntryId: null, name: "資料" });
    await api.deleteExplorerFile({ documentId: "00000000-0000-4000-8000-000000000000", entryId: "11111111-1111-4111-8111-111111111111" });
    await api.openProject();
    await api.createProject({ title: "Coffee" });
    await api.restoreProject();
    await api.openProjectFile({
      projectId: "77777777-7777-4777-8777-777777777777",
      fileId: "88888888-8888-4888-8888-888888888888"
    });
    await api.createProjectFile({
      projectId: "77777777-7777-4777-8777-777777777777",
      fileName: "memo.md",
      title: "Memo",
      documentType: "memo"
    });
    await api.openWorkdesk();
    await api.createWorkdesk({ title: "Desk" });
    await api.restoreWorkdesk();
    await api.returnToWorkdesk();
    await api.saveWorkdeskContext({
      workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
      context: { kind: "home" },
    });
    await api.createWorkdeskFile({
      workdeskId: "77777777-7777-4777-8777-777777777777",
      fileName: "memo.md",
      title: "Memo",
      documentType: "memo"
    });
    await api.createWorkdeskProject({ workdeskIdentityId: "11111111-1111-4111-8111-111111111111", title: "Child" });
    await api.registerWorkdeskProject({ workdeskIdentityId: "11111111-1111-4111-8111-111111111111" });
    await api.removeWorkdeskProject({
      workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
      projectIdentityId: "22222222-2222-4222-8222-222222222222"
    });
    await api.openWorkdeskProject({
      workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
      projectIdentityId: "22222222-2222-4222-8222-222222222222"
    });
    await api.copyWorkdeskFileToProject({
      workdeskId: "77777777-7777-4777-8777-777777777777",
      sourceFileId: "88888888-8888-4888-8888-888888888888",
      projectIdentityId: "22222222-2222-4222-8222-222222222222",
      documentType: "memo"
    });
    await api.openLibrary();
    await api.searchLibrary({
      libraryId: "22222222-2222-4222-8222-222222222222",
      query: "日本語"
    });
    await api.resolveQuotationForInsert({
      libraryId: "22222222-2222-4222-8222-222222222222",
      annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV"
    });
    await api.searchShelf({ query: "日本語" });
    await api.refreshShelf();
    await api.openReviewerView();
    await api.setReviewerViewBounds({ x: 220, y: 128, width: 720, height: 540 });
    await api.closeReviewerView();
    await api.resolveReferences({ text: "# Draft" });
    await api.resolveExport({ documentId: "opaque-session", revision: 1, currentText: "# Draft" });
    await api.writeExport({
      exportId: "opaque-export",
      documentId: "opaque-session",
      revision: 1,
      text: "# Output",
      format: "docx",
      settings: {
        paperSize: "A4",
        orientation: "portrait",
        paragraphIndent: true,
        header: { left: "", center: "", right: "" },
        pageNumber: true
      }
    });
    await api.resolveInternalLink({ projectId: "77777777-7777-4777-8777-777777777777", target: "notes/eco.md" });
    await api.openInternalLink({ projectId: "77777777-7777-4777-8777-777777777777", fileId: "88888888-8888-4888-8888-888888888888" });
    await api.openExternalLink({ url: "https://example.test/" });
    await api.resolveSyncedBlockDocument({ projectId: "77777777-7777-4777-8777-777777777777", target: "notes/eco.md" });
    await api.resolveProjectAsset({ projectId: "77777777-7777-4777-8777-777777777777", relativePath: "assets/figure.png" });
    await api.importDroppedImageFile({ projectId: "77777777-7777-4777-8777-777777777777", file: {} as File, optimize: true });
    await api.searchProjectMarkdown?.({ projectId: "77777777-7777-4777-8777-777777777777", query: "Eco" });
    await api.loadMods();
    await api.reloadMods();
    await api.openModsFolder();
    await api.invokeModCommand({
      modId: "dev.maginalia.secondary-markdown",
      commandId: "open-active-document-in-secondary",
      args: []
    });
    await api.loadWorkspaceState();
    await api.saveWorkspaceState({
      version: 1,
      projectId: "project-1",
      openFileIds: ["file-1"],
      activeFileId: "file-1",
      viewPlacements: []
    });
    await api.createRepository({ kind: "project", title: "Project" });
    await api.createRepositoryHistory({ repositoryId: "55555555-5555-4555-8555-555555555555" });
    await api.listRepositoryHistory({ repositoryId: "55555555-5555-4555-8555-555555555555" });
    await api.openRepositoryHistory({
      repositoryId: "55555555-5555-4555-8555-555555555555",
      historyId: "66666666-6666-4666-8666-666666666666"
    });
    await api.openRepository();
    await api.openRepositoryDocument({
      repositoryId: "33333333-3333-4333-8333-333333333333"
    });
    await api.useRepositoryShelf({
      repositoryId: "44444444-4444-4444-8444-444444444444"
    });
    expect(calls).toEqual([
      { channel: GET_FIRST_RUN_STATUS_CHANNEL, args: [] },
      { channel: RUN_FIRST_RUN_SETUP_CHANNEL, args: [{ workdeskMode: "new", privateShelfMode: "existing", registerPublicShelf: false }] },
      { channel: OPEN_BUNDLED_MANUAL_CHANNEL, args: [] },
      { channel: CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL, args: [] },
      { channel: CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL, args: [] },
      { channel: OPEN_MARKDOWN_CHANNEL, args: [] },
      { channel: SAVE_MARKDOWN_CHANNEL, args: [{ sessionId: "opaque-session", text: "# Draft\r\n" }] },
      { channel: OPEN_DOCUMENT_CHANNEL, args: [] },
      {
        channel: OPEN_MANUSCRIPT_CHANNEL,
        args: [{
          documentId: "00000000-0000-4000-8000-000000000000",
          manuscriptId: "11111111-1111-4111-8111-111111111111"
        }]
      },
      { channel: LIST_EXPLORER_CHANNEL, args: [{ documentId: "00000000-0000-4000-8000-000000000000" }] },
      { channel: CREATE_EXPLORER_FOLDER_CHANNEL, args: [{ documentId: "00000000-0000-4000-8000-000000000000", parentEntryId: null, name: "資料" }] },
      { channel: DELETE_EXPLORER_FILE_CHANNEL, args: [{ documentId: "00000000-0000-4000-8000-000000000000", entryId: "11111111-1111-4111-8111-111111111111" }] },
      { channel: OPEN_PROJECT_CHANNEL, args: [] },
      { channel: CREATE_PROJECT_CHANNEL, args: [{ title: "Coffee" }] },
      { channel: RESTORE_PROJECT_CHANNEL, args: [] },
      {
        channel: OPEN_PROJECT_FILE_CHANNEL,
        args: [{
          projectId: "77777777-7777-4777-8777-777777777777",
          fileId: "88888888-8888-4888-8888-888888888888"
        }]
      },
      {
        channel: CREATE_PROJECT_FILE_CHANNEL,
        args: [{
          projectId: "77777777-7777-4777-8777-777777777777",
          fileName: "memo.md",
          title: "Memo",
          documentType: "memo"
        }]
      },
      { channel: OPEN_WORKDESK_CHANNEL, args: [] },
      { channel: CREATE_WORKDESK_CHANNEL, args: [{ title: "Desk" }] },
      { channel: RESTORE_WORKDESK_CHANNEL, args: [] },
      { channel: RETURN_TO_WORKDESK_CHANNEL, args: [] },
      {
        channel: SAVE_WORKDESK_CONTEXT_CHANNEL,
        args: [{ workdeskIdentityId: "11111111-1111-4111-8111-111111111111", context: { kind: "home" } }]
      },
      {
        channel: CREATE_WORKDESK_FILE_CHANNEL,
        args: [{
          workdeskId: "77777777-7777-4777-8777-777777777777",
          fileName: "memo.md",
          title: "Memo",
          documentType: "memo"
        }]
      },
      {
        channel: CREATE_WORKDESK_PROJECT_CHANNEL,
        args: [{ workdeskIdentityId: "11111111-1111-4111-8111-111111111111", title: "Child" }]
      },
      {
        channel: REGISTER_WORKDESK_PROJECT_CHANNEL,
        args: [{ workdeskIdentityId: "11111111-1111-4111-8111-111111111111" }]
      },
      {
        channel: REMOVE_WORKDESK_PROJECT_CHANNEL,
        args: [{
          workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
          projectIdentityId: "22222222-2222-4222-8222-222222222222"
        }]
      },
      {
        channel: OPEN_WORKDESK_PROJECT_CHANNEL,
        args: [{
          workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
          projectIdentityId: "22222222-2222-4222-8222-222222222222"
        }]
      },
      {
        channel: COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL,
        args: [{
          workdeskId: "77777777-7777-4777-8777-777777777777",
          sourceFileId: "88888888-8888-4888-8888-888888888888",
          projectIdentityId: "22222222-2222-4222-8222-222222222222",
          documentType: "memo"
        }]
      },
      { channel: OPEN_LIBRARY_CHANNEL, args: [] },
      {
        channel: SEARCH_LIBRARY_CHANNEL,
        args: [{ libraryId: "22222222-2222-4222-8222-222222222222", query: "日本語" }]
      },
      {
        channel: RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
        args: [{
          libraryId: "22222222-2222-4222-8222-222222222222",
          annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV"
        }]
      },
      { channel: SEARCH_SHELF_CHANNEL, args: [{ query: "日本語" }] },
      { channel: REFRESH_SHELF_CHANNEL, args: [] },
      { channel: OPEN_REVIEWER_VIEW_CHANNEL, args: [] },
      { channel: SET_REVIEWER_VIEW_BOUNDS_CHANNEL, args: [{ x: 220, y: 128, width: 720, height: 540 }] },
      { channel: CLOSE_REVIEWER_VIEW_CHANNEL, args: [] },
      { channel: RESOLVE_REFERENCES_CHANNEL, args: [{ text: "# Draft" }] },
      {
        channel: RESOLVE_EXPORT_CHANNEL,
        args: [{ documentId: "opaque-session", revision: 1, currentText: "# Draft" }]
      },
      {
        channel: WRITE_EXPORT_CHANNEL,
        args: [{
          exportId: "opaque-export",
          documentId: "opaque-session",
          revision: 1,
          text: "# Output",
          format: "docx",
          settings: {
            paperSize: "A4",
            orientation: "portrait",
            paragraphIndent: true,
            header: { left: "", center: "", right: "" },
            pageNumber: true
          }
        }]
      },
      {
        channel: RESOLVE_INTERNAL_LINK_CHANNEL,
        args: [{ projectId: "77777777-7777-4777-8777-777777777777", target: "notes/eco.md" }]
      },
      {
        channel: OPEN_INTERNAL_LINK_CHANNEL,
        args: [{ projectId: "77777777-7777-4777-8777-777777777777", fileId: "88888888-8888-4888-8888-888888888888" }]
      },
      { channel: OPEN_EXTERNAL_LINK_CHANNEL, args: [{ url: "https://example.test/" }] },
      { channel: RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL, args: [{ projectId: "77777777-7777-4777-8777-777777777777", target: "notes/eco.md" }] },
      {
        channel: RESOLVE_PROJECT_ASSET_CHANNEL,
        args: [{ projectId: "77777777-7777-4777-8777-777777777777", relativePath: "assets/figure.png" }]
      },
      {
        channel: IMPORT_DROPPED_IMAGE_CHANNEL,
        args: [{ projectId: "77777777-7777-4777-8777-777777777777", sourcePath: "C:\\drop\\figure.png", optimize: true }]
      },
      {
        channel: SEARCH_PROJECT_MARKDOWN_CHANNEL,
        args: [{ projectId: "77777777-7777-4777-8777-777777777777", query: "Eco" }]
      },
      { channel: LOAD_MODS_CHANNEL, args: [] },
      { channel: RELOAD_MODS_CHANNEL, args: [] },
      { channel: OPEN_MODS_FOLDER_CHANNEL, args: [] },
      {
        channel: INVOKE_MOD_COMMAND_CHANNEL,
        args: [{
          modId: "dev.maginalia.secondary-markdown",
          commandId: "open-active-document-in-secondary",
          args: []
        }]
      },
      { channel: LOAD_WORKSPACE_STATE_CHANNEL, args: [] },
      {
        channel: SAVE_WORKSPACE_STATE_CHANNEL,
        args: [{
          version: 1,
          projectId: "project-1",
          openFileIds: ["file-1"],
          activeFileId: "file-1",
          viewPlacements: []
        }]
      },
      {
        channel: CREATE_REPOSITORY_CHANNEL,
        args: [{ kind: "project", title: "Project" }]
      },
      {
        channel: CREATE_REPOSITORY_HISTORY_CHANNEL,
        args: [{ repositoryId: "55555555-5555-4555-8555-555555555555" }]
      },
      {
        channel: LIST_REPOSITORY_HISTORY_CHANNEL,
        args: [{ repositoryId: "55555555-5555-4555-8555-555555555555" }]
      },
      {
        channel: OPEN_REPOSITORY_HISTORY_CHANNEL,
        args: [{
          repositoryId: "55555555-5555-4555-8555-555555555555",
          historyId: "66666666-6666-4666-8666-666666666666"
        }]
      },
      { channel: OPEN_REPOSITORY_CHANNEL, args: [] },
      {
        channel: OPEN_REPOSITORY_DOCUMENT_CHANNEL,
        args: [{ repositoryId: "33333333-3333-4333-8333-333333333333" }]
      },
      {
        channel: USE_REPOSITORY_SHELF_CHANNEL,
        args: [{ repositoryId: "44444444-4444-4444-8444-444444444444" }]
      }
    ]);
  });

  it("validates menu snapshots and native command events at the preload boundary", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const commandEvents: Array<{ channel: string; listener: (value: unknown) => void }> = [];
    const api = createMarkdownPreloadApi(
      async (channel, ...args) => {
        calls.push({ channel, args: [...args] });
        return channel === UPDATE_APPLICATION_MENU_CHANNEL;
      },
      (channel, listener) => {
        commandEvents.push({ channel, listener });
        return () => undefined;
      }
    );

    const snapshot = [{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+S" }] as const;
    await api.updateApplicationMenu(snapshot);
    const received: string[] = [];
    api.onApplicationCommand((commandId) => received.push(commandId));
    expect(calls).toEqual([{ channel: UPDATE_APPLICATION_MENU_CHANNEL, args: [snapshot] }]);
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]?.channel).toBe(APPLICATION_MENU_COMMAND_CHANNEL);
    commandEvents[0]?.listener("maginalia.document.save");
    commandEvents[0]?.listener("dev.example.injected");
    expect(received).toEqual(["maginalia.document.save"]);

    await expect(api.updateApplicationMenu([{ id: "dev.example.injected", enabled: true }] as never))
      .rejects.toThrow("snapshot is invalid");
    await expect(api.updateApplicationMenu([{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+Unknown" }] as never))
      .rejects.toThrow("snapshot is invalid");
  });
});
