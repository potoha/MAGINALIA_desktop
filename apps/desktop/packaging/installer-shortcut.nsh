!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "${PROJECT_DIR}\\packaging\\runtime\\ndlocr-installer-size.nsh"

# α1 display name. Only used to retire the α1 Desktop shortcut on upgrade.
!define MAGINALIA_LEGACY_NAME "MAGINALIA desktop α1"

!ifndef BUILD_UNINSTALLER
Var MAGINALIA_LEGACY_LINK_REMOVED
Var MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX
Var MAGINALIA_DESKTOP_SHORTCUT_STATE
Var MAGINALIA_NDLOCR_CHECKBOX
Var MAGINALIA_NDLOCR_STATE

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "追加コンポーネント"
  !define MUI_PAGE_HEADER_SUBTEXT "必要な機能を選べます。あとからインストールし直して変更できます。"
  Page custom MAGINALIA_NdlocrPageCreate MAGINALIA_NdlocrPageLeave
  !undef MUI_PAGE_HEADER_TEXT
  !undef MUI_PAGE_HEADER_SUBTEXT
  !define MUI_PAGE_HEADER_TEXT "ショートカットを選ぶ"
  !define MUI_PAGE_HEADER_SUBTEXT "デスクトップにもアイコンを置くか選べます。"
  Page custom MAGINALIA_DesktopShortcutPageCreate MAGINALIA_DesktopShortcutPageLeave
  !undef MUI_PAGE_HEADER_TEXT
  !undef MUI_PAGE_HEADER_SUBTEXT
!macroend

Function MAGINALIA_DesktopShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 12u "デスクトップにもショートカットを作る"
  Pop $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX
  ${NSD_Uncheck} $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX
  nsDialogs::Show
FunctionEnd

Function MAGINALIA_DesktopShortcutPageLeave
  ${NSD_GetState} $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX $MAGINALIA_DESKTOP_SHORTCUT_STATE
FunctionEnd

Function MAGINALIA_NdlocrPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 14u "NDLOCR-Lite 1.3.1（文字認識機能）"
  Pop $MAGINALIA_NDLOCR_CHECKBOX
  IfFileExists "$INSTDIR\resources\ndlocr\ndlocr-lite\ndlocr-lite.exe" MAGINALIA_NdlocrAlreadyInstalled
  ${NSD_Uncheck} $MAGINALIA_NDLOCR_CHECKBOX
  Goto MAGINALIA_NdlocrCheckboxReady
  MAGINALIA_NdlocrAlreadyInstalled:
    ${NSD_Check} $MAGINALIA_NDLOCR_CHECKBOX
  MAGINALIA_NdlocrCheckboxReady:
  ${NSD_CreateLabel} 0 22u 100% 56u "書籍や資料の画像から文字を読み取り、引用の確認・修正を支援します。画像はこのPC内で処理され、インターネットへ送信しません。\r\n追加容量：約${MAGINALIA_NDLOCR_SIZE_MB} MB\r\n開発：国立国会図書館（MAGINALIAへの推奨を意味するものではありません）"
  Pop $0
  ${NSD_CreateButton} 0 84u 58% 16u "ライセンスと開発元を確認"
  Pop $0
  ${NSD_OnClick} $0 MAGINALIA_ShowNdlocrLicenses
  ${NSD_CreateLabel} 0 106u 100% 26u "選ばなくてもMAGINALIAの基本機能は使えます。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function MAGINALIA_NdlocrPageLeave
  ${NSD_GetState} $MAGINALIA_NDLOCR_CHECKBOX $MAGINALIA_NDLOCR_STATE
FunctionEnd

Function MAGINALIA_ShowNdlocrLicenses
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\MAGINALIA-NDLOCR-Licenses"
  File /r "${PROJECT_DIR}\packaging\runtime\ndlocr\licenses\*.*"
  ExecShell "open" "$PLUGINSDIR\MAGINALIA-NDLOCR-Licenses\LICENSES.txt"
FunctionEnd
!endif

!macro customInstall
  ${If} $MAGINALIA_NDLOCR_STATE == ${BST_CHECKED}
    SetOutPath "$INSTDIR\resources\ndlocr"
    File /r "${PROJECT_DIR}\packaging\runtime\ndlocr\*.*"
  ${Else}
    RMDir /r "$INSTDIR\resources\ndlocr"
  ${EndIf}
  # Upgrade over α1: the α1 uninstaller never removes the optional Desktop
  # shortcut, so it would dangle at the removed α1 executable. Delete it only
  # when it points at the α1 executable inside this install directory, and
  # carry the user's choice over to the new name.
  StrCpy $MAGINALIA_LEGACY_LINK_REMOVED "0"
  IfFileExists "$DESKTOP\${MAGINALIA_LEGACY_NAME}.lnk" 0 MAGINALIA_LegacyDesktopShortcutDone
    System::Call 'Kernel32::SetEnvironmentVariable(t "MAGINALIA_LEGACY_LNK", t "$DESKTOP\${MAGINALIA_LEGACY_NAME}.lnk")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "MAGINALIA_LEGACY_EXE", t "$INSTDIR\${MAGINALIA_LEGACY_NAME}.exe")i'
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$l=(New-Object -ComObject WScript.Shell).CreateShortcut($$env:MAGINALIA_LEGACY_LNK);if($$l.TargetPath -ieq $$env:MAGINALIA_LEGACY_EXE){Remove-Item -LiteralPath $$env:MAGINALIA_LEGACY_LNK;exit 0}else{exit 3}"'
    Pop $0
    ${If} $0 == 0
      StrCpy $MAGINALIA_LEGACY_LINK_REMOVED "1"
    ${EndIf}
  MAGINALIA_LegacyDesktopShortcutDone:
  ${If} $MAGINALIA_DESKTOP_SHORTCUT_STATE == ${BST_CHECKED}
  ${OrIf} $MAGINALIA_LEGACY_LINK_REMOVED == "1"
    IfFileExists "$DESKTOP\MAGINALIA α2 wild berry.lnk" MAGINALIA_DesktopShortcutConflict
    CreateShortCut "$DESKTOP\MAGINALIA α2 wild berry.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto MAGINALIA_DesktopShortcutDone
    MAGINALIA_DesktopShortcutConflict:
      MessageBox MB_ICONEXCLAMATION|MB_OK "同じ名前のショートカットがあるため、デスクトップには追加しませんでした。"
    MAGINALIA_DesktopShortcutDone:
  ${EndIf}
!macroend
