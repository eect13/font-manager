@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0package.json" (
  echo.
  echo GitHub zip: open the inner font-manager-main folder, then run this file.
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

echo Running Font Manager desktop setup...
node "%~dp0scripts\desktop-setup.mjs" --run
echo.
pause
