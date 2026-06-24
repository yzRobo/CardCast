// Phase 3 verification: deck-aware Gundam match control.
// Seeds a saved Gundam deck, then drives the control page to confirm the deck
// selector, "deck only" quick-add list, deck-filtered search, and that quick-add
// pushes AP/HP-prefilled units (and pilots) to the overlay.
//
//   node scripts/verify-gundam-deck-aware.mjs
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
async function discover() {
    const units = [], pilots = [], bases = [];
    for (const q of ['EB01', 'GD01', 'GD02', 'ST01', 'ST02']) {
        const arr = await (await fetch(`${BASE}/api/search/gundam?q=${q}`)).json();
        for (const c of arr) {
            const t = (c.card_type || '').toUpperCase();
            if (t.includes('UNIT') && c.gd_ap != null && units.length < 3 && !units.find(u => u.card_number === c.card_number)) units.push(c);
            else if (t.includes('PILOT') && pilots.length < 1 && !pilots.find(u => u.card_number === c.card_number)) pilots.push(c);
            else if (t.includes('BASE') && bases.length < 1) bases.push(c);
        }
        if (units.length >= 3 && pilots.length >= 1 && bases.length >= 1) break;
    }
    return { units, pilots, bases };
}

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const { units, pilots, bases } = await discover();
    check('discovered >=2 Units (with AP) + Pilot + Base', units.length >= 2 && pilots.length >= 1 && bases.length >= 1,
        JSON.stringify({ units: units.length, pilots: pilots.length, bases: bases.length }));

    const deck = {
        name: 'P3Deck', game: 'gundam',
        categories: {
            Units: units.map(c => ({ number: c.card_number, name: c.name, quantity: 4 })),
            Pilots: pilots.map(c => ({ number: c.card_number, name: c.name, quantity: 2 })),
            Bases: bases.map(c => ({ number: c.card_number, name: c.name, quantity: 2 }))
        }
    };

    browser = await chromium.launch();
    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/gundam-match`, { waitUntil: 'networkidle' });
    const control = await browser.newPage();
    control.on('dialog', d => d.accept());
    // Seed the saved deck, then load the control page so it picks it up.
    await control.goto(`${BASE}/gundam-match-control`, { waitUntil: 'domcontentloaded' });
    await control.evaluate((d) => localStorage.setItem('savedDecks', JSON.stringify({ gundam: [d] })), deck);
    await control.reload({ waitUntil: 'networkidle' });

    // Deck selector lists the deck.
    const hasOption = await control.evaluate(() => Array.from(document.getElementById('p1Deck').options).some(o => o.value === 'P3Deck'));
    check('P1 deck selector lists the saved Gundam deck', hasOption);

    // Select the deck for P1.
    await control.evaluate(() => { document.getElementById('p1Deck').value = 'P3Deck'; setPlayerDeck(1); });

    // Open Unit search -> deck-only auto-on + quick-add list populated.
    await control.evaluate(() => openSearch(1, 'unit', 0));
    await control.waitForSelector('#searchResults .card', { timeout: 8000 });
    const modal = await control.evaluate(() => ({
        deckOnlyVisible: !document.getElementById('deckOnlyLabel').classList.contains('hidden'),
        deckOnlyChecked: document.getElementById('searchDeckOnly').checked,
        resultCount: document.querySelectorAll('#searchResults .card').length
    }));
    check('Unit search shows "Deck only" toggle, checked', modal.deckOnlyVisible && modal.deckOnlyChecked, JSON.stringify(modal));
    check('quick-add list has the deck Units', modal.resultCount === units.length, `${modal.resultCount} vs ${units.length}`);

    // Deck-only filter: typing narrows the list.
    const firstName = units[0].name;
    await control.evaluate((n) => { document.getElementById('cardSearch').value = n.slice(0, 4); runSearch(); }, firstName);
    await control.waitForTimeout(300);
    const filtered = await control.evaluate(() => document.querySelectorAll('#searchResults .card').length);
    check('deck-only search filters the quick-add list', filtered >= 1 && filtered <= units.length, String(filtered));

    // Reset query, click the first deck Unit to quick-add it.
    await control.evaluate(() => { document.getElementById('cardSearch').value = ''; runSearch(); });
    await control.waitForSelector('#searchResults .card', { timeout: 5000 });
    await control.click('#searchResults .card');

    // Overlay shows the unit with AP prefilled from the deck card.
    const apOk = await overlay.waitForFunction((ap) => {
        const cell = document.querySelector('#p1Units .unit-cell:not(.empty)');
        return cell && cell.querySelector('.ap-chip') && cell.querySelector('.ap-chip').textContent.includes('AP ' + ap);
    }, units[0].gd_ap, { timeout: 6000 }).then(() => true).catch(() => false);
    check('quick-add unit appears on overlay with AP prefilled', apOk, 'expected AP ' + units[0].gd_ap);

    // Quick-add a Pilot from the deck onto that unit.
    await control.evaluate(() => openSearch(1, 'pilot', 0));
    await control.waitForSelector('#searchResults .card', { timeout: 8000 });
    const pilotCount = await control.evaluate(() => document.querySelectorAll('#searchResults .card').length);
    check('Pilot quick-add list populated from deck', pilotCount >= 1, String(pilotCount));
    await control.click('#searchResults .card');
    const pilotOk = await overlay.waitForFunction(() => !!document.querySelector('#p1Units .unit-cell .pilot-chip'), { timeout: 6000 }).then(() => true).catch(() => false);
    check('quick-add pilot appears as pilot chip on overlay', pilotOk);

    // Player 2 has no deck -> deck-only toggle hidden, plain search.
    await control.evaluate(() => openSearch(2, 'unit', 0));
    const p2 = await control.evaluate(() => document.getElementById('deckOnlyLabel').classList.contains('hidden'));
    check('player without a deck: deck-only toggle hidden', p2);
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
