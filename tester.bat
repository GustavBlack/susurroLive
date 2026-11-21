@echo off
title susurroLive dev build
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [susurroLive] Electron is not installed.
  echo Run: npm install
  pause
  exit /b 1
)

echo [susurroLive] starting the dev build...
"node_modules\electron\dist\electron.exe" .
echo.
echo [susurroLive] dev build exited.
pause
