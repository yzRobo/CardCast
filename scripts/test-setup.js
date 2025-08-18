// scripts/test-setup.js - CardCast System Test
const fs = require('fs');
const path = require('path');

console.log('CardCast System Test');
console.log('====================\n');

// Check required directories
const dirs = [
    'data',
    'cache',
    'public',
    'public/css',
    'public/js',
    'overlays',
    'src'
];

console.log('Checking directories...');
dirs.forEach(dir => {
    const dirPath = path.join(__dirname, '..', dir);
    if (!fs.existsSync(dirPath)) {
        console.log(`✗ Missing: ${dir} - Creating...`);
        fs.mkdirSync(dirPath, { recursive: true });
    } else {
        console.log(`✓ Found: ${dir}`);
    }
});

// Check required files
console.log('\nChecking required files...');
const files = [
    'server.js',
    'index.html',
    'package.json',
    'config.json',
    'src/database.js',
    'src/tcg-api.js',
    'src/overlay-server.js',
    'overlays/main.html',
    'overlays/prizes.html',
    'overlays/decklist.html'
];

let allFilesExist = true;
files.forEach(file => {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) {
        console.log(`✗ Missing: ${file}`);
        allFilesExist = false;
    } else {
        console.log(`✓ Found: ${file}`);
    }
});

// Check Node modules
console.log('\nChecking Node modules...');
const requiredModules = [
    'express',
    'socket.io',
    'better-sqlite3',
    'axios',
    'cheerio'
];

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
let allModulesInstalled = true;

requiredModules.forEach(module => {
    const modulePath = path.join(__dirname, '..', 'node_modules', module);
    if (!fs.existsSync(modulePath)) {
        console.log(`✗ Missing module: ${module}`);
        allModulesInstalled = false;
    } else {
        console.log(`✓ Installed: ${module}`);
    }
});

// Test database connection
console.log('\nTesting database...');
try {
    const Database = require('../src/database');
    const db = new Database();
    console.log('✓ Database initialized successfully');
    
    // Test a simple query
    const games = ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece'];
    games.forEach(game => {
        const hasData = db.hasGameData(game);
        console.log(`  ${game}: ${hasData ? 'Has data' : 'No data'}`);
    });
    
    db.close();
} catch (error) {
    console.log('✗ Database error:', error.message);
}

// Generate test results
console.log('\n====================');
console.log('Test Results:');
console.log('====================');

if (!allFilesExist) {
    console.log('✗ Some files are missing. Please ensure all files are created.');
} else {
    console.log('✓ All required files found');
}

if (!allModulesInstalled) {
    console.log('✗ Some Node modules are missing. Run: npm install');
} else {
    console.log('✓ All Node modules installed');
}

if (allFilesExist && allModulesInstalled) {
    console.log('\n✓ System ready! You can start the server with: npm start');
    console.log('  or for development: npm run dev');
} else {
    console.log('\n✗ Please fix the issues above before starting the server.');
    process.exit(1);
}

// Test server startup (without actually starting it)
console.log('\nTesting server initialization...');
try {
    // Just require the server to check for syntax errors
    require('../server.js');
    console.log('✓ Server code validated');
} catch (error) {
    if (error.code === 'EADDRINUSE') {
        console.log('✓ Server code validated (port already in use)');
    } else if (error.message.includes('listen')) {
        console.log('✓ Server code validated');
    } else {
        console.log('✗ Server error:', error.message);
    }
}

console.log('\n====================');
console.log('Setup Complete!');
console.log('====================');
console.log('\nNext steps:');
console.log('1. Start the server: npm start');
console.log('2. Open browser to: http://localhost:3888');
console.log('3. Select a game and click "Download" to fetch card data');
console.log('4. Add OBS browser sources for the overlays');
console.log('\nOBS Browser Source URLs:');
console.log('  Main Overlay: http://localhost:3888/overlay');
console.log('  Prize Cards:  http://localhost:3888/prizes');
console.log('  Deck List:    http://localhost:3888/decklist');