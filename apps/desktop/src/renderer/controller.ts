import {
  createSaveSnapshot,
  insertQuoteRef as createQuoteRefInsertion,
  insertQuotation as createQuotationInsertion,
  isDirty,
  type DocumentId,
  type DocumentState,
  type QuoteRef,
  type QuoteRefInsertionResult,
  type QuotationInsertionInput,
  type QuotationInsertionResult
} from "@maginalia/writing-core";
import type {
  OpenMarkdownSuccess,
  OpenMarkdownResult,
  SaveMarkdownResult
} from "../markdown-ipc";
import type { MarkdownPreloadApi } from "../preload-api";
import {
  DocumentSessionStore,
  type DocumentSession,
  type DocumentSessionChange,
  type DocumentViewInstance
} from "./document-sessions";
import type {
  AutosaveFlushResult,
  AutosaveStatus,
  AutosaveStatusChange
} from "./autosave-coordinator";

export interface WritingSurface {
  replaceDocument(text: string): void;
  getText(): string;
  getLineEnding?(): WritingTextLineEnding;
  getSelection(): WritingTextRange;
  applyEdit(range: WritingTextRange, text: string, selection: WritingTextRange): void;
  onTextChange(listener: (text: string) => void): () => void;
  onSelectionChange?(listener: (range: WritingTextRange) => void): () => void;
  focus(): void;
  /** Optional editor command capability; the controller never exposes Monaco. */
  undo?(): void;
  redo?(): void;
  find?(): void;
  findReplace?(): void;
}

export type WritingTextLineEnding = "\n" | "\r\n" | "\r";

/** UTF-16 offsets shared by Writing Core and the Monaco adapter. */
export interface WritingTextRange {
  readonly start: number;
  readonly end: number;
}

export interface CapturedInsertionTarget {
  readonly documentId: DocumentId;
  /** Local revision invalidates a target after any edit, open, or clear. */
  readonly revision: number;
  readonly range: WritingTextRange;
}

/** A Preview-originated UTF-16 patch against one rendered DocumentSession. */
export interface WritingSourceEditTarget extends CapturedInsertionTarget {
  readonly replacement: string;
}

export type WritingSourceEditResult =
  | { readonly kind: "applied"; readonly revision: number; readonly range: WritingTextRange }
  | WritingInsertionStaleFailure
  | WritingInsertionSurfaceFailure;

export interface WritingInsertionStaleFailure {
  readonly kind: "error";
  readonly code: "stale-target";
  readonly message: string;
}

export interface WritingInsertionSurfaceFailure {
  readonly kind: "error";
  readonly code: "surface-failed";
  readonly message: string;
}

export type WritingInsertionResult =
  | QuotationInsertionResult
  | QuoteRefInsertionResult
  | WritingInsertionStaleFailure
  | WritingInsertionSurfaceFailure;

export type WritingStatus =
  | { kind: "empty"; message: string }
  | { kind: "saved"; message: string }
  | { kind: "modified"; message: string }
  | { kind: "saving"; message: string }
  | { kind: "error"; message: string };

export interface WritingView {
  setDocumentName(name: string): void;
  setStatus(status: WritingStatus): void;
  setSaveEnabled(enabled: boolean): void;
}

export type WritingDocumentChangeListener = (document: DocumentState | null) => void;

export interface WritingControllerOptions {
  readonly api: MarkdownPreloadApi;
  readonly surface: WritingSurface;
  readonly view: WritingView;
  readonly confirmReplace: (displayName: string) => boolean | Promise<boolean>;
  /** Shared source of truth when a document has more than one view. */
  readonly sessionStore?: DocumentSessionStore;
  /** Optional lifecycle save coordinator. It delegates to this controller's save queue. */
  readonly autosave?: WritingAutosavePort;
}

/** Narrow lifecycle boundary; it intentionally carries no filesystem path. */
export interface WritingAutosavePort {
  flushDocument(documentId: DocumentId): Promise<AutosaveFlushResult>;
  /** Explicit Save and autosave use the same coordinator-owned pipeline. */
  manualSave?(documentId: DocumentId): Promise<AutosaveFlushResult>;
  /** Optional status stream used to render inactive-document state safely. */
  onStatusChange?(listener: (change: AutosaveStatusChange) => void): () => void;
}

interface SaveOperation {
  readonly id: number;
  readonly snapshot: ReturnType<typeof createSaveSnapshot>;
  queued: boolean;
  completion?: Promise<void>;
}

const NO_DOCUMENT_NAME = "No document open";

export class WritingController {
  private readonly api: MarkdownPreloadApi;
  private readonly surface: WritingSurface;
  private readonly view: WritingView;
  private readonly confirmReplace: WritingControllerOptions["confirmReplace"];
  private readonly removeTextListener: () => void;
  private readonly removeSelectionListener: (() => void) | undefined;
  private readonly store: DocumentSessionStore;
  private autosave: WritingAutosavePort | undefined;
  private removeAutosaveStatusListener: (() => void) | undefined;
  private readonly removeStoreListener: () => void;
  private activeDocumentId: DocumentId | null = null;
  private readonly currentSaves = new Map<DocumentId, SaveOperation>();
  /** Save failures belong to their document, not to whichever tab is active. */
  private readonly saveErrors = new Map<DocumentId, string>();
  /** Coordinator status is keyed by document so tab activation cannot leak it. */
  private readonly autosaveStatuses = new Map<DocumentId, AutosaveStatus>();
  private nextSaveId = 1;
  private replacingSurface = false;
  private errorMessage: string | undefined;
  private readonly documentChangeListeners = new Set<WritingDocumentChangeListener>();
  private readonly sessionChangeListeners = new Set<(change: DocumentSessionChange) => void>();
  private readonly selectionChangeListeners = new Set<(range: WritingTextRange) => void>();
  private externalSelection: WritingTextRange | undefined;

  public constructor(options: WritingControllerOptions) {
    this.api = options.api;
    this.surface = options.surface;
    this.view = options.view;
    this.confirmReplace = options.confirmReplace;
    this.store = options.sessionStore ?? new DocumentSessionStore();
    this.removeTextListener = this.surface.onTextChange((text) => this.handleTextChange(text));
    this.removeSelectionListener = this.surface.onSelectionChange?.((range) => {
      // A Monaco gesture takes ownership immediately; a Preview range must
      // never continue to shadow the active editor selection.
      this.externalSelection = undefined;
      this.notifySelectionChange(range);
    });
    this.removeStoreListener = this.store.onDidChange((change) => this.handleStoreChange(change));
    this.setAutosaveCoordinator(options.autosave ?? null);
    this.render();
  }

  public getDocumentState(documentId?: DocumentId): DocumentSession | null {
    return documentId === undefined ? this.getActiveSession() : this.store.getSession(documentId);
  }

  public hasUnsavedChanges(): boolean {
    const current = this.getActiveSession();
    return current !== null && isDirty(current);
  }

  public getSessionStore(): DocumentSessionStore {
    return this.store;
  }

  public getDocumentSessions(): readonly DocumentSession[] {
    return this.store.snapshot().sessions;
  }

  public getDocumentViews(): readonly DocumentViewInstance[] {
    return this.store.snapshot().views;
  }

  public onSessionChange(listener: (change: DocumentSessionChange) => void): () => void {
    this.sessionChangeListeners.add(listener);
    listener(this.store.snapshot());
    return () => this.sessionChangeListeners.delete(listener);
  }

  public onSelectionChange(listener: (range: WritingTextRange) => void): () => void {
    this.selectionChangeListeners.add(listener);
    listener(this.getSelection());
    return () => this.selectionChangeListeners.delete(listener);
  }

  /** Attach the already-created coordinator after the controller is constructed. */
  public setAutosaveCoordinator(autosave: WritingAutosavePort | null): void {
    this.removeAutosaveStatusListener?.();
    this.removeAutosaveStatusListener = undefined;
    this.autosave = autosave ?? undefined;
    this.autosaveStatuses.clear();
    if (autosave?.onStatusChange !== undefined) {
      this.removeAutosaveStatusListener = autosave.onStatusChange(({ documentId, status }) => {
        this.autosaveStatuses.set(documentId, status);
        this.render();
      });
    }
    this.render();
  }

  public activateDocument(documentId: DocumentId, region: "main" | "secondary" = "main"): boolean {
    const session = this.store.getSession(documentId);
    if (session === null) return false;
    const view = this.store.activateDocument(documentId, region);
    if (view === null) return false;
    this.setActiveDocumentId(documentId);
    this.replaceSurfaceForActiveSession(false);
    this.errorMessage = undefined;
    this.render();
    this.notifyDocumentChange();
    return true;
  }

  /** Open/activate a central view without dirty-switch confirmation. */
  public openDocumentView(documentId: DocumentId): DocumentViewInstance | null {
    const session = this.store.getSession(documentId);
    if (session === null) return null;
    const view = this.store.openView(documentId, { region: "main", groupId: "editor-group-1" });
    if (view === null) return null;
    this.setActiveDocumentId(documentId);
    this.replaceSurfaceForActiveSession(false);
    this.errorMessage = undefined;
    this.render();
    this.notifyDocumentChange();
    return view;
  }

  /** Reorder main tabs without activating, saving, or changing their source. */
  public moveMainDocumentViewBefore(instanceId: string, beforeInstanceId: string): boolean {
    return this.store.moveMainViewBefore(instanceId, beforeInstanceId);
  }

  public async closeDocumentView(
    instanceId: string,
    decide: (displayName: string) => "save" | "discard" | "cancel" | Promise<"save" | "discard" | "cancel">
  ): Promise<boolean> {
    const view = this.store.getView(instanceId);
    if (view === null) return false;
    const views = this.store.getViewsForDocument(view.documentId);
    const session = this.store.getSession(view.documentId);
    if (session === null) return false;

    // Closing a secondary/duplicate view never discards the shared session.
    if (views.length === 1 && isDirty(session)) {
      // Autosave gets the first chance to flush the latest revision. A normal
      // close therefore does not repeatedly prompt after a successful local
      // save. If the flush fails, retain the existing explicit safety choice
      // so the user can retry, discard deliberately, or cancel.
      const flushed = await this.flushWithAutosave(view.documentId);
      const afterFlush = this.store.getSession(view.documentId);
      if (!flushed && afterFlush !== null && isDirty(afterFlush)) {
        const decision = await decide(session.displayName);
        if (decision === "cancel") return false;
        if (decision === "save") {
          const saved = this.autosave === undefined
            ? await this.saveDocument(view.documentId).then(() => true).catch(() => false)
            : await this.flushWithAutosave(view.documentId);
          const afterSave = this.store.getSession(view.documentId);
          if (!saved || afterSave === null || isDirty(afterSave)) return false;
        } else {
          this.store.discardChanges(view.documentId);
        }
      }
    }

    this.store.closeView(instanceId);
    if (views.length === 1) this.store.removeSession(view.documentId);
    this.setActiveDocumentId(this.store.snapshot().activeDocumentId);
    this.replaceSurfaceForActiveSession(false);
    this.render();
    this.notifyDocumentChange();
    return true;
  }

  /** Subscribe to document changes without exposing the editor surface. */
  public onDocumentChange(listener: WritingDocumentChangeListener): () => void {
    this.documentChangeListeners.add(listener);
    return () => this.documentChangeListeners.delete(listener);
  }

  public captureInsertionTarget(): CapturedInsertionTarget | null {
    const current = this.getActiveSession();
    if (current === null) return null;
    const range = this.getSelection();
    return {
      documentId: current.documentId,
      revision: current.revision,
      range: { start: range.start, end: range.end }
    };
  }

  /** A primitive UTF-16 selection snapshot for command handlers. */
  public getSelection(): WritingTextRange {
    return this.externalSelection ?? this.surface.getSelection();
  }

  /** Report the active writing surface's EOL for source edits at an empty document tail. */
  public getLineEnding(): WritingTextLineEnding {
    return this.surface.getLineEnding?.() ?? "\n";
  }

  /** Current Preview-owned selection, if any; callers must not fall back to hidden Monaco. */
  public getExternalSelection(): WritingTextRange | null {
    return this.externalSelection ?? null;
  }

  /** Preview selection drives existing Markdown commands without a second model. */
  public setExternalSelection(range: WritingTextRange | null): void {
    const current = this.getActiveSession();
    if (range === null || current === null
      || !Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < 0 || range.end < range.start || range.end > current.currentText.length) {
      this.externalSelection = undefined;
    } else {
      this.externalSelection = { start: range.start, end: range.end };
    }
    this.notifySelectionChange(this.getSelection());
  }

  /** Apply a revision-checked Preview patch through WritingSurface and DocumentSession. */
  public applySourceEdit(target: WritingSourceEditTarget): WritingSourceEditResult {
    const current = this.getActiveSession();
    if (current === null || !this.isInsertionTargetCurrent(target)) {
      return { kind: "error", code: "stale-target", message: "The Preview edit is no longer current." };
    }
    const { start, end } = target.range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > current.currentText.length
      || typeof target.replacement !== "string") {
      return { kind: "error", code: "surface-failed", message: "The Preview edit range is invalid." };
    }
    const nextText = `${current.currentText.slice(0, start)}${target.replacement}${current.currentText.slice(end)}`;
    const nextOffset = start + target.replacement.length;
    const revisionBeforeEdit = current.revision;
    try {
      this.surface.applyEdit({ start, end }, target.replacement, { start: nextOffset, end: nextOffset });
    } catch {
      return { kind: "error", code: "surface-failed", message: "The Preview edit could not be applied." };
    }
    const surfaceEmittedChange = this.getActiveSession()?.revision !== revisionBeforeEdit;
    if (!surfaceEmittedChange) {
      this.store.updateText(current.documentId, nextText);
      this.saveErrors.delete(current.documentId);
    }
    this.externalSelection = { start: nextOffset, end: nextOffset };
    this.errorMessage = undefined;
    this.render();
    if (!surfaceEmittedChange) this.notifyDocumentChange();
    const updated = this.getActiveSession();
    if (updated === null) return { kind: "error", code: "surface-failed", message: "The Preview document is no longer available." };
    return { kind: "applied", revision: updated.revision, range: { start, end: nextOffset } };
  }

  /** Monaco remains behind WritingSurface; undo follows its normal edit stack. */
  public undo(): boolean {
    if (this.getActiveSession() === null || this.surface.undo === undefined) return false;
    this.surface.undo();
    return true;
  }

  public redo(): boolean {
    if (this.getActiveSession() === null || this.surface.redo === undefined) return false;
    this.surface.redo();
    return true;
  }

  /** Open Monaco's native Find widget for the active source document. */
  public find(): boolean {
    if (this.getActiveSession() === null || this.surface.find === undefined) return false;
    this.surface.find();
    return true;
  }

  /** Open Monaco's native Find and Replace widget for the active source document. */
  public findReplace(): boolean {
    if (this.getActiveSession() === null || this.surface.findReplace === undefined) return false;
    this.surface.findReplace();
    return true;
  }

  public isInsertionTargetCurrent(target: CapturedInsertionTarget | null): boolean {
    const current = this.getActiveSession();
    return current !== null
      && target !== null
      && typeof target === "object"
      && current.documentId === target.documentId
      && current.revision === target.revision;
  }

  public insertQuotation(
    target: CapturedInsertionTarget,
    input: QuotationInsertionInput
  ): WritingInsertionResult {
    return this.applyInsertion(
      target,
      (current, targetRange) => createQuotationInsertion(current, targetRange, input),
      "The quotation could not be inserted into the editor."
    );
  }

  /**
   * Insert a stable QuoteRef through the same captured-target and Writing
   * Surface boundary as legacy literal quotations.  The Shelf never receives
   * or manipulates the Monaco surface directly.
   */
  public insertQuoteRef(
    target: CapturedInsertionTarget,
    input: QuoteRef
  ): WritingInsertionResult {
    return this.applyInsertion(
      target,
      (current, targetRange) => createQuoteRefInsertion(current, targetRange, input),
      "The QuoteRef could not be inserted into the editor."
    );
  }

  /**
   * Insert a renderer-owned, already-validated Markdown token through the
   * same captured selection and WritingSurface path as QuoteRef insertion.
   * This is intentionally not a filesystem capability: callers supply text
   * only, so DnD imports still enter DocumentSession/Autosave normally.
   */
  public insertMarkdownText(target: CapturedInsertionTarget, text: string): boolean {
    const current = this.getActiveSession();
    if (current === null || !this.isInsertionTargetCurrent(target) || typeof text !== "string") return false;
    const range = target.range;
    const nextText = `${current.currentText.slice(0, range.start)}${text}${current.currentText.slice(range.end)}`;
    const revisionBeforeEdit = current.revision;
    try {
      this.surface.applyEdit(range, text, {
        start: range.start + text.length,
        end: range.start + text.length
      });
    } catch {
      return false;
    }
    const surfaceEmittedChange = this.getActiveSession()?.revision !== revisionBeforeEdit;
    if (!surfaceEmittedChange) {
      this.store.updateText(current.documentId, nextText);
      this.saveErrors.delete(current.documentId);
    }
    this.errorMessage = undefined;
    this.render();
    if (!surfaceEmittedChange) this.notifyDocumentChange();
    return true;
  }

  private applyInsertion(
    target: CapturedInsertionTarget,
    createInsertion: (
      current: DocumentState,
      target: { readonly documentId: DocumentId; readonly start: number; readonly end: number }
    ) => QuotationInsertionResult | QuoteRefInsertionResult,
    surfaceFailureMessage: string
  ): WritingInsertionResult {
    const current = this.getActiveSession();
    if (current === null
      || target === null
      || typeof target !== "object"
      || current.documentId !== target.documentId
      || current.revision !== target.revision) {
      return {
        kind: "error",
        code: "stale-target",
        message: "The quotation target is no longer current."
      };
    }

    const targetRange = target.range;
    if (targetRange === null || typeof targetRange !== "object") {
      return {
        kind: "error",
        code: "invalid-range",
        message: "The quotation selection is outside the current document."
      };
    }

    const result = createInsertion(current, {
      documentId: target.documentId,
      start: targetRange.start,
      end: targetRange.end
    });
    if (result.kind !== "inserted") return result;

    const revisionBeforeEdit = current.revision;
    try {
      this.surface.applyEdit(
        targetRange,
        result.insertedText,
        { start: result.selectionStart, end: result.selectionEnd }
      );
    } catch (_error: unknown) {
      return {
        kind: "error",
        code: "surface-failed",
        message: surfaceFailureMessage
      };
    }

    // Monaco emits the normal text-change event synchronously. A small test
    // surface may not, so keep the Core state correct in either case.
    const surfaceEmittedChange = this.getActiveSession()?.revision !== revisionBeforeEdit;
    if (!surfaceEmittedChange) {
      this.store.updateText(target.documentId, result.state.currentText);
      this.saveErrors.delete(target.documentId);
    }
    this.errorMessage = undefined;
    this.render();
    if (!surfaceEmittedChange) this.notifyDocumentChange();
    return result;
  }

  /**
   * Apply one complete-document edit through the WritingSurface boundary.
   * Consumers such as derived-reference refresh must not touch Monaco.
   */
  public replaceText(nextText: string): boolean {
    const current = this.getActiveSession();
    if (current === null || typeof nextText !== "string" || nextText === current.currentText) {
      return false;
    }

    const currentSelection = this.getSelection();
    const clamp = (offset: number): number => Math.max(0, Math.min(nextText.length, offset));
    const revisionBeforeEdit = current.revision;
    // Monaco stores a UTF-8 BOM as model metadata. `getText()` exposes that
    // character to Writing Core, but inserting it through executeEdits would
    // create a second BOM. Keep the authoring text unchanged while passing
    // only the model payload through the surface boundary.
    const surfaceText = current.currentText.startsWith("\uFEFF") && nextText.startsWith("\uFEFF")
      ? nextText.slice(1)
      : nextText;
    try {
      this.surface.applyEdit(
        { start: 0, end: current.currentText.length },
        surfaceText,
        { start: clamp(currentSelection.start), end: clamp(currentSelection.end) }
      );
    } catch (_error: unknown) {
      return false;
    }

    // Monaco emits the normal text-change event synchronously. A small test
    // surface may not, so keep the Core state correct in either case.
    const surfaceEmittedChange = this.getActiveSession()?.revision !== revisionBeforeEdit;
    if (!surfaceEmittedChange) {
      this.store.updateText(current.documentId, nextText);
      this.saveErrors.delete(current.documentId);
    }
    this.errorMessage = undefined;
    this.render();
    if (!surfaceEmittedChange) this.notifyDocumentChange();
    return true;
  }

  public async open(): Promise<void> {
    const current = this.getActiveSession();
    if (current && isDirty(current) && !(await this.confirmReplace(current.displayName))) {
      this.render();
      return;
    }

    let result: OpenMarkdownResult;
    try {
      result = await this.api.openMarkdown();
    } catch (_error: unknown) {
      this.showError("The Markdown file could not be opened. Try again.");
      return;
    }

    if (result.kind === "cancelled") {
      this.render();
      return;
    }
    if (result.kind !== "opened") {
      this.showError(result.message);
      return;
    }

    this.applyOpenedDocument(result);
  }

  public applyOpenedDocument(result: OpenMarkdownSuccess): void {
    this.errorMessage = undefined;
    const session = this.store.openSession({
      documentId: result.sessionId,
      displayName: result.displayName,
      text: result.text
    });
    this.setActiveDocumentId(session.documentId);
    this.store.openView(session.documentId, { region: "main", groupId: "editor-group-1" });
    this.replaceSurfaceForActiveSession(true);
    this.render();
    this.notifyDocumentChange();
    this.surface.focus();
  }

  public clearDocument(): void {
    this.errorMessage = undefined;
    const active = this.activeDocumentId;
    if (active !== null) {
      for (const view of this.store.getViewsForDocument(active)) this.store.closeView(view.instanceId);
      this.store.removeSession(active);
      this.currentSaves.delete(active);
      this.saveErrors.delete(active);
    }
    this.setActiveDocumentId(null);
    this.replacingSurface = true;
    try {
      this.surface.replaceDocument("");
    } finally {
      this.replacingSurface = false;
    }
    this.render();
    this.notifyDocumentChange();
  }

  /** Close every view/session when switching the owning Project/Document. */
  public clearDocuments(): void {
    this.errorMessage = undefined;
    for (const view of this.store.snapshot().views) this.store.closeView(view.instanceId);
    for (const session of this.store.snapshot().sessions) {
      this.currentSaves.delete(session.documentId);
      this.saveErrors.delete(session.documentId);
      this.store.removeSession(session.documentId);
    }
    this.setActiveDocumentId(null);
    this.replacingSurface = true;
    try {
      this.surface.replaceDocument("");
    } finally {
      this.replacingSurface = false;
    }
    this.render();
    this.notifyDocumentChange();
  }

  public save(): Promise<void> {
    const current = this.getActiveSession();
    if (!current || !isDirty(current)) return Promise.resolve();

    // Manual Save consumes the coordinator's pending debounce and shares its
    // in-flight/revision-safe queue. The flush fallback keeps focused hosts
    // and legacy tests compatible with the pre-manualSave port.
    const autosave = this.autosave;
    const manualSave = autosave?.manualSave ?? autosave?.flushDocument;
    if (manualSave !== undefined) {
      return manualSave.call(autosave, current.documentId).then(() => undefined);
    }
    return this.saveDocument(current.documentId);
  }

  /**
   * Save one document through the existing serialized save pipeline.
   *
   * This is public for renderer-local orchestration such as Autosave. It
   * accepts only the opaque DocumentId; filesystem paths never cross this
   * boundary and the queue remains owned by this controller.
   */
  public saveDocument(documentId: DocumentId): Promise<void> {
    const current = this.store.getSession(documentId);
    if (!current || !isDirty(current)) return Promise.resolve();

    const active = this.currentSaves.get(documentId);
    if (active && active.snapshot.documentId === current.documentId) {
      active.queued = true;
      this.render();
      return active.completion ?? Promise.resolve();
    }
    if (active) return Promise.resolve();

    const operation: SaveOperation = {
      id: this.nextSaveId++,
      snapshot: createSaveSnapshot(current),
      queued: false
    };
    const completion = this.executeSave(operation).then(() => {
      if (this.currentSaves.get(operation.snapshot.documentId)?.id !== operation.id) return;

      const followUp = operation.queued
        && this.store.getSession(operation.snapshot.documentId) !== null
        && isDirty(this.store.getSession(operation.snapshot.documentId)!);
      this.currentSaves.delete(operation.snapshot.documentId);
      if (followUp) {
        return this.saveDocument(operation.snapshot.documentId);
      }
      this.render();
    });
    operation.completion = completion;
    this.currentSaves.set(documentId, operation);
    this.render();
    return completion;
  }

  /** Wait for the currently active save operation, if any. */
  public waitForSave(documentId: DocumentId): Promise<void> {
    return this.currentSaves.get(documentId)?.completion ?? Promise.resolve();
  }

  private async flushWithAutosave(documentId: DocumentId): Promise<boolean> {
    if (this.autosave === undefined) {
      // Preserve the pre-autosave close path when the optional coordinator is
      // not wired (for example in focused controller tests or legacy hosts).
      return false;
    }
    try {
      const result = await this.autosave.flushDocument(documentId);
      return result.kind === "saved" || result.kind === "clean";
    } catch {
      return false;
    }
  }

  /** A save failure remains observable until a later edit or successful save. */
  public getSaveError(documentId: DocumentId): string | undefined {
    return this.saveErrors.get(documentId);
  }

  public dispose(): void {
    this.removeTextListener();
    this.removeSelectionListener?.();
    this.removeStoreListener();
    this.removeAutosaveStatusListener?.();
    this.removeAutosaveStatusListener = undefined;
  }

  private handleTextChange(text: string): void {
    if (this.replacingSurface || this.activeDocumentId === null) return;
    this.externalSelection = undefined;
    this.store.updateText(this.activeDocumentId, text);
    this.saveErrors.delete(this.activeDocumentId);
    this.errorMessage = undefined;
    this.render();
    this.notifyDocumentChange();
  }

  private getActiveSession(): DocumentSession | null {
    return this.activeDocumentId === null ? null : this.store.getSession(this.activeDocumentId);
  }

  /** Preview selection is valid only for the currently active document. */
  private setActiveDocumentId(documentId: DocumentId | null): void {
    if (this.activeDocumentId !== documentId) this.externalSelection = undefined;
    this.activeDocumentId = documentId;
  }

  private replaceSurfaceForActiveSession(focus: boolean): void {
    const session = this.getActiveSession();
    const nextText = session?.currentText ?? "";
    if (this.surface.getText() !== nextText) {
      this.replacingSurface = true;
      try {
        this.surface.replaceDocument(nextText);
      } finally {
        this.replacingSurface = false;
      }
    }
    if (focus) this.surface.focus();
  }

  private handleStoreChange(change: DocumentSessionChange): void {
    const active = change.activeDocumentId;
    this.setActiveDocumentId(active);
    const liveDocumentIds = new Set(change.sessions.map((session) => session.documentId));
    for (const documentId of this.autosaveStatuses.keys()) {
      if (!liveDocumentIds.has(documentId)) this.autosaveStatuses.delete(documentId);
    }
    this.replaceSurfaceForActiveSession(false);
    this.render();
    for (const listener of this.sessionChangeListeners) {
      try { listener(change); } catch { /* observers cannot break the store */ }
    }
  }

  private notifyDocumentChange(): void {
    for (const listener of this.documentChangeListeners) {
      try {
        listener(this.getActiveSession());
      } catch {
        // A view listener must not interrupt editor state transitions.
      }
    }
  }

  private notifySelectionChange(range: WritingTextRange): void {
    for (const listener of this.selectionChangeListeners) {
      try { listener(range); } catch { /* selection observers are isolated */ }
    }
  }

  private async executeSave(operation: SaveOperation): Promise<void> {
    let result: SaveMarkdownResult;
    try {
      result = await this.api.saveMarkdown({
        sessionId: operation.snapshot.documentId,
        text: operation.snapshot.text
      });
    } catch (_error: unknown) {
      if (this.currentSaves.get(operation.snapshot.documentId)?.id === operation.id) {
        this.showSaveError(operation.snapshot.documentId, "The Markdown file could not be saved. Try again.");
      }
      return;
    }

    if (this.currentSaves.get(operation.snapshot.documentId)?.id !== operation.id) return;

    if (result.kind === "saved"
      && result.sessionId === operation.snapshot.documentId
      && result.text === operation.snapshot.text) {
      this.store.confirmSave(operation.snapshot.documentId, operation.snapshot.text);
      this.saveErrors.delete(operation.snapshot.documentId);
      this.errorMessage = undefined;
      return;
    }

    if (result.kind === "conflict" || result.kind === "error") {
      this.showSaveError(operation.snapshot.documentId, result.message);
      return;
    }

    this.showSaveError(
      operation.snapshot.documentId,
      "The save confirmation did not match this draft. Try saving again."
    );
  }

  private showSaveError(documentId: DocumentId, message: string): void {
    this.saveErrors.set(documentId, message);
    this.render();
  }

  private showError(message: string): void {
    this.errorMessage = message;
    this.render();
  }

  private render(): void {
    const current = this.getActiveSession();
    this.view.setDocumentName(current?.displayName ?? NO_DOCUMENT_NAME);

    if (current === null) {
      this.view.setStatus({ kind: "empty", message: "No document open" });
      this.view.setSaveEnabled(false);
      return;
    }

    const savingCurrent = this.currentSaves.has(current.documentId);
    const autosaveStatus = this.autosaveStatuses.get(current.documentId);
    const autosaveStatusIsCurrent = autosaveStatus?.revision === current.revision;
    if (savingCurrent || (autosaveStatusIsCurrent && autosaveStatus?.kind === "saving")) {
      this.view.setStatus({ kind: "saving", message: "Saving…" });
    } else if (this.saveErrors.has(current.documentId)) {
      this.view.setStatus({ kind: "error", message: this.saveErrors.get(current.documentId)! });
    } else if (autosaveStatusIsCurrent && autosaveStatus?.kind === "error") {
      this.view.setStatus({ kind: "error", message: autosaveStatus.message });
    } else if (this.errorMessage !== undefined) {
      this.view.setStatus({ kind: "error", message: this.errorMessage });
    } else if (isDirty(current)) {
      this.view.setStatus({ kind: "modified", message: "Modified" });
    } else {
      this.view.setStatus({ kind: "saved", message: "Saved" });
    }

    this.view.setSaveEnabled(!savingCurrent && isDirty(current));
  }
}
