// scripts/build-seed-db.js - Build the CardCast metadata seed database.
//
// Runs every wired game's full metadata download in seed mode (no image bytes)
// and writes one combined, compacted .db. That file ships as the GitHub Release
// asset (tag data-v1): fresh installs download it so they skip the live
// metadata-API calls. Images are NOT shipped - each user's lazy cache middleware
// fetches those on demand from the stored source_image_url.
//
// Usage:
//   node scripts/build-seed-db.js [outputPath]
// Default output: seed-build/cardcast.db
//
// This hits the live metadata APIs for ALL sets of every game, so it takes a
// while and needs a network connection. It is a maintainer tool; end users never
// run it. The output is gitignored (*.db); upload it to the Release manually.

const fs = require('fs');
const path = require('path');

const CardDatabase = require('../src/database');
const TCGApi = require('../src/tcg-api');
const { loadEnv, readJson, resolveApiKeys } = require('../src/config');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_GAMES = ['pokemon', 'magic', 'yugioh', 'lorcana', 'digimon', 'onepiece', 'gundam'];
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'seed-build', 'cardcast.db');

// Remove a database file and its WAL sidecars so we always start clean.
function removeDbFiles(dbPath) {
    for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
}

// Build the seed DB. Exported (and parameterized on games/setCount) so it can be
// exercised on a small scope by tests; the CLI calls it with the full defaults.
async function buildSeed(options = {}) {
    const outPath = path.resolve(options.outPath || DEFAULT_OUTPUT);
    const games = options.games || DEFAULT_GAMES;
    const setCount = options.setCount || 'all';
    const incremental = !!options.incremental;

    console.log('CardCast - Seed Database Builder');
    console.log('================================');
    console.log(`Output:    ${outPath}`);
    console.log(`Games:     ${games.join(', ')}`);
    console.log(`Set count: ${setCount}`);
    console.log(`Mode:      ${incremental ? 'incremental backfill (keep existing, add only missing sets)' : 'full rebuild (wipe + refetch all)'}\n`);

    // Full rebuild starts from a clean file. Incremental keeps the existing seed
    // and appends only sets not already present, so a rate-limited game can be
    // topped up by re-running without re-fetching what already landed.
    if (!incremental) {
        // Safety net: a full rebuild wipes the output, so preserve the previous
        // build as <out>.bak first. An accidental full run (e.g. an npm flag that
        // did not reach the script) can then always be undone.
        if (fs.existsSync(outPath)) {
            fs.copyFileSync(outPath, outPath + '.bak');
            console.log(`Backed up previous build to ${outPath}.bak\n`);
        }
        removeDbFiles(outPath);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    // Resolve optional API keys exactly like the server (env > config.local.json).
    loadEnv();
    const localConfig = readJson(path.join(PROJECT_ROOT, 'config.local.json'));
    const apiKeys = resolveApiKeys(localConfig);
    console.log(`Pokemon TCG API key: ${apiKeys.pokemonApiKey ? 'loaded' : 'not set (anonymous)'}\n`);

    const db = new CardDatabase(outPath);
    const api = new TCGApi(db, apiKeys);

    const summary = [];
    for (const game of games) {
        console.log(`\n=== ${game} ===`);
        let lastStatus = '';
        const progress = (p) => {
            if (p.status !== lastStatus) {
                lastStatus = p.status;
                console.log(`  [${p.percent}%] ${p.message}`);
            }
        };
        try {
            const count = await api.downloadGameData(game, progress, incremental, setCount, { skipImages: true });
            console.log(`  ${incremental ? 'added' : 'done'}: ${count} ${incremental ? 'new ' : ''}cards`);
            summary.push({ game, count });
        } catch (error) {
            console.error(`  FAILED: ${error.message}`);
            summary.push({ game, count: 0, error: error.message });
        }
    }

    // Fold the WAL into the main file, drop the WAL sidecars (switch to a rollback
    // journal), then compact so the shipped file is a single, minimal .db.
    console.log('\nFinalizing database (checkpoint + vacuum)...');
    db.db.pragma('wal_checkpoint(TRUNCATE)');
    db.db.pragma('journal_mode = DELETE');
    db.db.exec('VACUUM');
    db.close();

    const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log('\n================================');
    console.log('Seed build complete.');
    for (const s of summary) {
        console.log(`  ${s.game.padEnd(10)} ${String(s.count).padStart(7)} cards${s.error ? '  (ERROR: ' + s.error + ')' : ''}`);
    }
    console.log(`\nFile: ${outPath} (${sizeMb} MB)`);
    console.log('Upload this as the "cardcast.db" asset on the GitHub Release tagged data-v1.');

    return { outPath, summary };
}

// Parse CLI args: an optional positional output path (back-compat) plus flags:
//   --incremental            keep the existing seed, add only missing sets
//   --games=magic,pokemon    limit to specific games (default: all)
//   --out=path               output path (alternative to the positional arg)
//   --setCount=N             volume control passed through to each game
function parseArgs(argv) {
    const opts = {};
    for (const arg of argv) {
        if (arg === '--incremental') opts.incremental = true;
        else if (arg.startsWith('--games=')) opts.games = arg.slice(8).split(',').map(s => s.trim()).filter(Boolean);
        else if (arg.startsWith('--out=')) opts.outPath = arg.slice(6);
        else if (arg.startsWith('--setCount=')) opts.setCount = arg.slice(11);
        else if (!arg.startsWith('--')) opts.outPath = arg; // positional output path
    }
    return opts;
}

async function main() {
    await buildSeed(parseArgs(process.argv.slice(2)));
}

if (require.main === module) {
    main().catch(err => {
        console.error('Seed build failed:', err);
        process.exit(1);
    });
}

module.exports = { buildSeed, DEFAULT_GAMES, DEFAULT_OUTPUT };
