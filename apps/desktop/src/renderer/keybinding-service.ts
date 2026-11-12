import { APPLICATION_MENU_ROLE_RESERVED_KEYBINDINGS } from "../application-menu-contract";
import type { CommandContext } from "./command-context";
import type { CommandDescriptor, CommandRegistry } from "./command-registry";

/** `Mod` is the platform's primary shortcut modifier: Ctrl on Windows/Linux and Command on macOS. */
export type KeybindingPlatform = "windows" | "linux" | "mac";

export interface KeybindingEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly getModifierState?: (key: string) => boolean;
}

export interface KeybindingEntry {
  readonly commandId: string;
  readonly title: string;
  readonly category?: string;
  readonly when?: string;
  readonly enabled: boolean;
  readonly keybinding: string | null;
  readonly defaultKeybinding: string | null;
}

export interface KeybindingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface KeybindingServiceOptions {
  readonly platform?: KeybindingPlatform;
  /** Pass null to use in-memory bindings only. Defaults to the renderer's localStorage. */
  readonly storage?: KeybindingStorage | null;
}

export type KeybindingChangeResult =
  | { readonly kind: "updated"; readonly commandId: string; readonly keybinding: string | null }
  | { readonly kind: "conflict"; readonly commandIds: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: "command-not-found" | "command-internal" | "invalid-keybinding" | "reserved-keybinding" | "storage-unavailable" };

export type KeybindingConflictResolution = "cancel" | "replace";

/**
 * A persisted or default binding that could not stay effective because it
 * would make one chord ambiguous or collide with a reserved/native chord.
 * Resolution is deterministic and surfaced in the Shortcut Editor.
 */
export type KeybindingCollisionNotice =
  | {
    /** A later persisted override reused a chord already claimed by an earlier override; it is now unbound. */
    readonly kind: "duplicate-override";
    readonly commandId: string;
    readonly keybinding: string;
    readonly keptCommandId: string;
  }
  | {
    /** A persisted override used a reserved OS or native-menu chord; it was ignored. */
    readonly kind: "reserved-override";
    readonly commandId: string;
    readonly keybinding: string;
  }
  | {
    /** A default binding is shadowed by another command's user override. */
    readonly kind: "default-shadowed";
    readonly commandId: string;
    readonly keybinding: string;
    readonly keptCommandId: string;
  };

interface PersistedKeybindingsV1 {
  readonly version: 1;
  readonly overrides: Readonly<Record<string, string | null>>;
}

const STORAGE_KEY = "maginalia.keybindings.v1";
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/iu;
const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const NAVIGATION_KEYS = new Set([
  "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Backspace", "Delete", "End", "Enter", "Escape",
  "Home", "Insert", "PageDown", "PageUp", "Space", "Tab"
]);
const PRINTABLE_PUNCTUATION_KEYS = new Set([
  "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal", "Minus", "Period", "Plus", "Quote", "Semicolon", "Slash"
]);

/** Defaults are immutable application metadata; user overrides are stored separately. */
export const DEFAULT_KEYBINDINGS: Readonly<Record<string, string>> = Object.freeze({
  "maginalia.document.save": "Mod+S",
  "maginalia.workbench.showCommandPalette": "Mod+Shift+P",
  "maginalia.workbench.showQuickOpen": "Mod+P",
  "maginalia.editor.findInDocument": "Mod+F",
  "maginalia.editor.replaceInDocument": "Mod+H",
  "maginalia.view.togglePrimarySidebar": "Mod+Shift+B",
  "maginalia.view.toggleSecondarySidebar": "Mod+Shift+S",
  "maginalia.view.toggleActivityBar": "Mod+Shift+A",
  "maginalia.view.toggleEditorOnly": "Mod+Shift+E",
  "maginalia.editor.undo": "Mod+Z",
  "maginalia.editor.redo": "Mod+Shift+Z",
  "maginalia.editor.toggleBold": "Mod+B",
  "maginalia.editor.setParagraph": "Mod+0",
  "maginalia.editor.setHeading1": "Mod+1",
  "maginalia.editor.setHeading2": "Mod+2",
  "maginalia.editor.setHeading3": "Mod+3",
  "maginalia.editor.setHeading4": "Mod+4",
  "maginalia.editor.setHeading5": "Mod+5",
  "maginalia.editor.setHeading6": "Mod+6",
  // `Ctrl` stays Control on macOS, where Command+Tab belongs to the OS.
  "maginalia.document.activateNext": "Ctrl+Tab",
  "maginalia.document.activatePrevious": "Ctrl+Shift+Tab"
});

/** Overrides for platform conventions that differ from the portable defaults. */
export const PLATFORM_DEFAULT_KEYBINDINGS: Readonly<Record<KeybindingPlatform, Readonly<Record<string, string>>>> = Object.freeze({
  windows: Object.freeze({ "maginalia.editor.redo": "Mod+Y" }),
  linux: Object.freeze({}),
  mac: Object.freeze({})
});

export function getPlatformDefaultKeybindings(platform: KeybindingPlatform = detectPlatform()): Readonly<Record<string, string>> {
  return Object.freeze({ ...DEFAULT_KEYBINDINGS, ...PLATFORM_DEFAULT_KEYBINDINGS[platform] });
}

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  " ": "Space",
  spacebar: "Space",
  esc: "Escape",
  del: "Delete",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  pageup: "PageUp",
  pagedown: "PageDown",
  comma: "Comma",
  ",": "Comma",
  period: "Period",
  ".": "Period",
  slash: "Slash",
  "/": "Slash",
  backslash: "Backslash",
  "\\": "Backslash",
  semicolon: "Semicolon",
  ";": "Semicolon",
  quote: "Quote",
  "'": "Quote",
  bracketleft: "BracketLeft",
  "[": "BracketLeft",
  bracketright: "BracketRight",
  "]": "BracketRight",
  minus: "Minus",
  "-": "Minus",
  equal: "Equal",
  "=": "Equal",
  backquote: "Backquote",
  "`": "Backquote",
  plus: "Plus",
  "+": "Plus"
});

const SHARED_RESERVED_KEYBINDINGS = ["Mod+A", "Mod+C", "Mod+F", "Mod+Space", "Mod+V", "Mod+X", "Mod+Alt+Delete", "Alt+F4"] as const;
const WINDOWS_RESERVED_KEYBINDINGS = [
  "Alt+Tab", "Meta+A", "Meta+D", "Meta+E", "Meta+I", "Meta+L", "Meta+Q", "Meta+R", "Meta+S", "Meta+Space", "Meta+Tab", "Meta+V", "Meta+W", "Meta+X", "Meta+Z",
  "Meta+ArrowDown", "Meta+ArrowLeft", "Meta+ArrowRight", "Meta+ArrowUp", "Meta+Shift+S"
] as const;
const LINUX_RESERVED_KEYBINDINGS = ["Alt+Tab", "Meta+Tab"] as const;
const MAC_RESERVED_KEYBINDINGS = ["Mod+Q", "Mod+Space", "Mod+Tab", "Ctrl+ArrowDown", "Ctrl+ArrowLeft", "Ctrl+ArrowRight", "Ctrl+ArrowUp"] as const;

function detectPlatform(): KeybindingPlatform {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (/mac|iphone|ipad/iu.test(platform)) return "mac";
  if (/linux/iu.test(platform)) return "linux";
  return "windows";
}

function defaultStorage(): KeybindingStorage | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function canonicalKey(raw: string): string | null {
  if (raw === " ") return "Space";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLocaleLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias !== undefined) return alias;
  if (/^[a-z0-9]$/iu.test(trimmed)) return trimmed.toLocaleUpperCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(trimmed)) return trimmed.toLocaleUpperCase();

  const specialKeys: Readonly<Record<string, string>> = {
    arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp",
    backspace: "Backspace", delete: "Delete", end: "End", enter: "Enter", escape: "Escape", home: "Home",
    insert: "Insert", pagedown: "PageDown", pageup: "PageUp", space: "Space", tab: "Tab"
  };
  if (specialKeys[lower] !== undefined) return specialKeys[lower];

  // Keep Unicode printable keys, including combining sequences, usable when a layout reports them directly.
  if (/^\P{C}(?:\p{M}|\uFE0F)*$/u.test(trimmed)) return trimmed;
  return null;
}

function canonicalModifier(raw: string, platform: KeybindingPlatform): string | null {
  switch (raw.trim().toLocaleLowerCase()) {
    case "mod": case "primary": return "Mod";
    case "super": return "Meta";
    case "ctrl": case "control": return platform === "mac" ? "Ctrl" : "Mod";
    case "alt": case "option": return "Alt";
    case "shift": return "Shift";
    case "meta": case "cmd": case "command": return platform === "mac" ? "Mod" : "Meta";
    default: return null;
  }
}

/** Normalize one chord to a stable string (for example `Mod+Shift+P`). */
export function normalizeKeybinding(value: string, platform: KeybindingPlatform = detectPlatform()): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const tokens = value.split("+").map((token) => token.trim());
  const modifiers = new Set<string>();
  const keys: string[] = [];
  for (const token of tokens) {
    if (token.length === 0) return null;
    const modifier = canonicalModifier(token, platform);
    if (modifier !== null) modifiers.add(modifier);
    else {
      const key = canonicalKey(token);
      if (key === null) return null;
      keys.push(key);
    }
  }
  if (keys.length !== 1) return null;
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, keys[0]].join("+");
}

/** Convert a recorder event to a canonical chord; composition and modifier-only events are ignored. */
export function parseKeyboardEvent(event: KeybindingEvent, platform: KeybindingPlatform = detectPlatform()): string | null {
  if (event.isComposing || event.getModifierState?.("AltGraph") === true || ["Process", "Dead", "Unidentified"].includes(event.key)) return null;
  const key = canonicalKey(event.key);
  if (key === null || MODIFIERS.has(key)) return null;

  const modifiers: string[] = [];
  const primaryIsMeta = platform === "mac";
  if (event.ctrlKey) modifiers.push(primaryIsMeta ? "Ctrl" : "Mod");
  if (event.metaKey) modifiers.push(primaryIsMeta ? "Mod" : "Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return normalizeKeybinding([...modifiers, key].join("+"), platform);
}

/** Format a canonical chord for a shortcut list or settings row. */
export function formatKeybinding(value: string, platform: KeybindingPlatform = detectPlatform()): string {
  const normalized = normalizeKeybinding(value, platform);
  if (normalized === null) return "";
  if (platform === "mac") {
    return normalized.split("+").map((token) => ({ Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }[token] ?? token)).join("");
  }
  return normalized.split("+").map((token) => token === "Mod" ? "Ctrl" : token).join("+");
}

/** Return Electron-friendly modifier spelling while keeping `Mod` portable in storage. */
export function toPlatformKeybinding(value: string, platform: KeybindingPlatform = detectPlatform()): string | null {
  const normalized = normalizeKeybinding(value, platform);
  if (normalized === null) return null;
  const primary = platform === "mac" ? "Meta" : "Ctrl";
  return normalized.split("+").map((token) => token === "Mod" ? primary : token).join("+");
}

function isPrintableKey(key: string): boolean {
  if (key === "Space" || PRINTABLE_PUNCTUATION_KEYS.has(key) || /^[a-z0-9]$/iu.test(key)) return true;
  if (NAVIGATION_KEYS.has(key) || /^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(key)) return false;
  return /^\P{C}(?:\p{M}|\uFE0F)*$/u.test(key);
}

function isSafeUserBinding(binding: string, platform: KeybindingPlatform, commandId: string, defaults: Readonly<Record<string, string>>): boolean {
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  const hasCommandModifier = parts.slice(0, -1).some((part) => part !== "Shift");
  if (!hasCommandModifier && (isPrintableKey(key) || NAVIGATION_KEYS.has(key))) return false;
  const platformReserved = platform === "mac" ? MAC_RESERVED_KEYBINDINGS : platform === "windows" ? WINDOWS_RESERVED_KEYBINDINGS : LINUX_RESERVED_KEYBINDINGS;
  if (SHARED_RESERVED_KEYBINDINGS.includes(binding as typeof SHARED_RESERVED_KEYBINDINGS[number])
    || platformReserved.includes(binding as never)
    // Native application-menu roles (for example Window > Close on Mod+W)
    // are registered by Electron and would win over a renderer shortcut.
    || APPLICATION_MENU_ROLE_RESERVED_KEYBINDINGS.includes(binding)) {
    const defaultBinding = defaults[commandId];
    return defaultBinding !== undefined && normalizeKeybinding(defaultBinding, platform) === binding;
  }
  return true;
}

/** Application-owned shortcut overrides. The CommandRegistry remains the command authority. */
export class KeybindingService {
  private readonly platform: KeybindingPlatform;
  private readonly defaults: Readonly<Record<string, string>>;
  private readonly storage: KeybindingStorage | undefined;
  private readonly allowInMemoryOnly: boolean;
  private readonly overrides: Map<string, string | null>;
  /** Chord -> command that owns it through a user override (unique by construction). */
  private readonly overrideOwners = new Map<string, string>();
  private readonly loadNotices: readonly KeybindingCollisionNotice[];
  private readonly listeners = new Set<() => void>();
  private readonly registrySubscription: () => void;

  public constructor(
    private readonly registry: CommandRegistry,
    options: KeybindingServiceOptions = {}
  ) {
    this.platform = options.platform ?? detectPlatform();
    this.defaults = getPlatformDefaultKeybindings(this.platform);
    this.allowInMemoryOnly = options.storage === null;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage ?? undefined;
    const loaded = this.readOverrides();
    this.overrides = loaded.overrides;
    this.loadNotices = Object.freeze(loaded.notices);
    this.indexOverrideOwners();
    this.registrySubscription = registry.onDidChange(() => this.notify());
  }

  public getBinding(commandId: string): string | null {
    const command = this.registry.get(commandId);
    if (command === null || command.visibility === "internal") return null;
    if (this.overrides.has(commandId)) return this.overrides.get(commandId) ?? null;
    const defaultBinding = this.getDefaultBinding(commandId);
    // A user override on another live command takes the chord; the default is
    // shadowed rather than left ambiguous (which would swallow the key).
    return defaultBinding !== null && this.shadowingOverrideOwner(commandId, defaultBinding) !== null ? null : defaultBinding;
  }

  /**
   * Deterministic collision resolutions from loading persisted overrides, plus
   * defaults currently shadowed by another command's override.
   */
  public getCollisionNotices(): readonly KeybindingCollisionNotice[] {
    // Load notices stay relevant only while the user has not since rebound the
    // affected command (a duplicate stays unbound until then).
    const notices: KeybindingCollisionNotice[] = this.loadNotices.filter((notice) => notice.kind === "reserved-override"
      ? !this.overrides.has(notice.commandId)
      : this.overrides.get(notice.commandId) === null);
    for (const commandId of Object.keys(this.defaults).sort()) {
      const command = this.registry.get(commandId);
      if (command === null || command.visibility === "internal" || this.overrides.has(commandId)) continue;
      const defaultBinding = this.getDefaultBinding(commandId);
      const owner = defaultBinding === null ? null : this.shadowingOverrideOwner(commandId, defaultBinding);
      if (defaultBinding !== null && owner !== null) {
        notices.push({ kind: "default-shadowed", commandId, keybinding: defaultBinding, keptCommandId: owner });
      }
    }
    return Object.freeze(notices);
  }

  /** True when at least one persisted user override is still active in memory. */
  public hasUserOverrides(): boolean {
    return this.overrides.size > 0;
  }

  public getDefaultBinding(commandId: string): string | null {
    const value = this.defaults[commandId];
    return value === undefined ? null : normalizeKeybinding(value, this.platform);
  }

  public listBindings(context: CommandContext = {}, includeDisabled = true): readonly KeybindingEntry[] {
    const enabledCommands = new Set(this.registry.list(context).map((command) => command.id));
    return this.registry.list(context, includeDisabled).map((command) => ({
      commandId: command.id,
      title: command.title,
      ...(command.category === undefined ? {} : { category: command.category }),
      ...(command.when === undefined ? {} : { when: command.when }),
      enabled: enabledCommands.has(command.id),
      keybinding: this.getBinding(command.id),
      defaultKeybinding: this.getDefaultBinding(command.id)
    }));
  }

  public setBinding(
    commandId: string,
    keybinding: string | null,
    resolution: KeybindingConflictResolution = "cancel"
  ): KeybindingChangeResult {
    const command = this.registry.get(commandId);
    if (command === null) return { kind: "rejected", reason: "command-not-found" };
    if (command.visibility === "internal") return { kind: "rejected", reason: "command-internal" };

    let normalized: string | null = null;
    if (keybinding !== null) {
      normalized = normalizeKeybinding(keybinding, this.platform);
      if (normalized === null) return { kind: "rejected", reason: "invalid-keybinding" };
      if (!isSafeUserBinding(normalized, this.platform, commandId, this.defaults)) {
        return { kind: "rejected", reason: "reserved-keybinding" };
      }
    }

    const conflicts = normalized === null ? [] : this.listBindings({}, true)
      .filter((entry) => entry.commandId !== commandId && entry.keybinding === normalized)
      .map((entry) => entry.commandId);
    if (conflicts.length > 0 && resolution !== "replace") return { kind: "conflict", commandIds: conflicts };

    const next = new Map(this.overrides);
    for (const conflictId of conflicts) next.set(conflictId, null);
    next.set(commandId, normalized);
    if (!this.persist(next)) return { kind: "rejected", reason: "storage-unavailable" };
    this.replaceOverrides(next);
    return { kind: "updated", commandId, keybinding: normalized };
  }

  public resetBinding(commandId: string, resolution: KeybindingConflictResolution = "cancel"): KeybindingChangeResult {
    const command = this.registry.get(commandId);
    if (command === null) return { kind: "rejected", reason: "command-not-found" };
    if (command.visibility === "internal") return { kind: "rejected", reason: "command-internal" };
    const defaultBinding = this.getDefaultBinding(commandId);
    const conflicts = defaultBinding === null ? [] : this.listBindings({}, true)
      .filter((entry) => entry.commandId !== commandId && entry.keybinding === defaultBinding)
      .map((entry) => entry.commandId);
    if (conflicts.length > 0 && resolution !== "replace") return { kind: "conflict", commandIds: conflicts };
    if (!this.overrides.has(commandId) && conflicts.length === 0) {
      return { kind: "updated", commandId, keybinding: defaultBinding };
    }
    const next = new Map(this.overrides);
    for (const conflictId of conflicts) next.set(conflictId, null);
    next.delete(commandId);
    if (!this.persist(next)) return { kind: "rejected", reason: "storage-unavailable" };
    this.replaceOverrides(next);
    return { kind: "updated", commandId, keybinding: defaultBinding };
  }

  public resetAllBindings(): boolean {
    if (this.overrides.size === 0) return false;
    const next = new Map<string, string | null>();
    if (!this.persist(next)) return false;
    this.replaceOverrides(next);
    return true;
  }

  /** Returns one enabled public command for a chord, or null for no match/ambiguity. */
  public getCommandForKeybinding(keybinding: string, context: CommandContext): CommandDescriptor | null {
    const normalized = normalizeKeybinding(keybinding, this.platform);
    if (normalized === null) return null;
    const matches = this.registry.list(context).filter((command) => this.getBinding(command.id) === normalized);
    return matches.length === 1 ? matches[0] : null;
  }

  public getCommandForEvent(event: KeybindingEvent, context: CommandContext): CommandDescriptor | null {
    const keybinding = parseKeyboardEvent(event, this.platform);
    return keybinding === null ? null : this.getCommandForKeybinding(keybinding, context);
  }

  /** Default chords that app-level routing should consume after their owner was remapped or unbound. */
  public getShadowedDefaultBindings(): readonly string[] {
    const shadowed = new Set<string>();
    for (const [commandId, rawDefault] of Object.entries(this.defaults)) {
      const command = this.registry.get(commandId);
      if (command === null || command.visibility === "internal") continue;
      const defaultBinding = normalizeKeybinding(rawDefault, this.platform);
      if (defaultBinding !== null && this.getBinding(commandId) !== defaultBinding) shadowed.add(defaultBinding);
    }
    if (this.platform === "windows") {
      const redoCommand = this.registry.get("maginalia.editor.redo");
      const monacoRedoAlternate = "Mod+Shift+Z";
      if (redoCommand !== null && redoCommand.visibility !== "internal" && this.getBinding(redoCommand.id) !== monacoRedoAlternate) {
        shadowed.add(monacoRedoAlternate);
      }
    }
    return [...shadowed].sort();
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    this.registrySubscription();
    this.listeners.clear();
  }

  private readOverrides(): { readonly overrides: Map<string, string | null>; readonly notices: KeybindingCollisionNotice[] } {
    const empty = () => ({ overrides: new Map<string, string | null>(), notices: [] });
    if (this.storage === undefined) return empty();
    let raw: string | null;
    try { raw = this.storage.getItem(STORAGE_KEY); } catch { return empty(); }
    if (raw === null) return empty();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1
        || !("overrides" in parsed) || typeof parsed.overrides !== "object" || parsed.overrides === null || Array.isArray(parsed.overrides)) return empty();
      const values = parsed.overrides as Record<string, unknown>;
      const result = new Map<string, string | null>();
      const notices: KeybindingCollisionNotice[] = [];
      const owners = new Map<string, string>();
      // Persisted files are written sorted by command ID; sort again so a
      // hand-edited or legacy file still resolves duplicates deterministically.
      for (const [commandId, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
        if (!COMMAND_ID_PATTERN.test(commandId)) continue;
        if (value === null) result.set(commandId, null);
        else if (typeof value === "string") {
          const normalized = normalizeKeybinding(value, this.platform);
          if (normalized === null) continue;
          if (!isSafeUserBinding(normalized, this.platform, commandId, this.defaults)) {
            notices.push({ kind: "reserved-override", commandId, keybinding: normalized });
            continue;
          }
          const keptCommandId = owners.get(normalized);
          if (keptCommandId !== undefined) {
            // Keep the first valid owner; unbind the later duplicate instead of
            // falling back to a default that could collide again.
            result.set(commandId, null);
            notices.push({ kind: "duplicate-override", commandId, keybinding: normalized, keptCommandId });
            continue;
          }
          owners.set(normalized, commandId);
          result.set(commandId, normalized);
        }
      }
      return { overrides: result, notices };
    } catch {
      return empty();
    }
  }

  private indexOverrideOwners(): void {
    this.overrideOwners.clear();
    for (const [commandId, keybinding] of this.overrides) {
      if (keybinding !== null && !this.overrideOwners.has(keybinding)) this.overrideOwners.set(keybinding, commandId);
    }
  }

  /** The live public command whose user override claims `keybinding`, if not `commandId` itself. */
  private shadowingOverrideOwner(commandId: string, keybinding: string): string | null {
    const owner = this.overrideOwners.get(keybinding);
    if (owner === undefined || owner === commandId) return null;
    const command = this.registry.get(owner);
    return command === null || command.visibility === "internal" ? null : owner;
  }

  private persist(overrides: ReadonlyMap<string, string | null>): boolean {
    if (this.storage === undefined) return this.allowInMemoryOnly;
    const sorted = Object.fromEntries([...overrides.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const payload: PersistedKeybindingsV1 = { version: 1, overrides: sorted };
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private replaceOverrides(next: ReadonlyMap<string, string | null>): void {
    this.overrides.clear();
    for (const [commandId, keybinding] of next) this.overrides.set(commandId, keybinding);
    this.indexOverrideOwners();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* one settings surface cannot break command routing */ }
    }
  }
}
