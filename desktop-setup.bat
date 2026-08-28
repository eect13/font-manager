@echo off
setlocal
cd /d "%~dp0"

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
node scripts\desktop-setup.mjs --run
echo.
pause
