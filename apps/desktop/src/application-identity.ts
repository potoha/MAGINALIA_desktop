import { mkdirSync, statSync } from "node:fs";

import { PRODUCT_DISPLAY_NAME } from "./branding";

export const MAGINALIA_APPLICATION_NAME = PRODUCT_DISPLAY_NAME;

export interface ElectronApplicationIdentityAdapter {
  getName(): string;
  getPath(name: "userData"): string;
  setName(name: string): void;
  setPath(name: "userData", path: string): void;
}

/**
 * Fix Electron's product identity before any user-data-backed store is built,
 * while pinning the profile Electron selected before this upgrade. This keeps
 * existing local state at its current location instead of silently relocating
 * it when the app name changes from Electron.
 */
export function establishApplicationIdentity(
  application: ElectronApplicationIdentityAdapter,
  name: string = MAGINALIA_APPLICATION_NAME,
): Readonly<{ applicationName: string; userDataPath: string }> {
  const existingUserDataPath = application.getPath("userData");
  // Electron may return its default profile location before that directory has
  // been created on a fresh install. Ensure the captured location exists so
  // setPath accepts it, without changing or migrating the selected profile.
  mkdirSync(existingUserDataPath, { recursive: true });
  if (!statSync(existingUserDataPath).isDirectory()) {
    throw new Error("Electron userData path is not a directory.");
  }
  application.setName(name);
  application.setPath("userData", existingUserDataPath);
  return Object.freeze({
    applicationName: application.getName(),
    userDataPath: application.getPath("userData"),
  });
}
