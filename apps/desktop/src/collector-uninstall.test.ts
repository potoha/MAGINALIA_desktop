/**
 * Static checks of the Collector uninstall cleanup (WP-8, design 2.4 / 8.5; multi-browser S5, design
 * 4.3 / 6): the NSIS script is read as text, never executed. The state-check PowerShell is the one
 * piece that is executed (Windows PowerShell 5.1), against parseIntegrationStateFile for state v1
 * and v2. The real uninstall is an owner E2E (WP-9). The compile test runs only where
 * electron-builder's NSIS (makensis) is already cached.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTOR_EXTENSION_PREVIOUS_NAME, COLLECTOR_EXTENSION_STAGING_NAME, COLLECTOR_HOST_LICENSE_FILES } from "./collector-integration-apply.js";
import { COLLECTOR_REGISTRY_TARGETS } from "./collector-browser-table.js";
import { COLLECTOR_EXTENSION_FOLDER_NAME, COLLECTOR_HOST_SLOTS, COLLECTOR_STATE_FILE_NAME, parseIntegrationStateFile } from "./collector-integration.js";
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

/**
 * The LogicLib conditions enclosing the first line that starts with `prefix`, outermost first. A
 * block's `${AndIf}` / `${OrIf}` lines are appended to its opening line. Throws when the line does
 * not exist.
 */
function enclosingConditions(body: string, prefix: string): string[] {
  const stack: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(prefix)) return [...stack];
    if (/^\$\{(if|ifNot|IfNot|If)\}/u.test(line)) stack.push(line);
    else if (/^\$\{(AndIf|OrIf|AndIfNot|OrIfNot)\}/u.test(line)) stack[stack.length - 1] += ` ${line}`;
    else if (/^\$\{(endIf|EndIf)\}/u.test(line)) stack.pop();
  }
  throw new Error(`line not found: ${prefix}`);
}

/** The PowerShell state check, rebuilt from the FileWrite lines of un.MAGINALIA_HasValidState. */
function stateCheckScript(source: string): string {
  const body = functionBody(source, "un.MAGINALIA_HasValidState");
  const lines = [...body.matchAll(/^ {2}FileWrite \$9 `(.*)\$\\r\$\\n`$/gmu)].map((match) => (match[1] as string).replaceAll("$$", "$"));
  return `${lines.join("\r\n")}\r\n`;
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
    // Structure, not order: the cleanup call sits INSIDE both the not-updated and the per-user blocks.
    const conditions = enclosingConditions((hook as RegExpExecArray)[1] as string, "!insertmacro MAGINALIA_CollectorCleanup");
    expect(conditions).toEqual(["${ifNot} ${isUpdated}", '${if} $installMode == "CurrentUser"']);
    expect(source.match(/^\s*!insertmacro MAGINALIA_CollectorCleanup$/gmu)?.length).toBe(1);
    // An "all users" uninstall runs elevated with $LOCALAPPDATA = ProgramData; only "CurrentUser" may
    // reach the cleanup (electron-builder multiUser.nsh: `Var installMode`, "CurrentUser" | "all").
    expect(codeLines(source).join("\n")).not.toMatch(/\$installMode\s*(!=|==)\s*"all"/u);
  });

  it("unregisters only when the registry value equals our own manifest path", async () => {
    const source = await readScript();
    const lines = codeLines(source);
    expect(lines).toContain(`!define MAGINALIA_COLLECTOR_HOST_KEY_CHROME "${COLLECTOR_HOST_REGISTRY_SUBKEY}"`);
    expect(lines).toContain(`!define MAGINALIA_COLLECTOR_MANIFEST_NAME "${COLLECTOR_MANIFEST_FILE_NAME}"`);
    expect(lines).toContain(`!define MAGINALIA_COLLECTOR_PROGRAM_SUBPATH "Programs\\${COLLECTOR_PROGRAM_FOLDER_NAME}"`);

    // The per-key block lives in ONE macro, so every target gets the identical read -> value match
    // -> delete value -> delete key-if-empty sequence.
    const macro = /^!macro MAGINALIA_UnregisterHostKey hostKey\n([\s\S]*?)^!macroend$/mu.exec(source);
    expect(macro).not.toBeNull();
    const macroLines = codeLines((macro as RegExpExecArray)[1] as string);
    const read = macroLines.findIndex((line) => line === 'ReadRegStr $R0 HKCU "${hostKey}" ""');
    const compare = macroLines.findIndex((line) => line === '${AndIf} $R0 == "$LOCALAPPDATA\\${MAGINALIA_COLLECTOR_PROGRAM_SUBPATH}\\${MAGINALIA_COLLECTOR_MANIFEST_NAME}"');
    const deleteValue = macroLines.findIndex((line) => line === 'DeleteRegValue HKCU "${hostKey}" ""');
    const deleteKey = macroLines.findIndex((line) => line === 'DeleteRegKey /ifempty HKCU "${hostKey}"');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(compare).toBeGreaterThan(read);
    expect(deleteValue).toBeGreaterThan(compare);
    expect(deleteKey).toBeGreaterThan(deleteValue);
    // Both deletes sit INSIDE the "no read error AND value equals our path" block.
    const body = (macro as RegExpExecArray)[1] as string;
    const guard = ["${IfNot} ${Errors} ${AndIf} $R0 == \"$LOCALAPPDATA\\${MAGINALIA_COLLECTOR_PROGRAM_SUBPATH}\\${MAGINALIA_COLLECTOR_MANIFEST_NAME}\""];
    expect(enclosingConditions(body, "DeleteRegValue HKCU")).toEqual(guard);
    expect(enclosingConditions(body, "DeleteRegKey /ifempty HKCU")).toEqual(guard);
    // The macro is the ONLY place that touches the registry: exactly these three registry statements,
    // all on the macro parameter; the key is removed only when empty, never under HKLM.
    expect(lines.filter((line) => /^(ReadRegStr|ReadRegDWORD|WriteReg\w+|DeleteReg(Key|Value)|EnumReg\w+)\b/u.test(line))).toEqual([
      'ReadRegStr $R0 HKCU "${hostKey}" ""',
      'DeleteRegValue HKCU "${hostKey}" ""',
      'DeleteRegKey /ifempty HKCU "${hostKey}"',
    ]);
    expect(source).not.toMatch(/\bHKLM\b|HKEY_LOCAL_MACHINE|SHCTX|SHELL_CONTEXT/u);
  });

  it("unregisters EVERY writable target (Chrome and Edge) and nothing else, matching the TS and addon tables", async () => {
    const source = await readScript();
    const lines = codeLines(source);

    // The writable subkeys of the three tables: TS (collector-browser-table), addon (windows_integration.cc), NSIS.
    const tsWritable = COLLECTOR_REGISTRY_TARGETS.filter((target) => target.writable).map((target) => [target.id, target.subkey] as const);
    const addon = await readFile(path.join(desktopRoot, "native/windows-integration/src/windows_integration.cc"), "utf8");
    const addonWritable = [...addon.matchAll(/^\s*\{"([a-z]+)", L"([^"]+)", (true|false)\},?$/gmu)]
      .filter((match) => match[3] === "true")
      .map((match) => [match[1] as string, (match[2] as string).replaceAll("\\\\", "\\")] as const);
    const nshDefines = lines
      .map((line) => /^!define MAGINALIA_COLLECTOR_HOST_KEY_([A-Z]+) "([^"]+)"$/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [(match[1] as string).toLowerCase(), match[2] as string] as const);
    expect(tsWritable.map(([id]) => id)).toEqual(["chrome", "edge"]);
    expect(addonWritable).toEqual(tsWritable);
    expect(nshDefines).toEqual(tsWritable);
    // The exact Edge key, spelled out: only the leaf key under the Edge host root.
    expect(lines).toContain('!define MAGINALIA_COLLECTOR_HOST_KEY_EDGE "Software\\Microsoft\\Edge\\NativeMessagingHosts\\org.maginalia.collector"');
    for (const [, subkey] of nshDefines) expect(subkey).toMatch(/^Software\\[A-Za-z]+(\\[A-Za-z]+)?\\NativeMessagingHosts\\org\.maginalia\.collector$/u);

    // One macro insertion per writable target, in table order, and no other insertion. The read-only
    // targets (Chromium, Vivaldi) and any parent key never appear as a registry path in the script.
    const inserted = lines.filter((line) => line.startsWith("!insertmacro MAGINALIA_UnregisterHostKey"));
    expect(inserted).toEqual(tsWritable.map(([id]) => `!insertmacro MAGINALIA_UnregisterHostKey "\${MAGINALIA_COLLECTOR_HOST_KEY_${id.toUpperCase()}}"`));
    for (const target of COLLECTOR_REGISTRY_TARGETS.filter((spec) => !spec.writable)) expect(source, `read-only ${target.id}`).not.toContain(target.subkey);
    expect(source).not.toMatch(/Software\\Chromium|Software\\Vivaldi/u);
    // The insertions run from the cleanup macro, before the (state-gated) folder cleanup, so the
    // registration is removed whatever the state file says.
    const cleanup = /!macro MAGINALIA_CollectorCleanup\n([\s\S]*?)!macroend/u.exec(source);
    const cleanupBody = (cleanup as RegExpExecArray)[1] as string;
    expect(cleanupBody.indexOf("MAGINALIA_UnregisterHostKey")).toBeGreaterThan(-1);
    expect(cleanupBody.lastIndexOf("MAGINALIA_UnregisterHostKey")).toBeLessThan(cleanupBody.indexOf("Call un.MAGINALIA_HasValidState"));
    expect(enclosingConditions(cleanupBody, "!insertmacro MAGINALIA_UnregisterHostKey")).toEqual([]);
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
    expect(lines.filter((line) => !line.startsWith("FileWrite ") && !line.startsWith("System::Call ") && /[*?]/u.test(line) && !/^FindFirst \$R6 \$R7 "\$R5\\\*\.tmp"$/u.test(line) && !line.startsWith("ReadRegStr"))).toEqual([]);
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
    // Only "not found" (2, 3) counts as absent; any other failure is "unknown" (= present, never deleted).
    expect(kind).toContain("? e");
    expect(kind).toMatch(/\$3 == 2\n\s*\$\{OrIf\} \$3 == 3\n\s*StrCpy \$0 "none"\n\s*\$\{Else\}\n\s*StrCpy \$0 "unknown"/u);
    // The delete sits INSIDE the "regular file" branch, the directory removal inside the "plain dir" branch.
    expect(enclosingConditions(functionBody(source, "un.MAGINALIA_DeleteOwnedFile"), "Delete $R1")).toEqual(['${If} $0 == "file"']);
    expect(enclosingConditions(functionBody(source, "un.MAGINALIA_RemoveEmptyDir"), "RMDir $R1")).toEqual(['${If} $0 == "dir"']);
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
    // Structure: the folder cleanup is INSIDE the "state is valid" block, and that block tests the
    // un-inverted result of HasValidState ($0 == "1" is ownership proven).
    expect(enclosingConditions(body, "Call un.MAGINALIA_CleanProgramFolder")).toEqual(['${If} $0 == "1"']);
    const validState = functionBody(source, "un.MAGINALIA_HasValidState");
    expect(validState).toMatch(/\$\{If\} \$9 == "0"\n\s*StrCpy \$0 "1"\n\s*\$\{Else\}\n\s*StrCpy \$0 "0"\n\s*\$\{EndIf\}\s*$/u);
    // Every early return of HasValidState reports "not ours".
    for (const match of validState.matchAll(/StrCpy \$0 "(\d)"\n\s*Return/gu)) expect(match[1]).toBe("0");
    // Nothing below the program folder is reached from anywhere else.
    for (const name of ["CleanSlot", "CleanExtension", "DeleteTempFiles"]) {
      const callers = [...source.matchAll(new RegExp(`Call un\\.MAGINALIA_${name}`, "gu"))].length;
      expect(callers).toBeGreaterThan(0);
    }
    const validity = functionBody(source, "un.MAGINALIA_HasValidState");
    expect(validity).toContain("${MAGINALIA_COLLECTOR_STATE_NAME}");
    expect(source).toContain(`!define MAGINALIA_COLLECTOR_STATE_NAME "${COLLECTOR_STATE_FILE_NAME}"`);
    // Equivalent strictness to parseIntegrationStateFile (proven by the execution test below); any failure means "not ours".
    for (const field of ["version", "payloadId", "activeSlot", "extensionVersion", "placedAt", "registeredTargets"]) expect(validity).toContain(`'${field}'`);
    // v1: exactly the five fields; v2 adds registeredTargets (6 fields). Version 2 appends the sixth name.
    expect(validity).toContain("$$f = 'version','payloadId','activeSlot','extensionVersion','placedAt'");
    expect(validity).toContain("if ($$v -eq 2) { $$f += 'registeredTargets' }");
    expect(validity).toContain("$$o.Count -ne $$f.Count");
    // registeredTargets: an array of writable target ids only (the table's writable ids), no duplicates.
    expect(validity).toContain("$$r -isnot [object[]]");
    expect(validity).toContain("$$seen.ContainsKey($$e)");
    const idChecks = [...validity.matchAll(/\$\$e -cne '([^']+)'/gu)].map((match) => match[1]);
    expect(idChecks).toEqual(COLLECTOR_REGISTRY_TARGETS.filter((target) => target.writable).map((target) => target.id));
    expect(validity).toContain("catch { exit 3 }");
    expect(validity).not.toMatch(/\bInvoke-Expression\b|\biex\b/u);

    // Folder cleanup: the state file goes last and only when every owned folder is gone.
    const folder = functionBody(source, "un.MAGINALIA_CleanProgramFolder");
    expect(folder.indexOf("MAGINALIA_NoteLeftover")).toBeGreaterThan(folder.indexOf("Call un.MAGINALIA_CleanExtension"));
    // The manifest and all five subfolders are checked for leftovers (WP-5b: a surviving manifest keeps the state file).
    const noted = [...folder.matchAll(/StrCpy \$8 "([^"]+)"\n\s*Call un\.MAGINALIA_NoteLeftover/gu)].map((match) => match[1]);
    expect(noted).toEqual(["${MAGINALIA_COLLECTOR_MANIFEST_NAME}", "host-a", "host-b", "extension", "extension.next", "extension.prev"]);
    expect(enclosingConditions(folder, "Push \"$6\\${MAGINALIA_COLLECTOR_STATE_NAME}\"")).toEqual(['${If} $7 == "0"']);
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
    // Append-only snapshot: names of every Collector release ever pinned. Add new names; NEVER remove one.
    const everPinned = [
      "manifest.json", "capture.css", "capture.html", "capture.js", "host-client.js", "icon..png", "onboarding.css",
      "onboarding.html", "onboarding.js", "outbox.js", "popup.css", "popup.html", "popup.js", "service-worker.js",
    ];
    for (const name of everPinned) expect(listed, `append-only: ${name} must stay`).toContain(name);
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

  const powershell = findPowerShell();
  if (powershell === undefined) console.warn("[collector-uninstall] SKIPPED state-check equivalence test: Windows PowerShell 5.1 is not available (non-Windows platform or missing powershell.exe).");
  it.skipIf(powershell === undefined)("the PowerShell state check accepts and rejects exactly what parseIntegrationStateFile does", async () => {
    const valid = {
      version: 1,
      payloadId: "0.2.0+abc1234",
      activeSlot: "a",
      extensionVersion: "0.3.0",
      placedAt: "2026-11-16T01:02:03.456Z",
    };
    const text = (override: Record<string, unknown> = {}, drop: string[] = []): string => {
      const value: Record<string, unknown> = { ...valid, ...override };
      for (const key of drop) delete value[key];
      return JSON.stringify(value);
    };
    const validV2 = { ...valid, version: 2, registeredTargets: ["chrome", "edge"] };
    const textV2 = (override: Record<string, unknown> = {}, drop: string[] = []): string => text({ version: 2, registeredTargets: ["chrome", "edge"], ...override }, drop);
    const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");
    const cases: Array<[string, Buffer]> = [
      ["valid", utf8(text())],
      ["valid, trailing newline", utf8(`${text()}\n`)],
      ["valid, CRLF pretty", utf8(JSON.stringify(valid, null, 2).replaceAll("\n", "\r\n"))],
      ["valid, UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(text())])],
      ["valid, slot b, prerelease", utf8(text({ activeSlot: "b", extensionVersion: "1.2.3.4-rc.1+build.5" }))],
      ["empty", Buffer.alloc(0)],
      ["whitespace only", utf8("  \n")],
      ["broken JSON", utf8('{"version":1,')],
      ["not an object", utf8("[]")],
      ["null", utf8("null")],
      ["missing version", utf8(text({}, ["version"]))],
      ["missing placedAt", utf8(text({}, ["placedAt"]))],
      ["only one field", utf8('{"version":1}')],
      ["extra key", utf8(text({ extra: 1 }))],
      ["version 2 without registeredTargets", utf8(text({ version: 2 }))],
      ["version as string", utf8(text({ version: "1" }))],
      ["bad slot", utf8(text({ activeSlot: "c" }))],
      ["slot uppercase", utf8(text({ activeSlot: "A" }))],
      ["payloadId without build", utf8(text({ payloadId: "0.2.0" }))],
      ["payloadId trailing newline", utf8(text({ payloadId: "0.2.0+abc1234\n" }))],
      ["payloadId number", utf8(text({ payloadId: 1 }))],
      ["extensionVersion trailing newline", utf8(text({ extensionVersion: "0.3.0\n" }))],
      ["extensionVersion full-width digits", utf8(text({ extensionVersion: "０.３.０" }))],
      ["extensionVersion empty prerelease part", utf8(text({ extensionVersion: "1.0.0-a..b" }))],
      ["extensionVersion trailing dot prerelease", utf8(text({ extensionVersion: "1.0.0-a." }))],
      ["extensionVersion five parts", utf8(text({ extensionVersion: "1.2.3.4.5" }))],
      ["extensionVersion garbage", utf8(text({ extensionVersion: "latest" }))],
      ["placedAt full-width digits", utf8(text({ placedAt: "２026-11-16T01:02:03Z" }))],
      ["placedAt trailing newline", utf8(text({ placedAt: "2026-11-16T01:02:03Z\n" }))],
      ["placedAt no zone", utf8(text({ placedAt: "2026-11-16T01:02:03" }))],
      ["UTF-16LE with BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text(), "utf16le")])],
      ["UTF-16BE with BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text(), "utf16le").swap16()])],
      ["invalid UTF-8", Buffer.concat([utf8('{"version":1,"payloadId":"'), Buffer.from([0xff, 0xfe]), utf8('"}')])],
      // State v2 (S4 writes it; design 4.3): the same five fields plus `registeredTargets`.
      ["v2 valid, chrome + edge", utf8(textV2())],
      ["v2 valid, chrome only", utf8(textV2({ registeredTargets: ["chrome"] }))],
      ["v2 valid, edge only", utf8(textV2({ registeredTargets: ["edge"] }))],
      ["v2 valid, empty registeredTargets", utf8(textV2({ registeredTargets: [] }))],
      ["v2 valid, reversed order", utf8(textV2({ registeredTargets: ["edge", "chrome"] }))],
      ["v2 valid, CRLF pretty", utf8(JSON.stringify(validV2, null, 2).replaceAll("\n", "\r\n"))],
      ["v2 valid, UTF-8 BOM, slot b", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(textV2({ activeSlot: "b" }))])],
      ["v2 missing registeredTargets (five fields)", utf8(textV2({}, ["registeredTargets"]))],
      ["v2 extra key (seven fields)", utf8(textV2({ extra: 1 }))],
      ["v2 duplicate target", utf8(textV2({ registeredTargets: ["chrome", "chrome"] }))],
      ["v2 duplicate target, three entries", utf8(textV2({ registeredTargets: ["chrome", "edge", "chrome"] }))],
      ["v2 unknown target", utf8(textV2({ registeredTargets: ["firefox"] }))],
      ["v2 known + unknown target", utf8(textV2({ registeredTargets: ["chrome", "firefox"] }))],
      ["v2 read-only target chromium", utf8(textV2({ registeredTargets: ["chromium"] }))],
      ["v2 unverified target vivaldi", utf8(textV2({ registeredTargets: ["vivaldi"] }))],
      ["v2 target uppercase", utf8(textV2({ registeredTargets: ["Chrome"] }))],
      ["v2 target with trailing space", utf8(textV2({ registeredTargets: ["chrome "] }))],
      ["v2 target empty string", utf8(textV2({ registeredTargets: [""] }))],
      ["v2 target null element", utf8(textV2({ registeredTargets: [null] }))],
      ["v2 target number element", utf8(textV2({ registeredTargets: [1] }))],
      ["v2 target nested array", utf8(textV2({ registeredTargets: [["chrome"]] }))],
      ["v2 target object element", utf8(textV2({ registeredTargets: [{ id: "chrome" }] }))],
      ["v2 registeredTargets string", utf8(textV2({ registeredTargets: "chrome" }))],
      ["v2 registeredTargets null", utf8(textV2({ registeredTargets: null }))],
      ["v2 registeredTargets object", utf8(textV2({ registeredTargets: { chrome: true } }))],
      ["v2 registeredTargets number", utf8(textV2({ registeredTargets: 1 }))],
      ["v2 bad payloadId", utf8(textV2({ payloadId: "0.2.0" }))],
      ["v2 bad activeSlot", utf8(textV2({ activeSlot: "c" }))],
      ["v2 bad extensionVersion", utf8(textV2({ extensionVersion: "latest" }))],
      ["v2 bad placedAt", utf8(textV2({ placedAt: "2026-11-16T01:02:03" }))],
      ["v2 version as string", utf8(textV2({ version: "2" }))],
      ["v1 with registeredTargets (six fields)", utf8(text({ registeredTargets: ["chrome"] }))],
      ["version 3", utf8(textV2({ version: 3 }))],
      ["version 0", utf8(textV2({ version: 0 }))],
    ];
    const oversize = utf8(`${text()}${" ".repeat(5000)}`);
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-state-"));
    try {
      const script = path.join(directory, "check.ps1");
      await writeFile(script, stateCheckScript(await readScript()), "utf8");
      const all: Array<[string, Buffer]> = [...cases, ["oversize (> 4096 bytes)", oversize]];
      for (const [index, [, bytes]] of all.entries()) await writeFile(path.join(directory, `case-${index}.json`), bytes);
      const driver = path.join(directory, "run.ps1");
      await writeFile(
        driver,
        [
          "$dir = $args[0]",
          "$check = Join-Path $dir 'check.ps1'",
          `foreach ($i in 0..${all.length - 1}) {`,
          "  $env:MAGINALIA_COLLECTOR_STATE = Join-Path $dir \"case-$i.json\"",
          "  & $check",
          "  Write-Output \"$i=$LASTEXITCODE\"",
          "}",
          "",
        ].join("\r\n"),
        "utf8",
      );
      const output = execFileSync(powershell as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver, directory], { encoding: "utf8" });
      const results = new Map([...output.matchAll(/^(\d+)=(\d+)\s*$/gmu)].map((match) => [Number(match[1]), Number(match[2])]));
      for (const [index, [label, bytes]] of all.entries()) {
        let expected = false;
        if (bytes.length <= 4096) {
          try {
            expected = parseIntegrationStateFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) !== undefined;
          } catch {
            expected = false;
          }
        }
        // Guard against a vacuous pass: every case labelled valid really is accepted by the parser.
        if (label.startsWith("valid") || label.startsWith("v2 valid")) expect(expected, `${label}: parseIntegrationStateFile`).toBe(true);
        expect(results.get(index) === 0, `${label} (script exit ${String(results.get(index))})`).toBe(expected);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  const makensis = findMakensis();
  if (makensis === undefined) console.warn("[collector-uninstall] SKIPPED makensis compile test: electron-builder's cached NSIS (makensis.exe) was not found; the script compile is NOT VERIFIED here.");
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
          "Var installMode",
          'Name "check"',
          `OutFile "${path.join(directory, "check.exe")}"`,
          "RequestExecutionLevel user",
          `!include "${scriptPath}"`,
          'Section "i"',
          '  StrCpy $installMode "CurrentUser"',
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

function findPowerShell(): string | undefined {
  const root = process.env.SystemRoot;
  if (process.platform !== "win32" || root === undefined) return undefined;
  const candidate = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : undefined;
}

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
