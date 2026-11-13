import { describe, expect, it } from "vitest";
import path from "node:path";
import { findApplicationIconPath, findBrandAssetPath } from "./brand-assets";

describe("brand asset resolution", () => {
  it("uses the first existing packaged or development asset", () => {
    const roots = [path.join("packed", "branding"), path.join("development", "assets")];
    const existingPath = path.join(roots[1], "splash.png");
    const existing = new Set([existingPath]);

    expect(findBrandAssetPath("splash.png", roots, (candidate) => existing.has(candidate)))
      .toBe(existingPath);
  });

  it("returns no path when the brand asset is unavailable", () => {
    expect(findBrandAssetPath("marker-stroke.png", [path.join("missing")], () => false)).toBeNull();
  });

  it("requires the generated generated ICO for Windows instead of falling back to old PNG icons", () => {
    const root = path.join("packaged", "branding");
    const existing = new Set([
      path.join(root, "icon.png"),
      path.join(root, "iconnottran.png"),
      path.join(root, "logo.png"),
    ]);

    expect(findApplicationIconPath("win32", [root], (candidate) => existing.has(candidate))).toBeNull();

    const generatedIco = path.join(root, "maginalia.ico");
    existing.add(generatedIco);
    expect(findApplicationIconPath("win32", [root], (candidate) => existing.has(candidate))).toBe(generatedIco);
  });

  it("uses logo.png on non-Windows app surfaces and ignores old icon PNGs", () => {
    const root = path.join("packaged", "branding");
    const existing = new Set([
      path.join(root, "icon.png"),
      path.join(root, "iconnottran.png"),
      path.join(root, "logo.png"),
    ]);

    expect(findApplicationIconPath("darwin", [root], (candidate) => existing.has(candidate)))
      .toBe(path.join(root, "logo.png"));
  });

  it("does not fall back to an old PNG when the application logo is missing", () => {
    const root = path.join("packaged", "branding");
    const existing = new Set([
      path.join(root, "icon.png"),
      path.join(root, "iconnottran.png"),
    ]);

    expect(findApplicationIconPath("darwin", [root], (candidate) => existing.has(candidate))).toBeNull();
  });
});
