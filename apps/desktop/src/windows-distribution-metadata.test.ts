import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_DISPLAY_NAME } from "./branding";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("Windows distribution metadata", () => {
  it("keeps the app, workspace lock, and versioned installer artifact aligned", async () => {
    const app = JSON.parse(await readFile(path.join(repositoryRoot, "apps/desktop/package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { name?: string; version?: string }>;
    };
    const installer = JSON.parse(await readFile(path.join(repositoryRoot, "apps/desktop/packaging/electron-builder.json"), "utf8")) as {
      appId: string;
      productName: string;
      win: { artifactName: string };
      nsis: { perMachine: boolean; deleteAppDataOnUninstall: boolean; shortcutName: string };
    };
    const stageScript = await readFile(path.join(repositoryRoot, "apps/desktop/scripts/stage-windows-app.mjs"), "utf8");

    expect(app).toMatchObject({ name: "@maginalia/desktop", version: "0.2.0" });
    expect(lock.packages["apps/desktop"]).toMatchObject({ name: app.name, version: app.version });
    expect(installer).toMatchObject({
      appId: "org.maginalia.desktop.alpha1",
      productName: PRODUCT_DISPLAY_NAME,
      win: { artifactName: "MAGINALIA-desktop-${version}-Setup.exe" },
      nsis: { perMachine: false, deleteAppDataOnUninstall: false },
    });
    expect(installer.nsis).toMatchObject({ shortcutName: PRODUCT_DISPLAY_NAME });
    expect(stageScript).toContain("version: desktopPackage.version");
  });
});
