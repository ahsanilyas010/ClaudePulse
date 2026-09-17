@echo off
rem Stops the background Claude Pulse server.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*claude-pulse*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped Claude Pulse (pid ' + $_.ProcessId + ')') }"
