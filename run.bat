@echo off
rem Starts the media library. First run: run.bat "D:\Videos"   Later runs: run.bat
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
)
rem Install the dependencies on the first run, and again whenever requirements.txt changes.
fc /b requirements.txt .venv\requirements.txt >nul 2>&1 || (
  .venv\Scripts\python -m pip install -r requirements.txt && copy /y requirements.txt .venv\requirements.txt >nul
)
if "%~1"=="" (
  .venv\Scripts\python -m medialib
) else (
  .venv\Scripts\python -m medialib --library "%~1" %2 %3 %4 %5
)
pause
