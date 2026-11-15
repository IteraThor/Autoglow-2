@echo off
setlocal
cd /d "%~dp0"
title AutoGlow

if not exist "%~dp0autoglow.exe" (
    echo [ERROR] AutoGlow is not built yet. Please run setup.bat first.
    pause
    exit /b 1
)

"%~dp0autoglow.exe"
