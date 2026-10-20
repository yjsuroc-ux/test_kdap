@echo off
rem Start the server (default port 8000)
cd /d "%~dp0"
set "PY=python"
where py >nul 2>&1 && set "PY=py -3"
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
set PYTHONIOENCODING=utf-8
%PY% app.py
pause
