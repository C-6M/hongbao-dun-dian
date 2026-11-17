@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 红包蹲点 - 看板

pushd "%~dp0core" 2>nul
if errorlevel 1 (
  echo [错误] 找不到 core 程序目录，请保留启动脚本和 core 的相对位置.
  pause
  exit /b 1
)
if not exist "server.js" (
  echo [错误] 缺少 core\server.js，请检查程序文件是否完整.
  goto :failed
)

set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :node_error
"%NODE_EXE%" -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').close();" >nul 2>&1
if errorlevel 1 goto :node_error

echo ========================================
echo   红包蹲点 · 本地看板.
echo ========================================
echo.
echo   地址: http://127.0.0.1:8443/pool
echo.
echo   实时数据需要先启动 1-启动扫描器.bat
echo   服务就绪后会自动打开浏览器，重复启动直接打开现有看板.
echo   首次启动按 Ctrl+C 停止服务.
echo.

"%NODE_EXE%" "server.js" --port 8443 --open
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [错误] 看板退出，错误码 %EXIT_CODE%，请查看上方原因.
goto :finish

:node_error
echo [错误] 需要支持内置 SQLite 的 Node.js 24 或更高版本.
echo 请安装或升级 Node.js，然后重新打开本脚本.
:failed
set "EXIT_CODE=1"
:finish
popd
echo.
pause
exit /b %EXIT_CODE%
