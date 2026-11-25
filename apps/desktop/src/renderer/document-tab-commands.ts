import type { CommandArgs, CommandRegistry } from "./command-registry";

export const ACTIVATE_DOCUMENT_COMMAND_ID = "maginalia.document.activate";
export const ACTIVATE_NEXT_DOCUMENT_COMMAND_ID = "maginalia.document.activateNext";
export const ACTIVATE_PREVIOUS_DOCUMENT_COMMAND_ID = "maginalia.document.activatePrevious";

export interface DocumentTabCommandDependencies {
  /** Opaque document IDs of the central tab strip, in visual order. */
  readonly listTabDocumentIds: () => readonly string[];
  readonly getActiveDocumentId: () => string | null;
  /** Activates an already-open document session; returns false when it is gone. */
  readonly activateDocument: (documentId: string) => boolean;
}

/** Wrap-around neighbour of the active tab, or null when cycling cannot change anything. */
export function adjacentTabDocumentId(
  documentIds: readonly string[],
  activeDocumentId: string | null,
  direction: 1 | -1
): string | null {
  if (documentIds.length < 2) return null;
  const index = activeDocumentId === null ? -1 : documentIds.indexOf(activeDocumentId);
  if (index < 0) return direction === 1 ? documentIds[0]! : documentIds[documentIds.length - 1]!;
  return documentIds[(index + direction + documentIds.length) % documentIds.length]!;
}

/**
 * Tab activation is a public user action: a tab click, the Palette, and
 * Ctrl+Tab shortcuts all converge on these command IDs.
 */
export function registerDocumentTabCommands(registry: CommandRegistry, dependencies: DocumentTabCommandDependencies): void {
  const activate = (documentId: string): void => {
    if (!dependencies.listTabDocumentIds().includes(documentId) || !dependencies.activateDocument(documentId)) {
      throw new Error("The document tab is no longer open.");
    }
  };
  registry.register({
    id: ACTIVATE_DOCUMENT_COMMAND_ID,
    title: "タブを切り替える",
    description: "Activate one open document tab by its opaque document ID.",
    category: "Document",
    keywords: ["tab", "switch", "activate", "タブ"],
    // Requires a target document, so it is not offered without arguments.
    visibility: "internal"
  }, (args?: CommandArgs) => {
    const documentId = args?.documentId;
    if (documentId === undefined || documentId.length === 0) throw new Error("Choose a document tab to activate.");
    activate(documentId);
  });
  for (const [id, title, direction, keywords] of [
    [ACTIVATE_NEXT_DOCUMENT_COMMAND_ID, "次のタブへ切り替え", 1, ["next", "tab", "switch", "次", "タブ"]],
    [ACTIVATE_PREVIOUS_DOCUMENT_COMMAND_ID, "前のタブへ切り替え", -1, ["previous", "tab", "switch", "前", "タブ"]]
  ] as const) {
    registry.register({
      id,
      title,
      description: direction === 1 ? "Activate the next open document tab." : "Activate the previous open document tab.",
      category: "Document",
      keywords,
      when: "document.multipleTabs"
    }, () => {
      const target = adjacentTabDocumentId(dependencies.listTabDocumentIds(), dependencies.getActiveDocumentId(), direction);
      if (target === null) throw new Error("Open another document tab first.");
      activate(target);
    });
  }
}
