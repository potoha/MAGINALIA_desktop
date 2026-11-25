import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExportPresentationSettings,
  DEFAULT_EXPORT_PRESENTATION_SETTINGS
} from "../export-presentation-settings";
import {
  createLocalStorageRendererPreferenceStore,
  DEFAULT_RENDERER_PREFERENCES,
  RENDERER_PREFERENCES_STORAGE_KEY,
  restoreRendererPreferences
} from "./renderer-preferences";

afterEach(() => vi.unstubAllGlobals());

describe("renderer export preferences", () => {
  it("recovers old v1 renderer preferences without export settings", () => {
    expect(restoreRendererPreferences({
      version: 1,
      defaultWritingDirection: "vertical",
      optimizeDroppedImages: false
    })).toEqual({
      version: 1,
      defaultWritingDirection: "vertical",
      optimizeDroppedImages: false,
      exportPresentationSettings: DEFAULT_EXPORT_PRESENTATION_SETTINGS
    });
  });

  it("restores validated settings as an immutable shared-contract value", () => {
    const settings = createExportPresentationSettings({
      paperSize: "Legal",
      orientation: "landscape",
      paragraphIndent: false,
      header: { left: "Polar Bear", center: "研究", right: "2026" },
      pageNumber: false
    });

    const restored = restoreRendererPreferences({ ...DEFAULT_RENDERER_PREFERENCES, exportPresentationSettings: settings });

    expect(restored.exportPresentationSettings).toEqual(settings);
    expect(Object.isFrozen(restored.exportPresentationSettings)).toBe(true);
    expect(Object.isFrozen(restored.exportPresentationSettings.header)).toBe(true);
  });

  it("falls back to shared defaults for invalid persisted export settings", () => {
    const restored = restoreRendererPreferences({
      version: 1,
      defaultWritingDirection: "vertical",
      optimizeDroppedImages: false,
      exportPresentationSettings: { paperSize: "ISO-B3", orientation: "portrait" }
    });

    expect(restored.defaultWritingDirection).toBe("vertical");
    expect(restored.optimizeDroppedImages).toBe(false);
    expect(restored.exportPresentationSettings).toEqual(DEFAULT_EXPORT_PRESENTATION_SETTINGS);
  });

  it("loads and saves through the existing renderer preference storage key", () => {
    let stored: string | null = JSON.stringify({
      version: 1,
      defaultWritingDirection: "horizontal",
      optimizeDroppedImages: true
    });
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; })
    };
    vi.stubGlobal("localStorage", storage);
    const store = createLocalStorageRendererPreferenceStore();

    expect(store.load().exportPresentationSettings).toEqual(DEFAULT_EXPORT_PRESENTATION_SETTINGS);

    const settings = createExportPresentationSettings({ paperSize: "B4", header: { left: "見出し" } });
    expect(store.save({ ...store.load(), exportPresentationSettings: settings })).toBe(true);

    expect(storage.setItem).toHaveBeenCalledWith(RENDERER_PREFERENCES_STORAGE_KEY, expect.any(String));
    expect(JSON.parse(stored!).exportPresentationSettings).toEqual(settings);
    expect(store.load().exportPresentationSettings).toEqual(settings);
  });

  it("reports unavailable or failing localStorage writes without throwing", () => {
    const store = createLocalStorageRendererPreferenceStore();
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => { throw new Error("localStorage is unavailable"); }
    });
    expect(store.save(DEFAULT_RENDERER_PREFERENCES)).toBe(false);

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new Error("storage is unavailable"); }
    });
    expect(store.save(DEFAULT_RENDERER_PREFERENCES)).toBe(false);
  });
});
