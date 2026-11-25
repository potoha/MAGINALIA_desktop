import type { CommandArgs, CommandRegistry } from "./command-registry";

export const SHELF_SEARCH_COMMAND_ID = "maginalia.shelf.search";
export const PROJECT_MARKDOWN_SEARCH_COMMAND_ID = "maginalia.search.projectMarkdown";
export const SHELF_SELECT_RESULT_COMMAND_ID = "maginalia.shelf.selectResult";
export const SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID = "maginalia.shelf.insertSelectedQuote";
export const INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID = "maginalia.editor.insertProjectSearchSelection";

export type ProjectSearchInsertionOutcome = "inserted" | "empty-selection" | "stale-target";

export interface SearchCommandDependencies {
  /** Run Private Shelf search; `query` is undefined when invoked without arguments (Palette). */
  readonly searchShelf: (query: string | undefined) => Promise<void>;
  /** Run current-Project Markdown search; `query` is undefined when invoked without arguments. */
  readonly searchProjectMarkdown: (query: string | undefined) => Promise<void>;
  /** Select one opaque Reviewer annotationId among current Shelf results. */
  readonly selectShelfResult: (annotationId: string) => void;
  /** Insert a QuoteRef for the given (or currently selected) Shelf result. */
  readonly insertShelfQuote: (annotationId: string | undefined) => Promise<void>;
  /** Literal copy of the selected source text from the Project search preview. */
  readonly insertProjectSearchSelection: () => ProjectSearchInsertionOutcome;
}

/**
 * Search and Shelf insertion are public actions. The unified search form,
 * result buttons, and the Command Palette dispatch these IDs; the
 * implementations stay in the Shelf/Project search controllers.
 */
export function registerSearchCommands(registry: CommandRegistry, dependencies: SearchCommandDependencies): void {
  registry.register({
    id: SHELF_SEARCH_COMMAND_ID,
    title: "Shelf を検索",
    description: "Search approved Private Shelf quotations.",
    category: "Shelf",
    keywords: ["search", "shelf", "quotation", "検索", "引用"],
    when: "shelf.available"
  }, (args?: CommandArgs) => dependencies.searchShelf(args?.query));

  registry.register({
    id: PROJECT_MARKDOWN_SEARCH_COMMAND_ID,
    title: "Project 内の Markdown を検索",
    description: "Search Markdown text in the active Project.",
    category: "Search",
    keywords: ["search", "project", "markdown", "text", "検索"],
    when: "projectSearch.available && project.active"
  }, (args?: CommandArgs) => dependencies.searchProjectMarkdown(args?.query));

  registry.register({
    id: SHELF_SELECT_RESULT_COMMAND_ID,
    title: "Shelf の結果を選択",
    description: "Select one Shelf result by its opaque annotation ID.",
    category: "Shelf",
    keywords: ["shelf", "select", "result"],
    when: "shelf.available",
    // Requires a target annotation, so it is not offered without arguments.
    visibility: "internal"
  }, (args?: CommandArgs) => {
    const annotationId = args?.annotationId;
    if (annotationId === undefined || annotationId.length === 0) throw new Error("Choose a Shelf result to select.");
    dependencies.selectShelfResult(annotationId);
  });

  registry.register({
    id: SHELF_INSERT_SELECTED_QUOTE_COMMAND_ID,
    title: "選択した引用を挿入",
    description: "Insert a QuoteRef for the selected Shelf result at the cursor.",
    category: "Shelf",
    keywords: ["insert", "quote", "quoteref", "shelf", "挿入", "引用"],
    when: "editor.hasDocument && shelf.resultSelected"
  }, (args?: CommandArgs) => dependencies.insertShelfQuote(args?.annotationId));

  registry.register({
    id: INSERT_PROJECT_SEARCH_SELECTION_COMMAND_ID,
    title: "検索結果の選択範囲を挿入",
    description: "Insert the text selected in the Project search preview as a literal copy.",
    category: "Editor",
    keywords: ["insert", "search", "project", "copy", "挿入"],
    when: "editor.hasDocument && projectSearch.hasSource"
  }, () => {
    const outcome = dependencies.insertProjectSearchSelection();
    if (outcome === "empty-selection") throw new Error("Select text in the source preview before inserting it.");
    if (outcome === "stale-target") throw new Error("The destination changed before insertion. Select a Project result again.");
  });
}
