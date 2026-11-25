export type SettingScope = "user" | "project";
export type SettingValue = boolean | number | string;
export type SettingType = "boolean" | "number" | "string" | "enum";

export type SettingValidator<T extends SettingValue> = (value: T) => string | null | undefined;

interface SettingDefinitionBase {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly scope: SettingScope;
  readonly owner: string;
  /** Re-evaluated when listing, searching, reading, or writing the setting. */
  readonly enabled?: () => boolean;
}

export type SettingDefinition = SettingDefinitionBase & (
  | { readonly type: "boolean"; readonly defaultValue: boolean; readonly validate?: SettingValidator<boolean> }
  | { readonly type: "number"; readonly defaultValue: number; readonly validate?: SettingValidator<number> }
  | { readonly type: "string"; readonly defaultValue: string; readonly validate?: SettingValidator<string> }
  | {
    readonly type: "enum";
    readonly defaultValue: string;
    readonly options: readonly string[];
    readonly validate?: SettingValidator<string>;
  }
);

export type SettingValueFor<Definition extends SettingDefinition> = Definition extends { readonly type: "boolean" }
  ? boolean
  : Definition extends { readonly type: "number" }
    ? number
    : string;

export interface SettingValueAdapter<Value extends SettingValue> {
  /** Return undefined when the current store has no value and the default should be used. */
  getValue(): unknown;
  setValue(value: Value): void;
}

/** Immutable public metadata. Storage remains owned by the supplied adapter. */
export type SettingMetadata = SettingDefinition;

export type SettingValidationFailure = {
  readonly code: "type" | "number" | "enum-option" | "custom" | "validator-error";
  readonly message: string;
};

export type SettingReadResult =
  | { readonly kind: "value"; readonly value: SettingValue; readonly source: "stored" | "default" }
  | { readonly kind: "missing" }
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid"; readonly failure: SettingValidationFailure }
  | { readonly kind: "failed"; readonly message: string };

export type SettingWriteResult =
  | { readonly kind: "updated"; readonly value: SettingValue }
  | { readonly kind: "missing" }
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid"; readonly failure: SettingValidationFailure }
  | { readonly kind: "failed"; readonly message: string };

export interface SettingResetEntry {
  readonly id: string;
  readonly result: SettingWriteResult;
}

interface RegisteredSetting {
  readonly metadata: SettingMetadata;
  readonly token: symbol;
  readonly adapter: SettingValueAdapter<SettingValue>;
  validate(value: unknown): SettingValidationFailure | null;
}

const SETTING_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/iu;
const OWNER_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/iu;
const DEFINITION_KEYS = new Set([
  "id", "title", "description", "category", "scope", "owner", "enabled", "type", "defaultValue", "validate", "options"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function typeFailure(message: string): SettingValidationFailure {
  return Object.freeze({ code: "type", message });
}

function validateBuiltInType(definition: SettingDefinition, value: unknown): SettingValidationFailure | null {
  switch (definition.type) {
    case "boolean":
      return typeof value === "boolean" ? null : typeFailure("Enter true or false.");
    case "number":
      if (typeof value !== "number") return typeFailure("Enter a number.");
      return Number.isFinite(value)
        ? null
        : Object.freeze({ code: "number", message: "Enter a finite number." });
    case "string":
      return typeof value === "string" ? null : typeFailure("Enter text.");
    case "enum":
      if (typeof value !== "string") return typeFailure("Choose one of the available options.");
      return definition.options.includes(value)
        ? null
        : Object.freeze({ code: "enum-option", message: "Choose one of the available options." });
  }
}

function validateValue(definition: SettingDefinition, value: unknown): SettingValidationFailure | null {
  const builtInFailure = validateBuiltInType(definition, value);
  if (builtInFailure !== null) return builtInFailure;
  if (definition.validate === undefined) return null;

  try {
    const message = definition.validate(value as never);
    if (message === null || message === undefined || message === "") return null;
    if (typeof message !== "string" || message.trim().length === 0) {
      return Object.freeze({ code: "validator-error", message: "The setting validator returned an invalid result." });
    }
    return Object.freeze({ code: "custom", message: message.trim() });
  } catch (error: unknown) {
    return Object.freeze({
      code: "validator-error",
      message: errorMessage(error, "The setting could not be validated.")
    });
  }
}

function validateDefinition(value: unknown): asserts value is SettingDefinition {
  if (!isRecord(value)) throw new Error("Invalid setting definition.");
  if (Object.keys(value).some((key) => !DEFINITION_KEYS.has(key))) throw new Error("Invalid setting definition: unsupported metadata.");
  if (typeof value.id !== "string" || value.id.length > 200 || !SETTING_ID_PATTERN.test(value.id)) {
    throw new Error("Invalid setting definition: use a stable namespaced id.");
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 200) {
    throw new Error("Invalid setting definition: title is required.");
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0 || value.description.length > 500) {
    throw new Error("Invalid setting definition: description is required.");
  }
  if (typeof value.category !== "string" || value.category.trim().length === 0 || value.category.length > 100) {
    throw new Error("Invalid setting definition: category is required.");
  }
  if (value.scope !== "user" && value.scope !== "project") throw new Error("Invalid setting definition: scope must be user or project.");
  if (typeof value.owner !== "string" || value.owner.length > 200 || !OWNER_ID_PATTERN.test(value.owner)) {
    throw new Error("Invalid setting definition: use a stable namespaced owner.");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "function") throw new Error("Invalid setting definition: enabled must be a function.");
  if (value.validate !== undefined && typeof value.validate !== "function") throw new Error("Invalid setting definition: validate must be a function.");

  switch (value.type) {
    case "boolean":
      if (typeof value.defaultValue !== "boolean" || value.options !== undefined) {
        throw new Error("Invalid setting definition: boolean settings require a boolean default and no options.");
      }
      break;
    case "number":
      if (typeof value.defaultValue !== "number" || !Number.isFinite(value.defaultValue) || value.options !== undefined) {
        throw new Error("Invalid setting definition: number settings require a finite numeric default and no options.");
      }
      break;
    case "string":
      if (typeof value.defaultValue !== "string" || value.options !== undefined) {
        throw new Error("Invalid setting definition: string settings require a string default and no options.");
      }
      break;
    case "enum": {
      if (typeof value.defaultValue !== "string" || !Array.isArray(value.options) || value.options.length === 0) {
        throw new Error("Invalid setting definition: enum settings require a string default and options.");
      }
      if (value.options.some((option) => typeof option !== "string" || option.length === 0 || option.length > 200)
        || new Set(value.options).size !== value.options.length
        || !value.options.includes(value.defaultValue)) {
        throw new Error("Invalid setting definition: enum options must be unique strings and include the default.");
      }
      break;
    }
    default:
      throw new Error("Invalid setting definition: unsupported setting type.");
  }
}

function freezeMetadata(definition: SettingDefinition): SettingMetadata {
  const metadata = definition.type === "enum"
    ? { ...definition, options: Object.freeze([...definition.options]) }
    : { ...definition };
  return Object.freeze(metadata) as SettingMetadata;
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  let cursor = 0;
  for (const character of needle) {
    cursor = haystack.indexOf(character, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

/**
 * Renderer Settings metadata and routing boundary. Each contribution adapts to
 * its existing preference/project store; this registry never owns persistence.
 */
export class SettingsRegistry {
  private readonly settings = new Map<string, RegisteredSetting>();
  private readonly listeners = new Set<() => void>();

  public register<const Definition extends SettingDefinition>(
    definition: Definition,
    adapter: SettingValueAdapter<SettingValueFor<Definition>>
  ): () => void {
    validateDefinition(definition);
    if (this.settings.has(definition.id)) throw new Error(`Setting already registered: ${definition.id}`);
    const metadata = freezeMetadata(definition);
    const defaultFailure = validateValue(metadata, metadata.defaultValue);
    if (defaultFailure !== null) {
      throw new Error(`Invalid default for setting ${metadata.id}: ${defaultFailure.message}`);
    }

    const token = Symbol(metadata.id);
    const registered: RegisteredSetting = {
      metadata,
      token,
      adapter: adapter as SettingValueAdapter<SettingValue>,
      validate: (value) => validateValue(metadata, value)
    };
    this.settings.set(metadata.id, registered);
    this.notify();
    return () => this.unregisterRegistration(metadata.id, token);
  }

  public unregister(id: string): boolean {
    const removed = this.settings.delete(id);
    if (removed) this.notify();
    return removed;
  }

  /** Remove all contributions owned by a disabled or unloaded module. */
  public unregisterOwner(owner: string): number {
    let removed = 0;
    for (const [id, setting] of this.settings) {
      if (setting.metadata.owner === owner) {
        this.settings.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.notify();
    return removed;
  }

  /** Returns active metadata only; callers cannot mutate the registry snapshot. */
  public list(): readonly SettingMetadata[] {
    return Object.freeze([...this.settings.values()]
      .filter((setting) => this.isEnabled(setting))
      .map((setting) => setting.metadata)
      .sort((left, right) => left.category.localeCompare(right.category)
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id)));
  }

  public get(id: string): SettingMetadata | null {
    const setting = this.settings.get(id);
    return setting !== undefined && this.isEnabled(setting) ? setting.metadata : null;
  }

  public listCategories(): readonly string[] {
    return Object.freeze([...new Set(this.list().map((setting) => setting.category))].sort((left, right) => left.localeCompare(right)));
  }

  /** Search active metadata by title, description, category, owner, type, options, and id. */
  public search(query: string): readonly SettingMetadata[] {
    const normalized = query.trim().toLocaleLowerCase();
    return Object.freeze(this.list().filter((setting) => {
      if (normalized.length === 0) return true;
      const searchable = [
        setting.id,
        setting.title,
        setting.description,
        setting.category,
        setting.owner,
        setting.type,
        ...(setting.type === "enum" ? setting.options : [])
      ].join(" ").toLocaleLowerCase();
      return fuzzyIncludes(searchable, normalized);
    }));
  }

  public getValue(id: string): SettingReadResult {
    const setting = this.settings.get(id);
    if (setting === undefined) return { kind: "missing" };
    if (!this.isEnabled(setting)) return { kind: "disabled" };

    try {
      const storedValue = setting.adapter.getValue();
      const source = storedValue === undefined ? "default" : "stored";
      const value = source === "default" ? setting.metadata.defaultValue : storedValue;
      const failure = setting.validate(value);
      return failure === null
        ? { kind: "value", value: value as SettingValue, source }
        : { kind: "invalid", failure };
    } catch (error: unknown) {
      return { kind: "failed", message: errorMessage(error, "The setting could not be read.") };
    }
  }

  public setValue(id: string, value: unknown): SettingWriteResult {
    const setting = this.settings.get(id);
    if (setting === undefined) return { kind: "missing" };
    if (!this.isEnabled(setting)) return { kind: "disabled" };
    const failure = setting.validate(value);
    if (failure !== null) return { kind: "invalid", failure };

    try {
      setting.adapter.setValue(value as SettingValue);
      this.notify();
      return { kind: "updated", value: value as SettingValue };
    } catch (error: unknown) {
      // A failed adapter may have partially changed its backing store. Notify
      // observers so they can re-read through the same authoritative adapter.
      this.notify();
      return { kind: "failed", message: errorMessage(error, "The setting could not be saved.") };
    }
  }

  public reset(id: string): SettingWriteResult {
    const setting = this.settings.get(id);
    if (setting === undefined) return { kind: "missing" };
    return this.setValue(id, setting.metadata.defaultValue);
  }

  /** Reset every active setting in the requested category, across both scopes. */
  public resetCategory(category: string): readonly SettingResetEntry[] {
    return this.resetSettings(this.list().filter((setting) => setting.category === category));
  }

  /** Reset active user settings only. Project presentation values remain untouched. */
  public resetAllUserSettings(): readonly SettingResetEntry[] {
    return this.resetSettings(this.list().filter((setting) => setting.scope === "user"));
  }

  /** Re-evaluate dynamic `enabled` predicates and notify Settings surfaces. */
  public refresh(): void {
    this.notify();
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private resetSettings(settings: readonly SettingMetadata[]): readonly SettingResetEntry[] {
    return Object.freeze(settings.map((metadata) => Object.freeze({ id: metadata.id, result: this.reset(metadata.id) })));
  }

  private isEnabled(setting: RegisteredSetting): boolean {
    try {
      return setting.metadata.enabled?.() ?? true;
    } catch {
      // A broken module predicate must not break the shared Settings surface.
      return false;
    }
  }

  private unregisterRegistration(id: string, token: symbol): void {
    if (this.settings.get(id)?.token !== token) return;
    this.settings.delete(id);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* one Settings surface cannot break other observers */ }
    }
  }
}
