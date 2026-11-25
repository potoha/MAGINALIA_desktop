import type { CommandContext } from "./command-context";
import type { CommandRegistry } from "./command-registry";
import {
  formatKeybinding,
  parseKeyboardEvent,
  type KeybindingChangeResult,
  type KeybindingCollisionNotice,
  type KeybindingEntry,
  type KeybindingService
} from "./keybinding-service";
import {
  type SettingMetadata,
  type SettingReadResult,
  type SettingValue,
  type SettingWriteResult,
  SettingsRegistry
} from "./settings-registry";

export type SettingsCenterTab = "settings" | "shortcuts" | "cheatsheet";

/** User-facing (Japanese) explanation of one deterministic shortcut collision resolution. */
export function describeKeybindingCollisionNotice(
  notice: KeybindingCollisionNotice,
  titleOf: (commandId: string) => string
): string {
  const binding = formatKeybinding(notice.keybinding);
  const title = titleOf(notice.commandId);
  switch (notice.kind) {
    case "duplicate-override":
      return `${title} の保存済みショートカット ${binding} は ${titleOf(notice.keptCommandId)} と重複していたため、割り当てを解除しました。`;
    case "reserved-override":
      return `${title} の保存済みショートカット ${binding} はシステムまたはアプリケーションメニューで予約されているため、使用していません。`;
    case "default-shadowed":
      return `${title} の既定ショートカット ${binding} は ${titleOf(notice.keptCommandId)} に割り当て済みのため、無効になっています。`;
  }
}

export interface SettingsCenterOptions {
  readonly settings: SettingsRegistry;
  readonly commands: CommandRegistry;
  readonly keybindings: KeybindingService;
  readonly getContext: () => CommandContext;
  readonly onError?: (message: string) => void;
  readonly onOpenStateChanged?: (open: boolean) => void;
}

const TAB_LABELS: Readonly<Record<SettingsCenterTab, string>> = Object.freeze({
  settings: "設定",
  shortcuts: "ショートカット",
  cheatsheet: "ショートカット一覧"
});

function isTab(value: string): value is SettingsCenterTab {
  return value === "settings" || value === "shortcuts" || value === "cheatsheet";
}

function displaySettingValue(setting: SettingMetadata, value: SettingValue): string {
  if (setting.id === "maginalia.renderer.default-writing-direction") {
    if (value === "horizontal") return "横書き";
    if (value === "vertical") return "縦書き";
  }
  if (setting.id === "maginalia.export.orientation") {
    if (value === "portrait") return "縦向き";
    if (value === "landscape") return "横向き";
  }
  return String(value);
}

function defaultText(setting: SettingMetadata): string {
  return displaySettingValue(setting, setting.defaultValue);
}

function failureMessage(result: SettingReadResult | SettingWriteResult): string | null {
  switch (result.kind) {
    case "invalid": return result.failure.message;
    case "failed": return result.message;
    case "disabled": return "This setting is currently unavailable.";
    case "missing": return "This setting is no longer registered.";
    default: return null;
  }
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  let cursor = 0;
  for (const character of needle) {
    cursor = haystack.indexOf(character, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

function appendText(parent: HTMLElement, tag: "h3" | "p" | "span" | "small", className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function makeButton(text: string, action: string, focusKey: string, commandId?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.dataset.action = action;
  button.dataset.focusKey = focusKey;
  if (commandId !== undefined) button.dataset.commandId = commandId;
  return button;
}

/** A dialog for existing preference adapters and the shared public command surface. */
export class SettingsCenter {
  private readonly dialog: HTMLDialogElement;
  private readonly tabs = new Map<SettingsCenterTab, HTMLButtonElement>();
  private readonly searchInput: HTMLInputElement;
  private readonly categoryFilter: HTMLSelectElement;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly errors = new Map<string, string>();
  private readonly subscriptions: Array<() => void> = [];
  private tab: SettingsCenterTab = "settings";
  private previousFocus: HTMLElement | null = null;
  private recordingCommandId: string | null = null;
  private draftBinding: { readonly commandId: string; readonly binding: string } | null = null;
  private conflict: { readonly commandId: string; readonly binding: string; readonly commandIds: readonly string[]; readonly reset: boolean } | null = null;

  public constructor(private readonly options: SettingsCenterOptions) {
    this.dialog = document.createElement("dialog");
    this.dialog.id = "settings-center";
    this.dialog.className = "settings-center";
    this.dialog.setAttribute("aria-labelledby", "settings-center-title");

    const shell = document.createElement("div");
    shell.className = "settings-center-shell";
    const header = document.createElement("header");
    header.className = "settings-center-header";
    const title = document.createElement("h2");
    title.textContent = "設定";
    title.id = "settings-center-title";
    header.append(title);
    const close = makeButton("閉じる", "close-settings", "close");
    close.setAttribute("aria-label", "設定を閉じる");
    close.addEventListener("click", () => this.dialog.close());
    header.append(close);

    const navigation = document.createElement("nav");
    navigation.className = "settings-center-tabs";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "設定セクション");
    for (const tab of ["settings", "shortcuts", "cheatsheet"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = TAB_LABELS[tab];
      button.dataset.settingsTab = tab;
      button.dataset.focusKey = `tab:${tab}`;
      button.id = `settings-tab-${tab}`;
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => this.selectTab(tab));
      this.tabs.set(tab, button);
      navigation.append(button);
    }
    navigation.addEventListener("keydown", (event) => {
      const currentIndex = ["settings", "shortcuts", "cheatsheet"].indexOf(this.tab);
      let nextIndex = currentIndex;
      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % this.tabs.size;
      else if (event.key === "ArrowLeft") nextIndex = (currentIndex + this.tabs.size - 1) % this.tabs.size;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = this.tabs.size - 1;
      else return;
      event.preventDefault();
      this.selectTab((["settings", "shortcuts", "cheatsheet"] as const)[nextIndex]!);
    });

    const searchLabel = document.createElement("label");
    searchLabel.className = "settings-center-search-label";
    searchLabel.htmlFor = "settings-search";
    searchLabel.textContent = "検索";
    this.searchInput = document.createElement("input");
    this.searchInput.id = "settings-search";
    this.searchInput.type = "search";
    this.searchInput.autocomplete = "off";
    this.searchInput.setAttribute("aria-label", "設定とショートカットを検索");
    this.searchInput.addEventListener("input", () => this.render());
    searchLabel.append(this.searchInput);

    this.categoryFilter = document.createElement("select");
    this.categoryFilter.id = "settings-category-filter";
    this.categoryFilter.setAttribute("aria-label", "設定カテゴリ");
    this.categoryFilter.dataset.focusKey = "category-filter";
    this.categoryFilter.addEventListener("change", () => this.render());

    this.status = document.createElement("p");
    this.status.className = "settings-center-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel = document.createElement("section");
    this.panel.className = "settings-center-panel";
    this.panel.setAttribute("role", "tabpanel");
    this.panel.id = "settings-center-panel";
    for (const button of this.tabs.values()) button.setAttribute("aria-controls", this.panel.id);

    shell.append(header, navigation, searchLabel, this.categoryFilter, this.status, this.panel);
    this.dialog.append(shell);
    document.body.append(this.dialog);
    this.dialog.addEventListener("close", () => this.onClose());
    this.dialog.addEventListener("click", (event) => this.onClick(event));
    this.dialog.addEventListener("change", (event) => this.onChange(event));
    this.dialog.addEventListener("keydown", (event) => this.onKeyDown(event), true);

    this.subscriptions.push(
      options.settings.onDidChange(() => this.renderIfOpen()),
      options.commands.onDidChange(() => this.renderIfOpen()),
      options.keybindings.onDidChange(() => this.renderIfOpen())
    );
    this.selectTab("settings", false);
  }

  public isOpen(): boolean { return this.dialog.open; }

  public open(tab: SettingsCenterTab = "settings"): void {
    this.selectTab(tab, false);
    if (!this.dialog.open) {
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.dialog.showModal();
      this.options.onOpenStateChanged?.(true);
    }
    this.render();
    queueMicrotask(() => this.searchInput.focus());
  }

  public close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  public dispose(): void {
    this.close();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.dialog.remove();
  }

  private selectTab(tab: SettingsCenterTab, focus = true): void {
    const changed = this.tab !== tab;
    this.tab = tab;
    for (const [name, button] of this.tabs) {
      const active = name === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    this.panel.setAttribute("aria-labelledby", `settings-tab-${tab}`);
    this.categoryFilter.hidden = tab !== "settings";
    if (changed) this.status.textContent = "";
    this.refreshCategoryOptions();
    this.render();
    if (focus) this.tabs.get(tab)?.focus();
  }

  private renderIfOpen(): void {
    if (this.dialog.open) this.render();
  }

  /** Re-render dynamic enabled state after application context changes. */
  public refresh(): void {
    this.renderIfOpen();
  }

  private refreshCategoryOptions(): void {
    const selected = this.categoryFilter.value;
    this.categoryFilter.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "すべてのカテゴリ";
    this.categoryFilter.append(all);
    for (const category of this.options.settings.listCategories()) {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      this.categoryFilter.append(option);
    }
    this.categoryFilter.value = [...this.categoryFilter.options].some((option) => option.value === selected) ? selected : "";
  }

  private render(): void {
    this.refreshCategoryOptions();
    const focusKey = this.currentFocusKey();
    this.panel.replaceChildren();
    if (this.tab === "settings") this.renderSettings();
    else if (this.tab === "shortcuts") this.renderShortcuts(false);
    else this.renderShortcuts(true);
    if (focusKey !== null) this.findFocusTarget(focusKey)?.focus();
  }

  private renderSettings(): void {
    const toolbar = document.createElement("div");
    toolbar.className = "settings-center-toolbar";
    const resetCategory = makeButton("カテゴリをリセット", "reset-category", "reset-category");
    const resetAll = makeButton("ユーザー設定をすべてリセット", "reset-all-settings", "reset-all-settings");
    toolbar.append(resetCategory, resetAll);
    this.panel.append(toolbar);

    const query = this.searchInput.value.trim().toLocaleLowerCase();
    const selectedCategory = this.categoryFilter.value;
    const settings = this.options.settings.search(query).filter((setting) => selectedCategory.length === 0 || setting.category === selectedCategory);
    if (settings.length === 0) appendText(this.panel, "p", "settings-center-empty", "一致する設定はありません。");
    for (const setting of settings) this.panel.append(this.makeSettingRow(setting));
  }

  private makeSettingRow(setting: SettingMetadata): HTMLElement {
    const row = document.createElement("article");
    row.className = "settings-setting-row";
    row.dataset.settingId = setting.id;
    appendText(row, "h3", "", setting.title);
    appendText(row, "p", "settings-setting-description", setting.description);
    const metadata = document.createElement("div");
    metadata.className = "settings-setting-meta";
    appendText(metadata, "span", "", `カテゴリ: ${setting.category}`);
    appendText(metadata, "span", "", `範囲: ${setting.scope === "user" ? "ユーザー" : "プロジェクト"}`);
    appendText(metadata, "span", "", `提供元: ${setting.owner}`);
    appendText(metadata, "span", "", `既定値: ${defaultText(setting)}`);
    row.append(metadata);

    const read = this.options.settings.getValue(setting.id);
    const control = this.makeSettingControl(setting, read);
    row.append(control);
    const error = this.errors.get(setting.id) ?? failureMessage(read);
    if (error !== null && error !== undefined) {
      const message = appendText(row, "p", "settings-inline-error", error);
      message.id = `setting-error-${this.safeId(setting.id)}`;
      message.setAttribute("role", "alert");
      control.setAttribute("aria-describedby", message.id);
    }
    const reset = makeButton("既定値に戻す", "reset-setting", `reset-setting:${setting.id}`);
    reset.dataset.settingId = setting.id;
    row.append(reset);
    return row;
  }

  private makeSettingControl(setting: SettingMetadata, read: SettingReadResult): HTMLElement {
    const current = read.kind === "value" ? read.value : setting.defaultValue;
    const wrapper = document.createElement("label");
    wrapper.className = "settings-setting-control";
    appendText(wrapper, "span", "", setting.title);
    let input: HTMLInputElement | HTMLSelectElement;
    if (setting.type === "enum") {
      const select = document.createElement("select");
      for (const value of setting.options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = displaySettingValue(setting, value);
        select.append(option);
      }
      select.value = current as string;
      input = select;
    } else {
      const element = document.createElement("input");
      element.type = setting.type === "boolean" ? "checkbox" : setting.type === "number" ? "number" : "text";
      if (setting.type === "boolean") element.checked = current as boolean;
      else element.value = String(current);
      input = element;
    }
    input.dataset.settingControl = "true";
    input.dataset.settingId = setting.id;
    input.dataset.focusKey = `setting:${setting.id}`;
    input.id = `setting-control-${this.safeId(setting.id)}`;
    wrapper.htmlFor = input.id;
    wrapper.append(input);
    return wrapper;
  }

  private renderShortcuts(cheatsheet: boolean): void {
    const context = this.options.getContext();
    const bindings = this.options.keybindings.listBindings(context, !cheatsheet);
    const allPublicCommands = this.options.commands.list(context, true);
    const descriptors = new Map(allPublicCommands.map((command) => [command.id, command]));
    const query = this.searchInput.value.trim().toLocaleLowerCase();
    const rows = bindings.filter((entry) => {
      if (cheatsheet && !entry.enabled) return false;
      const descriptor = descriptors.get(entry.commandId);
      const currentDisplay = entry.keybinding === null ? "未割り当て" : formatKeybinding(entry.keybinding);
      const defaultDisplay = entry.defaultKeybinding === null ? "なし" : formatKeybinding(entry.defaultKeybinding);
      const searchable = [entry.commandId, entry.title, entry.category ?? "", entry.when ?? "", entry.keybinding ?? "", entry.defaultKeybinding ?? "",
        currentDisplay, defaultDisplay,
        descriptor?.description ?? "", ...(descriptor?.keywords ?? [])].join(" ").toLocaleLowerCase();
      return query.length === 0 || fuzzyMatch(searchable, query);
    });

    if (!cheatsheet) {
      const toolbar = document.createElement("div");
      toolbar.className = "settings-center-toolbar";
      toolbar.append(makeButton("すべての割り当てをリセット", "reset-all-bindings", "reset-all-bindings"));
      this.panel.append(toolbar);
      const notices = this.options.keybindings.getCollisionNotices();
      if (notices.length > 0) this.panel.append(this.makeCollisionNoticePanel(notices));
      if (this.conflict !== null) this.panel.append(this.makeConflictPanel());
    }
    if (rows.length === 0) appendText(this.panel, "p", "settings-center-empty", "一致するショートカットはありません。");
    const list = document.createElement("div");
    list.className = "settings-command-list";
    for (const entry of rows) list.append(this.makeCommandRow(entry, cheatsheet));
    this.panel.append(list);
  }

  private makeCommandRow(entry: KeybindingEntry, cheatsheet: boolean): HTMLElement {
    const row = document.createElement("article");
    row.className = "settings-command-row";
    row.dataset.commandId = entry.commandId;
    appendText(row, "h3", "", entry.title);
    appendText(row, "small", "settings-command-category", entry.category ?? "");
    if (!entry.enabled) appendText(row, "span", "settings-command-disabled", "現在利用できません");
    const binding = entry.keybinding === null ? "未割り当て" : formatKeybinding(entry.keybinding);
    appendText(row, "span", "settings-command-effective", `現在: ${binding}`);
    appendText(row, "span", "settings-command-default", `既定: ${entry.defaultKeybinding === null ? "なし" : formatKeybinding(entry.defaultKeybinding)}`);
    if (!cheatsheet) {
      const isRecording = this.recordingCommandId === entry.commandId;
      if (isRecording) {
        const recorder = document.createElement("input");
        recorder.id = "shortcut-recorder";
        recorder.type = "text";
        recorder.readOnly = true;
        recorder.placeholder = "キーの組み合わせを入力";
        recorder.setAttribute("aria-label", `${entry.title} のショートカットを記録`);
        recorder.dataset.commandId = entry.commandId;
        recorder.dataset.focusKey = `recorder:${entry.commandId}`;
        recorder.value = this.draftBinding?.commandId === entry.commandId ? formatKeybinding(this.draftBinding.binding) : "";
        row.append(recorder);
        row.append(makeButton("保存", "save-binding", `save-binding:${entry.commandId}`, entry.commandId));
        row.append(makeButton("記録をキャンセル", "cancel-recording", `cancel-recording:${entry.commandId}`, entry.commandId));
      } else {
        row.append(makeButton("記録", "record-binding", `record-binding:${entry.commandId}`, entry.commandId));
      }
      row.append(makeButton("解除", "unbind", `unbind:${entry.commandId}`, entry.commandId));
      row.append(makeButton("既定値に戻す", "reset-binding", `reset-binding:${entry.commandId}`, entry.commandId));
    }
    return row;
  }

  private makeCollisionNoticePanel(notices: readonly KeybindingCollisionNotice[]): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "settings-binding-notices";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-labelledby", "settings-binding-notices-title");
    appendText(panel, "h3", "", "ショートカットの重複を解決しました").id = "settings-binding-notices-title";
    const list = document.createElement("ul");
    const titleOf = (commandId: string) => this.options.commands.get(commandId)?.title ?? commandId;
    for (const notice of notices) {
      const item = document.createElement("li");
      item.dataset.commandId = notice.commandId;
      item.dataset.noticeKind = notice.kind;
      item.textContent = describeKeybindingCollisionNotice(notice, titleOf);
      list.append(item);
    }
    panel.append(list);
    return panel;
  }

  private makeConflictPanel(): HTMLElement {
    const conflict = this.conflict;
    if (conflict === null) return document.createElement("section");
    const panel = document.createElement("section");
    panel.className = "settings-binding-conflict";
    panel.setAttribute("aria-labelledby", "settings-binding-conflict-title");
    appendText(panel, "h3", "", "ショートカットが重複しています").id = "settings-binding-conflict-title";
    const target = this.options.commands.get(conflict.commandId)?.title ?? conflict.commandId;
    const names = conflict.commandIds.map((id) => this.options.commands.get(id)?.title ?? id);
    appendText(panel, "p", "", `${target} を ${formatKeybinding(conflict.binding)} に割り当てると、${names.join("、")} の割り当てが解除されます。`);
    panel.append(
      makeButton("置き換える", "replace-binding", "replace-binding", conflict.commandId),
      makeButton("キャンセル", "cancel-binding", "cancel-binding", conflict.commandId)
    );
    return panel;
  }

  private onClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action]") : null;
    if (target === null || !this.dialog.contains(target)) return;
    const action = target.dataset.action;
    const commandId = target.dataset.commandId;
    if (action === "reset-setting" && target.dataset.settingId !== undefined) {
      const id = target.dataset.settingId;
      const result = this.options.settings.reset(id);
      this.setSettingError(id, result);
      return;
    }
    if (action === "reset-category") {
      const category = this.categoryFilter.value;
      if (category.length === 0) {
        this.status.textContent = "カテゴリを選択してください。";
        return;
      }
      const settings = this.options.settings.list().filter((setting) => setting.category === category && setting.scope === "user");
      this.applyResets(settings.map((setting) => setting.id));
      return;
    }
    if (action === "reset-all-settings") {
      const results = this.options.settings.resetAllUserSettings();
      this.applyResetResults(results.map(({ id, result }) => [id, result] as const));
      return;
    }
    if (action === "record-binding" && commandId !== undefined) {
      this.recordingCommandId = commandId;
      this.draftBinding = null;
      this.conflict = null;
      this.render();
      this.findFocusTarget(`recorder:${commandId}`)?.focus();
      this.status.textContent = "ショートカットを入力してから保存してください。";
      return;
    }
    if (action === "save-binding" && commandId !== undefined) {
      if (this.draftBinding?.commandId !== commandId) {
        this.status.textContent = "先にキーの組み合わせを入力してください。";
        return;
      }
      this.saveBinding(commandId, this.draftBinding.binding, "cancel");
      return;
    }
    if (action === "unbind" && commandId !== undefined) {
      const result = this.options.keybindings.setBinding(commandId, null);
      this.handleBindingResult(result);
      return;
    }
    if (action === "reset-binding" && commandId !== undefined) {
      const result = this.options.keybindings.resetBinding(commandId);
      if (result.kind === "conflict") {
        const binding = this.options.keybindings.getDefaultBinding(commandId);
        if (binding !== null) {
          this.draftBinding = { commandId, binding };
          this.conflict = { commandId, binding, commandIds: result.commandIds, reset: true };
        }
        this.status.textContent = "既定の割り当てが別のコマンドと重複しています。";
        this.render();
      } else if (result.kind === "updated") {
        this.status.textContent = "既定の割り当てに戻しました。";
        this.recordingCommandId = null;
        this.draftBinding = null;
        this.conflict = null;
        this.render();
      } else if (result.kind === "rejected") {
        this.status.textContent = `保存できませんでした: ${result.reason}`;
        this.render();
      } else {
        this.status.textContent = "既定の割り当てを使用しています。";
        this.render();
      }
      return;
    }
    if (action === "replace-binding" && this.conflict !== null) {
      if (this.conflict.reset) {
        this.handleBindingResult(this.options.keybindings.resetBinding(this.conflict.commandId, "replace"));
      } else {
        this.saveBinding(this.conflict.commandId, this.conflict.binding, "replace");
      }
      return;
    }
    if (action === "cancel-binding") {
      const commandId = this.conflict?.commandId;
      this.conflict = null;
      this.recordingCommandId = null;
      this.draftBinding = null;
      this.status.textContent = "割り当ての変更をキャンセルしました。";
      this.render();
      if (commandId !== undefined) this.findFocusTarget(`record-binding:${commandId}`)?.focus();
      return;
    }
    if (action === "cancel-recording") {
      const commandId = this.recordingCommandId;
      this.recordingCommandId = null;
      this.draftBinding = null;
      this.conflict = null;
      this.status.textContent = "記録をキャンセルしました。";
      this.render();
      if (commandId !== null) this.findFocusTarget(`record-binding:${commandId}`)?.focus();
      return;
    }
    if (action === "reset-all-bindings") {
      const changed = this.options.keybindings.resetAllBindings();
      if (!changed && this.options.keybindings.hasUserOverrides()) {
        this.status.textContent = "割り当てを保存できず、既定値に戻せませんでした。変更は保持されています。";
        this.render();
        return;
      }
      this.conflict = null;
      this.recordingCommandId = null;
      this.draftBinding = null;
      this.status.textContent = changed ? "すべての割り当てを既定値に戻しました。" : "既定の割り当てを使用しています。";
      this.render();
    }
  }

  private onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || target.dataset.settingControl !== "true") return;
    const id = target.dataset.settingId;
    if (id === undefined) return;
    const metadata = this.options.settings.get(id);
    if (metadata === null) return;
    let value: SettingValue;
    if (metadata.type === "boolean") value = (target as HTMLInputElement).checked;
    else if (metadata.type === "number") value = target.value.trim().length === 0 ? Number.NaN : Number(target.value);
    else value = target.value;
    this.setSettingError(id, this.options.settings.setValue(id, value));
  }

  private setSettingError(id: string, result: SettingWriteResult): void {
    const message = failureMessage(result);
    if (message === null) {
      this.errors.delete(id);
      this.status.textContent = "設定を保存しました。";
    } else {
      this.errors.set(id, message);
      this.status.textContent = "設定を保存できませんでした。";
    }
    this.render();
  }

  private applyResets(ids: readonly string[]): void {
    this.applyResetResults(ids.map((id) => [id, this.options.settings.reset(id)] as const));
  }

  private applyResetResults(entries: readonly (readonly [string, SettingWriteResult])[]): void {
    let failed = 0;
    for (const [id, result] of entries) {
      const message = failureMessage(result);
      if (message === null) this.errors.delete(id);
      else { this.errors.set(id, message); failed += 1; }
    }
    this.status.textContent = failed === 0 ? "設定をリセットしました。" : `${failed} 件の設定をリセットできませんでした。`;
    this.render();
  }

  private saveBinding(commandId: string, binding: string, resolution: "cancel" | "replace"): void {
    const result = this.options.keybindings.setBinding(commandId, binding, resolution);
    this.handleBindingResult(result);
  }

  private handleBindingResult(result: KeybindingChangeResult): void {
    if (result.kind === "conflict") {
      const commandId = this.recordingCommandId ?? this.draftBinding?.commandId;
      const binding = this.draftBinding?.binding;
      if (commandId !== undefined && commandId !== null && binding !== undefined) {
        this.conflict = { commandId, binding, commandIds: result.commandIds, reset: false };
      }
      this.status.textContent = "重複を確認してください。";
      this.render();
      return;
    }
    this.conflict = null;
    this.recordingCommandId = null;
    this.draftBinding = null;
    if (result.kind === "updated") this.status.textContent = result.keybinding === null ? "割り当てを解除しました。" : "ショートカットを保存しました。";
    else {
      this.status.textContent = `保存できませんでした: ${result.reason}`;
      this.options.onError?.(result.reason);
    }
    this.render();
    if (result.kind === "updated") this.findFocusTarget(`record-binding:${result.commandId}`)?.focus();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.recordingCommandId === null) {
      if (event.key === "Escape") {
        // Search inputs otherwise consume the first Escape to clear their value.
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.recordingCommandId = null;
      this.draftBinding = null;
      this.conflict = null;
      this.status.textContent = "記録をキャンセルしました。";
      this.render();
      return;
    }
    if (!(event.target instanceof HTMLInputElement)
      || event.target.id !== "shortcut-recorder"
      || event.key === "Tab"
      || event.key === "Enter") return;
    const binding = parseKeyboardEvent(event);
    if (binding === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.draftBinding = { commandId: this.recordingCommandId, binding };
    this.status.textContent = `記録しました: ${formatKeybinding(binding)}。保存を押してください。`;
    const recorder = this.dialog.querySelector<HTMLInputElement>("#shortcut-recorder");
    if (recorder !== null) recorder.value = formatKeybinding(binding);
  }

  private onClose(): void {
    this.recordingCommandId = null;
    this.draftBinding = null;
    this.conflict = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    else document.querySelector<HTMLElement>("#open-markdown, #save-markdown, #toolbar-toggle-editor-only")?.focus();
    this.previousFocus = null;
    this.options.onOpenStateChanged?.(false);
  }

  private currentFocusKey(): string | null {
    const active = document.activeElement;
    return active instanceof HTMLElement && this.dialog.contains(active) ? active.dataset.focusKey ?? null : null;
  }

  private findFocusTarget(key: string): HTMLElement | null {
    return [...this.dialog.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.dataset.focusKey === key) ?? null;
  }

  private safeId(value: string): string {
    return value.replace(/[^a-z0-9_-]/giu, "-");
  }
}
