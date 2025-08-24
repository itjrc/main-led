@echo off
REM OBS Main LED - Batch Launcher
REM This batch file runs the PowerShell startup script

echo Starting OBS Main LED Application...
echo.

REM Check if PowerShell is available
powershell -Command "exit" >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: PowerShell is not available on this system.
    echo Please install PowerShell or run the application manually.
    pause
    exit /b 1
)

REM Run the PowerShell startup script
powershell -ExecutionPolicy Bypass -File "%~dp0start.ps1"

REM Check if the PowerShell script ran successfully
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to start the application.
    echo Check the console output above for error details.
    pause
    exit /b %errorlevel%
)

echo.
echo Application started successfully!