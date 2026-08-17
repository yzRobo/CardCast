// Playwright check for deck-view card art resolution.
//
// Regression guard for the 2.0.3/2.0.4 bug where the deck view re-found each card
// by its collector number alone and rendered whichever unrelated card happened to
// share that number (Pikachu #58 -> Aegislash #58). Covers the shapes decks are
// actually stored in - legacy (name + number), imported (name + set + number),
// and freshly clicked (id + image) - plus the same-name case from 613afaa, where
// distinct cards sharing a name must each keep their own art.
//
//   node scripts/verify-deck-art.mjs
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

// Ground truth straight from the DB, so expectations are never hand-written.
async function findCard(game, name) {
    const r = await fetch(`${BASE}/api/search/${game}?q=${encodeURIComponent(name)}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    return rows.find(c => (c.name || '').toLowerCase() === name.toLowerCase()) || null;
}

// Distinct cards that share a name (the Bandai case commit 613afaa fixed).
async function findSameNamePair(game, name) {
    const r = await fetch(`${BASE}/api/search/${game}?q=${encodeURIComponent(name)}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) return [];
    const named = rows.filter(c => (c.name || '').toLowerCase() === name.toLowerCase() && c.image_url);
    const seen = new Set();
    return named.filter(c => {
        if (seen.has(c.card_number)) return false;
        seen.add(c.card_number);
        return true;
    }).slice(0, 3);
}

// Render a deck through the real view and read back what the <img> tags show.
async function renderedArt(page, game, section, cards) {
    return page.evaluate(async ({ game, section, cards }) => {
        const deck = { name: 'Art Check', game, categories: { [section]: cards } };
        await window.displayDeckView(deck, game);
        return Array.from(document.querySelectorAll('#deckView .deck-card-image'))
            .map(img => ({ src: img.getAttribute('src'), title: img.getAttribute('alt') }));
    }, { game, section, cards });
}

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.displayDeckView === 'function');

    // ===== The reported bug: numeric collector numbers on legacy deck entries =====
    // These are exactly what 2.0.3/2.0.4 wrote to localStorage: a name and a number,
    // no id, no image, no set code.
    const LEGACY = [
        ['pokemon', 'Pokemon', 'Pikachu'],
        ['pokemon', 'Trainer', 'Iono'],
        ['magic', 'Creatures', 'Llanowar Elves'],
        ['magic', 'Spells', 'Lightning Bolt'],
        ['magic', 'Spells', 'Counterspell'],
        ['lorcana', 'Characters', 'Elsa - Concerned Sister']
    ];
    for (const [game, section, name] of LEGACY) {
        const truth = await findCard(game, name);
        if (!truth) { check(`${game}: ${name} present in DB`, false, 'card not found'); continue; }

        const art = await renderedArt(page, game, section, [
            { name: truth.name, number: truth.card_number || '', quantity: 1 }
        ]);
        check(`${game}: legacy entry "${name}" renders its own art`,
            art.length === 1 && art[0].src === truth.image_url,
            `expected ${truth.image_url} got ${art[0] && art[0].src}`);
    }

    // ===== Imported entries (name + set code + number) =====
    // Set codes containing digits (4BB, M12, B2) do not match the server's
    // set+number pattern, so these exercise the bare-name fall-through too.
    for (const [game, section, name] of LEGACY) {
        const truth = await findCard(game, name);
        if (!truth) continue;
        const art = await renderedArt(page, game, section, [
            { name: truth.name, setCode: truth.set_abbreviation || '', number: truth.card_number || '', quantity: 1 }
        ]);
        check(`${game}: imported entry "${name}" renders its own art`,
            art.length === 1 && art[0].src === truth.image_url,
            `expected ${truth.image_url} got ${art[0] && art[0].src}`);
    }

    // ===== 613afaa must not regress: same-name cards keep separate art =====
    for (const [game, section, name] of [['digimon', 'Main Deck', 'Agumon'], ['gundam', 'Units', 'Gundam']]) {
        const pair = await findSameNamePair(game, name);
        if (pair.length < 2) { check(`${game}: found multiple "${name}" cards`, false, `only ${pair.length}`); continue; }

        const art = await renderedArt(page, game, section,
            pair.map(c => ({ name: c.name, number: c.card_number || '', quantity: 1 })));
        const srcs = art.map(a => a.src);
        check(`${game}: ${pair.length} distinct "${name}" cards each keep their own art`,
            srcs.length === pair.length && pair.every((c, i) => srcs[i] === c.image_url),
            `expected ${pair.map(c => c.card_number).join(',')} got ${srcs.join(',')}`);
        check(`${game}: same-name art is not duplicated`,
            new Set(srcs).size === pair.length, srcs.join(','));
    }

    // ===== A stored image is used as-is =====
    const stored = await findCard('pokemon', 'Iono');
    if (stored) {
        const art = await renderedArt(page, 'pokemon', 'Trainer', [
            { name: stored.name, number: stored.card_number, image: stored.image_url, quantity: 1 }
        ]);
        check('stored image is used directly', art[0] && art[0].src === stored.image_url,
            `got ${art[0] && art[0].src}`);
    }

    // ===== A stored id resolves via /api/card =====
    if (stored) {
        const art = await renderedArt(page, 'pokemon', 'Trainer', [
            { name: stored.name, id: stored.id, number: stored.card_number, quantity: 1 }
        ]);
        check('stored id resolves to the right art', art[0] && art[0].src === stored.image_url,
            `got ${art[0] && art[0].src}`);
    }

    // ===== Clicking a search result stores the row it clicked =====
    const added = await page.evaluate(async () => {
        const deck = { name: 'Add Check', game: 'pokemon', categories: { Trainer: [] } };
        await window.displayDeckView(deck, 'pokemon');
        window.enterEditMode();
        await new Promise(r => setTimeout(r, 50));

        const input = document.getElementById('addCardSearch');
        input.value = 'Iono';
        await window.searchCardsToAdd({ target: input });

        const first = document.querySelector('#addCardResults .add-card-result');
        if (!first) return { error: 'no add-card results' };
        const clickedSrc = first.querySelector('img').getAttribute('src');

        document.getElementById('addCardCategory').value = 'Trainer';
        first.click();
        await new Promise(r => setTimeout(r, 400));

        const entry = (window.__deckArtProbe = null, document.querySelector('#deckView .deck-card-image'));
        return { clickedSrc, renderedSrc: entry && entry.getAttribute('src') };
    });
    check('clicked card is the card added to the deck',
        added.clickedSrc && added.renderedSrc === added.clickedSrc,
        `clicked ${added.clickedSrc} rendered ${added.renderedSrc} ${added.error || ''}`);

    // ===== A card name that no longer resolves falls back to the card back =====
    const missing = await renderedArt(page, 'pokemon', 'Trainer', [
        { name: 'Zzzz Not A Real Card', number: '185', quantity: 1 }
    ]);
    check('unresolvable entry shows the card back, not a wrong card',
        missing[0] && missing[0].src === '/images/card-back.png',
        `got ${missing[0] && missing[0].src}`);

} catch (error) {
    check('verification run completed', false, error.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
