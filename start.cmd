@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js to use the local preview.
  pause
  exit /b 1
)
node server.js --open
