import { describe, expect, it, vi } from "vitest";
import { ContextKeyService } from "./command-context";
import { CommandRegistry } from "./command-registry";
import { registerCoreCommands } from "./core-commands";

function register(actions: {
  readonly refreshReferences?: () => void | Promise<void>;
  readonly exportMarkdown?: () => void | Promise<void>;
  readonly exportPdf?: () => void | Promise<void>;
  readonly exportDocx?: () => void | Promise<void>;
  readonly saveDocument?: () => void | Promise<void>;
} = {}) {
  const commands = new CommandRegistry();
  const contextKeys = new ContextKeyService();
  registerCoreCommands(commands, {
    writing: {
      getDocumentState: () => null,
      getSelection: () => ({ start: 0, end: 0 }),
      replaceText: () => false,
      undo: () => undefined,
      redo: () => undefined,
    } as never,
    setPreviewDirection: () => undefined,
    refreshReferences: actions.refreshReferences ?? (() => undefined),
    exportMarkdown: actions.exportMarkdown ?? (() => undefined),
    exportPdf: actions.exportPdf ?? (() => undefined),
    exportDocx: actions.exportDocx ?? (() => undefined),
    saveDocument: actions.saveDocument ?? (() => undefined),
    contextKeys,
  });
  return commands;
}

describe("Core command adapters", () => {
  it("uses the existing bold command for a mapped Preview source selection", async () => {
    const commands = new CommandRegistry();
    const contextKeys = new ContextKeyService();
    const replaceText = vi.fn(() => true);
    registerCoreCommands(commands, {
      writing: {
        getDocumentState: () => ({ documentId: "doc", displayName: "doc.md", currentText: "important text", savedText: "important text" }),
        getSelection: () => ({ start: 0, end: 9 }),
        replaceText,
        undo: () => undefined,
        redo: () => undefined,
      } as never,
      setPreviewDirection: () => undefined,
      refreshReferences: () => undefined,
      exportMarkdown: () => undefined,
      exportPdf: () => undefined,
      exportDocx: () => undefined,
      saveDocument: () => undefined,
      contextKeys,
    });
    await expect(commands.execute("maginalia.editor.toggleBold", { "editor.hasDocument": true, "editor.hasSelection": true }))
      .resolves.toEqual({ kind: "executed" });
    expect(replaceText).toHaveBeenCalledWith("**important** text");
    expect(commands.get("maginalia.preview.toggleBold")).toBeNull();
  });

  it("gives Save, Export, and References one stable command handler each", async () => {
    const saveDocument = vi.fn(async () => undefined);
    const exportMarkdown = vi.fn(async () => undefined);
    const exportPdf = vi.fn(async () => undefined);
    const exportDocx = vi.fn(async () => undefined);
    const refreshReferences = vi.fn(async () => undefined);
    const commands = register({ saveDocument, exportMarkdown, exportPdf, exportDocx, refreshReferences });
    const context = { "editor.hasDocument": true, "export.available": true };

    await expect(commands.execute("maginalia.document.save", context)).resolves.toEqual({ kind: "executed" });
    await expect(commands.execute("maginalia.document.export", context)).resolves.toEqual({ kind: "executed" });
    await expect(commands.execute("maginalia.document.exportPdf", context)).resolves.toEqual({ kind: "executed" });
    await expect(commands.execute("maginalia.document.exportDocx", context)).resolves.toEqual({ kind: "executed" });
    await expect(commands.execute("maginalia.references.refresh", context)).resolves.toEqual({ kind: "executed" });
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(exportMarkdown).toHaveBeenCalledOnce();
    expect(exportPdf).toHaveBeenCalledOnce();
    expect(exportDocx).toHaveBeenCalledOnce();
    expect(refreshReferences).toHaveBeenCalledOnce();
  });

  it("hides Export from discovery until the export runtime is available", async () => {
    const exportMarkdown = vi.fn();
    const commands = register({ exportMarkdown });
    const withoutRuntime = { "editor.hasDocument": true };
    for (const id of ["maginalia.document.export", "maginalia.document.exportPdf", "maginalia.document.exportDocx"]) {
      expect(commands.list(withoutRuntime).some((command) => command.id === id)).toBe(false);
      await expect(commands.execute(id, withoutRuntime)).resolves.toEqual({ kind: "disabled" });
      expect(commands.list({ ...withoutRuntime, "export.available": true }).some((command) => command.id === id)).toBe(true);
    }
    expect(exportMarkdown).not.toHaveBeenCalled();
  });

  it("awaits a failed Core action without breaking another registered action", async () => {
    const commands = register({ exportMarkdown: async () => { throw new Error("export failed"); } });
    const save = vi.fn();
    commands.register({ id: "maginalia.test.saveAfterFailure", title: "Save after failure" }, save);
    const context = { "editor.hasDocument": true, "export.available": true };

    await expect(commands.execute("maginalia.document.export", context)).resolves.toMatchObject({
      kind: "failed",
      error: { message: "export failed" },
    });
    await expect(commands.execute("maginalia.test.saveAfterFailure", context)).resolves.toEqual({ kind: "executed" });
    expect(save).toHaveBeenCalledOnce();
  });
});
