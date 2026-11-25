import { describe, expect, it, vi } from "vitest";
import { SettingsRegistry, type SettingDefinition } from "./settings-registry";

function definition(overrides: Partial<SettingDefinition> & Pick<SettingDefinition, "id" | "type" | "defaultValue">): SettingDefinition {
  return {
    title: "A setting",
    description: "A test setting.",
    category: "General",
    scope: "user",
    owner: "maginalia.core",
    ...overrides
  } as SettingDefinition;
}

describe("SettingsRegistry", () => {
  it("registers immutable metadata, reads defaults, validates writes, and searches categories", () => {
    const registry = new SettingsRegistry();
    let stored: unknown;
    const dispose = registry.register({
      id: "maginalia.editor.fontSize",
      title: "Editor font size",
      description: "Controls the editor text size.",
      category: "Editor",
      type: "number",
      defaultValue: 16,
      scope: "user",
      owner: "maginalia.core",
      validate: (value) => value >= 8 && value <= 48 ? null : "Use a size from 8 to 48."
    }, {
      getValue: () => stored,
      setValue: (value) => { stored = value; }
    });

    expect(registry.getValue("maginalia.editor.fontSize")).toEqual({ kind: "value", value: 16, source: "default" });
    expect(registry.setValue("maginalia.editor.fontSize", 20)).toEqual({ kind: "updated", value: 20 });
    expect(stored).toBe(20);
    expect(registry.setValue("maginalia.editor.fontSize", 60)).toEqual({
      kind: "invalid",
      failure: { code: "custom", message: "Use a size from 8 to 48." }
    });
    expect(stored).toBe(20);
    expect(registry.search("edit font").map((item) => item.id)).toEqual(["maginalia.editor.fontSize"]);
    expect(registry.search("editor").map((item) => item.category)).toEqual(["Editor"]);
    expect(registry.listCategories()).toEqual(["Editor"]);

    const metadata = registry.get("maginalia.editor.fontSize");
    expect(metadata).not.toBeNull();
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    dispose();
    expect(registry.get("maginalia.editor.fontSize")).toBeNull();
  });

  it("validates primitive and enum values, including defaults at registration", () => {
    const registry = new SettingsRegistry();
    const options = ["horizontal", "vertical"];
    const adapter = { getValue: () => undefined, setValue: (_value: string) => undefined };
    registry.register({
      id: "maginalia.editor.direction",
      title: "Writing direction",
      description: "Default writing direction.",
      category: "Editor",
      type: "enum",
      options,
      defaultValue: "horizontal",
      scope: "user",
      owner: "maginalia.core"
    }, adapter);
    options.push("invalid-after-registration");
    expect(registry.setValue("maginalia.editor.direction", "invalid-after-registration")).toMatchObject({
      kind: "invalid",
      failure: { code: "enum-option" }
    });

    expect(() => registry.register({
      id: "maginalia.editor.badDefault",
      title: "Bad default",
      description: "Default does not pass validation.",
      category: "Editor",
      type: "number",
      defaultValue: 100,
      scope: "user",
      owner: "maginalia.core",
      validate: (value) => value < 10 ? null : "Value must be below 10."
    }, { getValue: () => undefined, setValue: (_value: number) => undefined })).toThrow("Invalid default for setting");

    expect(registry.setValue("maginalia.editor.direction", 12)).toMatchObject({
      kind: "invalid",
      failure: { code: "type" }
    });
    expect(registry.setValue("maginalia.editor.direction", "horizontal")).toEqual({ kind: "updated", value: "horizontal" });
  });

  it("rejects duplicates, malformed ids, unsupported secret types, and malformed enum options", () => {
    const registry = new SettingsRegistry();
    const adapter = { getValue: () => undefined, setValue: (_value: boolean) => undefined };
    const valid = definition({ id: "maginalia.editor.enabled", type: "boolean", defaultValue: true });
    registry.register(valid, adapter);
    expect(() => registry.register(valid, adapter)).toThrow("already registered");
    expect(() => registry.register(definition({ id: "enabled", type: "boolean", defaultValue: true }), adapter)).toThrow("namespaced id");
    expect(() => registry.register({
      ...valid,
      id: "maginalia.editor.credential",
      type: "secret"
    } as unknown as SettingDefinition, adapter)).toThrow("unsupported setting type");
    expect(() => registry.register({
      id: "maginalia.editor.mode",
      title: "Mode",
      description: "Invalid enum options.",
      category: "Editor",
      type: "enum",
      options: ["same", "same"],
      defaultValue: "same",
      scope: "user",
      owner: "maginalia.core"
    }, { getValue: () => undefined, setValue: (_value: string) => undefined })).toThrow("enum options");
  });

  it("resets one category across scopes and bulk-resets user settings only", () => {
    const registry = new SettingsRegistry();
    const adapters = new Map<string, { value: unknown; setValue: (value: SettingDefinition["defaultValue"]) => void }>();
    const add = (id: string, scope: "user" | "project", category: string, initial: unknown): void => {
      adapters.set(id, { value: initial, setValue(value) { this.value = value; } });
      registry.register({
        id,
        title: id,
        description: "Reset test setting.",
        category,
        type: "boolean",
        defaultValue: false,
        scope,
        owner: "maginalia.core"
      }, {
        getValue: () => adapters.get(id)?.value,
        setValue: (value) => adapters.get(id)!.setValue(value)
      });
    };
    add("maginalia.general.userFlag", "user", "General", true);
    add("maginalia.editor.projectFlag", "project", "Editor", true);
    add("maginalia.editor.userFlag", "user", "Editor", true);

    expect(registry.resetCategory("Editor").map(({ id, result }) => [id, result.kind])).toEqual([
      ["maginalia.editor.projectFlag", "updated"],
      ["maginalia.editor.userFlag", "updated"]
    ]);
    expect(adapters.get("maginalia.editor.projectFlag")?.value).toBe(false);
    expect(adapters.get("maginalia.editor.userFlag")?.value).toBe(false);

    adapters.get("maginalia.general.userFlag")!.value = true;
    adapters.get("maginalia.editor.projectFlag")!.value = true;
    expect(registry.resetAllUserSettings().map(({ id }) => id)).toEqual([
      "maginalia.editor.userFlag",
      "maginalia.general.userFlag"
    ]);
    expect(adapters.get("maginalia.general.userFlag")?.value).toBe(false);
    expect(adapters.get("maginalia.editor.projectFlag")?.value).toBe(true);
  });

  it("hides disabled contributions, refreshes observers, and unregisters an owner safely", () => {
    const registry = new SettingsRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.onDidChange(listener);
    let enabled = true;
    const dispose = registry.register({
      id: "example.mod.enabled",
      title: "Enabled setting",
      description: "Owned by an optional module.",
      category: "Mods",
      type: "boolean",
      defaultValue: true,
      scope: "user",
      owner: "example.mod",
      enabled: () => enabled
    }, { getValue: () => undefined, setValue: (_value: boolean) => undefined });
    expect(registry.list()).toHaveLength(1);
    enabled = false;
    registry.refresh();
    expect(registry.list()).toEqual([]);
    expect(registry.getValue("example.mod.enabled")).toEqual({ kind: "disabled" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.unregisterOwner("example.mod")).toBe(1);
    expect(registry.unregisterOwner("example.mod")).toBe(0);
    dispose(); // A stale registration disposer cannot remove a later registration.
    expect(registry.get("example.mod.enabled")).toBeNull();
    unsubscribe();
    expect(registry.unregister("missing.setting")).toBe(false);
  });

  it("isolates adapter, validator, enabled predicate, and observer failures", () => {
    const registry = new SettingsRegistry();
    const listener = vi.fn(() => { throw new Error("observer failure"); });
    registry.onDidChange(listener);
    registry.register({
      id: "example.core.adapterFailure",
      title: "Adapter failure",
      description: "Adapter exceptions become results.",
      category: "General",
      type: "string",
      defaultValue: "default",
      scope: "user",
      owner: "example.core"
    }, {
      getValue: () => { throw new Error("read failed"); },
      setValue: () => { throw new Error("write failed"); }
    });
    registry.register({
      id: "example.core.validatorFailure",
      title: "Validator failure",
      description: "Validator exceptions are visible.",
      category: "General",
      type: "string",
      defaultValue: "valid",
      scope: "user",
      owner: "example.core",
      validate: (value) => {
        if (value === "bad") throw new Error("validation failed");
        return null;
      }
    }, { getValue: () => undefined, setValue: () => undefined });
    registry.register({
      id: "example.core.predicateFailure",
      title: "Predicate failure",
      description: "A broken predicate hides only its own contribution.",
      category: "General",
      type: "boolean",
      defaultValue: true,
      scope: "user",
      owner: "example.core",
      enabled: () => { throw new Error("predicate failed"); }
    }, { getValue: () => undefined, setValue: () => undefined });

    expect(registry.getValue("example.core.adapterFailure")).toEqual({ kind: "failed", message: "read failed" });
    expect(registry.setValue("example.core.adapterFailure", "value")).toEqual({ kind: "failed", message: "write failed" });
    expect(registry.setValue("example.core.validatorFailure", "bad")).toEqual({
      kind: "invalid",
      failure: { code: "validator-error", message: "validation failed" }
    });
    expect(registry.list().map((item) => item.id)).toEqual(["example.core.adapterFailure", "example.core.validatorFailure"]);
    expect(listener).toHaveBeenCalled();
  });
});
