import {
  DEFAULT_EXPORT_PRESENTATION_SETTINGS,
  EXPORT_PAPER_SIZES,
  type ExportPresentationSettings
} from "../export-presentation-settings";
import type { SettingValue, SettingWriteResult, SettingsRegistry } from "./settings-registry";

export const EXPORT_SETTING_IDS = Object.freeze({
  paperSize: "maginalia.export.paper-size",
  orientation: "maginalia.export.orientation",
  paragraphIndent: "maginalia.export.paragraph-indent",
  headerLeft: "maginalia.export.header-left",
  headerCenter: "maginalia.export.header-center",
  headerRight: "maginalia.export.header-right",
  pageNumber: "maginalia.export.page-number"
} as const);

export type ExportSettingId = typeof EXPORT_SETTING_IDS[keyof typeof EXPORT_SETTING_IDS];

export interface ExportPresentationPatch {
  readonly paperSize?: string;
  readonly orientation?: string;
  readonly paragraphIndent?: boolean;
  readonly header?: { readonly left?: string; readonly center?: string; readonly right?: string };
  readonly pageNumber?: boolean;
}

export interface ExportPresentationSettingsStore {
  readonly get: () => ExportPresentationSettings;
  /** Validate, persist, then publish. Throws a user-facing message when persistence fails. */
  readonly update: (patch: ExportPresentationPatch) => void;
}

/**
 * Register the export presentation settings once. The Settings Center and the
 * Menu view's export panel both write through these registry entries, so there
 * is a single writer and both surfaces see the same persistence failures.
 */
export function registerExportPresentationSettings(registry: SettingsRegistry, store: ExportPresentationSettingsStore): void {
  const common = { category: "書き出し", scope: "user", owner: "maginalia.core.export" } as const;
  registry.register({
    id: EXPORT_SETTING_IDS.paperSize,
    title: "用紙サイズ",
    description: "書き出し時に使う用紙サイズを選びます。",
    type: "enum",
    options: EXPORT_PAPER_SIZES,
    defaultValue: DEFAULT_EXPORT_PRESENTATION_SETTINGS.paperSize,
    ...common
  }, {
    getValue: () => store.get().paperSize,
    setValue: (value: string) => store.update({ paperSize: value })
  });
  registry.register({
    id: EXPORT_SETTING_IDS.orientation,
    title: "ページの向き",
    description: "書き出し時の縦向きまたは横向きを選びます。",
    type: "enum",
    options: ["portrait", "landscape"] as const,
    defaultValue: DEFAULT_EXPORT_PRESENTATION_SETTINGS.orientation,
    ...common
  }, {
    getValue: () => store.get().orientation,
    setValue: (value: string) => store.update({ orientation: value })
  });
  registry.register({
    id: EXPORT_SETTING_IDS.paragraphIndent,
    title: "段落の字下げ",
    description: "書き出す段落の先頭を字下げします。",
    type: "boolean",
    defaultValue: DEFAULT_EXPORT_PRESENTATION_SETTINGS.paragraphIndent,
    ...common
  }, {
    getValue: () => store.get().paragraphIndent,
    setValue: (value: boolean) => store.update({ paragraphIndent: value })
  });
  for (const [side, id] of [
    ["left", EXPORT_SETTING_IDS.headerLeft],
    ["center", EXPORT_SETTING_IDS.headerCenter],
    ["right", EXPORT_SETTING_IDS.headerRight]
  ] as const) {
    const label = side === "left" ? "左" : side === "right" ? "右" : "中央";
    registry.register({
      id,
      title: `ヘッダー ${label}`,
      description: `書き出しヘッダーの${label}に表示する文字列です。`,
      type: "string",
      defaultValue: DEFAULT_EXPORT_PRESENTATION_SETTINGS.header[side],
      ...common
    }, {
      getValue: () => store.get().header[side],
      setValue: (value: string) => store.update({ header: { ...store.get().header, [side]: value } })
    });
  }
  registry.register({
    id: EXPORT_SETTING_IDS.pageNumber,
    title: "ページ番号",
    description: "書き出しフッターの中央にページ番号を表示します。",
    type: "boolean",
    defaultValue: DEFAULT_EXPORT_PRESENTATION_SETTINGS.pageNumber,
    ...common
  }, {
    getValue: () => store.get().pageNumber,
    setValue: (value: boolean) => store.update({ pageNumber: value })
  });
}

/** A form control in the export panel, reduced to what the binding needs. */
export interface ExportSettingControl {
  readonly settingId: ExportSettingId;
  readonly event: "change" | "input";
  readonly read: () => SettingValue;
  readonly addEventListener: (type: "change" | "input", listener: () => void) => void;
}

/**
 * Bind export panel controls to the Settings Registry. Every control change is
 * a `setValue` on the registry entry; a rejected or failed write is reported and
 * the panel is restored from the authoritative store.
 */
export function bindExportSettingControls(
  registry: Pick<SettingsRegistry, "setValue">,
  controls: readonly ExportSettingControl[],
  onFailure: (message: string, result: SettingWriteResult) => void
): void {
  for (const control of controls) {
    control.addEventListener(control.event, () => {
      const result = registry.setValue(control.settingId, control.read());
      if (result.kind === "updated") return;
      const message = result.kind === "failed"
        ? result.message
        : result.kind === "invalid"
          ? result.failure.message
          : "書き出し設定を変更できませんでした。";
      onFailure(message, result);
    });
  }
}
