import { describe, expect, it, vi } from "vitest";
import { matchesWhen } from "./command-context";
import { CommandRegistry } from "./command-registry";
import {
  ACTIVATE_DOCUMENT_COMMAND_ID,
  ACTIVATE_NEXT_DOCUMENT_COMMAND_ID,
  ACTIVATE_PREVIOUS_DOCUMENT_COMMAND_ID,
  adjacentTabDocumentId,
  registerDocumentTabCommands
} from "./document-tab-commands";
import {
  externalLinkUrlAtOffset,
  internalLinkTargetAtOffset,
  isOpenableExternalUrl,
  OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID,
  OPEN_EXTERNAL_LINK_COMMAND_ID,
  OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID,
  OPEN_INTERNAL_LINK_COMMAND_ID,
  registerLinkCommands,
  type LinkCommandDependencies
} from "./link-commands";
import {
  INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID,
  PROJECT_MARKDOWN_SEARCH_COMMAND_ID,
  registerSearchCommands,
  SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID,
  SHELF_SEARCH_COMMAND_ID,
  SHELF_SELECT_RESULT_COMMAND_ID,
  type SearchCommandDependencies
} from "./search-commands";
import { buildApplicationMenuSnapshot } from "./application-menu-snapshot";

const ids = (registry: CommandRegistry, context: Record<string, boolean | string>) =>
  registry.list(context).map((command) => command.id);

describe("Command Registry arguments", () => {
  it("passes a frozen copy of bounded string arguments to the handler", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({ id: "maginalia.test.target", title: "Target" }, handler);
    const args = { documentId: "doc-1" };

    await expect(registry.execute("maginalia.test.target", {}, args)).resolves.toEqual({ kind: "executed" });
    const received = handler.mock.calls[0]?.[0];
    expect(received).toEqual({ documentId: "doc-1" });
    expect(received).not.toBe(args);
    expect(Object.isFrozen(received)).toBe(true);
    await registry.execute("maginalia.test.target", {});
    expect(handler.mock.calls[1]?.[0]).toBeUndefined();
  });

  it("rejects non-string, oversized, or non-plain arguments without running the handler", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({ id: "maginalia.test.target", title: "Target" }, handler);
    for (const invalid of [{ documentId: 1 }, { path: "x".repeat(5_000) }, ["doc"], new Map([["documentId", "x"]]), { "bad-key": "x" }]) {
      await expect(registry.execute("maginalia.test.target", {}, invalid as never)).resolves.toMatchObject({ kind: "failed" });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("evaluates equality clauses on camelCase context keys", () => {
    expect(matchesWhen({ "editor.linkType": "internal" }, "editor.linkType == internal")).toBe(true);
    expect(matchesWhen({ "editor.linkType": "external" }, "editor.linkType == internal")).toBe(false);
    expect(matchesWhen({ "editor.linkType": "external" }, "editor.linkType != internal")).toBe(true);
  });
});

describe("Document tab commands", () => {
  function setup(tabs: string[], active: string | null) {
    const registry = new CommandRegistry();
    let current = active;
    const activateDocument = vi.fn((documentId: string) => {
      current = documentId;
      return true;
    });
    registerDocumentTabCommands(registry, {
      listTabDocumentIds: () => tabs,
      getActiveDocumentId: () => current,
      activateDocument
    });
    return { registry, activateDocument, active: () => current };
  }

  it("computes wrap-around neighbours and refuses to cycle a single tab", () => {
    expect(adjacentTabDocumentId(["a", "b", "c"], "c", 1)).toBe("a");
    expect(adjacentTabDocumentId(["a", "b", "c"], "a", -1)).toBe("c");
    expect(adjacentTabDocumentId(["a", "b", "c"], "missing", -1)).toBe("c");
    expect(adjacentTabDocumentId(["a"], "a", 1)).toBeNull();
  });

  it("activates a tab by opaque ID and keeps the argument form out of discovery", async () => {
    const { registry, activateDocument } = setup(["a", "b"], "a");
    expect(registry.get(ACTIVATE_DOCUMENT_COMMAND_ID)?.visibility).toBe("internal");
    expect(ids(registry, { "document.multipleTabs": true })).not.toContain(ACTIVATE_DOCUMENT_COMMAND_ID);
    await expect(registry.execute(ACTIVATE_DOCUMENT_COMMAND_ID, {}, { documentId: "b" })).resolves.toEqual({ kind: "executed" });
    expect(activateDocument).toHaveBeenCalledWith("b");
    await expect(registry.execute(ACTIVATE_DOCUMENT_COMMAND_ID, {}, { documentId: "closed" })).resolves.toMatchObject({ kind: "failed" });
    await expect(registry.execute(ACTIVATE_DOCUMENT_COMMAND_ID, {})).resolves.toMatchObject({ kind: "failed" });
  });

  it("offers next/previous only while several tabs are open", async () => {
    const { registry, active } = setup(["a", "b", "c"], "a");
    expect(ids(registry, {})).not.toContain(ACTIVATE_NEXT_DOCUMENT_COMMAND_ID);
    const context = { "document.multipleTabs": true };
    expect(ids(registry, context)).toEqual(expect.arrayContaining([ACTIVATE_NEXT_DOCUMENT_COMMAND_ID, ACTIVATE_PREVIOUS_DOCUMENT_COMMAND_ID]));
    await registry.execute(ACTIVATE_NEXT_DOCUMENT_COMMAND_ID, context);
    expect(active()).toBe("b");
    await registry.execute(ACTIVATE_PREVIOUS_DOCUMENT_COMMAND_ID, context);
    await registry.execute(ACTIVATE_PREVIOUS_DOCUMENT_COMMAND_ID, context);
    expect(active()).toBe("c");
  });
});

describe("Link commands", () => {
  const text = "前文 [[章/第一章]] と [[メモ]]\n[外部](https://example.org/a) [二つ目](http://example.com/b)\n![[image.png]]";

  it("finds the link under the caret, else the first link on the caret line", () => {
    expect(internalLinkTargetAtOffset(text, text.indexOf("メモ"))).toBe("メモ");
    expect(internalLinkTargetAtOffset(text, 0)).toBe("章/第一章");
    expect(internalLinkTargetAtOffset(text, text.indexOf("image"))).toBeNull();
    expect(externalLinkUrlAtOffset(text, text.indexOf("二つ目"))).toBe("http://example.com/b");
    expect(externalLinkUrlAtOffset(text, text.indexOf("[外部]"))).toBe("https://example.org/a");
    expect(externalLinkUrlAtOffset(text, 0)).toBeNull();
  });

  it("accepts only credential-free HTTP(S) URLs for external opening", () => {
    expect(isOpenableExternalUrl("https://example.org/path?q=1")).toBe(true);
    expect(isOpenableExternalUrl("file:///C:/secret.txt")).toBe(false);
    expect(isOpenableExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("https://user:pass@example.org")).toBe(false);
    expect(isOpenableExternalUrl("https://example.org/\u0000")).toBe(false);
  });

  function setupLinks(overrides: Partial<LinkCommandDependencies> = {}) {
    const registry = new CommandRegistry();
    const openInternalFile = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => ({ kind: "opened" as const }));
    registerLinkCommands(registry, {
      getCaret: () => ({ text, offset: text.indexOf("メモ") }),
      resolveInternalTarget: async (target) => target === "メモ" ? "file-memo" : null,
      openInternalFile,
      openExternal,
      ...overrides
    });
    return { registry, openInternalFile, openExternal };
  }

  it("routes Preview clicks and the cursor/context-menu action through one internal opener", async () => {
    const { registry, openInternalFile } = setupLinks();
    const context = { "editor.hasDocument": true, "project.active": true, "editor.linkType": "internal" };
    expect(registry.get(OPEN_INTERNAL_LINK_COMMAND_ID)?.visibility).toBe("internal");
    expect(ids(registry, context)).toContain(OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID);
    expect(ids(registry, { ...context, "editor.linkType": "none" })).not.toContain(OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID);

    await expect(registry.execute(OPEN_INTERNAL_LINK_COMMAND_ID, context, { fileId: "file-1" })).resolves.toEqual({ kind: "executed" });
    await expect(registry.execute(OPEN_INTERNAL_LINK_AT_CURSOR_COMMAND_ID, context)).resolves.toEqual({ kind: "executed" });
    expect(openInternalFile.mock.calls).toEqual([["file-1"], ["file-memo"]]);
    await expect(registry.execute(OPEN_INTERNAL_LINK_COMMAND_ID, context)).resolves.toMatchObject({ kind: "failed" });
  });

  it("opens external links only through the validated opener and reports unavailability", async () => {
    const { registry, openExternal } = setupLinks({ getCaret: () => ({ text, offset: text.indexOf("[外部]") }) });
    const context = { "editor.hasDocument": true, "link.externalAvailable": true, "editor.linkType": "external" };
    expect(ids(registry, context)).toContain(OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID);
    expect(ids(registry, { ...context, "link.externalAvailable": false })).not.toContain(OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID);
    await expect(registry.execute(OPEN_EXTERNAL_LINK_COMMAND_ID, context, { url: "https://www.youtube.com/watch?v=x" })).resolves.toEqual({ kind: "executed" });
    await expect(registry.execute(OPEN_EXTERNAL_LINK_AT_CURSOR_COMMAND_ID, context)).resolves.toEqual({ kind: "executed" });
    await expect(registry.execute(OPEN_EXTERNAL_LINK_COMMAND_ID, context, { url: "file:///etc/passwd" })).resolves.toMatchObject({ kind: "failed" });
    expect(openExternal.mock.calls).toEqual([["https://www.youtube.com/watch?v=x"], ["https://example.org/a"]]);

    const unavailable = setupLinks({ openExternal: null }).registry;
    await expect(unavailable.execute(OPEN_EXTERNAL_LINK_COMMAND_ID, context, { url: "https://example.org" }))
      .resolves.toMatchObject({ kind: "failed", error: { message: "Opening external links is unavailable." } });
    await expect(registry.execute(OPEN_EXTERNAL_LINK_COMMAND_ID, { "link.externalAvailable": false }, { url: "https://example.org" }))
      .resolves.toEqual({ kind: "disabled" });
  });
});

describe("Search and Shelf insertion commands", () => {
  function setupSearch(overrides: Partial<SearchCommandDependencies> = {}) {
    const registry = new CommandRegistry();
    const dependencies: SearchCommandDependencies = {
      searchShelf: vi.fn(async () => undefined),
      searchProjectMarkdown: vi.fn(async () => undefined),
      selectShelfResult: vi.fn(),
      insertShelfQuote: vi.fn(async () => undefined),
      insertProjectSearchSelection: vi.fn(() => "inserted" as const),
      ...overrides
    };
    registerSearchCommands(registry, dependencies);
    return { registry, dependencies };
  }

  it("exposes each search action only when it can run", () => {
    const { registry } = setupSearch();
    expect(ids(registry, {})).toEqual([]);
    expect(ids(registry, { "shelf.available": true })).toEqual([SHELF_SEARCH_COMMAND_ID]);
    expect(ids(registry, { "projectSearch.available": true })).not.toContain(PROJECT_MARKDOWN_SEARCH_COMMAND_ID);
    expect(ids(registry, { "projectSearch.available": true, "project.active": true })).toContain(PROJECT_MARKDOWN_SEARCH_COMMAND_ID);
    expect(ids(registry, { "shelf.available": true, "shelf.resultSelected": true })).not.toContain(SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID);
    expect(ids(registry, { "shelf.available": true, "shelf.resultSelected": true, "editor.hasDocument": true })).toContain(SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID);
    expect(ids(registry, { "editor.hasDocument": true, "projectSearch.hasSource": true })).toContain(INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID);
    expect(registry.get(SHELF_SELECT_RESULT_COMMAND_ID)?.visibility).toBe("internal");
  });

  it("passes the form query and opaque annotation IDs through command arguments", async () => {
    const { registry, dependencies } = setupSearch();
    const context = { "shelf.available": true, "shelf.resultSelected": true, "editor.hasDocument": true, "projectSearch.available": true, "project.active": true };
    await registry.execute(SHELF_SEARCH_COMMAND_ID, context, { query: "引用" });
    await registry.execute(SHELF_SEARCH_COMMAND_ID, context);
    await registry.execute(PROJECT_MARKDOWN_SEARCH_COMMAND_ID, context, { query: "本文" });
    await registry.execute(SHELF_SELECT_RESULT_COMMAND_ID, context, { annotationId: "ann-1" });
    await registry.execute(SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID, context, { annotationId: "ann-1" });
    await registry.execute(SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID, context);
    expect(vi.mocked(dependencies.searchShelf).mock.calls).toEqual([["引用"], [undefined]]);
    expect(dependencies.searchProjectMarkdown).toHaveBeenCalledWith("本文");
    expect(dependencies.selectShelfResult).toHaveBeenCalledWith("ann-1");
    expect(vi.mocked(dependencies.insertShelfQuote).mock.calls).toEqual([["ann-1"], [undefined]]);
    await expect(registry.execute(SHELF_SELECT_RESULT_COMMAND_ID, context)).resolves.toMatchObject({ kind: "failed" });
  });

  it("turns Project search insertion outcomes into user-visible failures", async () => {
    const context = { "editor.hasDocument": true, "projectSearch.hasSource": true };
    const empty = setupSearch({ insertProjectSearchSelection: () => "empty-selection" }).registry;
    const stale = setupSearch({ insertProjectSearchSelection: () => "stale-target" }).registry;
    await expect(empty.execute(INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID, context))
      .resolves.toMatchObject({ kind: "failed", error: { message: "Select text in the source preview before inserting it." } });
    await expect(stale.execute(INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID, context)).resolves.toMatchObject({ kind: "failed" });
    await expect(setupSearch().registry.execute(INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID, context)).resolves.toEqual({ kind: "executed" });
  });
});

describe("Native application menu snapshot", () => {
  it("projects enabled state, modal gating, and effective shortcuts", () => {
    const snapshot = buildApplicationMenuSnapshot({
      commandIds: ["maginalia.document.save", "maginalia.settings.open", "maginalia.document.closeView"],
      enabledCommandIds: new Set(["maginalia.document.save", "maginalia.settings.open"]),
      modalOpen: true,
      allowedDuringModal: new Set(["maginalia.settings.open"]),
      getShortcut: (id) => id === "maginalia.document.save" ? "Ctrl+S" : null
    });
    expect(snapshot).toEqual([
      { id: "maginalia.document.save", enabled: false, shortcut: "Ctrl+S" },
      { id: "maginalia.settings.open", enabled: true },
      { id: "maginalia.document.closeView", enabled: false }
    ]);
    expect(buildApplicationMenuSnapshot({
      commandIds: ["maginalia.document.save"],
      enabledCommandIds: new Set(["maginalia.document.save"]),
      modalOpen: false,
      allowedDuringModal: new Set(),
      getShortcut: () => null
    })).toEqual([{ id: "maginalia.document.save", enabled: true }]);
  });
});
