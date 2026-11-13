import "./style.css";
import brandHeaderUrl from "../../../../assets/header.png?url";
const brandMarkerUrl = new URL("../../dist/branding/marker-stroke.png", import.meta.url).href;
import { WritingController, type CapturedInsertionTarget, type WritingStatus, type WritingView } from "./controller";
import { AutosaveCoordinator } from "./autosave-coordinator";
import { decideDirtySwitch } from "./dirty-decision";
import {
  LibraryController,
  type LibraryControllerApi,
  type LibraryControllerView,
  type LibraryViewState
} from "./library-controller";
import {
  ShelfController,
  type ShelfControllerApi,
  type ShelfControllerView,
  type ShelfViewState
} from "./shelf-controller";
import { MonacoMarkdownSurface } from "./monaco-surface";
import {
  createPreviewQuoteMap,
  renderMarkdownPreview,
  scanQuoteMarkersFromText,
  type PreviewQuote,
  type PreviewQuoteMap,
  type PreviewSyncedBlock
} from "./markdown-renderer";
import { insertMarkdownTable, transformMarkdownTable, type MarkdownTableCellTarget, type MarkdownTableTarget, type TableOperation } from "./markdown-table-commands";
import { applyDocumentProperties, readDocumentProperties, type DocumentProperties, type DocumentPropertiesState } from "./document-properties";
import { ownsCurrentPropertiesTarget, shouldPreserveUnappliedPropertiesForm, type PropertiesTarget } from "./properties-target";
import { mayDispatchTableTarget, ownsCurrentTableTarget, type ActiveTableTarget } from "./table-target";
import { PreviewController } from "./preview-controller";
import {
  insertSyncedBlockMarker,
  linearizeProjectComposition,
  resolveProjectComposition,
  scanSyncedBlockMarkers,
  validateSyncedBlockTarget,
  wouldIntroduceSyncedBlockCycle,
  type ComposedMarkdownProjection,
  type ComposedSyncedBlock,
  type SyncedBlockResolveResult
} from "./synced-block";
import { createLocalStorageRendererPreferenceStore, type WritingDirection } from "./renderer-preferences";
import { createExportPresentationSettings, EXPORT_PAPER_SIZES } from "../export-presentation-settings";
import { bindExportSettingControls, EXPORT_SETTING_IDS, registerExportPresentationSettings, type ExportPresentationPatch } from "./export-settings-registration";
import { resolvePreviewMedia } from "./project-media";
import { resolvePreviewInternalLinks } from "./preview-links";
import { importDroppedImageIntoDocument } from "./dropped-image";
import { stripDerivedReferenceList } from "./reference-list";
import { ContextKeyService } from "./command-context";
import { CommandRegistry, type CommandArgs } from "./command-registry";
import { registerDocumentTabCommands, ACTIVATE_DOCUMENT_COMMAND_ID } from "./document-tab-commands";
import { registerLinkCommands, OPEN_EXTERNAL_LINK_COMMAND_ID, OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID, OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID, OPEN_INTERNAL_LINK_COMMAND_ID } from "./link-commands";
import {
  INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID,
  PROJECT_MARKDOWN_SEARCH_COMMAND_ID,
  registerSearchCommands,
  SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID,
  SHELF_SEARCH_COMMAND_ID,
  SHELF_SELECT_RESULT_COMMAND_ID
} from "./search-commands";
import { buildApplicationMenuSnapshot } from "./application-menu-snapshot";
import { CommandPalette } from "./command-palette";
import { searchCurrentProjectDocuments, searchRegisteredWorkdeskProjects } from "./quick-open-search";
import { SettingsCenter } from "./settings-center";
import { SettingsRegistry } from "./settings-registry";
import { formatKeybinding, KeybindingService, parseKeyboardEvent, toPlatformKeybinding } from "./keybinding-service";
import { decideNativeInputKeybinding } from "./native-input-keybinding";
import { APPLICATION_MENU_COMMAND_IDS } from "../application-menu-contract";
import { registerCoreCommands } from "./core-commands";
import { registerWorkbenchCommands } from "./workbench-commands";
import { ContextMenuRegistry } from "./context-menu-registry";
import { ContextMenuSurface } from "./context-menu-surface";
import { UtilityBar } from "./utility-bar";
import { ModContributionBridge } from "./mod-contribution-bridge";
import {
  ProjectSearchController,
  insertProjectSearchSelection,
  normalizeSearchText,
  type ProjectSearchState,
  type UnifiedSearchMode
} from "./unified-search";
import {
  createShelfSourceUrlElement,
  DEFAULT_CANONICAL_SHELF_SEARCH_FIELDS,
  filterCanonicalShelfResults,
  type CanonicalShelfSearchField
} from "./shelf-search-view";
import type { DocumentSessionChange } from "./document-sessions";
import type { ExplorerEntry } from "../document-workspace";
import type { WorkspaceState } from "../workspace-state-ipc";
import { ModController, type ModControllerState } from "./mod-controller";
import {
  ReferencesController,
  type ReferencesControllerApi,
  type ReferencesControllerView,
  type ReferencesViewState
} from "./references-controller";
import {
  ExportController,
  type ExportControllerApi,
  type ExportControllerView,
  type ExportViewState
} from "./export-controller";
import {
  ProjectNavigationController,
  type ProjectNavigationApi,
  type ProjectNavigationState,
  type ProjectNavigationView
} from "./project-controller";
import { PROJECT_DOCUMENT_TYPES, type ProjectDocumentType } from "../project-metadata";
import { createProjectFileName } from "./project-ui";
import type { WorkdeskCopyResult, WorkdeskOpenResult, WorkdeskOpened, WorkdeskProjectResult, WorkdeskRecovered, WorkdeskRestoreResult } from "../workdesk-ipc";
import {
  WorkspaceNavigationController,
  type WorkspaceNavigationApi,
  type DirtySwitchDecision,
  type WorkspaceNavigationState,
  type WorkspaceNavigationView
} from "./workspace-controller";
import {
  RepositoryController,
  type RepositoryControllerApi,
  type RepositoryControllerView,
  type RepositoryHistoryViewState,
  type RepositoryKindOption,
  type RepositoryViewState
} from "./repository-controller";
import {
  createLocalStorageLayoutStore,
  WorkbenchCore,
  type LayoutState,
  type ViewRegion
} from "./workbench-core";
import { CENTRAL_SERVICE_VIEW_MANIFEST, WORKBENCH_VIEW_MANIFEST } from "./workbench-views";
import { restoreRememberedWorkdeskContext, shouldPromptForPrimaryWorkdesk } from "./workdesk-startup";
import { workdeskProjectShortcutsForRoot, type WorkdeskProjectExplorerShortcut } from "./workdesk-project-explorer";
import { restoreWorkdeskForReturn } from "./workdesk-return";
import { projectIdentityRecoveryNotice, workdeskIdentityRecoveryNotice, type FolderIdentityRecoveryNotice } from "./folder-identity-recovery-copy";
import type { FirstRunChoices, FirstRunResult } from "../first-run-coordinator";
import type { FirstRunStatus } from "../first-run-ipc";

const app = document.querySelector<HTMLDivElement>("#app");
const firstRunMode = new URLSearchParams(window.location.search).get("setup") === "first-run";

if (!app) {
  throw new Error("Renderer root element was not found");
}

app.innerHTML = `
  <main id="workbench" class="workspace workbench" aria-labelledby="title" data-editor-only="false">
    <header class="toolbar" id="workbench-toolbar">
      <div class="brand">
        <img class="brand-wordmark" src="${brandHeaderUrl}" alt="" aria-hidden="true">
        <h1 id="title" class="visually-hidden">MAGINALIA Alpha2 Wild Berry</h1>
      </div>
      <button id="workdesk-home" class="workbench-home-action" data-workbench-command="maginalia.workdesk.return" type="button" title="Return to your Workdesk" aria-label="Back to Workdesk" aria-pressed="false" disabled>← Workdesk</button>
    </header>
    <div class="workbench-body">
      <nav id="activity-bar" class="activity-bar" data-workbench-region="activity-bar" aria-label="Workbench view containers">
        <div id="activity-view-buttons" class="activity-view-buttons"></div>
        <span class="activity-spacer" aria-hidden="true"></span>
        <button id="toggle-primary-sidebar" class="activity-command" data-workbench-command="maginalia.view.togglePrimarySidebar" type="button" title="Toggle primary sidebar" aria-label="Toggle primary sidebar">P</button>
        <button id="toggle-secondary-sidebar" class="activity-command" data-workbench-command="maginalia.view.toggleSecondarySidebar" type="button" title="Toggle secondary sidebar" aria-label="Toggle secondary sidebar">S</button>
        <button id="toggle-activity-bar" class="activity-command" data-workbench-command="maginalia.view.toggleActivityBar" type="button" title="Toggle activity bar" aria-label="Toggle activity bar">A</button>
        <button id="toggle-editor-only" class="activity-command" data-workbench-command="maginalia.view.toggleEditorOnly" type="button" title="Toggle editor-only mode" aria-label="Toggle editor-only mode">E</button>
      </nav>
      <aside id="primary-sidebar" class="workbench-sidebar primary-sidebar" data-workbench-region="primary-sidebar" aria-label="Primary sidebar">
        <div id="primary-sidebar-resizer" class="sidebar-resizer" data-workbench-resize="primary-sidebar" role="separator" aria-label="Resize primary sidebar" aria-orientation="vertical" tabindex="0"></div>
        <div class="view-container primary-view-container">
          <section id="workspace-navigation" class="workspace-navigation view-panel" aria-labelledby="workspace-document-heading">
            <h2 id="workspace-document-heading" class="visually-hidden">Explorer</h2>
            <div class="project-header">
              <div class="workspace-document-heading">
                <span id="workspace-label" class="workspace-label">Project</span>
                <div class="workspace-document-title">
                  <strong id="workspace-document-name">No Project open</strong>
                  <div id="project-header-actions" class="project-header-actions">
                    <div class="project-menu-anchor">
                      <button id="project-overflow" class="project-header-action" type="button" aria-label="More Project actions" title="More Project actions" aria-haspopup="menu" aria-controls="project-overflow-menu" aria-expanded="false">⋯</button>
                      <div id="project-overflow-menu" class="project-action-menu project-overflow-menu" role="menu" aria-label="Project actions" hidden>
                        <button id="workdesk-register-project" type="button" role="menuitem">Add existing Project…</button>
                        <button id="open-project" type="button" role="menuitem">Open another Project…</button>
                        <hr class="project-action-menu-separator" role="separator">
                        <button id="open-workdesk" type="button" role="menuitem">Open Workdesk…</button>
                        <button id="workdesk-create" type="button" role="menuitem">Create Workdesk…</button>
                        <hr class="project-action-menu-separator" role="separator">
                        <button id="open-bundled-manual" type="button" role="menuitem">取扱説明書を開く</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div id="project-primary-actions" class="project-primary-actions">
              <div class="project-menu-anchor">
                <button id="project-new" class="project-header-action project-primary-action" type="button" aria-label="New Markdown file" title="New Markdown file" aria-haspopup="menu" aria-controls="project-new-menu" aria-expanded="false">+ New</button>
                <div id="project-new-menu" class="project-action-menu project-new-menu" role="menu" aria-label="New file" hidden>
                  <span class="project-action-menu-label">New Markdown</span>
                  ${PROJECT_DOCUMENT_TYPES.map((type) => `<button type="button" role="menuitem" data-document-type="${type}">${type}</button>`).join("")}
                  <button id="explorer-new-folder" type="button" role="menuitem">New Folder</button>
                </div>
              </div>
              <div id="workdesk-project-actions" class="project-header-actions" hidden aria-label="Workdesk Project actions">
                <button id="workdesk-new-project" class="project-header-action project-primary-action" type="button" title="New Project">New Project</button>
              </div>
            </div>
            <section id="workspace-recovery" class="workspace-recovery" aria-labelledby="workspace-recovery-title" hidden>
              <strong id="workspace-recovery-title"></strong>
              <p id="workspace-recovery-message" role="status" aria-live="polite"></p>
              <button id="workspace-repair" type="button" hidden>管理情報を修復</button>
            </section>
            <form id="project-create-form" class="project-create-form" hidden>
              <label class="visually-hidden" for="create-project-title">New Project name</label>
              <input id="create-project-title" type="text" maxlength="200" autocomplete="off" placeholder="New Project name" required>
              <button id="create-project" type="submit">Create</button>
              <button id="project-create-cancel" type="button">Cancel</button>
            </form>
            <p id="workspace-error" class="workspace-error" role="alert" aria-live="assertive" hidden></p>
            <div id="project-inline-create" class="project-inline-create" hidden>
              <div class="project-inline-create-heading">
                <span>New Markdown</span>
                <strong id="project-inline-document-type"></strong>
              </div>
              <form id="new-file-form" class="new-file-form">
                <input id="new-file-name" type="hidden" maxlength="240" autocomplete="off">
                <label class="visually-hidden" for="new-file-title">Title</label>
                <input id="new-file-title" type="text" maxlength="240" autocomplete="off" placeholder="Title">
                <select id="new-file-type" hidden aria-hidden="true" tabindex="-1">
                ${PROJECT_DOCUMENT_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("")}
                </select>
                <button id="new-file" type="submit" hidden aria-hidden="true">Create</button>
                <button id="project-create-file-submit" type="submit">Create</button>
                <button id="project-create-file-cancel" type="button">Cancel</button>
              </form>
            </div>
            <p id="empty-document-message" class="empty-document-message">Open a Project folder to see its Markdown files.</p>
            <ul id="explorer-tree" class="explorer-tree" aria-label="Explorer"></ul>
          </section>
          <section id="repository-navigation" class="repository-navigation view-panel" aria-labelledby="repository-heading">
            <div class="repository-heading-row">
              <h2 id="repository-heading">Repository</h2>
              <span id="repository-kind-label" class="repository-kind-label">No repository selected</span>
              <strong id="repository-name">No Repository open</strong>
            </div>
            <div class="repository-controls">
              <label for="repository-kind">Kind</label>
              <select id="repository-kind">
                <option value="project">Project</option>
                <option value="workbench">Workbench</option>
                <option value="shelf">Private Shelf</option>
              </select>
              <label for="repository-title">Title</label>
              <input id="repository-title" type="text" maxlength="200" autocomplete="off">
              <button id="create-repository" type="button">Create</button>
              <button id="open-repository" type="button">Open Repository</button>
              <button id="activate-repository" type="button" hidden>Activate</button>
            </div>
            <p id="repository-status" class="repository-status" role="status" aria-live="polite">Create or open a repository.</p>
            <p id="repository-error" class="repository-error" role="alert" aria-live="assertive" hidden></p>
            <section class="repository-history" aria-labelledby="repository-history-heading">
              <div class="repository-history-heading-row">
                <h3 id="repository-history-heading">History</h3>
                <div class="repository-history-actions">
                  <button id="record-repository-history" type="button" disabled>Record History</button>
                  <button id="refresh-repository-history" type="button" disabled>Refresh</button>
                </div>
              </div>
              <label for="repository-history-entry">Saved History</label>
              <select id="repository-history-entry" disabled>
                <option value="">No saved History</option>
              </select>
              <button id="open-repository-history" type="button" disabled>Open History Copy</button>
              <p id="repository-history-status" class="repository-history-status" role="status" aria-live="polite">Activate a repository to view History.</p>
              <p id="repository-history-error" class="repository-history-error" role="alert" aria-live="assertive" hidden></p>
            </section>
          </section>
        </div>
      </aside>
      <section class="editor-area" aria-label="Editor Area">
        <nav id="document-tabs" class="document-tabs" role="tablist" aria-label="Open documents"></nav>
        <div id="editor-utility-bar" aria-label="Editor commands"></div>
        <div id="document-presentation-controls" class="document-presentation-controls" aria-label="Document presentation">
          <button id="document-edit-mode" type="button" aria-pressed="true">Edit</button>
          <button id="document-preview-mode" type="button" aria-pressed="false">Preview</button>
          <span class="presentation-divider" aria-hidden="true"></span>
          <button id="document-horizontal" data-command-id="maginalia.renderer.setHorizontal" type="button" aria-pressed="true">Horizontal</button>
          <button id="document-vertical" data-command-id="maginalia.renderer.setVertical" type="button" aria-pressed="false">Vertical</button>
        </div>
        <section id="editor" class="editor" aria-label="Markdown editor"></section>
        <section id="markdown-preview" class="markdown-preview" aria-label="Markdown preview" hidden></section>
        <section id="central-service-view" class="central-service-view" data-workbench-service-view="reviewer" aria-label="Reviewer" hidden>
          <header class="central-service-header">
            <strong>Reviewer</strong>
            <span>取り込み・確認・OCR・承認</span>
            <button id="close-reviewer-view" type="button">エディターに戻る</button>
          </header>
          <div id="reviewer-service-slot" class="central-service-slot" aria-label="Reviewer service content"></div>
        </section>
      </section>
      <aside id="secondary-sidebar" class="workbench-sidebar secondary-sidebar" data-workbench-region="secondary-sidebar" aria-label="Secondary sidebar">
        <div id="secondary-sidebar-resizer" class="sidebar-resizer" data-workbench-resize="secondary-sidebar" role="separator" aria-label="Resize secondary sidebar" aria-orientation="vertical" tabindex="0"></div>
        <nav id="secondary-view-tabs" class="secondary-view-tabs" role="tablist" aria-label="Secondary sidebar views" aria-orientation="horizontal"></nav>
        <div class="view-container secondary-view-container">
          <section id="library-navigation" class="library-navigation view-panel" aria-labelledby="library-heading">
            <div class="library-heading-row">
              <h2 id="library-heading">Shelf</h2>
              <strong id="library-name">Private Shelf</strong>
              <button id="open-reviewer" type="button" title="取り込む・確認する">取り込む・確認する</button>
              <button id="refresh-shelf" type="button" title="Sync Reviewer approvals into the selected Private Shelf">Shelfを更新</button>
              <button id="refresh-references" data-command-id="maginalia.references.refresh" type="button" disabled>Refresh References</button>
            </div>
            <form id="library-search-form" class="library-search-form">
              <label class="visually-hidden" for="library-query">Search quotations</label>
              <input id="library-query" type="search" autocomplete="off" placeholder="Search Private Shelf...">
              <button id="library-search" type="submit">Search</button>
            </form>
            <div id="unified-search-modes" class="unified-search-modes" role="group" aria-label="Search source">
              <button type="button" data-unified-search-mode="all" aria-pressed="true">All</button>
              <button type="button" data-unified-search-mode="shelf" aria-pressed="false">Shelf</button>
              <button type="button" data-unified-search-mode="project" aria-pressed="false">Project</button>
            </div>
            <fieldset id="shelf-search-fields" class="shelf-search-fields">
              <legend>Private Shelf fields</legend>
              <label><input type="checkbox" data-shelf-search-field="quote" checked> 引用文</label>
              <label><input type="checkbox" data-shelf-search-field="privateMemo" checked> 個人メモ</label>
              <label><input type="checkbox" data-shelf-search-field="title" checked> 書名</label>
              <label><input type="checkbox" data-shelf-search-field="authors" checked> 著者</label>
              <label><input type="checkbox" data-shelf-search-field="page" checked> ページ</label>
              <label><input type="checkbox" data-shelf-search-field="url" checked> URL</label>
            </fieldset>
            <p id="unified-search-status" class="unified-search-status" role="status" aria-live="polite"></p>
            <section id="project-search-panel" class="project-search-panel" aria-label="Project search results" hidden>
              <h3>PROJECT</h3>
              <ul id="project-search-results" class="project-search-results"></ul>
              <div id="project-search-preview" class="project-search-preview" hidden>
                <label for="project-search-source">Source Markdown</label>
                <textarea id="project-search-source" readonly spellcheck="false" aria-label="Read-only source Markdown"></textarea>
                <button id="project-search-insert" type="button">テキストとして挿入</button>
                <p id="project-search-error" class="library-error" role="alert" hidden></p>
              </div>
            </section>
            <p id="library-status" class="library-status" role="status" aria-live="polite">Search the selected Private Shelf.</p>
            <p id="library-error" class="library-error" role="alert" aria-live="assertive" hidden></p>
            <p id="references-status" class="references-status" data-state="empty" role="status" aria-live="polite">Open a document to refresh References.</p>
            <p id="references-unresolved" class="references-unresolved">Unresolved: 0</p>
            <ul id="library-results" class="library-results" aria-label="Private Shelf quotations"></ul>
          </section>
          <section id="menu-navigation" class="menu-navigation view-panel" aria-labelledby="menu-heading">
            <h2 id="menu-heading">Menu</h2>
            <section class="menu-section" aria-labelledby="menu-document-heading">
              <h3 id="menu-document-heading">Document</h3>
              <div class="document-controls">
                <button id="open-markdown" type="button">Open</button>
                <button id="save-markdown" data-command-id="maginalia.document.save" type="button" disabled>Save</button>
                <button id="export-markdown" data-command-id="maginalia.document.export" type="button" disabled>Export Markdown</button>
                <button id="export-pdf" data-command-id="maginalia.document.exportPdf" type="button" disabled>Export PDF</button>
                <button id="export-docx" data-command-id="maginalia.document.exportDocx" type="button" disabled>Export DOCX</button>
              </div>
              <span id="document-name" class="document-name">No document open</span>
              <span id="document-status" class="document-status" data-state="empty" role="status" aria-live="polite">No document open</span>
              <span id="export-status" class="export-status" data-state="empty" role="status" aria-live="polite">Open a document to export.</span>
              <details id="export-settings-panel" class="export-settings">
                <summary>Export settings</summary>
                <div class="export-settings-fields">
                  <label for="export-paper-size">Paper size</label>
                  <select id="export-paper-size">
                    ${EXPORT_PAPER_SIZES.map((size) => `<option value="${size}">${size.startsWith("B") ? `${size} (JIS)` : size}</option>`).join("")}
                  </select>
                  <label for="export-orientation">Orientation</label>
                  <select id="export-orientation">
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                  <label class="export-settings-check" for="export-paragraph-indent">
                    <input id="export-paragraph-indent" type="checkbox">
                    First-line indent (1 em)
                  </label>
                  <fieldset class="export-header-fields">
                    <legend>Header text</legend>
                    <label for="export-header-left">Left<input id="export-header-left" type="text" autocomplete="off"></label>
                    <label for="export-header-center">Center<input id="export-header-center" type="text" autocomplete="off"></label>
                    <label for="export-header-right">Right<input id="export-header-right" type="text" autocomplete="off"></label>
                  </fieldset>
                  <label class="export-settings-check" for="export-page-number">
                    <input id="export-page-number" type="checkbox">
                    Centered page number in footer
                  </label>
                </div>
              </details>
            </section>
            <section class="menu-section" aria-labelledby="menu-settings-heading">
              <h3 id="menu-settings-heading">設定</h3>
              <div class="document-controls">
                <button id="open-settings" type="button">設定</button>
                <button id="open-shortcut-settings" type="button">ショートカット設定</button>
                <button id="open-cheat-sheet" type="button">ショートカット一覧</button>
              </div>
            </section>
            <section class="menu-section" aria-labelledby="menu-workbench-heading">
              <h3 id="menu-workbench-heading">Workbench</h3>
              <div id="workbench-layout-controls" class="layout-controls" aria-label="Workbench layout controls">
                <button id="toolbar-toggle-activity-bar" data-workbench-command="maginalia.view.toggleActivityBar" type="button" title="Toggle activity bar">Activity</button>
                <button id="toolbar-toggle-primary-sidebar" data-workbench-command="maginalia.view.togglePrimarySidebar" type="button" title="Toggle primary sidebar">Primary</button>
                <button id="toolbar-toggle-secondary-sidebar" data-workbench-command="maginalia.view.toggleSecondarySidebar" type="button" title="Toggle secondary sidebar">Secondary</button>
                <button id="toolbar-toggle-editor-only" data-workbench-command="maginalia.view.toggleEditorOnly" type="button" title="Toggle editor-only mode">Editor only</button>
                <button id="open-mods-folder" type="button" title="Open the global Mods folder">Mods</button>
                <button id="reload-mods" type="button" title="Reload installed Mods">Reload Mods</button>
              </div>
              <span id="mods-status" class="mods-status" role="status" aria-live="polite">Mods not loaded</span>
            </section>
          </section>
          <section id="properties-panel" class="properties-panel view-panel" aria-labelledby="properties-heading">
            <div class="properties-heading-row">
              <h2 id="properties-heading">Properties</h2>
              <span id="properties-document-name" class="properties-document-name">No document open</span>
            </div>
            <form id="properties-form" class="properties-form">
              <label>Title<input id="properties-title" type="text" maxlength="240" required autocomplete="off"></label>
              <label>Author<input id="properties-author" type="text" autocomplete="off"></label>
              <label>Tags<textarea id="properties-tags" rows="3" placeholder="One tag per line"></textarea></label>
              <label>Document type
                <select id="properties-type">
                  <option value="memo">Memo</option>
                  <option value="draft">Draft</option>
                  <option value="body">Body</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>Created<input id="properties-created" type="date"></label>
              <button id="properties-apply" data-command-id="maginalia.document.applyProperties" type="submit" disabled>Apply</button>
              <button id="properties-reload" data-command-id="maginalia.document.reloadProperties" type="button" disabled>Reload Properties</button>
            </form>
            <p id="properties-status" class="properties-status" role="status" aria-live="polite">Open a document to edit its properties.</p>
            <p id="properties-error" class="properties-error" role="alert" hidden></p>
            <div class="properties-advanced">
              <strong>Advanced</strong>
              <button id="properties-open-source" data-command-id="maginalia.renderer.showEdit" type="button">Open raw source</button>
            </div>
          </section>
          <section id="mod-contributions" class="mod-contributions" aria-label="Mod contributions">
            <div id="mod-view-host"></div>
            <div id="mod-command-host"></div>
          </section>
        </div>
      </aside>
    </div>
  </main>
`;

if (firstRunMode) {
  document.body.classList.add("first-run-mode");
  requiredElement<HTMLElement>("#workbench").hidden = true;
  const setup = document.createElement("section");
  setup.id = "first-run-setup";
  setup.className = "first-run-setup";
  setup.setAttribute("aria-labelledby", "first-run-title");
  setup.style.setProperty("--brand-marker-image", `url("${brandMarkerUrl}")`);
  setup.innerHTML = `
    <div class="first-run-card">
      <img class="first-run-wordmark" src="${brandHeaderUrl}" alt="MAGINALIA Alpha2 Wild Berry">
      <h1 id="first-run-title" tabindex="-1">MAGINALIAを使う準備</h1>
      <p class="first-run-intro">作業場所と引用棚を確認します。選んだ場所にあるファイルや記録は、上書きしません。</p>
      <form id="first-run-form">
        <fieldset>
          <legend>Workdesk</legend>
          <label><input type="radio" name="workdeskMode" value="new" checked> 新しく作る</label>
          <label><input type="radio" name="workdeskMode" value="existing"> すでにあるデータを使う</label>
        </fieldset>
        <fieldset>
          <legend>Private Shelf</legend>
          <label><input type="radio" name="privateShelfMode" value="new" checked> 新しく作る</label>
          <label><input type="radio" name="privateShelfMode" value="existing"> すでにあるデータを使う</label>
        </fieldset>
        <label class="first-run-public"><input id="first-run-public" type="checkbox"> すでにあるPublic Shelfも使う</label>
        <button id="first-run-submit" class="first-run-primary" type="submit">保存場所を選んで設定する</button>
      </form>
      <div class="first-run-progress" aria-hidden="true" hidden><span></span></div>
      <div class="first-run-status-stage">
        <span class="first-run-status-paint" aria-hidden="true"></span>
        <p id="first-run-status" class="first-run-status" role="status" aria-live="polite">既定の保存先は「ドキュメント\\MAGINALIA\\Workdesk」と「ドキュメント\\MAGINALIA\\Private Shelf」です。</p>
      </div>
      <p id="first-run-error" class="first-run-error" role="alert" aria-live="assertive" hidden></p>
      <button id="first-run-open" class="first-run-primary" type="button" hidden>MAGINALIAを開く</button>
      <p class="first-run-data-note">設定を中断しても、選んだ場所のデータはそのまま残ります。</p>
    </div>`;
  app.append(setup);
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Renderer element was not found: ${selector}`);
  return element;
}

function initializeFirstRunScreen(): void {
  if (!firstRunMode) return;
  const form = requiredElement<HTMLFormElement>("#first-run-form");
  const status = requiredElement<HTMLElement>("#first-run-status");
  const error = requiredElement<HTMLElement>("#first-run-error");
  const submit = requiredElement<HTMLButtonElement>("#first-run-submit");
  const open = requiredElement<HTMLButtonElement>("#first-run-open");
  const progress = requiredElement<HTMLElement>(".first-run-progress");
  const api = window.maginalia;
  const showSetupError = (message: string) => {
    error.textContent = message;
    error.hidden = false;
  };
  const showComplete = (result?: Extract<FirstRunResult, { readonly kind: "completed" }>) => {
    form.hidden = true;
    submit.hidden = true;
    progress.hidden = false;
    progress.dataset.state = "complete";
    status.textContent = result
      ? `${result.projectTitle}を用意しました。続けてチュートリアルを開きます。`
      : "前回の設定が完了しています。チュートリアルを開きます。";
    open.hidden = false;
    open.focus({ preventScroll: true });
    if (result?.shelfSeed.conflicts.length) {
      showSetupError(`一部の引用資料は、同じIDで内容が異なるため追加しませんでした。既存の記録はそのままです。Private Shelfから内容を確認できます。（${result.shelfSeed.conflicts.length}件）`);
    }
  };

  if (typeof api.getFirstRunStatus !== "function"
    || typeof api.runFirstRunSetup !== "function"
    || typeof api.onFirstRunProgress !== "function") {
    showSetupError("設定画面を開けませんでした。MAGINALIAを終了して、もう一度起動してください。");
    submit.disabled = true;
    return;
  }
  api.onFirstRunProgress((event) => {
    status.textContent = event.message;
    progress.hidden = false;
    progress.dataset.state = "busy";
  });
  void api.getFirstRunStatus().then((current: FirstRunStatus) => {
    if (current.kind === "complete") showComplete();
    else if (current.kind === "error") showSetupError(current.message ?? "設定を読み取れませんでした。もう一度お試しください。");
    else if (current.stage !== "start") status.textContent = "前回の続きから設定します。選んだ場所のファイルは上書きしません。";
  }).catch(() => showSetupError("設定を読み取れませんでした。MAGINALIAを終了して、もう一度起動してください。"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const workdeskMode = formData.get("workdeskMode");
    const privateShelfMode = formData.get("privateShelfMode");
    if ((workdeskMode !== "new" && workdeskMode !== "existing")
      || (privateShelfMode !== "new" && privateShelfMode !== "existing")) {
      showSetupError("保存場所の選び方を確認してください。");
      return;
    }
    const choices: FirstRunChoices = {
      workdeskMode,
      privateShelfMode,
      registerPublicShelf: requiredElement<HTMLInputElement>("#first-run-public").checked,
    };
    error.hidden = true;
    submit.disabled = true;
    form.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = true; });
    progress.hidden = false;
    progress.dataset.state = "busy";
    status.textContent = "保存場所を確認しています";
    void api.runFirstRunSetup(choices).then((result: FirstRunResult) => {
      if (result.kind === "completed") {
        showComplete(result);
        return;
      }
      submit.disabled = false;
      form.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = false; });
      progress.hidden = true;
      progress.dataset.state = "idle";
      if (result.kind === "cancelled") {
        status.textContent = "設定を中断しました。選んだ場所のデータは変更していません。もう一度選べます。";
      } else {
        status.textContent = "設定を続けるには、保存場所を確認してください。";
        showSetupError(result.message);
      }
    }).catch(() => {
      submit.disabled = false;
      form.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = false; });
      progress.hidden = true;
      progress.dataset.state = "idle";
      status.textContent = "設定を続けるには、保存場所を確認してください。";
      showSetupError("設定を完了できませんでした。選んだ場所のデータはそのままです。もう一度お試しください。");
    });
  });

  open.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("setup");
    url.searchParams.set("tutorial-entry", "1");
    window.location.replace(url.href);
  });
  requiredElement<HTMLElement>("#first-run-title").focus();
}

initializeFirstRunScreen();

const activityViewButtonHost = requiredElement<HTMLElement>("#activity-view-buttons");
for (const view of WORKBENCH_VIEW_MANIFEST) {
  const button = document.createElement("button");
  button.id = view.activityButtonId;
  button.className = "activity-button";
  button.type = "button";
  button.dataset.workbenchView = view.id;
  button.dataset.workbenchViewRegion = view.defaultRegion;
  button.setAttribute("aria-pressed", "false");
  button.title = view.title;
  button.textContent = view.title;
  activityViewButtonHost.append(button);

  const panel = requiredElement<HTMLElement>(`#${view.panelId}`);
  panel.dataset.workbenchViewPanel = view.id;
}

const secondaryViewTabHost = requiredElement<HTMLElement>("#secondary-view-tabs");
const secondaryViewTabs: HTMLButtonElement[] = [];
for (const view of WORKBENCH_VIEW_MANIFEST.filter((candidate) => candidate.defaultRegion === "secondary-sidebar")) {
  const tab = document.createElement("button");
  tab.id = `secondary-tab-${view.id}`;
  tab.type = "button";
  tab.className = "secondary-view-tab";
  tab.dataset.secondaryViewTab = view.id;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", view.panelId);
  tab.setAttribute("aria-selected", "false");
  tab.tabIndex = -1;
  tab.textContent = view.title;
  secondaryViewTabHost.append(tab);
  secondaryViewTabs.push(tab);

  const panel = requiredElement<HTMLElement>(`#${view.panelId}`);
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tab.id);
  panel.tabIndex = 0;
}

const workbenchRoot = requiredElement<HTMLElement>(".workbench");
const workbenchToolbar = requiredElement<HTMLElement>("#workbench-toolbar");
const activityBar = requiredElement<HTMLElement>("#activity-bar");
const primarySidebar = requiredElement<HTMLElement>("#primary-sidebar");
const secondarySidebar = requiredElement<HTMLElement>("#secondary-sidebar");
const primarySidebarResizer = requiredElement<HTMLElement>("#primary-sidebar-resizer");
const secondarySidebarResizer = requiredElement<HTMLElement>("#secondary-sidebar-resizer");
const editorArea = requiredElement<HTMLElement>(".editor-area");
const documentTabs = requiredElement<HTMLElement>("#document-tabs");
const activityViewButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-workbench-view]")];
const viewPanels = [...document.querySelectorAll<HTMLElement>("[data-workbench-view-panel]")];
const togglePrimarySidebarButton = requiredElement<HTMLButtonElement>("#toggle-primary-sidebar");
const toggleSecondarySidebarButton = requiredElement<HTMLButtonElement>("#toggle-secondary-sidebar");
const toggleActivityBarButton = requiredElement<HTMLButtonElement>("#toggle-activity-bar");
const toggleEditorOnlyButton = requiredElement<HTMLButtonElement>("#toggle-editor-only");
const toolbarToggleActivityBarButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-activity-bar");
const toolbarTogglePrimarySidebarButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-primary-sidebar");
const toolbarToggleSecondarySidebarButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-secondary-sidebar");
const toolbarToggleEditorOnlyButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-editor-only");
const openModsFolderButton = requiredElement<HTMLButtonElement>("#open-mods-folder");
const reloadModsButton = requiredElement<HTMLButtonElement>("#reload-mods");
const modsStatus = requiredElement<HTMLElement>("#mods-status");
const openButton = requiredElement<HTMLButtonElement>("#open-markdown");
const openProjectButton = requiredElement<HTMLButtonElement>("#open-project");
const openProjectMenuItem = openProjectButton;
const openWorkdeskButton = requiredElement<HTMLButtonElement>("#open-workdesk");
const createWorkdeskButton = requiredElement<HTMLButtonElement>("#workdesk-create");
const workspaceRepairButton = requiredElement<HTMLButtonElement>("#workspace-repair");
const saveButton = requiredElement<HTMLButtonElement>("#save-markdown");
const exportButton = requiredElement<HTMLButtonElement>("#export-markdown");
const exportPdfButton = requiredElement<HTMLButtonElement>("#export-pdf");
const exportDocxButton = requiredElement<HTMLButtonElement>("#export-docx");
const exportPaperSizeInput = requiredElement<HTMLSelectElement>("#export-paper-size");
const exportOrientationInput = requiredElement<HTMLSelectElement>("#export-orientation");
const exportParagraphIndentInput = requiredElement<HTMLInputElement>("#export-paragraph-indent");
const exportHeaderLeftInput = requiredElement<HTMLInputElement>("#export-header-left");
const exportHeaderCenterInput = requiredElement<HTMLInputElement>("#export-header-center");
const exportHeaderRightInput = requiredElement<HTMLInputElement>("#export-header-right");
const exportPageNumberInput = requiredElement<HTMLInputElement>("#export-page-number");
const documentName = requiredElement<HTMLElement>("#document-name");
const documentStatus = requiredElement<HTMLElement>("#document-status");
const exportStatus = requiredElement<HTMLElement>("#export-status");
const workspaceLabel = requiredElement<HTMLElement>("#workspace-label");
const workspaceDocumentHeading = requiredElement<HTMLElement>("#workspace-document-heading");
const workspaceDocumentName = requiredElement<HTMLElement>("#workspace-document-name");
const workspaceError = requiredElement<HTMLElement>("#workspace-error");
const workspaceRecovery = requiredElement<HTMLElement>("#workspace-recovery");
const workspaceRecoveryTitle = requiredElement<HTMLElement>("#workspace-recovery-title");
const workspaceRecoveryMessage = requiredElement<HTMLElement>("#workspace-recovery-message");
const emptyDocumentMessage = requiredElement<HTMLElement>("#empty-document-message");
const explorerTree = requiredElement<HTMLUListElement>("#explorer-tree");
const workdeskProjectActions = requiredElement<HTMLElement>("#workdesk-project-actions");
const workdeskHomeButton = requiredElement<HTMLButtonElement>("#workdesk-home");
const projectPrimaryActions = requiredElement<HTMLElement>("#project-primary-actions");
const workdeskNewProjectButton = requiredElement<HTMLButtonElement>("#workdesk-new-project");
const workdeskRegisterProjectButton = requiredElement<HTMLButtonElement>("#workdesk-register-project");
const createProjectTitle = requiredElement<HTMLInputElement>("#create-project-title");
const createProjectButton = requiredElement<HTMLButtonElement>("#create-project");
const newFileForm = requiredElement<HTMLFormElement>("#new-file-form");
const newFileName = requiredElement<HTMLInputElement>("#new-file-name");
const newFileTitle = requiredElement<HTMLInputElement>("#new-file-title");
const newFileType = requiredElement<HTMLSelectElement>("#new-file-type");
const libraryName = requiredElement<HTMLElement>("#library-name");
const openReviewerButton = requiredElement<HTMLButtonElement>("#open-reviewer");
const refreshShelfButton = requiredElement<HTMLButtonElement>("#refresh-shelf");
const refreshReferencesButton = requiredElement<HTMLButtonElement>("#refresh-references");
const librarySearchForm = requiredElement<HTMLFormElement>("#library-search-form");
const libraryQuery = requiredElement<HTMLInputElement>("#library-query");
const librarySearchButton = requiredElement<HTMLButtonElement>("#library-search");
const libraryStatus = requiredElement<HTMLElement>("#library-status");
const libraryError = requiredElement<HTMLElement>("#library-error");
const referencesStatus = requiredElement<HTMLElement>("#references-status");
const referencesUnresolved = requiredElement<HTMLElement>("#references-unresolved");
const libraryResults = requiredElement<HTMLUListElement>("#library-results");
const propertiesForm = requiredElement<HTMLFormElement>("#properties-form");
const propertiesDocumentName = requiredElement<HTMLElement>("#properties-document-name");
const propertiesTitle = requiredElement<HTMLInputElement>("#properties-title");
const propertiesAuthor = requiredElement<HTMLInputElement>("#properties-author");
const propertiesTags = requiredElement<HTMLTextAreaElement>("#properties-tags");
const propertiesType = requiredElement<HTMLSelectElement>("#properties-type");
const propertiesCreated = requiredElement<HTMLInputElement>("#properties-created");
const propertiesApply = requiredElement<HTMLButtonElement>("#properties-apply");
const propertiesReload = requiredElement<HTMLButtonElement>("#properties-reload");
const propertiesStatus = requiredElement<HTMLElement>("#properties-status");
const propertiesError = requiredElement<HTMLElement>("#properties-error");
const propertiesOpenSource = requiredElement<HTMLButtonElement>("#properties-open-source");
const unifiedSearchModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-unified-search-mode]"));
const shelfSearchFieldset = requiredElement<HTMLFieldSetElement>("#shelf-search-fields");
const shelfSearchFieldInputs = Array.from(document.querySelectorAll<HTMLInputElement>("[data-shelf-search-field]"));
const unifiedSearchStatus = requiredElement<HTMLElement>("#unified-search-status");
const projectSearchPanel = requiredElement<HTMLElement>("#project-search-panel");
const projectSearchResults = requiredElement<HTMLUListElement>("#project-search-results");
const projectSearchPreview = requiredElement<HTMLElement>("#project-search-preview");
const projectSearchSource = requiredElement<HTMLTextAreaElement>("#project-search-source");
const projectSearchInsert = requiredElement<HTMLButtonElement>("#project-search-insert");
const projectSearchError = requiredElement<HTMLElement>("#project-search-error");
const modViewHost = requiredElement<HTMLElement>("#mod-view-host");
const modCommandHost = requiredElement<HTMLElement>("#mod-command-host");
const editorContainer = requiredElement<HTMLElement>("#editor");
const previewContainer = requiredElement<HTMLElement>("#markdown-preview");
const centralServiceView = requiredElement<HTMLElement>("#central-service-view");
const reviewerServiceSlot = requiredElement<HTMLElement>("#reviewer-service-slot");
const closeReviewerViewButton = requiredElement<HTMLButtonElement>("#close-reviewer-view");
const editorUtilityBar = requiredElement<HTMLElement>("#editor-utility-bar");
const editModeButton = requiredElement<HTMLButtonElement>("#document-edit-mode");
const previewModeButton = requiredElement<HTMLButtonElement>("#document-preview-mode");
const horizontalDirectionButton = requiredElement<HTMLButtonElement>("#document-horizontal");
const verticalDirectionButton = requiredElement<HTMLButtonElement>("#document-vertical");
const projectHeaderActions = requiredElement<HTMLElement>("#project-header-actions");
const projectNewButton = requiredElement<HTMLButtonElement>("#project-new");
const projectNewMenu = requiredElement<HTMLElement>("#project-new-menu");
const explorerNewFolderButton = requiredElement<HTMLButtonElement>("#explorer-new-folder");
const projectOverflowButton = requiredElement<HTMLButtonElement>("#project-overflow");
const projectOverflowMenu = requiredElement<HTMLElement>("#project-overflow-menu");
const openBundledManualButton = requiredElement<HTMLButtonElement>("#open-bundled-manual");
const projectCreateForm = requiredElement<HTMLFormElement>("#project-create-form");
const projectCreateCancelButton = requiredElement<HTMLButtonElement>("#project-create-cancel");
const projectInlineCreate = requiredElement<HTMLElement>("#project-inline-create");
const projectInlineDocumentType = requiredElement<HTMLElement>("#project-inline-document-type");
const projectCreateFileCancelButton = requiredElement<HTMLButtonElement>("#project-create-file-cancel");
const repositoryNavigation = requiredElement<HTMLElement>("#repository-navigation");
const repositoryKindLabel = requiredElement<HTMLElement>("#repository-kind-label");
const repositoryName = requiredElement<HTMLElement>("#repository-name");
const repositoryKind = requiredElement<HTMLSelectElement>("#repository-kind");
const repositoryTitle = requiredElement<HTMLInputElement>("#repository-title");
const createRepositoryButton = requiredElement<HTMLButtonElement>("#create-repository");
const openRepositoryButton = requiredElement<HTMLButtonElement>("#open-repository");
const activateRepositoryButton = requiredElement<HTMLButtonElement>("#activate-repository");
const repositoryStatus = requiredElement<HTMLElement>("#repository-status");
const repositoryError = requiredElement<HTMLElement>("#repository-error");
const recordRepositoryHistoryButton = requiredElement<HTMLButtonElement>("#record-repository-history");
const refreshRepositoryHistoryButton = requiredElement<HTMLButtonElement>("#refresh-repository-history");
const repositoryHistoryEntry = requiredElement<HTMLSelectElement>("#repository-history-entry");
const openRepositoryHistoryButton = requiredElement<HTMLButtonElement>("#open-repository-history");
const repositoryHistoryStatus = requiredElement<HTMLElement>("#repository-history-status");
const repositoryHistoryError = requiredElement<HTMLElement>("#repository-history-error");

let unifiedSearchMode: UnifiedSearchMode = "all";
let shelfSearchFields = new Set<CanonicalShelfSearchField>(DEFAULT_CANONICAL_SHELF_SEARCH_FIELDS);
let selectedProjectSearchText: string | null = null;
let projectSearchInsertionTarget: CapturedInsertionTarget | null = null;

const workbench = new WorkbenchCore(createLocalStorageLayoutStore());
for (const view of WORKBENCH_VIEW_MANIFEST) workbench.registerView(view);
const reviewerServiceDescriptor = CENTRAL_SERVICE_VIEW_MANIFEST.find((view) => view.id === "reviewer");
if (reviewerServiceDescriptor === undefined
  || reviewerServiceDescriptor.panelId !== centralServiceView.id
  || reviewerServiceDescriptor.slotId !== reviewerServiceSlot.id) {
  throw new Error("Reviewer central service View is not registered correctly.");
}
let reviewerServiceViewOpen = false;

function sendReviewerServiceBounds(): void {
  if (!reviewerServiceViewOpen || typeof window.maginalia.setReviewerViewBounds !== "function") return;
  const bounds = reviewerServiceSlot.getBoundingClientRect();
  if (bounds.width < 160 || bounds.height < 120) return;
  void window.maginalia.setReviewerViewBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  });
}

function setReviewerServiceViewOpen(open: boolean): void {
  reviewerServiceViewOpen = open;
  centralServiceView.hidden = !open;
  if (open) requestAnimationFrame(sendReviewerServiceBounds);
}
window.addEventListener("resize", sendReviewerServiceBounds);

function updateViewPanels(state: LayoutState): void {
  for (const panel of viewPanels) {
    const id = panel.dataset.workbenchViewPanel;
    const region = panel.closest<HTMLElement>("[data-workbench-region]")?.dataset.workbenchRegion as ViewRegion | undefined;
    const activeId = region === "secondary-sidebar" ? state.activeSecondaryView : state.activePrimaryView;
    const registered = region !== undefined && id !== undefined
      && workbench.getViews(region).some((view) => view.id === id);
    const active = registered && id === activeId;
    panel.classList.toggle("view-panel-active", active);
    panel.setAttribute("aria-hidden", String(!active));
  }
  for (const button of activityViewButtons) {
    const id = button.dataset.workbenchView;
    const region = button.dataset.workbenchViewRegion;
    const active = region === "secondary-sidebar"
      ? id === state.activeSecondaryView
      : id === state.activePrimaryView;
    button.classList.toggle("active", active);
    button.classList.toggle("active-primary", active && region === "primary-sidebar");
    button.classList.toggle("active-secondary", active && region === "secondary-sidebar");
    button.setAttribute("aria-pressed", String(active));
  }
  for (const tab of secondaryViewTabs) {
    const active = tab.dataset.secondaryViewTab === state.activeSecondaryView;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
}

function updateWorkbenchLayout(state: LayoutState): void {
  const editorOnly = workbench.isEditorOnly();
  workbenchRoot.dataset.editorOnly = String(editorOnly);
  workbenchRoot.style.setProperty("--primary-sidebar-width", `${state.primarySidebarWidth}px`);
  workbenchRoot.style.setProperty("--secondary-sidebar-width", `${state.secondarySidebarWidth}px`);
  primarySidebar.style.width = `${state.primarySidebarWidth}px`;
  secondarySidebar.style.width = `${state.secondarySidebarWidth}px`;
  primarySidebar.dataset.width = String(state.primarySidebarWidth);
  secondarySidebar.dataset.width = String(state.secondarySidebarWidth);
  primarySidebarResizer.setAttribute("aria-valuemin", "180");
  primarySidebarResizer.setAttribute("aria-valuemax", "800");
  primarySidebarResizer.setAttribute("aria-valuenow", String(state.primarySidebarWidth));
  secondarySidebarResizer.setAttribute("aria-valuemin", "180");
  secondarySidebarResizer.setAttribute("aria-valuemax", "800");
  secondarySidebarResizer.setAttribute("aria-valuenow", String(state.secondarySidebarWidth));
  activityBar.hidden = !state.activityBarVisible;
  primarySidebar.hidden = !state.primarySidebarVisible;
  secondarySidebar.hidden = !state.secondarySidebarVisible;
  workbenchToolbar.hidden = editorOnly;
  editorArea.dataset.editorOnly = String(editorOnly);
  toggleActivityBarButton.setAttribute("aria-pressed", String(state.activityBarVisible));
  togglePrimarySidebarButton.setAttribute("aria-pressed", String(state.primarySidebarVisible));
  toggleSecondarySidebarButton.setAttribute("aria-pressed", String(state.secondarySidebarVisible));
  toggleEditorOnlyButton.setAttribute("aria-pressed", String(editorOnly));
  toolbarToggleActivityBarButton.setAttribute("aria-pressed", String(state.activityBarVisible));
  toolbarTogglePrimarySidebarButton.setAttribute("aria-pressed", String(state.primarySidebarVisible));
  toolbarToggleSecondarySidebarButton.setAttribute("aria-pressed", String(state.secondarySidebarVisible));
  toolbarToggleEditorOnlyButton.setAttribute("aria-pressed", String(editorOnly));
  updateViewPanels(state);
}

const removeWorkbenchListener = workbench.onDidChange(updateWorkbenchLayout);

function showWorkbenchView(viewId: string): void {
  const registered = workbench.getViews("primary-sidebar").some((view) => view.id === viewId)
    || workbench.getViews("secondary-sidebar").some((view) => view.id === viewId);
  if (!registered) return;
  void executeCommand(`maginalia.view.show.${viewId}`);
}

for (const button of activityViewButtons) {
  button.addEventListener("click", () => {
    const viewId = button.dataset.workbenchView;
    if (viewId) showWorkbenchView(viewId);
  });
}
for (const [index, tab] of secondaryViewTabs.entries()) {
  tab.addEventListener("click", () => {
    const viewId = tab.dataset.secondaryViewTab;
    if (viewId) showWorkbenchView(viewId);
  });
  tab.addEventListener("keydown", (event) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % secondaryViewTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index + secondaryViewTabs.length - 1) % secondaryViewTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = secondaryViewTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = secondaryViewTabs[nextIndex];
    next?.focus();
    next?.click();
  });
}
togglePrimarySidebarButton.addEventListener("click", () => void executeCommand("maginalia.view.togglePrimarySidebar"));
toggleSecondarySidebarButton.addEventListener("click", () => void executeCommand("maginalia.view.toggleSecondarySidebar"));
toggleActivityBarButton.addEventListener("click", () => void executeCommand("maginalia.view.toggleActivityBar"));
toggleEditorOnlyButton.addEventListener("click", () => void executeCommand("maginalia.view.toggleEditorOnly"));
toolbarTogglePrimarySidebarButton.addEventListener("click", () => void executeCommand("maginalia.view.togglePrimarySidebar"));
toolbarToggleSecondarySidebarButton.addEventListener("click", () => void executeCommand("maginalia.view.toggleSecondarySidebar"));
toolbarToggleActivityBarButton.addEventListener("click", () => void executeCommand("maginalia.view.toggleActivityBar"));
toolbarToggleEditorOnlyButton.addEventListener("click", () => void executeCommand("maginalia.view.toggleEditorOnly"));

type ResizeSession = {
  region: ViewRegion;
  startX: number;
  startWidth: number;
};

function beginResize(region: ViewRegion, event: PointerEvent): void {
  if (event.button !== 0) return;
  const current = workbench.getState();
  const session: ResizeSession = {
    region,
    startX: event.clientX,
    startWidth: region === "primary-sidebar" ? current.primarySidebarWidth : current.secondarySidebarWidth
  };
  const onMove = (moveEvent: PointerEvent): void => {
    const delta = moveEvent.clientX - session.startX;
    const nextWidth = session.region === "primary-sidebar"
      ? session.startWidth + delta
      : session.startWidth - delta;
    workbench.resize(session.region, nextWidth);
  };
  const onEnd = (): void => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.body.classList.remove("resizing-sidebar");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onEnd);
  document.addEventListener("pointercancel", onEnd);
  document.body.classList.add("resizing-sidebar");
  event.preventDefault();
}

function resizeFromKeyboard(region: ViewRegion, event: KeyboardEvent): void {
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (direction === 0) return;
  const current = workbench.getState();
  const width = region === "primary-sidebar"
    ? current.primarySidebarWidth + direction * 16
    : current.secondarySidebarWidth - direction * 16;
  workbench.resize(region, width);
  event.preventDefault();
}

primarySidebarResizer.addEventListener("pointerdown", (event) => beginResize("primary-sidebar", event));
secondarySidebarResizer.addEventListener("pointerdown", (event) => beginResize("secondary-sidebar", event));
primarySidebarResizer.addEventListener("keydown", (event) => resizeFromKeyboard("primary-sidebar", event));
secondarySidebarResizer.addEventListener("keydown", (event) => resizeFromKeyboard("secondary-sidebar", event));

const view: WritingView = {
  setDocumentName(name: string): void {
    documentName.textContent = name;
  },
  setStatus(status: WritingStatus): void {
    documentStatus.dataset.state = status.kind;
    documentStatus.textContent = status.message;
  },
  setSaveEnabled(enabled: boolean): void {
    saveButton.disabled = !enabled;
  }
};

const surface = new MonacoMarkdownSurface(editorContainer);
const controller = new WritingController({
  api: window.maginalia,
  surface,
  view,
  confirmReplace: (displayName) => window.confirm(`Open another Markdown file? Unsaved changes to ${displayName} will be replaced.`)
});

const autosaveCoordinator = new AutosaveCoordinator({ writing: controller });
controller.setAutosaveCoordinator(autosaveCoordinator);

type PropertiesFormTarget = PropertiesTarget & {
  readonly fileName: string;
  readonly state: DocumentPropertiesState;
  readonly initial: DocumentProperties;
  readonly stale: boolean;
};

let propertiesFormTarget: PropertiesFormTarget | null = null;
let applyingProperties = false;

function activeProperties(): DocumentProperties {
  return {
    title: propertiesTitle.value,
    author: propertiesAuthor.value,
    tags: propertiesTags.value.split(/\r\n|\r|\n/gu),
    type: propertiesType.value as ProjectDocumentType,
    created: propertiesCreated.value
  };
}

function propertiesFormIsDirty(): boolean {
  const target = propertiesFormTarget;
  if (target === null || target.state.kind !== "ready") return false;
  const current = activeProperties();
  return current.title !== target.initial.title
    || current.author !== target.initial.author
    || current.type !== target.initial.type
    || current.created !== target.initial.created
    || current.tags.join("\n") !== target.initial.tags.join("\n");
}

function isLooseWorkdeskDocument(): boolean {
  const project = projectController?.getState().project;
  return project?.projectId === activeWorkdeskRootDocumentId();
}

function propertiesFormIsValid(): boolean {
  const target = propertiesFormTarget;
  if (target === null || target.stale || target.state.kind !== "ready") return false;
  if (isLooseWorkdeskDocument() && propertiesType.value === "body") return false;
  return propertiesForm.checkValidity() && propertiesTitle.value.trim().length > 0 && propertiesTitle.value.trim().length <= 240;
}

function updatePropertiesFormAvailability(): void {
  const target = propertiesFormTarget;
  const editable = target?.state.kind === "ready" && !target.stale;
  for (const element of [propertiesTitle, propertiesAuthor, propertiesTags, propertiesType, propertiesCreated]) element.disabled = !editable;
  const bodyOption = propertiesType.querySelector<HTMLOptionElement>('option[value="body"]');
  if (bodyOption) bodyOption.disabled = !editable || isLooseWorkdeskDocument();
  propertiesApply.disabled = !editable || !propertiesFormIsValid() || !propertiesFormIsDirty();
  propertiesReload.disabled = target?.stale !== true;
}

function refreshPropertiesPanel(): void {
  const current = controller.getDocumentState();
  const previous = propertiesFormTarget;
  if (previous !== null && !applyingProperties && shouldPreserveUnappliedPropertiesForm(previous, current, propertiesFormIsDirty(), previous.stale)) {
    propertiesFormTarget = { ...previous, stale: true };
    propertiesDocumentName.textContent = `${previous.fileName} (unapplied changes)`;
    propertiesStatus.textContent = "Your unapplied Properties changes are preserved, but the document changed. Reload Properties to discard them and read the current document.";
    propertiesError.hidden = true;
    updatePropertiesFormAvailability();
    return;
  }
  if (current === null) {
    propertiesFormTarget = null;
    propertiesDocumentName.textContent = "No document open";
    propertiesTitle.value = "";
    propertiesAuthor.value = "";
    propertiesTags.value = "";
    propertiesType.value = "other";
    propertiesCreated.value = "";
    propertiesStatus.textContent = "Open a document to edit its properties.";
    propertiesError.hidden = true;
    updatePropertiesFormAvailability();
    return;
  }
  const state = readDocumentProperties(current.currentText, current.displayName);
  propertiesFormTarget = {
    documentId: current.documentId,
    revision: current.revision,
    fileName: current.displayName,
    state,
    initial: state.kind === "ready" ? state.properties : { title: "", author: "", tags: [], type: "other", created: "" },
    stale: false
  };
  propertiesDocumentName.textContent = current.displayName;
  if (state.kind === "ready") {
    propertiesTitle.value = state.properties.title;
    propertiesAuthor.value = state.properties.author;
    propertiesTags.value = state.properties.tags.join("\n");
    propertiesType.value = state.properties.type;
    propertiesCreated.value = state.properties.created;
    propertiesStatus.textContent = "Edit supported document properties, then apply them to this Markdown file.";
    propertiesError.hidden = true;
  } else {
    propertiesTitle.value = "";
    propertiesAuthor.value = "";
    propertiesTags.value = "";
    propertiesType.value = "other";
    propertiesCreated.value = "";
    propertiesStatus.textContent = "Structured properties are unavailable for this document.";
    propertiesError.textContent = state.message;
    propertiesError.hidden = false;
  }
  updatePropertiesFormAvailability();
}

function reloadPropertiesPanel(): void {
  propertiesFormTarget = null;
  refreshPropertiesPanel();
  updateCommandContext();
}

// Declared before PreviewController's immediate initial render. Project
// activation fills it later; previews without a Project show safe fallbacks.
let projectController: ProjectNavigationController | undefined;
type ActiveWorkdesk = Extract<WorkdeskOpenResult, { readonly kind: "opened" }>;
let activeWorkdesk: ActiveWorkdesk | null = null;
let activeWorkdeskProjectIdentityId: string | null = null;
let activeWorkdeskRecovery: WorkdeskRecovered | null = null;
let primaryWorkdeskAvailable = false;
function activeWorkdeskRootDocumentId(): string | null {
  return activeWorkdesk?.workdesk.documentId ?? activeWorkdeskRecovery?.workdesk.documentId ?? null;
}
const rendererPreferences = createLocalStorageRendererPreferenceStore();
const settingsRegistry = new SettingsRegistry();
let currentExportPresentationSettings = rendererPreferences.load().exportPresentationSettings;
function restoreExportSettingsControls(): void {
  exportPaperSizeInput.value = currentExportPresentationSettings.paperSize;
  exportOrientationInput.value = currentExportPresentationSettings.orientation;
  exportParagraphIndentInput.checked = currentExportPresentationSettings.paragraphIndent;
  exportHeaderLeftInput.value = currentExportPresentationSettings.header.left;
  exportHeaderCenterInput.value = currentExportPresentationSettings.header.center;
  exportHeaderRightInput.value = currentExportPresentationSettings.header.right;
  exportPageNumberInput.checked = currentExportPresentationSettings.pageNumber;
}
restoreExportSettingsControls();
let previewMediaGeneration = 0;
let pendingPreviewEnterCaret: { readonly documentId: string; readonly revision: number; readonly offset: number } | null = null;
let activeTableTarget: ActiveTableTarget | null = null;
let commandContextReady = false;
let pendingSyncedBlockOpen: { readonly fileId: string; readonly target: string } | null = null;
let pendingSyncedBlockInsert: { readonly projectId: string; readonly target: string } | null = null;
const PROJECT_DOCUMENT_DRAG_MIME = "application/x-maginalia-project-document";

function projectDocumentDragData(projectId: string, target: string): string {
  return JSON.stringify({ projectId, target });
}

function readProjectDocumentDrag(dataTransfer: DataTransfer | null | undefined): { readonly projectId: string; readonly target: string } | null {
  const raw = dataTransfer?.getData(PROJECT_DOCUMENT_DRAG_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as { projectId?: unknown; target?: unknown };
    return typeof record.projectId === "string" && typeof record.target === "string"
      && record.projectId.length > 0 && record.target.length > 0
      ? { projectId: record.projectId, target: record.target }
      : null;
  } catch { return null; }
}

function requestSyncedBlockInsertion(candidate: { readonly projectId: string; readonly target: string }): void {
  pendingSyncedBlockInsert = candidate;
  updateCommandContext();
  void executeCommand("maginalia.syncedBlock.insertDocument").finally(() => {
    // A drag/source selection is a one-shot authoring intent. If command
    // context rejects it before the handler runs, do not let it survive for a
    // later document, selection, or palette invocation.
    if (pendingSyncedBlockInsert === candidate) {
      pendingSyncedBlockInsert = null;
      updateCommandContext();
    }
  });
}

const previewApi = typeof window.maginalia.resolveReferences === "function"
  ? { resolveReferences: (request: { readonly text: string }) => window.maginalia.resolveReferences(request) }
  : null;

function projectSyncedSourceResolver(
  projectId: string,
  onOpenSession?: (session: { readonly documentId: string; readonly revision: number; readonly currentText: string }) => void
): ((target: string) => Promise<SyncedBlockResolveResult>) | null {
  const navigation = projectController;
  const resolveFromProject = window.maginalia.resolveSyncedBlockDocument;
  if (navigation === undefined || typeof resolveFromProject !== "function") return null;
  return async (target: string): Promise<SyncedBlockResolveResult> => {
    const result = await resolveFromProject({ projectId, target });
    if (result.kind !== "resolved") return result;
    const sessionId = navigation.getSessionIdForFile(result.fileId);
    const open = sessionId === null ? null : controller.getDocumentState(sessionId);
    if (open !== null && typeof open.revision === "number") {
      onOpenSession?.({ documentId: open.documentId, revision: open.revision, currentText: open.currentText });
    }
    return { ...result, text: open?.currentText ?? result.text };
  };
}

/**
 * Produce one renderer-local composition snapshot for Preview, References,
 * and Export.  Open child sessions intentionally overlay disk through the
 * established Project resolver; no expanded content is written to a parent.
 */
async function composeSyncedMarkdown(source: string, documentId: string): Promise<ComposedMarkdownProjection> {
  const navigation = projectController;
  const project = navigation?.getState().project;
  const parentFileId = navigation?.getFileIdForSession(documentId) ?? null;
  const parent = parentFileId === null ? undefined : navigation?.getState().files.find((file) => file.fileId === parentFileId);
  const markers = scanSyncedBlockMarkers(source);
  if (markers.length === 0) return { kind: "composed", text: source };
  const openSources = new Map<string, { readonly revision: number; readonly currentText: string }>();
  const resolve = project === null || project === undefined ? null : projectSyncedSourceResolver(project.projectId, (open) => {
    openSources.set(open.documentId, { revision: open.revision, currentText: open.currentText });
  });
  if (project === null || project === undefined || parent === undefined || resolve === null) {
    return { kind: "blocked", message: "Synced Blocks require an open Project document." };
  }
  const composition = await resolveProjectComposition(source, { rootTarget: parent.displayName, resolve });
  const openSourcesCurrent = (): boolean => [...openSources].every(([sessionId, snapshot]) => {
    const current = controller.getDocumentState(sessionId);
    return current !== null && current.revision === snapshot.revision && current.currentText === snapshot.currentText;
  });
  if (!openSourcesCurrent()) {
    return { kind: "blocked", message: "Synced Block source changed during composition. Refresh and try again." };
  }
  const linear = linearizeProjectComposition(source, composition);
  return linear.kind === "linear"
    ? { kind: "composed", text: linear.markdown, isCurrent: openSourcesCurrent }
    : { kind: "blocked", message: linear.message };
}

function unresolvedPreviewQuoteMap(markers: readonly string[]): PreviewQuoteMap {
  const quotes = new Map<string, PreviewQuote>();
  for (const marker of markers) quotes.set(marker, { state: "unresolved", reason: "Quotation unresolved." });
  return quotes;
}

async function resolvePreviewQuotes(text: string): Promise<PreviewQuoteMap> {
  const markers = scanQuoteMarkersFromText(text);
  if (markers.length === 0) return new Map();
  if (previewApi === null) return unresolvedPreviewQuoteMap(markers);
  try {
    const result = await previewApi.resolveReferences({ text });
    if (result.kind === "error") return unresolvedPreviewQuoteMap(markers);
    const quotes = new Map(createPreviewQuoteMap(result.resolved, result.unresolved));
    for (const marker of markers) {
      if (!quotes.has(marker)) quotes.set(marker, { state: "unresolved", reason: "Quotation unresolved." });
    }
    return quotes;
  } catch {
    return unresolvedPreviewQuoteMap(markers);
  }
}

async function resolveSyncedPreviewBlocks(source: string, documentId: string): Promise<ReadonlyMap<string, PreviewSyncedBlock>> {
  const navigation = projectController;
  const project = navigation?.getState().project;
  const parentFileId = navigation?.getFileIdForSession(documentId) ?? null;
  const parent = parentFileId === null ? undefined : navigation?.getState().files.find((file) => file.fileId === parentFileId);
  const resolve = project === null || project === undefined ? null : projectSyncedSourceResolver(project.projectId);
  if (project === null || project === undefined || parent === undefined || resolve === null) return new Map();
  const composition = await resolveProjectComposition(source, { rootTarget: parent.displayName, resolve });
  const linkApi = typeof window.maginalia.resolveInternalLink === "function"
    ? { resolveInternalLink: (request: { readonly projectId: string; readonly target: string }) => window.maginalia.resolveInternalLink(request) }
    : null;
  const mediaApi = typeof window.maginalia.resolveProjectAsset === "function"
    ? { resolveProjectAsset: (request: { readonly projectId: string; readonly relativePath: string }) => window.maginalia.resolveProjectAsset(request) }
    : null;
  const hydrate = async (block: ComposedSyncedBlock): Promise<PreviewSyncedBlock> => {
    if (block.kind !== "resolved" || block.markdown === undefined) return block;
    // A child may carry its own previously generated list, but composition
    // presents one parent-derived result. Keep source unchanged and fail
    // closed rather than rendering ambiguous generated markers as prose.
    const stripped = stripDerivedReferenceList(block.markdown);
    if (stripped.kind === "conflict") {
      return { kind: "unresolved", marker: block.marker, target: block.target, message: "Synced document has an invalid derived reference list." };
    }
    const markdown = stripped.text;
    const children = new Map<string, PreviewSyncedBlock>();
    for (const [key, child] of block.children ?? []) children.set(key, await hydrate(child));
    const [internalLinks, media, quotes] = await Promise.all([
      resolvePreviewInternalLinks(linkApi, project.projectId, markdown),
      resolvePreviewMedia(mediaApi, project.projectId, markdown),
      resolvePreviewQuotes(markdown),
    ]);
    return { ...block, markdown, children, internalLinks, media, quotes };
  };
  const previewBlocks = new Map<string, PreviewSyncedBlock>();
  for (const [key, block] of composition.blocks) previewBlocks.set(key, await hydrate(block));
  return previewBlocks;
}
const previewController = new PreviewController({
  writing: controller,
  api: previewApi,
  preferences: rendererPreferences,
  view: {
    setPreviewState(state): void {
      const previewing = state.mode === "preview";
      // Every rendered projection owns fresh ephemeral table targets.
      if (activeTableTarget !== null) {
        activeTableTarget = null;
        if (commandContextReady) updateCommandContext();
      }
      editorContainer.hidden = previewing;
      previewContainer.hidden = !previewing;
      editModeButton.setAttribute("aria-pressed", String(!previewing));
      previewModeButton.setAttribute("aria-pressed", String(previewing));
      horizontalDirectionButton.setAttribute("aria-pressed", String(state.direction === "horizontal"));
      verticalDirectionButton.setAttribute("aria-pressed", String(state.direction === "vertical"));
      horizontalDirectionButton.disabled = state.document === null;
      verticalDirectionButton.disabled = state.document === null;
      if (!previewing) return;
      const text = state.document?.currentText ?? "";
      const generation = ++previewMediaGeneration;
      const projectId = projectController?.getState().project?.projectId ?? null;
      const restoreCaret = state.document !== null && pendingPreviewEnterCaret?.documentId === state.document.documentId
        && pendingPreviewEnterCaret.revision === state.document.revision ? pendingPreviewEnterCaret : null;
      const editable = state.document !== null && typeof state.document.revision === "number"
        ? {
          revision: state.document.revision,
          defaultLineEnding: controller.getLineEnding(),
          restoreCaretOffset: restoreCaret?.offset,
          onEdit: (request: { readonly revision: number; readonly range: { readonly start: number; readonly end: number }; readonly replacement: string }) =>
            controller.applySourceEdit({
              documentId: state.document!.documentId,
              revision: request.revision,
              range: request.range,
              replacement: request.replacement
            }),
          onEnterApplied: ({ revision, offset }: { readonly revision: number; readonly offset: number }) => {
            const current = controller.getDocumentState();
            const documentId = state.document!.documentId;
            if (current === null || current.documentId !== documentId || current.revision !== revision) return;
            const caret = { documentId, revision, offset };
            pendingPreviewEnterCaret = caret;
            if (!previewController.refreshAfterInlineEdit(documentId, revision) && pendingPreviewEnterCaret === caret) {
              pendingPreviewEnterCaret = null;
            }
          },
          onEnterFallback: () => {
            const current = controller.getDocumentState();
            if (current?.documentId !== state.document!.documentId) return;
            pendingPreviewEnterCaret = null;
            void executeCommand("maginalia.renderer.showEdit");
          },
          onEditingChange: (editing: boolean) => {
            if (editing) {
              previewController.setInlineEditing(state.document!.documentId);
              return;
            }
            queueMicrotask(() => {
              if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.classList.contains("markdown-preview-editable-text")) {
                previewController.setInlineEditing(null);
              }
            });
          },
          onSelectionChange: (range: { readonly start: number; readonly end: number } | null) => {
            controller.setExternalSelection(range);
            updateCommandContext();
          }
        }
        : undefined;
      const previewOptions = {
        editable,
        onTableTarget: (table: MarkdownTableTarget, cell: MarkdownTableCellTarget) => {
          const current = controller.getDocumentState();
          if (current === null || current.documentId !== state.document!.documentId || current.revision !== state.document!.revision) return;
          activeTableTarget = { documentId: state.document!.documentId, revision: state.document!.revision!, table, cell };
          updateCommandContext();
        },
        onTableCommand: (commandId: string, table: MarkdownTableTarget, cell: MarkdownTableCellTarget) => {
          if (mayDispatchTableTarget(activeTableTarget, controller.getDocumentState(), table, cell)) void executeCommand(commandId);
        },
        onOpenInternal: ({ fileId }: { readonly target: string; readonly fileId: string }) => {
          void executeCommand(OPEN_INTERNAL_LINK_COMMAND_ID, { fileId });
        },
        // Embed cards expose "Open externally"; the command revalidates the URL
        // in main before shell.openExternal (project-link-ipc).
        onOpenExternal: (url: string) => {
          void executeCommand(OPEN_EXTERNAL_LINK_COMMAND_ID, { url });
        },
        onOpenSyncedBlock: ({ fileId, target }: { readonly fileId: string; readonly target: string }) => {
          pendingSyncedBlockOpen = { fileId, target };
          updateCommandContext();
          void executeCommand("maginalia.syncedBlock.openSource");
        }
      };
      renderMarkdownPreview(previewContainer, text, state.quoteMap, state.direction, previewOptions);
      if (restoreCaret !== null && pendingPreviewEnterCaret === restoreCaret) pendingPreviewEnterCaret = null;
      const linkApi = typeof window.maginalia.resolveInternalLink === "function"
        ? { resolveInternalLink: (request: { readonly projectId: string; readonly target: string }) => window.maginalia.resolveInternalLink(request) }
        : null;
      const mediaApi = typeof window.maginalia.resolveProjectAsset === "function"
        ? { resolveProjectAsset: (request: { readonly projectId: string; readonly relativePath: string }) => window.maginalia.resolveProjectAsset(request) }
        : null;
      void Promise.all([
        resolvePreviewInternalLinks(linkApi, projectId, text),
        resolvePreviewMedia(mediaApi, projectId, text),
        state.document === null ? Promise.resolve(new Map<string, PreviewSyncedBlock>()) : resolveSyncedPreviewBlocks(text, state.document.documentId),
      ]).then(([internalLinks, media, syncedBlocks]) => {
        if (generation !== previewMediaGeneration || previewController.getMode() !== "preview" || previewController.isInlineEditing()) return;
        const current = controller.getDocumentState();
        if (current?.currentText !== text) return;
        renderMarkdownPreview(previewContainer, text, state.quoteMap, state.direction, { ...previewOptions, syncedBlocks }, internalLinks, media);
      }).catch(() => undefined);
    }
  }
});

horizontalDirectionButton.addEventListener("click", () => void executeCommand("maginalia.renderer.setHorizontal"));
verticalDirectionButton.addEventListener("click", () => void executeCommand("maginalia.renderer.setVertical"));

// Command surfaces are deliberately mounted beside the Workbench rather than
// into Monaco.  Later toolbar/menu contributions use this same registry.
const commandContext = new ContextKeyService();
const commandRegistry = new CommandRegistry();
let repositoryController: RepositoryController | undefined;
let repositoryReadyForHistory = false;
let modHostAvailable = false;
let openMarkdownAction: () => void | Promise<void> = () => undefined;
// Runtime availability published as context keys. These are hoisted so the
// context updater never reads controllers declared later in this module.
const commandAvailability = {
  documentOpen: false,
  export: false,
  shelf: false,
  projectSearch: false
};
let shelfResultSelected = false;
let refreshNativeApplicationMenu: () => void = () => undefined;
function executeCommand(id: string, args?: CommandArgs): Promise<void> {
  return commandRegistry.execute(id, commandContext.snapshot(), args).then((result) => {
    if (result.kind === "failed") {
      documentStatus.dataset.state = "error";
      documentStatus.textContent = `Command failed: ${result.error.message}`;
    }
  });
}
function requestProjectFileOpen(fileId: string): void {
  const project = projectController?.getState().project;
  if (!project || fileId.length === 0) return;
  void executeCommand("maginalia.project.openFile", { fileId });
}
commandRegistry.register({
  id: "maginalia.document.open",
  title: "ドキュメントを開く",
  description: "現在のワークスペースでドキュメントを開きます。",
  category: "ドキュメント",
  keywords: ["open", "document", "markdown", "file", "開く", "ドキュメント"],
  when: "document.openAvailable"
}, () => openMarkdownAction());
commandRegistry.register({
  id: "maginalia.project.openFile",
  title: "Open Project document",
  description: "Open a named document in the active Project through Project navigation.",
  category: "Project",
  keywords: ["open", "document", "file", "project", "開く", "ファイル"],
  when: "project.active"
}, async (args?: CommandArgs) => {
  const fileId = args?.fileId;
  if (fileId === undefined) {
    // Without a target (for example from the Palette) offer the name picker
    // instead of failing.
    commandPalette?.openQuickOpen();
    return;
  }
  const navigation = projectController;
  const state = navigation?.getState();
  if (navigation === undefined || !state?.project || !state.files.some((file) => file.fileId === fileId)) {
    throw new Error("The Project document is no longer available.");
  }
  await navigation.openFile(fileId);
});
commandRegistry.register({
  id: "maginalia.document.closeView",
  title: "アクティブなタブを閉じる",
  description: "Close the active document tab, preserving unsaved work through the existing close safeguard.",
  category: "Document",
  keywords: ["close", "tab", "document", "閉じる", "タブ"],
  when: "editor.hasDocument && document.hasMainView"
}, async () => {
  const current = controller.getDocumentState();
  const requestedViewId = pendingDocumentCloseViewId;
  pendingDocumentCloseViewId = null;
  const view = requestedViewId === null
    ? controller.getDocumentViews().find((candidate) => candidate.documentId === current?.documentId && candidate.region === "main")
    : controller.getDocumentViews().find((candidate) => candidate.instanceId === requestedViewId);
  if (!view || !(await closeDocumentTabView(view.instanceId))) throw new Error("The document tab remains open.");
});
for (const action of [
  { id: "maginalia.editor.findInDocument", title: "本文内を検索", action: "find" as const, keywords: ["find", "search", "本文", "検索"] },
  { id: "maginalia.editor.replaceInDocument", title: "本文内を置換", action: "findReplace" as const, keywords: ["replace", "find", "本文", "置換"] }
] as const) {
  commandRegistry.register({
    id: action.id,
    title: action.title,
    description: "Use Monaco's native find widget for the active source document.",
    category: "Editor",
    keywords: action.keywords,
    when: "editor.hasDocument && view.id == edit"
  }, () => {
    const opened = action.action === "find" ? controller.find() : controller.findReplace();
    if (!opened) throw new Error("本文内検索は編集画面で利用できます。");
  });
}
const updateCommandContext = (): void => {
  const current = controller.getDocumentState();
  const selection = controller.getSelection();
  const text = current?.currentText ?? "";
  const lineStart = text.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const lineEnd = text.indexOf("\n", selection.start);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const linkType = /\[\[[^\]]+\]\]/u.test(line)
    ? "internal"
    : /\[[^\]]+\]\((?:https?:\/\/)[^)]*\)/u.test(line) ? "external" : "none";
  const mediaMatch = /!\[\[[^\]]+\]\]|!\[[^\]]*\]\(([^)]+)\)/u.exec(line);
  const mediaType = mediaMatch === null
    ? "none"
    : /\.(?:mp4|webm|ogg)(?:[?#].*)?$/iu.test(mediaMatch[1] ?? line) ? "video" : "image";
  const tableCurrent = ownsCurrentTableTarget(activeTableTarget, current);
  const propertiesCurrent = ownsCurrentPropertiesTarget(propertiesFormTarget, current) && propertiesFormTarget?.stale !== true;
  const project = projectController?.getState().project;
  const activeProjectId = project?.projectId;
  const workdeskHomeActive = activeWorkdesk !== null
    && project?.projectId === activeWorkdesk.workdesk.documentId;
  const parentFileId = current === null ? null : projectController?.getFileIdForSession(current.documentId) ?? null;
  const insertionSelectionIsSafe = previewController.getMode() !== "preview" || controller.getExternalSelection() !== null;
  const repositoryState = repositoryController?.getState();
  const repositoryHistoryState = repositoryController?.getHistoryState();
  const repositoryBusy = repositoryState !== undefined
    && ["creating", "opening", "activating"].includes(repositoryState.status);
  const repositoryHistoryBusy = repositoryHistoryState !== undefined
    && ["loading", "recording", "opening"].includes(repositoryHistoryState.status);
  const syncedBlockInsertable = current !== null && project !== null && project !== undefined
    && parentFileId !== null && pendingSyncedBlockInsert !== null
    && pendingSyncedBlockInsert.projectId === project.projectId
    && validateSyncedBlockTarget(pendingSyncedBlockInsert.target) !== null
    && insertionSelectionIsSafe;
  commandContext.patch({
    "editor.hasDocument": current !== null,
    "editor.hasSelection": selection.start !== selection.end,
    "editor.blockType": /^#{1,6}\s/u.test(line) ? "heading" : line.startsWith("> ") ? "blockquote" : "paragraph",
    "editor.linkType": linkType,
    "editor.mediaType": mediaType,
    "editor.hasQuoteRef": line.includes("<!-- maginalia:quote-ref "),
    "table.active": tableCurrent,
    "table.headerCell": tableCurrent && activeTableTarget?.cell.rowKind === "header",
    "table.bodyCell": tableCurrent && activeTableTarget?.cell.rowKind === "body",
    "table.canDeleteRow": tableCurrent && activeTableTarget?.cell.rowKind === "body",
    "table.canDeleteColumn": tableCurrent && (activeTableTarget?.table.header.length ?? 0) > 1,
    "syncedBlock.available": current !== null && project !== null && project !== undefined && parentFileId !== null,
    "syncedBlock.insertable": syncedBlockInsertable,
    "syncedBlock.target": pendingSyncedBlockOpen !== null,
    "properties.available": propertiesCurrent,
    "properties.valid": propertiesCurrent && propertiesFormIsValid(),
    "properties.dirty": propertiesCurrent && propertiesFormIsDirty(),
    "properties.stale": propertiesFormTarget?.stale === true,
    "renderer.orientation": previewController.getDirection(),
    "document.type": "markdown",
    "view.id": previewController.getMode(),
    "document.hasMainView": current !== null && controller.getDocumentViews().some((view) => view.documentId === current.documentId && view.region === "main"),
    "project.creationActive": !projectCreateForm.hidden,
    "mods.available": modHostAvailable,
    "repository.available": repositoryController !== undefined,
    "repository.idle": repositoryController !== undefined && !repositoryBusy,
    "repository.activationAvailable": repositoryState?.repository !== null
      && repositoryState?.repository !== undefined
      && repositoryState.status !== "ready"
      && !repositoryBusy,
    "repository.historyAvailable": repositoryReadyForHistory && !repositoryBusy && !repositoryHistoryBusy,
    "repository.historySelected": repositoryReadyForHistory
      && repositoryHistoryState?.selectedHistoryId !== null
      && repositoryHistoryState?.selectedHistoryId !== undefined
      && !repositoryBusy
      && !repositoryHistoryBusy,
    "project.active": projectController?.getState().project != null,
    "workdesk.active": activeWorkdesk !== null,
    "workdesk.homeActive": workdeskHomeActive,
    "workdesk.homeAvailable": primaryWorkdeskAvailable
      && activeProjectId !== activeWorkdeskRootDocumentId(),
    "workdesk.childProject": activeWorkdesk !== null
      && project !== null
      && project !== undefined
      && project.projectId !== activeWorkdesk.workdesk.documentId,
    "explorer.creationActive": !projectInlineCreate.hidden && project !== null && project !== undefined,
    "document.multipleTabs": mainTabDocumentIds().length > 1,
    "document.openAvailable": commandAvailability.documentOpen,
    "export.available": commandAvailability.export,
    "link.externalAvailable": typeof window.maginalia.openExternalLink === "function",
    "shelf.available": commandAvailability.shelf,
    "shelf.resultSelected": shelfResultSelected,
    "projectSearch.available": commandAvailability.projectSearch,
    "projectSearch.hasSource": selectedProjectSearchText !== null
  });
  openProjectMenuItem.hidden = activeWorkdesk !== null;
  workdeskRegisterProjectButton.hidden = !workdeskHomeActive;
  openWorkdeskButton.textContent = activeWorkdesk !== null || activeWorkdeskRecovery !== null
    ? "Switch Workdesk…"
    : "Open Workdesk…";
  const actionLabel = workdeskHomeActive ? "More Workdesk actions" : "More Project actions";
  projectOverflowButton.setAttribute("aria-label", actionLabel);
  projectOverflowButton.title = actionLabel;
  projectOverflowMenu.setAttribute("aria-label", workdeskHomeActive ? "Workdesk actions" : "Project actions");
  workdeskNewProjectButton.disabled = !workdeskHomeActive || selectedProjectDocumentType !== null;
};
commandContextReady = true;
controller.onDocumentChange(() => {
  const current = controller.getDocumentState();
  if (!ownsCurrentTableTarget(activeTableTarget, current)) {
    activeTableTarget = null;
  }
  refreshPropertiesPanel();
  updateCommandContext();
});
// Composition must notice unsaved edits in inactive child tabs as well as the
// active parent document. This is renderer-only invalidation; sessions remain
// the single source of truth and no filesystem polling is introduced.
controller.onSessionChange(() => {
  if (previewController.getMode() === "preview" && !previewController.isInlineEditing()) previewController.refresh();
});
controller.onSelectionChange(() => updateCommandContext());
registerWorkbenchCommands(commandRegistry, workbench, WORKBENCH_VIEW_MANIFEST);
/**
 * Single writer for writing direction. Commands change the active direction
 * and remember it best-effort; the Settings entry requires persistence first
 * (PR #70 review) so a storage failure is reported there.
 */
function applyWritingDirection(direction: WritingDirection, requirePersistence: boolean): void {
  previewController.setDirection(direction, requirePersistence);
  updateCommandContext();
  settingsRegistry.refresh();
}
function requireExportController(): ExportController {
  if (exportController === undefined) throw new Error("書き出しはこの環境では利用できません。");
  return exportController;
}
registerCoreCommands(commandRegistry, {
  writing: controller,
  setPreviewDirection: (direction) => applyWritingDirection(direction, false),
  refreshReferences: () => referencesController?.refresh(),
  exportMarkdown: () => requireExportController().exportMarkdown(),
  exportPdf: () => requireExportController().exportPdf(),
  exportDocx: () => requireExportController().exportDocx(),
  saveDocument: () => controller.save(),
  contextKeys: commandContext
});

settingsRegistry.register({
  id: "maginalia.renderer.default-writing-direction",
  title: "文字方向",
  description: "ドキュメント表示に使う横書きまたは縦書きを選びます。",
  category: "表示",
  type: "enum",
  options: ["horizontal", "vertical"] as const,
  defaultValue: "horizontal",
  scope: "user",
  owner: "maginalia.core.renderer"
}, {
  getValue: () => rendererPreferences.load().defaultWritingDirection,
  setValue: (value: string) => applyWritingDirection(value === "vertical" ? "vertical" : "horizontal", true)
});

function updateExportPresentationSettings(patch: ExportPresentationPatch): void {
  const nextSettings = createExportPresentationSettings({
    ...currentExportPresentationSettings,
    ...patch,
    header: { ...currentExportPresentationSettings.header, ...patch.header }
  });
  if (rendererPreferences.save({ ...rendererPreferences.load(), exportPresentationSettings: nextSettings }) === false) {
    throw new Error("設定を保存できませんでした。保存先の空き容量とアクセス権を確認してください。");
  }
  currentExportPresentationSettings = nextSettings;
  restoreExportSettingsControls();
}

registerExportPresentationSettings(settingsRegistry, {
  get: () => currentExportPresentationSettings,
  update: updateExportPresentationSettings
});
commandRegistry.register({
  id: "maginalia.document.applyProperties",
  title: "Apply Properties",
  description: "Apply supported document properties to Markdown front matter.",
  category: "Document",
  keywords: ["properties", "title", "author", "tags", "metadata"],
  when: "properties.available && properties.valid && properties.dirty"
}, () => {
  const target = propertiesFormTarget;
  const current = controller.getDocumentState();
  if (!ownsCurrentPropertiesTarget(target, current) || target === null || current === null || target.stale || target.state.kind !== "ready") {
    refreshPropertiesPanel();
    return;
  }
  const result = applyDocumentProperties(current.currentText, target.fileName, activeProperties(), { allowBody: !isLooseWorkdeskDocument() });
  if (result.kind === "invalid") {
    propertiesError.textContent = result.message;
    propertiesError.hidden = false;
    updatePropertiesFormAvailability();
    updateCommandContext();
    return;
  }
  if (result.kind === "unchanged") return;
  const applied = (() => {
    applyingProperties = true;
    try {
      return controller.applySourceEdit({
        documentId: target.documentId,
        revision: target.revision,
        range: { start: result.edit.start, end: result.edit.end },
        replacement: result.edit.replacement
      });
    } finally {
      applyingProperties = false;
    }
  })();
  if (applied.kind !== "applied") {
    refreshPropertiesPanel();
    propertiesError.textContent = "The document changed before Properties could be applied. Review the current properties and try again.";
    propertiesError.hidden = false;
    return;
  }
  projectController?.updateActiveFileMetadata(target.documentId, { title: result.properties.title, documentType: result.properties.type });
});
commandRegistry.register({
  id: "maginalia.document.reloadProperties",
  title: "Reload Properties",
  description: "Discard unapplied Properties changes and reload the active document metadata.",
  category: "Document",
  keywords: ["properties", "reload", "discard", "metadata"],
  when: "properties.stale"
}, () => {
  if (propertiesFormTarget?.stale !== true) return;
  reloadPropertiesPanel();
});
commandRegistry.register({ id: "maginalia.editor.insertTable", title: "Insert Table", category: "Editor", keywords: ["table", "insert", "markdown"], when: "editor.hasDocument" }, () => {
  const target = controller.captureInsertionTarget();
  const documentState = controller.getDocumentState();
  if (target === null || documentState === null) {
    throw new Error("表を挿入する位置を特定できません。本文の挿入位置を選択してください。");
  }
  const inserted = insertMarkdownTable(documentState.currentText, target.range.start, target.range.end);
  const applied = controller.applySourceEdit({ ...target, replacement: inserted.replacement });
  if (applied.kind !== "applied") throw new Error("文書が変更されたため表を挿入できませんでした。もう一度お試しください。");
});
const runTableOperation = (operation: TableOperation): void => {
  const target = activeTableTarget;
  const documentState = controller.getDocumentState();
  if (target === null || !ownsCurrentTableTarget(target, documentState)) return;
  const replacement = transformMarkdownTable(target.table, target.cell.rowKind, target.cell.rowIndex, target.cell.columnIndex, operation);
  if (replacement === null) return;
  controller.applySourceEdit({ documentId: target.documentId, revision: target.revision, range: { start: target.table.start, end: target.table.end }, replacement });
  activeTableTarget = null;
  updateCommandContext();
};
for (const [id, operation, title] of [
  ["maginalia.table.addRowAbove", "addRowAbove", "Add Table Row Above"],
  ["maginalia.table.addRowBelow", "addRowBelow", "Add Table Row Below"],
  ["maginalia.table.deleteRow", "deleteRow", "Delete Table Row"],
  ["maginalia.table.addColumnBefore", "addColumnBefore", "Add Table Column Before"],
  ["maginalia.table.addColumnAfter", "addColumnAfter", "Add Table Column After"],
  ["maginalia.table.deleteColumn", "deleteColumn", "Delete Table Column"]
] as const) commandRegistry.register({
  id,
  title,
  category: "Table",
  keywords: ["table", "row", "column"],
  when: operation === "addRowAbove" ? "table.bodyCell"
    : operation === "deleteRow" ? "table.canDeleteRow"
      : operation === "deleteColumn" ? "table.canDeleteColumn"
        : "table.active"
}, () => runTableOperation(operation));
commandRegistry.register({
  id: "maginalia.syncedBlock.insertDocument",
  title: "Insert as Synced Block",
  description: "Insert a Project document as a synchronized composition reference.",
  category: "Project",
  keywords: ["synced", "block", "compose", "document"],
  when: "syncedBlock.insertable"
}, async () => {
  const pending = pendingSyncedBlockInsert;
  // Consume the renderer-local source candidate before asynchronous graph
  // work. Every rejection path therefore fails closed instead of retaining a
  // target that could later apply to another document.
  pendingSyncedBlockInsert = null;
  updateCommandContext();
  const project = projectController?.getState().project;
  const parent = controller.getDocumentState();
  if (pending === null || project === null || project === undefined || pending.projectId !== project.projectId || parent === null || validateSyncedBlockTarget(pending.target) === null) return;
  const parentFileId = projectController?.getFileIdForSession(parent.documentId) ?? null;
  const parentFile = parentFileId === null ? undefined : projectController?.getState().files.find((file) => file.fileId === parentFileId);
  // Preview insertion is legal only for a currently mapped Preview selection;
  // never fall back to a hidden Monaco selection.
  if (parentFile === undefined || (previewController.getMode() === "preview" && controller.getExternalSelection() === null)) return;
  const target = controller.captureInsertionTarget();
  const resolve = projectSyncedSourceResolver(project.projectId);
  if (target === null || resolve === null || !controller.isInsertionTargetCurrent(target)) return;
  let createsCycle = false;
  try { createsCycle = await wouldIntroduceSyncedBlockCycle(parentFile.displayName, pending.target, resolve); } catch { return; }
  if (!controller.isInsertionTargetCurrent(target)) return;
  if (createsCycle) {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = "That Synced Block would create a composition cycle.";
    return;
  }
  controller.applySourceEdit({ ...target, replacement: insertSyncedBlockMarker(parent.currentText, target.range.start, target.range.end, pending.target).replacement });
});
commandRegistry.register({
  id: "maginalia.syncedBlock.openSource",
  title: "Open Synced Block Source",
  description: "Open the Project document that owns this composed block.",
  category: "Project",
  keywords: ["synced", "block", "source", "open"],
  when: "syncedBlock.target"
}, async () => {
  const pending = pendingSyncedBlockOpen;
  const project = projectController?.getState().project;
  pendingSyncedBlockOpen = null;
  updateCommandContext();
  if (pending === null || project === null || project === undefined || typeof window.maginalia.openInternalLink !== "function") return;
  await projectController?.openInternalLink(pending.fileId, () => window.maginalia.openInternalLink!({ projectId: project.projectId, fileId: pending.fileId }));
});
commandRegistry.register({
  id: "maginalia.renderer.showEdit",
  title: "Show Markdown Edit",
  category: "Renderer",
  keywords: ["edit", "markdown", "source"]
}, () => {
  // Raw Edit immediately returns selection ownership to Monaco.
  controller.setExternalSelection(null);
  activeTableTarget = null;
  updateCommandContext();
  previewController.setMode("edit");
});
commandRegistry.register({
  id: "maginalia.renderer.showPreview",
  title: "Show Editable Preview",
  category: "Renderer",
  keywords: ["preview", "render", "edit"]
}, () => {
  previewController.setMode("preview");
  updateCommandContext();
});
editModeButton.addEventListener("click", () => void executeCommand("maginalia.renderer.showEdit"));
previewModeButton.addEventListener("click", () => void executeCommand("maginalia.renderer.showPreview"));
propertiesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void executeCommand("maginalia.document.applyProperties");
});
propertiesReload.addEventListener("click", () => void executeCommand("maginalia.document.reloadProperties"));
for (const field of [propertiesTitle, propertiesAuthor, propertiesTags, propertiesType, propertiesCreated]) {
  field.addEventListener("input", () => {
    propertiesError.hidden = true;
    updatePropertiesFormAvailability();
    updateCommandContext();
  });
  field.addEventListener("change", () => {
    updatePropertiesFormAvailability();
    updateCommandContext();
  });
}
propertiesOpenSource.addEventListener("click", () => void executeCommand("maginalia.renderer.showEdit"));
commandRegistry.register({
  id: "maginalia.shelf.openReviewer",
  title: "取り込む・確認する",
  category: "Shelf",
  keywords: ["reviewer", "import", "OCR", "quotation", "取り込む", "確認する"]
}, async () => {
  const openReviewerView = window.maginalia.openReviewerView;
  if (typeof openReviewerView !== "function") {
    libraryStatus.dataset.state = "error";
    libraryStatus.textContent = "Reviewer is unavailable.";
    libraryError.textContent = "Reviewer View is unavailable in this Desktop runtime.";
    libraryError.hidden = false;
    return;
  }
  const result = await openReviewerView();
  if (result.kind === "unavailable") {
    setReviewerServiceViewOpen(false);
    libraryStatus.dataset.state = "error";
    libraryStatus.textContent = "Reviewer unavailable.";
    libraryError.textContent = result.message;
    libraryError.hidden = false;
    return;
  }
  setReviewerServiceViewOpen(true);
  libraryStatus.dataset.state = "ready";
  libraryStatus.textContent = result.kind === "activated"
    ? "Reviewer is already open."
    : "Reviewer opened. Approve quotations there, then refresh Shelf.";
  libraryError.hidden = true;
});
commandRegistry.register({
  id: "maginalia.shelf.closeReviewer",
  title: "エディターに戻る",
  category: "Shelf",
  keywords: ["reviewer", "close", "return", "editor", "戻る"]
}, async () => {
  const closeReviewerView = window.maginalia.closeReviewerView;
  if (typeof closeReviewerView === "function") await closeReviewerView();
  setReviewerServiceViewOpen(false);
  libraryStatus.dataset.state = "ready";
  libraryStatus.textContent = "Reviewer closed. Shelf can be refreshed.";
  libraryError.hidden = true;
});
commandRegistry.register({
  id: "maginalia.shelf.refresh",
  title: "Refresh Shelf",
  category: "Shelf",
  keywords: ["reviewer", "approved", "quotation", "refresh"]
}, async () => {
  const refreshShelf = window.maginalia.refreshShelf;
  if (typeof refreshShelf !== "function") {
    libraryStatus.dataset.state = "error";
    libraryStatus.textContent = "Shelf refresh is unavailable.";
    libraryError.textContent = "Shelf refresh is unavailable in this Desktop runtime.";
    libraryError.hidden = false;
    return;
  }
  let result: Awaited<ReturnType<typeof refreshShelf>>;
  try {
    result = await refreshShelf();
  } catch (_error: unknown) {
    libraryStatus.dataset.state = "error";
    libraryStatus.textContent = "Shelf refresh failed.";
    libraryError.textContent = "The canonical Private Shelf could not be refreshed.";
    libraryError.hidden = false;
    return;
  }
  if (result.kind === "error") {
    libraryStatus.dataset.state = "error";
    libraryStatus.textContent = "Shelf refresh failed.";
    libraryError.textContent = result.message;
    libraryError.hidden = false;
    return;
  }

  await shelfController?.search(libraryQuery.value);
});
registerLinkCommands(commandRegistry, {
  getCaret: () => {
    const current = controller.getDocumentState();
    return current === null ? null : { text: current.currentText, offset: controller.getSelection().start };
  },
  resolveInternalTarget: async (target) => {
    const projectId = projectController?.getState().project?.projectId;
    if (projectId === undefined || typeof window.maginalia.resolveInternalLink !== "function") return null;
    const resolved = await window.maginalia.resolveInternalLink({ projectId, target });
    return resolved.kind === "resolved" ? resolved.fileId : null;
  },
  openInternalFile: async (fileId) => {
    const navigation = projectController;
    const projectId = navigation?.getState().project?.projectId;
    if (navigation === undefined || projectId === undefined || typeof window.maginalia.openInternalLink !== "function") {
      throw new Error("The internal link is no longer available.");
    }
    await navigation.openInternalLink(fileId, () => window.maginalia.openInternalLink!({ projectId, fileId }));
  },
  openExternal: typeof window.maginalia.openExternalLink === "function"
    ? (url) => window.maginalia.openExternalLink!({ url })
    : null
});
let commandPalette: CommandPalette | undefined;
commandRegistry.register({
  id: "maginalia.workbench.showCommandPalette",
  title: "Show Command Palette",
  description: "Find and run registered commands.",
  category: "Workbench",
  keywords: ["commands", "actions", "more"]
}, () => commandPalette?.isOpen() ? commandPalette.close() : commandPalette?.openCommandPicker());
commandRegistry.register({
  id: "maginalia.workbench.showQuickOpen",
  title: "Quick Open document",
  description: "Open a document by name from the active Project.",
  category: "Workbench",
  keywords: ["quick", "open", "file", "document", "Project"],
  when: "project.active"
}, () => commandPalette?.openQuickOpen());
commandRegistry.register({
  id: "maginalia.help.openManual",
  title: "取扱説明書を開く",
  description: "Open the bundled offline user guide.",
  category: "Help",
  keywords: ["manual", "guide", "help", "tutorial"]
}, async () => {
  const result = await window.maginalia.openBundledManual?.();
  if (result?.kind === "opened") {
    projectView.setProjectError(null);
  } else if (result?.kind === "missing") {
    projectView.setProjectError("取扱説明書はまだ用意されていません。チュートリアルの「マキナの置き手紙」から操作を確認できます。");
  } else {
    projectView.setProjectError("取扱説明書を開けませんでした。チュートリアルの「マキナの置き手紙」を開いてください。");
  }
});
// Collector save destination: the main process owns the confirmation and result
// dialogs and writes only the machine-local binding; no Shelf data is changed.
commandRegistry.register({
  id: "maginalia.collector.configureSaveDestination",
  title: "Collector の保存先を設定",
  description: "Use the configured Private Shelf as the MAGINALIA Collector save destination.",
  category: "Collector",
  keywords: ["collector", "browser", "extension", "save", "shelf", "保存先"]
}, async () => {
  await window.maginalia.configureCollectorSaveDestination?.();
});
commandRegistry.register({
  id: "maginalia.collector.clearSaveDestination",
  title: "Collector の保存先を解除",
  description: "Remove the MAGINALIA Collector save destination setting without changing Shelf data.",
  category: "Collector",
  keywords: ["collector", "browser", "extension", "unbind", "clear", "解除"]
}, async () => {
  await window.maginalia.clearCollectorSaveDestination?.();
});
commandRegistry.register({
  id: "maginalia.workdesk.open",
  title: "Open Workdesk",
  category: "Workdesk",
  keywords: ["desk", "workbench", "open"]
}, async () => {
  const api = getWorkdeskApi();
  if (!api) throw new Error("Workdesk is unavailable.");
  await openWorkdesk(api);
});
commandRegistry.register({
  id: "maginalia.workdesk.return",
  title: "Back to Workdesk",
  category: "Workdesk",
  keywords: ["back", "parent", "root", "navigation"],
  when: "project.active && workdesk.homeAvailable"
}, async () => {
  const desk = activeWorkdesk;
  const navigation = projectController;
  const childProjectId = navigation?.getState().project?.projectId;
  if (!navigation || !childProjectId || (desk && childProjectId === desk.workdesk.documentId)) return;
  const api = getWorkdeskApi();
  if (!api) {
    projectView.setProjectError("Workdesk is unavailable. Reload MAGINALIA to try again.");
    return;
  }
  const priorWorkdeskActivationKey = desk?.workdesk.workdeskIdentityId ?? activeWorkdeskRecovery?.workdesk.documentId ?? null;
  await restoreWorkdeskForReturn({
    restore: api.returnToWorkdesk,
    activate: async (result) => {
      // Restore is asynchronous. Do not navigate away from a different child
      // Project or a Workdesk that the user selected in the meantime.
      if ((activeWorkdesk?.workdesk.workdeskIdentityId ?? activeWorkdeskRecovery?.workdesk.documentId ?? null) !== priorWorkdeskActivationKey
        || projectController !== navigation
        || navigation.getState().project?.projectId !== childProjectId) return false;
      return activateWorkdesk(result);
    },
    rememberHome: () => rememberActiveWorkdeskContext({ kind: "home" }),
    showError: (message) => projectView.setProjectError(message)
  });
});
commandRegistry.register({
  id: "maginalia.workdesk.create",
  title: "Create Workdesk",
  category: "Workdesk",
  keywords: ["desk", "workbench", "new"]
}, async () => {
  const api = getWorkdeskApi();
  if (!api) throw new Error("Workdesk is unavailable.");
  const title = window.prompt("New Workdesk name");
  if (title === null || title.trim().length === 0) return;
  await openWorkdesk(api, title);
});
commandRegistry.register({
  id: "maginalia.workdesk.createProject",
  title: "New Project",
  category: "Workdesk",
  keywords: ["project", "new", "child"],
  when: "workdesk.homeActive"
}, async () => {
  const desk = activeWorkdesk;
  if (!desk || !getWorkdeskApi()) throw new Error("Open a Workdesk before creating a Project.");
  beginProjectCreation(true);
});
commandRegistry.register({
  id: "maginalia.project.create",
  title: "Create Project",
  description: "Create the Project currently described by the open Project form.",
  category: "Project",
  keywords: ["create", "new", "project"],
  when: "project.creationActive"
}, () => submitProjectCreation());
commandRegistry.register({
  id: "maginalia.workdesk.registerProject",
  title: "Add existing Project",
  category: "Workdesk",
  keywords: ["project", "register", "external"],
  when: "workdesk.homeActive"
}, async () => {
  const desk = activeWorkdesk;
  const api = getWorkdeskApi();
  if (!desk || !api) throw new Error("Open a Workdesk before registering a Project.");
  await openWorkdeskProjectResult(await api.registerWorkdeskProject({
    workdeskIdentityId: desk.workdesk.workdeskIdentityId
  }));
});
commandRegistry.register({
  id: "maginalia.workdesk.removeProject",
  title: "Remove Project from Workdesk",
  category: "Workdesk",
  keywords: ["project", "remove", "membership"],
  when: "workdesk.active",
  // Requires the registered Project to remove; the Explorer row passes it.
  visibility: "internal"
}, async (args?: CommandArgs) => {
  const desk = activeWorkdesk;
  const projectIdentityId = args?.projectIdentityId ?? null;
  const api = getWorkdeskApi();
  if (!desk || !api || projectIdentityId === null) throw new Error("The Workdesk Project is no longer available.");
  const project = desk.projects.find((candidate) => candidate.projectIdentityId === projectIdentityId);
  if (!project || !window.confirm(`Remove ${project.title} from this Workdesk? The Project files will remain where they are.`)) return;
  await openWorkdeskProjectResult(await api.removeWorkdeskProject({
    workdeskIdentityId: desk.workdesk.workdeskIdentityId,
    projectIdentityId
  }));
});
commandRegistry.register({
  id: "maginalia.workdesk.openProject",
  title: "Open registered Project",
  category: "Workdesk",
  keywords: ["project", "open", "registered"],
  when: "workdesk.active"
}, async (args?: CommandArgs) => {
  const desk = activeWorkdesk;
  const projectIdentityId = args?.projectIdentityId ?? null;
  const api = getWorkdeskApi();
  if (!desk || !api) throw new Error("Open a Workdesk to choose a registered Project.");
  if (projectIdentityId === null) {
    const target = explorerTree.querySelector<HTMLButtonElement>("[data-workdesk-project-shortcut]")
      ?? workdeskNewProjectButton;
    target.focus();
    return;
  }
  const workdeskIdentityId = desk.workdesk.workdeskIdentityId;
  const registeredProject = desk.projects.find((project) => project.projectIdentityId === projectIdentityId);
  if (!registeredProject || !registeredProject.available) {
    projectView.setProjectError("This registered Project is currently unavailable.");
    return;
  }
  if (activeWorkdeskProjectIdentityId === projectIdentityId) return;
  await loadAndActivateWorkdeskProject(async () => {
    const currentDesk = activeWorkdesk;
    if (!currentDesk || currentDesk.workdesk.workdeskIdentityId !== workdeskIdentityId) {
      projectView.setProjectError("The active Workdesk changed before the Project could be opened.");
      return null;
    }
    const currentRegistration = currentDesk.projects.find((project) => project.projectIdentityId === projectIdentityId);
    if (!currentRegistration || !currentRegistration.available) {
      projectView.setProjectError("This registered Project is currently unavailable.");
      return null;
    }
    return api.openWorkdeskProject({ workdeskIdentityId, projectIdentityId });
  });
});
commandRegistry.register({
  id: "maginalia.workdesk.copyToProject",
  title: "Copy Workdesk Document to Project",
  category: "Workdesk",
  keywords: ["copy", "project", "duplicate", "send"],
  when: "editor.hasDocument && workdesk.active"
}, async () => {
  const desk = activeWorkdesk;
  const api = getWorkdeskApi();
  const current = controller.getDocumentState();
  const navigation = projectController;
  const state = navigation?.getState();
  if (!desk || !api || !current || !navigation || state?.project?.projectId !== desk.workdesk.documentId) {
    throw new Error("Open a loose Workdesk document before copying it to a Project.");
  }
  const sourceFileId = navigation.getFileIdForSession(current.documentId);
  if (!sourceFileId) throw new Error("The active Workdesk document is no longer available.");
  const available = desk.projects.filter((project) => project.available);
  if (available.length === 0) throw new Error("Register or create an available Project before copying this document.");
  const choices = available.map((project, index) => `${index + 1}. ${project.title}`).join("\n");
  const selected = window.prompt(`Copy to Project:\n${choices}`, "1");
  if (selected === null) return;
  const destination = available[Number.parseInt(selected, 10) - 1];
  if (!destination || !/^\d+$/u.test(selected.trim())) throw new Error("Choose one available Project by number.");
  const sourceType = state.files.find((file) => file.fileId === sourceFileId)?.documentType ?? "other";
  // A legacy loose document may itself be `body`, but creating a body copy
  // must remain an affirmative choice rather than the implicit default.
  const selectedType = window.prompt(
    "Destination document type (memo, draft, other, or body)",
    sourceType === "body" ? "other" : sourceType
  );
  if (selectedType === null) return;
  if (selectedType !== "memo" && selectedType !== "draft" && selectedType !== "other" && selectedType !== "body") {
    throw new Error("Choose memo, draft, other, or body as the destination type.");
  }
  // Copy takes a disk snapshot. Flush first so the user's visible source is
  // the copied source, while keeping the source document itself untouched.
  const flushed = await autosaveCoordinator.flushDocument(current.documentId);
  if (flushed.kind === "error") throw new Error("The Workdesk document could not be saved before copying.");
  const result: WorkdeskCopyResult = await api.copyWorkdeskFileToProject({
    workdeskId: desk.workdesk.documentId,
    sourceFileId,
    projectIdentityId: destination.projectIdentityId,
    documentType: selectedType
  });
  if (result.kind !== "created") throw new Error(result.message);
  documentStatus.dataset.state = "saved";
  documentStatus.textContent = `Copied to ${destination.title}: ${result.file.displayName}`;
});
/** Shared by the Explorer and Workdesk "new document" commands. */
function beginDocumentCreationCommand(documentType: ProjectDocumentType): void {
  if (isLooseWorkdeskDocument() && documentType === "body") {
    projectView.setProjectError("Workdesk documents must be memo, draft, or other.");
    return;
  }
  beginProjectFileCreation(documentType);
}
for (const documentType of PROJECT_DOCUMENT_TYPES) {
  commandRegistry.register({
    id: `maginalia.explorer.new${documentType[0]!.toUpperCase()}${documentType.slice(1)}`,
    title: `New ${documentType} Markdown`,
    category: "Explorer",
    keywords: ["new", "markdown", documentType],
    when: "project.active"
  }, () => beginDocumentCreationCommand(documentType));
}
commandRegistry.register({
  id: "maginalia.explorer.newFolder",
  title: "New Folder",
  category: "Explorer",
  keywords: ["new", "folder", "directory"],
  when: "project.active"
}, async () => {
  const project = projectController?.getState().project;
  const api = getExplorerApi();
  if (!project || !api) throw new Error("Open a Project before creating a folder.");
  const name = window.prompt("New folder name");
  if (name === null) return;
  const result = await api.createExplorerFolder({ documentId: project.projectId, parentEntryId: selectedExplorerFolderId, name });
  if (result.kind === "error") {
    projectView.setProjectError(result.message);
    return;
  }
  selectedExplorerFolderId = result.entry.entryId;
  await refreshExplorer(project.projectId);
});
commandRegistry.register({
  id: "maginalia.explorer.createFile",
  title: "Create Markdown File",
  description: "Create the Markdown file from the active Explorer form.",
  category: "Explorer",
  keywords: ["create", "file", "markdown"],
  // Only while the inline "New Markdown" form is open; it supplies the name.
  when: "project.active && explorer.creationActive"
}, async () => {
  await createSelectedProjectFile();
});
commandRegistry.register({
  id: "maginalia.explorer.delete",
  title: "Delete Explorer File",
  category: "Explorer",
  keywords: ["delete", "remove", "trash"],
  when: "project.active"
}, async () => {
  await deleteSelectedExplorerFile();
});
for (const documentType of ["memo", "draft", "other"] as const) {
  commandRegistry.register({
    id: `maginalia.workdesk.new${documentType[0]!.toUpperCase()}${documentType.slice(1)}`,
    title: `New Workdesk ${documentType}`,
    category: "Workdesk",
    keywords: ["new", documentType],
    when: "editor.hasDocument && workdesk.active"
  }, () => beginDocumentCreationCommand(documentType));
}
commandRegistry.register({
  id: "maginalia.editor.importImage",
  title: "Import Image",
  category: "Editor",
  keywords: ["image", "asset", "file"],
  when: "editor.hasDocument"
}, () => chooseImageForImport());
for (const action of [
  { id: "maginalia.mods.openFolder", title: "Open Mods folder", keywords: ["mod", "folder", "open"] },
  { id: "maginalia.mods.reload", title: "Reload Mods", keywords: ["mod", "reload", "refresh"] }
] as const) {
  commandRegistry.register({
    id: action.id,
    title: action.title,
    category: "Mods",
    keywords: action.keywords,
    when: "mods.available"
  }, async () => {
    const mods = modController;
    if (!mods) throw new Error("Mod host is unavailable.");
    if (action.id === "maginalia.mods.openFolder") await mods.openFolder();
    else await mods.reload();
  });
}
let settingsCenter: SettingsCenter | null = null;
for (const { id, title, description, keywords, tab } of [
  {
    id: "maginalia.settings.open",
    title: "設定",
    description: "表示と書き出しの設定を開きます。",
    keywords: ["settings", "preferences", "configuration", "設定"],
    tab: "settings" as const
  },
  {
    id: "maginalia.settings.shortcuts",
    title: "ショートカット設定",
    description: "登録済みコマンドのショートカットを編集します。",
    keywords: ["keyboard", "shortcut", "keybinding", "settings", "キーボード", "ショートカット"],
    tab: "shortcuts" as const
  },
  {
    id: "maginalia.help.cheatSheet",
    title: "ショートカット一覧",
    description: "現在利用できるコマンドとショートカットを表示します。",
    keywords: ["help", "cheat sheet", "shortcut", "keyboard", "一覧", "ショートカット"],
    tab: "cheatsheet" as const
  }
] as const) {
  commandRegistry.register({ id, title, description, category: "設定", keywords }, () => settingsCenter?.open(tab));
}
const keybindingService = new KeybindingService(commandRegistry);
const settingsCommandsAllowedWhileModal = new Set([
  "maginalia.settings.open",
  "maginalia.settings.shortcuts",
  "maginalia.help.cheatSheet"
]);
settingsCenter = new SettingsCenter({
  settings: settingsRegistry,
  commands: commandRegistry,
  keybindings: keybindingService,
  getContext: () => commandContext.snapshot(),
  onOpenStateChanged: () => refreshNativeApplicationMenu(),
  onError: (message) => {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = `ショートカットを更新できませんでした: ${message}`;
  }
});
for (const [selector, commandId] of [
  ["#open-settings", "maginalia.settings.open"],
  ["#open-shortcut-settings", "maginalia.settings.shortcuts"],
  ["#open-cheat-sheet", "maginalia.help.cheatSheet"]
] as const) {
  requiredElement<HTMLButtonElement>(selector).addEventListener("click", () => void executeCommand(commandId));
}

let nativeMenuRefreshPending = false;
let lastNativeMenuSnapshot = "";
const refreshNativeMenuSoon = (): void => {
  if (nativeMenuRefreshPending) return;
  nativeMenuRefreshPending = true;
  queueMicrotask(() => {
    nativeMenuRefreshPending = false;
    const context = commandContext.snapshot();
    const snapshot = buildApplicationMenuSnapshot({
      commandIds: APPLICATION_MENU_COMMAND_IDS,
      enabledCommandIds: new Set(commandRegistry.list(context).map((command) => command.id)),
      modalOpen: settingsCenter?.isOpen() ?? false,
      allowedDuringModal: settingsCommandsAllowedWhileModal,
      getShortcut: (id) => {
        const keybinding = keybindingService.getBinding(id);
        return keybinding === null ? null : toPlatformKeybinding(keybinding);
      }
    });
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastNativeMenuSnapshot) return;
    lastNativeMenuSnapshot = serialized;
    void window.maginalia.updateApplicationMenu(snapshot).catch(() => undefined);
  });
};
refreshNativeApplicationMenu = refreshNativeMenuSoon;
commandRegistry.onDidChange(refreshNativeMenuSoon);
keybindingService.onDidChange(refreshNativeMenuSoon);
window.maginalia.onApplicationCommand((commandId) => {
  if (settingsCenter?.isOpen() && !settingsCommandsAllowedWhileModal.has(commandId)) return;
  void executeCommand(commandId);
});
refreshNativeMenuSoon();

commandPalette = new CommandPalette({
  registry: commandRegistry,
  getContext: () => commandContext.snapshot(),
  providers: {
    project: (query) => searchRegisteredWorkdeskProjects(activeWorkdesk?.projects ?? [], query),
    file: (query) => {
      const state = projectController?.getState();
      const project = state?.project;
      if (!project) return [];
      return searchCurrentProjectDocuments(project, state.files, query);
    }
  },
  prepareProviderResult: (providerId, resultId) => {
    if (providerId === "project") {
      return activeWorkdesk?.projects.some((candidate) => candidate.projectIdentityId === resultId && candidate.available) === true;
    }
    const state = projectController?.getState();
    return state?.project != null && state.files.some((file) => file.fileId === resultId);
  },
  getShortcut: (commandId) => {
    const binding = keybindingService.getBinding(commandId);
    return binding === null ? null : formatKeybinding(binding);
  },
  onError: (message) => {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = `Command failed: ${message}`;
  }
});

const utilityBar = new UtilityBar({
  root: editorUtilityBar,
  commandRegistry,
  getContext: () => commandContext.snapshot(),
  onError: (message) => {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = `Command failed: ${message}`;
  }
});

for (const contribution of [
  { id: "core.utility.undo", command: "maginalia.editor.undo", group: "history", label: "Undo", title: "Undo" },
  { id: "core.utility.redo", command: "maginalia.editor.redo", group: "history", label: "Redo", title: "Redo" },
  { id: "core.utility.paragraph", command: "maginalia.editor.setParagraph", group: "block", label: "Paragraph", title: "Set paragraph" },
  { id: "core.utility.heading1", command: "maginalia.editor.setHeading1", group: "block", label: "H1", title: "Set Heading 1" },
  { id: "core.utility.bold", command: "maginalia.editor.toggleBold", group: "inline", label: "B", title: "Toggle bold", when: "editor.hasSelection" },
  { id: "core.utility.italic", command: "maginalia.editor.toggleItalic", group: "inline", label: "I", title: "Toggle italic", when: "editor.hasSelection" },
  { id: "core.utility.code", command: "maginalia.editor.toggleInlineCode", group: "inline", label: "`", title: "Toggle inline code", when: "editor.hasSelection" },
  { id: "core.utility.bullets", command: "maginalia.editor.toggleBulletList", group: "lists", label: "•", title: "Toggle bulleted list" },
  { id: "core.utility.numbers", command: "maginalia.editor.toggleNumberedList", group: "lists", label: "1.", title: "Toggle numbered list" },
  { id: "core.utility.quote", command: "maginalia.editor.toggleBlockquote", group: "lists", label: ">", title: "Toggle blockquote" },
  { id: "core.utility.internal-link", command: "maginalia.editor.insertInternalLink", group: "insert", label: "Internal Link", title: "Insert internal link" },
  { id: "core.utility.external-link", command: "maginalia.editor.insertExternalLink", group: "insert", label: "External Link", title: "Insert external link" },
  { id: "core.utility.table", command: "maginalia.editor.insertTable", group: "insert", label: "Table", title: "Insert Markdown table" },
  { id: "core.utility.image", command: "maginalia.editor.importImage", group: "insert", label: "Image", title: "Import image asset" },
  { id: "core.utility.horizontal", command: "maginalia.renderer.setHorizontal", group: "presentation", label: "Horizontal", title: "Set horizontal writing" },
  { id: "core.utility.vertical", command: "maginalia.renderer.setVertical", group: "presentation", label: "Vertical", title: "Set vertical writing" },
  { id: "core.utility.more", command: "maginalia.workbench.showCommandPalette", group: "more", label: "More…", title: "Show command palette" }
] as const) utilityBar.register(contribution);

const contextMenuRegistry = new ContextMenuRegistry();
for (const contribution of [
  { id: "core.menu.caret.undo", location: "editor.caret", command: "maginalia.editor.undo", group: "history", order: 10 },
  { id: "core.menu.caret.redo", location: "editor.caret", command: "maginalia.editor.redo", group: "history", order: 20 },
  { id: "core.menu.caret.paragraph", location: "editor.caret", command: "maginalia.editor.setParagraph", group: "block", order: 10 },
  { id: "core.menu.caret.heading", location: "editor.caret", command: "maginalia.editor.setHeading1", group: "block", order: 20 },
  { id: "core.menu.caret.bullets", location: "editor.caret", command: "maginalia.editor.toggleBulletList", group: "block", order: 30 },
  { id: "core.menu.caret.numbered", location: "editor.caret", command: "maginalia.editor.toggleNumberedList", group: "block", order: 40 },
  { id: "core.menu.caret.quote", location: "editor.caret", command: "maginalia.editor.toggleBlockquote", group: "block", order: 50 },
  { id: "core.menu.caret.internal", location: "editor.caret", command: "maginalia.editor.insertInternalLink", group: "insert", order: 10 },
  { id: "core.menu.caret.external", location: "editor.caret", command: "maginalia.editor.insertExternalLink", group: "insert", order: 20 },
  { id: "core.menu.caret.image", location: "editor.caret", command: "maginalia.editor.importImage", group: "insert", order: 30 },
  { id: "core.menu.workdesk.copy", location: "editor.caret", command: "maginalia.workdesk.copyToProject", group: "workdesk", order: 10, when: "workdesk.active" },
  { id: "core.menu.selection.bold", location: "editor.selection", command: "maginalia.editor.toggleBold", group: "format", order: 10 },
  { id: "core.menu.selection.italic", location: "editor.selection", command: "maginalia.editor.toggleItalic", group: "format", order: 20 },
  { id: "core.menu.selection.code", location: "editor.selection", command: "maginalia.editor.toggleInlineCode", group: "format", order: 30 },
  { id: "core.menu.selection.internal", location: "editor.selection", command: "maginalia.editor.insertInternalLink", group: "insert", order: 10 },
  { id: "core.menu.selection.external", location: "editor.selection", command: "maginalia.editor.insertExternalLink", group: "insert", order: 20 },
  { id: "core.menu.selection.quote", location: "editor.selection", command: "maginalia.editor.toggleBlockquote", group: "block", order: 10 },
  { id: "core.menu.selection.bullets", location: "editor.selection", command: "maginalia.editor.toggleBulletList", group: "block", order: 20 },
  { id: "core.menu.quote.references", location: "editor.quote-ref", command: "maginalia.references.refresh", group: "quote", order: 10 },
  { id: "core.menu.link.internal.open", location: "editor.link.internal", command: OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID, group: "link", order: 10 },
  { id: "core.menu.link.internal.insert", location: "editor.link.internal", command: "maginalia.editor.insertInternalLink", group: "insert", order: 10 },
  { id: "core.menu.link.internal.external", location: "editor.link.internal", command: "maginalia.editor.insertExternalLink", group: "insert", order: 20 },
  { id: "core.menu.link.internal.undo", location: "editor.link.internal", command: "maginalia.editor.undo", group: "history", order: 10 },
  { id: "core.menu.link.internal.redo", location: "editor.link.internal", command: "maginalia.editor.redo", group: "history", order: 20 },
  { id: "core.menu.link.external.open", location: "editor.link.external", command: OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID, group: "link", order: 10 },
  { id: "core.menu.link.external.insert", location: "editor.link.external", command: "maginalia.editor.insertExternalLink", group: "insert", order: 10 },
  { id: "core.menu.link.external.internal", location: "editor.link.external", command: "maginalia.editor.insertInternalLink", group: "insert", order: 20 },
  { id: "core.menu.link.external.undo", location: "editor.link.external", command: "maginalia.editor.undo", group: "history", order: 10 },
  { id: "core.menu.link.external.redo", location: "editor.link.external", command: "maginalia.editor.redo", group: "history", order: 20 },
  { id: "core.menu.media.image", location: "editor.media", command: "maginalia.editor.importImage", group: "media", order: 10 }
] as const) contextMenuRegistry.register(contribution);

const contextMenuSurface = new ContextMenuSurface({
  menuRegistry: contextMenuRegistry,
  commandRegistry,
  getContext: () => commandContext.snapshot(),
  onError: (message) => {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = `Command failed: ${message}`;
  }
});

function contextMenuLocation(): string {
  const context = commandContext.snapshot();
  if (context["editor.mediaType"] !== "none") return "editor.media";
  if (context["editor.hasQuoteRef"] === true) return "editor.quote-ref";
  if (context["editor.linkType"] === "internal") return "editor.link.internal";
  if (context["editor.linkType"] === "external") return "editor.link.external";
  return context["editor.hasSelection"] === true ? "editor.selection" : "editor.caret";
}

function bindWorkbenchContextMenu(target: HTMLElement): void {
  target.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    contextMenuSurface.open(contextMenuLocation(), event.clientX, event.clientY, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  });
}

bindWorkbenchContextMenu(editorContainer);
bindWorkbenchContextMenu(previewContainer);
commandContext.onDidChange(() => {
  utilityBar.refresh();
  contextMenuSurface.refresh();
  settingsCenter?.refresh();
  refreshNativeApplicationMenu();
});
updateCommandContext();

// The bridge is populated only from the Mod host's validated declarative
// snapshot. It intentionally has no access to a Mod's code or renderer DOM.
const modContributionBridge = new ModContributionBridge({
  commands: commandRegistry,
  menus: contextMenuRegistry,
  utilityBar,
  invoke: async (modId, commandId) => modController?.invoke(modId, commandId) ?? null,
  onError: (message) => {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = `Mod contribution unavailable: ${message}`;
  }
});

editorContainer.addEventListener("dragover", (event) => {
  if (readProjectDocumentDrag(event.dataTransfer) !== null) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    return;
  }
  const files = event.dataTransfer?.files;
  if (files !== undefined && files.length > 0) event.preventDefault();
});

async function importImageFileIntoCurrentDocument(droppedFile: File): Promise<void> {
  const projectId = projectController?.getState().project?.projectId;
  if (projectId === undefined || typeof window.maginalia.importDroppedImageFile !== "function") {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = "Open a Project document before importing an image.";
    return;
  }
  const result = await importDroppedImageIntoDocument({
    writing: controller,
    importImage: () => {
      const optimize = rendererPreferences.load().optimizeDroppedImages;
      // Electron 32+ intentionally removed File.path. The preload helper
      // uses webUtils.getPathForFile, so renderer code never receives an
      // absolute filesystem path.
      return window.maginalia.importDroppedImageFile({ projectId, file: droppedFile, optimize });
    }
  });
  if (result.kind === "inserted") return;
  documentStatus.dataset.state = "error";
  documentStatus.textContent = result.message;
}

function chooseImageForImport(): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.addEventListener("change", () => {
      const file = input.files?.item(0);
      if (file !== null && file !== undefined) {
        void importImageFileIntoCurrentDocument(file).finally(resolve);
      } else {
        resolve();
      }
    }, { once: true });
    input.click();
  });
}

editorContainer.addEventListener("drop", (event) => {
  const projectDocument = readProjectDocumentDrag(event.dataTransfer);
  if (projectDocument !== null) {
    event.preventDefault();
    requestSyncedBlockInsertion(projectDocument);
    return;
  }
  const dropped = event.dataTransfer?.files.item(0);
  // Prevent Chromium from navigating the Workbench to a dropped local file.
  // The actual source path crosses only the bounded import IPC below.
  if (event.dataTransfer?.files.length) event.preventDefault();
  if (dropped === null || dropped === undefined) {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = "Open a Project document before dropping an image.";
    return;
  }
  void importImageFileIntoCurrentDocument(dropped);
});

previewContainer.addEventListener("dragover", (event) => {
  if (readProjectDocumentDrag(event.dataTransfer) === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
previewContainer.addEventListener("drop", (event) => {
  const projectDocument = readProjectDocumentDrag(event.dataTransfer);
  if (projectDocument === null) return;
  event.preventDefault();
  requestSyncedBlockInsertion(projectDocument);
});

async function flushAllAutosave(): Promise<boolean> {
  const results = await autosaveCoordinator.flushAll();
  return results.every((result) => result.kind === "saved" || result.kind === "clean");
}

// Main process shutdown uses this subscription as an explicit awaitable
// handshake. No beforeunload/unload save is attempted.
const removeAutosaveFlushRequest = window.maginalia.onAutosaveFlushRequest?.(
  () => flushAllAutosave()
);

let modController: ModController | undefined;

function renderModState(state: ModControllerState): void {
  modsStatus.dataset.state = state.busy ? "busy" : "ready";
  modsStatus.textContent = state.message;
  openModsFolderButton.disabled = state.busy;
  reloadModsButton.disabled = state.busy;

  modViewHost.replaceChildren();
  modCommandHost.replaceChildren();
  modContributionBridge.replace(state.snapshot);

  for (const registration of state.snapshot.contributions) {
    const contribution = registration.contribution;
    if (contribution.kind === "view") {
      const view = document.createElement("div");
      view.className = "mod-view-contribution";
      view.dataset.modId = registration.modId;
      view.dataset.modViewId = contribution.id;
      view.textContent = `${contribution.title} · ${contribution.region}`;
      modViewHost.append(view);
      continue;
    }

    if (contribution.kind !== "command") continue;
    const command = document.createElement("button");
    command.type = "button";
    command.className = "mod-command";
    command.dataset.modId = registration.modId;
    command.dataset.modCommandId = contribution.id;
    command.textContent = contribution.title;
    command.disabled = state.busy;
    command.addEventListener("click", () => {
      void commandRegistry.execute(contribution.id, commandContext.snapshot());
    });
    modCommandHost.append(command);
  }
}

const modView: { setModState(state: ModControllerState): void } = {
  setModState: renderModState
};

let draggedDocumentViewId: string | null = null;

async function closeDocumentTabView(instanceId: string): Promise<boolean> {
  return controller.closeDocumentView(instanceId, async (displayName) => decideDirtySwitch(
    { currentDisplayName: displayName, target: { kind: "manuscript", displayName: "another document tab" } },
    (message) => window.confirm(message)
  ));
}

function renderDocumentTabs(change: DocumentSessionChange): void {
  documentTabs.replaceChildren();
  const mainViews = change.views.filter((view) => view.region === "main" && view.groupId === "editor-group-1");
  for (const view of mainViews) {
    const session = change.sessions.find((candidate) => candidate.documentId === view.documentId);
    if (session === undefined) continue;
    const tab = document.createElement("div");
    tab.className = "document-tab";
    tab.dataset.documentTab = session.documentId;
    tab.dataset.documentViewId = view.instanceId;
    tab.setAttribute("role", "presentation");
    tab.draggable = true;
    tab.classList.toggle("active", change.activeDocumentId === session.documentId);
    tab.classList.toggle("dirty", session.currentText !== session.savedText);
    tab.addEventListener("dragstart", (event) => {
      draggedDocumentViewId = view.instanceId;
      tab.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", view.instanceId);
      const fileId = projectController?.getFileIdForSession(session.documentId) ?? null;
      const project = projectController?.getState().project;
      const file = fileId === null ? undefined : projectController?.getState().files.find((candidate) => candidate.fileId === fileId);
      if (project !== null && project !== undefined && file !== undefined) {
        event.dataTransfer?.setData(PROJECT_DOCUMENT_DRAG_MIME, projectDocumentDragData(project.projectId, file.displayName));
      }
      if (event.dataTransfer) event.dataTransfer.effectAllowed = file === undefined ? "move" : "copyMove";
    });
    tab.addEventListener("dragover", (event) => {
      if (draggedDocumentViewId === null || draggedDocumentViewId === view.instanceId) return;
      event.preventDefault();
      tab.classList.add("drag-over");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
    tab.addEventListener("drop", (event) => {
      event.preventDefault();
      tab.classList.remove("drag-over");
      const sourceViewId = draggedDocumentViewId ?? event.dataTransfer?.getData("text/plain") ?? "";
      draggedDocumentViewId = null;
      if (sourceViewId) controller.moveMainDocumentViewBefore(sourceViewId, view.instanceId);
    });
    tab.addEventListener("dragend", () => {
      draggedDocumentViewId = null;
      tab.classList.remove("dragging", "drag-over");
    });

    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "document-tab-label";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(change.activeDocumentId === session.documentId));
    activate.textContent = session.displayName;
    activate.title = session.displayName;
    if (session.currentText !== session.savedText) {
      const dirty = document.createElement("span");
      dirty.className = "document-tab-dirty";
      dirty.textContent = "●";
      dirty.setAttribute("aria-label", "unsaved changes");
      activate.append(dirty);
    }
    activate.addEventListener("click", () => {
      void executeCommand(ACTIVATE_DOCUMENT_COMMAND_ID, { documentId: session.documentId });
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "document-tab-close";
    close.setAttribute("aria-label", `Close ${session.displayName}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      pendingDocumentCloseViewId = view.instanceId;
      void executeCommand("maginalia.document.closeView");
    });
    tab.append(activate, close);
    documentTabs.append(tab);
  }
  documentTabs.hidden = mainViews.length === 0;
  if (commandContextReady) updateCommandContext();
}

/** Opaque document IDs of the central tab strip, in visual order. */
function mainTabDocumentIds(): readonly string[] {
  return controller.getDocumentViews()
    .filter((view) => view.region === "main" && view.groupId === "editor-group-1")
    .map((view) => view.documentId);
}

registerDocumentTabCommands(commandRegistry, {
  listTabDocumentIds: mainTabDocumentIds,
  getActiveDocumentId: () => controller.getDocumentState()?.documentId ?? null,
  activateDocument: (documentId) => controller.activateDocument(documentId)
});

controller.onSessionChange(renderDocumentTabs);

function renderWorkspaceState(state: WorkspaceNavigationState): void {
  workspaceLabel.textContent = "Document";
  workspaceDocumentName.textContent = state.document?.displayName ?? "No Document open";
  explorerTree.setAttribute("aria-label", "Document Explorer");
  explorerTree.replaceChildren();

  if (!state.document) {
    emptyDocumentMessage.textContent = "Open a Document folder to see its Markdown manuscripts.";
    emptyDocumentMessage.hidden = false;
    return;
  }
  if (state.manuscripts.length === 0) {
    emptyDocumentMessage.textContent = "This Document has no Markdown manuscripts in its root folder.";
    emptyDocumentMessage.hidden = false;
    return;
  }

  emptyDocumentMessage.hidden = true;
  for (const manuscript of state.manuscripts) {
    const item = document.createElement("li");
    item.className = "explorer-node";
    const row = document.createElement("div");
    row.className = "explorer-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "explorer-entry-button explorer-file-button";
    button.dataset.explorerFileId = manuscript.manuscriptId;
    button.dataset.explorerFileName = manuscript.displayName;
    button.title = manuscript.displayName;
    const icon = document.createElement("span");
    icon.className = "explorer-entry-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📄";
    const title = document.createElement("span");
    title.className = "explorer-entry-title";
    title.textContent = manuscript.displayName;
    button.append(icon, title);
    if (state.activeManuscriptId === manuscript.manuscriptId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    row.append(button);
    item.append(row);
    explorerTree.append(item);
  }
}

let selectedProjectDocumentType: ProjectDocumentType | null = null;
let selectedProjectFileId: string | null = null;
let selectedExplorerEntryId: string | null = null;
let selectedExplorerFolderId: string | null = null;
let explorerDocumentId: string | null = null;
let explorerEntries: readonly ExplorerEntry[] = [];
let pendingDocumentCloseViewId: string | null = null;
let projectCreationFromWorkdesk = false;

// The document controller can be empty during module construction. Hydrate the
// panel after all navigation ownership state exists, without mutating source.
queueMicrotask(() => {
  refreshPropertiesPanel();
  updateCommandContext();
});

function renderWorkdeskProjectNodes(projects: readonly WorkdeskProjectExplorerShortcut[]): void {
  for (const project of projects) {
    const item = document.createElement("li");
    item.className = "explorer-node workdesk-project-node";
    const row = document.createElement("div");
    row.className = "explorer-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "explorer-entry-button explorer-folder-button explorer-project-button workdesk-project-shortcut";
    button.setAttribute("aria-label", project.available
      ? `Open Project ${project.title}`
      : `Registered Project ${project.title}, unavailable on this PC. Select to retry opening.`);
    button.dataset.workdeskProjectShortcut = project.projectIdentityId;
    const icon = document.createElement("span");
    icon.className = "explorer-entry-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📁";
    const title = document.createElement("span");
    title.className = "explorer-entry-title";
    title.textContent = project.title;
    const type = document.createElement("small");
    type.className = "explorer-file-type";
    type.textContent = project.available ? "Project" : "Unavailable";
    button.append(icon, title, type);
    button.title = project.available ? `Project: ${project.title}` : `Project: ${project.title} (unavailable on this PC)`;
    button.addEventListener("click", () => {
      void executeCommand("maginalia.workdesk.openProject", { projectIdentityId: project.projectIdentityId });
    });
    const actions = document.createElement("div");
    actions.className = "explorer-row-actions";
    actions.setAttribute("aria-label", `Actions for ${project.title}`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "project-header-action explorer-row-action";
    remove.textContent = "Remove";
    remove.title = `Remove ${project.title} from this Workdesk`;
    remove.addEventListener("click", () => {
      void executeCommand("maginalia.workdesk.removeProject", { projectIdentityId: project.projectIdentityId });
    });
    actions.append(remove);
    row.append(button, actions);
    item.append(row);
    explorerTree.append(item);
  }
}

function appendExplorerSectionHeading(section: "projects" | "files"): void {
  const item = document.createElement("li");
  item.className = "explorer-section-heading";
  item.dataset.explorerSection = section;
  const heading = document.createElement("h3");
  heading.textContent = section.toUpperCase();
  item.append(heading);
  explorerTree.append(item);
}

function appendExplorerEmptyState(message: string): void {
  const item = document.createElement("li");
  item.className = "explorer-empty-entry";
  item.textContent = message;
  explorerTree.append(item);
}

function setWorkdeskDocumentTypes(enabled: boolean): void {
  for (const button of projectNewMenu.querySelectorAll<HTMLButtonElement>("button[data-document-type]")) {
    const isBody = button.dataset.documentType === "body";
    button.hidden = enabled && isBody;
    button.disabled = enabled && isBody;
  }
}

function entriesContainId(
  entries: readonly ExplorerEntry[],
  files: ProjectNavigationState["files"],
  entryId: string
): boolean {
  return entries.some((entry) => entry.entryId === entryId) || files.some((file) => file.fileId === entryId);
}

function renderProjectState(state: ProjectNavigationState): void {
  const desk = activeWorkdesk;
  const workdeskRoot = desk !== null && state.project?.projectId === desk.workdesk.documentId ? desk : null;
  const recovery = activeWorkdeskRecovery;
  const recoveryRoot = recovery !== null && state.project?.projectId === recovery.workdesk.documentId ? recovery : null;
  const isWorkdeskRoot = workdeskRoot !== null || recoveryRoot !== null;
  const workdeskChild = primaryWorkdeskAvailable && state.project !== null
    && state.project.projectId !== activeWorkdeskRootDocumentId();
  workspaceLabel.textContent = recoveryRoot || workdeskRoot ? "Workdesk" : "Project";
  workspaceDocumentHeading.textContent = isWorkdeskRoot ? "Workdesk Explorer" : "Project Explorer";
  workspaceDocumentName.textContent = recoveryRoot?.workdesk.title ?? workdeskRoot?.workdesk.title ?? state.project?.displayName ?? "No Project open";
  workspaceDocumentName.title = workspaceDocumentName.textContent;
  explorerTree.setAttribute("aria-label", isWorkdeskRoot ? "Workdesk Explorer" : "Project Explorer");
  setWorkdeskDocumentTypes(isWorkdeskRoot);
  workdeskProjectActions.hidden = projectPrimaryActions.hidden || workdeskRoot === null;
  workdeskRegisterProjectButton.hidden = workdeskRoot === null;
  workdeskHomeButton.disabled = isWorkdeskRoot || !primaryWorkdeskAvailable || state.project === null;
  workdeskHomeButton.setAttribute("aria-pressed", String(isWorkdeskRoot));
  workdeskHomeButton.classList.toggle("workbench-home-action-primary", workdeskChild);
  explorerTree.replaceChildren();
  updateProjectActionAvailability(state.project !== null);

  if (!state.project) {
    selectedProjectFileId = null;
    selectedExplorerEntryId = null;
    selectedExplorerFolderId = null;
    explorerDocumentId = null;
    explorerEntries = [];
    emptyDocumentMessage.textContent = desk || recovery
      ? "Open or create a Workdesk to see its loose Markdown documents."
      : "Open or create a Project folder to see its Markdown files.";
    emptyDocumentMessage.hidden = false;
    return;
  }
  if (explorerDocumentId !== state.project.projectId) {
    explorerDocumentId = state.project.projectId;
    explorerEntries = [];
    selectedExplorerFolderId = null;
    void refreshExplorer(state.project.projectId);
  }
  const selectedFileStillExists = state.files.some((file) => file.fileId === selectedProjectFileId);
  if (!selectedFileStillExists) selectedProjectFileId = state.activeFileId ?? state.files[0]?.fileId ?? null;
  if (selectedExplorerEntryId === null || !entriesContainId(explorerEntries, state.files, selectedExplorerEntryId)) {
    selectedExplorerEntryId = selectedProjectFileId;
  }
  const workdeskShortcuts = workdeskProjectShortcutsForRoot(workdeskRoot, state.project.projectId);
  if (isWorkdeskRoot) {
    appendExplorerSectionHeading("projects");
  }
  renderWorkdeskProjectNodes(workdeskShortcuts);
  if (isWorkdeskRoot && workdeskShortcuts.length === 0) {
    appendExplorerEmptyState(recoveryRoot
      ? "Repair Workdesk management information to use registered Projects."
      : "No Projects added yet.");
  }
  appendExplorerSectionHeading("files");
  emptyDocumentMessage.hidden = true;
  const entries = explorerDocumentId === state.project.projectId && explorerEntries.length > 0
    ? explorerEntries
    : state.files.map((file) => ({
      entryId: file.fileId,
      parentId: null,
      displayName: file.displayName,
      relativeName: file.displayName,
      kind: "markdown" as const
    }));
  if (entries.length === 0) {
    appendExplorerEmptyState(isWorkdeskRoot ? "No loose Workdesk files yet." : "No Project files yet.");
  }
  const childLists = new Map<string, HTMLUListElement>();
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "explorer-node";
    const parentList = entry.parentId === null ? explorerTree : childLists.get(entry.parentId);
    if (!parentList) continue;
    const row = document.createElement("div");
    row.className = "explorer-row";
    if (entry.kind === "folder") {
      item.dataset.explorerFolderId = entry.entryId;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "explorer-entry-button explorer-folder-button";
      button.title = entry.relativeName;
      button.classList.toggle("selected", selectedExplorerFolderId === entry.entryId);
      const icon = document.createElement("span");
      icon.className = "explorer-entry-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "📁";
      const title = document.createElement("span");
      title.className = "explorer-entry-title";
      title.textContent = entry.displayName;
      button.append(icon, title);
      button.addEventListener("click", () => {
        selectedExplorerFolderId = entry.entryId;
        selectedProjectFileId = null;
        selectedExplorerEntryId = null;
        projectView.setProjectState(projectController?.getState() ?? state);
      });
      row.append(button);
      const children = document.createElement("ul");
      children.className = "explorer-tree-children";
      children.setAttribute("aria-label", `${entry.displayName} contents`);
      item.append(row, children);
      childLists.set(entry.entryId, children);
      parentList.append(item);
      continue;
    }
    const file = entry.kind === "markdown"
      ? state.files.find((candidate) => candidate.fileId === entry.entryId)
      : undefined;
    if (!file) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "explorer-entry-button explorer-file-button explorer-ordinary-file";
      button.title = entry.relativeName;
      button.classList.toggle("selected", selectedExplorerEntryId === entry.entryId);
      const icon = document.createElement("span");
      icon.className = "explorer-entry-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "📄";
      const title = document.createElement("span");
      title.className = "explorer-entry-title";
      title.textContent = entry.displayName;
      button.append(icon, title);
      button.addEventListener("click", () => {
        selectedExplorerEntryId = entry.entryId;
        selectedProjectFileId = null;
        selectedExplorerFolderId = null;
        projectView.setProjectState(projectController?.getState() ?? state);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "project-header-action explorer-delete explorer-row-action";
      remove.textContent = "Delete";
      remove.title = `Delete ${entry.displayName}`;
      remove.addEventListener("click", () => {
        selectedExplorerEntryId = entry.entryId;
        selectedProjectFileId = null;
        void commandRegistry.execute("maginalia.explorer.delete", commandContext.snapshot());
      });
      const actions = document.createElement("div");
      actions.className = "explorer-row-actions";
      actions.setAttribute("aria-label", `Actions for ${entry.displayName}`);
      actions.append(remove);
      row.append(button, actions);
      item.append(row);
      parentList.append(item);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "explorer-entry-button explorer-file-button";
    button.dataset.explorerFileId = file.fileId;
    button.dataset.explorerFileName = file.displayName;
    button.title = file.displayName;
    button.draggable = true;
    button.addEventListener("dragstart", (event) => {
      const project = state.project;
      if (project === null) return;
      event.dataTransfer?.setData(PROJECT_DOCUMENT_DRAG_MIME, projectDocumentDragData(project.projectId, file.displayName));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
    });
    button.tabIndex = selectedProjectFileId === file.fileId ? 0 : -1;
    const icon = document.createElement("span");
    icon.className = "explorer-entry-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📄";
    const title = document.createElement("span");
    title.className = "explorer-entry-title";
    title.textContent = file.displayName.split("/").at(-1) ?? file.displayName;
    const type = document.createElement("small");
    type.className = "explorer-file-type";
    type.textContent = file.documentType;
    button.append(icon, title, type);
    button.classList.toggle("selected", selectedProjectFileId === file.fileId);
    if (state.activeFileId === file.fileId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    const insertSynced = document.createElement("button");
    insertSynced.type = "button";
    insertSynced.className = "project-header-action explorer-row-action";
    insertSynced.textContent = "Sync";
    insertSynced.title = `Insert ${file.displayName} as a Synced Block`;
    insertSynced.addEventListener("click", () => {
      const project = state.project;
      if (project !== null) requestSyncedBlockInsertion({ projectId: project.projectId, target: file.displayName });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "project-header-action explorer-delete explorer-row-action";
    remove.textContent = "Delete";
    remove.title = `Delete ${file.displayName}`;
    remove.addEventListener("click", () => {
      selectedProjectFileId = file.fileId;
      selectedExplorerEntryId = file.fileId;
      void commandRegistry.execute("maginalia.explorer.delete", commandContext.snapshot());
    });
    const actions = document.createElement("div");
    actions.className = "explorer-row-actions";
    actions.setAttribute("aria-label", `Actions for ${file.title}`);
    actions.append(insertSynced, remove);
    row.append(button, actions);
    item.append(row);
    parentList.append(item);
  }
}

function updateProjectActionAvailability(hasProject: boolean): void {
  projectNewButton.disabled = !hasProject || selectedProjectDocumentType !== null;
  projectOverflowButton.disabled = selectedProjectDocumentType !== null;
}

function updateSelectedProjectFile(buttons: readonly HTMLButtonElement[], fileId: string | null): void {
  selectedProjectFileId = fileId;
  selectedExplorerEntryId = fileId;
  for (const candidate of buttons) {
    candidate.classList.toggle("selected", candidate.dataset.explorerFileId === fileId);
  }
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    .filter((button) => !button.hidden && !button.disabled);
}

function focusMenuItem(menu: HTMLElement, index: number): void {
  const items = menuItems(menu);
  if (items.length === 0) return;
  const bounded = (index + items.length) % items.length;
  items[bounded]?.focus();
}

function setProjectMenuOpen(menu: HTMLElement, trigger: HTMLButtonElement, open: boolean): void {
  menu.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
}

function setWorkspaceRecoveryNotice(notice: FolderIdentityRecoveryNotice | null): void {
  workspaceRecovery.hidden = notice === null;
  workspaceRecoveryTitle.textContent = notice?.title ?? "";
  workspaceRecoveryMessage.textContent = notice?.message ?? "";
  workspaceRepairButton.hidden = notice?.canRepairWorkdesk !== true;
}

function cancelProjectFileCreation(restoreFocus = true): void {
  projectInlineCreate.hidden = true;
  selectedProjectDocumentType = null;
  updateProjectActionAvailability(projectController?.getState().project !== null);
  if (commandContextReady) updateCommandContext();
  newFileForm.reset();
  if (restoreFocus) projectNewButton.focus();
}

function cancelProjectCreation(restoreFocus = true): void {
  const focusTarget = projectCreationFromWorkdesk ? workdeskNewProjectButton : projectNewButton;
  projectCreateForm.hidden = true;
  createProjectTitle.value = "";
  projectCreationFromWorkdesk = false;
  updateCommandContext();
  if (restoreFocus) focusTarget.focus();
}

function beginProjectCreation(fromWorkdesk: boolean): void {
  projectCreationFromWorkdesk = fromWorkdesk;
  createProjectTitle.value = "";
  projectCreateForm.hidden = false;
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
  updateCommandContext();
  createProjectTitle.focus();
}

function beginProjectFileCreation(documentType: ProjectDocumentType): void {
  selectedProjectDocumentType = documentType;
  newFileType.value = documentType;
  newFileTitle.value = "";
  newFileName.value = "";
  projectInlineDocumentType.textContent = documentType;
  projectInlineCreate.hidden = false;
  updateProjectActionAvailability(projectController?.getState().project !== null);
  if (commandContextReady) updateCommandContext();
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
  newFileTitle.focus();
}

async function createSelectedProjectFile(): Promise<void> {
  const navigation = projectController;
  if (!navigation) return;
  const documentType = selectedProjectDocumentType ?? newFileType.value as ProjectDocumentType;
  const fileName = selectedProjectDocumentType
    ? createProjectFileName(
      newFileTitle.value,
      selectedProjectDocumentType,
      navigation.getState().files.map((file) => file.displayName)
    )
    : newFileName.value;
  newFileName.value = fileName;
  if (activeWorkdesk && isLooseWorkdeskDocument()) {
    const desk = activeWorkdesk;
    if (documentType === "body") {
      projectView.setProjectError("Workdesk documents must be memo, draft, or other.");
      return;
    }
    const api = getWorkdeskApi();
    if (!api) {
      projectView.setProjectError("Workdesk is unavailable. Reload MAGINALIA to try again.");
      return;
    }
    try {
      const result = await api.createWorkdeskFile({
        workdeskId: desk.workdesk.documentId,
        fileName,
        title: newFileTitle.value,
        documentType,
        parentEntryId: selectedExplorerFolderId
      });
      if (result.kind === "created") {
        await navigation.applyCreatedFile(result);
        await refreshExplorer(desk.workdesk.documentId);
        cancelProjectFileCreation(false);
      } else if (result.kind === "error") {
        projectView.setProjectError(result.message);
      }
    } catch {
      projectView.setProjectError("The Workdesk Markdown file could not be created.");
    }
    return;
  }
  await navigation.createFile({ fileName, title: newFileTitle.value, documentType, parentEntryId: selectedExplorerFolderId });
  if (selectedProjectDocumentType && navigation.getState().files.some((file) => file.displayName === fileName || file.displayName.endsWith(`/${fileName}`))) {
    cancelProjectFileCreation(false);
  }
  const project = navigation.getState().project;
  if (project) await refreshExplorer(project.projectId);
}

function bindProjectFileKeyboard(): void {
  const buttons = [...explorerTree.querySelectorAll<HTMLButtonElement>("button[data-explorer-file-id]")];
  buttons.forEach((button, index) => {
    button.addEventListener("focus", () => {
      updateSelectedProjectFile(buttons, button.dataset.explorerFileId ?? null);
      buttons.forEach((candidate) => { candidate.tabIndex = candidate === button ? 0 : -1; });
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = buttons.find((candidate) => candidate.dataset.explorerFileId === selectedProjectFileId) ?? button;
        selected.click();
        return;
      }
      const nextIndex = event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
      if (nextIndex === undefined) return;
      event.preventDefault();
      buttons.forEach((candidate) => { candidate.tabIndex = -1; });
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, nextIndex))];
      if (next) {
        updateSelectedProjectFile(buttons, next.dataset.explorerFileId ?? null);
        next.tabIndex = 0;
        next.focus();
      }
    });
  });
}

function bindProjectMenuKeyboard(menu: HTMLElement, trigger: HTMLButtonElement): void {
  menu.addEventListener("keydown", (event) => {
    const items = menuItems(menu);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(menu, currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(menu, currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(menu, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(menu, items.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setProjectMenuOpen(menu, trigger, false);
      trigger.focus();
    } else if (event.key === "Tab") {
      setProjectMenuOpen(menu, trigger, false);
    }
  });
}

function bindProjectMenuTriggerKeyboard(menu: HTMLElement, trigger: HTMLButtonElement): void {
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setProjectMenuOpen(menu, trigger, true);
    const items = menuItems(menu);
    queueMicrotask(() => focusMenuItem(menu, event.key === "ArrowDown" ? 0 : items.length - 1));
  });
}

let workspaceController: WorkspaceNavigationController | undefined;
let persistedWorkspaceState: WorkspaceState | null = null;
let persistedWorkspaceStateLoad: Promise<void> = Promise.resolve();

const workspaceView: WorkspaceNavigationView = {
  setWorkspaceState(state: WorkspaceNavigationState): void {
    renderWorkspaceState(state);
    updateSmokeTextForSmoke?.();
    for (const button of explorerTree.querySelectorAll<HTMLButtonElement>("button[data-explorer-file-id]")) {
      button.addEventListener("click", () => {
        const manuscriptId = button.dataset.explorerFileId;
        if (manuscriptId) void workspaceController?.openManuscript(manuscriptId);
      });
    }
  },
  setWorkspaceError(message: string | null): void {
    workspaceError.textContent = message ?? "";
    workspaceError.hidden = message === null;
  }
};

const projectView: ProjectNavigationView = {
  setProjectState(state: ProjectNavigationState): void {
    renderProjectState(state);
    refreshPropertiesPanel();
    updateCommandContext();
    void persistWorkspaceState();
    bindProjectFileKeyboard();
    updateSmokeTextForSmoke?.();
    for (const button of explorerTree.querySelectorAll<HTMLButtonElement>("button[data-explorer-file-id]")) {
      button.addEventListener("click", () => {
        const fileId = button.dataset.explorerFileId;
        if (fileId) {
          updateSelectedProjectFile(
            [...explorerTree.querySelectorAll<HTMLButtonElement>("button[data-explorer-file-id]")],
            fileId
          );
          requestProjectFileOpen(fileId);
        }
      });
    }
  },
  setProjectError(message: string | null): void {
    workspaceError.textContent = message ?? "";
    workspaceError.hidden = message === null;
  },
  setProjectIdentityRecovery(recovery): void {
    setWorkspaceRecoveryNotice(recovery === null ? null : projectIdentityRecoveryNotice(recovery.code));
  }
};

let workspacePersistChain: Promise<void> = Promise.resolve();

function persistWorkspaceState(): Promise<void> {
  // Session/tab transitions can notify several observers in one turn. Queue
  // the atomic file writes so a late save cannot race an earlier `.tmp`
  // rename and accidentally persist an intermediate one-tab snapshot.
  workspacePersistChain = workspacePersistChain.then(async () => {
    const save = window.maginalia.saveWorkspaceState;
    const project = projectController?.getState().project;
    if (!save || !project) return;
    const state = projectController?.getState();
    if (!state) return;
    const snapshot: WorkspaceState = {
      version: 1,
      projectId: project.projectId,
      openFileIds: projectController?.getOpenedFileIds() ?? [],
      activeFileId: state.activeFileId,
      viewPlacements: controller.getDocumentViews().map((view) => ({
        // Persist project-relative opaque file IDs, not runtime session IDs.
        documentId: projectController?.getFileIdForSession(view.documentId) ?? view.documentId,
        viewType: view.viewType,
        region: view.region,
        groupId: view.groupId
      }))
    };
    try {
      await save(snapshot);
    } catch {
      // Workspace restoration is convenience state and must never block editing.
    }
  }, () => undefined);
  return workspacePersistChain;
}

async function restorePersistedProjectViews(): Promise<void> {
  const current = projectController?.getState();
  const project = current?.project;
  if (!project || persistedWorkspaceState === null || persistedWorkspaceState.projectId !== project.projectId) return;
  const validFileIds = new Set(current?.files.map((file) => file.fileId) ?? []);
  const openFiles = persistedWorkspaceState.openFileIds;
  for (const fileId of openFiles) {
    if (validFileIds.has(fileId)) await projectController?.openFile(fileId);
  }
  let beforeViewId: string | undefined;
  for (const fileId of [...openFiles].reverse()) {
    const view = controller.getDocumentViews().find((candidate) =>
      candidate.region === "main"
      && candidate.groupId === "editor-group-1"
      && projectController?.getFileIdForSession(candidate.documentId) === fileId);
    if (!view) continue;
    if (beforeViewId) controller.moveMainDocumentViewBefore(view.instanceId, beforeViewId);
    beforeViewId = view.instanceId;
  }
  if (persistedWorkspaceState.activeFileId !== null && validFileIds.has(persistedWorkspaceState.activeFileId)) {
    await projectController?.openFile(persistedWorkspaceState.activeFileId);
  }
}

const repositoryKindLabels: Record<RepositoryKindOption, string> = {
  project: "Project",
  workbench: "Workbench",
  shelf: "Private Shelf"
};

function formatHistoryTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (!Number.isFinite(timestampMs) || Number.isNaN(date.getTime())) return "Saved History";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderRepositoryState(state: RepositoryViewState): void {
  const repository = state.repository;
  repositoryReadyForHistory = repository !== null && state.status === "ready";
  repositoryKindLabel.textContent = repository === null
    ? "No repository selected"
    : repositoryKindLabels[repository.kind];
  repositoryName.textContent = repository?.title ?? "No Repository open";
  repositoryStatus.dataset.state = state.status;
  repositoryStatus.textContent = state.status === "creating"
    ? "Creating…"
    : state.status === "opening"
      ? "Opening…"
      : state.status === "activating"
        ? "Activating…"
        : state.status === "ready"
          ? "Ready"
          : state.status === "pending"
            ? "Activation needed"
            : state.status === "error"
              ? "Action could not be completed"
              : "Create or open a repository.";
  repositoryError.textContent = state.error ?? "";
  repositoryError.hidden = state.error === null;

  const busy = state.status === "creating" || state.status === "opening" || state.status === "activating";
  createRepositoryButton.disabled = busy;
  openRepositoryButton.disabled = busy;
  activateRepositoryButton.hidden = repository === null || state.status === "ready";
  activateRepositoryButton.disabled = busy;
  activateRepositoryButton.textContent = repository?.kind === "shelf"
    ? "Use Private Shelf"
    : "Open in Document";
  updateCommandContext();
}

function renderRepositoryHistoryState(state: RepositoryHistoryViewState): void {
  const historyBusy = state.status === "loading"
    || state.status === "recording"
    || state.status === "opening";
  const canUseHistory = repositoryReadyForHistory && !historyBusy;

  repositoryHistoryEntry.replaceChildren();
  if (state.entries.length === 0) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No saved History";
    repositoryHistoryEntry.append(empty);
  } else {
    for (const entry of state.entries) {
      const option = document.createElement("option");
      option.value = entry.historyId;
      option.textContent = formatHistoryTimestamp(entry.timestampMs);
      repositoryHistoryEntry.append(option);
    }
  }
  repositoryHistoryEntry.value = state.selectedHistoryId ?? "";
  repositoryHistoryEntry.disabled = !canUseHistory || state.entries.length === 0;
  recordRepositoryHistoryButton.disabled = !canUseHistory;
  refreshRepositoryHistoryButton.disabled = !canUseHistory;
  openRepositoryHistoryButton.disabled = !canUseHistory || state.selectedHistoryId === null;

  repositoryHistoryStatus.dataset.state = state.status;
  repositoryHistoryStatus.textContent = state.status === "loading"
    ? "Refreshing History…"
    : state.status === "recording"
      ? "Recording History…"
      : state.status === "opening"
        ? "Opening History copy…"
        : state.status === "ready"
          ? `${state.entries.length} saved History version${state.entries.length === 1 ? "" : "s"}`
          : repositoryReadyForHistory
            ? "Refresh History to view saved versions."
            : "Activate a repository to view History.";
  repositoryHistoryError.textContent = state.error ?? "";
  repositoryHistoryError.hidden = state.error === null;
  updateCommandContext();
}

const repositoryView: RepositoryControllerView = {
  setRepositoryState(state: RepositoryViewState): void {
    renderRepositoryState(state);
  },
  setRepositoryHistoryState(state: RepositoryHistoryViewState): void {
    renderRepositoryHistoryState(state);
  }
};

function filteredCanonicalShelfResults(state: ShelfViewState): readonly ShelfViewState["results"][number][] {
  return filterCanonicalShelfResults(state.results, state.query, shelfSearchFields);
}

function shelfFilterError(): string | null {
  return shelfSearchFields.size === 0 ? "Choose at least one Private Shelf field to search." : null;
}

function renderShelfState(state: ShelfViewState): void {
  libraryName.textContent = "Private Shelf";
  libraryQuery.value = state.query;
  libraryQuery.disabled = state.status === "searching";
  librarySearchButton.disabled = state.status === "searching";

  const filteredResults = filteredCanonicalShelfResults(state);
  const filterError = shelfFilterError();
  const statusMessage = state.status === "searching"
    ? "Searching Private Shelf…"
    : state.status === "ready"
      ? filterError ?? `${filteredResults.length} Private Shelf result${filteredResults.length === 1 ? "" : "s"}`
      : "Search the selected Private Shelf.";
  libraryStatus.dataset.state = state.status;
  libraryStatus.textContent = statusMessage;
  const shelfIdentityRecovery = state.folderIdentityRecovery?.message ?? null;
  libraryError.textContent = filterError ?? state.error ?? shelfIdentityRecovery ?? "";
  libraryError.hidden = filterError === null && state.error === null && shelfIdentityRecovery === null;

  libraryResults.replaceChildren();
  for (const reference of filteredResults) {
    const item = document.createElement("li");
    item.className = "library-result";

    const details = document.createElement("div");
    details.className = "library-reference";
    const quote = document.createElement("blockquote");
    quote.className = "shelf-quote";
    quote.textContent = `「${reference.quote}」`;
    details.append(quote);
    const title = document.createElement("strong");
    title.textContent = reference.title;
    details.append(title);
    const metadata = document.createElement("span");
    const authors = reference.authors.join("、");
    metadata.textContent = [
      authors,
      reference.sourceId,
      reference.page === undefined ? "" : `p. ${reference.page}`
    ].filter((part) => part.length > 0).join(" / ");
    details.append(metadata);
    const sourceUrl = createShelfSourceUrlElement(reference.url, document);
    if (sourceUrl !== null) details.append(sourceUrl);
    if (reference.privateMemo !== undefined && reference.privateMemo.length > 0) {
      const comment = document.createElement("span");
      comment.className = "shelf-private-memo";
      comment.textContent = reference.privateMemo;
      details.append(comment);
    }

    const actions = document.createElement("div");
    actions.className = "library-result-actions";
    const select = document.createElement("button");
    select.type = "button";
    select.textContent = state.selectedAnnotationId === reference.annotationId ? "Selected" : "Select";
    select.setAttribute("aria-pressed", String(state.selectedAnnotationId === reference.annotationId));
    select.addEventListener("click", () => executeShelfCommand(SHELF_SELECT_RESULT_COMMAND_ID, { annotationId: reference.annotationId }));
    const insert = document.createElement("button");
    insert.type = "button";
    insert.textContent = "Insert";
    insert.addEventListener("click", () => {
      // Selecting first makes the Insert command's `when` true for this row;
      // both steps are the same commands the Palette offers.
      const annotationId = reference.annotationId;
      void executeShelfCommandAsync(SHELF_SELECT_RESULT_COMMAND_ID, { annotationId })
        .then((selected) => selected && executeShelfCommandAsync(
          SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID,
          { annotationId },
          "Open a manuscript before inserting a quotation."
        ));
    });
    actions.append(select, insert);
    item.append(details, actions);
    libraryResults.append(item);
  }
}

function renderProjectSearchState(state: ProjectSearchState): void {
  projectSearchResults.replaceChildren();
  projectSearchPanel.hidden = unifiedSearchMode === "shelf" || state.kind === "idle";
  projectSearchPreview.hidden = selectedProjectSearchText === null;
  if (state.kind === "searching") {
    unifiedSearchStatus.textContent = "Searching Project Markdown…";
    return;
  }
  if (state.kind === "error") {
    unifiedSearchStatus.textContent = state.message;
    return;
  }
  if (state.kind === "results") {
    unifiedSearchStatus.textContent = `${state.results.length} Project result${state.results.length === 1 ? "" : "s"}${state.total > state.results.length ? ` (first ${state.results.length} of ${state.total})` : ""}`;
    for (const result of state.results) {
      const item = document.createElement("li");
      item.className = "project-search-result";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "project-search-open";
      open.textContent = result.displayName;
      open.title = "Preview raw Markdown";
      open.draggable = true;
      open.addEventListener("dragstart", (event) => {
        const project = projectController?.getState().project;
        if (project === null || project === undefined) return;
        event.dataTransfer?.setData(PROJECT_DOCUMENT_DRAG_MIME, projectDocumentDragData(project.projectId, result.displayName));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      });
      open.addEventListener("click", () => {
        selectedProjectSearchText = result.text;
        projectSearchSource.value = result.text;
        projectSearchInsertionTarget = controller.captureInsertionTarget();
        projectSearchPreview.hidden = false;
        projectSearchError.hidden = true;
        updateCommandContext();
      });
      const sync = document.createElement("button");
      sync.type = "button";
      sync.className = "project-search-sync";
      sync.textContent = "Sync";
      sync.dataset.projectSearchSync = "true";
      sync.dataset.target = result.displayName;
      sync.title = `Insert ${result.displayName} as a Synced Block`;
      sync.setAttribute("aria-label", `Insert ${result.displayName} as a Synced Block`);
      sync.addEventListener("click", () => {
        const project = projectController?.getState().project;
        if (project !== null && project !== undefined) {
          requestSyncedBlockInsertion({ projectId: project.projectId, target: result.displayName });
        }
      });
      const actions = document.createElement("div");
      actions.className = "project-search-result-actions";
      actions.append(open, sync);
      const excerpt = document.createElement("pre");
      excerpt.className = "project-search-excerpt";
      excerpt.textContent = result.excerpt;
      item.append(actions, excerpt);
      projectSearchResults.append(item);
    }
    return;
  }
  unifiedSearchStatus.textContent = "";
}

function renderReferencesState(state: ReferencesViewState): void {
  referencesStatus.dataset.state = state.status;
  referencesStatus.textContent = state.message;
  referencesUnresolved.textContent = `Unresolved: ${state.unresolvedCount}`;
  refreshReferencesButton.disabled = state.status === "empty" || state.status === "refreshing";
}

const shelfView: ShelfControllerView = {
  setShelfState(state: ShelfViewState): void {
    shelfResultSelected = state.selectedAnnotationId !== null
      && state.results.some((result) => result.annotationId === state.selectedAnnotationId);
    renderShelfState(state);
    if (commandContextReady) updateCommandContext();
  }
};

// LibraryController remains a local-backend compatibility port for explicit
// repository Shelf handoffs. It never owns the Normal Shelf DOM.
const legacyLibraryView: LibraryControllerView = {
  setLibraryState(_state: LibraryViewState): void {}
};

function getWorkspaceApi(): WorkspaceNavigationApi | null {
  const api = window.maginalia;
  if (!api || typeof api.openDocument !== "function" || typeof api.openManuscript !== "function") {
    return null;
  }
  const openDocument = api.openDocument;
  const openManuscript = api.openManuscript;
  return {
    openDocument: () => openDocument(),
    openManuscript: (request) => openManuscript(request)
  };
}

function getProjectApi(): ProjectNavigationApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.openProject !== "function"
    || typeof api.createProject !== "function"
    || typeof api.restoreProject !== "function"
    || typeof api.openProjectFile !== "function"
    || typeof api.createProjectFile !== "function") {
    return null;
  }
  const openProject = api.openProject;
  const createProject = api.createProject;
  const restoreProject = api.restoreProject;
  const openProjectFile = api.openProjectFile;
  const createProjectFile = api.createProjectFile;
  return {
    openProject: () => openProject(),
    createProject: (request) => createProject(request),
    restoreProject: () => restoreProject(),
    openProjectFile: (request) => openProjectFile(request),
    createProjectFile: (request) => createProjectFile(request)
  };
}

type WorkdeskApi = {
  readonly openWorkdesk: () => Promise<WorkdeskOpenResult>;
  readonly createWorkdesk: (request: { readonly title: string }) => Promise<WorkdeskOpenResult>;
  readonly restoreWorkdesk: () => Promise<WorkdeskRestoreResult>;
  readonly returnToWorkdesk: () => Promise<WorkdeskRestoreResult>;
  readonly saveWorkdeskContext: (request: {
    readonly workdeskIdentityId: string;
    readonly context: WorkdeskOpened["lastActiveContext"];
  }) => Promise<{ readonly kind: "saved" } | { readonly kind: "error"; readonly message: string }>;
  readonly createWorkdeskFile: (request: { readonly workdeskId: string; readonly fileName: string; readonly title: string; readonly documentType: "memo" | "draft" | "other"; readonly parentEntryId?: string | null }) => Promise<import("../workdesk-ipc").WorkdeskFileCreateResult>;
  readonly createWorkdeskProject: (request: { readonly workdeskIdentityId: string; readonly title: string }) => Promise<WorkdeskProjectResult>;
  readonly registerWorkdeskProject: (request: { readonly workdeskIdentityId: string }) => Promise<WorkdeskProjectResult>;
  readonly removeWorkdeskProject: (request: { readonly workdeskIdentityId: string; readonly projectIdentityId: string }) => Promise<WorkdeskProjectResult>;
  readonly openWorkdeskProject: (request: { readonly workdeskIdentityId: string; readonly projectIdentityId: string }) => Promise<WorkdeskProjectResult>;
  readonly copyWorkdeskFileToProject: (request: { readonly workdeskId: string; readonly sourceFileId: string; readonly projectIdentityId: string; readonly documentType: ProjectDocumentType }) => Promise<WorkdeskCopyResult>;
};

function getWorkdeskApi(): WorkdeskApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.openWorkdesk !== "function"
    || typeof api.createWorkdesk !== "function"
    || typeof api.restoreWorkdesk !== "function"
    || typeof api.returnToWorkdesk !== "function"
    || typeof api.saveWorkdeskContext !== "function"
    || typeof api.createWorkdeskFile !== "function"
    || typeof api.createWorkdeskProject !== "function"
    || typeof api.registerWorkdeskProject !== "function"
    || typeof api.removeWorkdeskProject !== "function"
    || typeof api.openWorkdeskProject !== "function"
    || typeof api.copyWorkdeskFileToProject !== "function") return null;
  return {
    openWorkdesk: () => api.openWorkdesk!(),
    createWorkdesk: (request) => api.createWorkdesk!(request),
    restoreWorkdesk: () => api.restoreWorkdesk!(),
    returnToWorkdesk: () => api.returnToWorkdesk!(),
    saveWorkdeskContext: (request) => api.saveWorkdeskContext!(request),
    createWorkdeskFile: (request) => api.createWorkdeskFile!(request),
    createWorkdeskProject: (request) => api.createWorkdeskProject!(request),
    registerWorkdeskProject: (request) => api.registerWorkdeskProject!(request),
    removeWorkdeskProject: (request) => api.removeWorkdeskProject!(request),
    openWorkdeskProject: (request) => api.openWorkdeskProject!(request),
    copyWorkdeskFileToProject: (request) => api.copyWorkdeskFileToProject!(request)
  };
}

type ExplorerApi = {
  readonly listExplorer: (request: { readonly documentId: string }) => Promise<import("../document-workspace").ExplorerListResult>;
  readonly createExplorerFolder: (request: { readonly documentId: string; readonly parentEntryId: string | null; readonly name: string }) => Promise<import("../document-workspace").CreateFolderResult>;
  readonly deleteExplorerFile: (request: { readonly documentId: string; readonly entryId: string }) => Promise<import("../document-workspace-ipc").ExplorerDeleteFileResult>;
};

function getExplorerApi(): ExplorerApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.listExplorer !== "function"
    || typeof api.createExplorerFolder !== "function"
    || typeof api.deleteExplorerFile !== "function") return null;
  return {
    listExplorer: (request) => api.listExplorer!(request),
    createExplorerFolder: (request) => api.createExplorerFolder!(request),
    deleteExplorerFile: (request) => api.deleteExplorerFile!(request)
  };
}

async function refreshExplorer(projectId: string): Promise<void> {
  const api = getExplorerApi();
  if (!api) return;
  const result = await api.listExplorer({ documentId: projectId });
  const activeProject = projectController?.getState().project;
  if (activeProject?.projectId !== projectId) return;
  if (result.kind === "error") {
    projectView.setProjectError(result.message);
    return;
  }
  explorerDocumentId = projectId;
  explorerEntries = activeWorkdeskRootDocumentId() === projectId
    ? result.entries.filter((entry) => entry.relativeName !== "projects" && !entry.relativeName.startsWith("projects/"))
    : result.entries;
  projectView.setProjectState(projectController?.getState() ?? { project: null, files: [], activeFileId: null });
}

async function deleteSelectedExplorerFile(): Promise<void> {
  const navigation = projectController;
  const project = navigation?.getState().project;
  const entryId = selectedExplorerEntryId ?? selectedProjectFileId;
  const api = getExplorerApi();
  if (!navigation || !project || !entryId || !api) throw new Error("Select a file before deleting it.");
  const entry = explorerEntries.find((candidate) => candidate.entryId === entryId);
  if (entry?.kind === "folder") throw new Error("Folders cannot be deleted from the Explorer.");
  const file = navigation.getState().files.find((candidate) => candidate.fileId === entryId);
  const displayName = entry?.displayName ?? file?.displayName;
  if (!displayName) throw new Error("The selected file is no longer available.");
  const documentId = file ? navigation.getSessionIdForFile(entryId) : null;
  const session = documentId ? controller.getDocumentState(documentId) : null;
  if (session && session.currentText !== session.savedText
    && !window.confirm(`Delete ${displayName}? Unsaved changes will be lost and the file will move to the Recycle Bin.`)) return;
  if (!window.confirm(`Move ${displayName} to the Recycle Bin?`)) return;
  const result = await api.deleteExplorerFile({ documentId: project.projectId, entryId });
  if (result.kind !== "deleted") {
    projectView.setProjectError(result.message);
    return;
  }
  if (documentId) {
    const views = controller.getDocumentViews().filter((view) => view.documentId === documentId);
    for (const view of views) await controller.closeDocumentView(view.instanceId, () => "discard");
  }
  if (file) navigation.removeDeletedFile(entryId);
  selectedExplorerEntryId = null;
  await refreshExplorer(project.projectId);
}

function refreshActiveWorkdeskNode(node: { readonly projectIdentityId: string; readonly title: string; readonly available: boolean }): void {
  if (!activeWorkdesk) return;
  const present = activeWorkdesk.projects.find((item) => item.projectIdentityId === node.projectIdentityId);
  activeWorkdesk = {
    ...activeWorkdesk,
    projects: present
      ? activeWorkdesk.projects.map((item) => item.projectIdentityId === node.projectIdentityId ? node : item)
      : [...activeWorkdesk.projects, node]
  };
  projectView.setProjectState(projectController?.getState() ?? { project: null, files: [], activeFileId: null });
}

async function openWorkdeskProjectResult(result: WorkdeskProjectResult, alreadyActivated = false): Promise<boolean> {
  if (result.kind === "cancelled") return false;
  if (result.kind === "opened-unregistered") {
    const navigation = projectController;
    if (!navigation || (!alreadyActivated && !(await navigation.activateOpenedProject(result.project)))) return false;
    activeWorkdeskProjectIdentityId = null;
    projectView.setProjectState(navigation.getState());
    await rememberActiveWorkdeskContext({ kind: "home" });
    updateCommandContext();
    return true;
  }
  if (result.kind === "registered") {
    refreshActiveWorkdeskNode(result.node);
    return true;
  }
  if (result.kind === "removed") {
    if (activeWorkdesk) {
      activeWorkdesk = {
        ...activeWorkdesk,
        projects: activeWorkdesk.projects.filter((project) => project.projectIdentityId !== result.projectIdentityId)
      };
      projectView.setProjectState(projectController?.getState() ?? { project: null, files: [], activeFileId: null });
    }
    return true;
  }
  if (result.kind !== "opened") {
    projectView.setProjectError(result.message);
    return false;
  }
  const navigation = projectController;
  if (!navigation || (!alreadyActivated && !(await navigation.activateOpenedProject(result.project)))) return false;
  activeWorkdeskProjectIdentityId = result.node.projectIdentityId;
  refreshActiveWorkdeskNode(result.node);
  await rememberActiveWorkdeskContext({ kind: "project", projectIdentityId: result.node.projectIdentityId });
  updateCommandContext();
  return true;
}

async function loadAndActivateWorkdeskProject(
  load: () => Promise<WorkdeskProjectResult | null>
): Promise<boolean> {
  const navigation = projectController;
  if (!navigation) return false;
  const loaded: { result: WorkdeskProjectResult | null } = { result: null };
  const activated = await navigation.activateProjectFromLoader(async () => {
    const result = await load();
    loaded.result = result;
    return result?.kind === "opened" || result?.kind === "opened-unregistered" ? result.project : null;
  });
  const result = loaded.result;
  if (result === null) return false;
  if (result.kind === "opened" || result.kind === "opened-unregistered") {
    if (!activated) {
      projectView.setProjectError("The Workdesk Project could not be activated.");
      return false;
    }
    return openWorkdeskProjectResult(result, true);
  }
  return openWorkdeskProjectResult(result);
}

async function activateWorkdesk(result: WorkdeskOpenResult): Promise<boolean> {
  if (result.kind === "cancelled") return false;
  if (result.kind === "recovery") {
    const navigation = projectController;
    if (!navigation) return false;
    const activated = await navigation.activateOpenedProject({ kind: "opened", project: result.project, files: result.files });
    if (!activated) return false;
    activeWorkdesk = null;
    activeWorkdeskProjectIdentityId = null;
    activeWorkdeskRecovery = result;
    primaryWorkdeskAvailable = true;
    setWorkspaceRecoveryNotice(workdeskIdentityRecoveryNotice(result.recovery.code));
    projectView.setProjectError(null);
    updateCommandContext();
    projectView.setProjectState(navigation.getState());
    return true;
  }
  if (result.kind !== "opened") {
    projectView.setProjectError(result.message);
    return false;
  }
  const navigation = projectController;
  if (!navigation) return false;
  const activated = await navigation.activateOpenedProject({ kind: "opened", project: result.project, files: result.files });
  if (!activated) return false;
  activeWorkdesk = result;
  activeWorkdeskProjectIdentityId = null;
  activeWorkdeskRecovery = null;
  primaryWorkdeskAvailable = true;
  setWorkspaceRecoveryNotice(null);
  projectView.setProjectError(null);
  updateCommandContext();
  // ProjectNavigationController deliberately owns DocumentSession handoff;
  // re-render after its successful generic Project state update to apply the
  // normal-UI Workdesk label and parent nodes without changing source state.
  projectView.setProjectState(navigation.getState());
  return true;
}

async function rememberActiveWorkdeskContext(context: WorkdeskOpened["lastActiveContext"]): Promise<void> {
  const desk = activeWorkdesk;
  const api = getWorkdeskApi();
  if (!desk || !api) return;
  try {
    const result = await api.saveWorkdeskContext({
      workdeskIdentityId: desk.workdesk.workdeskIdentityId,
      context,
    });
    if (result.kind !== "saved") projectView.setProjectError(result.message);
  } catch {
    projectView.setProjectError("The active Workdesk context could not be saved.");
  }
}

async function openWorkdesk(api: WorkdeskApi, createTitle?: string): Promise<void> {
  const result = createTitle === undefined ? await api.openWorkdesk() : await api.createWorkdesk({ title: createTitle });
  if (await activateWorkdesk(result) && result.kind === "opened") await rememberActiveWorkdeskContext({ kind: "home" });
}

function getLibraryApi(): LibraryControllerApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.openLibrary !== "function"
    || typeof api.searchLibrary !== "function"
    || typeof api.resolveQuotationForInsert !== "function") {
    return null;
  }
  const openLibrary = api.openLibrary;
  const searchLibrary = api.searchLibrary;
  const resolveQuotationForInsert = api.resolveQuotationForInsert;
  return {
    openLibrary: () => openLibrary(),
    searchLibrary: (request) => searchLibrary(request),
    resolveQuotationForInsert: (request) => resolveQuotationForInsert(request)
  };
}

function getShelfApi(): ShelfControllerApi | null {
  const api = window.maginalia;
  if (!api || typeof api.searchShelf !== "function") return null;
  const searchShelf = api.searchShelf;
  return {
    searchShelf: (request) => searchShelf(request)
  };
}

function getProjectSearchApi(): { searchProjectMarkdown(request: { readonly projectId: string; readonly query: string }): Promise<import("../project-search-ipc").SearchProjectMarkdownResult> } | null {
  const api = window.maginalia;
  if (!api || typeof api.searchProjectMarkdown !== "function") return null;
  const searchProjectMarkdown = api.searchProjectMarkdown;
  return { searchProjectMarkdown: (request) => searchProjectMarkdown(request) };
}

function getReferencesApi(): ReferencesControllerApi | null {
  const api = window.maginalia;
  if (!api || typeof api.resolveReferences !== "function") return null;
  const resolveReferences = api.resolveReferences;
  return {
    resolveReferences: (request) => resolveReferences(request)
  };
}

function getExportApi(): ExportControllerApi | null {
  const api = window.maginalia;
  if (!api || typeof api.resolveExport !== "function" || typeof api.writeExport !== "function") return null;
  const resolveExport = api.resolveExport;
  const writeExport = api.writeExport;
  return {
    resolveExport: (request) => resolveExport(request),
    writeExport: (request) => writeExport(request)
  };
}

function getModApi(): ConstructorParameters<typeof ModController>[0]["api"] | null {
  const api = window.maginalia;
  if (!api
    || typeof api.loadMods !== "function"
    || typeof api.reloadMods !== "function"
    || typeof api.openModsFolder !== "function"
    || typeof api.invokeModCommand !== "function") {
    return null;
  }
  const loadMods = api.loadMods;
  const reloadMods = api.reloadMods;
  const openModsFolder = api.openModsFolder;
  const invokeModCommand = api.invokeModCommand;
  return {
    loadMods: () => loadMods(),
    reloadMods: () => reloadMods(),
    openModsFolder: () => openModsFolder(),
    invokeModCommand: (request) => invokeModCommand(request),
    onModCapabilityRequest: api.onModCapabilityRequest
  };
}

function getRepositoryApi(): RepositoryControllerApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.createRepository !== "function"
    || typeof api.openRepository !== "function"
    || typeof api.openRepositoryDocument !== "function"
    || typeof api.useRepositoryShelf !== "function"
    || typeof api.createRepositoryHistory !== "function"
    || typeof api.listRepositoryHistory !== "function"
    || typeof api.openRepositoryHistory !== "function") {
    return null;
  }
  const createRepository = api.createRepository;
  const openRepository = api.openRepository;
  const openRepositoryDocument = api.openRepositoryDocument;
  const useRepositoryShelf = api.useRepositoryShelf;
  const createRepositoryHistory = api.createRepositoryHistory;
  const listRepositoryHistory = api.listRepositoryHistory;
  const openRepositoryHistory = api.openRepositoryHistory;
  return {
    createRepository: (request) => createRepository(request),
    openRepository: () => openRepository(),
    openRepositoryDocument: (request) => openRepositoryDocument(request),
    useRepositoryShelf: (request) => useRepositoryShelf(request),
    createRepositoryHistory: (request) => createRepositoryHistory(request),
    listRepositoryHistory: (request) => listRepositoryHistory(request),
    openRepositoryHistory: (request) => openRepositoryHistory(request)
  };
}

const standaloneWorkbenchSmoke = new URLSearchParams(window.location.search).get("smoke") === "workbench";
const modApi = getModApi();
if (modApi && !standaloneWorkbenchSmoke) {
  modController = new ModController({ api: modApi, writing: controller, view: modView });
  modHostAvailable = true;
  updateCommandContext();
  openModsFolderButton.addEventListener("click", () => {
    void executeCommand("maginalia.mods.openFolder");
  });
  reloadModsButton.addEventListener("click", () => {
    void executeCommand("maginalia.mods.reload");
  });
  void modController.load();
} else {
  openModsFolderButton.disabled = true;
  reloadModsButton.disabled = true;
  modsStatus.dataset.state = "error";
  modsStatus.textContent = "Mod host unavailable";
}

let updateSmokeTextForSmoke: (() => void) | undefined;
const smokeQuery = new URLSearchParams(window.location.search).get("smoke");
const writingSmokeMode = smokeQuery === "writing";
const workspaceSmokeMode = smokeQuery === "workspace";
const quotationSmokeMode = smokeQuery === "quotation";
const repositorySmokeMode = smokeQuery === "repository";
const shelfSmokeMode = smokeQuery === "shelf";
const d5SmokeMode = smokeQuery === "d5" || smokeQuery === "d5-restore";
const exportSmokeMode = smokeQuery === "export";
const gSmokeMode = smokeQuery === "g" || smokeQuery === "g-restore";
const workdeskSmokeMode = smokeQuery === "h" || smokeQuery === "h-restore"
  || smokeQuery === "h-acceptance" || smokeQuery === "h-acceptance-restore";
const workdeskRestoreSmokeMode = smokeQuery === "h-restore" || smokeQuery === "h-acceptance-restore";
const gRestoreSmokeMode = smokeQuery === "g-restore";
const projectSmokeMode = smokeQuery === "project";
const projectRestoreSmokeMode = smokeQuery === "project-restore" || smokeQuery === "d5-restore" || gRestoreSmokeMode || workdeskRestoreSmokeMode;
const workbenchSmokeMode = smokeQuery === "workbench";
const smokeDecisionQueue: DirtySwitchDecision[] = [];
const legacyWorkspaceMode = workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode;
const projectLikeSmokeMode = projectSmokeMode
  || projectRestoreSmokeMode
  || shelfSmokeMode
  || d5SmokeMode
  || exportSmokeMode
  || gSmokeMode
  || workdeskSmokeMode;
openButton.textContent = writingSmokeMode ? "Open" : legacyWorkspaceMode ? "Open Document" : "Open another Project…";
openButton.hidden = !writingSmokeMode && !legacyWorkspaceMode;
repositoryNavigation.hidden = writingSmokeMode;
projectHeaderActions.hidden = writingSmokeMode || legacyWorkspaceMode;
projectPrimaryActions.hidden = writingSmokeMode || legacyWorkspaceMode;
projectNewMenu.hidden = true;
projectOverflowMenu.hidden = true;
projectInlineCreate.hidden = true;
projectCreateForm.hidden = true;

bindProjectMenuKeyboard(projectNewMenu, projectNewButton);
bindProjectMenuKeyboard(projectOverflowMenu, projectOverflowButton);
bindProjectMenuTriggerKeyboard(projectNewMenu, projectNewButton);
bindProjectMenuTriggerKeyboard(projectOverflowMenu, projectOverflowButton);

projectNewButton.addEventListener("click", () => {
  const open = Boolean(projectNewMenu.hidden);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
  setProjectMenuOpen(projectNewMenu, projectNewButton, open);
  if (open) queueMicrotask(() => focusMenuItem(projectNewMenu, 0));
});

projectOverflowButton.addEventListener("click", () => {
  const open = Boolean(projectOverflowMenu.hidden);
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, open);
  if (open) queueMicrotask(() => focusMenuItem(projectOverflowMenu, 0));
});

for (const button of projectNewMenu.querySelectorAll<HTMLButtonElement>("button[data-document-type]")) {
  button.addEventListener("click", () => {
    const value = button.dataset.documentType;
    if ((PROJECT_DOCUMENT_TYPES as readonly string[]).includes(value ?? "")) {
      const command = `maginalia.explorer.new${value![0]!.toUpperCase()}${value!.slice(1)}`;
      void commandRegistry.execute(command, commandContext.snapshot());
    }
  });
}
explorerNewFolderButton.addEventListener("click", () => {
  void commandRegistry.execute("maginalia.explorer.newFolder", commandContext.snapshot());
});

projectCreateCancelButton.addEventListener("click", () => cancelProjectCreation());
projectCreateFileCancelButton.addEventListener("click", () => cancelProjectFileCreation());

projectInlineCreate.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelProjectFileCreation();
});

projectCreateForm.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelProjectCreation();
});

projectNewMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") event.stopPropagation();
});

projectOverflowMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") event.stopPropagation();
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (projectNewMenu.contains(target) || projectOverflowMenu.contains(target)
    || projectNewButton.contains(target) || projectOverflowButton.contains(target)) return;
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
});

if (writingSmokeMode || workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode || shelfSmokeMode || projectLikeSmokeMode) {
  const updateSmokeText = (): void => {
    editorContainer.dataset.smokeText = surface.getText();
  };
  updateSmokeTextForSmoke = updateSmokeText;
  editorContainer.dataset.smokeReady = writingSmokeMode
    ? "true"
    : workspaceSmokeMode
      ? "workspace"
      : quotationSmokeMode
        ? "quotation"
        : shelfSmokeMode
            ? "shelf"
            : workdeskSmokeMode
              ? "workdesk"
            : projectLikeSmokeMode
              ? "project"
            : "repository";
  editorContainer.addEventListener("maginalia-smoke-append", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") surface.appendTextForSmoke(text);
  });
  editorContainer.addEventListener("maginalia-smoke-replace", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") controller.replaceText(text);
  });
  editorContainer.addEventListener("maginalia-smoke-focus", () => surface.focus());
  if (quotationSmokeMode || shelfSmokeMode) {
    editorContainer.addEventListener("maginalia-smoke-cursor-end", () => surface.setCursorToEndForSmoke());
  }
  surface.onTextChange(updateSmokeText);
  updateSmokeText();
}

if (workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode || shelfSmokeMode || projectLikeSmokeMode) {
  window.addEventListener("maginalia-smoke-decision", (event) => {
    const decision = (event as CustomEvent<unknown>).detail;
    if (decision === "save" || decision === "discard" || decision === "cancel") {
      smokeDecisionQueue.push(decision);
    }
  });
  window.addEventListener("error", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : shelfSmokeMode ? "Shelf" : exportSmokeMode ? "Export" : projectLikeSmokeMode ? "Project" : "Workspace";
    console.error(`${smokeLabel} smoke page error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : shelfSmokeMode ? "Shelf" : exportSmokeMode ? "Export" : projectLikeSmokeMode ? "Project" : "Workspace";
    console.error(`${smokeLabel} smoke unhandled rejection: ${String(event.reason)}`);
  });
}

if (legacyWorkspaceMode) {
  const workspaceApi = getWorkspaceApi();
  if (!workspaceApi) {
    const message = "Document workspace is unavailable. Reload MAGINALIA to try again.";
    workspaceView.setWorkspaceError(message);
    openButton.disabled = true;
    if (workspaceSmokeMode) console.error(message);
  } else {
      workspaceController = new WorkspaceNavigationController({
      api: workspaceApi,
      writing: controller,
      view: workspaceView,
      flushAllDocuments: flushAllAutosave,
      decideDirtySwitch: workspaceSmokeMode
        ? () => smokeDecisionQueue.shift() ?? "cancel"
        : (context) => decideDirtySwitch(context, (message) => window.confirm(message))
    });
  }
} else if (!writingSmokeMode) {
  const projectApi = getProjectApi();
  if (!projectApi) {
    projectView.setProjectError("Project is unavailable. Reload MAGINALIA to try again.");
    openButton.disabled = true;
    openProjectButton.disabled = true;
    projectNewButton.disabled = true;
    projectOverflowButton.disabled = true;
    createProjectButton.disabled = true;
    newFileForm.querySelectorAll("input, select, button").forEach((element) => {
      (element as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = true;
    });
  } else {
    projectController = new ProjectNavigationController({
      api: projectApi,
      writing: controller,
      view: projectView,
      // Central tabs keep each DocumentSession alive, so switching files is
      // activation and must not invoke the legacy replacement prompt.
      confirmDocumentSwitch: false,
      flushAllDocuments: flushAllAutosave,
      decideDirtySwitch: projectLikeSmokeMode
        ? () => smokeDecisionQueue.shift() ?? "cancel"
        : (context) => decideDirtySwitch(context, (message) => window.confirm(message))
    });
    if (!workbenchSmokeMode && window.maginalia.loadWorkspaceState) {
      persistedWorkspaceStateLoad = window.maginalia.loadWorkspaceState().then((result) => {
        if ("version" in result && result.version === 1) persistedWorkspaceState = result;
      }).catch(() => undefined);
    }
    if (((!projectLikeSmokeMode && !workbenchSmokeMode) || projectRestoreSmokeMode) && !firstRunMode) {
      const workdeskApi = getWorkdeskApi();
      if (workdeskApi) {
        void workdeskApi.restoreWorkdesk().then(async (result) => {
          if (result.kind === "opened") {
            const contextResult = await restoreRememberedWorkdeskContext(result, {
              activateHome: activateWorkdesk,
              openProject: workdeskApi.openWorkdeskProject,
              activateProject: openWorkdeskProjectResult,
              showError: (message) => projectView.setProjectError(message),
            });
            if (contextResult.kind === "project") {
              await persistedWorkspaceStateLoad;
              await restorePersistedProjectViews();
            }
            const launchQuery = new URLSearchParams(window.location.search);
            if (launchQuery.get("tutorial-entry") === "1") {
              const entry = projectController?.getState().files.find((file) => file.displayName === "sample-a_マキナの置き手紙.md");
              if (entry) {
                await projectController?.openFile(entry.fileId);
                launchQuery.delete("tutorial-entry");
                const nextUrl = new URL(window.location.href);
                nextUrl.search = launchQuery.toString();
                window.history.replaceState(null, "", nextUrl.href);
              }
            }
            if (contextResult.kind === "home-fallback") {
              await rememberActiveWorkdeskContext({ kind: "home" });
            }
            console.info("MAGINALIA_WORKDESK_RENDERER_STARTUP", JSON.stringify({
              restoreResult: result.kind,
              lastActiveContext: result.lastActiveContext.kind,
              restoredContextResult: contextResult.kind,
            }));
            return;
          }
          if (result.kind === "recovery") {
            await activateWorkdesk(result);
            return;
          }
          let restoreError: string | null = result.kind === "error" ? result.message : null;
          // A missing primary Workdesk is a normal first-run state. Ask for
          // one explicit local folder and let the existing IPC open path bind
          // it as primary; cancellation keeps the current authoring state.
          const shouldInvokeFirstRunSelection = shouldPromptForPrimaryWorkdesk(result.kind, !projectLikeSmokeMode && !workbenchSmokeMode);
          console.info("MAGINALIA_WORKDESK_RENDERER_STARTUP", JSON.stringify({
            restoreResult: result.kind,
            firstRunSelectionInvoked: shouldInvokeFirstRunSelection,
            reason: result.kind === "none" ? "no-saved-primary" : result.kind === "error" ? "restore-error" : "smoke-mode",
          }));
          if (shouldInvokeFirstRunSelection) {
            const selected = await workdeskApi.openWorkdesk();
            if (selected.kind === "opened" || selected.kind === "recovery") {
              if (await activateWorkdesk(selected)) {
                if (selected.kind === "opened") await rememberActiveWorkdeskContext({ kind: "home" });
                return;
              }
            }
            if (selected.kind === "error") restoreError = selected.message;
          }
          await projectController?.restoreProject();
          await persistedWorkspaceStateLoad;
          await restorePersistedProjectViews();
          if (restoreError !== null) projectView.setProjectError(restoreError);
        }).catch(() => {
          void projectController?.restoreProject().then(async () => {
            await persistedWorkspaceStateLoad;
            await restorePersistedProjectViews();
            projectView.setProjectError("The previous Workdesk could not be restored. Use Open Workdesk to choose another folder.");
          }).catch(() => {
            projectView.setProjectError("The previous Workdesk could not be restored. Use Open Workdesk to choose another folder.");
          });
        });
      } else {
        const restore = projectController.restoreProject();
        void restore.then(async () => {
          await persistedWorkspaceStateLoad;
          await restorePersistedProjectViews();
        });
      }
    }
  }
}

if (projectController && !workbenchSmokeMode) {
  controller.onSessionChange((change) => {
    projectController?.syncOpenDocuments(change.views
      .filter((view) => view.region === "main" && view.groupId === "editor-group-1")
      .map((view) => view.documentId));
    projectController?.syncActiveDocument(change.activeDocumentId);
    void persistWorkspaceState();
  });
}

let libraryController: LibraryController | undefined;
const libraryApi = getLibraryApi();
if (libraryApi) {
  // Keep the local LibraryService path alive for repository-owned Shelf
  // activation and its privacy/legacy tests. Normal UI search is below.
  libraryController = new LibraryController({
    api: libraryApi,
    writing: controller,
    view: legacyLibraryView
  });
}

let shelfController: ShelfController | undefined;
let projectSearchController: ProjectSearchController | undefined;
const projectSearchApi = getProjectSearchApi();
if (projectSearchApi) {
  projectSearchController = new ProjectSearchController(projectSearchApi, renderProjectSearchState);
  commandAvailability.projectSearch = true;
  updateCommandContext();
} else {
  unifiedSearchStatus.textContent = "Project search is unavailable.";
}

function updateUnifiedSearchMode(mode: UnifiedSearchMode): void {
  unifiedSearchMode = mode;
  for (const button of unifiedSearchModeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.unifiedSearchMode === mode));
  }
  shelfSearchFieldset.hidden = mode === "project";
  libraryResults.hidden = mode === "project";
  if (mode === "shelf") {
    projectSearchPanel.hidden = true;
  } else {
    renderProjectSearchState(projectSearchController?.getState() ?? { kind: "idle" });
  }
}

const SHELF_FIELD_REQUIRED_MESSAGE = "Choose at least one Private Shelf field to search.";

/** Shelf search command implementation (form submit and Palette). */
async function runShelfSearchCommand(query: string | undefined): Promise<void> {
  const shelf = shelfController;
  if (shelf === undefined) throw new Error("Shelf is unavailable.");
  if (query === undefined && libraryQuery.value.length === 0) {
    // From the Palette with nothing typed yet: bring the search field forward.
    if (unifiedSearchMode === "project") updateUnifiedSearchMode("shelf");
    await executeCommand("maginalia.view.show.library");
    libraryQuery.focus();
    return;
  }
  if (shelfSearchFields.size === 0) {
    libraryError.textContent = SHELF_FIELD_REQUIRED_MESSAGE;
    libraryError.hidden = false;
    return;
  }
  if (query === undefined && unifiedSearchMode === "project") updateUnifiedSearchMode("shelf");
  libraryError.hidden = true;
  await shelf.search(query ?? libraryQuery.value);
}

/** Current-Project Markdown search command implementation (form submit and Palette). */
async function runProjectMarkdownSearchCommand(query: string | undefined): Promise<void> {
  const search = projectSearchController;
  if (search === undefined) throw new Error("Project search is unavailable.");
  if (query === undefined && libraryQuery.value.length === 0) {
    if (unifiedSearchMode === "shelf") updateUnifiedSearchMode("project");
    await executeCommand("maginalia.view.show.library");
    libraryQuery.focus();
    return;
  }
  if (query === undefined && unifiedSearchMode === "shelf") updateUnifiedSearchMode("project");
  selectedProjectSearchText = null;
  projectSearchPreview.hidden = true;
  updateCommandContext();
  const projectId = projectController?.getState().project?.projectId ?? null;
  await search.search(projectId, query ?? libraryQuery.value);
}

/** The unified search form dispatches the same commands as the Palette. */
async function runUnifiedSearch(): Promise<void> {
  const query = libraryQuery.value;
  const includesShelf = unifiedSearchMode === "all" || unifiedSearchMode === "shelf";
  const includesProject = unifiedSearchMode === "all" || unifiedSearchMode === "project";
  if (includesShelf && shelfSearchFields.size === 0) {
    libraryError.textContent = SHELF_FIELD_REQUIRED_MESSAGE;
    libraryError.hidden = false;
    return;
  }
  libraryError.hidden = true;
  const jobs: Promise<unknown>[] = [];
  if (includesShelf) jobs.push(executeShelfCommandAsync(SHELF_SEARCH_COMMAND_ID, { query }));
  if (includesProject) {
    if (commandContext.snapshot()["project.active"] === true) {
      jobs.push(executeCommand(PROJECT_MARKDOWN_SEARCH_COMMAND_ID, { query }));
    } else {
      projectSearchPanel.hidden = unifiedSearchMode === "shelf";
      unifiedSearchStatus.textContent = "Open a Project before searching its Markdown.";
    }
  }
  await Promise.all(jobs);
}

for (const button of unifiedSearchModeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.unifiedSearchMode;
    if (mode !== "all" && mode !== "shelf" && mode !== "project") return;
    updateUnifiedSearchMode(mode);
    if (libraryQuery.value.length > 0) void runUnifiedSearch();
  });
}
for (const input of shelfSearchFieldInputs) {
  input.addEventListener("change", () => {
    const field = input.dataset.shelfSearchField;
    if (field !== "quote" && field !== "privateMemo" && field !== "title" && field !== "authors" && field !== "page" && field !== "url") return;
    if (input.checked) shelfSearchFields.add(field);
    else shelfSearchFields.delete(field);
    if (shelfController) renderShelfState(shelfController.getState());
  });
}
projectSearchInsert.addEventListener("click", () => {
  void commandRegistry.execute(INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID, commandContext.snapshot()).then((result) => {
    if (result.kind === "executed") {
      projectSearchError.hidden = true;
      return;
    }
    projectSearchError.textContent = result.kind === "failed"
      ? result.error.message
      : "Select a Project result and open a document before inserting.";
    projectSearchError.hidden = false;
  });
});

registerSearchCommands(commandRegistry, {
  searchShelf: runShelfSearchCommand,
  searchProjectMarkdown: runProjectMarkdownSearchCommand,
  selectShelfResult: (annotationId) => {
    const shelf = shelfController;
    if (shelf === undefined || !shelf.getState().results.some((result) => result.annotationId === annotationId)) {
      throw new Error("The Shelf result is no longer available.");
    }
    shelf.selectResult(annotationId);
  },
  insertShelfQuote: async (annotationId) => {
    const shelf = shelfController;
    if (shelf === undefined) throw new Error("Shelf is unavailable.");
    // ShelfController reports a missing result, target, or stale insertion
    // through the Shelf status panel.
    await shelf.insertResult(annotationId);
  },
  insertProjectSearchSelection: () => insertProjectSearchSelection(
    projectSearchInsertionTarget,
    projectSearchSource.value.slice(projectSearchSource.selectionStart, projectSearchSource.selectionEnd),
    (target) => controller.isInsertionTargetCurrent(target),
    (target, text) => controller.insertMarkdownText(target, text)
  )
});

const shelfApi = getShelfApi();
if (!shelfApi) {
  libraryQuery.disabled = true;
  librarySearchButton.disabled = true;
  libraryStatus.textContent = "Shelf is unavailable.";
  libraryError.textContent = "Activate a Private Shelf repository before searching.";
  libraryError.hidden = false;
} else {
  shelfController = new ShelfController({
    api: shelfApi,
    writing: controller,
    view: shelfView
  });
  commandAvailability.shelf = true;
  updateCommandContext();
  libraryQuery.addEventListener("input", () => {
    shelfController?.setQuery(libraryQuery.value);
  });
  librarySearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void runUnifiedSearch();
  });
}

/** Dispatch a Shelf command and report failures in the Shelf panel; resolves true when it ran. */
function executeShelfCommandAsync(command: string, args?: CommandArgs, disabledMessage?: string): Promise<boolean> {
  return commandRegistry.execute(command, commandContext.snapshot(), args).then((result) => {
    const message = result.kind === "failed" ? result.error.message
      : result.kind === "disabled" && disabledMessage !== undefined ? disabledMessage
        : null;
    if (message !== null) {
      libraryStatus.dataset.state = "error";
      libraryStatus.textContent = "Shelf action failed.";
      libraryError.textContent = message;
      libraryError.hidden = false;
    }
    return result.kind === "executed";
  });
}

function executeShelfCommand(command: string, args?: CommandArgs): void {
  void executeShelfCommandAsync(command, args);
}

// Shelf-facing controls only dispatch command IDs. They never invoke the
// process manager, view controller, or search implementation directly.
openReviewerButton.addEventListener("click", () => executeShelfCommand("maginalia.shelf.openReviewer"));
refreshShelfButton.addEventListener("click", () => executeShelfCommand("maginalia.shelf.refresh"));
closeReviewerViewButton.addEventListener("click", () => executeShelfCommand("maginalia.shelf.closeReviewer"));

const referencesView: ReferencesControllerView = {
  setReferencesState(state: ReferencesViewState): void {
    renderReferencesState(state);
  }
};

let referencesController: ReferencesController | undefined;
const referencesApi = getReferencesApi();
if (referencesApi) {
  referencesController = new ReferencesController({
    api: referencesApi,
    writing: controller,
    view: referencesView,
    compose: (document) => composeSyncedMarkdown(document.currentText, document.documentId)
  });
  refreshReferencesButton.addEventListener("click", () => void executeCommand("maginalia.references.refresh"));
} else {
  refreshReferencesButton.disabled = true;
  referencesStatus.dataset.state = "error";
  referencesStatus.textContent = "Reference refresh is unavailable.";
}

const exportView: ExportControllerView = {
  setExportState(state: ExportViewState): void {
    exportButton.disabled = !state.enabled;
    exportPdfButton.disabled = !state.enabled;
    exportDocxButton.disabled = !state.enabled;
    exportStatus.dataset.state = state.status;
    exportStatus.textContent = state.message;
  }
};

let exportController: ExportController | undefined;
const exportApi = getExportApi();
if (exportApi) {
  exportController = new ExportController({
    api: exportApi,
    writing: controller,
    view: exportView,
    compose: (document) => composeSyncedMarkdown(document.currentText, document.documentId),
    getPresentationSettings: () => currentExportPresentationSettings
  });
  commandAvailability.export = true;
  updateCommandContext();
  // The export panel is a second surface for the registered export settings;
  // it writes through the Settings Registry like the Settings Center does.
  bindExportSettingControls(settingsRegistry, [
    { settingId: EXPORT_SETTING_IDS.paperSize, event: "change", read: () => exportPaperSizeInput.value, addEventListener: (type, listener) => exportPaperSizeInput.addEventListener(type, listener) },
    { settingId: EXPORT_SETTING_IDS.orientation, event: "change", read: () => exportOrientationInput.value, addEventListener: (type, listener) => exportOrientationInput.addEventListener(type, listener) },
    { settingId: EXPORT_SETTING_IDS.paragraphIndent, event: "change", read: () => exportParagraphIndentInput.checked, addEventListener: (type, listener) => exportParagraphIndentInput.addEventListener(type, listener) },
    { settingId: EXPORT_SETTING_IDS.pageNumber, event: "change", read: () => exportPageNumberInput.checked, addEventListener: (type, listener) => exportPageNumberInput.addEventListener(type, listener) },
    { settingId: EXPORT_SETTING_IDS.headerLeft, event: "input", read: () => exportHeaderLeftInput.value, addEventListener: (type, listener) => exportHeaderLeftInput.addEventListener(type, listener) },
    { settingId: EXPORT_SETTING_IDS.headerCenter, event: "input", read: () => exportHeaderCenterInput.value, addEventListener: (type, listener) => exportHeaderCenterInput.addEventListener(type, listener) },
    { settingId: EXPORT_SETTING_IDS.headerRight, event: "input", read: () => exportHeaderRightInput.value, addEventListener: (type, listener) => exportHeaderRightInput.addEventListener(type, listener) }
  ], (message) => {
    restoreExportSettingsControls();
    exportStatus.dataset.state = "error";
    exportStatus.textContent = `書き出し設定を保存できませんでした: ${message}`;
  });
  exportButton.addEventListener("click", () => void executeCommand("maginalia.document.export"));
  exportPdfButton.addEventListener("click", () => void executeCommand("maginalia.document.exportPdf"));
  exportDocxButton.addEventListener("click", () => void executeCommand("maginalia.document.exportDocx"));
} else {
  exportButton.disabled = true;
  exportPdfButton.disabled = true;
  exportDocxButton.disabled = true;
  exportStatus.dataset.state = "error";
  exportStatus.textContent = "Markdown export is unavailable.";
}

if (!writingSmokeMode) {
  const repositoryApi = getRepositoryApi();
  const documentPort = workspaceController ?? projectController;
  if (!repositoryApi || !documentPort || !libraryController) {
    createRepositoryButton.disabled = true;
    openRepositoryButton.disabled = true;
    activateRepositoryButton.disabled = true;
    recordRepositoryHistoryButton.disabled = true;
    refreshRepositoryHistoryButton.disabled = true;
    repositoryHistoryEntry.disabled = true;
    openRepositoryHistoryButton.disabled = true;
    repositoryStatus.textContent = "Repository is unavailable.";
    repositoryError.textContent = "The Repository bridge is unavailable. Reload MAGINALIA to try again.";
    repositoryError.hidden = false;
  } else {
    repositoryController = new RepositoryController({
      api: repositoryApi,
      workspace: documentPort,
      library: libraryController,
      view: repositoryView,
      writing: { hasUnsavedChanges: () => controller.hasUnsavedChanges() }
    });
    commandRegistry.register({
      id: "maginalia.repository.create",
      title: "Create Repository",
      description: "Create a local Project, Workdesk, or Private Shelf repository.",
      category: "Repository",
      keywords: ["repository", "new", "create", "project", "workdesk", "shelf"],
      when: "repository.available && repository.idle"
    }, () => repositoryController?.create(
      repositoryKind.value as RepositoryKindOption,
      repositoryTitle.value
    ));
    commandRegistry.register({
      id: "maginalia.repository.open",
      title: "Open Repository",
      description: "Choose a local repository to inspect or activate.",
      category: "Repository",
      keywords: ["repository", "open", "folder", "project", "workdesk", "shelf"],
      when: "repository.available && repository.idle"
    }, () => repositoryController?.openRepository());
    commandRegistry.register({
      id: "maginalia.repository.activate",
      title: "Activate Repository",
      description: "Open the selected repository in its supported document or Shelf surface.",
      category: "Repository",
      keywords: ["repository", "activate", "use", "open", "shelf"],
      when: "repository.activationAvailable"
    }, () => repositoryController?.activateRepository());
    commandRegistry.register({
      id: "maginalia.repository.history.record",
      title: "Record Repository History",
      description: "Save the active local Repository state in History.",
      category: "Repository History",
      keywords: ["repository", "history", "snapshot", "save", "record"],
      when: "repository.historyAvailable"
    }, () => repositoryController?.recordHistory());
    commandRegistry.register({
      id: "maginalia.repository.history.refresh",
      title: "Refresh Repository History",
      description: "Reload saved History versions for the active Repository.",
      category: "Repository History",
      keywords: ["repository", "history", "refresh", "reload"],
      when: "repository.historyAvailable"
    }, () => repositoryController?.refreshHistory());
    commandRegistry.register({
      id: "maginalia.repository.history.openCopy",
      title: "Open Repository History Copy",
      description: "Open the selected saved History version as a copy.",
      category: "Repository History",
      keywords: ["repository", "history", "open", "copy", "restore"],
      when: "repository.historySelected"
    }, () => repositoryController?.openHistoryCopy());
    updateCommandContext();
    createRepositoryButton.addEventListener("click", () => {
      void executeCommand("maginalia.repository.create");
    });
    openRepositoryButton.addEventListener("click", () => {
      void executeCommand("maginalia.repository.open");
    });
    activateRepositoryButton.addEventListener("click", () => {
      void executeCommand("maginalia.repository.activate");
    });
    recordRepositoryHistoryButton.addEventListener("click", () => {
      void executeCommand("maginalia.repository.history.record");
    });
    refreshRepositoryHistoryButton.addEventListener("click", () => {
      void executeCommand("maginalia.repository.history.refresh");
    });
    repositoryHistoryEntry.addEventListener("change", () => {
      repositoryController?.selectHistory(repositoryHistoryEntry.value || null);
    });
    openRepositoryHistoryButton.addEventListener("click", () => {
      void executeCommand("maginalia.repository.history.openCopy");
    });
  }
}

if (writingSmokeMode) {
  commandAvailability.documentOpen = true;
  openMarkdownAction = async () => {
    await controller.open();
    updateSmokeTextForSmoke?.();
  };
} else if (workspaceController) {
  commandAvailability.documentOpen = true;
  openMarkdownAction = () => workspaceController?.openDocument();
} else if (projectController) {
  commandAvailability.documentOpen = true;
  const clearWorkdeskAfterProjectReplacement = (previousProjectId: string | undefined): void => {
    const project = projectController?.getState().project;
    if (!project || project.projectId === previousProjectId) return;
    activeWorkdesk = null;
    activeWorkdeskProjectIdentityId = null;
    activeWorkdeskRecovery = null;
    projectView.setProjectError(null);
    projectView.setProjectState(projectController.getState());
    updateCommandContext();
  };
  const openStandaloneProject = (): void => {
    if (activeWorkdesk) {
      void commandRegistry.execute("maginalia.workdesk.registerProject", commandContext.snapshot());
      return;
    }
    const previousProjectId = projectController.getState().project?.projectId;
    void projectController.openProject().then(() => clearWorkdeskAfterProjectReplacement(previousProjectId));
  };
  commandRegistry.register({
    id: "maginalia.project.open",
    title: "Open another Project",
    description: "Choose a Project folder to open manually.",
    category: "Project",
    keywords: ["project", "open", "folder", "manual"]
  }, () => {
    setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
    openStandaloneProject();
  });
  openMarkdownAction = () => executeCommand("maginalia.project.open");
  openProjectButton.addEventListener("click", () => {
    void commandRegistry.execute("maginalia.project.open", commandContext.snapshot());
  });
  openWorkdeskButton.addEventListener("click", () => {
    setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
    void commandRegistry.execute("maginalia.workdesk.open", commandContext.snapshot());
  });
  createWorkdeskButton.addEventListener("click", () => {
    setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
    void commandRegistry.execute("maginalia.workdesk.create", commandContext.snapshot());
  });
  workdeskNewProjectButton.addEventListener("click", () => {
    void commandRegistry.execute("maginalia.workdesk.createProject", commandContext.snapshot());
  });
  workdeskRegisterProjectButton.addEventListener("click", () => {
    setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
    void commandRegistry.execute("maginalia.workdesk.registerProject", commandContext.snapshot());
  });
  workspaceRepairButton.addEventListener("click", () => {
    void commandRegistry.execute("maginalia.workdesk.open", commandContext.snapshot());
  });
  workdeskHomeButton.addEventListener("click", () => {
    void commandRegistry.execute("maginalia.workdesk.return", commandContext.snapshot());
  });
  openBundledManualButton.addEventListener("click", () => {
    setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
    void commandRegistry.execute("maginalia.help.openManual", commandContext.snapshot());
  });
}

updateCommandContext();
openButton.addEventListener("click", () => void executeCommand("maginalia.document.open"));

newFileTitle.addEventListener("input", () => {
  if (!selectedProjectDocumentType) return;
  const names = projectController?.getState().files.map((file) => file.displayName) ?? [];
  newFileName.value = createProjectFileName(newFileTitle.value, selectedProjectDocumentType, names);
});

newFileTitle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !selectedProjectDocumentType) return;
  event.preventDefault();
  newFileForm.requestSubmit();
});

async function submitProjectCreation(): Promise<void> {
  const navigation = projectController;
  if (!navigation) return;
  if (projectCreationFromWorkdesk) {
    const desk = activeWorkdesk;
    const api = getWorkdeskApi();
    if (!desk || !api) {
      projectView.setProjectError("Open a Workdesk before creating a Project.");
      return;
    }
    const workdeskIdentityId = desk.workdesk.workdeskIdentityId;
    const opened = await loadAndActivateWorkdeskProject(async () => {
      if (activeWorkdesk?.workdesk.workdeskIdentityId !== workdeskIdentityId) {
        projectView.setProjectError("The active Workdesk changed before the Project could be created.");
        return null;
      }
      return api.createWorkdeskProject({ workdeskIdentityId, title: createProjectTitle.value });
    });
    if (opened) cancelProjectCreation(false);
    return;
  }
  const previousProjectId = navigation.getState().project?.projectId;
  await navigation.createProject(createProjectTitle.value);
  const project = navigation.getState().project;
  if (project && project.projectId !== previousProjectId) {
    activeWorkdesk = null;
    activeWorkdeskProjectIdentityId = null;
    activeWorkdeskRecovery = null;
    projectView.setProjectError(null);
    projectView.setProjectState(navigation.getState());
    updateCommandContext();
    cancelProjectCreation(false);
  }
}

projectCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void executeCommand("maginalia.project.create");
});

newFileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void executeCommand("maginalia.explorer.createFile");
});

saveButton.addEventListener("click", () => void executeCommand("maginalia.document.save"));

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null && target.closest("dialog, .command-palette") !== null) return;
  const inMonaco = target !== null && target.closest(".monaco-editor") !== null;
  const inPreview = target !== null && previewContainer.contains(target);
  const inEditorSurface = inMonaco || inPreview;
  const inNativeInput = !inEditorSurface && target !== null
    && target.closest("input, textarea, select, [contenteditable='true']") !== null;

  if (!inNativeInput && event.key === "Escape" && workbench.isEditorOnly()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void executeCommand("maginalia.view.toggleEditorOnly");
    return;
  }

  const binding = parseKeyboardEvent(event);
  if (binding === null) return;
  const context = commandContext.snapshot();
  const entry = keybindingService.listBindings(context, true).find((candidate) => candidate.keybinding === binding);
  const quickOpenDefault = keybindingService.getDefaultBinding("maginalia.workbench.showQuickOpen");
  const shadowedQuickOpenDefault = binding === quickOpenDefault
    && keybindingService.getShadowedDefaultBindings().includes(binding);
  if (inNativeInput) {
    const saveDefault = keybindingService.getDefaultBinding("maginalia.document.save");
    const shadowedSaveDefault = binding === saveDefault && keybindingService.getShadowedDefaultBindings().includes(binding);
    const nativeUndoRedoChord = [
      keybindingService.getDefaultBinding("maginalia.editor.undo"),
      keybindingService.getDefaultBinding("maginalia.editor.redo"),
      "Mod+Shift+Z"
    ].includes(binding);
    const decision = decideNativeInputKeybinding({
      commandId: entry?.commandId ?? null,
      enabled: entry?.enabled ?? false,
      shadowedSaveDefault,
      nativeUndoRedoChord,
      shadowedQuickOpenDefault
    });
    if (decision === "block") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (decision === "native") return;
  }
  if (entry !== undefined) {
    if (!entry.enabled) {
      if (inEditorSurface || entry.commandId === "maginalia.workbench.showQuickOpen" || shadowedQuickOpenDefault) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    const command = keybindingService.getCommandForKeybinding(binding, context);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (command !== null) void executeCommand(command.id);
    return;
  }
  if (shadowedQuickOpenDefault) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (inEditorSurface && keybindingService.getShadowedDefaultBindings().includes(binding)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, { capture: true });
