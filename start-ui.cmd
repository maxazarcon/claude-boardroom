@echo off
rem Starts the Claude Boardroom moderator UI on http://127.0.0.1:4737
rem Close this window to stop it.
title Claude Boardroom UI
cd /d "%~dp0"
node src\ui-server.js
echo.
echo The UI has stopped. Press any key to close.
pause >nul
