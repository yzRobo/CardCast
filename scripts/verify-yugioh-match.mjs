// Phase 2/3 verification: Yu-Gi-Oh! match overlay + control, end to end.
// Opens BOTH the control page and the overlay page, exercises every control,
// and asserts the overlay re-renders via the socket round-trip. A second
// section drives the overlay directly and asserts the polish pass: turn
// emphasis rail, render caching, idle-zone motion, stat-block overflow, the
// life-point ticker and layout integrity - by geometry, not DOM presence.
//
//   node scripts/verify-yugioh-match.mjs
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

// Discover a real Monster (with ATK), Spell, Trap, and an Extra-deck monster from the DB.
async function discover() {
    const found = {};
    for (const q of ['Dark Magician', 'Blue-Eyes', 'Mystical Space', 'Mirror Force', 'Stardust', 'Sky Striker', 'Pot of']) {
        const arr = await (await fetch(`${BASE}/api/search/yugioh?q=${encodeURIComponent(q)}`)).json();
        for (const c of arr) {
            const t = (c.card_type || '').toLowerCase();
            if (!found.monster && t.includes('monster') && !/fusion|synchro|xyz|link/.test(t) && c.attack != null) found.monster = c;
            if (!found.spell && t.includes('spell')) found.spell = c;
            if (!found.trap && t.includes('trap')) found.trap = c;
        }
        if (found.monster && found.spell && found.trap) break;
    }
    return found;
}

// Reuse a dev server if one is already listening - never kill someone else's.
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };
const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Monster/Spell/Trap cards from DB', cards.monster && cards.spell && cards.trap,
        JSON.stringify({ monster: cards.monster && cards.monster.name, spell: cards.spell && cards.spell.name, trap: cards.trap && cards.trap.name }));

    browser = await chromium.launch();

    const overlay = await browser.newPage();
    const overlayErrors = [];
    overlay.on('pageerror', e => overlayErrors.push(e.message));
    await overlay.goto(`${BASE}/yugioh-match`, { waitUntil: 'networkidle' });
    const control = await browser.newPage();
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/yugioh-match-control`, { waitUntil: 'networkidle' });

    // Control renders two boards with 5 monster + 5 spell/trap zones each.
    const layout = await control.evaluate(() => ({
        boards: document.querySelectorAll('#playersGrid > .card').length,
        p1mon: document.querySelectorAll('#p1Monsters > div').length,
        p2mon: document.querySelectorAll('#p2Monsters > div').length,
        p1st: document.querySelectorAll('#p1SpellsTraps > div').length,
        phases: document.querySelectorAll('#phaseButtons > button').length,
        counts: document.querySelectorAll('#p1Counts input').length
    }));
    check('control renders 2 player boards', layout.boards === 2, JSON.stringify(layout));
    check('control renders 5 monster zones per player', layout.p1mon === 5 && layout.p2mon === 5, JSON.stringify(layout));
    check('control renders 5 spell/trap zones', layout.p1st === 5, JSON.stringify(layout));
    check('control renders 6 phase buttons', layout.phases === 6, JSON.stringify(layout));
    check('control renders 5 zone-count inputs', layout.counts === 5, JSON.stringify(layout));

    // Overlay reports connected on the control status badge.
    await control.waitForFunction(() => document.getElementById('overlayStatus').textContent.includes('Connected'), { timeout: 8000 });
    check('control shows Overlay Connected', true);

    const waitOverlay = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // 1) Name + record + games won
    await control.evaluate(() => { setName(1, 'Yugi'); document.getElementById('p1W').value = 2; document.getElementById('p1L').value = 1; setRecord(1); adjGamesWon(1, 1); });
    check('overlay reflects P1 name', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Yugi'));
    check('overlay reflects P1 record', await waitOverlay(() => document.getElementById('p1Record').textContent === '2-1-0'));
    check('overlay reflects P1 games won', await waitOverlay(() => document.getElementById('p1GamesWon').textContent.includes('1')));

    // 2) Life Points: damage + color thresholds
    await control.evaluate(() => adjLife(1, -4000)); // 8000 -> 4000
    check('overlay LP shows 4,000', await waitOverlay(() => document.getElementById('p1LP').textContent.replace(/,/g, '') === '4000'));
    await control.evaluate(() => adjLife(1, -3500)); // -> 500 critical
    check('overlay LP critical class < 1000', await waitOverlay(() => document.getElementById('p1LP').classList.contains('critical')));

    // 3) Assign a Monster to P1 zone 0 (ATK/DEF + position badge)
    await control.evaluate(async (id) => { openSearch(1, 'monster', 0); await pickCard(id); }, cards.monster.id);
    check('overlay shows monster with ATK/DEF + badge', await waitOverlay(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell:not(.empty)');
        return cell && cell.querySelector('.card-art') && cell.querySelector('.pos-badge') && /ATK/.test(cell.querySelector('.atkdef').textContent);
    }));

    // 4) Flip that monster to Defense -> badge DEF + sideways class
    await control.evaluate(() => setMonsterPosition(1, 0, 'def'));
    check('overlay monster position -> DEF', await waitOverlay(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell:not(.empty)');
        return cell && cell.classList.contains('def') && cell.querySelector('.pos-badge').textContent === 'DEF';
    }));

    // 5) Set monster to face-down SET -> card back, no ATK/DEF shown
    await control.evaluate(() => setMonsterPosition(1, 0, 'set'));
    check('overlay SET monster hides ATK/DEF', await waitOverlay(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell:not(.empty)');
        return cell && cell.querySelector('.pos-badge').textContent === 'SET' && !cell.querySelector('.atkdef');
    }));

    // 6) Assign a Spell/Trap, then toggle face-down
    await control.evaluate(async (id) => { openSearch(1, 'spelltrap', 0); await pickCard(id); }, cards.spell.id);
    check('overlay shows spell/trap card', await waitOverlay(() => !!document.querySelector('#p1SpellsTraps .zone-cell:not(.empty)')));
    await control.evaluate(() => toggleSpellFaceDown(1, 0));
    check('overlay spell/trap face-down badge SET', await waitOverlay(() => {
        const c = document.querySelector('#p1SpellsTraps .zone-cell:not(.empty)');
        return c && c.querySelector('.pos-badge') && c.querySelector('.pos-badge').textContent === 'SET';
    }));

    // 7) Assign a Field Spell
    await control.evaluate(async (id) => { openSearch(1, 'field', 0); await pickCard(id); }, cards.spell.id);
    check('overlay shows field spell name', await waitOverlay(() => {
        const f = document.getElementById('p1Field');
        return f && f.querySelector('.field-name') && f.querySelector('.field-name').textContent.length > 0;
    }));

    // 8) Normal Summon flag
    await control.evaluate(() => { document.getElementById('p1NS').checked = true; toggleNormalSummon(1); });
    check('overlay Normal Summon flag used', await waitOverlay(() => document.getElementById('p1NS').classList.contains('used')));

    // 9) Zone counts
    await control.evaluate(() => setCount(1, 'graveyard', 7));
    check('overlay GY count shows 7', await waitOverlay(() => {
        const labels = [...document.querySelectorAll('#p1Counts .count-item')];
        const gy = labels.find(el => el.querySelector('.count-label').textContent === 'GY');
        return gy && gy.querySelector('.count-value').textContent === '7';
    }));

    // 10) Phase stepper
    await control.evaluate(() => setPhase('Battle'));
    check('overlay phase stepper highlights Battle', await waitOverlay(() => {
        const on = document.querySelector('#phaseStepper .phase-chip.on');
        return on && on.textContent === 'Battle';
    }));

    // 11) Switch turn (also clears Normal Summon flags)
    await control.evaluate(() => switchTurn());
    check('overlay turn indicator -> P2', await waitOverlay(() => document.getElementById('turnIndicator').textContent.includes("Player 2")));
    check('overlay Normal Summon cleared on turn switch', await waitOverlay(() => !document.getElementById('p1NS').classList.contains('used')));

    // 12) Timer set
    await control.evaluate(() => { document.getElementById('timerMinutes').value = 12; document.getElementById('timerSeconds').value = 34; setTimer(); });
    check('overlay timer shows 12:34', await waitOverlay(() => document.getElementById('matchTimer').textContent === '12:34'));

    // 13) Hide then show overlay
    await control.evaluate(() => hideOverlay());
    check('overlay hides', await waitOverlay(() => !document.getElementById('player1Board').classList.contains('active')));
    await control.evaluate(() => showOverlay());
    check('overlay shows', await waitOverlay(() => document.getElementById('player1Board').classList.contains('active')));

    // 14) Reset clears the board (name preserved)
    await control.evaluate(() => resetMatch());
    check('overlay clears monsters on reset', await waitOverlay(() => document.querySelectorAll('#p1Monsters .zone-cell.empty').length === 5));
    check('overlay LP back to 8,000 on reset', await waitOverlay(() => document.getElementById('p1LP').textContent.replace(/,/g, '') === '8000'));
    check('overlay preserves name across reset', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Yugi'));

    // 15) Fresh overlay restores current state via request-state (reconnect)
    await control.evaluate(async (id) => { openSearch(2, 'monster', 1); await pickCard(id); }, cards.monster.id);
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/yugioh-match`, { waitUntil: 'networkidle' });
    check('reconnecting overlay restores existing monster', await overlay2.waitForFunction(
        () => document.querySelectorAll('#p2Monsters .zone-cell:not(.empty)').length >= 1, { timeout: 6000 }
    ).then(() => true).catch(() => false));
    await overlay2.close();

    // ================= POLISH PASS =================
    // Driven straight at the overlay so the assertions are about rendering,
    // not about the control page. Same socket contract, no new events.
    // The control page must be closed first: it answers every `overlay-connected`
    // with pushFullState(), and the overlay re-registers on a 5s heartbeat, so
    // leaving it open would overwrite driver-set zones mid-run.
    await control.close();
    await overlay.evaluate(() => { window.__drv = io(); });
    await overlay.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = async (e, d) => {
        await overlay.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);
        await overlay.waitForTimeout(130);
    };
    const at = fn => overlay.evaluate(fn);

    await emit('yugioh-match-reset', {});
    await emit('toggle-yugioh-match', { show: true });
    await emit('yugioh-match-update', {
        player1: { name: 'Yugi Muto' }, player2: { name: 'Seto Kaiba' }, currentTurn: 1
    });

    const ART = '/images/card-back.png';
    const bigMonster = { id: 'ult', name: 'Blue-Eyes Ultimate Dragon', image: ART, atk: 4500, def: 3800, position: 'atk' };

    console.log('\n-- polish: active-player emphasis --');
    await emit('turn-switch', { currentTurn: 1 });
    check('active board flagged active-turn', await at(() => document.getElementById('player1Board').classList.contains('active-turn')));
    check('idle board flagged idle-turn', await at(() => document.getElementById('player2Board').classList.contains('idle-turn')));
    check('turn rail lit on the active side', await at(() => {
        const s = getComputedStyle(document.getElementById('player1Board'), '::after');
        return parseFloat(s.opacity) === 1 && parseFloat(s.width) > 0;
    }));
    check('turn rail absent on the idle side', await at(() =>
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 0));
    check('idle board visibly recessed (opacity + desaturation)', await at(() => {
        const s = getComputedStyle(document.getElementById('player2Board'));
        return parseFloat(s.opacity) < 1 && s.filter !== 'none' && s.filter.includes('saturate');
    }));
    // The board box is a fixed 1000px but the panel stack is ~250px shorter,
    // so a rail stretched to the box hangs into empty space under the board.
    check('turn rail is measured from the panel stack, not the empty board box', await at(() => {
        const board = document.getElementById('player1Board');
        const railH = parseFloat(getComputedStyle(board).getPropertyValue('--rail-h'));
        const last = board.lastElementChild;
        const content = last.offsetTop + last.offsetHeight;
        return board.offsetHeight - content > 100 && railH > 300 && Math.abs(railH - (content - 12)) < 3;
    }));
    check('turn rail bottom does not hang below the last panel', await at(() => {
        const board = document.getElementById('player1Board');
        const railH = parseFloat(getComputedStyle(board).getPropertyValue('--rail-h'));
        const last = board.lastElementChild;
        return 6 + railH <= last.offsetTop + last.offsetHeight + 2;
    }));
    await emit('turn-switch', { currentTurn: 2 });
    await overlay.waitForTimeout(700);   // the rail cross-fades over 0.45s
    check('emphasis follows the turn', await at(() =>
        document.getElementById('player2Board').classList.contains('active-turn') &&
        document.getElementById('player1Board').classList.contains('idle-turn') &&
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 1 &&
        parseFloat(getComputedStyle(document.getElementById('player1Board'), '::after').opacity) === 0));
    await emit('turn-switch', { currentTurn: 1 });
    // The idle treatment must never leak into the hidden state: a board that
    // is toggled off has to reach opacity 0, not the 0.8 of an idle turn.
    check('a hidden board is still fully hidden while idle', await at(async () => {
        window.__drv.emit('toggle-yugioh-match', { show: false });
        await new Promise(r => setTimeout(r, 900));   // board transition is 0.5s
        const o = parseFloat(getComputedStyle(document.getElementById('player2Board')).opacity);
        window.__drv.emit('toggle-yugioh-match', { show: true });
        await new Promise(r => setTimeout(r, 900));
        return o === 0;
    }));
    await overlay.waitForTimeout(300);

    console.log('\n-- polish: stat block fits the zone cell --');
    await emit('yugioh-monster-update', { player: 1, index: 0, monster: bigMonster });
    check('ATK and DEF both rendered in full', await at(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell.filled');
        return cell.querySelector('.ad-chip.atk .v').textContent === '4500'
            && cell.querySelector('.ad-chip.def .v').textContent === '3800';
    }));
    // Side by side these overran a ~65px cell and were silently clipped by its
    // overflow, so "DEF 2100" read as "DEF 2" - a number that still parses.
    check('four-digit ATK/DEF are not clipped by the zone cell', await at(() =>
        Array.from(document.querySelectorAll('#p1Monsters .zone-cell.filled .ad-chip'))
            .every(c => c.scrollWidth <= c.clientWidth + 1)
        && Array.from(document.querySelectorAll('#p1Monsters .zone-cell.filled .ad-chip .v'))
            .every(v => v.scrollWidth <= v.clientWidth + 1)));
    check('stat block stays inside the zone cell', await at(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell.filled').getBoundingClientRect();
        const blk = document.querySelector('#p1Monsters .zone-cell.filled .atkdef').getBoundingClientRect();
        return blk.left >= cell.left - 1 && blk.right <= cell.right + 1 && blk.bottom <= cell.bottom + 1;
    }));
    check('ATK sits above DEF rather than beside it', await at(() => {
        const a = document.querySelector('#p1Monsters .ad-chip.atk').getBoundingClientRect();
        const d = document.querySelector('#p1Monsters .ad-chip.def').getBoundingClientRect();
        return d.top >= a.bottom - 1;
    }));
    check('position badge clears the stat block', await at(() => {
        const badge = document.querySelector('#p1Monsters .zone-cell.filled .pos-badge').getBoundingClientRect();
        const blk = document.querySelector('#p1Monsters .zone-cell.filled .atkdef').getBoundingClientRect();
        return badge.bottom <= blk.top + 1;
    }));

    console.log('\n-- polish: render caching --');
    await at(() => { document.querySelector('#p1Monsters .zone-cell.filled img').dataset.stamp = 'orig'; });
    await emit('yugioh-monster-position', { player: 1, index: 0, position: 'def' });
    check('a position flip updates in place, never reloading the art', await at(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell.filled');
        return cell.querySelector('img').dataset.stamp === 'orig'
            && cell.classList.contains('def')
            && cell.querySelector('.pos-badge').textContent === 'DEF';
    }));
    check('four-digit stats still fit in defence position', await at(() =>
        Array.from(document.querySelectorAll('#p1Monsters .zone-cell.filled .ad-chip'))
            .every(c => c.scrollWidth <= c.clientWidth + 1)));
    await emit('yugioh-monster-update', { player: 1, index: 0, monster: { ...bigMonster, atk: 5000, position: 'def' } });
    check('an ATK edit updates in place, never reloading the art', await at(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell.filled');
        return cell.querySelector('img').dataset.stamp === 'orig'
            && cell.querySelector('.ad-chip.atk .v').textContent === '5000';
    }));
    // Filling a different zone must not churn the zones already on screen -
    // rebuilding the row would reload every card and restart every drift.
    await at(() => { document.querySelectorAll('#p1Monsters .zone-cell.empty')[0].dataset.stamp = 'idle0'; });
    await emit('yugioh-monster-update', { player: 1, index: 4, monster: { id: 'z4', name: 'Kuriboh', image: ART, atk: 300, def: 200, position: 'atk' } });
    check('filling one zone leaves the other slots untouched', await at(() => {
        const held = document.querySelector('#p1Monsters .zone-cell:nth-child(1) img');
        const idle = document.querySelector('#p1Monsters .zone-cell:nth-child(2)');
        return held && held.dataset.stamp === 'orig' && idle && idle.dataset.stamp === 'idle0';
    }));
    // Face-down flips DO have to rebuild - the image source changes and the
    // stat block goes away.
    await emit('yugioh-monster-position', { player: 1, index: 0, position: 'set' });
    check('flipping face-down rebuilds the slot', await at(() => {
        const cell = document.querySelector('#p1Monsters .zone-cell:nth-child(1)');
        return cell.querySelector('img').dataset.stamp === undefined
            && cell.querySelector('.pos-badge').textContent === 'SET'
            && !cell.querySelector('.atkdef');
    }));
    await emit('yugioh-monster-position', { player: 1, index: 0, position: 'atk' });

    await emit('yugioh-spelltrap-update', { player: 1, index: 0, card: { id: 's1', name: 'Mirror Force', image: ART, faceDown: false } });
    await at(() => { document.querySelector('#p1SpellsTraps .zone-cell.filled img').dataset.stamp = 'st'; });
    await emit('yugioh-spelltrap-update', { player: 1, index: 3, card: { id: 's2', name: 'Solemn Judgment', image: ART, faceDown: false } });
    check('a second spell/trap does not reload the first', await at(() =>
        document.querySelector('#p1SpellsTraps .zone-cell:nth-child(1) img').dataset.stamp === 'st'));
    await emit('yugioh-spelltrap-update', { player: 1, index: 0, card: { id: 's1', name: 'Mirror Force', image: ART, faceDown: true } });
    check('setting a spell/trap face-down rebuilds it', await at(() => {
        const cell = document.querySelector('#p1SpellsTraps .zone-cell:nth-child(1)');
        return cell.querySelector('img').dataset.stamp === undefined
            && cell.querySelector('.pos-badge').textContent === 'SET';
    }));

    await emit('yugioh-field-update', { player: 1, field: { id: 'f1', name: 'Yami', image: ART } });
    await at(() => { document.querySelector('#p1Field .field-art').dataset.stamp = 'field'; });
    await emit('yugioh-field-update', { player: 1, field: { id: 'f1', name: 'Yami', image: ART } });
    check('an unchanged field spell is not re-rendered', await at(() =>
        document.querySelector('#p1Field .field-art').dataset.stamp === 'field'));

    await emit('yugioh-counts-update', { player: 1, counts: { hand: 5, deck: 33, extra: 15, graveyard: 12, banished: 3 } });
    await at(() => { document.querySelector('#p1Counts .count-item').dataset.stamp = 'cnt'; });
    await emit('yugioh-counts-update', { player: 1, counts: { hand: 4, deck: 32, extra: 15, graveyard: 14, banished: 3 } });
    check('zone counts update in place', await at(() => {
        const item = document.querySelector('#p1Counts .count-item');
        return item.dataset.stamp === 'cnt' && item.querySelector('.count-value').textContent === '4';
    }));
    check('three-digit zone counts are not clipped', await at(async () => {
        window.__drv.emit('yugioh-counts-update', { player: 1, counts: { hand: 999, deck: 999, extra: 999, graveyard: 999, banished: 999 } });
        await new Promise(r => setTimeout(r, 200));
        return Array.from(document.querySelectorAll('#p1Counts .count-value')).every(v => v.scrollWidth <= v.clientWidth + 1)
            && Array.from(document.querySelectorAll('#p1Counts .count-label')).every(v => v.scrollWidth <= v.clientWidth + 1);
    }));
    await emit('yugioh-counts-update', { player: 1, counts: { hand: 4, deck: 32, extra: 15, graveyard: 14, banished: 3 } });

    // updateMatchInfo runs once a second off the timer; it used to rebuild the
    // phase stepper's markup on every one of those ticks.
    await at(() => { document.querySelector('#phaseStepper .phase-chip').dataset.stamp = 'ph'; });
    await emit('timer-set', { minutes: 21, seconds: 9 });
    await emit('yugioh-phase-update', { phase: 'Battle' });
    check('phase stepper highlights without rebuilding its chips', await at(() => {
        const first = document.querySelector('#phaseStepper .phase-chip');
        const on = document.querySelector('#phaseStepper .phase-chip.on');
        return first.dataset.stamp === 'ph' && on && on.textContent === 'Battle';
    }));

    console.log('\n-- polish: idle-zone motion --');
    check('empty zones drift the diamond motif', await at(() => {
        const s = getComputedStyle(document.querySelector('#p2Monsters .zone-cell.empty'), '::before');
        return s.animationName === 'zone-drift' && s.backgroundImage.includes('svg');
    }));
    check('idle-zone drift is slow enough to ignore', await at(() =>
        parseFloat(getComputedStyle(document.querySelector('#p2Monsters .zone-cell.empty'), '::before').animationDuration) >= 5));
    check('idle-zone drift is staggered across the row', await at(() => {
        const cells = Array.from(document.querySelectorAll('#p2Monsters .zone-cell.empty'));
        return cells.length === 5 && new Set(cells.map(c => c.style.getPropertyValue('--drift-delay'))).size === 5;
    }));
    check('the two zone rows do not drift in lockstep', await at(() => {
        const m = document.querySelector('#p2Monsters .zone-cell.empty').style.getPropertyValue('--drift-delay');
        const s = document.querySelector('#p2SpellsTraps .zone-cell.empty').style.getPropertyValue('--drift-delay');
        return m !== s;
    }));
    check('the empty field slot also drifts, with no leftover label', await at(() => {
        const el = document.querySelector('#p2Field .field-empty.idle');
        return !!el && el.textContent.trim() === ''
            && getComputedStyle(el, '::before').animationName === 'zone-drift';
    }));
    check('a card entering a zone gets an entrance animation', await at(() =>
        getComputedStyle(document.querySelector('#p1Monsters .zone-cell.filled')).animationName === 'card-swap'));

    console.log('\n-- polish: life-point ticker --');
    await emit('yugioh-life-update', { player: 1, lifePoints: 8000 });
    await overlay.waitForTimeout(1300);
    await emit('yugioh-life-update', { player: 1, lifePoints: 5000 });
    check('LP ticker shows the damage taken', await at(() => {
        const pop = document.querySelector('#player1Board .lp-pop');
        return !!pop && pop.textContent === '-3,000' && !pop.classList.contains('heal');
    }));
    // Presence is not enough: an absolutely-positioned pop inside an
    // overflow:hidden parent renders zero pixels and still passes a DOM test.
    check('LP ticker is actually visible, not clipped away', await at(() => {
        const pop = document.querySelector('#player1Board .lp-pop');
        if (!pop) return false;
        const r = pop.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        let node = pop.parentElement;
        while (node && node !== document.body) {
            if (getComputedStyle(node).overflow !== 'visible') {
                const nr = node.getBoundingClientRect();
                if (r.bottom <= nr.top || r.top >= nr.bottom || r.right <= nr.left || r.left >= nr.right) return false;
            }
            node = node.parentElement;
        }
        return true;
    }));
    check('LP ticker stays inside its panel', await at(() => {
        const pop = document.querySelector('#player1Board .lp-pop').getBoundingClientRect();
        const panel = document.querySelector('#p1LP').closest('.panel').getBoundingClientRect();
        return pop.left >= panel.left && pop.right <= panel.right && pop.top >= panel.top && pop.bottom <= panel.bottom;
    }));
    check('LP ticker clears the numerals and the Normal Summon flag', await at(() => {
        const pop = document.querySelector('#player1Board .lp-pop').getBoundingClientRect();
        const lp = document.getElementById('p1LP').getBoundingClientRect();
        const ns = document.getElementById('p1NS').getBoundingClientRect();
        return pop.left >= lp.right && pop.right <= ns.left;
    }));
    await overlay.waitForTimeout(1300);
    await emit('yugioh-life-update', { player: 1, lifePoints: 7000 });
    check('healing is distinguished from damage', await at(() => {
        const pop = document.querySelector('#player1Board .lp-pop');
        return !!pop && pop.classList.contains('heal') && pop.textContent === '+2,000';
    }));
    await overlay.waitForTimeout(1300);
    await emit('yugioh-life-update', { player: 1, lifePoints: 500 });
    check('critical life points pulse', await at(() => {
        const el = document.getElementById('p1LP');
        return el.classList.contains('critical') && getComputedStyle(el).animationName === 'soft-pulse';
    }));
    check('repeated renders do not restart the critical pulse class', await at(async () => {
        window.__drv.emit('yugioh-counts-update', { player: 1, counts: { hand: 3 } });
        await new Promise(r => setTimeout(r, 200));
        const el = document.getElementById('p1LP');
        return el.classList.contains('critical') && el.className.split(/\s+/).filter(Boolean).length === 2;
    }));

    console.log('\n-- polish: no phantom tickers from restored state --');
    await overlay.waitForTimeout(1300);
    const overlay3 = await browser.newPage();
    await overlay3.goto(`${BASE}/yugioh-match`, { waitUntil: 'networkidle' });
    await overlay3.waitForTimeout(1600);
    // Cold load renders the 8000 default, then request-state drops in LP 500.
    // Without an explicit suppression that diff fires a -7,500 on a board
    // nobody touched.
    check('a freshly loaded overlay fires no phantom LP ticker', await overlay3.evaluate(() =>
        document.querySelectorAll('.lp-pop').length === 0));
    const restoredLp = await overlay3.evaluate(() => document.getElementById('p1LP').textContent.replace(/,/g, ''));
    check('the freshly loaded overlay still shows the restored LP', restoredLp === '500', `saw ${restoredLp}`);
    // A five-second re-registration answers with another full state push; the
    // structural cache has to survive it or every card reloads on that cycle.
    await overlay3.evaluate(() => { document.querySelectorAll('#p1Monsters .zone-cell').forEach((c, i) => { c.dataset.stamp = 'r' + i; }); });
    await overlay3.waitForTimeout(6500);
    check('a re-registration state push does not rebuild the board', await overlay3.evaluate(() =>
        Array.from(document.querySelectorAll('#p1Monsters .zone-cell')).every((c, i) => c.dataset.stamp === 'r' + i)));
    await overlay3.close();

    await emit('yugioh-match-reset', {});
    check('a match reset fires no phantom LP ticker', await at(() =>
        document.querySelectorAll('.lp-pop').length === 0));
    check('a match reset clears every zone', await at(() =>
        document.querySelectorAll('#p1Monsters .zone-cell.empty').length === 5 &&
        document.querySelectorAll('#p1SpellsTraps .zone-cell.empty').length === 5 &&
        !!document.querySelector('#p1Field .field-empty.idle')));

    console.log('\n-- polish: icons, timer and overflow --');
    check('the Normal Summon icon is inline SVG, not an emoji glyph', await at(() =>
        Array.from(document.querySelectorAll('.ns-icon')).length === 2 &&
        Array.from(document.querySelectorAll('.ns-icon')).every(e => !!e.querySelector('svg'))));
    check('no emoji glyphs anywhere in the rendered overlay', await at(() =>
        !/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(document.body.innerText)));

    await emit('timer-set', { minutes: 0, seconds: 45 });
    check('the final minute is flagged on the clock', await at(() => {
        const t = document.getElementById('matchTimer');
        return t.classList.contains('expiring') && getComputedStyle(t).animationName === 'soft-pulse';
    }));
    await emit('timer-set', { minutes: 30, seconds: 0 });
    check('normal time is not flagged', await at(() => !document.getElementById('matchTimer').classList.contains('expiring')));

    const LONG = 'Maximillion Pegasus J. Crawford III';
    await emit('yugioh-match-update', { player1: { name: LONG }, currentTurn: 1 });
    check('a long player name ellipsises instead of overrunning', await at(() => {
        const el = document.getElementById('p1Name');
        return getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth;
    }));
    check('the record chip is not pushed out of the header panel', await at(() => {
        const rec = document.getElementById('p1Record').getBoundingClientRect();
        const panel = document.getElementById('p1Name').closest('.panel').getBoundingClientRect();
        return rec.right <= panel.right - 1 && rec.left >= panel.left;
    }));
    check('a long name does not burst the match-info bar', await at(() => {
        const ti = document.getElementById('turnIndicator').getBoundingClientRect();
        const bar = document.getElementById('matchInfo').getBoundingClientRect();
        return ti.right <= bar.right + 1 && ti.left >= bar.left - 1 && bar.width <= 1200;
    }));
    await emit('yugioh-match-update', { player1: { name: 'Yugi Muto' } });

    console.log('\n-- polish: layout integrity --');
    check('both boards stay inside the 1080 canvas', await at(() =>
        [1, 2].every(n => {
            const r = document.getElementById(`player${n}Board`).getBoundingClientRect();
            return r.top >= -1 && r.bottom <= 1081 && r.left >= -1 && r.right <= 1921;
        })));
    check('no panel overflows its board', await at(() =>
        [1, 2].every(n => {
            const board = document.getElementById(`player${n}Board`);
            const r = board.getBoundingClientRect();
            return Array.from(board.querySelectorAll('.panel')).every(p => {
                const pr = p.getBoundingClientRect();
                return pr.top >= r.top - 1 && pr.bottom <= r.bottom + 1 && pr.left >= r.left - 1 && pr.right <= r.right + 1;
            });
        })));
    check('zone rows fit their panel at five slots', await at(() =>
        ['p1Monsters', 'p1SpellsTraps', 'p2Monsters', 'p2SpellsTraps'].every(id => {
            const row = document.getElementById(id);
            return row.scrollWidth <= row.clientWidth + 1 && row.children.length === 5;
        })));
    check('the match-info bar clears the bottom of the canvas', await at(() => {
        const r = document.getElementById('matchInfo').getBoundingClientRect();
        return r.bottom <= 1080 && r.top > 800;
    }));
    check('the turn rail sits outside the board, between the two boards', await at(() => {
        const l = document.getElementById('player1Board').getBoundingClientRect();
        const r = document.getElementById('player2Board').getBoundingClientRect();
        return l.right < r.left && r.left - l.right > 100;
    }));
    check('no page errors during the run', overlayErrors.length === 0, overlayErrors.join(' | '));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
