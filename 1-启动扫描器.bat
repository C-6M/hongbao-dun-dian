@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 红包蹲点 - 扫描器

pushd "%~dp0core" 2>nul
if errorlevel 1 (
  echo [错误] 找不到 core 程序目录，请保留启动脚本和 core 的相对位置.
  pause
  exit /b 1
)
if not exist "spider.js" (
  echo [错误] 缺少 core\spider.js，请检查程序文件是否完整.
  goto :failed
)

if not exist "local-scanner.js" (
  echo [错误] 缺少 core\local-scanner.js，请检查程序文件是否完整.
  goto :failed
)

if not defined SCANNER_NODE_LIMIT set "SCANNER_NODE_LIMIT=12"
if not defined SCANNER_PER_IP_BUDGET set "SCANNER_PER_IP_BUDGET=130"
if not defined SCANNER_IP_NETWORK_RETRY set "SCANNER_IP_NETWORK_RETRY=1"
set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :node_error
"%NODE_EXE%" -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').close();" >nul 2>&1
if errorlevel 1 goto :node_error

echo ========================================
echo   红包蹲点 · 扫描器.
echo ========================================
echo.
echo   扫描 B 站直播间红包，写入 ../data/live-state.json
echo   需要先启动 Clash（代理端口 7890）.
echo.
echo   已有扫描器时继续使用现有实例，本窗口自动关闭.
echo   新启动的扫描器可按 Ctrl+C 停止.
echo.

"%NODE_EXE%" "local-scanner.js" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [错误] 扫描器退出，错误码 %EXIT_CODE%，请查看上方原因.
goto :finish

:node_error
echo [错误] 需要支持内置 SQLite 的 Node.js 24 或更高版本.
echo 请安装或升级 Node.js，然后重新打开本脚本.
:failed
set "EXIT_CODE=1"
:finish
popd
if "%EXIT_CODE%"=="0" exit /b 0
echo.
pause
exit /b %EXIT_CODE%
