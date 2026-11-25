/**
 * Single source of truth for product naming. The release version is never
 * hard-coded here: it comes from the application version (package.json via
 * Electron's `app.getVersion()`), injected so tests and the installer-side
 * checks can use this module without Electron.
 */
export const PRODUCT_NAME = "MAGINALIA" as const;
export const RELEASE_CODENAME = "Alpha2 Wild Berry" as const;
/** ASCII-only on purpose: window titles, shortcut names, installer and exe name. */
export const PRODUCT_DISPLAY_NAME = "MAGINALIA Alpha2 Wild Berry" as const;

export interface VersionSource {
  getVersion(): string;
}

/** The version string shown on branded surfaces, e.g. "0.2.0". */
export function brandVersionString(source: VersionSource): string {
  return source.getVersion().trim();
}

/** Accessible/alt text for the branded art: display name plus version. */
export function brandAccessibleName(version: string): string {
  return `${PRODUCT_DISPLAY_NAME} ${version}`.trim();
}
