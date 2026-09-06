@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0package.json" (
  echo.
  echo This is not the Font Manager project folder.
  echo GitHub zip: open the inner font-manager-main folder, then double-click deploy.bat there.
  echo.
  pause
  exit /b 1
)
if not exist "%~dp0scripts\deploy.mjs" (
  echo.
  echo scripts\deploy.mjs is missing. Re-download the repo zip and run deploy.bat from that folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 22 or newer is required.
  echo Opening https://nodejs.org  — install it, then double-click this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

echo Building Font Manager installers...
echo Leave this window open. First build can take a long time.
echo.
node "%~dp0scripts\deploy.mjs"
echo.
pause
