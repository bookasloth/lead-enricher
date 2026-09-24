@echo off
REM Hourly cold-email batch (Windows Task Scheduler runs this, e.g. every hour 9-18).
REM Set SMTP creds + SEND=1 here (this .cmd is gitignored via *.log? no) OR in the
REM Task Scheduler action env. Without SEND=1 + creds it runs DRY.
cd /d "%~dp0"
REM --- fill these in, or set them as Task Scheduler environment variables ---
REM set SMTP_USER=team@timewheel.co.in
REM set SMTP_PASS=your-16-char-app-password
REM set SEND=1
echo ---- outreach run: %DATE% %TIME% ---- >> outreach.log
"C:\Program Files\nodejs\node.exe" gmaps/send-outreach.mjs >> outreach.log 2>&1
