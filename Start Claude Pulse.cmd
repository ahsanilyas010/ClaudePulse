@echo off
rem Starts the Claude Pulse server in the background (if not already running) and opens the widget window.
setlocal
set "HERE=%~dp0"
set "URL=http://localhost:4319"

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%/api/state' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process node -ArgumentList '\"%HERE%server.js\"' -WindowStyle Hidden"
  powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%/api/state' | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }"
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --window-size=480,860
) else (
  start "" %URL%
)
endlocal
