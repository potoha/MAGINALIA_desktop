import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const installerScriptPath = path.join(repositoryRoot, "apps/desktop/packaging/installer-shortcut.nsh");

describe("optional Desktop shortcut installer policy", () => {
  it("checks for same-name links and omits uninstall deletion from the NSIS hook", async () => {
    const source = await readFile(installerScriptPath, "utf8");
    const existenceCheck = source.indexOf('IfFileExists "$DESKTOP\\MAGINALIA α2 wild berry.lnk" MAGINALIA_DesktopShortcutConflict');
    const createShortcut = source.indexOf('CreateShortCut "$DESKTOP\\MAGINALIA α2 wild berry.lnk"');

    expect(source).toContain("${NSD_Uncheck} $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX");
    expect(existenceCheck).toBeGreaterThanOrEqual(0);
    expect(createShortcut).toBeGreaterThan(existenceCheck);
    expect(source).toContain('MessageBox MB_ICONEXCLAMATION|MB_OK "同じ名前のショートカットがあるため、デスクトップには追加しませんでした。"');
    expect(source).not.toContain("maginalia-desktop-shortcut-created");
    expect(source).not.toContain('Delete "$DESKTOP\\MAGINALIA α2 wild berry.lnk"');
    expect(source).not.toContain("!macro customUnInstall");
  });

  it("retires the α1 Desktop shortcut on upgrade only when it targets the α1 executable in the install directory", async () => {
    const source = await readFile(installerScriptPath, "utf8");

    expect(source).toContain('!define MAGINALIA_LEGACY_NAME "MAGINALIA desktop α1"');
    expect(source).toContain('IfFileExists "$DESKTOP\\${MAGINALIA_LEGACY_NAME}.lnk" 0 MAGINALIA_LegacyDesktopShortcutDone');
    expect(source).toContain('t "$INSTDIR\\${MAGINALIA_LEGACY_NAME}.exe"');
    // The link is deleted by the target comparison itself, never unconditionally.
    expect(source).toContain("if($$l.TargetPath -ieq $$env:MAGINALIA_LEGACY_EXE){Remove-Item -LiteralPath $$env:MAGINALIA_LEGACY_LNK;exit 0}else{exit 3}");
    expect(source).not.toContain('Delete "$DESKTOP\\${MAGINALIA_LEGACY_NAME}.lnk"');
    expect(source).toContain('${OrIf} $MAGINALIA_LEGACY_LINK_REMOVED == "1"');
  });
});
