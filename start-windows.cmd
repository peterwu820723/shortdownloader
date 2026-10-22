@echo off
setlocal
title ShortDownloader.com - Local Engine
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.19 or newer from https://nodejs.org first.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.10 or newer and enable Add Python to PATH first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto failed
)
call npm run setup
if errorlevel 1 goto failed
set VIDEO_OPEN_BROWSER=1
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Setup or engine startup failed. Read the error above and try again.
pause
exit /b 1
