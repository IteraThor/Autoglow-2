@echo off
title AutoGlow Launcher
if not exist venv (
    echo [ERROR] Virtual environment not found. Please run setup.bat first.
    pause
    exit /b 1
)
call venv\Scripts\activate.bat
start pythonw autoglow_tray.py
