# Collector integration cleanup for the Desktop uninstaller (WP-8).
#
# Source of truth: docs/collector-wizard-integration-design.md 2.3, 2.4, 8.5 (Desktop repository,
# separate branch) and the WP-5b `remove` in apps/desktop/src/collector-integration-apply.ts. This
# file is deliberately a smaller, name-only duplicate of that logic. If the two disagree, WP-5b and
# the design win and this file is the one to fix.
#
# Rules (all enforced by src/collector-uninstall.test.ts):
#  - Runs only from `customUnInstall`, only when NOT ${isUpdated} (an update keeps the integration)
#    and only for a per-user install ($installMode == "CurrentUser"; see the macro at the end).
#  - Every writable HKCU Native Messaging Host key (Chrome, Edge) is checked on its own and removed
#    only when its default value equals OUR manifest path. A foreign value is left alone and the
#    other keys and the folder cleanup still run. The parent NativeMessagingHosts keys, the
#    read-only Chromium key and any other host are never touched. This does not depend on the state
#    file: the registry decision is the value match alone.
#  - Files are deleted only inside the fixed program folder, only by fixed name (or our private
#    `<name>.<16 lowercase hex>.tmp` temp names), and only when the program folder holds a VALID
#    integration-state.json (the ownership evidence). No state file, or an invalid one: nothing on
#    disk is touched.
#  - Never a recursive delete, never a wildcard delete. `FindFirst *.tmp` only enumerates; every hit
#    must pass un.MAGINALIA_IsTempName before it can be deleted.
#  - A link / junction / reparse point (folder or file) is never followed and never deleted.
#  - Unknown files stay; the folder then stays (the safe failure). Nothing outside the program
#    folder is touched: not %LOCALAPPDATA%\MAGINALIA (binding, journal), Shelf, Workdesk, Projects,
#    browser profile data or the browser-side extension registration.
#
# Register use (uninstaller functions): leaf functions $0-$5, layer 2 $R0-$R4, layer 3 $R5-$R7,
# slot / extension cleanup $R8-$R9, folder cleanup and state check $6-$9. Result goes in $0. The
# macro below saves and restores every register it lets the functions clobber.

!include "LogicLib.nsh"

# One define per WRITABLE registry target of the addon table (apps/desktop/native/windows-integration,
# kTargets) and of COLLECTOR_REGISTRY_TARGETS: chrome, edge. A define is named after the target id.
# The read-only targets (chromium, and the unverified vivaldi) are never written or deleted by
# MAGINALIA, so they have no define here. Add a define (and one insertmacro below) for a new
# writable target; src/collector-uninstall.test.ts checks the three tables agree.
!define MAGINALIA_COLLECTOR_HOST_KEY_CHROME "Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector"
!define MAGINALIA_COLLECTOR_HOST_KEY_EDGE "Software\Microsoft\Edge\NativeMessagingHosts\org.maginalia.collector"
!define MAGINALIA_COLLECTOR_PROGRAM_SUBPATH "Programs\MAGINALIA Collector"
!define MAGINALIA_COLLECTOR_MANIFEST_NAME "org.maginalia.collector.json"
!define MAGINALIA_COLLECTOR_STATE_NAME "integration-state.json"

!ifdef BUILD_UNINSTALLER

# Pop path; $0 = "none" | "unknown" | "link" (any reparse point) | "dir" | "file". Clobbers $0-$3.
Function un.MAGINALIA_PathKind
  Pop $1
  System::Call 'Kernel32::GetFileAttributesW(w r1)i.r2 ? e'
  Pop $3
  ${If} $2 == -1
    # Only "not found" counts as absent (2 = FILE_NOT_FOUND, 3 = PATH_NOT_FOUND). Any other failure
    # (access denied, sharing problem) is "unknown": treated as present and never deleted.
    ${If} $3 == 2
    ${OrIf} $3 == 3
      StrCpy $0 "none"
    ${Else}
      StrCpy $0 "unknown"
    ${EndIf}
    Return
  ${EndIf}
  IntOp $3 $2 & 0x400
  ${If} $3 != 0
    StrCpy $0 "link"
    Return
  ${EndIf}
  IntOp $3 $2 & 0x10
  ${If} $3 != 0
    StrCpy $0 "dir"
  ${Else}
    StrCpy $0 "file"
  ${EndIf}
FunctionEnd

# Push char, Push set; $0 = "1" when the (case-sensitive) char is in the set. Clobbers $0-$5.
Function un.MAGINALIA_InSet
  Pop $2
  Pop $1
  StrCpy $0 "0"
  StrLen $3 $2
  IntOp $3 $3 - 1
  ${For} $4 0 $3
    StrCpy $5 $2 1 $4
    ${If} $5 S== $1
      StrCpy $0 "1"
      ${ExitFor}
    ${EndIf}
  ${Next}
FunctionEnd

# Pop file name; $0 = "1" when it is `<base>.<16 lowercase hex>.tmp` with base in [A-Za-z0-9._-]{1,120}
# (the private temp names of WP-5b, TEMP_NAME_PATTERN). Clobbers $0-$5, $R0-$R4.
Function un.MAGINALIA_IsTempName
  Pop $R0
  StrCpy $0 "0"
  StrLen $R1 $R0
  ${If} $R1 < 22
  ${OrIf} $R1 > 141
    Return
  ${EndIf}
  StrCpy $R3 $R0 4 -4
  ${IfNot} $R3 S== ".tmp"
    Return
  ${EndIf}
  StrCpy $R3 $R0 1 -21
  ${IfNot} $R3 S== "."
    Return
  ${EndIf}
  ${For} $R2 0 15
    IntOp $R3 $R2 - 20
    StrCpy $R4 $R0 1 $R3
    Push $R4
    Push "0123456789abcdef"
    Call un.MAGINALIA_InSet
    ${If} $0 != "1"
      Return
    ${EndIf}
  ${Next}
  IntOp $R3 $R1 - 22
  ${For} $R2 0 $R3
    StrCpy $R4 $R0 1 $R2
    Push $R4
    Push "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
    Call un.MAGINALIA_InSet
    ${If} $0 != "1"
      Return
    ${EndIf}
  ${Next}
  StrCpy $0 "1"
FunctionEnd

# Pop full path. The ONLY file delete in this script: a regular file that is not a reparse point.
# Clobbers $0-$3, $R0-$R4.
Function un.MAGINALIA_DeleteOwnedFile
  Pop $R1
  Push $R1
  Call un.MAGINALIA_PathKind
  ${If} $0 == "file"
    Delete $R1
  ${EndIf}
FunctionEnd

# Pop directory. Deletes the private temp files in it (never a directory, never a link).
# Clobbers $0-$5, $R0-$R7.
Function un.MAGINALIA_DeleteTempFiles
  Pop $R5
  FindFirst $R6 $R7 "$R5\*.tmp"
  ${DoWhile} $R7 != ""
    Push $R7
    Call un.MAGINALIA_IsTempName
    ${If} $0 == "1"
      Push "$R5\$R7"
      Call un.MAGINALIA_DeleteOwnedFile
    ${EndIf}
    FindNext $R6 $R7
  ${Loop}
  FindClose $R6
FunctionEnd

# Pop directory; remove it only when it is a plain (non-link) EMPTY directory. Non-recursive.
# Clobbers $0-$3, $R0-$R4.
Function un.MAGINALIA_RemoveEmptyDir
  Pop $R1
  Push $R1
  Call un.MAGINALIA_PathKind
  ${If} $0 == "dir"
    RMDir $R1
  ${EndIf}
FunctionEnd

# Pop Host slot directory (host-a / host-b): fixed Host file names plus private temp names.
Function un.MAGINALIA_CleanSlot
  Pop $R8
  Push $R8
  Call un.MAGINALIA_PathKind
  ${If} $0 != "dir"
    Return
  ${EndIf}
  Push "$R8\MAGINALIA-Collector-Host.exe"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\shelf_mutex.node"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\LICENSE.txt"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\NOTICE.txt"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\NODE-LICENSE.txt"
  Call un.MAGINALIA_DeleteOwnedFile
  Push $R8
  Call un.MAGINALIA_DeleteTempFiles
  Push $R8
  Call un.MAGINALIA_RemoveEmptyDir
FunctionEnd

# Pop extension directory (extension / extension.next / extension.prev): the pinned Collector
# release file names only. APPEND-ONLY: when runtime-versions.json pins a new Collector release,
# ADD its new file names here and never remove an old one, so a folder placed by an older Desktop
# version is still covered (design 2.4; checked by src/collector-uninstall.test.ts). Unknown names
# (user files, subfolders) stay and keep the folder in place.
Function un.MAGINALIA_CleanExtension
  Pop $R8
  Push $R8
  Call un.MAGINALIA_PathKind
  ${If} $0 != "dir"
    Return
  ${EndIf}
  Push "$R8\manifest.json"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\capture.css"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\capture.html"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\capture.js"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\host-client.js"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\icon..png"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\onboarding.css"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\onboarding.html"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\onboarding.js"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\outbox.js"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\popup.css"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\popup.html"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\popup.js"
  Call un.MAGINALIA_DeleteOwnedFile
  Push "$R8\service-worker.js"
  Call un.MAGINALIA_DeleteOwnedFile
  Push $R8
  Call un.MAGINALIA_DeleteTempFiles
  Push $R8
  Call un.MAGINALIA_RemoveEmptyDir
FunctionEnd

# Pop program folder; $0 = "1" only when it is a plain directory holding a valid integration-state.json
# (mirrors parseIntegrationStateFile, multi-browser design 4.3 / 6.1: version 1 has exactly the five
# fields version, payloadId, activeSlot a|b, extensionVersion, placedAt; version 2 has exactly those
# five plus registeredTargets, an array without duplicates whose entries are the writable target ids
# "chrome" / "edge" in any order, possibly empty). Any doubt, including a PowerShell failure, is "0".
# Clobbers $0-$9, $R0-$R7.
Function un.MAGINALIA_HasValidState
  Pop $6
  Push $6
  Call un.MAGINALIA_PathKind
  ${If} $0 != "dir"
    StrCpy $0 "0"
    Return
  ${EndIf}
  StrCpy $7 "$6\${MAGINALIA_COLLECTOR_STATE_NAME}"
  Push $7
  Call un.MAGINALIA_PathKind
  ${If} $0 != "file"
    StrCpy $0 "0"
    Return
  ${EndIf}
  InitPluginsDir
  StrCpy $8 "$PLUGINSDIR\maginalia-collector-state-check.ps1"
  FileOpen $9 $8 w
  ${If} $9 == ""
    StrCpy $0 "0"
    Return
  ${EndIf}
  FileWrite $9 `$$ErrorActionPreference = 'Stop'$\r$\n`
  FileWrite $9 `try {$\r$\n`
  FileWrite $9 `  $$p = $$env:MAGINALIA_COLLECTOR_STATE$\r$\n`
  FileWrite $9 `  $$i = Get-Item -LiteralPath $$p -Force$\r$\n`
  FileWrite $9 `  if ($$i.PSIsContainer -or ($$i.Attributes -band 1024) -or $$i.Length -gt 4096) { exit 3 }$\r$\n`
  FileWrite $9 `  $$b = [System.IO.File]::ReadAllBytes($$p)$\r$\n`
  FileWrite $9 `  if ($$b.Length -ge 3 -and $$b[0] -eq 239 -and $$b[1] -eq 187 -and $$b[2] -eq 191) { $$b = $$b[3..($$b.Length - 1)] }$\r$\n`
  FileWrite $9 `  $$t = (New-Object System.Text.UTF8Encoding($$false, $$true)).GetString([byte[]]$$b)$\r$\n`
  FileWrite $9 `  Add-Type -AssemblyName System.Web.Extensions$\r$\n`
  FileWrite $9 `  $$o = (New-Object System.Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($$t)$\r$\n`
  FileWrite $9 `  if ($$o -isnot [System.Collections.IDictionary] -or -not $$o.ContainsKey('version')) { exit 3 }$\r$\n`
  FileWrite $9 `  $$v = $$o['version']$\r$\n`
  FileWrite $9 `  if ($$v -isnot [int] -or ($$v -ne 1 -and $$v -ne 2)) { exit 3 }$\r$\n`
  FileWrite $9 `  $$f = 'version','payloadId','activeSlot','extensionVersion','placedAt'$\r$\n`
  FileWrite $9 `  if ($$v -eq 2) { $$f += 'registeredTargets' }$\r$\n`
  FileWrite $9 `  if ($$o.Count -ne $$f.Count) { exit 3 }$\r$\n`
  FileWrite $9 `  foreach ($$k in $$f) { if (-not $$o.ContainsKey($$k)) { exit 3 } }$\r$\n`
  FileWrite $9 `  if ($$o['payloadId'] -isnot [string] -or $$o['payloadId'] -cnotmatch '^[0-9A-Za-z][0-9A-Za-z.-]{0,63}\+[0-9A-Za-z]{1,40}\z') { exit 3 }$\r$\n`
  FileWrite $9 `  if ($$o['activeSlot'] -isnot [string] -or ($$o['activeSlot'] -cne 'a' -and $$o['activeSlot'] -cne 'b')) { exit 3 }$\r$\n`
  FileWrite $9 `  if ($$o['extensionVersion'] -isnot [string] -or $$o['extensionVersion'] -cnotmatch '^[0-9]{1,9}(\.[0-9]{1,9}){0,3}(-(?<pre>[0-9A-Za-z][0-9A-Za-z.-]{0,31}))?(\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?\z') { exit 3 }$\r$\n`
  FileWrite $9 `  if ($$Matches['pre'] -and @($$Matches['pre'].Split('.') | Where-Object { $$_.Length -eq 0 }).Count -gt 0) { exit 3 }$\r$\n`
  FileWrite $9 `  if ($$o['placedAt'] -isnot [string] -or $$o['placedAt'] -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z\z') { exit 3 }$\r$\n`
  FileWrite $9 `  if ($$v -eq 2) {$\r$\n`
  FileWrite $9 `    $$r = $$o['registeredTargets']$\r$\n`
  FileWrite $9 `    if ($$r -isnot [object[]]) { exit 3 }$\r$\n`
  FileWrite $9 `    $$seen = @{}$\r$\n`
  FileWrite $9 `    foreach ($$e in $$r) {$\r$\n`
  FileWrite $9 `      if ($$e -isnot [string] -or ($$e -cne 'chrome' -and $$e -cne 'edge') -or $$seen.ContainsKey($$e)) { exit 3 }$\r$\n`
  FileWrite $9 `      $$seen[$$e] = $$true$\r$\n`
  FileWrite $9 `    }$\r$\n`
  FileWrite $9 `  }$\r$\n`
  FileWrite $9 `  exit 0$\r$\n`
  FileWrite $9 `} catch { exit 3 }$\r$\n`
  FileClose $9
  System::Call 'Kernel32::SetEnvironmentVariable(t "MAGINALIA_COLLECTOR_STATE", t r7)i'
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$8"'
  Pop $9
  System::Call 'Kernel32::SetEnvironmentVariable(t "MAGINALIA_COLLECTOR_STATE", t "")i'
  Delete $8
  ${If} $9 == "0"
    StrCpy $0 "1"
  ${Else}
    StrCpy $0 "0"
  ${EndIf}
FunctionEnd

# Pop program folder. Call only after un.MAGINALIA_HasValidState returned "1".
Function un.MAGINALIA_CleanProgramFolder
  Pop $6
  Push $6
  Call un.MAGINALIA_PathKind
  ${If} $0 != "dir"
    Return
  ${EndIf}
  Push "$6\${MAGINALIA_COLLECTOR_MANIFEST_NAME}"
  Call un.MAGINALIA_DeleteOwnedFile
  Push $6
  Call un.MAGINALIA_DeleteTempFiles
  Push "$6\host-a"
  Call un.MAGINALIA_CleanSlot
  Push "$6\host-b"
  Call un.MAGINALIA_CleanSlot
  Push "$6\extension"
  Call un.MAGINALIA_CleanExtension
  Push "$6\extension.next"
  Call un.MAGINALIA_CleanExtension
  Push "$6\extension.prev"
  Call un.MAGINALIA_CleanExtension
  # The state file goes last, and only when every owned folder is gone, so that an interrupted or
  # partial cleanup still looks like ours (WP-5b). Then the root, non-recursive.
  StrCpy $7 "0"
  StrCpy $8 "${MAGINALIA_COLLECTOR_MANIFEST_NAME}"
  Call un.MAGINALIA_NoteLeftover
  StrCpy $8 "host-a"
  Call un.MAGINALIA_NoteLeftover
  StrCpy $8 "host-b"
  Call un.MAGINALIA_NoteLeftover
  StrCpy $8 "extension"
  Call un.MAGINALIA_NoteLeftover
  StrCpy $8 "extension.next"
  Call un.MAGINALIA_NoteLeftover
  StrCpy $8 "extension.prev"
  Call un.MAGINALIA_NoteLeftover
  ${If} $7 == "0"
    Push "$6\${MAGINALIA_COLLECTOR_STATE_NAME}"
    Call un.MAGINALIA_DeleteOwnedFile
    Push $6
    Call un.MAGINALIA_RemoveEmptyDir
  ${EndIf}
FunctionEnd

# $6 = program folder, $8 = child name; sets $7 = "1" when that child still exists. Clobbers $0-$3.
Function un.MAGINALIA_NoteLeftover
  Push "$6\$8"
  Call un.MAGINALIA_PathKind
  ${If} $0 != "none"
    StrCpy $7 "1"
  ${EndIf}
FunctionEnd

!endif

# One writable target: the HKCU host key `hostKey` is unregistered only when its default value is
# exactly our manifest path (case-insensitive compare, as Windows paths are). Then the key itself
# goes only when it is empty (a foreign extra value keeps it). The parent keys stay. Uses $R0 only;
# an error here (missing key, no access) just skips this target and never stops the next one.
!macro MAGINALIA_UnregisterHostKey hostKey
  ClearErrors
  ReadRegStr $R0 HKCU "${hostKey}" ""
  ${IfNot} ${Errors}
  ${AndIf} $R0 == "$LOCALAPPDATA\${MAGINALIA_COLLECTOR_PROGRAM_SUBPATH}\${MAGINALIA_COLLECTOR_MANIFEST_NAME}"
    DeleteRegValue HKCU "${hostKey}" ""
    DeleteRegKey /ifempty HKCU "${hostKey}"
  ${EndIf}
!macroend

# Registration (every writable target) + folder cleanup.
!macro MAGINALIA_CollectorCleanup
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  !insertmacro MAGINALIA_UnregisterHostKey "${MAGINALIA_COLLECTOR_HOST_KEY_CHROME}"
  !insertmacro MAGINALIA_UnregisterHostKey "${MAGINALIA_COLLECTOR_HOST_KEY_EDGE}"

  Push "$LOCALAPPDATA\${MAGINALIA_COLLECTOR_PROGRAM_SUBPATH}"
  Call un.MAGINALIA_HasValidState
  ${If} $0 == "1"
    Push "$LOCALAPPDATA\${MAGINALIA_COLLECTOR_PROGRAM_SUBPATH}"
    Call un.MAGINALIA_CleanProgramFolder
  ${EndIf}

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

# Only a real uninstall removes the integration. electron-builder's update path runs the previous
# uninstaller with --updated; the registration and folder must survive it (design 2.3, 8.5).
#
# Only for a per-user install. In an "all users" install (`$installMode == "all"`, set by
# setInstallModePerAllUsers, which also does SetShellVarContext all and runs the uninstaller
# elevated) NSIS's $LOCALAPPDATA is C:\ProgramData: a folder an ordinary user can pre-create
# (valid state file, junctions) and an administrator's uninstaller must never delete from. Nothing
# is cleaned up there; the in-app removal command is the way out for such users (design 2.4).
# electron-builder's multiUser.nsh: `Var installMode`, values "CurrentUser" or "all".
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} $installMode == "CurrentUser"
      !insertmacro MAGINALIA_CollectorCleanup
    ${endIf}
  ${endIf}
!macroend
