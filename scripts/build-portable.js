// scripts/build-portable.js - CardCast Portable Build Script
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('CardCast - Portable Build Script');
console.log('========================================\n');

// Create dist directory
const distDir = path.join(__dirname, '..', 'dist-portable');
const projectRoot = path.join(__dirname, '..');

// Clean and create dist directory
if (fs.existsSync(distDir)) {
    console.log('Cleaning existing dist-portable directory...');
    fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

console.log('✓ Created dist-portable directory\n');

// Function to copy directory recursively
function copyDir(src, dest, exclude = []) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (let entry of entries) {
        // Skip excluded items
        if (exclude.includes(entry.name)) continue;
        
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Copy all necessary files
console.log('Copying project files...');

// Copy main files
const mainFiles = [
    'server.js',
    'index.html',
    'package.json'
];

mainFiles.forEach(file => {
    const srcPath = path.join(projectRoot, file);
    const destPath = path.join(distDir, file);
    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`✓ Copied ${file}`);
    }
});

// Create or copy config.json
const configPath = path.join(projectRoot, 'config.json');
const configDestPath = path.join(distDir, 'config.json');
if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, configDestPath);
    console.log('✓ Copied config.json');
} else {
    // Create default config
    const defaultConfig = {
        port: 3888,
        theme: 'dark',
        autoUpdate: true,
        games: {
            pokemon: { enabled: true, dataPath: null },
            magic: { enabled: true, dataPath: null },
            yugioh: { enabled: true, dataPath: null },
            lorcana: { enabled: true, dataPath: null },
            onepiece: { enabled: true, dataPath: null },
            digimon: { enabled: false, dataPath: null },
            fab: { enabled: false, dataPath: null },
            starwars: { enabled: false, dataPath: null }
        },
        obs: {
            mainOverlayPort: 3888,
            prizeOverlayPort: 3889,
            decklistPort: 3890
        }
    };
    fs.writeFileSync(configDestPath, JSON.stringify(defaultConfig, null, 2));
    console.log('✓ Created default config.json');
}

// Copy directories
const directories = [
    { name: 'src', exclude: [] },
    { name: 'public', exclude: [] },
    { name: 'overlays', exclude: [] },
    { name: 'scripts', exclude: [] }
];

directories.forEach(dir => {
    const srcPath = path.join(projectRoot, dir.name);
    const destPath = path.join(distDir, dir.name);
    if (fs.existsSync(srcPath)) {
        copyDir(srcPath, destPath, dir.exclude);
        console.log(`✓ Copied ${dir.name}/`);
    }
});

// Create necessary empty directories
const emptyDirs = ['data', 'cache'];
emptyDirs.forEach(dir => {
    const dirPath = path.join(distDir, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`✓ Created ${dir}/`);
});

// Create the portable Node.js launcher (primary)
const portableBatchContent = `@echo off
setlocal enabledelayedexpansion
title CardCast - TCG Streaming Overlay Tool
cd /d "%~dp0"
cls

echo =========================================
echo          CardCast v1.0.0
echo     TCG Streaming Overlay Tool
echo =========================================
echo.

:: Set paths
set "NODE_DIR=%~dp0node-portable"
set "NODE_EXE=%NODE_DIR%\\node.exe"
set "NPM_CMD=%NODE_DIR%\\npm.cmd"
set "PATH=%NODE_DIR%;%PATH%"

:: Check if portable Node.js exists
if exist "%NODE_EXE%" (
    echo Using portable Node.js installation...
    goto :NodeReady
)

:: Check if system Node.js is installed
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo Using system Node.js installation...
    set "NODE_EXE=node"
    set "NPM_CMD=npm"
    goto :NodeReady
)

:: No Node.js found - download portable version
echo Node.js is not installed.
echo.
echo CardCast will download a portable version of Node.js.
echo This won't affect your system and requires no admin rights.
echo.
echo Download size: ~30MB
echo.
set /p DOWNLOAD_CHOICE="Download portable Node.js? (Y/N): "

if /i "%DOWNLOAD_CHOICE%" neq "Y" (
    echo.
    echo Download cancelled.
    echo.
    echo To run CardCast, either:
    echo 1. Run this script again and choose Y
    echo 2. Install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Download portable Node.js
echo.
echo Downloading portable Node.js...
echo Please wait, this may take a minute...
echo.

:: Create temp directory
if not exist "%NODE_DIR%" mkdir "%NODE_DIR%"

:: Node.js portable version URL
set "NODE_VERSION=20.11.0"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"

:: Download using PowerShell
echo Downloading from nodejs.org...
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Write-Host 'Downloading Node.js portable...'; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%TEMP%\\node-portable.zip' -UseBasicParsing; Write-Host 'Download complete!' } catch { Write-Host 'Download failed: ' $_.Exception.Message -ForegroundColor Red; exit 1 }}"

if not exist "%TEMP%\\node-portable.zip" (
    echo.
    echo ERROR: Failed to download Node.js.
    echo Please check your internet connection and try again.
    echo.
    rmdir /s /q "%NODE_DIR%" 2>nul
    pause
    exit /b 1
)

:: Extract using PowerShell
echo.
echo Extracting Node.js...
powershell -Command "& {try { Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('%TEMP%\\node-portable.zip', '%TEMP%'); Write-Host 'Extraction complete!' } catch { Write-Host 'Extraction failed: ' $_.Exception.Message -ForegroundColor Red; exit 1 }}"

:: Move files to final location
echo Setting up portable Node.js...
xcopy /E /I /Q /Y "%TEMP%\\node-v%NODE_VERSION%-win-x64\\*" "%NODE_DIR%\\" >nul 2>&1

:: Clean up temp files
del "%TEMP%\\node-portable.zip" 2>nul
rmdir /s /q "%TEMP%\\node-v%NODE_VERSION%-win-x64" 2>nul

:: Verify installation
if not exist "%NODE_EXE%" (
    echo.
    echo ERROR: Failed to set up portable Node.js.
    echo Please try again or install Node.js manually.
    echo.
    rmdir /s /q "%NODE_DIR%" 2>nul
    pause
    exit /b 1
)

echo.
echo ✓ Portable Node.js installed successfully!
echo.

:NodeReady
:: Display Node version
for /f "tokens=*" %%i in ('"%NODE_EXE%" --version 2^>nul') do set NODE_VERSION=%%i
echo Node.js version: %NODE_VERSION%

:: Check if node_modules exists
if not exist "node_modules\\" (
    echo.
    echo First time setup - Installing CardCast dependencies...
    echo This will take 2-3 minutes...
    echo.
    
    call "%NPM_CMD%" install --production
    
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: Failed to install dependencies!
        echo Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    
    echo.
    echo ✓ Dependencies installed successfully!
)

:: Check for better-sqlite3 build
if not exist "node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node" (
    echo.
    echo Building database module...
    call "%NPM_CMD%" rebuild better-sqlite3 2>nul
    echo ✓ Database module ready!
)

:: Create directories if needed
if not exist "data" mkdir "data"
if not exist "cache" mkdir "cache"

echo.
echo =========================================
echo Starting CardCast server...
echo.
echo Browser will open to: http://localhost:3888
echo To stop: Close this window or press Ctrl+C
echo =========================================
echo.

:: Start the server
"%NODE_EXE%" server.js

:: If we get here, server stopped
echo.
echo Server stopped.
pause`;

fs.writeFileSync(path.join(distDir, 'CardCast.bat'), portableBatchContent);
console.log('\n✓ Created CardCast.bat launcher (with auto-download)');

// Create Node.js installer download helper
const nodeInstallerHelper = `@echo off
title Download Node.js
cls

echo =========================================
echo     Download Node.js for CardCast
echo =========================================
echo.
echo CardCast requires Node.js to run.
echo.
echo This will open the Node.js download page.
echo Please download and install the LTS version.
echo.
pause

start https://nodejs.org/

echo.
echo After installing Node.js:
echo 1. Close this window
echo 2. Run CardCast.bat
echo.
pause`;

fs.writeFileSync(path.join(distDir, 'GET-NODEJS.bat'), nodeInstallerHelper);
console.log('✓ Created GET-NODEJS.bat (Node.js download helper)');

// Create README
const readmeContent = `CardCast - Streaming Overlay Tool for TCGs
==========================================

QUICK START
-----------
1. Make sure Node.js is installed (run GET-NODEJS.bat if needed)
2. Double-click CardCast.bat
3. On first run, it will install dependencies (2-3 minutes)
4. Browser opens to http://localhost:3888
5. Download card data for your games
6. Add OBS browser sources

REQUIREMENTS
------------
- Windows 10 or later
- Node.js 16 or later (https://nodejs.org/)
- Internet connection (for downloading card data)

OBS BROWSER SOURCES
-------------------
Add these URLs as browser sources in OBS:
- Main Overlay: http://localhost:3888/overlay
- Prize Cards: http://localhost:3888/prizes
- Deck List: http://localhost:3888/decklist

Settings: 1920x1080, 30 FPS

FILES IN THIS PACKAGE
---------------------
CardCast.bat - Main launcher (use this!)
GET-NODEJS.bat - Downloads Node.js if needed
server.js - Application server
config.json - Settings (edit to change port)
src/ - Source code
public/ - Web interface
overlays/ - OBS overlay files
data/ - Card databases (created on use)
cache/ - Card images (created on use)

FIRST TIME SETUP
----------------
1. Run CardCast.bat
2. Wait for dependencies to install (one-time only)
3. Select your TCG game
4. Click "Download Card Data"
5. Wait for download to complete
6. Cards are now searchable offline!

TROUBLESHOOTING
---------------
"Node.js is not installed":
- Run GET-NODEJS.bat to download Node.js
- Install the LTS version
- Try CardCast.bat again

"Port 3888 already in use":
- Edit config.json
- Change "port": 3888 to another number (e.g., 3889)
- Run CardCast.bat again

OBS not showing cards:
- Check the browser source URL is correct
- Try refreshing the browser source
- Make sure CardCast is running

Can't download cards:
- Check your internet connection
- Try a different game
- Check Windows Firewall settings

UNINSTALLING
------------
Simply delete this folder. No registry entries are created.

DISTRIBUTION
------------
To share CardCast with others:
1. ZIP this entire folder
2. Share the ZIP file
3. Users extract and run CardCast.bat

SUPPORT
-------
Report issues at: https://github.com/yzRobo/CardCast

VERSION
-------
CardCast v1.0.0 - Portable Edition`;

fs.writeFileSync(path.join(distDir, 'README.txt'), readmeContent);
console.log('✓ Created README.txt');

// Create a simple package.json for production
const prodPackageJson = {
    name: "cardcast",
    version: "1.0.0",
    description: "Streaming overlay tool for TCG content creators",
    main: "server.js",
    scripts: {
        start: "node server.js"
    },
    dependencies: {
        "axios": "0.27.2",
        "better-sqlite3": "^9.2.2",
        "cheerio": "^1.0.0-rc.12",
        "express": "^4.18.2",
        "socket.io": "^4.6.0"
    },
    engines: {
        node: ">=14.0.0"
    }
};

fs.writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify(prodPackageJson, null, 2)
);
console.log('✓ Created production package.json');

console.log('\n========================================');
console.log('✅ Portable build complete!');
console.log('\nCreated in: dist-portable/');
console.log('\nWhat to do next:');
console.log('1. Test it: Go to dist-portable and run CardCast.bat');
console.log('2. Distribute: ZIP the entire dist-portable folder');
console.log('3. Users: Extract ZIP and run CardCast.bat');
console.log('\nAdvantages:');
console.log('- No pkg compatibility issues');
console.log('- Works with all Node.js modules');
console.log('- Easy to debug if issues arise');
console.log('- Smaller distribution size (~10MB without node_modules)');
console.log('\nNote: Users need Node.js installed (most streamers have it)');
console.log('========================================');