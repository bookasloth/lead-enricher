@echo off
REM Launcher for the hourly home->cloud sync (Windows Task Scheduler runs this).
cd /d "%~dp0"
echo ---- sync run: %DATE% %TIME% ---- >> sync.log
"C:\Program Files\nodejs\node.exe" sync.mjs >> sync.log 2>&1
