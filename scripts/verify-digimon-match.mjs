// Phase 2 verification: Digimon match overlay + control, end to end.
// Spawns the server, opens BOTH the control page and the overlay page, exercises
// every control, and asserts the overlay re-renders via the socket round-trip.
// Covers the TWO Digimon-unique mechanics: the per-player 5-card SECURITY loss
// track, and the SINGLE SHARED MEMORY gauge (-10..0..+10) in the center; plus the
// battle area (DP/level + digivolution stack badge), breeding, tamers and counts.
//
//   node scripts/verify-digimon-match.mjs
import { spawn, execSync } from 'node:child_process';
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
// Kill any stale server holding port 3888 so we always test the CURRENT code
// (the overlay hardcodes localhost:3888, so we cannot use another port).
function killPort(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
        const pids = new Set();
        out.split(/\r?\n/).forEach(l => {
            if (l.includes(`:${port} `) && /LISTENING/i.test(l)) {
                const cols = l.trim().split(/\s+/); const pid = cols[cols.length - 1];
                if (pid && pid !== '0') pids.add(pid);
            }
        });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} });
    } catch {}
}

// Discover a real Digimon (with DP), a Digi-Egg and a Tamer from the DB.
async function discover() {
    const found = {};
    const queries = ['Agumon', 'Greymon', 'Gabumon', 'Yokomon', 'Koromon', 'Tsunomon', 'Tai Kamiya', 'Matt Ishida', 'Sora', 'Tokomon'];
    for (const q of queries) {
        const arr = await (await fetch(`${BASE}/api/search/digimon?q=${encodeURIComponent(q)}`)).json();
        for (const c of arr) {
            const t = (c.card_type || '').toLowerCase();
            if (!found.digimon && t === 'digimon' && c.dp != null && c.dp > 0) found.digimon = c;
            if (!found.egg && t.includes('egg')) found.egg = c;
            if (!found.tamer && t.includes('tamer')) found.tamer = c;
        }
        if (found.digimon && found.egg && found.tamer) break;
    }
    return found;
}

killPort(3888);
const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Digimon/Digi-Egg/Tamer from DB', cards.digimon && cards.egg && cards.tamer,
        JSON.stringify({ digimon: cards.digimon && cards.digimon.name, dp: cards.digimon && cards.digimon.dp,
            egg: cards.egg && cards.egg.name, tamer: cards.tamer && cards.tamer.name }));

    browser = await chromium.launch();

    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/digimon-match`, { waitUntil: 'networkidle' });
    const control = await browser.newPage();
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/digimon-match-control`, { waitUntil: 'networkidle' });

    // Control renders two boards with 6 battle slots + 5 security pips each, plus the
    // SHARED memory slider, breeding, tamers and counts.
    const layout = await control.evaluate(() => ({
        boards: document.querySelectorAll('#playersGrid > .card').length,
        p1battle: document.querySelectorAll('#p1Battle > div').length,
        p2battle: document.querySelectorAll('#p2Battle > div').length,
        p1secpips: document.querySelectorAll('#p1SecPips .sec-pip').length,
        memSlider: !!document.getElementById('memorySlider'),
        p1breed: !!document.getElementById('p1Breed'),
        p1tamers: !!document.getElementById('p1Tamers'),
        p1counts: document.querySelectorAll('#p1Counts .join').length
    }));
    check('control renders 2 player boards', layout.boards === 2, JSON.stringify(layout));
    check('control renders 6 battle slots per player', layout.p1battle === 6 && layout.p2battle === 6, JSON.stringify(layout));
    check('control renders 5 security pips per player', layout.p1secpips === 5, JSON.stringify(layout));
    check('control has the SHARED memory slider', layout.memSlider, JSON.stringify(layout));
    check('control has breeding + tamers + 4 count steppers', layout.p1breed && layout.p1tamers && layout.p1counts === 4, JSON.stringify(layout));

    // Overlay: 5-pip security track + the 21-cell shared memory gauge.
    const overlayLayout = await overlay.evaluate(() => ({
        secpips: document.querySelectorAll('#p1SecTrack .sec-pip').length,
        memcells: document.querySelectorAll('#memTrack .mem-cell').length,
        battlecells: document.querySelectorAll('#p1Battle .battle-cell').length
    }));
    check('overlay security track has 5 pips', overlayLayout.secpips === 5, JSON.stringify(overlayLayout));
    check('overlay shared memory gauge has 21 cells (-10..+10)', overlayLayout.memcells === 21, JSON.stringify(overlayLayout));
    check('overlay battle area has 6 cells', overlayLayout.battlecells === 6, JSON.stringify(overlayLayout));

    // Overlay reports connected on the control status badge.
    await control.waitForFunction(() => document.getElementById('overlayStatus').textContent.includes('Connected'), { timeout: 8000 });
    check('control shows Overlay Connected', true);

    const waitOverlay = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // 1) Name + record + games won
    await control.evaluate(() => { setName(1, 'Tai'); document.getElementById('p1W').value = 2; document.getElementById('p1L').value = 1; setRecord(1); adjGamesWon(1, 1); });
    check('overlay reflects P1 name', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Tai'));
    check('overlay reflects P1 record', await waitOverlay(() => document.getElementById('p1Record').textContent === '2-1-0'));
    check('overlay reflects P1 games won', await waitOverlay(() => document.getElementById('p1GamesWon').textContent.includes('1')));

    // 2) SHARED memory gauge: +3 fills 3 cells on P2's side, readout names P2
    await control.evaluate(() => setMemory(3));
    check('overlay memory fills 3 cells on P2 side', await waitOverlay(() => document.querySelectorAll('#memTrack .mem-cell.fill-p2').length === 3));
    check('overlay memory readout names P2 side', await waitOverlay(() => document.getElementById('memReadout').textContent.includes('Player 2')));
    check('overlay memory marker present at value', await waitOverlay(() => document.querySelectorAll('#memTrack .mem-cell.marker').length === 1));

    // 3) Memory to the P1 side (-5) fills 5 P1 cells; clamps at +/-10
    await control.evaluate(() => setMemory(-5));
    check('overlay memory fills 5 cells on P1 side', await waitOverlay(() => document.querySelectorAll('#memTrack .mem-cell.fill-p1').length === 5));
    check('overlay memory readout names P1 side', await waitOverlay(() => document.getElementById('memReadout').textContent.includes('Tai')));
    await control.evaluate(() => setMemory(99));
    check('overlay memory clamps to +10 (10 P2 cells)', await waitOverlay(() => document.querySelectorAll('#memTrack .mem-cell.fill-p2').length === 10));
    await control.evaluate(() => setMemory(0));
    check('overlay memory neutral at 0 (no fills)', await waitOverlay(() => document.querySelectorAll('#memTrack .mem-cell.fill-p1, #memTrack .mem-cell.fill-p2').length === 0));

    // 4) SECURITY: toggle one card taken -> count 4 + one X'd pip; reset -> 5
    await control.evaluate(() => toggleSecurity(1, 0));
    check('overlay security count drops to 4', await waitOverlay(() => document.getElementById('p1Sec').textContent === '4'));
    check('overlay marks 1 security pip taken', await waitOverlay(() => document.querySelectorAll('#p1SecTrack .sec-pip.taken').length === 1));
    await control.evaluate(() => resetSecurity(1));
    check('overlay security resets to 5', await waitOverlay(() => document.getElementById('p1Sec').textContent === '5' && document.querySelectorAll('#p1SecTrack .sec-pip.taken').length === 0));

    // 5) Battle area: add a Digimon -> DP stat chip shows; stack +1 -> x2 badge; remove
    await control.evaluate(async (id) => { openSearch(1, 'battle', 0); await pickCard(id); }, cards.digimon.id);
    check('overlay battle cell shows DP stat', await waitOverlay(() => {
        const cell = document.querySelector('#p1Battle .battle-cell:not(.empty)');
        return cell && cell.querySelector('.stat.dp');
    }));
    await control.evaluate(() => adjStack(1, 0, 1));
    check('overlay shows digivolution stack badge x2', await waitOverlay(() => {
        const b = document.querySelector('#p1Battle .battle-cell:not(.empty) .stack-badge');
        return b && b.textContent.includes('x2');
    }));
    await control.evaluate(() => removeBattle(1, 0));
    check('overlay battle cell cleared on remove', await waitOverlay(() => document.querySelectorAll('#p1Battle .battle-cell.empty').length === 6));

    // 6) Breeding: add an egg/rookie -> overlay shows it
    await control.evaluate(async (id) => { openSearch(1, 'breeding', 0); await pickCard(id); }, cards.egg.id);
    check('overlay breeding slot shows a card', await waitOverlay(() => {
        const cell = document.querySelector('#p1Breed .breed-cell:not(.empty)');
        const name = document.querySelector('#p1Breed .breed-name');
        return cell && name && name.textContent.length > 0;
    }));

    // 7) Tamers: add a Tamer -> overlay shows a chip
    await control.evaluate(async (id) => { openSearch(1, 'tamer', 0); await pickCard(id); }, cards.tamer.id);
    check('overlay tamers row shows a chip', await waitOverlay(() => document.querySelectorAll('#p1Tamers .tamer-chip').length >= 1));

    // 8) Zone counts: bump Hand to 3 -> overlay first count reads 3
    await control.evaluate(() => { adjCount(1, 'hand', 1); adjCount(1, 'hand', 1); adjCount(1, 'hand', 1); });
    check('overlay Hand count shows 3', await waitOverlay(() => {
        const v = document.querySelectorAll('#p1Counts .count-val')[0];
        return v && v.textContent === '3';
    }));

    // 9) Switch turn
    await control.evaluate(() => switchTurn());
    check('overlay turn indicator -> P2', await waitOverlay(() => document.getElementById('turnIndicator').textContent.includes('Player 2')));

    // 10) Timer set
    await control.evaluate(() => { document.getElementById('timerMinutes').value = 12; document.getElementById('timerSeconds').value = 34; setTimer(); });
    check('overlay timer shows 12:34', await waitOverlay(() => document.getElementById('matchTimer').textContent === '12:34'));

    // 11) Hide then show overlay (incl. the shared memory gauge)
    await control.evaluate(() => hideOverlay());
    check('overlay hides', await waitOverlay(() => !document.getElementById('player1Board').classList.contains('active')));
    await control.evaluate(() => showOverlay());
    check('overlay shows (memory gauge active)', await waitOverlay(() =>
        document.getElementById('player1Board').classList.contains('active') &&
        document.getElementById('memoryGauge').classList.contains('active')));

    // 12) Reset clears the board (name preserved, memory 0, security 5)
    await control.evaluate(() => { setMemory(4); resetMatch(); });
    check('overlay clears battle on reset', await waitOverlay(() => document.querySelectorAll('#p1Battle .battle-cell.empty').length === 6));
    check('overlay resets memory to neutral', await waitOverlay(() => document.querySelectorAll('#memTrack .mem-cell.fill-p1, #memTrack .mem-cell.fill-p2').length === 0));
    check('overlay resets security to 5', await waitOverlay(() => document.getElementById('p1Sec').textContent === '5'));
    check('overlay preserves name across reset', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Tai'));

    // 13) Fresh overlay restores current state via request-state (reconnect)
    await control.evaluate(async (id) => { setMemory(-2); openSearch(2, 'battle', 1); await pickCard(id); }, cards.digimon.id);
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/digimon-match`, { waitUntil: 'networkidle' });
    check('reconnecting overlay restores battle unit', await overlay2.waitForFunction(
        () => document.querySelectorAll('#p2Battle .battle-cell:not(.empty)').length >= 1, { timeout: 6000 }
    ).then(() => true).catch(() => false));
    check('reconnecting overlay restores shared memory (-2)', await overlay2.waitForFunction(
        () => document.querySelectorAll('#memTrack .mem-cell.fill-p1').length === 2, { timeout: 6000 }
    ).then(() => true).catch(() => false));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
    killPort(3888);
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
