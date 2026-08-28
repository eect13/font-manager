@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo Font Manager — clear a broken program install
echo.
echo This does NOT delete typefaces in Documents\Font Manager.
echo It closes the tray copy, removes leftover AppData files,
echo and clears the "already installed" registry keys.
echo.

taskkill /F /IM "font-manager.exe" >nul 2>nul
taskkill /F /IM "Font Manager.exe" >nul 2>nul
timeout /t 2 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$names = @('Font Manager','font-manager');" ^
  "foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {" ^
  "  if (Test-Path $hive) { Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {" ^
  "    $dn = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName;" ^
  "    if ($names -contains $dn) { Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue }" ^
  "  } }" ^
  "};" ^
  "Remove-Item 'HKCU:\Software\Eric Emerson Tan\Font Manager' -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Font Manager' -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item 'HKLM:\Software\Eric Emerson Tan\Font Manager' -Recurse -Force -ErrorAction SilentlyContinue;"

if exist "%LOCALAPPDATA%\Font Manager\uninstall.exe" del /f /q "%LOCALAPPDATA%\Font Manager\uninstall.exe" >nul 2>nul
if exist "%LOCALAPPDATA%\Font Manager\" rmdir /s /q "%LOCALAPPDATA%\Font Manager" 2>nul
if exist "%LOCALAPPDATA%\app.fontmanager.desktop\" rmdir /s /q "%LOCALAPPDATA%\app.fontmanager.desktop" 2>nul
if exist "%PROGRAMFILES%\Font Manager\" rmdir /s /q "%PROGRAMFILES%\Font Manager" 2>nul
if exist "%PROGRAMFILES(X86)%\Font Manager\" rmdir /s /q "%PROGRAMFILES(X86)%\Font Manager" 2>nul

del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Font Manager.lnk" >nul 2>nul
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Font Manager\" (
  del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Font Manager\*.lnk" >nul 2>nul
  rmdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Font Manager" >nul 2>nul
)
del /q "%USERPROFILE%\Desktop\Font Manager.lnk" >nul 2>nul
del /q "%PUBLIC%\Desktop\Font Manager.lnk" >nul 2>nul

echo Leftover program files are gone. Fonts in Documents are untouched.
echo.

set "SETUP="
for /f "delims=" %%F in ('dir /b /s /a:-d "src-tauri\target\release\bundle\nsis\*.exe" 2^>nul') do set "SETUP=%%F"
if not defined SETUP for /f "delims=" %%F in ('dir /b /s /a:-d "src-tauri\target\release\bundle\msi\*.msi" 2^>nul') do set "SETUP=%%F"

if defined SETUP (
  echo Launching setup:
  echo   %SETUP%
  echo If Windows blocked it: right-click the file - Properties - Unblock.
  echo.
  start "" "%SETUP%"
) else (
  echo No setup found under src-tauri\target\release\bundle\
  echo Run deploy.bat first, then double-click this file again.
  echo.
  pause
)
