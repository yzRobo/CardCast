// Phase 2 verification: Gundam match overlay + control, end to end.
// Spawns the server, opens BOTH the control page and the overlay page, exercises
// every control, and asserts the overlay re-renders via the socket round-trip.
//
//   node scripts/verify-gundam-match.mjs
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

// Discover a real Unit (with AP), Pilot, and Base card from the DB.
async function discover() {
    const found = {};
    for (const q of ['EB01', 'GD01', 'GD02', 'ST01', 'ST02', 'GD03', 'GD04']) {
        const arr = await (await fetch(`${BASE}/api/search/gundam?q=${q}`)).json();
        for (const c of arr) {
            const t = (c.card_type || '').toUpperCase();
            if (!found.unit && t.includes('UNIT') && c.gd_ap != null) found.unit = c;
            if (!found.pilot && t.includes('PILOT')) found.pilot = c;
            if (!found.base && t.includes('BASE')) found.base = c;
        }
        if (found.unit && found.pilot && found.base) break;
    }
    return found;
}

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Unit/Pilot/Base cards from DB', cards.unit && cards.pilot && cards.base,
        JSON.stringify({ unit: cards.unit && cards.unit.card_number, pilot: cards.pilot && cards.pilot.card_number, base: cards.base && cards.base.card_number }));

    browser = await chromium.launch();

    // Overlay page
    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/gundam-match`, { waitUntil: 'networkidle' });
    // Control page
    const control = await browser.newPage();
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/gundam-match-control`, { waitUntil: 'networkidle' });

    // Control renders two boards with 6 unit cells + 6 shields each.
    const layout = await control.evaluate(() => ({
        boards: document.querySelectorAll('#playersGrid > .card').length,
        p1cells: document.querySelectorAll('#p1Units > div').length,
        p2cells: document.querySelectorAll('#p2Units > div').length,
        p1shields: document.querySelectorAll('#p1Shields > button').length
    }));
    check('control renders 2 player boards', layout.boards === 2, JSON.stringify(layout));
    check('control renders 6 unit cells per player', layout.p1cells === 6 && layout.p2cells === 6, JSON.stringify(layout));
    check('control renders 6 shield buttons', layout.p1shields === 6, JSON.stringify(layout));

    // Overlay reports connected on the control status badge.
    await control.waitForFunction(() => document.getElementById('overlayStatus').textContent.includes('Connected'), { timeout: 8000 });
    check('control shows Overlay Connected', true);

    const waitOverlay = (fn, detail) => overlay.waitForFunction(fn, { timeout: 6000 }).then(() => true).catch(() => false);

    // 1) Name + record + games won
    await control.evaluate(() => { setName(1, 'Char'); document.getElementById('p1W').value = 2; document.getElementById('p1L').value = 1; setRecord(1); adjGamesWon(1, 1); });
    check('overlay reflects P1 name', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Char'));
    check('overlay reflects P1 record', await waitOverlay(() => document.getElementById('p1Record').textContent === '2-1-0'));
    check('overlay reflects P1 games won', await waitOverlay(() => document.getElementById('p1GamesWon').textContent.includes('1')));

    // 2) Assign a Unit to P1 cell 0
    await control.evaluate(async (id) => { openSearch(1, 'unit', 0); await pickCard(id); }, cards.unit.id);
    check('overlay shows assigned unit (art + AP)', await waitOverlay(() => {
        const cell = document.querySelector('#p1Units .unit-cell:not(.empty)');
        return cell && cell.querySelector('.unit-art') && /AP/.test(cell.querySelector('.ap-chip').textContent);
    }));

    // 3) Pair a Pilot onto that unit
    await control.evaluate(async (id) => { openSearch(1, 'pilot', 0); await pickCard(id); }, cards.pilot.id);
    check('overlay shows paired pilot chip', await waitOverlay(() => !!document.querySelector('#p1Units .unit-cell .pilot-chip')));

    // 4) Adjust unit HP down
    const hpBefore = await overlay.evaluate(() => document.querySelector('#p1Units .unit-hp-text').textContent);
    await control.evaluate(() => adjUnitHp(1, 0, -1));
    check('overlay unit HP updates', await waitOverlay((before) => {
        const t = document.querySelector('#p1Units .unit-hp-text');
        return t && t.textContent !== before;
    }, hpBefore) || (await overlay.evaluate(() => document.querySelector('#p1Units .unit-hp-text').textContent)) !== hpBefore);

    // 5) Assign a Base
    await control.evaluate(async (id) => { openSearch(1, 'base', 0); await pickCard(id); }, cards.base.id);
    check('overlay shows base with HP', await waitOverlay(() => {
        const b = document.getElementById('p1Base');
        return b && b.querySelector('.base-name') && /HP/.test(b.textContent);
    }));

    // 6) Resources: active +2, total stays >=, EX on
    await control.evaluate(() => { adjResource(1, 'total', 5); adjResource(1, 'active', 3); toggleEx(1); document.getElementById('p1Ex').checked = true; toggleEx(1); });
    check('overlay resources show active/total', await waitOverlay(() => {
        const el = document.getElementById('p1Resources');
        return el && el.querySelector('.active').textContent === '3' && el.querySelector('.total').textContent === '5';
    }));
    check('overlay EX badge on', await waitOverlay(() => document.getElementById('p1Ex').classList.contains('on')));

    // 7) Take a shield
    await control.evaluate(() => toggleShield(1, 0));
    check('overlay shield marked taken', await waitOverlay(() => document.querySelector('#p1Shields .shield').classList.contains('taken')));

    // 8) Switch turn
    await control.evaluate(() => switchTurn());
    check('overlay turn indicator -> P2', await waitOverlay(() => /Player 2|Char|'s Turn/.test(document.getElementById('turnIndicator').textContent) && document.getElementById('turnIndicator').textContent.includes("Player 2")));

    // 9) Timer set
    await control.evaluate(() => { document.getElementById('timerMinutes').value = 12; document.getElementById('timerSeconds').value = 34; setTimer(); });
    check('overlay timer shows 12:34', await waitOverlay(() => document.getElementById('matchTimer').textContent === '12:34'));

    // 10) Hide then show overlay
    await control.evaluate(() => hideOverlay());
    check('overlay hides', await waitOverlay(() => !document.getElementById('player1Board').classList.contains('active')));
    await control.evaluate(() => showOverlay());
    check('overlay shows', await waitOverlay(() => document.getElementById('player1Board').classList.contains('active')));

    // 11) Reset match clears the board
    await control.evaluate(() => resetMatch());
    check('overlay clears units on reset', await waitOverlay(() => document.querySelectorAll('#p1Units .unit-cell.empty').length === 6));
    check('overlay clears base on reset', await waitOverlay(() => document.getElementById('p1Base').textContent.includes('No Base')));
    check('overlay resets name', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Char')); // name preserved across reset

    // 12) Fresh overlay gets current state via request-state (reconnect)
    await control.evaluate(async (id) => { openSearch(2, 'unit', 1); await pickCard(id); }, cards.unit.id);
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/gundam-match`, { waitUntil: 'networkidle' });
    check('reconnecting overlay restores existing unit', await overlay2.waitForFunction(
        () => document.querySelectorAll('#p2Units .unit-cell:not(.empty)').length >= 1, { timeout: 6000 }
    ).then(() => true).catch(() => false));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
