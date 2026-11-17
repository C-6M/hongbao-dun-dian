@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 红包蹲点 - 一键启动

if not exist "%~dp01-启动扫描器.bat" goto :missing
if not exist "%~dp02-启动看板.bat" goto :missing
if not exist "%~dp0core\spider.js" goto :missing
if not exist "%~dp0core\local-scanner.js" goto :missing
if not exist "%~dp0core\server.js" goto :missing
if /i "%~1"=="--check" goto :checked

echo 正在打开本地扫描器和看板，请先确保 Clash 已启动.
echo 看板就绪后会自动打开浏览器，请保留两个运行窗口.

start "红包蹲点 - 扫描器" /D "%~dp0" "%ComSpec%" /d /c call "%~dp01-启动扫描器.bat"
if errorlevel 1 goto :launch_error
start "红包蹲点 - 看板" /D "%~dp0" "%ComSpec%" /d /c call "%~dp02-启动看板.bat"
if errorlevel 1 goto :launch_error
exit /b 0

:checked
echo [检查通过] 扫描器、看板和启动脚本齐全.
exit /b 0

:missing
echo [错误] 缺少启动脚本或 core 程序，请保留整个项目目录.
goto :failed

:launch_error
echo [错误] 无法打开运行窗口，请查看已打开窗口中的提示.

:failed
pause
exit /b 1
