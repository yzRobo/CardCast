// Phase 0 verification: the generalized (registry-categories-driven) deck library.
// Spawns the server, drives a headless browser, and asserts the rewired functions
// still behave for Pokemon (legacy) AND MTG (legacy) deck shapes:
//   - updateSavedDecksList card counts
//   - deck-view render (correct sections, no throw)
//   - exportDeckToClipboard text (deckToText)
//   - showDeckOnOverlay emits decklist-update with the right categories
//   - getDeckCardNameSet (deck-only search filter source)
//
//   node scripts/verify-deck-library.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const results = [];
const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`);
};

async function waitForServer(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(BASE + '/api/config'); if (r.ok) return true; } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('server did not start in time');
}

const POKEMON_DECK = {
    name: 'GardyTest', game: 'pokemon',
    pokemon: [{ quantity: 3, name: 'Ralts', setCode: 'SVI', number: '84' }, { quantity: 2, name: 'Gardevoir ex', setCode: 'SVI', number: '86' }],
    trainers: [{ quantity: 4, name: "Professor's Research" }],
    energy: [{ quantity: 6, name: 'Psychic Energy' }]
};
const MTG_DECK = {
    name: 'BoltTest', game: 'magic',
    cards: [{ quantity: 4, name: 'Lightning Bolt' }, { quantity: 20, name: 'Mountain' }],
    sideboard: [{ quantity: 2, name: 'Abrade' }]
};

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.game-item').length > 0);

    // Seed saved decks and reload so the inline script picks them up.
    await page.evaluate((decks) => localStorage.setItem('savedDecks', JSON.stringify(decks)),
        { pokemon: [POKEMON_DECK], magic: [MTG_DECK] });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.game-item').length > 0);

    // Globals exist (loaded from game-registry.js before the inline script).
    const globalsOk = await page.evaluate(() => ['getDeckCategories', 'getDeckCategoryArray', 'getDeckSectionNames', 'deckCardCount', 'deckToText', 'getDeckCardNameSet'].every(f => typeof window[f] === 'function'));
    check('deck helpers exposed on window', globalsOk);

    // showDeckOnOverlay round-trips through the server (io.emit echoes to all
    // clients), so we listen on the page's own socket for the broadcast.
    const overlayCategories = (game, name) => page.evaluate(({ game, name }) => new Promise((resolve) => {
        if (typeof socket === 'undefined') return resolve({ error: 'no socket' });
        const handler = (payload) => { socket.off('decklist-update', handler); resolve(payload); };
        socket.on('decklist-update', handler);
        window.showDeckOnOverlay(game, name);
        setTimeout(() => { socket.off('decklist-update', handler); resolve(null); }, 4000);
    }), { game, name });

    // ---- Pokemon ----
    await page.evaluate(() => window.selectGame('pokemon', true));
    const pkList = await page.evaluate(() => document.getElementById('savedDecksList').innerText);
    check('pokemon: saved list shows deck + 15 cards', pkList.includes('GardyTest') && /15 cards/i.test(pkList), pkList);

    await page.evaluate(() => window.loadDeck('pokemon', 'GardyTest'));
    await page.waitForSelector('#deckView .deck-section', { timeout: 8000 });
    const pkSections = await page.evaluate(() => Array.from(document.querySelectorAll('#deckView .deck-section-title')).map(e => e.innerText));
    check('pokemon: deck view renders Pokemon/Trainers/Energy sections in order',
        JSON.stringify(pkSections) === JSON.stringify(['Pokemon', 'Trainers', 'Energy']), pkSections.join(','));
    const pkView = await page.evaluate(() => document.getElementById('deckView').innerText);
    check('pokemon: deck view header shows 15 cards', /15 cards/i.test(pkView), pkView);

    const pkExport = await page.evaluate(() => window.deckToText(JSON.parse(localStorage.getItem('savedDecks')).pokemon[0]));
    check('pokemon: export has Pokémon/Trainer/Energy headers + total',
        /Pokémon: 5/.test(pkExport) && /Trainer: 4/.test(pkExport) && /Energy: 6/.test(pkExport) && /Total Cards: 15/.test(pkExport), pkExport);

    const pkEmit = await overlayCategories('pokemon', 'GardyTest');
    check('pokemon: showDeckOnOverlay broadcasts categories Pokemon/Trainers/Energy',
        !!pkEmit && pkEmit.deck && pkEmit.deck.categories && ['Pokemon', 'Trainers', 'Energy'].every(k => k in pkEmit.deck.categories), JSON.stringify(pkEmit && pkEmit.deck && pkEmit.deck.categories));

    await page.evaluate(() => window.exitDeckView());

    // ---- MTG ----
    await page.evaluate(() => window.selectGame('magic', true));
    const mgList = await page.evaluate(() => document.getElementById('savedDecksList').innerText);
    check('magic: saved list shows deck + 26 cards', mgList.includes('BoltTest') && /26 cards/i.test(mgList), mgList);

    await page.evaluate(() => window.loadDeck('magic', 'BoltTest'));
    await page.waitForSelector('#deckView .deck-section', { timeout: 8000 });
    const mgSections = await page.evaluate(() => Array.from(document.querySelectorAll('#deckView .deck-section-title')).map(e => e.innerText));
    check('magic: deck view renders Deck/Sideboard sections in order',
        JSON.stringify(mgSections) === JSON.stringify(['Deck', 'Sideboard']), mgSections.join(','));
    const mgView = await page.evaluate(() => document.getElementById('deckView').innerText);
    check('magic: deck view header shows 26 cards', /26 cards/i.test(mgView), mgView);

    const mgEmit = await overlayCategories('magic', 'BoltTest');
    check('magic: showDeckOnOverlay broadcasts categories Deck/Sideboard',
        !!mgEmit && mgEmit.deck && mgEmit.deck.categories && ['Deck', 'Sideboard'].every(k => k in mgEmit.deck.categories), JSON.stringify(mgEmit && mgEmit.deck && mgEmit.deck.categories));

    // deck-only search source set
    const nameSet = await page.evaluate(() => {
        const d = JSON.parse(localStorage.getItem('savedDecks')).pokemon[0];
        return Array.from(window.getDeckCardNameSet(d));
    });
    check('getDeckCardNameSet returns lowercased names', nameSet.includes('ralts') && nameSet.includes('psychic energy'), nameSet.join(','));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
