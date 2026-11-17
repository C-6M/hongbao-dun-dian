@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 红包蹲点 - 云端数据

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\instabox\open-cloud.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [错误] 连接失败，请查看上方提示.
  pause
)
exit /b %EXIT_CODE%
