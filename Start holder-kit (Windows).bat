@echo off
rem Double-click to start the holder-kit UI on Windows.
title holder-kit
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo holder-kit needs Node.js 20 or newer. Opening https://nodejs.org ...
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo holder-kit needs Node.js 20 or newer. Update it from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\viem" (
  echo First run: installing dependencies, one time...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting holder-kit. Your browser will open. Close this window to stop.
node src\server.mjs --open
pause
