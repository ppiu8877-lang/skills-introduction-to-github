@echo off
setlocal
cd /d "%~dp0"
start "Poultry Store Server" /min cmd /c "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/"
endlocal
