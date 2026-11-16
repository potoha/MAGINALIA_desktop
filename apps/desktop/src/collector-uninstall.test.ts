/**
 * Static checks of the Collector uninstall cleanup (WP-8, design 2.4 / 8.5): the NSIS script is
 * read as text, never executed. The real uninstall is an owner E2E (WP-9). The compile test runs
 * only where electron-builder's NSIS (makensis) is already cached.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTOR_EXTENSION_PREVIOUS_NAME, COLLECTOR_EXTENSION_STAGING_NAME, COLLECTOR_HOST_LICENSE_FILES } from "./collector-integration-apply.js";
import { COLLECTOR_EXTENSION_FOLDER_NAME, COLLECTOR_HOST_SLOTS, COLLECTOR_STATE_FILE_NAME } from "./collector-integration.js";
import { COLLECTOR_HOST_ADDON_NAME, COLLECTOR_HOST_EXECUTABLE_NAME } from "./collector-payload.js";
import { COLLECTOR_HOST_REGISTRY_SUBKEY, COLLECTOR_MANIFEST_FILE_NAME, COLLECTOR_PROGRAM_FOLDER_NAME } from "./windows-integration.js";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(desktopRoot, "packaging/collector-uninstall.nsh");

async function readScript(): Promise<string> {
  return (await readFile(scriptPath, "utf8")).replaceAll("\r\n", "\n");
}

/** Executable lines only: comments and blank lines removed. */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function functionBody(source: string, name: string): string {
  const match = new RegExp(`^Function ${name.replaceAll(".", "\\.")}\\n([\\s\\S]*?)^FunctionEnd$`, "mu").exec(source);
  if (match === null) throw new Error(`function ${name} not found`);
  return match[1] as string;
}

/** `Push "$R8\name"` lines of a function, as bare names. */
function pushedNames(body: string): string[] {
  return [...body.matchAll(/^ {2}Push "\$R8\\([^"]+)"$/gmu)].map((match) => match[1] as string);
}

describe("Collector uninstall cleanup script (WP-8)", () => {
  it("is wired into the Desktop installer include and only runs on a real uninstall", async () => {
    const source = await readScript();
    const include = await readFile(path.join(desktopRoot, "packaging/installer-shortcut.nsh"), "utf8");
    const builder = JSON.parse(await readFile(path.join(desktopRoot, "packaging/electron-builder.json"), "utf8")) as { nsis: Record<string, unknown> };

    expect(include).toContain('!include "${PROJECT_DIR}\\\\packaging\\\\collector-uninstall.nsh"');
    expect(builder.nsis.include).toBe("packaging/installer-shortcut.nsh");
    expect(builder.nsis.deleteAppDataOnUninstall).toBe(false);
    const hook = /!macro customUnInstall\n([\s\S]*?)!macroend/u.exec(source);
    expect(hook).not.toBeNull();
    expect((hook as RegExpExecArray)[1]).toMatch(/\$\{ifNot\} \$\{isUpdated\}\n\s*!insertmacro MAGINALIA_CollectorCleanup\n\s*\$\{endIf\}/u);
  });

  it("unregisters only when the registry value equals our own manifest path", async () => {
    const source = await readScript();
    const lines = codeLines(source);
    const hostKey = `!define MAGINALIA_COLLECTOR_HOST_KEY "${COLLECTOR_HOST_REGISTRY_SUBKEY}"`;
    expect(lines).toContain(hostKey);
    expect(lines).toContain(`!define MAGINALIA_COLLECTOR_MANIFEST_NAME "${COLLECTOR_MANIFEST_FILE_NAME}"`);
    expect(lines).toContain(`!define MAGINALIA_COLLECTOR_PROGRAM_SUBPATH "Programs\\${COLLECTOR_PROGRAM_FOLDER_NAME}"`);

    const read = lines.findIndex((line) => line.startsWith('ReadRegStr $R0 HKCU "${MAGINALIA_COLLECTOR_HOST_KEY}" ""'));
    const compare = lines.findIndex((line) => line === '${AndIf} $R0 == "$LOCALAPPDATA\\${MAGINALIA_COLLECTOR_PROGRAM_SUBPATH}\\${MAGINALIA_COLLECTOR_MANIFEST_NAME}"');
    const deleteValue = lines.findIndex((line) => line.startsWith("DeleteRegValue HKCU"));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(compare).toBeGreaterThan(read);
    expect(deleteValue).toBeGreaterThan(compare);
    // The key is removed only when empty after our value is gone; never unconditionally and never under HKLM.
    const deletes = lines.filter((line) => /^DeleteReg(Key|Value)\b/u.test(line));
    expect(deletes).toEqual([
      'DeleteRegValue HKCU "${MAGINALIA_COLLECTOR_HOST_KEY}" ""',
      'DeleteRegKey /ifempty HKCU "${MAGINALIA_COLLECTOR_HOST_KEY}"',
    ]);
    expect(source).not.toMatch(/\bHKLM\b|HKEY_LOCAL_MACHINE|SHCTX|SHELL_CONTEXT/u);
  });

  it("never recursively deletes and never deletes through a wildcard", async () => {
    const source = await readScript();
    const lines = codeLines(source);

    expect(lines.filter((line) => /^RMDir\b/u.test(line) && /\s\/r\b/iu.test(line))).toEqual([]);
    expect(lines.filter((line) => /^RMDir\b/u.test(line))).toEqual(["RMDir $R1"]);
    // Every file delete: the single guarded one (regular file, not a link), plus our own temp .ps1.
    expect(lines.filter((line) => /^Delete\b/u.test(line)).sort()).toEqual(["Delete $8", "Delete $R1"]);
    expect(lines.filter((line) => /^Delete\b/u.test(line) && /[*?]/u.test(line))).toEqual([]);
    expect(lines.filter((line) => /^(RMDir|Delete|Rename|CopyFiles)\b/u.test(line) && /[*?]/u.test(line))).toEqual([]);
    // Wildcards exist only to enumerate private temp files; each hit is validated before deletion.
    expect(lines.filter((line) => !line.startsWith("FileWrite ") && /[*?]/u.test(line) && !/^FindFirst \$R6 \$R7 "\$R5\\\*\.tmp"$/u.test(line) && !line.startsWith("ReadRegStr"))).toEqual([]);
    const sweep = functionBody(source, "un.MAGINALIA_DeleteTempFiles");
    expect(sweep.indexOf("Call un.MAGINALIA_IsTempName")).toBeGreaterThan(-1);
    expect(sweep.indexOf("Call un.MAGINALIA_IsTempName")).toBeLessThan(sweep.indexOf("Call un.MAGINALIA_DeleteOwnedFile"));
    // The delete and the directory removal are guarded by the reparse-point-aware kind check.
    for (const name of ["un.MAGINALIA_DeleteOwnedFile", "un.MAGINALIA_RemoveEmptyDir"]) {
      const body = functionBody(source, name);
      expect(body.indexOf("Call un.MAGINALIA_PathKind")).toBeGreaterThan(-1);
      expect(body.indexOf("Call un.MAGINALIA_PathKind")).toBeLessThan(body.search(/\b(Delete|RMDir) \$R1/u));
    }
    const kind = functionBody(source, "un.MAGINALIA_PathKind");
    expect(kind).toContain("GetFileAttributesW");
    expect(kind).toContain("0x400"); // FILE_ATTRIBUTE_REPARSE_POINT
    expect(kind.indexOf("0x400")).toBeLessThan(kind.indexOf("0x10"));
  });

  it("touches the program folder only after a valid integration-state.json proved ownership", async () => {
    const source = await readScript();
    const hook = /!macro MAGINALIA_CollectorCleanup\n([\s\S]*?)!macroend/u.exec(source);
    const body = (hook as RegExpExecArray)[1] as string;
    const validate = body.indexOf("Call un.MAGINALIA_HasValidState");
    const guard = body.indexOf('${If} $0 == "1"');
    const clean = body.indexOf("Call un.MAGINALIA_CleanProgramFolder");
    expect(validate).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(validate);
    expect(clean).toBeGreaterThan(guard);
    expect(body.match(/Call un\.MAGINALIA_CleanProgramFolder/gu)?.length).toBe(1);
    // Nothing below the program folder is reached from anywhere else.
    for (const name of ["CleanSlot", "CleanExtension", "DeleteTempFiles"]) {
      const callers = [...source.matchAll(new RegExp(`Call un\\.MAGINALIA_${name}`, "gu"))].length;
      expect(callers).toBeGreaterThan(0);
    }
    const validity = functionBody(source, "un.MAGINALIA_HasValidState");
    expect(validity).toContain("${MAGINALIA_COLLECTOR_STATE_NAME}");
    expect(source).toContain(`!define MAGINALIA_COLLECTOR_STATE_NAME "${COLLECTOR_STATE_FILE_NAME}"`);
    // Same five fields and patterns as parseIntegrationStateFile; any failure means "not ours".
    for (const field of ["version", "payloadId", "activeSlot", "extensionVersion", "placedAt"]) expect(validity).toContain(`'${field}'`);
    expect(validity).toContain("$$o.Count -ne 5");
    expect(validity).toContain("catch { exit 3 }");
    expect(validity).not.toMatch(/\bInvoke-Expression\b|\biex\b/u);

    // Folder cleanup: the state file goes last and only when every owned folder is gone.
    const folder = functionBody(source, "un.MAGINALIA_CleanProgramFolder");
    expect(folder.indexOf("MAGINALIA_NoteLeftover")).toBeGreaterThan(folder.indexOf("Call un.MAGINALIA_CleanExtension"));
    expect(folder.lastIndexOf("MAGINALIA_COLLECTOR_STATE_NAME")).toBeGreaterThan(folder.indexOf('${If} $7 == "0"'));
  });

  it("names exactly the owned folders and files, matching the WP-5b remove", async () => {
    const source = await readScript();
    const folder = functionBody(source, "un.MAGINALIA_CleanProgramFolder");
    const folders = [...folder.matchAll(/^ +Push "\$6\\([^"]+)"$/gmu)].map((match) => match[1] as string);
    const expectedFolders = [
      "${MAGINALIA_COLLECTOR_MANIFEST_NAME}",
      ...COLLECTOR_HOST_SLOTS.map((slot) => `host-${slot}`),
      COLLECTOR_EXTENSION_FOLDER_NAME,
      COLLECTOR_EXTENSION_STAGING_NAME,
      COLLECTOR_EXTENSION_PREVIOUS_NAME,
      "${MAGINALIA_COLLECTOR_STATE_NAME}",
    ];
    expect(folders).toEqual(expectedFolders);

    expect(pushedNames(functionBody(source, "un.MAGINALIA_CleanSlot")).sort()).toEqual(
      [COLLECTOR_HOST_EXECUTABLE_NAME, COLLECTOR_HOST_ADDON_NAME, ...COLLECTOR_HOST_LICENSE_FILES].sort(),
    );

    // The extension list is append-only: it must cover every file the pinned Collector release has.
    const versions = JSON.parse(await readFile(path.join(desktopRoot, "packaging/runtime-versions.json"), "utf8")) as { collectorExtension: { files: string[] } };
    const example = JSON.parse(await readFile(path.join(desktopRoot, "packaging/collector-payload.example.json"), "utf8")) as { extension: { files: Record<string, string> } };
    const listed = pushedNames(functionBody(source, "un.MAGINALIA_CleanExtension"));
    expect(new Set(listed).size).toBe(listed.length);
    for (const name of versions.collectorExtension.files) expect(listed, `pinned file ${name}`).toContain(name);
    for (const name of Object.keys(example.extension.files)) expect(listed, `example file ${name}`).toContain(name);
    for (const name of listed) expect(name).not.toMatch(/[\\/*?]|^\.\.?$/u);
  });

  it("knows the private temp name pattern <name>.<16 lowercase hex>.tmp", async () => {
    const source = await readScript();
    const body = functionBody(source, "un.MAGINALIA_IsTempName");
    // 1 base char + "." + 16 hex + ".tmp" = 22; 120 base chars + 21 = 141 (TEMP_NAME_PATTERN in WP-5b).
    expect(body).toContain("$R1 < 22");
    expect(body).toContain("$R1 > 141");
    expect(body).toContain('${IfNot} $R3 S== ".tmp"');
    expect(body).toContain("StrCpy $R3 $R0 1 -21");
    expect(body).toContain('"0123456789abcdef"');
    expect(body).toContain('"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"');
    expect(body).toContain("${For} $R2 0 15");
    // Case-sensitive comparisons only (NSIS `==` ignores case).
    expect(functionBody(source, "un.MAGINALIA_InSet")).toContain("S==");
    expect(body).not.toMatch(/\$R\d == /u);
  });

  it("does not reach any user data, other registry roots or the Chrome profile", async () => {
    const source = await readScript();
    const code = codeLines(source).join("\n");
    expect(code).not.toMatch(/\$APPDATA|\$PROFILE|\$DOCUMENTS|\$INSTDIR|\$TEMP\b|\$LOCALAPPDATA\\MAGINALIA\b|Chrome\\User Data|Local State/iu);
    // The only $LOCALAPPDATA use is the fixed program folder.
    const uses = [...code.matchAll(/\$LOCALAPPDATA[^"\n]*/gu)].map((match) => match[0]);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/^\$LOCALAPPDATA\\\$\{MAGINALIA_COLLECTOR_PROGRAM_SUBPATH\}/u);
  });

  const makensis = findMakensis();
  it.skipIf(makensis === undefined)("compiles as an uninstaller with the electron-builder NSIS", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-nsis-"));
    try {
      const harness = path.join(directory, "check.nsi");
      await writeFile(
        harness,
        [
          "Unicode true",
          "!define BUILD_UNINSTALLER",
          `!define PROJECT_DIR "${desktopRoot}"`,
          '!include "LogicLib.nsh"',
          "!macro _isUpdated _a _b _t _f",
          '  StrCmp "$0" "1" `${_t}` `${_f}`',
          "!macroend",
          '!define isUpdated `"" isUpdated ""`',
          'Name "check"',
          `OutFile "${path.join(directory, "check.exe")}"`,
          "RequestExecutionLevel user",
          `!include "${scriptPath}"`,
          'Section "i"',
          `  WriteUninstaller "${path.join(directory, "u.exe")}"`,
          "SectionEnd",
          'Section "un.u"',
          "  !insertmacro customUnInstall",
          "SectionEnd",
          "",
        ].join("\n"),
      );
      const output = execFileSync(makensis as string, ["/WX", "/V2", harness], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(output).not.toMatch(/error/iu);
      expect(existsSync(path.join(directory, "check.exe"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function findMakensis(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || local === undefined) return undefined;
  const cache = path.join(local, "electron-builder", "Cache");
  try {
    for (const group of readdirSync(cache).filter((name) => name.startsWith("nsis"))) {
      const groupPath = path.join(cache, group);
      for (const entry of readdirSync(groupPath)) {
        const candidate = path.join(groupPath, entry, "makensis.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
