import type { WritingController } from "./controller";
import type { ContextKeyService } from "./command-context";
import type { CommandRegistry } from "./command-registry";
import { insertLink, setBlockStyle, toggleInline, toggleLinePrefix } from "./markdown-commands";

export interface CoreCommandActions {
  readonly writing: WritingController;
  readonly setPreviewDirection: (direction: "horizontal" | "vertical") => void;
  readonly refreshReferences: () => void | Promise<void>;
  readonly exportMarkdown: () => void | Promise<void>;
  readonly exportPdf: () => void | Promise<void>;
  readonly exportDocx: () => void | Promise<void>;
  readonly saveDocument: () => void | Promise<void>;
  readonly contextKeys: ContextKeyService;
}

function currentTextEdit(writing: WritingController, transform: (text: string, start: number, end: number) => { readonly text: string; readonly changed: boolean }): void {
  const document = writing.getDocumentState();
  if (document === null) return;
  const selection = writing.getSelection();
  const result = transform(document.currentText, selection.start, selection.end);
  if (result.changed) writing.replaceText(result.text);
}

/** Register Core actions once.  Surfaces use these IDs instead of private handlers. */
export function registerCoreCommands(registry: CommandRegistry, actions: CoreCommandActions): void {
  const register = (id: string, title: string, handler: () => void | Promise<void>, category = "Editor", keywords: readonly string[] = [], when = "editor.hasDocument") => {
    registry.register({ id, title, category, keywords, when }, handler);
  };
  register("maginalia.editor.undo", "Undo", () => { actions.writing.undo(); }, "Editor", ["undo"]);
  register("maginalia.editor.redo", "Redo", () => { actions.writing.redo(); }, "Editor", ["redo"]);
  register("maginalia.editor.setParagraph", "Set Paragraph", () => currentTextEdit(actions.writing, (text, start, end) => setBlockStyle(text, start, end, 0)), "Editor", ["paragraph", "block"]);
  for (let level = 1; level <= 6; level += 1) {
    const heading = level;
    register(`maginalia.editor.setHeading${heading}`, `Set Heading ${heading}`, () => currentTextEdit(actions.writing, (text, start, end) => setBlockStyle(text, start, end, heading)), "Editor", [`h${heading}`, "heading", "block"]);
  }
  register("maginalia.editor.toggleBold", "Toggle Bold", () => currentTextEdit(actions.writing, (text, start, end) => toggleInline(text, start, end, "**")), "Editor", ["bold"], "editor.hasSelection");
  register("maginalia.editor.toggleItalic", "Toggle Italic", () => currentTextEdit(actions.writing, (text, start, end) => toggleInline(text, start, end, "*")), "Editor", ["italic"], "editor.hasSelection");
  register("maginalia.editor.toggleInlineCode", "Toggle Inline Code", () => currentTextEdit(actions.writing, (text, start, end) => toggleInline(text, start, end, "`")), "Editor", ["code"], "editor.hasSelection");
  register("maginalia.editor.toggleBulletList", "Toggle Bulleted List", () => currentTextEdit(actions.writing, (text, start, end) => toggleLinePrefix(text, start, end, "- ")), "Editor", ["bullet", "list"]);
  register("maginalia.editor.toggleNumberedList", "Toggle Numbered List", () => currentTextEdit(actions.writing, (text, start, end) => toggleLinePrefix(text, start, end, "1. ")), "Editor", ["number", "list"]);
  register("maginalia.editor.toggleBlockquote", "Toggle Blockquote", () => currentTextEdit(actions.writing, (text, start, end) => toggleLinePrefix(text, start, end, "> ")), "Editor", ["quote", "blockquote"]);
  register("maginalia.editor.insertInternalLink", "Insert Internal Link", () => currentTextEdit(actions.writing, (text, start, end) => insertLink(text, start, end, "internal")), "Editor", ["wiki", "link"]);
  register("maginalia.editor.insertExternalLink", "Insert External Link", () => currentTextEdit(actions.writing, (text, start, end) => insertLink(text, start, end, "external")), "Editor", ["url", "link"]);
  register("maginalia.document.save", "Save Document", actions.saveDocument, "Document", ["save"], "editor.hasDocument");
  register("maginalia.renderer.setHorizontal", "Set Horizontal Writing", () => actions.setPreviewDirection("horizontal"), "Renderer", ["horizontal", "orientation"]);
  register("maginalia.renderer.setVertical", "Set Vertical Writing", () => actions.setPreviewDirection("vertical"), "Renderer", ["vertical", "orientation"]);
  register("maginalia.references.refresh", "Refresh References", actions.refreshReferences, "References", ["bibliography", "quote"], "editor.hasDocument");
  // Export needs both a document and a wired export runtime; surfaces must not
  // offer an export that could only no-op.
  register("maginalia.document.export", "Export Markdown", actions.exportMarkdown, "Document", ["export", "markdown"], "editor.hasDocument && export.available");
  register("maginalia.document.exportPdf", "Export PDF", actions.exportPdf, "Document", ["export", "pdf"], "editor.hasDocument && export.available");
  register("maginalia.document.exportDocx", "Export DOCX", actions.exportDocx, "Document", ["export", "docx", "word"], "editor.hasDocument && export.available");
}
