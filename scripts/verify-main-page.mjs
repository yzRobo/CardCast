// Reusable Playwright check for the main page game switcher (Phases 1-2).
// Spawns the server, drives a headless browser, asserts each game rebuilds its
// panels with no cross-game leakage, that search/preview meta is per-game, and
// that the saved-decks list filters per game. Then tears the server down.
//
//   node scripts/verify-main-page.mjs
//
// Exit code 0 = all checks passed, 1 = a check failed (details printed).
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
        try {
            const r = await fetch(BASE + '/api/config');
            if (r.ok) return true;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('server did not start in time');
}

// Read the rendered panels after selecting a game via the real switcher.
async function panelsFor(page, gameId) {
    await page.evaluate((g) => window.selectGame(g, true), gameId);
    return page.evaluate(() => ({
        match: document.getElementById('matchControlsList').innerText,
        obs: document.getElementById('obsSourcesList').innerText,
        deckSelect: document.getElementById('deckGameSelect').value,
        activeTiles: Array.from(document.querySelectorAll('.game-item.active')).map(e => e.dataset.game)
    }));
}

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.game-item').length > 0);

    // ===== Phase 1: panels rebuild from the registry, no leakage =====
    const pk = await panelsFor(page, 'pokemon');
    check('pokemon: shows Pokemon Match Control', pk.match.includes('Pokemon Match Control'), pk.match);
    check('pokemon: OBS has pokemon-match + prizes', pk.obs.includes('/pokemon-match') && pk.obs.includes('/prizes'), pk.obs);
    check('pokemon: OBS has no MTG link', !pk.obs.includes('/mtg-match'), pk.obs);
    check('pokemon: deck select synced', pk.deckSelect === 'pokemon', pk.deckSelect);
    check('pokemon: sidebar tile active', pk.activeTiles.length === 1 && pk.activeTiles[0] === 'pokemon', pk.activeTiles.join(','));

    const mg = await panelsFor(page, 'magic');
    check('magic: shows MTG Match Control', mg.match.includes('MTG Match Control'), mg.match);
    check('magic: dropped Pokemon Match Control', !mg.match.includes('Pokemon Match Control'), mg.match);
    check('magic: OBS has mtg-match', mg.obs.includes('/mtg-match'), mg.obs);
    check('magic: OBS leaked no pokemon/prizes', !mg.obs.includes('/pokemon-match') && !mg.obs.includes('/prizes'), mg.obs);
    check('magic: deck select synced', mg.deckSelect === 'magic', mg.deckSelect);

    const yg = await panelsFor(page, 'yugioh');
    check('yugioh: shows Yu-Gi-Oh! Match Control', yg.match.includes('Yu-Gi-Oh! Match Control'), yg.match);
    check('yugioh: dropped Pokemon Match Control', !yg.match.includes('Pokemon Match Control'), yg.match);
    check('yugioh: OBS has yugioh-match overlay + decklist', yg.obs.includes('/yugioh-match') && yg.obs.includes('/decklist'), yg.obs);
    check('yugioh: OBS leaked no pokemon/mtg/prizes', !yg.obs.includes('/pokemon-match') && !yg.obs.includes('/mtg-match') && !yg.obs.includes('/prizes'), yg.obs);
    check('yugioh: deck select synced', yg.deckSelect === 'yugioh', yg.deckSelect);

    // ===== Phase 2: per-game search/preview meta =====
    // Pokemon: HP shown on results + preview
    await page.evaluate(() => window.selectGame('pokemon', true));
    const pkMeta = await page.evaluate(() => {
        const card = { id: 'p1', name: 'Pikachu', hp: 60, set_name: 'Base', card_number: '1', card_type: 'Basic Pokemon' };
        window.displaySearchResults([card]);
        window.updateCardPreview(card);
        return {
            results: document.getElementById('searchResults').innerText,
            preview: document.getElementById('cardPreview').innerText
        };
    });
    check('pokemon: results show HP meta', pkMeta.results.includes('HP 60'), pkMeta.results);
    check('pokemon: preview shows HP meta', pkMeta.preview.includes('HP 60'), pkMeta.preview);

    // Magic: mana cost shown instead of HP
    await page.evaluate(() => window.selectGame('magic', true));
    const mgMeta = await page.evaluate(() => {
        const card = { id: 'm1', name: 'Lightning Bolt', mana_cost: '{R}', card_type: 'Instant', set_name: '2X2', card_number: '117' };
        window.displaySearchResults([card]);
        window.updateCardPreview(card);
        return {
            results: document.getElementById('searchResults').innerText,
            preview: document.getElementById('cardPreview').innerText
        };
    });
    check('magic: results show mana-cost meta', mgMeta.results.includes('{R}'), mgMeta.results);
    check('magic: preview shows mana-cost meta', mgMeta.preview.includes('{R}'), mgMeta.preview);
    check('magic: preview shows no HP label', !/HP\s*\d/i.test(mgMeta.preview), mgMeta.preview);

    // categorize runs in-browser from the loaded registry
    const cat = await page.evaluate(() => ({
        land: window.getGameConfig('magic').deck.categorize({ card_type: 'Basic Land' }),
        trainer: window.getGameConfig('pokemon').deck.categorize({ card_type: 'Trainer Item' })
    }));
    check('magic categorize -> Lands', cat.land === 'Lands', cat.land);
    check('pokemon categorize -> Trainers', cat.trainer === 'Trainers', cat.trainer);

    // ===== Phase 3: header dropdown, synced with the sidebar =====
    const dd = await page.evaluate(() => {
        const sel = document.getElementById('gameSelect');
        return {
            present: !!sel,
            values: sel ? Array.from(sel.options).map(o => o.value).filter(Boolean) : []
        };
    });
    check('dropdown: present in header', dd.present);
    check('dropdown: has all enabled games', ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'digimon', 'gundam'].every(g => dd.values.includes(g)), dd.values.join(','));

    // sidebar/programmatic select -> dropdown value follows
    await page.evaluate(() => window.selectGame('pokemon', true));
    const ddAfterSidebar = await page.evaluate(() => document.getElementById('gameSelect').value);
    check('dropdown: follows sidebar selection', ddAfterSidebar === 'pokemon', ddAfterSidebar);

    // dropdown change -> rebuilds panels (real <select> change event)
    await page.selectOption('#gameSelect', 'magic');
    const viaDropdown = await page.evaluate(() => ({
        match: document.getElementById('matchControlsList').innerText,
        deckSel: document.getElementById('deckGameSelect').value,
        gameSel: document.getElementById('gameSelect').value
    }));
    check('dropdown: switches game to magic', viaDropdown.gameSel === 'magic' && viaDropdown.deckSel === 'magic', JSON.stringify(viaDropdown));
    check('dropdown: rebuilt Match Controls (MTG)', viaDropdown.match.includes('MTG Match Control'), viaDropdown.match);

    // dropdown to yugioh -> its own match controls, no leakage
    await page.selectOption('#gameSelect', 'yugioh');
    const viaDropdownYg = await page.evaluate(() => ({
        match: document.getElementById('matchControlsList').innerText,
        obs: document.getElementById('obsSourcesList').innerText
    }));
    check('dropdown: rebuilt Match Controls (Yu-Gi-Oh!)', viaDropdownYg.match.includes('Yu-Gi-Oh! Match Control'), viaDropdownYg.match);
    check('dropdown: yugioh no MTG/pokemon leak', !viaDropdownYg.obs.includes('/mtg-match') && !viaDropdownYg.obs.includes('/pokemon-match'), viaDropdownYg.obs);

    // ===== Phase 2: saved-decks list filters per game =====
    await page.evaluate(() => localStorage.setItem('savedDecks', JSON.stringify({
        pokemon: [{ name: 'PikaDeck', pokemon: [{ quantity: 2, name: 'Pikachu' }], trainers: [], energy: [] }],
        magic: [{ name: 'BoltDeck', cards: [{ quantity: 4, name: 'Lightning Bolt' }], sideboard: [] }]
    })));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.game-item').length > 0);

    await page.evaluate(() => window.selectGame('pokemon', true));
    const pkDecks = await page.evaluate(() => document.getElementById('savedDecksList').innerText);
    check('pokemon: saved decks show PikaDeck', pkDecks.includes('PikaDeck'), pkDecks);
    check('pokemon: saved decks hide BoltDeck', !pkDecks.includes('BoltDeck'), pkDecks);

    await page.evaluate(() => window.selectGame('magic', true));
    const mgDecks = await page.evaluate(() => document.getElementById('savedDecksList').innerText);
    check('magic: saved decks show BoltDeck', mgDecks.includes('BoltDeck'), mgDecks);
    check('magic: saved decks hide PikaDeck', !mgDecks.includes('PikaDeck'), mgDecks);
} catch (err) {
    check('harness ran without throwing', false, err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
