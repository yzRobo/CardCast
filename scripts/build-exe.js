// scripts/build-exe.js - CardCast Windows Executable Builder
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('CardCast - Windows Executable Builder');
console.log('========================================\n');

// Check if pkg is installed
try {
    execSync('pkg --version', { stdio: 'ignore' });
    console.log('✓ pkg is installed');
} catch (e) {
    console.log('Installing pkg globally...');
    try {
        execSync('npm install -g pkg', { stdio: 'inherit' });
        console.log('✓ pkg installed successfully');
    } catch (installError) {
        console.error('✗ Failed to install pkg. Please run: npm install -g pkg');
        process.exit(1);
    }
}

// Create necessary directories
const distDir = path.join(__dirname, '..', 'dist');
const dataDir = path.join(distDir, 'data');
const cacheDir = path.join(distDir, 'cache');

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

console.log('✓ Created dist directories');

// Update package.json for pkg
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Configure pkg for Windows only
packageJson.pkg = {
    assets: [
        "public/**/*",
        "src/**/*",
        "overlays/**/*",
        "index.html"
    ],
    targets: ["node18-win-x64"],
    outputPath: "dist",
    compress: "GZip"
};

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
console.log('✓ Updated package.json configuration');

// Build Windows executable
console.log('\nBuilding Windows executable...');
console.log('This may take a few minutes...\n');

try {
    const outputName = 'CardCast.exe';
    
    execSync(`pkg . --targets node18-win-x64 --output dist/${outputName} --compress GZip`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..')
    });
    
    console.log('\n✓ Build successful!');
    console.log(`Executable created: dist\\${outputName}`);
    console.log(`Size: ${(fs.statSync(path.join(distDir, outputName)).size / 1024 / 1024).toFixed(1)} MB`);
    
} catch (buildError) {
    console.error('\n✗ Build failed:', buildError.message);
    console.log('\nTroubleshooting:');
    console.log('1. Make sure all node_modules are installed: npm install');
    console.log('2. Try building with verbose output: pkg . --debug');
    console.log('3. Check if antivirus is blocking the build process');
    process.exit(1);
}

// Create default config file
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

fs.writeFileSync(
    path.join(distDir, 'config.json'),
    JSON.stringify(defaultConfig, null, 2)
);
console.log('✓ Created default config.json');

// Create README for distribution
const readmeContent = `CardCast - Streaming Overlay Tool for TCGs
==========================================

QUICK START
-----------
1. Double-click CardCast.exe
2. Your browser will open to http://localhost:3888
3. Select your TCG and download card data
4. Add browser sources to OBS

FILE STRUCTURE
--------------
CardCast.exe - Main application
config.json - Settings (edit if port 3888 is in use)
data/ - Card databases (downloaded through app)
cache/ - Card images (cached as you search)

OBS SETUP
---------
Add these browser sources to OBS:
- Main Overlay: http://localhost:3888/overlay
- Prize Cards: http://localhost:3889/prizes
- Deck List: http://localhost:3890/decklist

Browser source settings:
- Width: 1920
- Height: 1080
- FPS: 30

FIRST TIME SETUP
----------------
1. Launch CardCast.exe
2. Click "Download Card Data"
3. Select your TCG (Pokemon, Magic, Yu-Gi-Oh, etc.)
4. Wait for download (5-10 minutes depending on game)
5. Cards are now searchable offline

KEYBOARD SHORTCUTS
------------------
Ctrl+F - Focus search box
Ctrl+1-5 - Quick select recent cards
Ctrl+D - Toggle dark/light mode
Escape - Clear current selection

TROUBLESHOOTING
---------------
- Port already in use: Edit config.json and change port number
- OBS not showing cards: Check Windows Firewall settings
- Cards not loading: Re-download data for that game
- Antivirus warning: This is normal for unsigned exe files

CLOSING THE APP
---------------
Close the console window to stop CardCast

SUPPORT
-------
Report issues at: https://github.com/yourusername/cardcast`;

fs.writeFileSync(path.join(distDir, 'README.txt'), readmeContent);
console.log('✓ Created README.txt');

// Create sample overlay HTML files
const overlayHTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>CardCast Overlay</title>
    <style>
        body { margin: 0; background: transparent; }
        #overlay { width: 1920px; height: 1080px; }
    </style>
</head>
<body>
    <div id="overlay"></div>
    <script src="/overlay.js"></script>
</body>
</html>`;

fs.writeFileSync(path.join(distDir, 'overlay.html'), overlayHTML);
console.log('✓ Created overlay template');

console.log('\n========================================');
console.log('Build complete!');
console.log('\nDist folder contents:');
console.log('  - CardCast.exe (double-click to run)');
console.log('  - config.json (settings)');
console.log('  - data/ (card databases)');
console.log('  - cache/ (card images)');
console.log('  - overlay.html (OBS template)');
console.log('  - README.txt (instructions)');
console.log('\nTo distribute: ZIP the entire dist folder');
console.log('Users just extract and run CardCast.exe');
console.log('========================================');