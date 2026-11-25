import { describe, expect, it, vi } from "vitest";
import { createExportPresentationSettings, DEFAULT_EXPORT_PRESENTATION_SETTINGS, type ExportPresentationSettings } from "../export-presentation-settings";
import {
  bindExportSettingControls,
  EXPORT_SETTING_IDS,
  registerExportPresentationSettings,
  type ExportPresentationPatch,
  type ExportSettingControl
} from "./export-settings-registration";
import { SettingsRegistry } from "./settings-registry";

function setup(options: { readonly failPersistence?: boolean } = {}) {
  let current: ExportPresentationSettings = DEFAULT_EXPORT_PRESENTATION_SETTINGS;
  const persisted: ExportPresentationSettings[] = [];
  const update = vi.fn((patch: ExportPresentationPatch) => {
    const next = createExportPresentationSettings({ ...current, ...patch, header: { ...current.header, ...patch.header } });
    if (options.failPersistence === true) throw new Error("設定を保存できませんでした。");
    persisted.push(next);
    current = next;
  });
  const registry = new SettingsRegistry();
  registerExportPresentationSettings(registry, { get: () => current, update });
  return { registry, update, persisted, current: () => current };
}

function fakeControl(settingId: ExportSettingControl["settingId"], event: "change" | "input", value: () => string | boolean) {
  const listeners: Array<() => void> = [];
  const control: ExportSettingControl = {
    settingId,
    event,
    read: value,
    addEventListener: (type, listener) => {
      if (type === event) listeners.push(listener);
    }
  };
  return { control, fire: () => listeners.forEach((listener) => listener()) };
}

describe("Export presentation settings single writer", () => {
  it("registers every export setting once with the existing IDs", () => {
    const { registry } = setup();
    expect(registry.list().map((setting) => setting.id).sort()).toEqual(Object.values(EXPORT_SETTING_IDS).sort());
    expect(registry.getValue(EXPORT_SETTING_IDS.paperSize)).toMatchObject({ kind: "value", value: DEFAULT_EXPORT_PRESENTATION_SETTINGS.paperSize });
  });

  it("routes export-panel control changes through the Settings Registry adapter", () => {
    const { registry, update, current } = setup();
    let paper = "B5";
    let header = "卒業論文";
    const paperControl = fakeControl(EXPORT_SETTING_IDS.paperSize, "change", () => paper);
    const headerControl = fakeControl(EXPORT_SETTING_IDS.headerCenter, "input", () => header);
    const indentControl = fakeControl(EXPORT_SETTING_IDS.paragraphIndent, "change", () => true);
    const setValue = vi.spyOn(registry, "setValue");
    const onFailure = vi.fn();
    bindExportSettingControls(registry, [paperControl.control, headerControl.control, indentControl.control], onFailure);

    paperControl.fire();
    headerControl.fire();
    indentControl.fire();
    expect(setValue.mock.calls).toEqual([
      [EXPORT_SETTING_IDS.paperSize, "B5"],
      [EXPORT_SETTING_IDS.headerCenter, "卒業論文"],
      [EXPORT_SETTING_IDS.paragraphIndent, true]
    ]);
    expect(update).toHaveBeenCalledTimes(3);
    expect(current()).toMatchObject({ paperSize: "B5", paragraphIndent: true, header: { center: "卒業論文" } });
    expect(onFailure).not.toHaveBeenCalled();

    paper = "Letter-ish";
    header = "";
    paperControl.fire();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(current().paperSize).toBe("B5");
  });

  it("surfaces persistence failures to the export panel exactly as the Settings Center sees them", () => {
    const { registry, current } = setup({ failPersistence: true });
    const control = fakeControl(EXPORT_SETTING_IDS.orientation, "change", () => "landscape");
    const onFailure = vi.fn();
    bindExportSettingControls(registry, [control.control], onFailure);

    control.fire();
    expect(onFailure).toHaveBeenCalledWith("設定を保存できませんでした。", expect.objectContaining({ kind: "failed" }));
    expect(registry.setValue(EXPORT_SETTING_IDS.orientation, "landscape")).toMatchObject({ kind: "failed", message: "設定を保存できませんでした。" });
    expect(current().orientation).toBe(DEFAULT_EXPORT_PRESENTATION_SETTINGS.orientation);
  });
});
