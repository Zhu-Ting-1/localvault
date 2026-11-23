@echo off
setlocal
rem Uninstall LocalVault but KEEP the vault and backups.
rem   uninstall.cmd            - remove host + registry, keep vault
rem   uninstall.cmd -Purge     - also delete vault and backups (irreversible)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
echo.
pause
