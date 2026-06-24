// Phase 3 verification: MTG deck import routes into the registry's type
// categories (Creatures / Spells / Artifacts / Enchantments / Planeswalkers /
// Lands + Sideboard), the decklist overlay orders them, and the real import
// path (main page -> server relay -> overlay) renders them.
//
//   node scripts/verify-mtg-deck.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const results = [];
const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`);
};
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };
async function waitForServer(t = 20000) {
    const s = Date.now();
    while (Date.now() - s < t) { if (await isUp()) return true; await new Promise(r => setTimeout(r, 300)); }
    throw new Error('server did not start in time');
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();

    const main = await browser.newPage();
    main.on('pageerror', e => console.log('MAIN ERROR:', e.message));
    main.on('dialog', d => d.accept());
    await main.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await main.waitForFunction(() => typeof parseDeckList === 'function' && typeof deckToCategories === 'function', { timeout: 8000 });

    // Discover one real card per MTG type (using the registry's own categorize so
    // the test is self-consistent), then run the real import normalization on a
    // decklist built from those names. resolveMagicCardType re-resolves each name
    // against the DB, so this exercises the full type-resolution path.
    const data = await main.evaluate(async () => {
        const categorize = getGameConfig('magic').deck.categorize;
        const want = ['Creatures', 'Spells', 'Artifacts', 'Enchantments', 'Planeswalkers', 'Lands'];
        const picks = {};
        const queries = ['forest', 'island', 'sol ring', 'signet', 'jace', 'teferi', 'oath', 'pacifism',
            'bolt', 'shock', 'elf', 'goblin', 'angel', 'bear', 'golem', 'wall', 'light'];
        for (const q of queries) {
            const cards = await (await fetch(`/api/search/magic?q=${encodeURIComponent(q)}`)).json();
            for (const c of (cards || [])) {
                const cat = categorize(c);
                if (want.includes(cat) && !picks[cat]) picks[cat] = c.name;
            }
            if (want.every(w => picks[w])) break;
        }

        // Build an Arena-style decklist + a sideboard line, then normalize it.
        const lines = ['Deck'];
        let qty = 2;
        for (const w of want) if (picks[w]) lines.push(`${qty++} ${picks[w]}`);
        lines.push('', 'Sideboard');
        if (picks.Creatures) lines.push(`2 ${picks.Creatures}`);
        const text = lines.join('\n');

        const parsed = await parseDeckList(text);
        const norm = await deckToCategories(parsed);
        return { picks, norm, text };
    });

    const { picks, norm } = data;
    check('discovered a card for every MTG type', ['Creatures', 'Spells', 'Artifacts', 'Enchantments', 'Planeswalkers', 'Lands'].every(c => picks[c]), JSON.stringify(picks));
    check('import detected game = magic', norm.game === 'magic', norm.game);

    const inCat = (cat, name) => (norm.categories[cat] || []).some(c => c.name === name);
    check('Creature routed to Creatures', picks.Creatures && inCat('Creatures', picks.Creatures), JSON.stringify(norm.categories.Creatures));
    check('Instant/Sorcery routed to Spells', picks.Spells && inCat('Spells', picks.Spells), JSON.stringify(norm.categories.Spells));
    check('Artifact routed to Artifacts', picks.Artifacts && inCat('Artifacts', picks.Artifacts), JSON.stringify(norm.categories.Artifacts));
    check('Enchantment routed to Enchantments', picks.Enchantments && inCat('Enchantments', picks.Enchantments), JSON.stringify(norm.categories.Enchantments));
    check('Planeswalker routed to Planeswalkers', picks.Planeswalkers && inCat('Planeswalkers', picks.Planeswalkers), JSON.stringify(norm.categories.Planeswalkers));
    check('Land routed to Lands', picks.Lands && inCat('Lands', picks.Lands), JSON.stringify(norm.categories.Lands));
    check('Sideboard kept as its own category', (norm.categories.Sideboard || []).length >= 1, JSON.stringify(norm.categories.Sideboard));

    // Decklist overlay orders the MTG categories per CATEGORY_ORDER.
    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/decklist`, { waitUntil: 'domcontentloaded' });
    const order = await overlay.evaluate((categories) => {
        currentDeck = { title: 'MTG Test', game: 'magic', categories };
        updateDecklist();
        setShown(true);
        return [...document.querySelectorAll('.category-name')].map(el => el.textContent);
    }, norm.categories);
    const expected = ['Creatures', 'Spells', 'Artifacts', 'Enchantments', 'Planeswalkers', 'Lands', 'Sideboard'];
    const seqOk = expected.filter(c => order.includes(c)).join(',') ===
        order.filter(c => expected.includes(c)).join(',');
    check('decklist overlay orders MTG categories correctly', seqOk && order.includes('Creatures') && order.includes('Lands'), JSON.stringify(order));

    // Full real path: import on the main page -> server relay -> overlay renders.
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/decklist`, { waitUntil: 'domcontentloaded' });
    await overlay2.waitForFunction(() => typeof updateDecklist === 'function', { timeout: 8000 });
    await main.evaluate(async (text) => {
        currentGame = 'magic';
        document.getElementById('deckImportText').value = text;
        document.getElementById('deckNameInput').value = 'Realpath Deck';
        await importDeck();
    }, data.text);
    check('real import path renders on overlay', await overlay2.waitForFunction(() => {
        const names = [...document.querySelectorAll('.category-name')].map(e => e.textContent);
        return document.getElementById('deckTitle').textContent === 'Realpath Deck' &&
            names.includes('Creatures') && names.includes('Lands');
    }, { timeout: 8000 }).then(() => true).catch(() => false));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
