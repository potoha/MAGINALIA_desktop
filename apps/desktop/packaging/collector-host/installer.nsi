; MAGINALIA Collector Host - per-user installer (Desktop #86).
;
; - No elevation: RequestExecutionLevel user, HKCU only, installs under
;   %LOCALAPPDATA%\Programs\MAGINALIA Collector Host.
; - Registers the Chrome Native Messaging host org.maginalia.collector for this user:
;   HKCU\Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector (default
;   value = full path of the manifest). The manifest's `path` is relative to itself.
; - Installing over an existing copy is the update path.
; - The uninstaller removes only the files this installer wrote, the program folder
;   when it is then empty, the host registry key and its Apps entry. It never touches
;   %LOCALAPPDATA%\MAGINALIA (binding, coordination, journal), any Shelf, or Chrome
;   profile data (including the Collector's pending requests).
;
; Defines supplied by scripts/build-collector-host.mjs: VERSION, PAYLOAD, OUTFILE.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"

!define PRODUCT_NAME "MAGINALIA Collector Host"
!define HOST_NAME "org.maginalia.collector"
!define EXECUTABLE "MAGINALIA-Collector-Host.exe"
!define MANIFEST "org.maginalia.collector.json"
!define HOST_KEY "Software\Google\Chrome\NativeMessagingHosts\${HOST_NAME}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MAGINALIACollectorHost"

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1041 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1041 "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey /LANG=1041 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1041 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1041 "LegalCopyright" "MAGINALIA"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "MAGINALIA Collector Host のセットアップ"
!define MUI_WELCOMEPAGE_TEXT "ブラウザー拡張機能 MAGINALIA Collector が、MAGINALIA で設定した Private Shelf に Web 引用を保存するための補助プログラムをインストールします。$\r$\n$\r$\n管理者権限は不要です。このユーザーだけにインストールされます。$\r$\n$\r$\n保存先の本棚は、MAGINALIA desktop の「ファイル」→「Collector の保存先を設定…」で選びます。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "インストールが完了しました"
!define MUI_FINISHPAGE_TEXT "Chrome を再起動すると MAGINALIA Collector から利用できます。"
!insertmacro MUI_PAGE_FINISH

!define MUI_UNCONFIRMPAGE_TEXT_TOP "MAGINALIA Collector Host を削除します。本棚、引用データ、Collector の保存先設定、Chrome のデータは削除されません。"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Japanese"

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "${PAYLOAD}\${EXECUTABLE}"
  File "${PAYLOAD}\shelf_mutex.node"
  File "${PAYLOAD}\${MANIFEST}"
  File "${PAYLOAD}\PROVENANCE.txt"
  File "${PAYLOAD}\LICENSE.txt"
  File "${PAYLOAD}\NOTICE.txt"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${HOST_KEY}" "" "$INSTDIR\${MANIFEST}"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "MAGINALIA"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ; Only the files this installer wrote. No wildcard or recursive delete.
  Delete "$INSTDIR\${EXECUTABLE}"
  Delete "$INSTDIR\shelf_mutex.node"
  Delete "$INSTDIR\${MANIFEST}"
  Delete "$INSTDIR\PROVENANCE.txt"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\NOTICE.txt"
  Delete "$INSTDIR\Uninstall.exe"
  ; Removed only when empty.
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${HOST_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
