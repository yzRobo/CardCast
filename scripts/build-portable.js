// scripts/build-portable.js - CardCast Portable Build Script
const fs = require('fs');
const path = require('path');

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

// Copy main files - INCLUDING pokemon-match-control.html
const mainFiles = [
    'server.js',
    'index.html',
    'pokemon-match-control.html',  // ADD THIS FILE
    'package.json'
];

mainFiles.forEach(file => {
    const srcPath = path.join(projectRoot, file);
    const destPath = path.join(distDir, file);
    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`✓ Copied ${file}`);
    } else if (file === 'pokemon-match-control.html') {
        // Create a redirect file if it doesn't exist
        const redirectContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Pokemon Match Control - CardCast</title>
    <script>
        // Redirect to the main interface with Pokemon Match tab
        window.location.href = '/#pokemon-match';
    </script>
</head>
<body>
    <p>Redirecting to Pokemon Match Control...</p>
</body>
</html>`;
        fs.writeFileSync(destPath, redirectContent);
        console.log(`✓ Created ${file} (redirect)`);
    }
});

// Create or copy config.json
const configPath = path.join(projectRoot, 'config.json');
const configDestPath = path.join(distDir, 'config.json');
if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, configDestPath);
    console.log('✓ Copied config.json');
} else {
    // Create default config with correct settings
    const defaultConfig = {
        port: 3888,
        theme: 'dark',
        autoUpdate: true,
        games: {
            pokemon: { enabled: true, available: true, dataPath: null },
            magic: { enabled: false, available: false, dataPath: null },
            yugioh: { enabled: false, available: false, dataPath: null },
            lorcana: { enabled: false, available: false, dataPath: null },
            onepiece: { enabled: false, available: false, dataPath: null },
            digimon: { enabled: false, available: false, dataPath: null },
            fab: { enabled: false, available: false, dataPath: null },
            starwars: { enabled: false, available: false, dataPath: null }
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

// IMPORTANT: Ensure node_modules is NOT included
console.log('✗ Excluding node_modules (will be installed fresh on each machine)');

// Create the WORKING portable Node.js launcher that uses Node 16
const portableBatchContent = `@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
cls

echo =========================================
echo             CardCast
echo     TCG Streaming Overlay Tool
echo =========================================
echo.

:: Download Node.js if needed
if not exist "node-portable\\node.exe" (
    echo Setting up CardCast for first time use...
    echo This is a one-time setup that takes about 2-3 minutes.
    echo.
    
    mkdir node-portable 2>nul
    
    echo Downloading Node.js runtime...
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v16.20.2/node-v16.20.2-win-x64.zip' -OutFile '%TEMP%\\node.zip'"
    
    if not exist "%TEMP%\\node.zip" (
        echo.
        echo ERROR: Failed to download Node.js. Please check your internet connection.
        echo.
        pause
        exit /b 1
    )
    
    echo Extracting files...
    powershell -Command "Expand-Archive -Path '%TEMP%\\node.zip' -DestinationPath '%TEMP%' -Force"
    
    xcopy /E /I /Q /Y "%TEMP%\\node-v16.20.2-win-x64\\*" "node-portable\\" >nul
    
    del "%TEMP%\\node.zip" 2>nul
    rmdir /s /q "%TEMP%\\node-v16.20.2-win-x64" 2>nul
    
    echo Runtime installed successfully!
    echo.
)

:: Install dependencies if needed
if not exist "node_modules\\" (
    echo Installing CardCast components...
    echo This only happens on first run...
    echo.
    
    :: CRITICAL: Set PATH to use ONLY our portable Node.js
    set "PATH=%~dp0node-portable;%~dp0node-portable\\node_modules\\npm\\bin"
    set "NODE_PATH=%~dp0node-portable\\node_modules"
    
    :: Use better-sqlite3 v7 which has proper Node 16 support
    call "%~dp0node-portable\\npm.cmd" install axios@0.27.2 better-sqlite3@7.6.2 cheerio@1.0.0-rc.10 express@4.18.2 socket.io@4.5.4 --loglevel=error
    
    if !errorlevel! neq 0 (
        echo.
        echo ERROR: Failed to install components.
        echo Please check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    
    echo.
    echo ✓ CardCast is ready to use!
    echo.
)

:: Create required directories
if not exist "data" mkdir "data" 2>nul
if not exist "cache" mkdir "cache" 2>nul

:: Start the server
echo =========================================
echo Starting CardCast server...
echo.
echo Your browser will open automatically.
echo To stop CardCast: Close this window
echo =========================================
echo.

:: Open browser after a short delay
start /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3888"

:: Run the server
node-portable\\node.exe server.js

:: If we get here, server was stopped
echo.
echo CardCast has been stopped.
pause`;

fs.writeFileSync(path.join(distDir, 'CardCast.bat'), portableBatchContent);
console.log('\n✓ Created CardCast.bat launcher (FORCE DELETE AND REBUILD)');

// Create README
const readmeContent = `CardCast - Streaming Overlay Tool for TCGs
==========================================

QUICK START
-----------
1. Double-click CardCast.bat
2. Wait for automatic setup (first run only, 2-3 minutes)
3. Browser opens automatically to http://localhost:3888
4. Download Pokemon card data (20,000+ cards)
5. Add OBS browser sources for overlays

REQUIREMENTS
------------
- Windows 10 or later
- Internet connection (for first-time setup and card downloads)
- 2GB free disk space (for card data and images)

OBS BROWSER SOURCES
-------------------
Add these URLs as browser sources in OBS:
- Main Overlay: http://localhost:3888/overlay
- Prize Cards: http://localhost:3888/prizes
- Deck List: http://localhost:3888/decklist
- Pokemon Match: http://localhost:3888/pokemon-match

Settings: 1920x1080, 30 FPS

FILES IN THIS PACKAGE
---------------------
CardCast.bat - Main launcher (use this!)
server.js - Application server
config.json - Settings (edit to change port)
pokemon-match-control.html - Match control interface
src/ - Source code
public/ - Web interface
overlays/ - OBS overlay files
data/ - Card databases (created on use)
cache/ - Card images (created on use)

FIRST TIME SETUP
----------------
1. Run CardCast.bat
2. Wait for automatic setup (installs Node.js and dependencies)
3. Browser opens automatically
4. Select Pokemon TCG
5. Click "Download Card Data"
6. Wait for download to complete (20,000+ cards)
7. Cards are now searchable offline!

TROUBLESHOOTING
---------------
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
- Check Windows Firewall settings
- Try running as Administrator

UNINSTALLING
------------
Simply delete this folder. No registry entries are created.

SUPPORT
-------
Report issues at: https://github.com/yzRobo/CardCast

VERSION
-------
CardCast v1.0.0 - Portable Edition
Built with Node.js 16 for maximum compatibility`;

fs.writeFileSync(path.join(distDir, 'README.txt'), readmeContent);
console.log('✓ Created README.txt');

// Create a COMPATIBLE package.json for Node 16
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
        "better-sqlite3": "8.0.1",  // Version 8.0.1 has Node 16 prebuilts
        "cheerio": "1.0.0-rc.10",
        "express": "4.18.2",
        "socket.io": "4.5.4"
    },
    engines: {
        node: ">=16.0.0"
    }
};

fs.writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify(prodPackageJson, null, 2)
);
console.log('✓ Created production package.json (Node 16 compatible)');

console.log('\n========================================');
console.log('✅ Portable build complete!');
console.log('\nCreated in: dist-portable/');
console.log('\nWhat to do next:');
console.log('1. Test it: Go to dist-portable and run CardCast.bat');
console.log('2. Distribute: ZIP the entire dist-portable folder');
console.log('3. Users: Extract ZIP and run CardCast.bat');
console.log('\nKey improvements in this build:');
console.log('- Uses Node 16 for better-sqlite3 compatibility');
console.log('- Includes pokemon-match-control.html');
console.log('- Compatible package versions');
console.log('- Auto-downloads and sets up everything');
console.log('- No admin rights required');
console.log('========================================');