import type { CommandContext } from "./command-context";
import type { CommandArgs, CommandDescriptor, CommandRegistry, CommandSearchResult, CommandTextRange } from "./command-registry";

export type CommandPaletteProviderId = "project" | "file";

export interface CommandPaletteProviderResult {
  /** Opaque Project identity or file ID; provider results never carry filesystem paths. */
  readonly resultId: string;
  readonly commandId: string;
  /** Opaque scalar arguments passed to the generic command (never filesystem paths). */
  readonly args?: CommandArgs;
  readonly title: string;
  readonly category: string;
  readonly description?: string;
  readonly relevance: number;
  readonly titleMatches?: readonly CommandTextRange[];
  readonly descriptionMatches?: readonly CommandTextRange[];
}

export type CommandPaletteProvider = (
  query: string,
  context: CommandContext
) => readonly CommandPaletteProviderResult[];

export interface CommandPaletteOptions {
  readonly registry: CommandRegistry;
  readonly getContext: () => CommandContext;
  /** Effective keybindings are supplied by the owning renderer. */
  readonly getShortcut?: (commandId: string) => string | null;
  readonly providers?: Partial<Record<CommandPaletteProviderId, CommandPaletteProvider>>;
  /** Revalidates an opaque navigation identity before the registered generic command runs with its arguments. */
  readonly prepareProviderResult?: (providerId: CommandPaletteProviderId, resultId: string) => boolean;
  readonly onError?: (message: string) => void;
}

export type CommandPaletteInputMode = "commands" | "project" | "file" | "help";

export interface ParsedCommandPaletteInput {
  readonly mode: CommandPaletteInputMode;
  readonly query: string;
  readonly commandOnly: boolean;
}

interface PaletteOption {
  readonly commandId: string;
  readonly title: string;
  readonly category: string;
  readonly description?: string;
  readonly titleMatches: readonly CommandTextRange[];
  readonly categoryMatches: readonly CommandTextRange[];
  readonly descriptionMatches: readonly CommandTextRange[];
  readonly shortcut: string | null;
  readonly relevance: number;
  readonly providerId?: CommandPaletteProviderId;
  readonly resultId?: string;
  readonly args?: CommandArgs;
}

export function isImeCompositionKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Keeps the Quick Pick grammar explicit and prevents name modes mixing with action search. */
export function parseCommandPaletteInput(input: string): ParsedCommandPaletteInput {
  const value = input.trimStart();
  if (value.startsWith(">")) return { mode: "commands", query: value.slice(1).trim(), commandOnly: true };
  if (value.startsWith("?")) return { mode: "help", query: value.slice(1).trim(), commandOnly: false };
  const provider = /^(project|file):/iu.exec(value);
  if (provider !== null) {
    return {
      mode: provider[1]!.toLocaleLowerCase() as "project" | "file",
      query: value.slice(provider[0].length).trim(),
      commandOnly: false
    };
  }
  return { mode: "commands", query: input.trim(), commandOnly: false };
}

/** Registry-backed action search plus separate, identity-only navigation pickers. */
export class CommandPalette {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly message: HTMLDivElement;
  private readonly results: HTMLUListElement;
  private previousFocus: HTMLElement | null = null;
  private selected = 0;
  private openState = false;
  private currentOptions: readonly PaletteOption[] = [];

  public constructor(private readonly options: CommandPaletteOptions) {
    this.root = document.createElement("div");
    this.root.className = "command-palette";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Command Palette and Quick Open");

    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.placeholder = "Commands, project:, file:, > or ?";
    this.input.setAttribute("aria-label", "Search commands, Projects, or documents by name");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-expanded", "false");

    this.message = document.createElement("div");
    this.message.className = "command-palette-message";
    this.message.hidden = true;
    this.message.setAttribute("role", "status");

    this.results = document.createElement("ul");
    this.results.id = "command-palette-results";
    this.results.className = "command-palette-results";
    this.results.setAttribute("role", "listbox");
    this.results.setAttribute("aria-label", "Available commands and navigation targets");
    this.input.setAttribute("aria-controls", this.results.id);
    this.root.append(this.input, this.message, this.results);
    document.body.append(this.root);

    this.input.addEventListener("input", () => {
      this.selected = 0;
      this.render();
    });
    this.root.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.results.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest('[role="option"]') !== null) event.preventDefault();
    });
    this.options.registry.onDidChange(() => { if (this.openState) this.render(); });
  }

  public isOpen(): boolean { return this.openState; }

  public open(): void { this.openWith(""); }
  public openCommandPicker(): void { this.openWith("> "); }
  public openQuickOpen(): void { this.openWith("file: "); }

  public close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.root.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.results.replaceChildren();
    this.currentOptions = [];
    this.message.hidden = true;
    const focusTarget = this.previousFocus;
    this.previousFocus = null;
    if (focusTarget?.isConnected) focusTarget.focus();
  }

  private openWith(initialValue: string): void {
    if (this.openState) {
      this.input.value = initialValue;
      this.selected = 0;
      this.render();
      this.input.focus();
      this.input.setSelectionRange(initialValue.length, initialValue.length);
      return;
    }
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.openState = true;
    this.root.hidden = false;
    this.input.value = initialValue;
    this.selected = 0;
    this.render();
    queueMicrotask(() => {
      if (!this.openState) return;
      this.input.focus();
      this.input.setSelectionRange(initialValue.length, initialValue.length);
    });
  }

  private searchResults(): readonly PaletteOption[] {
    const parsed = parseCommandPaletteInput(this.input.value);
    const context = this.options.getContext();
    if (parsed.mode === "help") return [];
    if (parsed.mode === "commands") {
      return this.options.registry.search(parsed.query, context).map((match) => this.fromCommand(match));
    }

    const provider = this.options.providers?.[parsed.mode];
    if (provider === undefined) return [];
    const enabledCommands = new Set(this.options.registry.list(context).map((command) => command.id));
    return provider(parsed.query, context)
      .filter((result) => result.resultId.length > 0 && enabledCommands.has(result.commandId))
      .map((result) => this.fromProvider(parsed.mode as CommandPaletteProviderId, result))
      .sort((left, right) => right.relevance - left.relevance
        || left.title.localeCompare(right.title)
        || left.resultId!.localeCompare(right.resultId!));
  }

  private fromCommand(match: CommandSearchResult): PaletteOption {
    const command = match.descriptor;
    return {
      commandId: command.id,
      title: command.title,
      category: command.category ?? "General",
      ...(command.description === undefined ? {} : { description: command.description }),
      titleMatches: match.titleMatches,
      categoryMatches: match.categoryMatches,
      descriptionMatches: match.descriptionMatches,
      shortcut: this.options.getShortcut?.(command.id) ?? null,
      relevance: match.relevance
    };
  }

  private fromProvider(providerId: CommandPaletteProviderId, result: CommandPaletteProviderResult): PaletteOption {
    return {
      commandId: result.commandId,
      title: result.title,
      category: result.category,
      ...(result.description === undefined ? {} : { description: result.description }),
      titleMatches: result.titleMatches ?? [],
      categoryMatches: [],
      descriptionMatches: result.descriptionMatches ?? [],
      shortcut: this.options.getShortcut?.(result.commandId) ?? null,
      relevance: result.relevance,
      providerId,
      resultId: result.resultId,
      ...(result.args === undefined ? {} : { args: result.args })
    };
  }

  private render(): void {
    const parsed = parseCommandPaletteInput(this.input.value);
    this.currentOptions = this.searchResults();
    this.selected = this.currentOptions.length === 0 ? -1 : Math.max(0, Math.min(this.selected, this.currentOptions.length - 1));
    this.results.replaceChildren();
    this.input.removeAttribute("aria-activedescendant");
    this.message.hidden = false;

    if (parsed.mode === "help") {
      this.results.hidden = true;
      this.input.setAttribute("aria-expanded", "false");
      const commandShortcut = this.options.getShortcut?.("maginalia.workbench.showCommandPalette");
      const quickOpenShortcut = this.options.getShortcut?.("maginalia.workbench.showQuickOpen");
      this.message.textContent = [
        `Type > to find actions${commandShortcut ? ` (${commandShortcut})` : ""}.`,
        `Type project: to open an available registered Workdesk Project.`,
        `Type file: to open a document in the active Project${quickOpenShortcut ? ` (${quickOpenShortcut})` : ""}.`,
        "↑/↓ moves, Enter opens or runs, and Esc closes."
      ].join(" ");
      return;
    }

    this.results.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    if (this.currentOptions.length === 0) {
      this.message.textContent = parsed.mode === "project"
        ? "No available registered Workdesk Projects match this name."
        : parsed.mode === "file"
          ? "No documents in the active Project match this name."
          : "No commands match. Type ? for keyboard help.";
    } else {
      this.message.textContent = parsed.mode === "project"
        ? "Available Workdesk Projects · name search only"
        : parsed.mode === "file"
          ? "Documents in the active Project · name search only"
          : parsed.commandOnly
            ? "Commands only"
            : "Type > for command-only mode, project: or file: for name navigation, or ? for help.";
    }
    this.message.hidden = this.currentOptions.length > 0 && parsed.query.length > 0;

    this.currentOptions.forEach((option, index) => this.results.append(this.renderOption(option, index)));
    this.syncActiveOption();
  }

  private renderOption(option: PaletteOption, index: number): HTMLLIElement {
    const item = document.createElement("li");
    item.id = `command-palette-option-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === this.selected));
    item.className = "command-palette-item";
    item.dataset.commandId = option.commandId;
    if (option.providerId !== undefined) item.dataset.providerId = option.providerId;
    if (option.resultId !== undefined) item.dataset.resultId = option.resultId;

    const main = document.createElement("span");
    main.className = "command-palette-item-main";
    const title = document.createElement("span");
    title.className = "command-palette-command-title";
    appendHighlightedText(title, option.title, option.titleMatches);
    const category = document.createElement("span");
    category.className = "command-palette-category";
    appendHighlightedText(category, option.category, option.categoryMatches);
    main.append(title, category);

    if (option.description !== undefined && option.description !== option.title) {
      const description = document.createElement("span");
      description.className = "command-palette-description";
      appendHighlightedText(description, option.description, option.descriptionMatches);
      main.append(description);
    }
    item.append(main);

    if (option.shortcut) {
      const key = document.createElement("kbd");
      key.textContent = option.shortcut;
      item.append(key);
    }

    item.title = option.commandId;
    item.addEventListener("click", () => { void this.run(option); });
    return item;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (isImeCompositionKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key === "ArrowDown") {
      if (this.currentOptions.length === 0) return;
      event.preventDefault();
      this.selected = Math.min(this.currentOptions.length - 1, this.selected + 1);
      this.syncActiveOption();
      return;
    }
    if (event.key === "ArrowUp") {
      if (this.currentOptions.length === 0) return;
      event.preventDefault();
      this.selected = Math.max(0, this.selected - 1);
      this.syncActiveOption();
      return;
    }
    if (event.key === "Enter" && this.currentOptions[this.selected] !== undefined) {
      event.preventDefault();
      void this.run(this.currentOptions[this.selected]!);
    }
  }

  private syncActiveOption(): void {
    const items = this.results.querySelectorAll<HTMLElement>('[role="option"]');
    items.forEach((item, index) => item.setAttribute("aria-selected", String(index === this.selected)));
    const active = this.selected < 0 ? null : items.item(this.selected);
    if (active === null) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    this.input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView?.({ block: "nearest" });
  }

  private async run(option: PaletteOption): Promise<void> {
    this.close();
    if (option.providerId !== undefined
      && !(this.options.prepareProviderResult?.(option.providerId, option.resultId ?? "") ?? false)) {
      this.options.onError?.("This navigation target is no longer available.");
      return;
    }
    const result = await this.options.registry.execute(option.commandId, this.options.getContext(), option.args);
    if (result.kind === "failed") this.options.onError?.(result.error.message);
    else if (result.kind === "disabled" || result.kind === "missing") {
      this.options.onError?.("This command is no longer available.");
    }
  }
}

function appendHighlightedText(element: HTMLElement, text: string, ranges: readonly CommandTextRange[]): void {
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > cursor) element.append(document.createTextNode(text.slice(cursor, start)));
    if (end > start) {
      const mark = document.createElement("mark");
      mark.className = "command-palette-match";
      mark.textContent = text.slice(start, end);
      element.append(mark);
      cursor = end;
    }
  }
  if (cursor < text.length) element.append(document.createTextNode(text.slice(cursor)));
}
