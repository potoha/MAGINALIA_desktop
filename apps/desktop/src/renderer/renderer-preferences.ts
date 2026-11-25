import {
  createExportPresentationSettings,
  DEFAULT_EXPORT_PRESENTATION_SETTINGS,
  isExportPresentationSettings,
  type ExportPresentationSettings
} from "../export-presentation-settings";

/**
 * Presentation-only preferences for the renderer. This is separate from a
 * DocumentSession on purpose: preference changes never edit or save Markdown.
 */
export type WritingDirection = "horizontal" | "vertical";

export interface RendererPreferences {
  readonly version: 1;
  readonly defaultWritingDirection: WritingDirection;
  /** Reserved for the Project asset importer. */
  readonly optimizeDroppedImages: boolean;
  /** Presentation-only settings for PDF/DOCX. Never written into Markdown. */
  readonly exportPresentationSettings: ExportPresentationSettings;
}

export const RENDERER_PREFERENCES_STORAGE_KEY = "maginalia.renderer.preferences.v1";

export const DEFAULT_RENDERER_PREFERENCES: RendererPreferences = Object.freeze({
  version: 1,
  defaultWritingDirection: "horizontal",
  optimizeDroppedImages: true,
  exportPresentationSettings: DEFAULT_EXPORT_PRESENTATION_SETTINGS
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Corrupt or old preference data deliberately falls back to safe defaults. */
export function restoreRendererPreferences(value: unknown): RendererPreferences {
  if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_RENDERER_PREFERENCES };
  const exportPresentationSettings = isExportPresentationSettings(value.exportPresentationSettings)
    ? createExportPresentationSettings(value.exportPresentationSettings)
    : DEFAULT_EXPORT_PRESENTATION_SETTINGS;
  return {
    version: 1,
    defaultWritingDirection: value.defaultWritingDirection === "vertical" ? "vertical" : "horizontal",
    optimizeDroppedImages: typeof value.optimizeDroppedImages === "boolean"
      ? value.optimizeDroppedImages
      : DEFAULT_RENDERER_PREFERENCES.optimizeDroppedImages,
    exportPresentationSettings
  };
}

export interface RendererPreferenceStore {
  load(): RendererPreferences;
  /** Returns false when durable storage is unavailable; void remains compatible with existing adapters. */
  save(preferences: RendererPreferences): boolean | void;
}

export function createLocalStorageRendererPreferenceStore(
  key = RENDERER_PREFERENCES_STORAGE_KEY
): RendererPreferenceStore {
  return {
    load(): RendererPreferences {
      try {
        if (typeof globalThis.localStorage === "undefined") return { ...DEFAULT_RENDERER_PREFERENCES };
        const raw = globalThis.localStorage.getItem(key);
        return restoreRendererPreferences(raw === null ? null : JSON.parse(raw) as unknown);
      } catch {
        return { ...DEFAULT_RENDERER_PREFERENCES };
      }
    },
    save(preferences: RendererPreferences): boolean {
      try {
        const storage = globalThis.localStorage;
        if (storage === undefined || storage === null) return false;
        storage.setItem(key, JSON.stringify(restoreRendererPreferences(preferences)));
        return true;
      } catch {
        // A display preference must never block authoring.
        return false;
      }
    }
  };
}
