import { describe, expect, it, vi } from "vitest";
import { PRODUCT_DISPLAY_NAME } from "./branding";
import { establishApplicationIdentity, MAGINALIA_APPLICATION_NAME } from "./application-identity";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("Electron application identity", () => {
  it("uses the branded Alpha2 Wild Berry name", () => {
    expect(MAGINALIA_APPLICATION_NAME).toBe("MAGINALIA Alpha2 Wild Berry");
    expect(MAGINALIA_APPLICATION_NAME).toBe(PRODUCT_DISPLAY_NAME);
  });

  it("sets a stable product name before stores are resolved and retains the existing profile path", () => {
    let name = "Electron";
    const profileParent = mkdtempSync(join(tmpdir(), "maginalia-profile-"));
    const userDataPath = join(profileParent, "Roaming", "Electron");
    let userData = userDataPath;
    const calls: string[] = [];
    const application = {
      getName: vi.fn(() => name),
      getPath: vi.fn((_key: "userData") => userData),
      setName: vi.fn((next: string) => { calls.push(`name:${next}`); name = next; }),
      setPath: vi.fn((_key: "userData", next: string) => { calls.push(`path:${next}`); userData = next; }),
    };

    try {
      expect(establishApplicationIdentity(application)).toEqual({
        applicationName: MAGINALIA_APPLICATION_NAME,
        userDataPath,
      });
      expect(calls).toEqual([
        `name:${MAGINALIA_APPLICATION_NAME}`,
        `path:${userDataPath}`,
      ]);
    } finally {
      rmSync(profileParent, { recursive: true, force: true });
    }
  });

  it("creates a missing captured profile directory before pinning it", () => {
    const profileParent = mkdtempSync(join(tmpdir(), "maginalia-fresh-profile-"));
    const userDataPath = join(profileParent, "not-created-yet");
    const application = {
      getName: () => "Electron",
      getPath: () => userDataPath,
      setName: vi.fn(),
      setPath: vi.fn(),
    };
    try {
      expect(establishApplicationIdentity(application).userDataPath).toBe(userDataPath);
      expect(application.setPath).toHaveBeenCalledWith("userData", userDataPath);
    } finally {
      rmSync(profileParent, { recursive: true, force: true });
    }
  });

  it("keeps the α1 userData directory when the application name changes, even if Electron derives defaults from the name", () => {
    const profileParent = mkdtempSync(join(tmpdir(), "maginalia-pin-profile-"));
    const roaming = join(profileParent, "Roaming");
    const alpha1UserData = join(roaming, "Electron");
    let name = "Electron";
    let override: string | undefined;
    const application = {
      getName: () => name,
      // Electron's default userData is <appData>/<name> until it is overridden.
      getPath: (_key: "userData") => override ?? join(roaming, name),
      setName: (next: string) => { name = next; },
      setPath: (_key: "userData", next: string) => { override = next; },
    };
    try {
      const identity = establishApplicationIdentity(application);
      expect(identity.applicationName).toBe("MAGINALIA Alpha2 Wild Berry");
      expect(identity.userDataPath).toBe(alpha1UserData);
      expect(join(roaming, "MAGINALIA Alpha2 Wild Berry")).not.toBe(alpha1UserData);
    } finally {
      rmSync(profileParent, { recursive: true, force: true });
    }
  });

  it("pins the installer identity and staged manifest name that userData and upgrades derive from", () => {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const builder = JSON.parse(readFileSync(join(desktopRoot, "packaging", "electron-builder.json"), "utf8")) as {
      appId: string;
      nsis: { perMachine: boolean; deleteAppDataOnUninstall: boolean; allowToChangeInstallationDirectory: boolean };
    };
    const stageScript = readFileSync(join(desktopRoot, "scripts", "stage-windows-app.mjs"), "utf8");
    const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as { name: string };

    expect(builder.appId).toBe("org.maginalia.desktop.alpha1");
    expect(builder.nsis).toMatchObject({ perMachine: false, deleteAppDataOnUninstall: false, allowToChangeInstallationDirectory: false });
    // The packaged default userData (%APPDATA%\Electron) is derived from the staged manifest name.
    expect(desktopPackage.name).toBe("@maginalia/desktop");
    expect(stageScript).toContain("name: desktopPackage.name");
    expect(stageScript).not.toContain("productName");
  });
});
