// Phase 2/3 verification: One Piece match overlay + control, end to end.
// Spawns the server, opens BOTH the control page and the overlay page, exercises
// every control, and asserts the overlay re-renders via the socket round-trip.
// Also covers the deck-aware Phase 3 path (Leader picker seeds Life from the
// Leader's life; quick-add prefills Power from op_power).
//
//   node scripts/verify-onepiece-match.mjs
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

// Discover a real Leader (with life), Character (with op_power), Stage and Event.
async function discover() {
    const found = {};
    const queries = ['OP01-001', 'Roronoa Zoro', 'Monkey', 'Nami', 'Loguetown', 'Mini-Merry', 'Usopp', 'Luffy'];
    for (const q of queries) {
        const arr = await (await fetch(`${BASE}/api/search/onepiece?q=${encodeURIComponent(q)}`)).json();
        for (const c of arr) {
            const t = (c.card_type || '').toLowerCase();
            if (!found.leader && t.includes('leader') && c.life != null) found.leader = c;
            if (!found.character && t.includes('character') && c.op_power != null) found.character = c;
            if (!found.stage && t.includes('stage')) found.stage = c;
        }
        if (found.leader && found.character && found.stage) break;
    }
    return found;
}

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Leader/Character/Stage from DB', cards.leader && cards.character && cards.stage,
        JSON.stringify({ leader: cards.leader && cards.leader.name, life: cards.leader && cards.leader.life,
            character: cards.character && cards.character.name, power: cards.character && cards.character.op_power,
            stage: cards.stage && cards.stage.name }));

    browser = await chromium.launch();

    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/onepiece-match`, { waitUntil: 'networkidle' });
    const control = await browser.newPage();
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/onepiece-match-control`, { waitUntil: 'networkidle' });

    // Control renders two boards with 5 character slots each.
    const layout = await control.evaluate(() => ({
        boards: document.querySelectorAll('#playersGrid > .card').length,
        p1chars: document.querySelectorAll('#p1Chars > div').length,
        p2chars: document.querySelectorAll('#p2Chars > div').length,
        p1leader: !!document.getElementById('p1Leader'),
        p1donMax: document.getElementById('p1DonMax') && document.getElementById('p1DonMax').value
    }));
    check('control renders 2 player boards', layout.boards === 2, JSON.stringify(layout));
    check('control renders 5 character slots per player', layout.p1chars === 5 && layout.p2chars === 5, JSON.stringify(layout));
    check('control has Leader slot + DON max 10', layout.p1leader && layout.p1donMax === '10', JSON.stringify(layout));

    // Overlay reports connected on the control status badge.
    await control.waitForFunction(() => document.getElementById('overlayStatus').textContent.includes('Connected'), { timeout: 8000 });
    check('control shows Overlay Connected', true);

    const waitOverlay = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // 1) Name + record + games won
    await control.evaluate(() => { setName(1, 'Shanks'); document.getElementById('p1W').value = 2; document.getElementById('p1L').value = 1; setRecord(1); adjGamesWon(1, 1); });
    check('overlay reflects P1 name', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Shanks'));
    check('overlay reflects P1 record', await waitOverlay(() => document.getElementById('p1Record').textContent === '2-1-0'));
    check('overlay reflects P1 games won', await waitOverlay(() => document.getElementById('p1GamesWon').textContent.includes('1')));

    // 2) Assign Leader -> featured card + Power + Life seeded from leader.life
    const leaderLife = cards.leader.life;
    await control.evaluate(async (id) => { openSearch(1, 'leader', 0); await pickCard(id); }, cards.leader.id);
    check('overlay shows Leader name + power chip', await waitOverlay(() => {
        const el = document.getElementById('p1Leader');
        return el && el.querySelector('.leader-name') && el.querySelector('.leader-name').textContent.length > 0;
    }));
    check(`overlay Life track seeded to leader life (${leaderLife})`, await waitOverlay((life) => {
        return document.querySelectorAll('#p1Life .life-pip').length === life;
    }, leaderLife));
    check('overlay shows Leader color dots', await waitOverlay(() => document.querySelectorAll('#p1Leader .color-dot').length >= 1));

    // 3) Take a Life card -> pip marked taken, remaining decremented
    await control.evaluate(() => toggleLife(1, 0));
    check('overlay marks Life pip taken', await waitOverlay(() => document.querySelector('#p1Life .life-pip.taken') !== null));
    check('overlay Life remaining decremented', await waitOverlay((life) =>
        document.getElementById('p1LifeCount').textContent.trim().startsWith(String(life - 1)), leaderLife));

    // 4) DON!! counter: active + rested
    await control.evaluate(() => { adjDon(1, 'active', 5); adjDon(1, 'rested', 2); });
    check('overlay DON active shows 5', await waitOverlay(() => document.getElementById('p1DonActive').textContent === '5'));
    check('overlay DON rested label shows 2', await waitOverlay(() => document.getElementById('p1DonRested').textContent.includes('2')));
    check('overlay DON track has 5 active + 2 rested pips', await waitOverlay(() =>
        document.querySelectorAll('#p1DonTrack .don-pip.active').length === 5 &&
        document.querySelectorAll('#p1DonTrack .don-pip.rested').length === 2));

    // 5) Add a Character -> art + Power (prefilled from op_power)
    const charPower = parseInt(cards.character.op_power) || 0;
    await control.evaluate(async (id) => { openSearch(1, 'character', 0); await pickCard(id); }, cards.character.id);
    check('overlay shows character with power readout', await waitOverlay((p) => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        return cell && cell.querySelector('.char-power') && cell.querySelector('.char-power').textContent.includes(String(p));
    }, charPower));

    // 6) Attach DON!! to the character -> +1000 power boost shown
    await control.evaluate(() => { adjCharDon(1, 0, 2); });
    check('overlay character shows +2000 DON boost', await waitOverlay((p) => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        if (!cell) return false;
        const txt = cell.querySelector('.char-power').textContent;
        return txt.includes(String(p + 2000)) && cell.querySelectorAll('.char-don').length === 2;
    }, charPower));

    // 7) Assign a Stage
    await control.evaluate(async (id) => { openSearch(1, 'stage', 0); await pickCard(id); }, cards.stage.id);
    check('overlay shows Stage name', await waitOverlay(() => {
        const s = document.getElementById('p1Stage');
        return s && s.querySelector('.stage-name') && s.querySelector('.stage-name').textContent.length > 0;
    }));

    // 8) Switch turn
    await control.evaluate(() => switchTurn());
    check('overlay turn indicator -> P2', await waitOverlay(() => document.getElementById('turnIndicator').textContent.includes('Player 2')));

    // 9) Timer set
    await control.evaluate(() => { document.getElementById('timerMinutes').value = 12; document.getElementById('timerSeconds').value = 34; setTimer(); });
    check('overlay timer shows 12:34', await waitOverlay(() => document.getElementById('matchTimer').textContent === '12:34'));

    // 10) Manual Life total override (independent of leader)
    await control.evaluate(() => setLifeTotal(1, 6));
    check('overlay Life total override -> 6 pips', await waitOverlay(() => document.querySelectorAll('#p1Life .life-pip').length === 6));

    // 11) Hide then show overlay
    await control.evaluate(() => hideOverlay());
    check('overlay hides', await waitOverlay(() => !document.getElementById('player1Board').classList.contains('active')));
    await control.evaluate(() => showOverlay());
    check('overlay shows', await waitOverlay(() => document.getElementById('player1Board').classList.contains('active')));

    // 12) Reset clears the board (name preserved)
    await control.evaluate(() => resetMatch());
    check('overlay clears characters on reset', await waitOverlay(() => document.querySelectorAll('#p1Chars .char-cell.empty').length === 5));
    check('overlay clears Leader on reset', await waitOverlay(() => document.querySelector('#p1Leader .leader-none') !== null));
    check('overlay preserves name across reset', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Shanks'));

    // 13) Fresh overlay restores current state via request-state (reconnect)
    await control.evaluate(async (id) => { openSearch(2, 'character', 1); await pickCard(id); }, cards.character.id);
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/onepiece-match`, { waitUntil: 'networkidle' });
    check('reconnecting overlay restores existing character', await overlay2.waitForFunction(
        () => document.querySelectorAll('#p2Chars .char-cell:not(.empty)').length >= 1, { timeout: 6000 }
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
