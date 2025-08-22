@echo off
title CardCast Development Server
cls

echo =========================================
echo     CardCast Development Server
echo =========================================
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    echo.
)

:: Check for updates
echo Checking for dependency updates...
call npm outdated
echo.

echo Starting development server with auto-restart...
echo.
echo Server: http://localhost:3888
echo.
echo Press Ctrl+C to stop
echo =========================================
echo.

:: Start with nodemon for auto-restart on file changes
call npm run dev