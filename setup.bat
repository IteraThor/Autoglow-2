@echo off
title AutoGlow Setup
echo =============================================
echo       AutoGlow Setup for Windows            
echo =============================================
echo.

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.9+ from https://www.python.org/ and check "Add Python to PATH".
    pause
    exit /b 1
)

:: Create virtual environment
if not exist venv (
    echo --> Creating Python virtual environment...
    python -m venv venv
) else (
    echo --> Virtual environment already exists.
)

:: Activate venv and install requirements
echo --> Activating environment and installing requirements...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt

echo.
echo =============================================
echo       Setup Completed Successfully!          
echo =============================================
echo.
echo To start AutoGlow:
echo   1. Double-click "run_autoglow.bat" to start the tray application.
echo   2. Or open http://localhost:8080 in your browser to configure.
echo.
set /p choice="Would you like to start AutoGlow now? (Y/N): "
if /i "%choice%"=="Y" (
    echo --> Starting AutoGlow...
    start pythonw autoglow_tray.py
)
