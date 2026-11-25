import { describe, expect, it } from "vitest";
import { decideNativeInputKeybinding } from "./native-input-keybinding";

describe("decideNativeInputKeybinding", () => {
  it("routes enabled global commands from ordinary native fields", () => {
    expect(decideNativeInputKeybinding({ commandId: "maginalia.workbench.showCommandPalette", enabled: true, shadowedSaveDefault: false })).toBe("dispatch");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.view.togglePrimarySidebar", enabled: true, shadowedSaveDefault: false })).toBe("dispatch");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.document.save", enabled: true, shadowedSaveDefault: false })).toBe("dispatch");
  });

  it("leaves editor mutations and property submission to the focused field", () => {
    expect(decideNativeInputKeybinding({ commandId: "maginalia.editor.undo", enabled: true, shadowedSaveDefault: false })).toBe("native");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.editor.toggleBold", enabled: true, shadowedSaveDefault: false })).toBe("native");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.document.applyProperties", enabled: true, shadowedSaveDefault: false })).toBe("native");
  });

  it("preserves native undo and redo even if their old chord is assigned globally", () => {
    expect(decideNativeInputKeybinding({
      commandId: "maginalia.settings.open", enabled: true, shadowedSaveDefault: false, nativeUndoRedoChord: true
    })).toBe("native");
  });

  it("blocks disabled Save and a shadowed Save default without swallowing unrelated native chords", () => {
    expect(decideNativeInputKeybinding({ commandId: "maginalia.document.save", enabled: false, shadowedSaveDefault: false })).toBe("block");
    expect(decideNativeInputKeybinding({ commandId: null, enabled: false, shadowedSaveDefault: true })).toBe("block");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.editor.undo", enabled: true, shadowedSaveDefault: true })).toBe("block");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.workbench.showCommandPalette", enabled: true, shadowedSaveDefault: true })).toBe("dispatch");
    expect(decideNativeInputKeybinding({ commandId: "maginalia.view.togglePrimarySidebar", enabled: false, shadowedSaveDefault: false })).toBe("native");
    expect(decideNativeInputKeybinding({ commandId: null, enabled: false, shadowedSaveDefault: false })).toBe("native");
  });

  it("blocks disabled Quick Open and its remapped or unbound default without swallowing text editing", () => {
    expect(decideNativeInputKeybinding({
      commandId: "maginalia.workbench.showQuickOpen", enabled: true, shadowedSaveDefault: false
    })).toBe("dispatch");
    expect(decideNativeInputKeybinding({
      commandId: "maginalia.workbench.showQuickOpen", enabled: false, shadowedSaveDefault: false
    })).toBe("block");
    expect(decideNativeInputKeybinding({
      commandId: null, enabled: false, shadowedSaveDefault: false, shadowedQuickOpenDefault: true
    })).toBe("block");
    expect(decideNativeInputKeybinding({
      commandId: "maginalia.view.togglePrimarySidebar", enabled: true, shadowedSaveDefault: false, shadowedQuickOpenDefault: true
    })).toBe("dispatch");
    expect(decideNativeInputKeybinding({
      commandId: null, enabled: false, shadowedSaveDefault: false
    })).toBe("native");
  });
});
