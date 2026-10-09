@echo off
setlocal
cd /d "%~dp0"
if exist "releases\Cocos Live Probe Inspector-win32-x64\Cocos Live Probe Inspector.exe" (
    start "" "releases\Cocos Live Probe Inspector-win32-x64\Cocos Live Probe Inspector.exe"
) else (
    call npm run runtime:probe:inspector
)
