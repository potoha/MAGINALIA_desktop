/** Narrow, versionless bridge between the renderer Command Registry and the native application menu. */

export const UPDATE_APPLICATION_MENU_CHANNEL = "maginalia:update-application-menu";
export const APPLICATION_MENU_COMMAND_CHANNEL = "maginalia:application-menu-command";

export const APPLICATION_MENU_MANIFEST = [
  {
    label: "ファイル",
    items: [
      { kind: "command", id: "maginalia.document.open", label: "ドキュメントを開く…" },
      { kind: "command", id: "maginalia.workbench.showQuickOpen", label: "Project 内の文書を開く…" },
      { kind: "command", id: "maginalia.project.open", label: "別の Project を開く…" },
      { kind: "command", id: "maginalia.workdesk.open", label: "Workdesk を開く…" },
      { kind: "command", id: "maginalia.workdesk.create", label: "Workdesk を作成…" },
      { kind: "command", id: "maginalia.workdesk.return", label: "Workdesk に戻る" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.document.save", label: "保存" },
      { kind: "command", id: "maginalia.document.closeView", label: "タブを閉じる" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.document.export", label: "Markdown をエクスポート…" },
      { kind: "command", id: "maginalia.document.exportPdf", label: "PDF にエクスポート…" },
      { kind: "command", id: "maginalia.document.exportDocx", label: "DOCX にエクスポート…" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.settings.open", label: "設定…" },
      { kind: "command", id: "maginalia.settings.shortcuts", label: "ショートカット設定…" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.collector.configureSaveDestination", label: "Collector の保存先を設定…" },
      { kind: "command", id: "maginalia.collector.clearSaveDestination", label: "Collector の保存先を解除…" }
    ]
  },
  {
    label: "編集",
    items: [
      { kind: "command", id: "maginalia.editor.undo", label: "元に戻す" },
      { kind: "command", id: "maginalia.editor.redo", label: "やり直す" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.editor.findInDocument", label: "本文内を検索" },
      { kind: "command", id: "maginalia.editor.replaceInDocument", label: "本文内を置換" },
      { kind: "separator" },
      { kind: "role", role: "cut", label: "切り取り" },
      { kind: "role", role: "copy", label: "コピー" },
      { kind: "role", role: "paste", label: "貼り付け" },
      { kind: "separator" },
      { kind: "role", role: "selectAll", label: "すべて選択" }
    ]
  },
  {
    label: "表示",
    items: [
      { kind: "command", id: "maginalia.renderer.showEdit", label: "編集画面" },
      { kind: "command", id: "maginalia.renderer.showPreview", label: "プレビュー" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.view.show.workspace", label: "Project" },
      { kind: "command", id: "maginalia.view.show.library", label: "Shelf" },
      { kind: "command", id: "maginalia.view.show.menu", label: "メニュー" },
      { kind: "command", id: "maginalia.view.show.properties", label: "プロパティ" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.view.togglePrimarySidebar", label: "Project サイドバーを表示／非表示" },
      { kind: "command", id: "maginalia.view.toggleSecondarySidebar", label: "Shelf サイドバーを表示／非表示" },
      { kind: "command", id: "maginalia.view.toggleActivityBar", label: "アクティビティバーを表示／非表示" },
      { kind: "command", id: "maginalia.view.toggleEditorOnly", label: "エディターのみの表示を切り替え" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.workbench.showCommandPalette", label: "コマンドパレットを表示…" }
    ]
  },
  {
    label: "挿入",
    items: [
      { kind: "command", id: "maginalia.editor.insertTable", label: "表を挿入" },
      { kind: "command", id: "maginalia.editor.insertInternalLink", label: "Project 内リンクを挿入" },
      { kind: "command", id: "maginalia.editor.insertExternalLink", label: "外部リンクを挿入" },
      { kind: "command", id: "maginalia.editor.importImage", label: "画像を挿入…" }
    ]
  },
  {
    label: "書式",
    items: [
      { kind: "command", id: "maginalia.editor.setParagraph", label: "段落" },
      { kind: "command", id: "maginalia.editor.setHeading1", label: "見出し 1" },
      { kind: "command", id: "maginalia.editor.setHeading2", label: "見出し 2" },
      { kind: "command", id: "maginalia.editor.setHeading3", label: "見出し 3" },
      { kind: "command", id: "maginalia.editor.setHeading4", label: "見出し 4" },
      { kind: "command", id: "maginalia.editor.setHeading5", label: "見出し 5" },
      { kind: "command", id: "maginalia.editor.setHeading6", label: "見出し 6" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.editor.toggleBold", label: "太字" },
      { kind: "command", id: "maginalia.editor.toggleItalic", label: "斜体" },
      { kind: "command", id: "maginalia.editor.toggleInlineCode", label: "インラインコード" },
      { kind: "command", id: "maginalia.editor.toggleBulletList", label: "箇条書き" },
      { kind: "command", id: "maginalia.editor.toggleNumberedList", label: "番号付きリスト" },
      { kind: "command", id: "maginalia.editor.toggleBlockquote", label: "引用" },
      { kind: "separator" },
      { kind: "command", id: "maginalia.renderer.setHorizontal", label: "横書き" },
      { kind: "command", id: "maginalia.renderer.setVertical", label: "縦書き" }
    ]
  },
  {
    label: "ウィンドウ",
    items: [
      { kind: "role", role: "minimize", label: "最小化" },
      { kind: "role", role: "close", label: "閉じる" }
    ]
  },
  {
    label: "ヘルプ",
    items: [
      { kind: "command", id: "maginalia.help.openManual", label: "取扱説明書を開く" },
      { kind: "command", id: "maginalia.help.cheatSheet", label: "ショートカット一覧" }
    ]
  }
] as const;

type ApplicationMenuManifestEntry = (typeof APPLICATION_MENU_MANIFEST)[number]["items"][number];
export type ApplicationMenuCommandId = Extract<ApplicationMenuManifestEntry, { readonly kind: "command" }>["id"];
export type ApplicationMenuCommandState = {
  readonly id: ApplicationMenuCommandId;
  readonly enabled: boolean;
  readonly shortcut?: string;
};

export const APPLICATION_MENU_COMMAND_IDS: readonly ApplicationMenuCommandId[] = Object.freeze(
  APPLICATION_MENU_MANIFEST.flatMap((menu) => menu.items.flatMap((item) => item.kind === "command" ? [item.id] : []))
);

const applicationMenuCommandIdSet: ReadonlySet<string> = new Set(APPLICATION_MENU_COMMAND_IDS);

export function isApplicationMenuCommandId(value: unknown): value is ApplicationMenuCommandId {
  return typeof value === "string" && applicationMenuCommandIdSet.has(value);
}

export type AcceleratorPlatform = "darwin" | "linux" | "win32" | string;

const MODIFIER_ALIASES: Readonly<Record<string, "Control" | "Command" | "Super" | "Meta" | "Alt" | "Shift">> = {
  ctrl: "Control",
  control: "Control",
  meta: "Meta",
  cmd: "Command",
  command: "Command",
  super: "Super",
  alt: "Alt",
  option: "Alt",
  shift: "Shift"
};

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Return",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  plus: "Plus",
  minus: "Minus",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
  semicolon: ";",
  quote: "'",
  equal: "="
};

type ParsedApplicationMenuShortcut = {
  readonly modifiers: readonly string[];
  readonly key: string;
  readonly electronSupported: boolean;
};

function parseApplicationMenuShortcut(value: string, platform: AcceleratorPlatform): ParsedApplicationMenuShortcut | null {
  if (value.length === 0 || value.length > 64) return null;
  const tokens = value.split("+").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) return null;

  const modifiers: string[] = [];
  let key: string | null = null;
  let electronSupported = false;
  for (const token of tokens) {
    const modifierName = token.toLowerCase();
    const modifier = Object.hasOwn(MODIFIER_ALIASES, modifierName) ? MODIFIER_ALIASES[modifierName] : undefined;
    if (modifier !== undefined) {
      const electronModifier = modifier === "Meta"
        ? (platform === "darwin" ? "Command" : "Super")
        : modifier;
      if (modifiers.includes(electronModifier)) return null;
      modifiers.push(electronModifier);
      continue;
    }
    if (key !== null) return null;
    const normalizedToken = token.toLowerCase();
    const namedKey = Object.hasOwn(ELECTRON_KEY_NAMES, normalizedToken) ? ELECTRON_KEY_NAMES[normalizedToken] : undefined;
    if (namedKey !== undefined) {
      key = namedKey;
      electronSupported = true;
    } else if (/^[a-z0-9]$/iu.test(token)) {
      key = token.toUpperCase();
      electronSupported = true;
    } else if (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(token)) {
      key = token.toUpperCase();
      electronSupported = true;
    } else if (Array.from(token).length === 1 && !/\p{C}/u.test(token)) {
      // Keep Unicode printable keys valid in keybinding state. Electron's
      // accelerator syntax cannot represent every such key, so those bindings
      // remain usable in the renderer while their native menu display is omitted.
      key = token;
    } else {
      return null;
    }
  }
  if (key === null) return null;
  return { modifiers, key, electronSupported };
}

/** Validate bounded shortcut syntax, including printable Unicode keys. */
export function isBoundedApplicationMenuShortcut(value: string): boolean {
  return parseApplicationMenuShortcut(value, "win32") !== null;
}

/** Convert user-facing shortcut notation to Electron's platform accelerator spelling. */
export function normalizeApplicationMenuAccelerator(value: string, platform: AcceleratorPlatform): string | null {
  const parsed = parseApplicationMenuShortcut(value, platform);
  if (parsed === null || !parsed.electronSupported) return null;
  return [...parsed.modifiers, parsed.key].join("+");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

/** Validate renderer-supplied state before it can change the native menu. */
export function isApplicationMenuSnapshot(value: unknown): value is readonly ApplicationMenuCommandState[] {
  if (!Array.isArray(value) || value.length > APPLICATION_MENU_COMMAND_IDS.length) return false;
  const seen = new Set<ApplicationMenuCommandId>();
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    const hasShortcut = Object.hasOwn(entry, "shortcut");
    if (!hasExactKeys(entry, hasShortcut ? ["id", "enabled", "shortcut"] : ["id", "enabled"])) return false;
    if (!isApplicationMenuCommandId(entry.id) || typeof entry.enabled !== "boolean" || seen.has(entry.id)) return false;
    if (hasShortcut && (typeof entry.shortcut !== "string" || !isBoundedApplicationMenuShortcut(entry.shortcut))) {
      return false;
    }
    seen.add(entry.id);
  }
  return true;
}
