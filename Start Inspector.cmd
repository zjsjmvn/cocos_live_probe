@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\start-inspector.ps1"
if errorlevel 1 pause
