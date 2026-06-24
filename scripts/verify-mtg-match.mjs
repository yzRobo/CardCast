// Phase 1 verification: MTG match overlay (overlays/mtg-match.html), render-only.
// Drives the real mtg-* socket events through the server (as a control would) and
// asserts the rebuilt overlay re-renders. Also checks the de-Commander refactor
// and the two wiring-bug fixes (record event name, player-switch passthrough).
//
//   node scripts/verify-mtg-match.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const results = [];
const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`);
};
async function isUp() {
    try { const r = await fetch(BASE + '/api/config'); return r.ok; } catch { return false; }
}
async function waitForServer(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isUp()) return true;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('server did not start in time');
}

// Reuse a running server if present; otherwise spawn one (and kill it at the end).
const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();

    const overlay = await browser.newPage();
    overlay.on('pageerror', e => console.log('PAGE ERROR:', e.message));
    // domcontentloaded (not networkidle): the overlay holds a persistent socket.io
    // connection, so the network never goes fully idle. We gate on DOM state instead.
    await overlay.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    await overlay.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });
    check('overlay connects to server', true);

    // Dedicated driver socket on the overlay page (separate from the overlay's
    // own render-only socket). socket.io buffers emits until connected.
    await overlay.evaluate(() => { window.__drv = io(); });
    await overlay.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (event, data) => overlay.evaluate(([e, d]) => window.__drv.emit(e, d), [event, data]);
    const wait = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // De-Commander: overlay has zero Commander DOM / text.
    const commanderDom = await overlay.evaluate(() =>
        document.querySelectorAll('[class*="commander"],[id*="commander"]').length +
        (/commander/i.test(document.body.innerHTML) ? 1 : 0));
    check('overlay has no Commander UI', commanderDom === 0, `found ${commanderDom}`);

    // Default render: 20 life, healthy, poison hidden, Standard label.
    check('P1 starts at 20 life (healthy)', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '20' && el.classList.contains('life-healthy');
    }));
    check('poison hidden at 0', await overlay.evaluate(() => getComputedStyle(document.getElementById('p1-poison')).display === 'none'));
    check('format label defaults to Standard', await overlay.evaluate(() => document.getElementById('format-label').textContent === 'Standard'));

    // Life thresholds
    await emit('mtg-life-update', { player: 1, life: 9 });
    check('life 9 -> warning', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '9' && el.classList.contains('life-warning');
    }));
    await emit('mtg-life-update', { player: 1, life: 3 });
    check('life 3 -> critical', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '3' && el.classList.contains('life-critical');
    }));

    // Poison (alt loss condition): appears > 0, lethal at 10
    await emit('mtg-poison-update', { player: 1, poison: 4 });
    check('poison 4 shows', await wait(() => {
        const el = document.getElementById('p1-poison');
        return getComputedStyle(el).display !== 'none' && document.getElementById('p1-poison-val').textContent === '4';
    }));
    await emit('mtg-poison-update', { player: 1, poison: 10 });
    check('poison 10 -> lethal', await wait(() => document.getElementById('p1-poison').classList.contains('lethal')));

    // Lands
    await emit('mtg-lands-update', { player: 1, lands: 5 });
    check('lands 5', await wait(() => document.getElementById('p1-lands').textContent === '5'));

    // Turn flags (control emits mtg-turn-action; server re-emits mtg-turn-actions-update)
    await emit('mtg-turn-action', { player: 1, action: 'landPlayed', value: true });
    await emit('mtg-turn-action', { player: 1, action: 'spellCast', value: true });
    check('Land flag active', await wait(() => document.getElementById('p1-land-flag').classList.contains('active')));
    check('Spell flag active', await wait(() => document.getElementById('p1-spell-flag').classList.contains('active')));

    // Featured permanents (art + name only)
    await emit('mtg-permanent-add', { player: 1, card: { id: 't1', name: 'Lightning Bolt', image_url: '' } });
    check('featured permanent added (count + card)', await wait(() => {
        const cards = document.querySelectorAll('#p1-featured .perm-card');
        return cards.length === 1 && document.getElementById('p1-perm-count').textContent === '1' &&
            /Lightning Bolt/.test(document.querySelector('#p1-featured .perm-name').textContent);
    }));

    // Phase
    await emit('mtg-phase-update', { phase: 'combat' });
    check('phase -> Combat', await wait(() => document.getElementById('phase-text').textContent === 'Combat'));

    // Name / record / games-won. Record exercises bug #1 (server emits mtg-record-update).
    await emit('mtg-player-name-update', { player: 2, name: 'Jace' });
    check('P2 name', await wait(() => document.getElementById('p2-name').textContent === 'Jace'));
    await emit('mtg-player-record-update', { player: 1, record: '2-1-0' });
    check('P1 record reaches overlay (record-event fix)', await wait(() => document.getElementById('p1-record').textContent === '2-1-0'));
    await emit('mtg-games-won-update', { player: 1, gamesWon: 1 });
    check('P1 games won', await wait(() => document.getElementById('p1-games').textContent === '1'));

    // Active player passthrough (bug #2): set active directly to P2.
    await emit('mtg-player-switch', { activePlayer: 2 });
    check('active player -> P2 (set, not toggle)', await wait(() =>
        document.getElementById('p2-board').classList.contains('active') &&
        !document.getElementById('p1-board').classList.contains('active')));
    check('turn label shows P2 name', await wait(() => document.getElementById('turn-text').textContent === "Jace's Turn"));

    // Format is label-only: changing it must NOT change life (still 3 / critical).
    await emit('mtg-format-update', { format: 'Modern' });
    check('format label -> Modern', await wait(() => document.getElementById('format-label').textContent === 'Modern'));
    check('format change does NOT alter life', await overlay.evaluate(() => document.getElementById('p1-life').textContent === '3'));

    // Timer
    await emit('mtg-timer-update', { seconds: 754 });
    check('timer shows 12:34', await wait(() => document.getElementById('timer-text').textContent === '12:34'));

    // Reconnecting overlay hydrates current server state via request-state.
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    check('fresh overlay restores life 3', await overlay2.waitForFunction(
        () => document.getElementById('p1-life').textContent === '3', { timeout: 6000 }).then(() => true).catch(() => false));
    check('fresh overlay restores P2 name Jace', await overlay2.evaluate(() => document.getElementById('p2-name').textContent === 'Jace'));

    // Reset returns life to 20, preserves names, hides poison (overlay reloads).
    await emit('mtg-match-reset', {});
    await overlay.waitForTimeout(800); // let location.reload() begin before we re-bind
    await overlay.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });
    check('reset -> life back to 20', await wait(() => document.getElementById('p1-life').textContent === '20'));
    check('reset -> poison hidden', await overlay.evaluate(() => getComputedStyle(document.getElementById('p1-poison')).display === 'none'));
    check('reset preserves P2 name', await overlay.evaluate(() => document.getElementById('p2-name').textContent === 'Jace'));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
