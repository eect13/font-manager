; Font Manager NSIS hooks.
; Ask the installed app to close (WM_CLOSE via CloseMainWindow). Never a force kill.
; A Tip build (path contains \Tip\) is left running, including a silent install.
; Documents\Font Manager is left alone.

!macro FM_ASK_CLOSE exeName
  nsExec::ExecToLog 'powershell -NoProfile -WindowStyle Hidden -Command "Get-Process -Name ''${exeName}'' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -notmatch ''\\[Tt]ip\\'') } | ForEach-Object { $_.CloseMainWindow() | Out-Null }"'
  Pop $R9
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro FM_ASK_CLOSE "font-manager"
  !insertmacro FM_ASK_CLOSE "${MAINBINARYNAME}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro FM_ASK_CLOSE "font-manager"
  !insertmacro FM_ASK_CLOSE "${MAINBINARYNAME}"
!macroend
