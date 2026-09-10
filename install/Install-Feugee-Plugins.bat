@echo off
setlocal
title Feugee Studio - plugin installer

rem Feugee Studio - installer & repair (Windows)
rem Double-click this file. No administrator rights needed.
rem Runs the PowerShell installer sitting next to it; if this .bat was
rem downloaded on its own, it pulls the installer from GitHub instead.
rem
rem Deliberately written without parenthesised if/else blocks: those are what
rem cmd.exe mis-parses if this file ever loses its CRLF line endings.

set "PS1=%~dp0Install-Feugee-Plugins.ps1"
set "URL=https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/install/Install-Feugee-Plugins.ps1"

if exist "%PS1%" powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%PS1%' -ErrorAction SilentlyContinue; & '%PS1%' -NoPause"
if not exist "%PS1%" powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((Invoke-RestMethod '%URL%'))) -NoPause"

set "RC=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %RC%
