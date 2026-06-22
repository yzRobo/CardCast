#!/usr/bin/env node
// scripts/test-setup.js
// CardCast system check. Verifies the environment is ready to run the server:
//   - Node version is in the supported range
//   - The better-sqlite3 native module actually loads (the #1 failure on new Node)
//   - Required files/folders are present
// Exits 0 when everything critical passes, 1 otherwise. Called by `npm test`,
// `npm run setup`, and start.bat before launching the server.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OK = '[ OK ]';
const WARN = '[WARN]';
const FAIL = '[FAIL]';

let failures = 0;
let warnings = 0;

function ok(msg) { console.log(`${OK} ${msg}`); }
function warn(msg) { console.log(`${WARN} ${msg}`); warnings++; }
function fail(msg) { console.log(`${FAIL} ${msg}`); failures++; }

console.log('=========================================');
console.log('         CardCast - System Check');
console.log('=========================================\n');

// --- Node version -----------------------------------------------------------
// better-sqlite3's prebuilt binary must match the running Node ABI. This project
// targets Node 22+ (see .nvmrc / package.json "engines").
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) {
  ok(`Node ${process.versions.node} (supported)`);
} else {
  warn(`Node ${process.versions.node} is below the supported minimum (Node 22+).`);
  console.log('       Use Node 22 or newer, e.g. with nvm:  nvm use 22');
  console.log('       (better-sqlite3 ships prebuilt binaries for Node 22, 24, 25, 26)');
}

// --- Required files ---------------------------------------------------------
const requiredFiles = [
  'server.js',
  'config.json',
  'index.html',
  'pokemon-match-control.html',
  'mtg-match-control.html',
  path.join('public', 'css', 'style.css'),
  path.join('src', 'database.js'),
];
for (const rel of requiredFiles) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    ok(`Found ${rel}`);
  } else if (rel === path.join('public', 'css', 'style.css')) {
    fail(`Missing ${rel} - run "npm run build-css-prod" to compile the stylesheet`);
  } else {
    fail(`Missing ${rel}`);
  }
}

// --- Writable runtime folders (created on first run if absent) ---------------
for (const dir of ['data', 'cache']) {
  const abs = path.join(ROOT, dir);
  try {
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    fs.accessSync(abs, fs.constants.W_OK);
    ok(`Folder "${dir}/" is writable`);
  } catch (err) {
    fail(`Folder "${dir}/" is not writable: ${err.message}`);
  }
}

// --- Native module: better-sqlite3 (the critical check) ---------------------
try {
  const DatabaseCtor = require('better-sqlite3');
  const db = new DatabaseCtor(':memory:');
  db.exec('CREATE TABLE _check (id INTEGER)');
  db.prepare('INSERT INTO _check (id) VALUES (?)').run(1);
  const row = db.prepare('SELECT id FROM _check').get();
  db.close();
  if (row && row.id === 1) {
    ok('better-sqlite3 native module loads and runs');
  } else {
    fail('better-sqlite3 loaded but returned an unexpected result');
  }
} catch (err) {
  fail('better-sqlite3 failed to load (native module not built for this Node)');
  console.log('       ' + (err.message || err).toString().split('\n')[0]);
  console.log('       Fix: use Node 22+ (nvm use 22), then run:  npm install better-sqlite3');
}

// --- Summary ----------------------------------------------------------------
console.log('\n-----------------------------------------');
if (failures === 0) {
  console.log(`System check passed${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}.`);
  console.log('Start the server with:  npm start');
  process.exit(0);
} else {
  console.log(`System check FAILED: ${failures} problem${failures > 1 ? 's' : ''} found above.`);
  process.exit(1);
}
