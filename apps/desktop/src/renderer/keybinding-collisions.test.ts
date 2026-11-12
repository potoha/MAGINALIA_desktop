import { describe, expect, it } from "vitest";
import { APPLICATION_MENU_MANIFEST, APPLICATION_MENU_ROLE_KEYBINDINGS, APPLICATION_MENU_ROLE_RESERVED_KEYBINDINGS } from "../application-menu-contract";
import { CommandRegistry } from "./command-registry";
import { getPlatformDefaultKeybindings, KeybindingService, normalizeKeybinding, type KeybindingPlatform } from "./keybinding-service";
import { describeKeybindingCollisionNotice } from "./settings-center";

const STORAGE_KEY = "maginalia.keybindings.v1";

class MemoryStorage {
  public readonly values = new Map<string, string>();
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public setItem(key: string, value: string): void { this.values.set(key, value); }
}

function storageWith(overrides: Record<string, string | null>): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, overrides }));
  return storage;
}

function registry(...ids: string[]): CommandRegistry {
  const commands = new CommandRegistry();
  for (const id of ids) commands.register({ id, title: id }, () => undefined);
  return commands;
}

describe("Keybinding collisions on load", () => {
  it("keeps the first persisted override for a chord, unbinds later duplicates, and reports it", () => {
    const commands = registry("maginalia.a.first", "maginalia.b.second", "maginalia.c.third");
    // Insertion order is deliberately unsorted: resolution must follow command ID order.
    const storage = storageWith({ "maginalia.c.third": "Mod+K", "maginalia.a.first": "Mod+K", "maginalia.b.second": "Mod+J" });
    const before = storage.values.get(STORAGE_KEY);
    const service = new KeybindingService(commands, { platform: "windows", storage });

    expect(service.getBinding("maginalia.a.first")).toBe("Mod+K");
    expect(service.getBinding("maginalia.c.third")).toBeNull();
    expect(service.getCommandForKeybinding("Mod+K", {})?.id).toBe("maginalia.a.first");
    expect(service.getCollisionNotices()).toEqual([
      { kind: "duplicate-override", commandId: "maginalia.c.third", keybinding: "Mod+K", keptCommandId: "maginalia.a.first" }
    ]);
    // Loading never rewrites the user's file by itself.
    expect(storage.values.get(STORAGE_KEY)).toBe(before);

    // Rebinding the dropped command clears the notice and persists the resolution.
    expect(service.setBinding("maginalia.c.third", "Mod+L").kind).toBe("updated");
    expect(service.getCollisionNotices()).toEqual([]);
  });

  it("lets a persisted override win over a colliding default so the key is never swallowed", () => {
    const commands = registry("maginalia.document.save", "maginalia.test.custom");
    const service = new KeybindingService(commands, { platform: "windows", storage: storageWith({ "maginalia.test.custom": "Mod+S" }) });

    expect(service.getBinding("maginalia.test.custom")).toBe("Mod+S");
    expect(service.getBinding("maginalia.document.save")).toBeNull();
    expect(service.getCommandForKeybinding("Mod+S", {})?.id).toBe("maginalia.test.custom");
    expect(service.listBindings({}).filter((entry) => entry.keybinding === "Mod+S")).toHaveLength(1);
    expect(service.getCollisionNotices()).toEqual([
      { kind: "default-shadowed", commandId: "maginalia.document.save", keybinding: "Mod+S", keptCommandId: "maginalia.test.custom" }
    ]);
    // The default returns once the override owner disappears.
    commands.unregister("maginalia.test.custom");
    expect(service.getBinding("maginalia.document.save")).toBe("Mod+S");
    expect(service.getCollisionNotices()).toEqual([]);
  });

  it("drops persisted overrides on reserved native-menu role chords and reports them", () => {
    const commands = registry("maginalia.test.close");
    const service = new KeybindingService(commands, { platform: "windows", storage: storageWith({ "maginalia.test.close": "Ctrl+W" }) });
    expect(service.getBinding("maginalia.test.close")).toBeNull();
    expect(service.getCollisionNotices()).toEqual([{ kind: "reserved-override", commandId: "maginalia.test.close", keybinding: "Mod+W" }]);
  });
});

describe("Native role accelerators", () => {
  it("maps every role in the native menu manifest and reserves Window > Close and Minimize", () => {
    const roles = APPLICATION_MENU_MANIFEST.flatMap((menu) => menu.items.flatMap((item) => item.kind === "role" ? [item.role] : []));
    for (const role of roles) expect(APPLICATION_MENU_ROLE_KEYBINDINGS[role]).toMatch(/^Mod\+/u);
    expect(APPLICATION_MENU_ROLE_RESERVED_KEYBINDINGS).toEqual(expect.arrayContaining(["Mod+W", "Mod+M", "Mod+X", "Mod+C", "Mod+V", "Mod+A"]));
  });

  it.each<KeybindingPlatform>(["windows", "linux", "mac"])("rejects user bindings on native role chords (%s)", (platform) => {
    const commands = registry("maginalia.test.custom");
    const service = new KeybindingService(commands, { platform, storage: null });
    for (const chord of APPLICATION_MENU_ROLE_RESERVED_KEYBINDINGS) {
      expect(service.setBinding("maginalia.test.custom", chord)).toEqual({ kind: "rejected", reason: "reserved-keybinding" });
    }
  });

  it.each<KeybindingPlatform>(["windows", "linux", "mac"])("keeps defaults unique and off native role chords (%s)", (platform) => {
    const defaults = Object.values(getPlatformDefaultKeybindings(platform)).map((binding) => normalizeKeybinding(binding, platform));
    expect(new Set(defaults).size).toBe(defaults.length);
    for (const binding of defaults) expect(APPLICATION_MENU_ROLE_RESERVED_KEYBINDINGS).not.toContain(binding);
  });

  it("binds tab cycling to Control+Tab on every platform without taking Command+Tab", () => {
    expect(getPlatformDefaultKeybindings("windows")["maginalia.document.activateNext"]).toBe("Ctrl+Tab");
    expect(normalizeKeybinding("Ctrl+Tab", "windows")).toBe("Mod+Tab");
    expect(normalizeKeybinding("Ctrl+Shift+Tab", "windows")).toBe("Mod+Shift+Tab");
    expect(normalizeKeybinding("Ctrl+Tab", "mac")).toBe("Ctrl+Tab");
    const commands = registry("maginalia.document.activateNext", "maginalia.document.activatePrevious");
    const service = new KeybindingService(commands, { platform: "windows", storage: null });
    expect(service.getCommandForKeybinding("Mod+Tab", {})?.id).toBe("maginalia.document.activateNext");
    expect(service.getCommandForKeybinding("Mod+Shift+Tab", {})?.id).toBe("maginalia.document.activatePrevious");
  });
});

describe("Shortcut Editor collision notice copy", () => {
  it("names the affected and kept commands in Japanese", () => {
    const titles: Record<string, string> = { a: "保存", b: "独自コマンド" };
    const titleOf = (id: string) => titles[id] ?? id;
    expect(describeKeybindingCollisionNotice({ kind: "default-shadowed", commandId: "a", keybinding: "Mod+S", keptCommandId: "b" }, titleOf))
      .toContain("独自コマンド");
    expect(describeKeybindingCollisionNotice({ kind: "duplicate-override", commandId: "b", keybinding: "Mod+K", keptCommandId: "a" }, titleOf))
      .toContain("解除");
    expect(describeKeybindingCollisionNotice({ kind: "reserved-override", commandId: "b", keybinding: "Mod+W" }, titleOf))
      .toContain("予約");
  });
});
