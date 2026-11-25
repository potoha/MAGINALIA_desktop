import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import type { WritingSurface, WritingTextLineEnding, WritingTextRange } from "./controller";

(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

const MODEL_URI = monaco.Uri.parse("inmemory://maginalia/current.md");

export class MonacoMarkdownSurface implements WritingSurface {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly changeListeners = new Set<(text: string) => void>();
  private readonly selectionListeners = new Set<(range: WritingTextRange) => void>();
  private model: monaco.editor.ITextModel | undefined;
  private modelChangeSubscription: monaco.IDisposable | undefined;

  public constructor(container: HTMLElement) {
    this.editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontSize: 16,
      minimap: { enabled: false },
      padding: { top: 16, bottom: 16 },
      scrollBeyondLastLine: false,
      wordWrap: "on"
    });
    this.editor.onDidChangeCursorSelection(() => {
      const range = this.getSelection();
      for (const listener of this.selectionListeners) listener(range);
    });
    this.replaceDocument("");
  }

  public replaceDocument(text: string): void {
    this.modelChangeSubscription?.dispose();
    this.model?.dispose();
    this.model = monaco.editor.createModel(text, "markdown", MODEL_URI);
    this.editor.setModel(this.model);
    this.modelChangeSubscription = this.model.onDidChangeContent(() => {
      const value = this.getText();
      for (const listener of this.changeListeners) listener(value);
    });
  }

  public getText(): string {
    return this.model?.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) ?? "";
  }

  public getLineEnding(): WritingTextLineEnding {
    const lineEnding = this.model?.getEOL();
    return lineEnding === "\r\n" || lineEnding === "\n" ? lineEnding : "\n";
  }

  public getSelection(): WritingTextRange {
    const model = this.model;
    const selection = this.editor.getSelection();
    if (!model || !selection) return { start: 0, end: 0 };
    return {
      start: this.toDocumentOffset(model.getOffsetAt(selection.getStartPosition())),
      end: this.toDocumentOffset(model.getOffsetAt(selection.getEndPosition()))
    };
  }

  public applyEdit(range: WritingTextRange, text: string, selection: WritingTextRange): void {
    const model = this.model;
    if (!model) return;

    const start = model.getPositionAt(this.toModelOffset(range.start));
    const end = model.getPositionAt(this.toModelOffset(range.end));
    this.editor.pushUndoStop();
    this.editor.executeEdits("maginalia-quotation", [{
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text
    }], () => {
      const nextStart = model.getPositionAt(this.toModelOffset(selection.start));
      const nextEnd = model.getPositionAt(this.toModelOffset(selection.end));
      return [new monaco.Selection(
        nextStart.lineNumber,
        nextStart.column,
        nextEnd.lineNumber,
        nextEnd.column
      )];
    });
    this.editor.pushUndoStop();
  }

  public appendTextForSmoke(text: string): void {
    const model = this.model;
    if (!model) return;

    const end = model.getFullModelRange().getEndPosition();
    model.pushEditOperations([], [{
      range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column),
      text
    }], () => null);
  }

  /** Test-only cursor placement used by the real Electron quotation smoke. */
  public setCursorToEndForSmoke(): void {
    const model = this.model;
    if (!model) return;

    const position = model.getFullModelRange().getEndPosition();
    this.editor.setPosition(position);
    this.editor.revealPositionInCenterIfOutsideViewport(position);
    this.editor.focus();
  }

  public onTextChange(listener: (text: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public onSelectionChange(listener: (range: WritingTextRange) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  public focus(): void {
    this.editor.focus();
  }

  public undo(): void { this.editor.trigger("maginalia-command", "undo", undefined); }
  public redo(): void { this.editor.trigger("maginalia-command", "redo", undefined); }
  public find(): void { this.editor.trigger("maginalia-command", "actions.find", undefined); }
  public findReplace(): void {
    this.editor.trigger("maginalia-command", "editor.action.startFindReplaceAction", undefined);
  }

  public dispose(): void {
    this.modelChangeSubscription?.dispose();
    this.model?.dispose();
    this.editor.dispose();
    this.changeListeners.clear();
    this.selectionListeners.clear();
  }

  private hasUtf8Bom(): boolean {
    return this.model?.getValue(monaco.editor.EndOfLinePreference.TextDefined, true).startsWith("\uFEFF") ?? false;
  }

  /** Monaco keeps the BOM as model metadata; Core offsets include its string character. */
  private toDocumentOffset(offset: number): number {
    return this.hasUtf8Bom() ? offset + 1 : offset;
  }

  private toModelOffset(offset: number): number {
    return this.hasUtf8Bom() && offset > 0 ? offset - 1 : offset;
  }
}
