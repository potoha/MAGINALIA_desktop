import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_MENU_COMMAND_CHANNEL,
  APPLICATION_MENU_COMMAND_IDS,
  APPLICATION_MENU_MANIFEST,
  UPDATE_APPLICATION_MENU_CHANNEL,
  createApplicationMenuTemplate,
  createApplicationMenuUpdateHandler,
  dispatchApplicationMenuCommand,
  isApplicationMenuCommandId,
  isApplicationMenuSnapshot,
  normalizeApplicationMenuAccelerator,
  type ApplicationMenuCommandId
} from "./application-menu";

describe("native application menu contract", () => {
  it("declares seven Japanese menus and a unique allowlist of registered Core action IDs", () => {
    expect(APPLICATION_MENU_MANIFEST.map(({ label }) => label)).toEqual([
      "ファイル", "編集", "表示", "挿入", "書式", "ウィンドウ", "ヘルプ"
    ]);
    expect(new Set(APPLICATION_MENU_COMMAND_IDS).size).toBe(APPLICATION_MENU_COMMAND_IDS.length);
    expect(isApplicationMenuCommandId("maginalia.editor.undo")).toBe(true);
    expect(isApplicationMenuCommandId("dev.example.arbitrary")).toBe(false);
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.settings.open");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.settings.shortcuts");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.help.cheatSheet");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.document.open");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.workbench.showQuickOpen");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.editor.findInDocument");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.editor.replaceInDocument");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.document.closeView");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.collector.configureSaveDestination");
    expect(APPLICATION_MENU_COMMAND_IDS).toContain("maginalia.collector.clearSaveDestination");
  });

  it("bounds renderer state to unique allowlisted commands and safe accelerators", () => {
    expect(isApplicationMenuSnapshot([
      { id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+S" },
      { id: "maginalia.editor.undo", enabled: false }
    ])).toBe(true);
    expect(isApplicationMenuSnapshot([{ id: "dev.example.injected", enabled: true }])).toBe(false);
    expect(isApplicationMenuSnapshot([
      { id: "maginalia.document.save", enabled: true },
      { id: "maginalia.document.save", enabled: false }
    ])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: "yes" }])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: true, accelerator: "Ctrl+S" }])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+Unknown" }])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+\u0000" }])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+\u200b" }])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+Ctrl+S" }])).toBe(false);
    expect(isApplicationMenuSnapshot([{ id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+" + "あ".repeat(64) }])).toBe(false);
    expect(isApplicationMenuSnapshot(new Array(APPLICATION_MENU_COMMAND_IDS.length + 1).fill({ id: "maginalia.document.save", enabled: true }))).toBe(false);
    expect(isApplicationMenuSnapshot([
      { id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+あ" },
      { id: "maginalia.editor.undo", enabled: false, shortcut: "Meta+S" }
    ])).toBe(true);
  });

  it("normalizes Ctrl and Meta shortcut aliases to platform-supported Electron syntax", () => {
    expect(normalizeApplicationMenuAccelerator("Ctrl+Shift+P", "win32")).toBe("Control+Shift+P");
    expect(normalizeApplicationMenuAccelerator("Meta+S", "darwin")).toBe("Command+S");
    expect(normalizeApplicationMenuAccelerator("Meta+S", "linux")).toBe("Super+S");
    expect(normalizeApplicationMenuAccelerator("Ctrl+ArrowUp", "win32")).toBe("Control+Up");
    expect(normalizeApplicationMenuAccelerator("Ctrl+あ", "win32")).toBeNull();
    expect(normalizeApplicationMenuAccelerator("Ctrl+Ctrl+S", "win32")).toBeNull();
    expect(normalizeApplicationMenuAccelerator("Ctrl+", "win32")).toBeNull();
    expect(normalizeApplicationMenuAccelerator("Ctrl+constructor", "win32")).toBeNull();
  });

  it("builds native roles separately and dispatches enabled registry IDs without registering accelerators", () => {
    const dispatch = vi.fn<(id: ApplicationMenuCommandId) => void>();
    const template = createApplicationMenuTemplate([
      { id: "maginalia.editor.undo", enabled: true, shortcut: "Ctrl+Z" },
      { id: "maginalia.editor.redo", enabled: false }
    ], dispatch, "win32");
    const editMenu = template.find((item) => item.label === "編集");
    expect(editMenu?.submenu).toBeInstanceOf(Array);
    if (!Array.isArray(editMenu?.submenu)) throw new Error("Expected Edit submenu.");
    const undo = editMenu.submenu.find((item) => item.id === "maginalia.editor.undo");
    const redo = editMenu.submenu.find((item) => item.id === "maginalia.editor.redo");
    const cut = editMenu.submenu.find((item) => item.role === "cut");
    const undoClick = undo?.click as (() => void) | undefined;
    const redoClick = redo?.click as (() => void) | undefined;

    expect(undo).toMatchObject({ enabled: true, accelerator: "Control+Z", registerAccelerator: false });
    expect(redo).toMatchObject({ enabled: false, id: "maginalia.editor.redo" });
    expect(cut).toMatchObject({ label: "切り取り", role: "cut" });
    undoClick?.();
    redoClick?.();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("maginalia.editor.undo");
  });

  it("keeps a Unicode-shortcut command enabled and dispatchable when Electron cannot display its accelerator", () => {
    const dispatch = vi.fn<(id: ApplicationMenuCommandId) => void>();
    const template = createApplicationMenuTemplate([
      { id: "maginalia.document.save", enabled: true, shortcut: "Ctrl+あ" },
      { id: "maginalia.editor.undo", enabled: true, shortcut: "Ctrl+S" }
    ], dispatch, "win32");
    const fileMenu = template.find((item) => item.label === "ファイル");
    expect(Array.isArray(fileMenu?.submenu)).toBe(true);
    if (!Array.isArray(fileMenu?.submenu)) throw new Error("Expected File submenu.");
    const save = fileMenu.submenu.find((item) => item.id === "maginalia.document.save");
    const saveClick = save?.click as (() => void) | undefined;

    expect(save).toMatchObject({ enabled: true, id: "maginalia.document.save" });
    expect(save).not.toHaveProperty("accelerator");
    saveClick?.();
    expect(dispatch).toHaveBeenCalledWith("maginalia.document.save");
  });

  it("accepts menu-state updates only from the owner main frame and valid snapshots", () => {
    const owner = { mainFrame: {} };
    const update = vi.fn();
    const handler = createApplicationMenuUpdateHandler(() => owner, update);
    const validSnapshot = [{ id: "maginalia.document.save", enabled: true }];

    expect(handler({ sender: owner, senderFrame: owner.mainFrame }, validSnapshot)).toBe(true);
    expect(update).toHaveBeenCalledWith(validSnapshot);
    expect(handler({ sender: {}, senderFrame: owner.mainFrame }, validSnapshot)).toBe(false);
    expect(handler({ sender: owner, senderFrame: {} }, validSnapshot)).toBe(false);
    expect(handler({ sender: owner, senderFrame: null }, validSnapshot)).toBe(false);
    expect(handler({ sender: owner, senderFrame: owner.mainFrame }, [{ id: "dev.example.injected", enabled: true }])).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("forwards only allowlisted command IDs on the native command event channel", () => {
    const send = vi.fn();
    expect(dispatchApplicationMenuCommand("maginalia.document.save", send)).toBe(true);
    expect(dispatchApplicationMenuCommand("dev.example.injected", send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(APPLICATION_MENU_COMMAND_CHANNEL, "maginalia.document.save");
    expect(UPDATE_APPLICATION_MENU_CHANNEL).toBe("maginalia:update-application-menu");
  });
});
