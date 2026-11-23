@echo off
setlocal
rem Print a diagnostic report: paths, registry, vault file, backups, extension build.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Diagnose
echo.
pause
