import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseDocument, stringify } from "yaml";

export const SHELF_LOCATION_FILE_NAME = "shelf_location.yml";

export interface ShelfUrls {
  readonly github: string | null;
  readonly homepage: string | null;
  readonly other: readonly string[];
}

export interface ShelfLocation {
  readonly registry: string | null;
  readonly urls: ShelfUrls;
}

export interface ShelfLocationRegistryConfig {
  readonly version: 1;
  readonly privateShelf: ShelfLocation;
  readonly publicShelf: ShelfLocation;
}

export interface ShelfLocationRegistryLoaded {
  readonly kind: "loaded";
  readonly config: ShelfLocationRegistryConfig;
}

export interface ShelfLocationRegistryFailure {
  readonly kind: "error";
  readonly message: string;
}

export type ShelfLocationRegistryResult = ShelfLocationRegistryLoaded | ShelfLocationRegistryFailure;

const DEFAULT_URLS: ShelfUrls = Object.freeze({
  github: null,
  homepage: null,
  other: Object.freeze([]),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseUrls(value: unknown): ShelfUrls | undefined {
  if (value === undefined) return DEFAULT_URLS;
  if (value === null) return DEFAULT_URLS;
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["github", "homepage", "other"])) return undefined;
  // URL metadata is descriptive storage in this slice. It must never cause a
  // network request or make an otherwise valid local Shelf unreadable merely
  // because a legacy value is not a syntactically valid URL.
  const github = typeof value.github === "string" ? value.github : null;
  const homepage = typeof value.homepage === "string" ? value.homepage : null;
  const other = Array.isArray(value.other) ? value.other.filter((entry): entry is string => typeof entry === "string") : [];
  return Object.freeze({ github, homepage, other: Object.freeze([...other]) });
}

function parseShelfLocation(value: unknown): ShelfLocation | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["registry", "urls"])) return undefined;
  if (value.registry !== null && (typeof value.registry !== "string" || value.registry.length === 0 || !path.isAbsolute(value.registry))) {
    return undefined;
  }
  const urls = parseUrls(value.urls);
  if (urls === undefined) return undefined;
  return Object.freeze({ registry: value.registry, urls });
}

function parseConfig(value: unknown): ShelfLocationRegistryConfig | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["version", "private_shelf", "public_shelf"]) || value.version !== 1) {
    return undefined;
  }
  const privateShelf = parseShelfLocation(value.private_shelf);
  const publicShelf = parseShelfLocation(value.public_shelf);
  if (privateShelf === undefined || publicShelf === undefined) return undefined;
  return Object.freeze({ version: 1, privateShelf, publicShelf });
}

/** Parse an already-read registry with the same rules as the Desktop loader. */
export function parseShelfLocationSource(source: string): ShelfLocationRegistryConfig | undefined {
  try {
    const document = parseDocument(source, { prettyErrors: false });
    return document.errors.length ? undefined : parseConfig(document.toJS());
  } catch {
    return undefined;
  }
}

function copyUrls(urls: ShelfUrls): ShelfUrls {
  return Object.freeze({
    github: urls.github,
    homepage: urls.homepage,
    other: Object.freeze([...urls.other]),
  });
}

function copyLocation(location: ShelfLocation): ShelfLocation {
  return Object.freeze({ registry: location.registry, urls: copyUrls(location.urls) });
}

function copyConfig(config: ShelfLocationRegistryConfig): ShelfLocationRegistryConfig {
  return Object.freeze({
    version: 1,
    privateShelf: copyLocation(config.privateShelf),
    publicShelf: copyLocation(config.publicShelf),
  });
}

function withPrivateShelfRegistry(
  config: ShelfLocationRegistryConfig,
  registry: string,
): ShelfLocationRegistryConfig {
  return Object.freeze({
    version: 1,
    privateShelf: Object.freeze({ registry, urls: copyUrls(config.privateShelf.urls) }),
    publicShelf: copyLocation(config.publicShelf),
  });
}

function withPublicShelfRegistry(
  config: ShelfLocationRegistryConfig,
  registry: string,
): ShelfLocationRegistryConfig {
  return Object.freeze({
    version: 1,
    privateShelf: copyLocation(config.privateShelf),
    publicShelf: Object.freeze({ registry, urls: copyUrls(config.publicShelf.urls) }),
  });
}

const EMPTY_CONFIG: ShelfLocationRegistryConfig = Object.freeze({
  version: 1,
  privateShelf: Object.freeze({ registry: null, urls: DEFAULT_URLS }),
  publicShelf: Object.freeze({ registry: null, urls: DEFAULT_URLS }),
});

function serializeConfig(config: ShelfLocationRegistryConfig): string {
  return stringify({
    version: config.version,
    private_shelf: {
      registry: config.privateShelf.registry,
      urls: {
        github: config.privateShelf.urls.github,
        homepage: config.privateShelf.urls.homepage,
        other: [...config.privateShelf.urls.other],
      },
    },
    public_shelf: {
      registry: config.publicShelf.registry,
      urls: {
        github: config.publicShelf.urls.github,
        homepage: config.publicShelf.urls.homepage,
        other: [...config.publicShelf.urls.other],
      },
    },
  });
}

/**
 * Machine-local registry location configuration. It intentionally stores no
 * Shelf data, indexes, or selected document state.
 */
export class ShelfLocationRegistry {
  private readonly resolvedFilePath: string;

  public constructor(filePath: string) {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`Shelf configuration path must be absolute: ${filePath}`);
    }
    this.resolvedFilePath = path.resolve(filePath);
  }

  /** The one deterministic path read and, after an explicit selection, updated. */
  public get configurationPath(): string {
    return this.resolvedFilePath;
  }

  public async load(): Promise<ShelfLocationRegistryResult> {
    let source: string;
    try {
      source = await readFile(this.resolvedFilePath, "utf8");
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      return Object.freeze({
        kind: "error",
        message: code === "ENOENT"
          ? `Shelf configuration not found:\n${this.resolvedFilePath}`
          : `Shelf configuration could not be read:\n${this.resolvedFilePath}`,
      });
    }

    try {
      const config = parseShelfLocationSource(source);
      if (config === undefined) {
        return Object.freeze({ kind: "error", message: `Private Shelf configuration is invalid:\n${this.resolvedFilePath}` });
      }
      return Object.freeze({ kind: "loaded", config });
    } catch {
      return Object.freeze({ kind: "error", message: `Private Shelf configuration is invalid:\n${this.resolvedFilePath}` });
    }
  }

  /** Create an empty app-local configuration only when it is genuinely absent. */
  public async initializeEmpty(): Promise<ShelfLocationRegistryResult> {
    try {
      await lstat(this.resolvedFilePath);
      return this.load();
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") return this.load();
    }
    try {
      await mkdir(path.dirname(this.resolvedFilePath), { recursive: true });
      await writeFile(this.resolvedFilePath, serializeConfig(EMPTY_CONFIG), { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code !== "EEXIST") {
        return Object.freeze({ kind: "error", message: "Shelfの保存設定を作成できませんでした。" });
      }
    }
    return this.load();
  }

  /**
   * Persist only the Private Shelf registry path while preserving Public Shelf
   * and optional URL metadata. Callers validate/open the selected Shelf first.
   */
  public async savePrivateShelfRegistry(registry: string): Promise<ShelfLocationRegistryResult> {
    if (!path.isAbsolute(registry)) {
      return Object.freeze({
        kind: "error",
        message: `Private Shelf registry must be an absolute path:\n${this.resolvedFilePath}`,
      });
    }
    const loaded = await this.load();
    if (loaded.kind === "error") return loaded;
    const config = withPrivateShelfRegistry(loaded.config, path.resolve(registry));
    try {
      await writeFile(this.resolvedFilePath, serializeConfig(config), "utf8");
      return Object.freeze({ kind: "loaded", config: copyConfig(config) });
    } catch {
      return Object.freeze({
        kind: "error",
        message: `Private Shelf configuration could not be saved:\n${this.resolvedFilePath}`,
      });
    }
  }

  /** Persist an explicitly selected Public Shelf folder without changing Private Shelf metadata. */
  public async savePublicShelfRegistry(registry: string): Promise<ShelfLocationRegistryResult> {
    if (!path.isAbsolute(registry)) {
      return Object.freeze({ kind: "error", message: "Public Shelfの保存場所を確認できませんでした。" });
    }
    const loaded = await this.load();
    if (loaded.kind === "error") return loaded;
    const config = withPublicShelfRegistry(loaded.config, path.resolve(registry));
    try {
      await writeFile(this.resolvedFilePath, serializeConfig(config), "utf8");
      return Object.freeze({ kind: "loaded", config: copyConfig(config) });
    } catch {
      return Object.freeze({ kind: "error", message: "Public Shelfの保存場所を記録できませんでした。" });
    }
  }
}
