import { existsSync } from "node:fs";
import path from "node:path";

export type BrandAssetExists = (candidate: string) => boolean;

/**
 * Resolve a branded asset from the first available packaged/development root.
 * Asset lookup is deliberately optional so the app can still open if a visual
 * derivative is missing or an older development build is being launched.
 */
export function findBrandAssetPath(
  fileName: string,
  roots: readonly string[],
  fileExists: BrandAssetExists = existsSync,
): string | null {
  for (const root of roots) {
    const candidate = path.join(root, fileName);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function findApplicationIconPath(
  platform: string,
  roots: readonly string[],
  fileExists: BrandAssetExists = existsSync,
): string | null {
  const fileName = platform === "win32" ? "maginalia.ico" : "logo.png";
  return findBrandAssetPath(fileName, roots, fileExists);
}
