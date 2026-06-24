// Phase 1 verification: Gundam deck foundation against the real local DB.
// Spawns the server, drives a headless browser, and checks:
//   - /api/search/gundam returns gd_ap/gd_hp/gd_color (search SELECT change)
//   - parseGundamDeckList resolves GDxx-NNN numbers + buckets by card_type
//   - full Import & Save flow (UI) produces a generic { categories } deck
//   - saved-deck list count, deck view sections, show-on-overlay categories
//   - Gundam search tiles show AP/HP meta
//
//   node scripts/verify-gundam-deck.mjs
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

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('dialog', d => d.accept()); // auto-accept import alerts/confirms
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.game-item').length > 0);

    // Discover one real card per category from the live DB (EB01 first: it has Units with AP).
    const discovered = await page.evaluate(async () => {
        const map = {};
        let hasApKey = false;
        let unitWithAp = null;
        for (const q of ['EB01', 'GD01', 'GD02', 'GD03', 'GD04', 'ST01', 'ST02']) {
            const r = await fetch(`/api/search/gundam?q=${q}`);
            const arr = await r.json();
            for (const c of arr) {
                if ('gd_ap' in c) hasApKey = true; // column present (null is valid for Bases/Commands)
                if (!unitWithAp && c.gd_ap !== null && c.gd_ap !== undefined && c.gd_ap !== '') {
                    unitWithAp = { number: c.card_number, name: c.name, gd_ap: c.gd_ap, gd_hp: c.gd_hp };
                }
                const cat = window.gundamCategoryFromType(c.card_type);
                if (!map[cat]) map[cat] = { number: c.card_number, name: c.name, type: c.card_type };
            }
            if (Object.keys(map).length >= 5 && unitWithAp) break;
        }
        return { map, hasApKey, unitWithAp };
    });
    const cats = Object.keys(discovered.map);
    check('search returns gundam cards', cats.length > 0, JSON.stringify(discovered.map));
    check('search SELECT exposes gd_ap column', discovered.hasApKey);
    check('found a Unit with an AP value (data populated)', !!discovered.unitWithAp, JSON.stringify(discovered.unitWithAp));
    check('resolved >= 3 distinct categories from DB', cats.length >= 3, cats.join(','));

    // Build a number-keyed deck list from the discovered cards.
    const deckText = cats.map(c => `${c === 'Resources' ? 10 : 4} ${discovered.map[c].number}`).join('\n');
    console.log('---- deck list ----\n' + deckText + '\n-------------------');

    // Parse directly (async, resolves against the DB).
    const parsed = await page.evaluate(async (text) => await window.parseDeckList(text), deckText);
    check('parseDeckList returns generic { categories } shape', !!parsed.categories && !parsed.pokemon, JSON.stringify(Object.keys(parsed)));
    const parsedOk = cats.every(c => parsed.categories[c] && parsed.categories[c].some(card => card.number === discovered.map[c].number));
    check('each discovered card bucketed into its category', parsedOk, JSON.stringify(parsed.categories));

    // Full Import & Save through the real UI (importAndSaveDeck needs a click event).
    await page.fill('#deckNameInput', 'GundamItgTest');
    await page.selectOption('#deckGameSelect', 'gundam');
    await page.fill('#deckImportText', deckText);
    await page.click('button[onclick="importAndSaveDeck()"]');
    await page.waitForFunction(() => {
        const sd = JSON.parse(localStorage.getItem('savedDecks') || '{}');
        return sd.gundam && sd.gundam.some(d => d.name === 'GundamItgTest');
    }, { timeout: 15000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('savedDecks')).gundam.find(d => d.name === 'GundamItgTest'));
    check('imported deck saved with categories', !!saved.categories && Object.keys(saved.categories).length >= 3, JSON.stringify(Object.keys(saved.categories || {})));
    check('imported deck game = gundam', saved.game === 'gundam');

    // Saved-deck list shows it with a count.
    await page.evaluate(() => window.selectGame('gundam', true));
    const list = await page.evaluate(() => document.getElementById('savedDecksList').innerText);
    check('saved-deck list shows Gundam deck + card count', list.includes('GundamItgTest') && /\d+ cards/i.test(list), list);

    // Deck view renders the Gundam sections.
    await page.evaluate(() => window.loadDeck('gundam', 'GundamItgTest'));
    await page.waitForSelector('#deckView .deck-section', { timeout: 8000 });
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('#deckView .deck-section-title')).map(e => e.innerText));
    const gundamOrder = ['Units', 'Pilots', 'Commands', 'Bases', 'Resources'];
    check('deck view sections are Gundam categories in registry order',
        sections.length > 0 && sections.every(s => gundamOrder.includes(s)) && JSON.stringify(sections) === JSON.stringify(gundamOrder.filter(s => sections.includes(s))),
        sections.join(','));
    await page.evaluate(() => window.exitDeckView());

    // show-on-overlay broadcasts the Gundam categories.
    const emit = await page.evaluate((name) => new Promise((resolve) => {
        if (typeof socket === 'undefined') return resolve(null);
        const h = (p) => { socket.off('decklist-update', h); resolve(p); };
        socket.on('decklist-update', h);
        window.showDeckOnOverlay('gundam', name);
        setTimeout(() => { socket.off('decklist-update', h); resolve(null); }, 4000);
    }), 'GundamItgTest');
    check('showDeckOnOverlay broadcasts gundam categories',
        !!emit && emit.deck && emit.deck.game === 'gundam' && emit.deck.categories && Object.keys(emit.deck.categories).length >= 3,
        JSON.stringify(emit && emit.deck && Object.keys(emit.deck.categories || {})));

    // Search tile meta shows AP/HP for the discovered Unit card.
    const meta = await page.evaluate((unit) => {
        if (!unit) return { skip: true };
        window.selectGame('gundam', true);
        return { meta: window.getGameConfig('gundam').searchMeta({ gd_ap: unit.gd_ap, gd_hp: unit.gd_hp }), unit };
    }, discovered.unitWithAp);
    if (meta.skip) check('search meta AP/HP (no unit with AP found - skipped)', false, 'expected a unit with AP');
    else check('search meta shows AP/HP', /AP\s/.test(meta.meta) && /HP\s/.test(meta.meta), JSON.stringify(meta));

    // Regression: Pokemon search still works (SELECT change is additive).
    const pkOk = await page.evaluate(async () => {
        const r = await fetch('/api/search/pokemon?q=pikachu');
        const arr = await r.json();
        return Array.isArray(arr) && arr.length > 0 && 'hp' in arr[0];
    });
    check('regression: pokemon search still returns rows with hp', pkOk);
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
