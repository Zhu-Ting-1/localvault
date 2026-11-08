@echo off
setlocal
rem LocalVault installer - one click. No admin rights required.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo [FAILED] Installation did not complete. See the message above.
  pause
  exit /b 1
)
echo.
pause
