import type { OpenMarkdownResult, OpenMarkdownSuccess } from "../markdown-ipc";
import type {
  CreateProjectFileRequest,
  CreateProjectRequest,
  OpenProjectFileRequest,
  ProjectCreateResultWithCancel,
  ProjectFileCreateResultWithError,
  ProjectFileOpenResult,
  ProjectOpenResult,
  ProjectRestoreResult
} from "../project-ipc";
import type { ProjectFileCreated, ProjectFileSummary, ProjectOpened, ProjectSummary } from "../project-service";
import type { DocumentWorkspaceOpened } from "../document-workspace";
import type { WritingController } from "./controller";
import type {
  DirtySwitchDecision,
  DocumentActivationOutcome,
  RepositoryDocumentActivationResult,
  DirtySwitchContext,
  WorkspaceSwitchTarget
} from "./workspace-controller";

export interface ProjectNavigationApi {
  openProject(): Promise<ProjectOpenResult>;
  createProject(request: CreateProjectRequest): Promise<ProjectCreateResultWithCancel>;
  restoreProject(): Promise<ProjectRestoreResult>;
  openProjectFile(request: OpenProjectFileRequest): Promise<ProjectFileOpenResult>;
  createProjectFile(request: CreateProjectFileRequest): Promise<ProjectFileCreateResultWithError>;
}

export interface ProjectNavigationState {
  readonly project: ProjectSummary | null;
  readonly files: readonly ProjectFileSummary[];
  readonly activeFileId: string | null;
}

export interface ProjectNavigationView {
  setProjectState(state: ProjectNavigationState): void;
  setProjectError(message: string | null): void;
  setProjectIdentityRecovery?(recovery: NonNullable<ProjectOpened["folderIdentityRecovery"]> | null): void;
}

export interface ProjectNavigationControllerOptions {
  readonly api: ProjectNavigationApi;
  readonly writing: WritingController;
  readonly view: ProjectNavigationView;
  readonly decideDirtySwitch: (context: DirtySwitchContext) => DirtySwitchDecision | Promise<DirtySwitchDecision>;
  /** Tabs keep dirty sessions alive; legacy workspace callers may opt in to the old guard. */
  readonly confirmDocumentSwitch?: boolean;
  /** Flush all open sessions before replacing the owning Project. */
  readonly flushAllDocuments?: () => Promise<boolean>;
}

/** The bounded result shape returned by the opaque internal-link IPC. */
type InternalLinkOpenResult = OpenMarkdownSuccess | { readonly kind: string; readonly message?: string };

function isInternalLinkOpened(value: InternalLinkOpenResult): value is OpenMarkdownSuccess {
  return value.kind === "opened"
    && "sessionId" in value && typeof value.sessionId === "string"
    && "displayName" in value && typeof value.displayName === "string"
    && "text" in value && typeof value.text === "string";
}

const EMPTY_STATE: ProjectNavigationState = { project: null, files: [], activeFileId: null };
const OPEN_FAILED = "The Project folder could not be opened. Choose it again.";
const FILE_OPEN_FAILED = "The Markdown file could not be opened. Try again.";
const SWITCH_REQUIRES_CLEAN = "Save or discard the current manuscript before switching.";

function copyState(state: ProjectNavigationState): ProjectNavigationState {
  return { project: state.project, files: [...state.files], activeFileId: state.activeFileId };
}

function projectFileFromLegacy(file: { readonly manuscriptId: string; readonly displayName: string }): ProjectFileSummary {
  return {
    fileId: file.manuscriptId,
    displayName: file.displayName,
    documentType: "other",
    title: file.displayName.replace(/\.(?:md|markdown)$/iu, "")
  };
}

function projectFromLegacy(result: DocumentWorkspaceOpened): ProjectOpened {
  return {
    kind: "opened",
    project: { projectId: result.document.documentId, displayName: result.document.displayName },
    files: result.manuscripts.map(projectFileFromLegacy)
  };
}

export class ProjectNavigationController {
  private readonly api: ProjectNavigationApi;
  private readonly writing: WritingController;
  private readonly view: ProjectNavigationView;
  private readonly decideDirtySwitch: ProjectNavigationControllerOptions["decideDirtySwitch"];
  private readonly confirmDocumentSwitch: boolean;
  private readonly flushAllDocuments: ProjectNavigationControllerOptions["flushAllDocuments"];
  private state: ProjectNavigationState = EMPTY_STATE;
  private busy = false;
  private folderIdentityRecovery: NonNullable<ProjectOpened["folderIdentityRecovery"]> | null = null;
  private readonly openedFileIds = new Set<string>();
  private readonly fileSessionIds = new Map<string, string>();

  public constructor(options: ProjectNavigationControllerOptions) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.decideDirtySwitch = options.decideDirtySwitch;
    this.confirmDocumentSwitch = options.confirmDocumentSwitch ?? true;
    this.flushAllDocuments = options.flushAllDocuments;
    this.view.setProjectState(this.state);
    this.view.setProjectError(null);
  }

  public getState(): ProjectNavigationState {
    return copyState(this.state);
  }

  /** File IDs are project-relative opaque handles suitable for workspace persistence. */
  public getOpenedFileIds(): readonly string[] {
    return [...this.openedFileIds];
  }

  public getFileIdForSession(documentId: string): string | null {
    return [...this.fileSessionIds.entries()]
      .find(([, sessionId]) => sessionId === documentId)?.[0] ?? null;
  }

  /** Main editor session associated with a Project-relative opaque file ID. */
  public getSessionIdForFile(fileId: string): string | null {
    return this.fileSessionIds.get(fileId) ?? null;
  }

  /** Remove a file only after main process Trash confirmation and session close. */
  public removeDeletedFile(fileId: string): void {
    this.openedFileIds.delete(fileId);
    this.fileSessionIds.delete(fileId);
    const files = this.state.files.filter((file) => file.fileId !== fileId);
    const activeFileId = this.state.activeFileId === fileId ? null : this.state.activeFileId;
    this.replaceState({ ...this.state, files, activeFileId });
  }

  public syncOpenDocuments(documentIds: readonly string[]): void {
    const orderedFileIds = documentIds.flatMap((sessionId) => {
      const fileId = [...this.fileSessionIds.entries()]
        .find(([, candidateSessionId]) => candidateSessionId === sessionId)?.[0];
      return fileId === undefined ? [] : [fileId];
    });
    this.openedFileIds.clear();
    for (const fileId of orderedFileIds) this.openedFileIds.add(fileId);
  }

  public syncActiveDocument(documentId: string | null): void {
    if (documentId === null) return;
    const fileId = [...this.fileSessionIds.entries()]
      .find(([, sessionId]) => sessionId === documentId)?.[0];
    if (fileId === undefined || fileId === this.state.activeFileId) return;
    if (!this.state.files.some((file) => file.fileId === fileId)) return;
    this.replaceState({ ...this.state, activeFileId: fileId });
  }

  /** Refreshes the existing Project view state after a source-owned metadata edit. */
  public updateActiveFileMetadata(documentId: string, metadata: Pick<ProjectFileSummary, "title" | "documentType">): void {
    const fileId = this.getFileIdForSession(documentId);
    if (fileId === null) return;
    const files = this.state.files.map((file) => file.fileId === fileId ? { ...file, ...metadata } : file);
    this.replaceState({ ...this.state, files });
  }

  public restoreProject(): Promise<void> {
    return this.run(async () => {
      if (!(await this.canSwitch({ kind: "document" }))) return;
      let result: ProjectRestoreResult;
      try {
        result = await this.api.restoreProject();
      } catch (_error: unknown) {
        this.showError(OPEN_FAILED);
        return;
      }
      if (result.kind === "none") return;
      if (result.kind !== "opened") {
        this.showError(result.message);
        return;
      }
      await this.applyProject(result);
    });
  }

  public openProject(): Promise<void> {
    return this.run(async () => {
      if (!(await this.canSwitch({ kind: "document" }))) return;
      let result: ProjectOpenResult;
      try {
        result = await this.api.openProject();
      } catch (_error: unknown) {
        this.showError(OPEN_FAILED);
        return;
      }
      if (result.kind === "cancelled") return;
      if (result.kind !== "opened") {
        this.showError(result.message);
        return;
      }
      await this.applyProject(result);
    });
  }

  /**
   * Bounded parent-navigation handoff used by Workdesk loose documents.  The
   * caller has already received an IPC result whose root was validated in the
   * main process; it never supplies a path to this controller.
   */
  public activateOpenedProject(result: ProjectOpened): Promise<boolean> {
    if (this.busy) return Promise.resolve(false);
    this.busy = true;
    return (async () => {
      if (!(await this.canSwitch({ kind: "document" }))) return false;
      return this.applyProject(result);
    })().catch(() => {
      this.showError(OPEN_FAILED);
      return false;
    }).finally(() => {
      this.busy = false;
    });
  }

  /** Defer an owner-changing Project load until the current Project can be replaced safely. */
  public activateProjectFromLoader(load: () => Promise<ProjectOpened | null>): Promise<boolean> {
    if (this.busy) return Promise.resolve(false);
    this.busy = true;
    return (async () => {
      if (!(await this.canSwitch({ kind: "document" }))) return false;
      let result: ProjectOpened | null;
      try {
        result = await load();
      } catch (_error: unknown) {
        this.showError(OPEN_FAILED);
        return false;
      }
      return result === null ? false : this.applyProject(result);
    })().catch(() => {
      this.showError(OPEN_FAILED);
      return false;
    }).finally(() => {
      this.busy = false;
    });
  }

  public createProject(title: string): Promise<void> {
    return this.run(async () => {
      if (!(await this.canSwitch({ kind: "document" }))) return;
      let result: ProjectCreateResultWithCancel;
      try {
        result = await this.api.createProject({ title });
      } catch (_error: unknown) {
        this.showError("The Project could not be created. Try again.");
        return;
      }
      if (result.kind === "cancelled") return;
      if (result.kind !== "opened") {
        this.showError(result.message);
        return;
      }
      await this.applyProject(result);
    });
  }

  public createFile(request: Omit<CreateProjectFileRequest, "projectId">): Promise<void> {
    return this.run(async () => {
      const project = this.state.project;
      if (!project) {
        this.showError("Open a Project before creating a Markdown file.");
        return;
      }
      if (!(await this.canSwitch({ kind: "manuscript", displayName: request.fileName }))) return;
      let result: ProjectFileCreateResultWithError;
      try {
        result = await this.api.createProjectFile({ ...request, projectId: project.projectId });
      } catch (_error: unknown) {
        this.showError("The Markdown file could not be created. Try another name.");
        return;
      }
      if (result.kind !== "created") {
        this.showError(result.message);
        return;
      }
      const previousActive = this.state.activeFileId;
      this.replaceState({
        project: result.project,
        files: result.files,
        activeFileId: result.files.some((file) => file.fileId === previousActive) ? previousActive : null
      });
      await this.openFileNow(result.file.fileId);
    });
  }

  /** Apply a main-process file creation result without replacing open tabs. */
  public applyCreatedFile(result: ProjectFileCreated): Promise<void> {
    return this.run(async () => {
      const previousActive = this.state.activeFileId;
      this.replaceState({
        project: result.project,
        files: result.files,
        activeFileId: result.files.some((file) => file.fileId === previousActive) ? previousActive : null
      });
      await this.openFileNow(result.file.fileId);
    });
  }

  public openFile(fileId: string): Promise<void> {
    return this.run(() => this.openFileNow(fileId));
  }

  /**
   * Activate an already-open internal-link target or open the target through
   * the caller's opaque main-process capability.  This deliberately takes a
   * file ID rather than a path and uses the same DocumentSession/tab map as
   * Registry activation, so it cannot create a duplicate editable view.
   */
  public openInternalLink(
    fileId: string,
    load: () => Promise<InternalLinkOpenResult>,
  ): Promise<void> {
    return this.run(async () => {
      const project = this.state.project;
      if (!project) {
        this.showError("Open a Project before opening an internal link.");
        return;
      }
      const knownSessionId = this.fileSessionIds.get(fileId);
      if (knownSessionId !== undefined) {
        this.writing.activateDocument(knownSessionId);
        this.replaceState({ ...this.state, activeFileId: fileId });
        this.showError(null);
        return;
      }
      let result: InternalLinkOpenResult;
      try {
        result = await load();
      } catch {
        this.showError("The linked Markdown document could not be opened.");
        return;
      }
      if (!isInternalLinkOpened(result)) {
        this.showError(result.message ?? "The linked Markdown document could not be opened.");
        return;
      }
      this.writing.applyOpenedDocument(result);
      this.openedFileIds.add(fileId);
      this.fileSessionIds.set(fileId, result.sessionId);
      this.replaceState({ ...this.state, activeFileId: fileId });
      this.showError(null);
    });
  }

  /** Repository handoff adapter retained for the existing Repository feature. */
  public openDocumentFromRepository(
    load: () => Promise<RepositoryDocumentActivationResult>
  ): Promise<DocumentActivationOutcome> {
    if (this.busy) return Promise.resolve("cancelled");
    this.busy = true;
    return (async () => {
      if (!(await this.canSwitch({ kind: "document" }))) return "cancelled" as const;
      let result: RepositoryDocumentActivationResult;
      try {
        result = await load();
      } catch (_error: unknown) {
        this.showError(OPEN_FAILED);
        return "failed" as const;
      }
      if (result.kind === "cancelled") return "cancelled" as const;
      if (result.kind !== "opened") {
        this.showError(result.message);
        return "failed" as const;
      }
      const project = projectFromLegacy(result);
      if (!(await this.applyProject(project))) return "failed" as const;
      return "activated" as const;
    })().finally(() => {
      this.busy = false;
    });
  }

  private async applyProject(result: ProjectOpened): Promise<boolean> {
    this.folderIdentityRecovery = result.folderIdentityRecovery ?? null;
    this.view.setProjectIdentityRecovery?.(this.folderIdentityRecovery);
    const first = result.files[0];
    if (!first) {
      this.openedFileIds.clear();
      this.fileSessionIds.clear();
      this.writing.clearDocuments();
      this.replaceState({ project: result.project, files: result.files, activeFileId: null });
      this.showError(null);
      return true;
    }

    let opened: ProjectFileOpenResult;
    try {
      opened = await this.api.openProjectFile({ projectId: result.project.projectId, fileId: first.fileId });
    } catch (_error: unknown) {
      this.showError(FILE_OPEN_FAILED);
      return false;
    }
    if (opened.kind !== "opened") {
      this.showError(opened.kind === "error" ? opened.message : FILE_OPEN_FAILED);
      return false;
    }
    this.writing.clearDocuments();
    this.openedFileIds.clear();
    this.fileSessionIds.clear();
    this.writing.applyOpenedDocument(opened);
    this.openedFileIds.add(first.fileId);
    this.fileSessionIds.set(first.fileId, opened.sessionId);
    this.replaceState({ project: result.project, files: result.files, activeFileId: first.fileId });
    this.showError(null);
    return true;
  }

  private async openFileNow(fileId: string): Promise<void> {
    const project = this.state.project;
    if (!project) {
      this.showError("Open a Project before choosing a file.");
      return;
    }
    const file = this.state.files.find((candidate) => candidate.fileId === fileId);
    if (!file) {
      this.showError("That Markdown file is not available in the current Project.");
      return;
    }
    const knownSessionId = this.fileSessionIds.get(file.fileId);
    if (knownSessionId !== undefined) {
      if (this.writing.activateDocument(knownSessionId)) {
        if (file.fileId !== this.state.activeFileId) {
          this.replaceState({ ...this.state, activeFileId: file.fileId });
        }
        this.showError(null);
        return;
      }
      // A tab may have been closed outside this controller. Do not let the
      // stale file-to-session mapping turn a normal Explorer open into a no-op.
      this.fileSessionIds.delete(file.fileId);
      this.openedFileIds.delete(file.fileId);
    }
    if (!(await this.canSwitch({ kind: "manuscript", displayName: file.displayName }))) return;

    let result: ProjectFileOpenResult;
    try {
      result = await this.api.openProjectFile({ projectId: project.projectId, fileId: file.fileId });
    } catch (_error: unknown) {
      this.showError(FILE_OPEN_FAILED);
      return;
    }
    if (result.kind !== "opened") {
      this.showError(result.kind === "error" ? result.message : FILE_OPEN_FAILED);
      return;
    }
    this.writing.applyOpenedDocument(result);
    this.openedFileIds.add(file.fileId);
    this.fileSessionIds.set(file.fileId, result.sessionId);
    this.replaceState({ ...this.state, activeFileId: file.fileId });
    this.showError(null);
  }

  private async canSwitch(target: WorkspaceSwitchTarget): Promise<boolean> {
    // Opening another file inside the current Project is a tab activation and
    // must retain dirty sessions. A Project/Document replacement, however,
    // clears all sessions below, so flush inactive tabs before proceeding.
    if (target.kind === "document"
      && this.flushAllDocuments
      && this.writing.getDocumentSessions().length > 0) {
      let flushed = false;
      try {
        flushed = await this.flushAllDocuments();
      } catch {
        flushed = false;
      }
      if (!flushed) {
        this.showError(SWITCH_REQUIRES_CLEAN);
        return false;
      }
    }
    if (!this.confirmDocumentSwitch && target.kind === "manuscript") return true;
    if (!this.writing.hasUnsavedChanges()) return true;
    const current = this.writing.getDocumentState();
    if (!current) return true;
    let decision: DirtySwitchDecision;
    try {
      decision = await this.decideDirtySwitch({ currentDisplayName: current.displayName, target });
    } catch (_error: unknown) {
      this.showError(SWITCH_REQUIRES_CLEAN);
      return false;
    }
    if (decision === "discard") return true;
    if (decision !== "save") return false;
    try {
      await this.writing.save();
    } catch (_error: unknown) {
      this.showError(SWITCH_REQUIRES_CLEAN);
      return false;
    }
    if (this.writing.hasUnsavedChanges()) {
      this.showError(SWITCH_REQUIRES_CLEAN);
      return false;
    }
    return true;
  }

  private run(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return Promise.resolve();
    this.busy = true;
    return operation().catch((_error: unknown) => this.showError(OPEN_FAILED)).finally(() => {
      this.busy = false;
    });
  }

  private replaceState(state: ProjectNavigationState): void {
    this.state = copyState(state);
    this.view.setProjectState(this.state);
  }

  private showError(message: string | null): void {
    this.view.setProjectError(message);
  }
}
