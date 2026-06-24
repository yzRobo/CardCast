// src/config.js - CardCast configuration & API key resolution
//
// Resolution priority for every value: process.env > config.local.json > config.json defaults.
// config.local.json and .env are gitignored and may hold secrets; config.json is the committed,
// secret-free default. API keys are NEVER persisted back into config.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Minimal .env parser so no extra dependency is needed. Loads KEY=VALUE lines
// from a .env file at the project root into process.env, without overwriting
// variables that are already set in the real environment (real env wins).
function loadEnv(envPath = path.join(ROOT, '.env')) {
    if (!fs.existsSync(envPath)) return;
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            // Strip a single pair of surrounding quotes if present
            if (value.length >= 2 &&
                ((value.startsWith('"') && value.endsWith('"')) ||
                 (value.startsWith("'") && value.endsWith("'")))) {
                value = value.slice(1, -1);
            }
            if (key && !(key in process.env)) {
                process.env[key] = value;
            }
        }
    } catch (e) {
        console.log('Could not parse .env file:', e.message);
    }
}

function readJson(file) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.log(`Error reading ${path.basename(file)}:`, e.message);
    }
    return null;
}

// Merge override onto base. Top-level keys are overwritten; the nested
// `games` and `obs` objects are merged one level deep so a partial override
// (e.g. enabling a single game) does not wipe the other entries.
function mergeConfig(base, override) {
    if (!override) return base;
    const merged = { ...base, ...override };

    if (base.games || override.games) {
        merged.games = { ...(base.games || {}) };
        for (const [key, value] of Object.entries(override.games || {})) {
            merged.games[key] = { ...(merged.games[key] || {}), ...value };
        }
    }
    if (base.obs || override.obs) {
        merged.obs = { ...(base.obs || {}), ...(override.obs || {}) };
    }
    return merged;
}

// Resolve optional API keys. Keys are never read from the committed config.json;
// only env vars and the gitignored config.local.json are consulted.
function resolveApiKeys(localConfig) {
    const fromLocal = (localConfig && localConfig.apiKeys) || {};
    return {
        pokemonApiKey: process.env.POKEMONTCG_API_KEY || fromLocal.pokemon || null
    };
}

module.exports = { ROOT, loadEnv, readJson, mergeConfig, resolveApiKeys };
