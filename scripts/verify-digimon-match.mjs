// Verification: Digimon match overlay + control, end to end.
// Opens BOTH the control page and the overlay page, exercises every control, and
// asserts the overlay re-renders via the socket round-trip. Covers the TWO
// Digimon-unique mechanics: the per-player 5-card SECURITY loss track, and the
// SINGLE SHARED MEMORY gauge (-10..0..+10) in the center; plus the battle area
// (DP/level + digivolution stack badge), breeding, tamers and counts.
//
// Part 2 covers the polish pass: active-player emphasis, render caching, the
// idle-slot drift motif, the change tickers and overflow safety. Those checks
// assert GEOMETRY (bounding rects, scrollWidth vs clientWidth, computed
// opacity) rather than DOM presence - a ticker can exist and still render zero
// visible pixels if an ancestor clips it.
//
//   node scripts/verify-digimon-match.mjs
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
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

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

// Reuse a dev server if one is already listening; pages are served from disk on
// every request, so a running server still serves the current overlay code.
// Never kill a server this script did not start - other harnesses share 3888.
const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Digimon/Digi-Egg/Tamer from DB', cards.digimon && cards.egg && cards.tamer,
        JSON.stringify({ digimon: cards.digimon && cards.digimon.name, dp: cards.digimon && cards.digimon.dp,
            egg: cards.egg && cards.egg.name, tamer: cards.tamer && cards.tamer.name }));

    browser = await chromium.launch();

    const overlay = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const pageErrors = [];
    overlay.on('pageerror', e => pageErrors.push(e.message));
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

    // 4) SECURITY: toggle one card taken -> count 4 + one spent marker; reset -> 5
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
    await overlay2.close();

    // ==================================================================
    // Part 2 - the polish pass. Driven straight over a socket so the exact
    // payload (including legacy shapes) is under test control.
    //
    // The control page must go first: the server broadcasts `overlay-connected`
    // on every `register-overlay` ping (the overlay sends one every 5s), and the
    // control answers each one by re-pushing its entire state. With it open, any
    // socket-driven scenario is silently overwritten within five seconds.
    // ==================================================================
    await control.close();
    await overlay.evaluate(() => { window.__drv = io(); });
    await overlay.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = async (e, d) => {
        await overlay.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);
        await overlay.waitForTimeout(140);
    };
    const evalOverlay = fn => overlay.evaluate(fn);

    // A visibility helper matching the Pokemon harness: walk up to every
    // clipping ancestor and confirm the element is actually inside it.
    const VISIBLE_FN = `(sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (parseFloat(getComputedStyle(el).opacity) === 0) return false;
        let node = el.parentElement;
        while (node && node !== document.body) {
            const st = getComputedStyle(node);
            if (st.overflow !== 'visible') {
                const nr = node.getBoundingClientRect();
                if (r.bottom <= nr.top || r.top >= nr.bottom || r.right <= nr.left || r.left >= nr.right) return false;
            }
            node = node.parentElement;
        }
        return true;
    }`;
    const isVisible = sel => overlay.evaluate(new Function('sel', `return (${VISIBLE_FN})(sel);`), sel);

    await emit('toggle-digimon-match', { show: true });
    await emit('digimon-match-reset', {});

    const wg = { id: 'wg', name: 'WarGreymon', image: '/images/card-back.png', dp: 12000, level: 6, colors: 'Red', stack: 1 };
    const gg = { id: 'gg', name: 'Garurumon', image: '/images/card-back.png', dp: 6000, level: 4, colors: 'Blue', stack: 1 };
    // A unit stored before the polish pass: no dp / level / colors / stack.
    const legacyUnit = { id: 'lg', name: 'Betamon', image: '/images/card-back.png' };

    await emit('digimon-match-update', {
        memory: 0,
        player1: {
            name: 'Takeru', record: { wins: 3, losses: 1, ties: 0 }, gamesWon: 1,
            security: 5, securityTaken: [],
            battle: [wg, null, null, null, null, null],
            breeding: null, tamers: [],
            counts: { hand: 5, deck: 30, trash: 2, eggDeck: 4 }
        },
        player2: {
            name: 'Yamato', record: { wins: 3, losses: 1, ties: 0 }, gamesWon: 0,
            security: 5, securityTaken: [],
            battle: [legacyUnit, null, null, null, null, null],
            breeding: null, tamers: [],
            counts: { hand: 4, deck: 31, trash: 1, eggDeck: 5 }
        },
        currentTurn: 1, gameNumber: 1, matchFormat: 'Best of 3'
    });

    console.log('\n-- Active-player emphasis --');
    check('active board carries active-turn', await evalOverlay(() => document.getElementById('player1Board').classList.contains('active-turn')));
    check('idle board carries idle-turn', await evalOverlay(() => document.getElementById('player2Board').classList.contains('idle-turn')));
    check('turn classes do not collide with the visibility class', await evalOverlay(() =>
        document.getElementById('player1Board').classList.contains('active') &&
        document.getElementById('player2Board').classList.contains('active')));
    check('idle board is visibly recessed', await evalOverlay(() => {
        const o = parseFloat(getComputedStyle(document.getElementById('player2Board')).opacity);
        return o > 0 && o < 1;
    }));
    check('idle board is desaturated', await evalOverlay(() => {
        const f = getComputedStyle(document.getElementById('player2Board')).filter;
        return f !== 'none' && f.includes('saturate');
    }));
    check('active board is at full strength', await evalOverlay(() =>
        parseFloat(getComputedStyle(document.getElementById('player1Board')).opacity) === 1 &&
        getComputedStyle(document.getElementById('player1Board')).filter === 'none'));
    check('turn rail lit on the active side', await evalOverlay(() => {
        const s = getComputedStyle(document.getElementById('player1Board'), '::after');
        return parseFloat(s.opacity) === 1 && parseFloat(s.width) > 0;
    }));
    check('turn rail dark on the idle side', await evalOverlay(() =>
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 0));
    // The rail must sit on the board's INNER edge, facing screen centre.
    check('rail sits on each board\'s inner edge', await evalOverlay(() => {
        const l = getComputedStyle(document.getElementById('player1Board'), '::after');
        const r = getComputedStyle(document.getElementById('player2Board'), '::after');
        return parseFloat(l.right) < 0 && parseFloat(r.left) < 0;
    }));
    check('active panels take an accent glow', await evalOverlay(() => {
        const p1 = getComputedStyle(document.querySelector('#player1Board .panel:not(.soft)')).boxShadow;
        const p2 = getComputedStyle(document.querySelector('#player2Board .panel:not(.soft)')).boxShadow;
        return p1 !== p2 && p1.split('rgb').length > p2.split('rgb').length;
    }));

    await emit('turn-switch', { currentTurn: 2 });
    // The rail and the dim both ride a ~0.5s transition - settle before reading.
    await overlay.waitForTimeout(700);
    check('emphasis follows the turn across', await evalOverlay(() =>
        document.getElementById('player2Board').classList.contains('active-turn') &&
        document.getElementById('player1Board').classList.contains('idle-turn') &&
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 1));
    // The idle dim must not out-rank the hide: a board with no `.active` class
    // has to stay at opacity 0 even while it is the idle side.
    await emit('toggle-digimon-match', { show: false });
    await overlay.waitForTimeout(800);
    check('hidden board stays hidden while idle', await evalOverlay(() =>
        parseFloat(getComputedStyle(document.getElementById('player1Board')).opacity) === 0));
    await emit('toggle-digimon-match', { show: true });
    await emit('turn-switch', { currentTurn: 1 });
    await overlay.waitForTimeout(700);

    console.log('\n-- Idle-slot motion --');
    check('empty battle slots drift a motif', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1Battle .battle-cell.empty'), '::before');
        return s.animationName === 'slot-drift' && s.backgroundImage.includes('svg');
    }));
    check('the motif is an inline SVG data URI, not a glyph', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1Battle .battle-cell.empty'), '::before');
        return s.backgroundImage.includes('data:image/svg+xml') && s.content === '""';
    }));
    check('drift is slow enough to ignore', await evalOverlay(() =>
        parseFloat(getComputedStyle(document.querySelector('#p1Battle .battle-cell.empty'), '::before').animationDuration) >= 5));
    check('drift is staggered across idle slots', await evalOverlay(() => {
        const cells = Array.from(document.querySelectorAll('#p1Battle .battle-cell.empty'));
        return cells.length >= 5 && new Set(cells.map(c => c.style.getPropertyValue('--drift-delay'))).size === cells.length;
    }));
    check('filled slots carry no drift motif', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1Battle .battle-cell:not(.empty)'), '::before');
        return s.animationName === 'none' || s.content === 'none';
    }));
    check('empty breeding slot drifts too', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1Breed .breed-cell.empty'), '::before');
        return s.animationName === 'slot-drift';
    }));
    // The motif has to actually fit inside the slot it decorates.
    check('motif is scaled to its slot', await evalOverlay(() => {
        const cell = document.querySelector('#p1Battle .battle-cell.empty').getBoundingClientRect();
        const w = parseFloat(getComputedStyle(document.querySelector('#p1Battle .battle-cell.empty'), '::before').width);
        return w > 20 && w < cell.width * 0.55;
    }));

    console.log('\n-- Render caching --');
    await evalOverlay(() => {
        document.querySelector('#p1Battle .battle-cell:not(.empty) img.battle-art').dataset.stamp = 'orig';
        document.querySelector('#p1SecTrack .sec-pip').dataset.stamp = 'orig';
        document.querySelector('#memTrack .mem-cell').dataset.stamp = 'orig';
        document.querySelector('#p1Counts .count-val').dataset.stamp = 'orig';
    });
    const stamped = sel => evalOverlay(new Function(`return document.querySelector('${sel}')?.dataset.stamp === 'orig';`));

    await emit('digimon-battle-update', { player: 1, index: 0, unit: { ...wg, dp: 14000 } });
    check('DP edit does not reload the card art', await stamped('#p1Battle .battle-cell:not(.empty) img.battle-art'));
    check('DP text updated in place', await evalOverlay(() =>
        document.querySelector('#p1Battle .battle-cell:not(.empty) .stat.dp .v').textContent === '14000'));

    await emit('digimon-battle-update', { player: 1, index: 0, unit: { ...wg, dp: 14000, stack: 3 } });
    check('stack edit does not reload the card art', await stamped('#p1Battle .battle-cell:not(.empty) img.battle-art'));
    check('stack badge updated in place', await evalOverlay(() => {
        const b = document.querySelector('#p1Battle .battle-cell:not(.empty) .stack-badge');
        return b && b.textContent === 'x3' && !b.classList.contains('is-hidden');
    }));

    await emit('digimon-security-taken', { player: 1, index: 0 });
    check('security toggle does not rebuild the pips', await stamped('#p1SecTrack .sec-pip'));
    check('security toggle does not reload battle art', await stamped('#p1Battle .battle-cell:not(.empty) img.battle-art'));
    await emit('digimon-memory-update', { memory: 3 });
    check('memory change does not rebuild the gauge cells', await stamped('#memTrack .mem-cell'));
    await emit('digimon-counts-update', { player: 1, counts: { hand: 7, deck: 29, trash: 2, eggDeck: 4 } });
    check('count change does not rebuild the count cells', await stamped('#p1Counts .count-val'));
    check('count value updated in place', await evalOverlay(() =>
        document.querySelector('#p1Counts .count-val').textContent === '7'));

    // A genuinely different card must rebuild, or the slot keeps stale art.
    await emit('digimon-battle-update', { player: 1, index: 0, unit: gg });
    check('a different card rebuilds the slot', await evalOverlay(() =>
        document.querySelector('#p1Battle .battle-cell:not(.empty) img.battle-art')?.dataset.stamp === undefined));
    check('rebuilt slot shows the new name', await evalOverlay(() =>
        document.querySelector('#p1Battle .battle-cell:not(.empty) .battle-name').textContent === 'Garurumon'));
    check('battle area count tracks filled slots', await evalOverlay(() =>
        document.getElementById('p1BattleCount').textContent === '1/6'));

    // Emptying a slot must drop the previous occupant's colour stripe.
    await emit('digimon-battle-update', { player: 1, index: 0, unit: null });
    check('cleared slot loses its colour stripe', await evalOverlay(() => {
        const cell = document.querySelector('#p1Battle .battle-cell[data-slot="0"]');
        return cell.classList.contains('empty') && cell.style.getPropertyValue('--clr') === '' && cell.children.length === 0;
    }));
    await emit('digimon-battle-update', { player: 1, index: 0, unit: wg });

    console.log('\n-- Legacy state (fields the old control never sent) --');
    check('legacy unit renders its art', await evalOverlay(() => !!document.querySelector('#p2Battle .battle-cell:not(.empty) img.battle-art')));
    check('legacy unit hides the empty DP chip', await evalOverlay(() =>
        document.querySelector('#p2Battle .battle-cell:not(.empty) .stat.dp').classList.contains('is-hidden')));
    check('legacy unit hides the stack badge at depth 1', await evalOverlay(() =>
        document.querySelector('#p2Battle .battle-cell:not(.empty) .stack-badge').classList.contains('is-hidden')));
    check('legacy unit still shows its name', await evalOverlay(() =>
        document.querySelector('#p2Battle .battle-cell:not(.empty) .battle-name').textContent === 'Betamon'));

    console.log('\n-- Change tickers --');
    // Settle back to a full stack and let that ticker expire, so the assertion
    // below reads the swing under test rather than the one before it.
    await emit('digimon-security-taken', { player: 1, securityTaken: [] });
    await overlay.waitForTimeout(1200);
    await emit('digimon-security-taken', { player: 1, securityTaken: [0, 1] });
    check('security loss fires a ticker', await evalOverlay(() => {
        const p = document.querySelector('#player1Board .sec-pop');
        return !!p && p.textContent === '-2' && !p.classList.contains('gain');
    }));
    check('security ticker is actually visible, not clipped', await isVisible('#player1Board .sec-pop'));
    check('security ticker clears the security numerals', await evalOverlay(() => {
        const pop = document.querySelector('#player1Board .sec-pop').getBoundingClientRect();
        const num = document.querySelector('#player1Board .sec-count').getBoundingClientRect();
        return pop.left >= num.right - 1 || pop.bottom <= num.top + 1;
    }));
    check('security ticker stays inside the panel', await evalOverlay(() => {
        const pop = document.querySelector('#player1Board .sec-pop').getBoundingClientRect();
        const panel = document.querySelector('#player1Board .sec-head').closest('.panel').getBoundingClientRect();
        return pop.left >= panel.left && pop.right <= panel.right && pop.top >= panel.top;
    }));
    await overlay.waitForTimeout(1200);
    await emit('digimon-security-taken', { player: 1, securityTaken: [0] });
    check('security gain reads as a gain', await evalOverlay(() => {
        const p = document.querySelector('#player1Board .sec-pop');
        return !!p && p.textContent === '+1' && p.classList.contains('gain');
    }));
    await overlay.waitForTimeout(1200);
    await emit('digimon-security-reset', {});
    check('a security reset fires no phantom ticker', await evalOverlay(() =>
        document.querySelectorAll('.sec-pop').length === 0));

    // The memory ticker is parked in whichever of the readout's side margins the
    // swing is moving TOWARD - the gauge reads left = player 1, right = player 2,
    // so a ticker on the wrong half contradicts the widget it belongs to. Every
    // assertion below is therefore side-aware: which edge of the centred readout
    // text the pop has to clear depends on where it landed.
    const memPopGeo = () => evalOverlay(() => {
        const p = document.querySelector('#memoryGauge .mem-pop');
        if (!p) return null;
        const rr = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        return {
            text: p.textContent,
            toP1: p.classList.contains('to-p1'),
            pop: rr(p),
            who: rr(document.querySelector('#memReadout .who')),
            val: rr(document.querySelector('#memReadout .val')),
            gauge: rr(document.getElementById('memoryGauge'))
        };
    });
    const popClearsReadout = m => !!m && (m.toP1
        ? m.pop.right <= Math.min(m.who.left, m.val.left) + 1
        : m.pop.left >= Math.max(m.who.right, m.val.right) - 1);
    const popOnItsOwnHalf = m => !!m && (m.toP1
        ? m.pop.right <= (m.gauge.left + m.gauge.right) / 2
        : m.pop.left >= (m.gauge.left + m.gauge.right) / 2);
    const popInsideGauge = m => !!m && m.pop.left >= m.gauge.left - 1 && m.pop.right <= m.gauge.right + 1 && m.pop.top >= m.gauge.top;

    await emit('digimon-memory-update', { memory: 0 });
    await overlay.waitForTimeout(1200);
    await emit('digimon-memory-update', { memory: -4 });
    let memPop = await memPopGeo();
    check('memory swing fires a ticker', !!memPop && memPop.text === '-4' && memPop.toP1, JSON.stringify(memPop));
    check('memory ticker is actually visible, not clipped', await isVisible('#memoryGauge .mem-pop'));
    check('a swing toward P1 fires on P1\'s half of the gauge', popOnItsOwnHalf(memPop), JSON.stringify(memPop));
    check('memory ticker clears the centred readout text (toward P1)', popClearsReadout(memPop), JSON.stringify(memPop));
    check('memory ticker stays inside the gauge (toward P1)', popInsideGauge(memPop), JSON.stringify(memPop));

    // The mirror case: the harness used to only ever swing toward P1, so the
    // right-hand anchoring went untested.
    await overlay.waitForTimeout(1200);
    await emit('digimon-memory-update', { memory: 3 });
    memPop = await memPopGeo();
    check('memory swing toward P2 fires a ticker', !!memPop && memPop.text === '+7' && !memPop.toP1, JSON.stringify(memPop));
    check('memory ticker toward P2 is actually visible, not clipped', await isVisible('#memoryGauge .mem-pop'));
    check('a swing toward P2 fires on P2\'s half of the gauge', popOnItsOwnHalf(memPop), JSON.stringify(memPop));
    check('memory ticker clears the centred readout text (toward P2)', popClearsReadout(memPop), JSON.stringify(memPop));
    check('memory ticker stays inside the gauge (toward P2)', popInsideGauge(memPop), JSON.stringify(memPop));
    await overlay.waitForTimeout(1200);
    await emit('digimon-match-reset', {});
    check('a match reset fires no phantom ticker', await evalOverlay(() =>
        document.querySelectorAll('.sec-pop, .mem-pop').length === 0));

    console.log('\n-- Critical state legibility --');
    await emit('digimon-security-taken', { player: 1, securityTaken: [0, 1, 2] });
    check('two security left is not yet critical', await evalOverlay(() =>
        !document.getElementById('p1Sec').classList.contains('critical')));
    await emit('digimon-security-taken', { player: 1, securityTaken: [0, 1, 2, 3] });
    check('one security left is flagged critical', await evalOverlay(() =>
        document.getElementById('p1Sec').classList.contains('critical')));
    check('critical security pulses', await evalOverlay(() =>
        getComputedStyle(document.getElementById('p1Sec')).animationName === 'soft-pulse'));
    await emit('timer-set', { minutes: 0, seconds: 42 });
    check('final minute of the clock is flagged', await evalOverlay(() => {
        const t = document.getElementById('matchTimer');
        return t.classList.contains('expiring') && getComputedStyle(t).animationName === 'soft-pulse';
    }));
    await emit('timer-set', { minutes: 30, seconds: 0 });
    check('normal time is not flagged', await evalOverlay(() =>
        !document.getElementById('matchTimer').classList.contains('expiring')));

    console.log('\n-- Security markers are SVG card backs, never glyphs --');
    // Security cards sit face down on a real board, so each marker is a card
    // back drawn as an SVG data URI - no glyph characters, which render
    // inconsistently across OBS browser-source builds.
    //
    // The spent marker used to be a big red X stamped over the pip. A red X on
    // a live overlay reads to a viewer as an error state rather than as a point
    // scored, so a spent card is now expressed by TAKING IT AWAY: drained of
    // colour, dimmed and shrunk. Both halves are asserted - that the stamp is
    // gone, AND that its replacement is a visible difference, not a no-op.
    // The spent/remaining swap is a 0.35s transition and `emit` only settles for
    // 140ms - getComputedStyle mid-transition returns the INTERPOLATED value, so
    // an opacity assertion here would read ~0.6 on its way down to 0.35 and fail
    // for a reason that has nothing to do with the styling. Let it land first.
    await emit('digimon-security-taken', { player: 1, securityTaken: [0, 1] });
    await overlay.waitForTimeout(600);
    check('every security marker is drawn from an SVG data URI', await overlay.$$eval('.sec-pip', els =>
        els.length === 10 && els.every(e => getComputedStyle(e).backgroundImage.includes('data:image/svg+xml'))));
    check('the marker carries the same hexagon motif the empty slots drift', await evalOverlay(() => {
        // The identical six-point path used by --hex-line, so the security row
        // and the empty battle cells read as one system.
        const hex = /M50 40 76 55 76 85 50 100 24 85 24 55Z/;
        return ['#p1SecTrack .sec-pip', '#p2SecTrack .sec-pip']
            .every(sel => hex.test(getComputedStyle(document.querySelector(sel)).backgroundImage));
    }));
    check('each side draws the card back in its own accent', await evalOverlay(() =>
        getComputedStyle(document.querySelector('#p1SecTrack .sec-pip')).backgroundImage
        !== getComputedStyle(document.querySelector('#p2SecTrack .sec-pip')).backgroundImage));
    check('nothing is stamped over a spent marker', await evalOverlay(() => {
        const pip = document.querySelector('#p1SecTrack .sec-pip.taken');
        // Chrome reports `none` for a pseudo-element with no rule at all.
        return ['::before', '::after'].every(pe => getComputedStyle(pip, pe).content === 'none');
    }));
    check('a spent marker is removed visually, not marked up', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1SecTrack .sec-pip.taken'));
        return parseFloat(s.opacity) <= 0.5 && /grayscale/.test(s.filter) && /^matrix\(0\.8/.test(s.transform);
    }));
    check('a remaining marker is at full strength and lifted off the panel', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1SecTrack .sec-pip:not(.taken)'));
        return parseFloat(s.opacity) === 1 && /drop-shadow/.test(s.filter)
            && !/grayscale/.test(s.filter) && s.transform === 'none';
    }));
    check('spent and remaining are unmistakably different, not a subtle tint', await evalOverlay(() => {
        const a = getComputedStyle(document.querySelector('#p1SecTrack .sec-pip:not(.taken)'));
        const b = getComputedStyle(document.querySelector('#p1SecTrack .sec-pip.taken'));
        return parseFloat(a.opacity) - parseFloat(b.opacity) >= 0.4 && a.filter !== b.filter;
    }));
    check('the spent change transitions rather than snapping', await evalOverlay(() => {
        const s = getComputedStyle(document.querySelector('#p1SecTrack .sec-pip'));
        return parseFloat(s.transitionDuration) > 0
            && ['filter', 'opacity', 'transform'].every(p => s.transitionProperty.includes(p));
    }));
    check('the markers are static - nothing animates for hours on end', await overlay.$$eval('.sec-pip', els =>
        els.every(e => ['', '::before', '::after'].every(pe =>
            getComputedStyle(e, pe || undefined).animationName === 'none'))));
    check('no emoji glyphs anywhere in the rendered text', await evalOverlay(() =>
        !/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(document.body.innerText)));

    console.log('\n-- Overflow safety --');
    const longUnit = { id: 'lu', name: 'Omnimon Alter-S ACE (Extra Long Print)', image: '/images/card-back.png', dp: 15000, level: 7, colors: 'Blue/White', stack: 12 };
    await emit('digimon-match-update', {
        player1: {
            name: 'Maximilian Von Hohenzollern III',
            record: { wins: 12, losses: 10, ties: 3 }, gamesWon: 11,
            securityTaken: [0, 1, 2, 3],
            battle: [longUnit, longUnit, longUnit, longUnit, longUnit, longUnit],
            breeding: { id: 'be', name: 'An Extremely Long Digi-Egg Name', image: '/images/card-back.png', dp: 3000, level: 2 },
            tamers: [
                { id: 't1', name: 'Tai Kamiya & Agumon Bond' }, { id: 't2', name: 'Matt Ishida' },
                { id: 't3', name: 'Sora Takenouchi' }, { id: 't4', name: 'Izzy Izumi' },
                { id: 't5', name: 'Joe Kido' }, { id: 't6', name: 'Mimi Tachikawa' }
            ],
            counts: { hand: 12, deck: 999, trash: 128, eggDeck: 5 }
        },
        currentTurn: 1
    });
    // Numerals that silently drop a digit are worse than visible truncation.
    check('zone counts never clip a digit', await overlay.$$eval('#p1Counts .count-val', els => els.every(e => e.scrollWidth <= e.clientWidth)));
    check('zone labels never clip', await overlay.$$eval('#p1Counts .count-lbl', els => els.every(e => e.scrollWidth <= e.clientWidth)));
    check('the security headline never clips', await evalOverlay(() => {
        const head = document.querySelector('#player1Board .sec-head');
        return head.scrollWidth <= head.clientWidth + 1;
    }));
    check('the record chip never clips', await evalOverlay(() => {
        const r = document.getElementById('p1Record');
        return r.scrollWidth <= r.clientWidth + 1;
    }));
    check('five-digit DP chips fit their cell', await overlay.$$eval('#p1Battle .stat:not(.is-hidden)', els =>
        els.every(e => e.scrollWidth <= e.clientWidth + 1)));
    check('two-digit stack badges fit their cell', await evalOverlay(() => {
        const b = document.querySelector('#p1Battle .stack-badge:not(.is-hidden)');
        const cell = b.closest('.battle-cell').getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return b.textContent === 'x12' && br.right <= cell.right + 1 && br.left >= cell.left - 1;
    }));
    // A maxed cell (DP 15000 + Lv 7 + x12) used to lay the badge over the Lv
    // chip by 3.7px, because a top-right-pinned badge had no idea how wide the
    // chips beside it were. The badge shares their flex row now, so an overlap
    // is not representable - measured rather than assumed.
    check('the stack badge never lies on top of a stat chip', await overlay.$$eval('#p1Battle .battle-cell:not(.empty)', cells =>
        cells.every(cell => {
            const badge = cell.querySelector('.stack-badge:not(.is-hidden)');
            if (!badge) return true;
            const b = badge.getBoundingClientRect();
            return Array.from(cell.querySelectorAll('.stat:not(.is-hidden)')).every(s => {
                const r = s.getBoundingClientRect();
                return b.right <= r.left + 0.5 || r.right <= b.left + 0.5
                    || b.bottom <= r.top + 0.5 || r.bottom <= b.top + 0.5;
            });
        })));
    check('the stack badge stays inside its cell vertically too', await overlay.$$eval('#p1Battle .battle-cell:not(.empty)', cells =>
        cells.every(cell => {
            const badge = cell.querySelector('.stack-badge:not(.is-hidden)');
            if (!badge) return true;
            const b = badge.getBoundingClientRect(), c = cell.getBoundingClientRect();
            return b.top >= c.top - 1 && b.bottom <= c.bottom + 1;
        })));
    // Long text is allowed to truncate - but only visibly, with an ellipsis.
    const ellipsised = sel => overlay.evaluate(s => {
        const el = document.querySelector(s);
        return !!el && getComputedStyle(el).textOverflow === 'ellipsis' && getComputedStyle(el).overflow !== 'visible';
    }, sel);
    check('a long player name truncates with an ellipsis', await ellipsised('#p1Name'));
    check('a long player name does not shove the record chip out', await evalOverlay(() => {
        const row = document.querySelector('#player1Board .player-name-row').getBoundingClientRect();
        const rec = document.getElementById('p1Record').getBoundingClientRect();
        return rec.right <= row.right + 1 && rec.left >= row.left;
    }));
    check('a long card name truncates with an ellipsis', await ellipsised('#p1Battle .battle-name'));
    check('a long breeding name truncates with an ellipsis', await ellipsised('#p1Breed .breed-name'));
    check('a long turn name truncates with an ellipsis', await ellipsised('#turnIndicator'));
    check('the turn pill stays inside the match bar', await evalOverlay(() => {
        const bar = document.getElementById('matchInfo').getBoundingClientRect();
        const pill = document.getElementById('turnIndicator').getBoundingClientRect();
        return pill.right <= bar.right - 1 && pill.left >= bar.left;
    }));
    check('the tamer row collapses overflow into a +N chip', await evalOverlay(() => {
        const row = document.getElementById('p1Tamers');
        const more = row.querySelector('.tamer-chip.more');
        return row.scrollWidth <= row.clientWidth + 1 && !!more && /^\+\d+$/.test(more.textContent);
    }));
    check('the tamer row stays on one line', await evalOverlay(() => {
        const row = document.getElementById('p1Tamers');
        return row.scrollHeight <= row.clientHeight + 1;
    }));
    check('every tamer chip is inside the row', await overlay.$$eval('#p1Tamers .tamer-chip', els => {
        const row = els[0].parentElement.getBoundingClientRect();
        return els.every(e => { const r = e.getBoundingClientRect(); return r.right <= row.right + 1 && r.left >= row.left - 1; });
    }));
    // The 22px memory value used to overflow a 20px-tall readout box.
    check('the memory readout is tall enough for its value', await evalOverlay(() => {
        const row = document.getElementById('memReadout').getBoundingClientRect();
        const val = document.querySelector('#memReadout .val').getBoundingClientRect();
        return val.top >= row.top - 0.5 && val.bottom <= row.bottom + 0.5;
    }));
    check('the memory readout never overlaps the player end-labels', await evalOverlay(() => {
        const row = document.getElementById('memReadout').getBoundingClientRect();
        const end = document.getElementById('memEndP1').getBoundingClientRect();
        return end.top >= row.bottom - 0.5;
    }));
    check('long player names ellipsise on the gauge ends', await ellipsised('#memEndP1'));

    console.log('\n-- Layout integrity --');
    // Every assertion below measures a resting layout, so let the entrance
    // animations land first. `card-swap` transforms a freshly placed card for
    // 0.45s, and a transformed element's client rect is its TRANSFORMED box:
    // measured mid-animation the art reads as smaller than the cell, and the
    // stat chips sitting on it report as hanging off the card. That made
    // "battle stat chips stay on the card art" fail intermittently depending on
    // how fast the preceding checks happened to run. The idle-slot drift and
    // the critical pulse repeat forever, so they are filtered out rather than
    // awaited - awaiting them would hang.
    await overlay.evaluate(() => Promise.all(document.getAnimations()
        .filter(a => a.effect && a.effect.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => {}))).then(() => true));
    check('boards stay inside the 1080 canvas', await evalOverlay(() =>
        [1, 2].every(n => {
            const r = document.getElementById(`player${n}Board`).getBoundingClientRect();
            return r.top >= -1 && r.left >= -1 && r.right <= 1921;
        })));
    check('every panel stays inside the 1080 canvas', await overlay.$$eval('.panel', els =>
        els.every(p => { const r = p.getBoundingClientRect(); return r.top >= -1 && r.bottom <= 1081; })));
    check('the memory gauge clears both boards', await evalOverlay(() => {
        const g = document.getElementById('memoryGauge').getBoundingClientRect();
        const a = document.getElementById('player1Board').getBoundingClientRect();
        const b = document.getElementById('player2Board').getBoundingClientRect();
        return g.left >= a.right && g.right <= b.left;
    }));
    check('battle stat chips stay on the card art', await evalOverlay(() => {
        const cell = document.querySelector('#p1Battle .battle-cell:not(.empty)');
        const art = cell.querySelector('img.battle-art').getBoundingClientRect();
        return Array.from(cell.querySelectorAll('.stat:not(.is-hidden), .stack-badge:not(.is-hidden), .battle-name')).every(el => {
            const r = el.getBoundingClientRect();
            return r.left >= art.left - 1 && r.right <= art.right + 1 && r.top >= art.top - 1 && r.bottom <= art.bottom + 1;
        });
    }));
    check('the battle grid never overflows its panel', await evalOverlay(() => {
        const grid = document.getElementById('p1Battle');
        return grid.scrollWidth <= grid.clientWidth + 1 && grid.scrollHeight <= grid.clientHeight + 1;
    }));
    check('the security track never overflows its panel', await evalOverlay(() => {
        const t = document.getElementById('p1SecTrack');
        return t.scrollWidth <= t.clientWidth + 1;
    }));
    // The producer has this board framed in OBS, so the security row's box is
    // fixed furniture: only the artwork inside a marker may ever change. The
    // literals below are the shipped geometry - a 50x70 marker, five of them
    // with a 7px gap in a 374px row, inside a 175px-tall panel. Sizes are read
    // with offsetWidth/Height, NOT getBoundingClientRect: a spent marker is
    // scaled to 0.86, and a client rect would report the transformed 43x60.
    check('every security marker keeps its 50x70 box', await overlay.$$eval('.sec-pip', els =>
        els.length === 10 && els.every(e => e.offsetWidth === 50 && e.offsetHeight === 70),
    ), await overlay.$$eval('.sec-pip', els => els.map(e => `${e.offsetWidth}x${e.offsetHeight}`).join(' ')));
    check('a spent marker does not resize its own box', await evalOverlay(() => {
        const taken = document.querySelector('#p1SecTrack .sec-pip.taken');
        const left = document.querySelector('#p1SecTrack .sec-pip:not(.taken)');
        return !!taken && !!left
            && taken.offsetWidth === left.offsetWidth && taken.offsetHeight === left.offsetHeight;
    }));
    check('the security row keeps its 374x70 footprint', await evalOverlay(() => {
        const r = document.getElementById('p1SecTrack').getBoundingClientRect();
        return Math.abs(r.width - 374) <= 0.5 && Math.abs(r.height - 70) <= 0.5;
    }), await evalOverlay(() => {
        const r = document.getElementById('p1SecTrack').getBoundingClientRect();
        return `${r.width.toFixed(2)}x${r.height.toFixed(2)}`;
    }));
    check('the security panel keeps its 175px height', await evalOverlay(() => {
        const r = document.querySelector('#p1SecTrack').closest('.panel').getBoundingClientRect();
        return Math.abs(r.height - 175) <= 0.5;
    }), await evalOverlay(() =>
        document.querySelector('#p1SecTrack').closest('.panel').getBoundingClientRect().height.toFixed(2)));
    check('the security row sits wholly inside its panel', await evalOverlay(() => {
        const t = document.getElementById('p1SecTrack');
        const tr = t.getBoundingClientRect(), pr = t.closest('.panel').getBoundingClientRect();
        return tr.left >= pr.left - 0.5 && tr.right <= pr.right + 0.5
            && tr.top >= pr.top - 0.5 && tr.bottom <= pr.bottom + 0.5
            && t.scrollHeight <= t.clientHeight + 1;
    }));
    check('the memory track never overflows the gauge', await evalOverlay(() => {
        const t = document.getElementById('memTrack');
        return t.scrollWidth <= t.clientWidth + 1;
    }));

    console.log('\n-- Stack badge shares the stat row --');
    // The badge sits in the stat flex row, so it can wrap when the chips beside
    // it are wide. That has to stay a last resort: a board where two identical
    // x2 badges sit at different heights - purely because one card's DP has an
    // extra digit - reads as a rendering fault. Every combination a real Digimon
    // board can produce (5-digit DP + a level + a single-digit stack) must keep
    // the badge on the chips' own line.
    const realBoard = (battle) => ({
        name: 'Takeru', record: { wins: 3, losses: 1, ties: 0 }, gamesWon: 1,
        security: 5, securityTaken: [], battle, breeding: null, tamers: [],
        counts: { hand: 5, deck: 30, trash: 2, eggDeck: 4 }
    });
    const art = '/images/card-back.png';
    await emit('digimon-match-update', {
        player1: realBoard([
            { id: 'r1', name: 'WarGreymon', image: art, dp: 13000, level: 6, colors: 'Red', stack: 3 },
            { id: 'r2', name: 'Agumon', image: art, dp: 3000, level: 3, colors: 'Red', stack: 2 },
            { id: 'r3', name: 'Omnimon', image: art, dp: 15000, level: 7, colors: 'Blue/White', stack: 5 },
            { id: 'r4', name: 'Betamon', image: art, stack: 4 },
            null, null
        ]),
        currentTurn: 1
    });
    // Offsets are measured from each cell's own top-left: the six slots sit on
    // two grid rows, so comparing absolute page coordinates would only restate
    // the grid layout.
    const rowGeo = await overlay.$$eval('#p1Battle .battle-cell:not(.empty)', cells => cells.map(cell => {
        const c = cell.getBoundingClientRect();
        const badge = cell.querySelector('.stack-badge:not(.is-hidden)');
        const stats = Array.from(cell.querySelectorAll('.stat:not(.is-hidden)'));
        return {
            name: cell.querySelector('.battle-name').textContent,
            badgeTop: badge ? +(badge.getBoundingClientRect().top - c.top).toFixed(2) : null,
            badgeInset: badge ? +(c.right - badge.getBoundingClientRect().right).toFixed(2) : null,
            statTop: stats.length ? +(stats[0].getBoundingClientRect().top - c.top).toFixed(2) : null
        };
    }));
    check('a realistic stack badge stays on the chips\' own line', rowGeo.every(c =>
        c.badgeTop === null || c.statTop === null || Math.abs(c.badgeTop - c.statTop) <= 1), JSON.stringify(rowGeo));
    check('identical badges sit at one height across the board', new Set(
        rowGeo.filter(c => c.badgeTop !== null).map(c => c.badgeTop)).size === 1, JSON.stringify(rowGeo));
    check('every stack badge is right-anchored in its cell', rowGeo.every(c =>
        c.badgeInset === null || c.badgeInset <= 6), JSON.stringify(rowGeo));

    // The badge moving into the flex row must not resize the cell it lives in -
    // the producer has this board framed in OBS. A wrapping badge (x12) and a
    // non-wrapping one must leave the grid and the cells pixel-identical.
    const gridGeo = () => evalOverlay(() => {
        const round = r => [r.left, r.top, r.width, r.height].map(v => +v.toFixed(2)).join(',');
        return {
            grid: round(document.getElementById('p1Battle').getBoundingClientRect()),
            cell: round(document.querySelector('#p1Battle .battle-cell[data-slot="0"]').getBoundingClientRect()),
            panel: round(document.querySelector('#p1Battle').closest('.panel').getBoundingClientRect())
        };
    });
    const geoUnwrapped = await gridGeo();
    await emit('digimon-match-update', {
        player1: realBoard([
            { id: 'r1', name: 'Omnimon', image: art, dp: 15000, level: 7, colors: 'Blue/White', stack: 12 },
            null, null, null, null, null
        ]),
        currentTurn: 1
    });
    const geoWrapped = await gridGeo();
    check('a wrapped badge does not resize the cell', geoUnwrapped.cell === geoWrapped.cell,
        `${geoUnwrapped.cell} vs ${geoWrapped.cell}`);
    check('a wrapped badge does not resize the battle grid', geoUnwrapped.grid === geoWrapped.grid,
        `${geoUnwrapped.grid} vs ${geoWrapped.grid}`);
    check('a wrapped badge does not resize the battle panel', geoUnwrapped.panel === geoWrapped.panel,
        `${geoUnwrapped.panel} vs ${geoWrapped.panel}`);
    check('even a wrapped badge clears the stat chips', await evalOverlay(() => {
        const cell = document.querySelector('#p1Battle .battle-cell[data-slot="0"]');
        const b = cell.querySelector('.stack-badge:not(.is-hidden)').getBoundingClientRect();
        return Array.from(cell.querySelectorAll('.stat:not(.is-hidden)')).every(s => {
            const r = s.getBoundingClientRect();
            return b.right <= r.left + 0.5 || r.right <= b.left + 0.5
                || b.bottom <= r.top + 0.5 || r.bottom <= b.top + 0.5;
        });
    }));

    console.log('\n-- Script health --');
    check('no page errors during the run', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
