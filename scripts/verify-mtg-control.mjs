// Phase 2 verification: MTG match control (mtg-match-control.html) drives the
// rebuilt overlay end to end over the mtg-* socket events. Opens BOTH pages,
// exercises every control, and asserts the overlay re-renders. Also confirms the
// control has zero Commander UI and hydrates a fresh control via request-state.
//
//   node scripts/verify-mtg-control.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const results = [];
const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`);
};
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };
async function waitForServer(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) { if (await isUp()) return true; await new Promise(r => setTimeout(r, 300)); }
    throw new Error('server did not start in time');
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    // A real Magic card for the featured-permanent search.
    const search = await (await fetch(`${BASE}/api/search/magic?q=bolt`)).json();
    const sample = (search || [])[0];
    check('found a Magic card to search', !!sample, JSON.stringify(sample && sample.name));

    browser = await chromium.launch();

    const overlay = await browser.newPage();
    overlay.on('pageerror', e => console.log('OVERLAY ERROR:', e.message));
    await overlay.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    await overlay.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });

    const control = await browser.newPage();
    control.on('pageerror', e => console.log('CONTROL ERROR:', e.message));
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/mtg-match-control`, { waitUntil: 'domcontentloaded' });

    const waitO = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);
    const waitC = (fn, arg) => control.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // Control structure + de-Commander
    const struct = await control.evaluate(() => ({
        phaseBtns: document.querySelectorAll('.phase-btn').length,
        commander: document.querySelectorAll('[id*="commander" i],[class*="commander" i]').length,
        commanderText: /commander/i.test(document.body.innerHTML) ? 1 : 0,
        formatHas40: /40\s*life|commander/i.test(document.getElementById('format-selector').innerHTML) ? 1 : 0,
        poisonInputs: document.querySelectorAll('#p1-poison, #p2-poison').length
    }));
    check('control has 7 phase buttons', struct.phaseBtns === 7, JSON.stringify(struct));
    check('control has NO Commander UI', struct.commander === 0 && struct.commanderText === 0, JSON.stringify(struct));
    check('format selector has no Commander/40-life option', struct.formatHas40 === 0, JSON.stringify(struct));
    check('control has poison steppers', struct.poisonInputs === 2, JSON.stringify(struct));

    // Overlay-connected badge
    check('control shows Overlay Connected', await waitC(() => document.getElementById('overlayStatus').textContent.includes('Overlay Connected')));

    // Name + record (record exercises the mtg-record-update fix)
    await control.fill('#p1-name', 'Liliana');
    await control.dispatchEvent('#p1-name', 'change');
    check('overlay reflects P1 name', await waitO(() => document.getElementById('p1-name').textContent === 'Liliana'));
    await control.fill('#p1-record', '2-1-0');
    await control.dispatchEvent('#p1-record', 'change');
    check('overlay reflects P1 record', await waitO(() => document.getElementById('p1-record').textContent === '2-1-0'));

    // Games won
    await control.click('button[onclick="adjustGamesWon(1, 1)"]');
    check('overlay reflects P1 games won', await waitO(() => document.getElementById('p1-games').textContent === '1'));

    // Life: -5 twice -> 10 (warning)
    await control.click('button[onclick="adjustLife(1, -5)"]');
    await control.click('button[onclick="adjustLife(1, -5)"]');
    check('overlay life 10 + warning', await waitO(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '10' && el.classList.contains('life-warning');
    }));
    check('control life input shows warning', await waitC(() => document.getElementById('p1-life').classList.contains('life-warning')));

    // Poison +4
    for (let i = 0; i < 4; i++) await control.click('button[onclick="adjustPoison(1, 1)"]');
    check('overlay poison shows 4', await waitO(() => {
        const el = document.getElementById('p1-poison');
        return getComputedStyle(el).display !== 'none' && document.getElementById('p1-poison-val').textContent === '4';
    }));

    // Lands +5 (exercises the {lands:} payload fix)
    for (let i = 0; i < 5; i++) await control.click('button[onclick="adjustLands(1, 1)"]');
    check('overlay lands shows 5', await waitO(() => document.getElementById('p1-lands').textContent === '5'));

    // Turn flags
    await control.check('#p1-land-played');
    await control.check('#p1-spell-cast');
    check('overlay Land flag active', await waitO(() => document.getElementById('p1-land-flag').classList.contains('active')));
    check('overlay Spell flag active', await waitO(() => document.getElementById('p1-spell-flag').classList.contains('active')));

    // Phase: click Combat, then step to Main 2
    await control.click('.phase-btn[data-phase="combat"]');
    check('overlay phase -> Combat', await waitO(() => document.getElementById('phase-text').textContent === 'Combat'));
    await control.click('button[onclick="stepPhase(1)"]');
    check('overlay phase steps -> Main 2', await waitO(() => document.getElementById('phase-text').textContent === 'Main 2'));

    // Featured permanent via the search modal
    await control.click('button[onclick="openCardSearch(1)"]');
    await control.fill('#card-search-input', 'bolt');
    await control.waitForSelector('#card-search-results .card-result', { timeout: 6000 });
    await control.click('#card-search-results .card-result');
    check('overlay shows a featured permanent', await waitO(() => document.querySelectorAll('#p1-featured .perm-card').length >= 1));
    check('control mirrors the featured permanent', await waitC(() => document.querySelectorAll('#p1-featured-cards .featured-card').length >= 1));

    // Remove the featured permanent
    await control.click('#p1-featured-cards .featured-card .remove-btn');
    check('overlay clears the featured permanent', await waitO(() => document.querySelectorAll('#p1-featured .perm-card').length === 0));

    // Set Active P2
    await control.click('#set-active-p2');
    check('overlay active -> P2', await waitO(() =>
        document.getElementById('p2-board').classList.contains('active') &&
        !document.getElementById('p1-board').classList.contains('active')));
    check('control highlights P2 card', await waitC(() => document.getElementById('player2-card').classList.contains('player-card-active')));

    // Format label only (life must not change)
    await control.selectOption('#format-selector', 'Modern');
    check('overlay format -> Modern', await waitO(() => document.getElementById('format-label').textContent === 'Modern'));
    check('format change did NOT alter life', await overlay.evaluate(() => document.getElementById('p1-life').textContent === '10'));

    // Timer set 12:34
    await control.fill('#timer-minutes', '12');
    await control.fill('#timer-seconds', '34');
    await control.click('#timer-set');
    check('overlay timer -> 12:34', await waitO(() => document.getElementById('timer-text').textContent === '12:34'));
    check('control timer display -> 12:34', await waitC(() => document.getElementById('timer-display').textContent === '12:34'));

    // Reset match
    await control.click('#reset-match');
    check('overlay life resets to 20', await waitO(() => document.getElementById('p1-life').textContent === '20'));
    check('overlay poison hidden after reset', await waitO(() => getComputedStyle(document.getElementById('p1-poison')).display === 'none'));
    check('control life input resets to 20', await waitC(() => document.getElementById('p1-life').value === '20'));
    check('control poison resets to 0', await waitC(() => document.getElementById('p1-poison').value === '0'));
    check('reset preserves P1 name on control', await waitC(() => document.getElementById('p1-name').value === 'Liliana'));

    // Fresh control hydrates from server via request-state
    const control2 = await browser.newPage();
    await control2.goto(`${BASE}/mtg-match-control`, { waitUntil: 'domcontentloaded' });
    check('fresh control hydrates format Modern', await control2.waitForFunction(
        () => document.getElementById('format-selector').value === 'Modern', { timeout: 6000 }).then(() => true).catch(() => false));
    check('fresh control hydrates life 20', await control2.evaluate(() => document.getElementById('p1-life').value === '20'));
    check('fresh control hydrates P1 name', await control2.evaluate(() => document.getElementById('p1-name').value === 'Liliana'));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
