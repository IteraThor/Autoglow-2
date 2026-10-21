@echo off
setlocal
cd /d "%~dp0"
title AutoGlow Launcher

if not exist "%~dp0venv\Scripts\activate.bat" (
    echo [ERROR] Virtual environment not found. Please run setup.bat first.
    pause
    exit /b 1
)

call "%~dp0venv\Scripts\activate.bat"
"%~dp0venv\Scripts\python.exe" "%~dp0server.py"
