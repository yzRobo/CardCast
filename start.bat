@echo off
title CardCast - TCG Streaming Overlay Tool
cls

echo =========================================
echo          CardCast v1.0.0
echo     TCG Streaming Overlay Tool
echo =========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    echo This may take a few minutes on first run.
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install dependencies!
        echo Please check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

:: Check if better-sqlite3 needs rebuild
if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
    echo Rebuilding native modules...
    call npm rebuild better-sqlite3
    echo.
)

:: Run system test
echo Running system check...
node scripts/test-setup.js
if %errorlevel% neq 0 (
    echo.
    echo ERROR: System check failed!
    echo Please fix the issues above and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo =========================================
echo Starting CardCast Server...
echo =========================================
echo.
echo Server will start on http://localhost:3888
echo Your browser will open automatically.
echo.
echo OBS Browser Source URLs:
echo   Main Overlay: http://localhost:3888/overlay
echo   Prize Cards:  http://localhost:3888/prizes
echo   Deck List:    http://localhost:3888/decklist
echo.
echo Press Ctrl+C to stop the server
echo =========================================
echo.

:: Start the server
node server.js

:: If we get here, the server has stopped
echo.
echo Server stopped.
pause