import {
  type OpenMarkdownResult,
  type SaveMarkdownRequest,
  type SaveMarkdownResult
} from "./markdown-ipc";
import {
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  LIST_EXPLORER_CHANNEL,
  CREATE_EXPLORER_FOLDER_CHANNEL,
  DELETE_EXPLORER_FILE_CHANNEL,
  type OpenDocumentResult,
  type ExplorerDeleteFileRequest,
  type ExplorerDeleteFileResult,
  type ExplorerCreateFolderRequest,
  type ExplorerListRequest,
  type OpenManuscriptRequest,
  type OpenManuscriptResult
} from "./document-workspace-ipc";
import {
  OPEN_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  type OpenLibraryResult,
  type ResolveQuotationForInsertRequest,
  type ResolveQuotationForInsertResult,
  type SearchLibraryRequest,
  type SearchLibraryResult
} from "./library-ipc";
import {
  REFRESH_SHELF_CHANNEL,
  SEARCH_SHELF_CHANNEL,
  type SearchShelfRequest,
  type SearchShelfResult,
  type RefreshShelfResult
} from "./shelf-ipc";
import {
  CLOSE_REVIEWER_VIEW_CHANNEL,
  OPEN_REVIEWER_VIEW_CHANNEL,
  SET_REVIEWER_VIEW_BOUNDS_CHANNEL,
  type ReviewerViewCloseResult,
  type ReviewerViewBounds,
  type ReviewerViewOpenResult
} from "./reviewer-view-controller";
import {
  RESOLVE_REFERENCES_CHANNEL,
  type ResolveReferencesRequest,
  type ResolveReferencesResult
} from "./reference-ipc";
import {
  type ResolveExportRequest,
  type ResolveExportResult,
  type WriteExportRequest,
  type WriteExportResult
} from "./export-ipc";
import { RESOLVE_EXPORT_CHANNEL, WRITE_EXPORT_CHANNEL } from "./export-contract";
import {
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_MODS_CHANNEL,
  MOD_CAPABILITY_REQUEST_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  RELOAD_MODS_CHANNEL,
  RESPOND_MOD_CAPABILITY_CHANNEL,
  isModCapabilityRequestEvent,
  type InvokeModCommandResult,
  type ModCapabilityRequestEvent,
  type ModCapabilityResponse,
  type ModCapabilityResponseRequest,
  type ModCommandRequest,
  type OpenModsFolderResult,
  type ModSnapshotResult
} from "./mod-ipc";
import {
  LOAD_WORKSPACE_STATE_CHANNEL,
  SAVE_WORKSPACE_STATE_CHANNEL,
  type LoadWorkspaceStateResult,
  type SaveWorkspaceStateResult,
  type WorkspaceState
} from "./workspace-state-ipc";
import {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  type CreateRepositoryRequest,
  type CreateRepositoryResult,
  type CreateRepositoryHistoryResult,
  type ListRepositoryHistoryResult,
  type OpenRepositoryDocumentResult,
  type OpenRepositoryHistoryResult,
  type OpenRepositoryResult,
  type RepositoryHandoffRequest,
  type RepositoryHistoryCopyRequest,
  type RepositoryHistoryRequest,
  type UseRepositoryShelfResult
} from "./repository-ipc";
import {
  CREATE_PROJECT_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  RESTORE_PROJECT_CHANNEL,
  type CreateProjectFileRequest,
  type CreateProjectRequest,
  type OpenProjectFileRequest,
  type ProjectCreateResultWithCancel,
  type ProjectFileCreateResultWithError,
  type ProjectFileOpenResult,
  type ProjectOpenResult,
  type ProjectRestoreResult
} from "./project-ipc";
import type { CreateFolderResult, ExplorerListResult } from "./document-workspace";
import {
  FIRST_RUN_PROGRESS_CHANNEL,
  GET_FIRST_RUN_STATUS_CHANNEL,
  RUN_FIRST_RUN_SETUP_CHANNEL,
  isFirstRunProgressEvent,
  type FirstRunChoices,
  type FirstRunProgressEvent,
  type FirstRunSetupResult,
  type FirstRunStatus
} from "./first-run-ipc";
import { OPEN_BUNDLED_MANUAL_CHANNEL, type OpenBundledManualResult } from "./manual-ipc";
import {
  CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL,
  CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL,
  type CollectorSaveDestinationIpcResult
} from "./collector-save-destination-ipc";
import {
  CREATE_WORKDESK_CHANNEL,
  CREATE_WORKDESK_FILE_CHANNEL,
  CREATE_WORKDESK_PROJECT_CHANNEL,
  COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL,
  OPEN_WORKDESK_CHANNEL,
  OPEN_WORKDESK_PROJECT_CHANNEL,
  REMOVE_WORKDESK_PROJECT_CHANNEL,
  REGISTER_WORKDESK_PROJECT_CHANNEL,
  RESTORE_WORKDESK_CHANNEL,
  RETURN_TO_WORKDESK_CHANNEL,
  SAVE_WORKDESK_CONTEXT_CHANNEL,
  type CreateWorkdeskFileRequest,
  type CopyWorkdeskFileToProjectRequest,
  type CreateWorkdeskProjectRequest,
  type CreateWorkdeskRequest,
  type RemoveWorkdeskProjectRequest,
  type OpenWorkdeskProjectRequest,
  type RegisterWorkdeskProjectRequest,
  type WorkdeskFileCreateResult,
  type WorkdeskCopyResult,
  type WorkdeskOpenResult,
  type WorkdeskProjectResult,
  type WorkdeskRestoreResult,
  type SaveWorkdeskContextRequest,
  type SaveWorkdeskContextResult
} from "./workdesk-ipc";
import {
  AUTOSAVE_FLUSH_REQUEST_CHANNEL,
  AUTOSAVE_FLUSH_RESPONSE_CHANNEL,
  isAutosaveFlushRequest,
  type AutosaveFlushRequest,
  type AutosaveFlushResponseRequest
} from "./autosave-ipc";
import {
  OPEN_EXTERNAL_LINK_CHANNEL,
  OPEN_INTERNAL_LINK_CHANNEL,
  RESOLVE_INTERNAL_LINK_CHANNEL,
  type OpenExternalLinkRequest,
  type OpenExternalLinkResult,
  type OpenInternalLinkRequest,
  type OpenInternalLinkResult,
  type ResolveInternalLinkRequest,
  type ResolveInternalLinkResult
} from "./project-link-ipc";
import {
  RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL,
  type ResolveSyncedBlockDocumentRequest,
  type ResolveSyncedBlockDocumentIpcResult
} from "./synced-block-ipc";
import {
  IMPORT_DROPPED_IMAGE_CHANNEL,
  RESOLVE_PROJECT_ASSET_CHANNEL,
  type ProjectAssetIpcResult,
  type ResolveProjectAssetRequest
} from "./project-assets-ipc";
import {
  SEARCH_PROJECT_MARKDOWN_CHANNEL,
  type SearchProjectMarkdownRequest,
  type SearchProjectMarkdownResult
} from "./project-search-ipc";
import {
  APPLICATION_MENU_COMMAND_CHANNEL,
  UPDATE_APPLICATION_MENU_CHANNEL,
  isApplicationMenuCommandId,
  isApplicationMenuSnapshot,
  type ApplicationMenuCommandId,
  type ApplicationMenuCommandState
} from "./application-menu-contract";

export const OPEN_MARKDOWN_CHANNEL = "maginalia:open-markdown";
export const SAVE_MARKDOWN_CHANNEL = "maginalia:save-markdown";
export {
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  LIST_EXPLORER_CHANNEL,
  CREATE_EXPLORER_FOLDER_CHANNEL,
  DELETE_EXPLORER_FILE_CHANNEL
} from "./document-workspace-ipc";
export {
  CREATE_PROJECT_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  RESTORE_PROJECT_CHANNEL
} from "./project-ipc";
export {
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
  SAVE_WORKDESK_CONTEXT_CHANNEL
} from "./workdesk-ipc";
export {
  OPEN_LIBRARY_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL
} from "./library-ipc";
export { SEARCH_SHELF_CHANNEL, REFRESH_SHELF_CHANNEL } from "./shelf-ipc";
export {
  CLOSE_REVIEWER_VIEW_CHANNEL,
  OPEN_REVIEWER_VIEW_CHANNEL,
  SET_REVIEWER_VIEW_BOUNDS_CHANNEL
} from "./reviewer-view-controller";
export { RESOLVE_REFERENCES_CHANNEL } from "./reference-ipc";
export { RESOLVE_EXPORT_CHANNEL, WRITE_EXPORT_CHANNEL } from "./export-contract";
export { RESOLVE_INTERNAL_LINK_CHANNEL, OPEN_INTERNAL_LINK_CHANNEL, OPEN_EXTERNAL_LINK_CHANNEL } from "./project-link-ipc";
export { RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL } from "./synced-block-ipc";
export { RESOLVE_PROJECT_ASSET_CHANNEL, IMPORT_DROPPED_IMAGE_CHANNEL } from "./project-assets-ipc";
export { SEARCH_PROJECT_MARKDOWN_CHANNEL } from "./project-search-ipc";
export {
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_MODS_CHANNEL,
  MOD_CAPABILITY_REQUEST_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  RELOAD_MODS_CHANNEL,
  RESPOND_MOD_CAPABILITY_CHANNEL
} from "./mod-ipc";
export { LOAD_WORKSPACE_STATE_CHANNEL, SAVE_WORKSPACE_STATE_CHANNEL } from "./workspace-state-ipc";
export {
  AUTOSAVE_FLUSH_REQUEST_CHANNEL,
  AUTOSAVE_FLUSH_RESPONSE_CHANNEL
} from "./autosave-ipc";
export {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL
} from "./repository-ipc";
export type {
  OpenLibraryResult,
  QuotationReference,
  ResolveQuotationForInsertRequest,
  ResolveQuotationForInsertResult,
  SearchLibraryRequest,
  SearchLibraryResult
} from "./library-ipc";
export type {
  SearchShelfRequest,
  SearchShelfResult,
  RefreshShelfResult
} from "./shelf-ipc";
export type { SearchProjectMarkdownRequest, SearchProjectMarkdownResult } from "./project-search-ipc";
export type {
  ResolveReferencesRequest,
  ResolveReferencesResult
} from "./reference-ipc";
export type {
  ResolveExportRequest,
  ResolveExportResult,
  WriteExportRequest,
  WriteExportResult
} from "./export-ipc";
export type {
  InvokeModCommandResult,
  ModCapabilityRequestEvent,
  ModCapabilityResponse,
  ModCapabilityResponseRequest,
  ModCommandRequest,
  ModSnapshotResult
} from "./mod-ipc";
export type {
  LoadWorkspaceStateResult,
  SaveWorkspaceStateResult,
  WorkspaceState
} from "./workspace-state-ipc";
export type {
  CreateRepositoryRequest,
  CreateRepositoryResult,
  CreateRepositoryHistoryResult,
  ListRepositoryHistoryResult,
  OpenRepositoryDocumentResult,
  OpenRepositoryHistoryResult,
  OpenRepositoryResult,
  RepositoryHandoffRequest,
  RepositoryHistoryCopyRequest,
  RepositoryHistoryRequest,
  UseRepositoryShelfResult
} from "./repository-ipc";
export type {
  CreateProjectFileRequest,
  CreateProjectRequest,
  OpenProjectFileRequest,
  ProjectCreateResultWithCancel,
  ProjectFileCreateResultWithError,
  ProjectFileOpenResult,
  ProjectOpenResult,
  ProjectRestoreResult
} from "./project-ipc";
export type {
  CopyWorkdeskFileToProjectRequest,
  CreateWorkdeskFileRequest,
  CreateWorkdeskRequest,
  WorkdeskFileCreateResult,
  WorkdeskCopyResult,
  WorkdeskOpenResult,
  WorkdeskRestoreResult,
  SaveWorkdeskContextRequest,
  SaveWorkdeskContextResult
} from "./workdesk-ipc";
export type {
  AutosaveFlushRequest,
  AutosaveFlushResponseRequest
} from "./autosave-ipc";
export type {
  ResolveInternalLinkRequest,
  ResolveInternalLinkResult,
  OpenInternalLinkRequest,
  OpenInternalLinkResult,
  OpenExternalLinkRequest,
  OpenExternalLinkResult
} from "./project-link-ipc";
export type { ResolveProjectAssetRequest, ImportDroppedImageRequest, ProjectAssetIpcResult } from "./project-assets-ipc";

export type EventUnsubscribe = () => void;
export type AutosaveFlushCallback = (request: AutosaveFlushRequest) => boolean | Promise<boolean>;
export type ApplicationMenuCommandCallback = (commandId: ApplicationMenuCommandId) => void;
export type ModCapabilityCallback = (
  request: ModCapabilityRequestEvent,
) => ModCapabilityResponse | Promise<ModCapabilityResponse>;

export interface MarkdownPreloadApi {
  getFirstRunStatus?(): Promise<FirstRunStatus>;
  runFirstRunSetup?(choices: FirstRunChoices): Promise<FirstRunSetupResult>;
  onFirstRunProgress?(callback: (event: FirstRunProgressEvent) => void): EventUnsubscribe;
  updateApplicationMenu?(snapshot: readonly ApplicationMenuCommandState[]): Promise<void>;
  onApplicationCommand?(callback: ApplicationMenuCommandCallback): EventUnsubscribe;
  openBundledManual?(): Promise<OpenBundledManualResult>;
  configureCollectorSaveDestination?(): Promise<CollectorSaveDestinationIpcResult>;
  clearCollectorSaveDestination?(): Promise<CollectorSaveDestinationIpcResult>;
  openMarkdown(): Promise<OpenMarkdownResult>;
  saveMarkdown(request: SaveMarkdownRequest): Promise<SaveMarkdownResult>;
  openDocument?(): Promise<OpenDocumentResult>;
  openManuscript?(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
  listExplorer?(request: ExplorerListRequest): Promise<ExplorerListResult>;
  createExplorerFolder?(request: ExplorerCreateFolderRequest): Promise<CreateFolderResult>;
  deleteExplorerFile?(request: ExplorerDeleteFileRequest): Promise<ExplorerDeleteFileResult>;
  openProject?(): Promise<ProjectOpenResult>;
  createProject?(request: CreateProjectRequest): Promise<ProjectCreateResultWithCancel>;
  restoreProject?(): Promise<ProjectRestoreResult>;
  openProjectFile?(request: OpenProjectFileRequest): Promise<ProjectFileOpenResult>;
  createProjectFile?(request: CreateProjectFileRequest): Promise<ProjectFileCreateResultWithError>;
  openWorkdesk?(): Promise<WorkdeskOpenResult>;
  createWorkdesk?(request: CreateWorkdeskRequest): Promise<WorkdeskOpenResult>;
  restoreWorkdesk?(): Promise<WorkdeskRestoreResult>;
  returnToWorkdesk?(): Promise<WorkdeskRestoreResult>;
  saveWorkdeskContext?(request: SaveWorkdeskContextRequest): Promise<SaveWorkdeskContextResult>;
  createWorkdeskFile?(request: CreateWorkdeskFileRequest): Promise<WorkdeskFileCreateResult>;
  createWorkdeskProject?(request: CreateWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  registerWorkdeskProject?(request: RegisterWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  removeWorkdeskProject?(request: RemoveWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  openWorkdeskProject?(request: OpenWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  copyWorkdeskFileToProject?(request: CopyWorkdeskFileToProjectRequest): Promise<WorkdeskCopyResult>;
  openLibrary?(): Promise<OpenLibraryResult>;
  searchLibrary?(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert?(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
  searchShelf?(request: SearchShelfRequest): Promise<SearchShelfResult>;
  refreshShelf?(): Promise<RefreshShelfResult>;
  /** Opens the one managed Reviewer View; it accepts no renderer-controlled URL. */
  openReviewerView?(): Promise<ReviewerViewOpenResult>;
  closeReviewerView?(): Promise<ReviewerViewCloseResult>;
  /** Layout-only bounds for the fixed Reviewer central service view. */
  setReviewerViewBounds?(bounds: ReviewerViewBounds): Promise<void>;
  resolveReferences?(request: ResolveReferencesRequest): Promise<ResolveReferencesResult>;
  resolveExport?(request: ResolveExportRequest): Promise<ResolveExportResult>;
  writeExport?(request: WriteExportRequest): Promise<WriteExportResult>;
  resolveInternalLink?(request: ResolveInternalLinkRequest): Promise<ResolveInternalLinkResult>;
  openInternalLink?(request: OpenInternalLinkRequest): Promise<OpenInternalLinkResult>;
  openExternalLink?(request: OpenExternalLinkRequest): Promise<OpenExternalLinkResult>;
  resolveSyncedBlockDocument?(request: ResolveSyncedBlockDocumentRequest): Promise<ResolveSyncedBlockDocumentIpcResult>;
  resolveProjectAsset?(request: ResolveProjectAssetRequest): Promise<ProjectAssetIpcResult>;
  /** Resolves an OS-dropped File inside preload, never in renderer code. */
  importDroppedImageFile?(request: { readonly projectId: string; readonly file: File; readonly optimize: boolean }): Promise<ProjectAssetIpcResult>;
  searchProjectMarkdown?(request: SearchProjectMarkdownRequest): Promise<SearchProjectMarkdownResult>;
  loadMods?(): Promise<ModSnapshotResult>;
  reloadMods?(): Promise<ModSnapshotResult>;
  openModsFolder?(): Promise<OpenModsFolderResult>;
  invokeModCommand?(request: ModCommandRequest): Promise<InvokeModCommandResult>;
  onModCapabilityRequest?(callback: ModCapabilityCallback): EventUnsubscribe;
  loadWorkspaceState?(): Promise<LoadWorkspaceStateResult>;
  saveWorkspaceState?(state: WorkspaceState): Promise<SaveWorkspaceStateResult>;
  createRepository?(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  createRepositoryHistory?(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory?(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory?(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
  openRepository?(): Promise<OpenRepositoryResult>;
  openRepositoryDocument?(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf?(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
  onAutosaveFlushRequest?(callback: AutosaveFlushCallback): EventUnsubscribe;
}

export type CompleteMarkdownPreloadApi = MarkdownPreloadApi & {
  getFirstRunStatus(): Promise<FirstRunStatus>;
  runFirstRunSetup(choices: FirstRunChoices): Promise<FirstRunSetupResult>;
  onFirstRunProgress(callback: (event: FirstRunProgressEvent) => void): EventUnsubscribe;
  updateApplicationMenu(snapshot: readonly ApplicationMenuCommandState[]): Promise<void>;
  onApplicationCommand(callback: ApplicationMenuCommandCallback): EventUnsubscribe;
  openBundledManual(): Promise<OpenBundledManualResult>;
  configureCollectorSaveDestination(): Promise<CollectorSaveDestinationIpcResult>;
  clearCollectorSaveDestination(): Promise<CollectorSaveDestinationIpcResult>;
  openDocument(): Promise<OpenDocumentResult>;
  openManuscript(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
  listExplorer(request: ExplorerListRequest): Promise<ExplorerListResult>;
  createExplorerFolder(request: ExplorerCreateFolderRequest): Promise<CreateFolderResult>;
  deleteExplorerFile(request: ExplorerDeleteFileRequest): Promise<ExplorerDeleteFileResult>;
  openProject(): Promise<ProjectOpenResult>;
  createProject(request: CreateProjectRequest): Promise<ProjectCreateResultWithCancel>;
  restoreProject(): Promise<ProjectRestoreResult>;
  openProjectFile(request: OpenProjectFileRequest): Promise<ProjectFileOpenResult>;
  createProjectFile(request: CreateProjectFileRequest): Promise<ProjectFileCreateResultWithError>;
  openWorkdesk(): Promise<WorkdeskOpenResult>;
  createWorkdesk(request: CreateWorkdeskRequest): Promise<WorkdeskOpenResult>;
  restoreWorkdesk(): Promise<WorkdeskRestoreResult>;
  returnToWorkdesk(): Promise<WorkdeskRestoreResult>;
  saveWorkdeskContext(request: SaveWorkdeskContextRequest): Promise<SaveWorkdeskContextResult>;
  createWorkdeskFile(request: CreateWorkdeskFileRequest): Promise<WorkdeskFileCreateResult>;
  createWorkdeskProject(request: CreateWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  registerWorkdeskProject(request: RegisterWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  removeWorkdeskProject(request: RemoveWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  openWorkdeskProject(request: OpenWorkdeskProjectRequest): Promise<WorkdeskProjectResult>;
  copyWorkdeskFileToProject(request: CopyWorkdeskFileToProjectRequest): Promise<WorkdeskCopyResult>;
  openLibrary(): Promise<OpenLibraryResult>;
  searchLibrary(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
  searchShelf(request: SearchShelfRequest): Promise<SearchShelfResult>;
  refreshShelf(): Promise<RefreshShelfResult>;
  openReviewerView(): Promise<ReviewerViewOpenResult>;
  closeReviewerView(): Promise<ReviewerViewCloseResult>;
  setReviewerViewBounds(bounds: ReviewerViewBounds): Promise<void>;
  resolveReferences(request: ResolveReferencesRequest): Promise<ResolveReferencesResult>;
  resolveExport(request: ResolveExportRequest): Promise<ResolveExportResult>;
  writeExport(request: WriteExportRequest): Promise<WriteExportResult>;
  resolveInternalLink(request: ResolveInternalLinkRequest): Promise<ResolveInternalLinkResult>;
  openInternalLink(request: OpenInternalLinkRequest): Promise<OpenInternalLinkResult>;
  openExternalLink(request: OpenExternalLinkRequest): Promise<OpenExternalLinkResult>;
  resolveSyncedBlockDocument(request: ResolveSyncedBlockDocumentRequest): Promise<ResolveSyncedBlockDocumentIpcResult>;
  resolveProjectAsset(request: ResolveProjectAssetRequest): Promise<ProjectAssetIpcResult>;
  importDroppedImageFile(request: { readonly projectId: string; readonly file: File; readonly optimize: boolean }): Promise<ProjectAssetIpcResult>;
  loadMods(): Promise<ModSnapshotResult>;
  reloadMods(): Promise<ModSnapshotResult>;
  openModsFolder(): Promise<OpenModsFolderResult>;
  invokeModCommand(request: ModCommandRequest): Promise<InvokeModCommandResult>;
  onModCapabilityRequest(callback: ModCapabilityCallback): EventUnsubscribe;
  loadWorkspaceState(): Promise<LoadWorkspaceStateResult>;
  saveWorkspaceState(state: WorkspaceState): Promise<SaveWorkspaceStateResult>;
  createRepository(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  createRepositoryHistory(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
  openRepository(): Promise<OpenRepositoryResult>;
  openRepositoryDocument(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
  onAutosaveFlushRequest(callback: AutosaveFlushCallback): EventUnsubscribe;
};

export type MarkdownInvoke = (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
export type MarkdownEventSubscribe = (
  channel: string,
  listener: (value: unknown) => void,
) => EventUnsubscribe;
export type DroppedFilePathProvider = (file: File) => string;

const noEventSubscription: MarkdownEventSubscribe = () => () => undefined;

export function createMarkdownPreloadApi(
  invoke: MarkdownInvoke,
  subscribe: MarkdownEventSubscribe = noEventSubscription,
  droppedFilePath: DroppedFilePathProvider = () => "",
): CompleteMarkdownPreloadApi {
  return {
    getFirstRunStatus: () => invoke(GET_FIRST_RUN_STATUS_CHANNEL) as Promise<FirstRunStatus>,
    runFirstRunSetup: (choices) => invoke(RUN_FIRST_RUN_SETUP_CHANNEL, choices) as Promise<FirstRunSetupResult>,
    onFirstRunProgress: (callback) => {
      if (typeof callback !== "function") throw new TypeError("The first-run progress callback is invalid.");
      return subscribe(FIRST_RUN_PROGRESS_CHANNEL, (value) => {
        if (isFirstRunProgressEvent(value)) callback(value);
      });
    },
    updateApplicationMenu: async (snapshot) => {
      if (!isApplicationMenuSnapshot(snapshot)) throw new TypeError("The application menu snapshot is invalid.");
      const accepted = await invoke(UPDATE_APPLICATION_MENU_CHANNEL, snapshot);
      if (accepted !== true) throw new Error("The application menu update was rejected.");
    },
    onApplicationCommand: (callback) => {
      if (typeof callback !== "function") throw new TypeError("The application menu callback is invalid.");
      return subscribe(APPLICATION_MENU_COMMAND_CHANNEL, (value) => {
        if (isApplicationMenuCommandId(value)) callback(value);
      });
    },
    openBundledManual: () => invoke(OPEN_BUNDLED_MANUAL_CHANNEL) as Promise<OpenBundledManualResult>,
    configureCollectorSaveDestination: () => invoke(CONFIGURE_COLLECTOR_SAVE_DESTINATION_CHANNEL) as Promise<CollectorSaveDestinationIpcResult>,
    clearCollectorSaveDestination: () => invoke(CLEAR_COLLECTOR_SAVE_DESTINATION_CHANNEL) as Promise<CollectorSaveDestinationIpcResult>,
    openMarkdown: () => invoke(OPEN_MARKDOWN_CHANNEL) as Promise<OpenMarkdownResult>,
    saveMarkdown: (request) => invoke(SAVE_MARKDOWN_CHANNEL, request) as Promise<SaveMarkdownResult>,
    openDocument: () => invoke(OPEN_DOCUMENT_CHANNEL) as Promise<OpenDocumentResult>,
    openManuscript: (request) => invoke(OPEN_MANUSCRIPT_CHANNEL, request) as Promise<OpenManuscriptResult>,
    listExplorer: (request) => invoke(LIST_EXPLORER_CHANNEL, request) as Promise<ExplorerListResult>,
    createExplorerFolder: (request) => invoke(CREATE_EXPLORER_FOLDER_CHANNEL, request) as Promise<CreateFolderResult>,
    deleteExplorerFile: (request) => invoke(DELETE_EXPLORER_FILE_CHANNEL, request) as Promise<ExplorerDeleteFileResult>,
    openProject: () => invoke(OPEN_PROJECT_CHANNEL) as Promise<ProjectOpenResult>,
    createProject: (request) => invoke(CREATE_PROJECT_CHANNEL, request) as Promise<ProjectCreateResultWithCancel>,
    restoreProject: () => invoke(RESTORE_PROJECT_CHANNEL) as Promise<ProjectRestoreResult>,
    openProjectFile: (request) => invoke(OPEN_PROJECT_FILE_CHANNEL, request) as Promise<ProjectFileOpenResult>,
    createProjectFile: (request) => invoke(CREATE_PROJECT_FILE_CHANNEL, request) as Promise<ProjectFileCreateResultWithError>,
    openWorkdesk: () => invoke(OPEN_WORKDESK_CHANNEL) as Promise<WorkdeskOpenResult>,
    createWorkdesk: (request) => invoke(CREATE_WORKDESK_CHANNEL, request) as Promise<WorkdeskOpenResult>,
    restoreWorkdesk: () => invoke(RESTORE_WORKDESK_CHANNEL) as Promise<WorkdeskRestoreResult>,
    returnToWorkdesk: () => invoke(RETURN_TO_WORKDESK_CHANNEL) as Promise<WorkdeskRestoreResult>,
    saveWorkdeskContext: (request) => invoke(SAVE_WORKDESK_CONTEXT_CHANNEL, request) as Promise<SaveWorkdeskContextResult>,
    createWorkdeskFile: (request) => invoke(CREATE_WORKDESK_FILE_CHANNEL, request) as Promise<WorkdeskFileCreateResult>,
    createWorkdeskProject: (request) => invoke(CREATE_WORKDESK_PROJECT_CHANNEL, request) as Promise<WorkdeskProjectResult>,
    registerWorkdeskProject: (request) => invoke(REGISTER_WORKDESK_PROJECT_CHANNEL, request) as Promise<WorkdeskProjectResult>,
    removeWorkdeskProject: (request) => invoke(REMOVE_WORKDESK_PROJECT_CHANNEL, request) as Promise<WorkdeskProjectResult>,
    openWorkdeskProject: (request) => invoke(OPEN_WORKDESK_PROJECT_CHANNEL, request) as Promise<WorkdeskProjectResult>,
    copyWorkdeskFileToProject: (request) => invoke(COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL, request) as Promise<WorkdeskCopyResult>,
    openLibrary: () => invoke(OPEN_LIBRARY_CHANNEL) as Promise<OpenLibraryResult>,
    searchLibrary: (request) => invoke(SEARCH_LIBRARY_CHANNEL, request) as Promise<SearchLibraryResult>,
    resolveQuotationForInsert: (request) =>
      invoke(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL, request) as Promise<ResolveQuotationForInsertResult>,
    searchShelf: (request) => invoke(SEARCH_SHELF_CHANNEL, request) as Promise<SearchShelfResult>,
    refreshShelf: () => invoke(REFRESH_SHELF_CHANNEL) as Promise<RefreshShelfResult>,
    openReviewerView: () => invoke(OPEN_REVIEWER_VIEW_CHANNEL) as Promise<ReviewerViewOpenResult>,
    closeReviewerView: () => invoke(CLOSE_REVIEWER_VIEW_CHANNEL) as Promise<ReviewerViewCloseResult>,
    setReviewerViewBounds: (bounds) => invoke(SET_REVIEWER_VIEW_BOUNDS_CHANNEL, bounds) as Promise<void>,
    resolveReferences: (request) =>
      invoke(RESOLVE_REFERENCES_CHANNEL, request) as Promise<ResolveReferencesResult>,
    resolveExport: (request) =>
      invoke(RESOLVE_EXPORT_CHANNEL, request) as Promise<ResolveExportResult>,
    writeExport: (request) =>
      invoke(WRITE_EXPORT_CHANNEL, request) as Promise<WriteExportResult>,
    resolveInternalLink: (request) =>
      invoke(RESOLVE_INTERNAL_LINK_CHANNEL, request) as Promise<ResolveInternalLinkResult>,
    openInternalLink: (request) =>
      invoke(OPEN_INTERNAL_LINK_CHANNEL, request) as Promise<OpenInternalLinkResult>,
    openExternalLink: (request) =>
      invoke(OPEN_EXTERNAL_LINK_CHANNEL, request) as Promise<OpenExternalLinkResult>,
    resolveSyncedBlockDocument: (request) =>
      invoke(RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL, request) as Promise<ResolveSyncedBlockDocumentIpcResult>,
    resolveProjectAsset: (request) =>
      invoke(RESOLVE_PROJECT_ASSET_CHANNEL, request) as Promise<ProjectAssetIpcResult>,
    importDroppedImageFile: (request) => {
      let sourcePath = "";
      try { sourcePath = droppedFilePath(request.file); } catch { sourcePath = ""; }
      if (typeof sourcePath !== "string" || sourcePath.length === 0) {
        return Promise.resolve({ kind: "error", code: "invalid-request", message: "The dropped image is unavailable." });
      }
      return invoke(IMPORT_DROPPED_IMAGE_CHANNEL, {
        projectId: request.projectId,
        sourcePath,
        optimize: request.optimize
      }) as Promise<ProjectAssetIpcResult>;
    },
    searchProjectMarkdown: (request) =>
      invoke(SEARCH_PROJECT_MARKDOWN_CHANNEL, request) as Promise<SearchProjectMarkdownResult>,
    loadMods: () => invoke(LOAD_MODS_CHANNEL) as Promise<ModSnapshotResult>,
    reloadMods: () => invoke(RELOAD_MODS_CHANNEL) as Promise<ModSnapshotResult>,
    openModsFolder: () => invoke(OPEN_MODS_FOLDER_CHANNEL) as Promise<OpenModsFolderResult>,
    invokeModCommand: (request) => invoke(INVOKE_MOD_COMMAND_CHANNEL, request) as Promise<InvokeModCommandResult>,
    onModCapabilityRequest: (callback) => {
      if (typeof callback !== "function") throw new TypeError("The Mod capability callback is invalid.");
      return subscribe(MOD_CAPABILITY_REQUEST_CHANNEL, (value) => {
        // The main process has already validated the worker envelope. Keep
        // the callback boundary explicit and ensure renderer failures produce
        // a response instead of leaving a worker request pending.
        if (!isModCapabilityRequestEvent(value)) return;
        const request = value;
        let result: ModCapabilityResponse | Promise<ModCapabilityResponse>;
        try {
          result = callback(request);
        } catch (error) {
          result = {
            kind: "error",
            message: error instanceof Error && error.message.length > 0
              ? error.message.slice(0, 500)
              : "The Mod capability failed."
          };
        }
        void Promise.resolve(result).then((response) => {
          const requestValue: ModCapabilityResponseRequest = { requestId: request.requestId, response };
          return invoke(RESPOND_MOD_CAPABILITY_CHANNEL, requestValue);
        }).catch(() => undefined);
      });
    },
    loadWorkspaceState: () =>
      invoke(LOAD_WORKSPACE_STATE_CHANNEL) as Promise<LoadWorkspaceStateResult>,
    saveWorkspaceState: (state) =>
      invoke(SAVE_WORKSPACE_STATE_CHANNEL, state) as Promise<SaveWorkspaceStateResult>,
    createRepository: (request) =>
      invoke(CREATE_REPOSITORY_CHANNEL, request) as Promise<CreateRepositoryResult>,
    createRepositoryHistory: (request) =>
      invoke(CREATE_REPOSITORY_HISTORY_CHANNEL, request) as Promise<CreateRepositoryHistoryResult>,
    listRepositoryHistory: (request) =>
      invoke(LIST_REPOSITORY_HISTORY_CHANNEL, request) as Promise<ListRepositoryHistoryResult>,
    openRepositoryHistory: (request) =>
      invoke(OPEN_REPOSITORY_HISTORY_CHANNEL, request) as Promise<OpenRepositoryHistoryResult>,
    openRepository: () => invoke(OPEN_REPOSITORY_CHANNEL) as Promise<OpenRepositoryResult>,
    openRepositoryDocument: (request) =>
      invoke(OPEN_REPOSITORY_DOCUMENT_CHANNEL, request) as Promise<OpenRepositoryDocumentResult>,
    useRepositoryShelf: (request) =>
      invoke(USE_REPOSITORY_SHELF_CHANNEL, request) as Promise<UseRepositoryShelfResult>,
    onAutosaveFlushRequest: (callback) => {
      if (typeof callback !== "function") throw new TypeError("The Autosave callback is invalid.");
      return subscribe(AUTOSAVE_FLUSH_REQUEST_CHANNEL, (value) => {
        if (!isAutosaveFlushRequest(value)) return;
        let result: boolean | Promise<boolean>;
        try {
          result = callback(value);
        } catch {
          result = false;
        }
        void Promise.resolve(result).then((ok) => {
          const response: AutosaveFlushResponseRequest = {
            requestId: value.requestId,
            ok: ok === true
          };
          return invoke(AUTOSAVE_FLUSH_RESPONSE_CHANNEL, response);
        }).catch(() => undefined);
      });
    },
  };
}
