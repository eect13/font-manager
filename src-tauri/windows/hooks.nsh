; Font Manager NSIS hooks. Quietly quit a tray copy so files are not locked.
; Documents\Font Manager is left alone.

!macro NSIS_HOOK_PREINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcessCurrentUser "${PRODUCTNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcessCurrentUser "font-manager.exe"
  Pop $R9
  nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcess "${PRODUCTNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcess "font-manager.exe"
  Pop $R9
  nsExec::Exec 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Pop $R9
  nsExec::Exec 'taskkill /F /IM "${PRODUCTNAME}.exe"'
  Pop $R9
  nsExec::Exec 'taskkill /F /IM "font-manager.exe"'
  Pop $R9
  Sleep 400
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcessCurrentUser "${PRODUCTNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcessCurrentUser "font-manager.exe"
  Pop $R9
  nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcess "${PRODUCTNAME}.exe"
  Pop $R9
  nsis_tauri_utils::KillProcess "font-manager.exe"
  Pop $R9
  nsExec::Exec 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Pop $R9
  nsExec::Exec 'taskkill /F /IM "${PRODUCTNAME}.exe"'
  Pop $R9
  nsExec::Exec 'taskkill /F /IM "font-manager.exe"'
  Pop $R9
  Sleep 400
!macroend
