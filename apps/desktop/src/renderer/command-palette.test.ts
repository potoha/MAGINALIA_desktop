import { describe, expect, it } from "vitest";
import { isImeCompositionKey, parseCommandPaletteInput } from "./command-palette";

describe("Command Palette input", () => {
  it("parses command, Project-name, document-name, and help modes without mixing result kinds", () => {
    expect(parseCommandPaletteInput("  Toggle Bold ")).toEqual({
      mode: "commands",
      query: "Toggle Bold",
      commandOnly: false
    });
    expect(parseCommandPaletteInput(">  Toggle Bold ")).toEqual({
      mode: "commands",
      query: "Toggle Bold",
      commandOnly: true
    });
    expect(parseCommandPaletteInput("project: 卒業論文")).toEqual({
      mode: "project",
      query: "卒業論文",
      commandOnly: false
    });
    expect(parseCommandPaletteInput("FILE: Chapter 1")).toEqual({
      mode: "file",
      query: "Chapter 1",
      commandOnly: false
    });
    expect(parseCommandPaletteInput("? ")).toEqual({ mode: "help", query: "", commandOnly: false });
  });

  it("does not consume keyboard actions while an IME composition key is active", () => {
    expect(isImeCompositionKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeCompositionKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeCompositionKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
