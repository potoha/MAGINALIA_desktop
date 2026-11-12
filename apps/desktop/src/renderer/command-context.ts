/**
 * Small, serialisable Workbench context vocabulary.  It deliberately exposes
 * only values a contribution can safely reason about, never Monaco or DOM
 * objects.
 */
export type CommandContextValue = boolean | string;
export type CommandContext = Readonly<Record<string, CommandContextValue>>;

export const COMMAND_CONTEXT_KEYS = [
  "editor.hasDocument",
  "editor.hasSelection",
  "editor.blockType",
  "editor.linkType",
  "editor.mediaType",
  "editor.hasQuoteRef",
  "table.active",
  "table.headerCell",
  "table.bodyCell",
  "table.canDeleteRow",
  "table.canDeleteColumn",
  "syncedBlock.available",
  "syncedBlock.insertable",
  "syncedBlock.target",
  "properties.available",
  "properties.valid",
  "properties.dirty",
  "properties.stale",
  "renderer.orientation",
  "document.type",
  "document.hasMainView",
  "view.id",
  "project.creationActive",
  "mods.available",
  "repository.available",
  "repository.idle",
  "repository.activationAvailable",
  "repository.historyAvailable",
  "repository.historySelected",
  // Current Project/Workdesk document scope, without exposing a filesystem path.
  "project.active",
  // Portable parent navigation state; still a scalar, never a path or a
  // Workdesk service object. It scopes Workdesk-only creation commands.
  "workdesk.active",
  "workdesk.homeActive",
  "workdesk.homeAvailable",
  // True only while the current Explorer displays a child Project of that
  // active Workdesk.
  "workdesk.childProject",
  // True while the inline Explorer "New Markdown" form is open.
  "explorer.creationActive",
  // More than one central document tab is open, so tab cycling can act.
  "document.multipleTabs",
  // A Document/Project open implementation is wired for this runtime.
  "document.openAvailable",
  // Export IPC and controller are available for this runtime.
  "export.available",
  // The main-process validated external-link opener is available.
  "link.externalAvailable",
  // Private Shelf search can run (API available) and has a selected result.
  "shelf.available",
  "shelf.resultSelected",
  // Current-Project Markdown search is available, and a result source is shown.
  "projectSearch.available",
  "projectSearch.hasSource"
] as const;

export type CommandContextKey = typeof COMMAND_CONTEXT_KEYS[number];

function isKey(value: string): value is CommandContextKey {
  return (COMMAND_CONTEXT_KEYS as readonly string[]).includes(value);
}

/** A deliberately bounded `when` evaluator, not a VS Code expression parser. */
export function matchesWhen(context: CommandContext, when: string | undefined): boolean {
  if (when === undefined || when.trim().length === 0) return true;
  return when.split("&&").every((rawClause) => {
    const clause = rawClause.trim();
    if (clause.length === 0) return false;
    // Keys are camelCase segments (for example `editor.linkType`).
    const equals = /^([a-zA-Z.]+)\s*(==|!=)\s*([a-zA-Z0-9_-]+)$/u.exec(clause);
    if (equals !== null) {
      const [, key, operator, value] = equals;
      if (!isKey(key)) return false;
      const actual = String(context[key] ?? "");
      return operator === "==" ? actual === value : actual !== value;
    }
    if (clause.startsWith("!")) {
      const key = clause.slice(1);
      return isKey(key) && context[key] !== true;
    }
    return isKey(clause) && context[clause] === true;
  });
}

export class ContextKeyService {
  private values: Record<string, CommandContextValue> = {};
  private readonly listeners = new Set<(context: CommandContext) => void>();

  public set(key: CommandContextKey, value: CommandContextValue): void {
    if (this.values[key] === value) return;
    this.values = { ...this.values, [key]: value };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* observers are isolated */ }
    }
  }

  public patch(values: Partial<Record<CommandContextKey, CommandContextValue>>): void {
    for (const [key, value] of Object.entries(values)) {
      if (isKey(key) && value !== undefined) this.set(key, value);
    }
  }

  public snapshot(): CommandContext { return Object.freeze({ ...this.values }); }
  public matches(when: string | undefined): boolean { return matchesWhen(this.values, when); }

  public onDidChange(listener: (context: CommandContext) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
}
