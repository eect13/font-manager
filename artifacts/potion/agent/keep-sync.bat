@echo off
REM Double-click or run from a Command Prompt.
REM Edit the three lines below, then save.

set KEEP_URL=http://127.0.0.1:4747
set KEEP_TOKEN=keep_paste_token_here
set KEEP_FOLDER=%USERPROFILE%\Keep

cd /d "%~dp0\.."
node agent\keep-sync.js
pause
