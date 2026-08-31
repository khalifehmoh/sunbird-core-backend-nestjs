@echo off
setlocal
cd /d "%~dp0.."
echo Installing dependencies, database, and starting the API...
call npm run setup:dev
exit /b %ERRORLEVEL%
