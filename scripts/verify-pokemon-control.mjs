// End-to-end check of the Pokemon match control driving the overlay through
// the REAL UI: open the search, type, click a result card, and assert what the
// overlay actually renders. scripts/verify-pokemon-match.mjs pushes synthetic
// payloads over a driver socket, so it cannot catch a break in the control's
// own selectPokemon() path - this one clicks the button a producer clicks.
//
//   node scripts/verify-pokemon-control.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' -> ' + detail : ''}`); }
};

// Pick a real card that exercises every field the polish pass added.
async function pickCard() {
    for (const query of ['Charizard ex', 'Gardevoir ex', 'Pikachu']) {
        const results = await (await fetch(`${BASE}/api/search/pokemon?q=${encodeURIComponent(query)}`)).json();
        for (const hit of (results || [])) {
            const full = await (await fetch(`${BASE}/api/card/pokemon/${hit.id}`)).json();
            if (full && full.hp && full.attack1_name && full.stage) return { query, card: full };
        }
    }
    return null;
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    const picked = await pickCard();
    check('found a Pokemon with HP, stage and an attack', !!picked, 'no suitable card in the database');
    if (!picked) throw new Error('no fixture card available');
    const { query, card } = picked;
    console.log(`  (fixture: ${card.name} - stage "${card.stage}", attack "${card.attack1_name}")`);

    browser = await chromium.launch();

    const overlayErrors = [], controlErrors = [];
    const overlay = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    overlay.on('pageerror', e => overlayErrors.push(e.message));
    await overlay.goto(`${BASE}/pokemon-match`, { waitUntil: 'domcontentloaded' });
    await overlay.waitForTimeout(1200);

    const control = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    control.on('pageerror', e => controlErrors.push(e.message));
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/pokemon-match-control`, { waitUntil: 'domcontentloaded' });
    await control.waitForTimeout(800);

    console.log('\nDriving the control UI');
    // Open the Active-Pokemon picker exactly as the button in the page does.
    await control.click('button[onclick="selectPokemonFor(\'player1\', \'active\')"]');
    check('search overlay opened', await control.evaluate(() =>
        document.getElementById('searchOverlay').classList.contains('active')));

    // Search outside the deck list, then type into the real input so the
    // debounced listener fires rather than calling searchPokemon() directly.
    await control.evaluate(() => { document.getElementById('searchAllCards').checked = true; });
    await control.fill('#pokemonSearch', query);
    await control.waitForFunction(
        name => Array.from(document.querySelectorAll('#searchResults [onclick^="selectPokemon("]'))
            .some(el => el.textContent.includes(name)),
        card.name, { timeout: 15000 });
    check('typing into the search box returned the card', true);

    // Click the result tile itself - this is the path under test.
    await control.click(`#searchResults [onclick="selectPokemon('${card.id}')"]`);
    // selectPokemon() fetches the full card before closing, so wait rather than
    // reading the class straight after the click.
    check('search overlay closed after picking', await control.waitForFunction(() =>
        !document.getElementById('searchOverlay').classList.contains('active'),
        { timeout: 8000 }).then(() => true).catch(() => false));

    console.log('\nOverlay received the pick');
    const arrived = await overlay.waitForFunction(
        name => document.getElementById('player1ActiveName').textContent === name,
        card.name, { timeout: 8000 }).then(() => true).catch(() => false);
    check('overlay banner shows the picked Pokemon', arrived);

    check('overlay renders the card art', await overlay.evaluate(() =>
        !!document.querySelector('#player1Active img.card-art')));
    check('overlay shows HP from the card record', await overlay.evaluate(hp =>
        document.querySelector('#player1Active .hp-text').textContent.trim() === `${hp}/${hp}`,
        parseInt(card.hp)));

    // The fields the polish pass added to selectPokemon(). If the control ever
    // stops sending them, the overlay silently degrades to the old look - which
    // is exactly the regression this script exists to catch.
    check('stage chip populated and trimmed to one token', await overlay.evaluate(expected => {
        const el = document.getElementById('player1ActiveStage');
        return el.style.display !== 'none' && el.textContent.trim() === expected;
    }, String(card.stage).split(',')[0].trim()));

    check('attack row rendered from the control payload', await overlay.evaluate(name =>
        Array.from(document.querySelectorAll('#player1Active .move-name')).some(el => el.textContent.trim() === name),
        card.attack1_name));

    if (card.attack1_cost) {
        check('attack cost rendered as energy pips', await overlay.evaluate(() =>
            document.querySelectorAll('#player1Active .energy-pip').length > 0));
    }
    if (card.ability_name) {
        check('ability row rendered from the control payload', await overlay.evaluate(name =>
            Array.from(document.querySelectorAll('#player1Active .move-name')).some(el => el.textContent.trim() === name),
            card.ability_name));
    }

    console.log('\nPer-placement identity token');
    const uid = await control.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('pokemonMatchState') || '{}');
        return state.player1 && state.player1.active ? state.player1.active.uid : null;
    });
    check('control stamps a uid on the placed Pokemon', typeof uid === 'string' && uid.length > 0, String(uid));
    check('the placement is persisted to localStorage', await control.evaluate(name => {
        const state = JSON.parse(localStorage.getItem('pokemonMatchState') || '{}');
        return state.player1 && state.player1.active && state.player1.active.name === name;
    }, card.name));

    console.log('\nBench placement through the same path');
    // The other selectPokemon() branch. Note the Active picker button is gone
    // once a Pokemon is placed - the panel swaps to Remove / Attach Tool.
    await control.click(`[onclick="selectPokemonFor('player1', 'bench', 0)"]`);
    await control.evaluate(() => { document.getElementById('searchAllCards').checked = true; });
    await control.fill('#pokemonSearch', query);
    await control.waitForFunction(id => !!document.querySelector(`#searchResults [onclick="selectPokemon('${id}')"]`),
        card.id, { timeout: 15000 });
    await control.click(`#searchResults [onclick="selectPokemon('${card.id}')"]`);
    check('bench slot filled on the overlay', await overlay.waitForFunction(() =>
        document.querySelectorAll('#player1Bench .bench-slot.filled').length === 1,
        { timeout: 8000 }).then(() => true).catch(() => false));
    check('bench HP label rendered', await overlay.evaluate(hp =>
        document.querySelector('#player1Bench .bench-hp').textContent.trim() === `${hp}/${hp}`,
        parseInt(card.hp)));

    // Same card in two slots must carry two different tokens, otherwise the
    // overlay cannot tell a promoted copy from the Pokemon it replaced.
    const uids = await control.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('pokemonMatchState') || '{}');
        return {
            active: state.player1 && state.player1.active ? state.player1.active.uid : null,
            bench: state.player1 && state.player1.bench && state.player1.bench[0] ? state.player1.bench[0].uid : null
        };
    });
    check('the bench copy gets its own uid', typeof uids.bench === 'string' && uids.bench.length > 0, JSON.stringify(uids));
    check('two copies of one card do not share a uid', uids.active !== uids.bench, JSON.stringify(uids));

    console.log('\nRemoving the Active clears it end to end');
    await control.click(`[onclick="removeActive(1)"]`);
    check('overlay falls back to the empty state', await overlay.waitForFunction(() =>
        document.querySelector('#player1Active .no-active') !== null,
        { timeout: 8000 }).then(() => true).catch(() => false));
    check('banner falls back to its label', await overlay.evaluate(() =>
        document.getElementById('player1ActiveName').textContent === 'Active Pokémon'));

    console.log('\nScript health');
    check('no overlay page errors', overlayErrors.length === 0, overlayErrors.join(' | '));
    check('no control page errors', controlErrors.length === 0, controlErrors.join(' | '));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
