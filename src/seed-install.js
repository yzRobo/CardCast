// src/seed-install.js - First-run install of the metadata seed database.
//
// On a fresh install (no data/cardcast.db yet) we try to download a pre-built
// metadata seed from the project's GitHub Release (tag data-v1) so the user skips
// the live metadata-API downloads. Image bytes are never shipped; the lazy cache
// middleware fetches those per-user on demand from each card's source_image_url.
// If the asset is unreachable we simply continue with an empty database and the
// normal live Download/Update flow still works.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_SEED_URL =
    'https://github.com/yzRobo/CardCast/releases/download/data-v1/cardcast.db';

// A real SQLite database begins with the 16-byte header "SQLite format 3\0".
// Checking it guards against saving an HTML error page (e.g. a 404) as the DB.
function isSqliteFile(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(16);
        fs.readSync(fd, buf, 0, 16, 0);
        fs.closeSync(fd);
        return buf.toString('utf8', 0, 15) === 'SQLite format 3';
    } catch (e) {
        return false;
    }
}

// Ensure a database exists at dbPath, downloading the seed if it does not.
// Returns { installed, reason?, error? }. Never throws: a failed/absent seed is
// a soft outcome so the caller can fall back to an empty DB + live downloads.
async function ensureSeedDatabase(options = {}) {
    const dbPath = options.dbPath;
    const seedUrl = options.seedUrl || DEFAULT_SEED_URL;

    if (!dbPath) {
        return { installed: false, reason: 'no-db-path' };
    }

    // The absence of the DB file is our fresh-install marker.
    if (fs.existsSync(dbPath)) {
        return { installed: false, reason: 'exists' };
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tmpPath = `${dbPath}.download`;

    // No-fetch path: if a bundled seed file is provided and valid (the desktop app
    // ships the seed inside its package), copy it into place instead of downloading.
    const bundledSeedPath = options.bundledSeedPath;
    if (bundledSeedPath && fs.existsSync(bundledSeedPath)) {
        try {
            if (!isSqliteFile(bundledSeedPath)) {
                console.warn('Bundled seed is not a valid SQLite database; will try downloading.');
            } else {
                fs.copyFileSync(bundledSeedPath, tmpPath);
                fs.renameSync(tmpPath, dbPath);
                const sizeMb = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
                console.log(`Metadata seed installed from bundle (${sizeMb} MB). Card images download on demand.`);
                return { installed: true, reason: 'copied' };
            }
        } catch (error) {
            if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
            console.warn(`Could not copy bundled seed (${error.message}); will try downloading.`);
        }
    }

    try {
        console.log(`No database found. Downloading metadata seed from ${seedUrl} ...`);
        const response = await axios.get(seedUrl, {
            responseType: 'stream',
            timeout: 60000,
            maxRedirects: 5, // GitHub release downloads redirect to a signed CDN URL
            headers: { 'User-Agent': 'CardCast/1.0.0' }
        });

        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmpPath);
            response.data.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            response.data.on('error', reject);
        });

        // Sanity-check the download before adopting it as the live database.
        const looksValid = isSqliteFile(tmpPath) && fs.statSync(tmpPath).size > 100 * 1024;
        if (!looksValid) {
            fs.rmSync(tmpPath, { force: true });
            console.warn('Downloaded seed did not look like a valid database; skipping.');
            return { installed: false, reason: 'invalid' };
        }

        fs.renameSync(tmpPath, dbPath);
        const sizeMb = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
        console.log(`Metadata seed installed (${sizeMb} MB). Card images download on demand.`);
        return { installed: true, reason: 'downloaded' };
    } catch (error) {
        if (fs.existsSync(tmpPath)) {
            fs.rmSync(tmpPath, { force: true });
        }
        console.warn(`Could not download metadata seed (${error.message}). Starting with an empty database; use the Download buttons to fetch card data.`);
        return { installed: false, reason: 'error', error: error.message };
    }
}

module.exports = { ensureSeedDatabase, isSqliteFile, DEFAULT_SEED_URL };
