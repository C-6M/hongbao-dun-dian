@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Redpacket Watch - QQ Forwarder
pushd "%~dp0" 2>nul
if errorlevel 1 exit /b 1
set "QQ_NODE_EXE="
for %%I in (node.exe) do set "QQ_NODE_EXE=%%~$PATH:I"
if not defined QQ_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "QQ_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined QQ_NODE_EXE (
  echo [ERROR] Node.js was not found.
  pause
  exit /b 1
)
if /I "%~1"=="--check" (
  "%QQ_NODE_EXE%" --check "core\qq-forward-start.js"
  if errorlevel 1 exit /b 1
  echo Launcher syntax OK.
  popd
  exit /b 0
)
"%QQ_NODE_EXE%" "core\qq-forward-start.js"
if errorlevel 1 (
  echo [ERROR] Startup failed. See the message above.
  pause
  popd
  exit /b 1
)
echo.
echo The QQ worker runs in the background. You may close this window.
echo Keep QQ logged in and the target group open as a separate window.
echo Start the scanner separately when you want live redpacket alerts.
popd
pause
