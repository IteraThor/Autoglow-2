@echo off
setlocal
cd /d "%~dp0"
title AutoGlow Setup
echo =============================================
echo       AutoGlow Setup for Windows
echo =============================================
echo.

:: AutoGlow is built from source with Rust (https://rustup.rs)
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust is not installed or not in PATH.
    echo Please install Rust from https://rustup.rs and run setup.bat again.
    pause
    exit /b 1
)

echo --^> Building AutoGlow (takes a few minutes the first time)...
cargo build --release
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] The build failed.
    pause
    exit /b 1
)
copy /y "%~dp0target\release\autoglow.exe" "%~dp0autoglow.exe" >nul

echo.
echo =============================================
echo       Setup Completed Successfully!
echo =============================================
echo.
echo To start AutoGlow:
echo   1. Double-click "run_autoglow.bat" to start the application.
echo   2. Open http://localhost:8080 in your browser to configure.
echo.
echo Autodarts game events come from the AutoGlow Bridge Chrome extension:
echo   1. In Chrome open chrome://extensions and switch on "Developer mode".
echo   2. Click "Load unpacked" and select this folder:
echo      %~dp0chrome_extension
echo   3. Play on https://play.autodarts.com - the extension icon shows ON when linked.
echo.
set /p choice="Would you like to start AutoGlow now? (Y/N): "
if /i "%choice%"=="Y" (
    echo --^> Starting AutoGlow...
    "%~dp0autoglow.exe"
)
