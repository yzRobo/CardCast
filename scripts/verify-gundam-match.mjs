// Verification: Gundam match overlay + control, end to end.
//
// Part 1 (original) spawns the server, opens BOTH the control page and the
// overlay page, exercises every control, and asserts the overlay re-renders via
// the socket round-trip.
//
// Part 2 covers the polish pass - active-player emphasis, per-cell render
// caching, idle-slot motion, SVG-not-glyph icons, overflow safety and the
// damage ticker - and asserts GEOMETRY (bounding rects, scrollWidth vs
// clientWidth, computed opacity), not just DOM presence. A ticker that renders
// zero pixels passes a presence test and is still invisible on stream.
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
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };
async function waitForServer(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isUp()) return true;
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

// Only start a server if none is already listening, and only ever kill our own.
const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Unit/Pilot/Base cards from DB', cards.unit && cards.pilot && cards.base,
        JSON.stringify({ unit: cards.unit && cards.unit.card_number, pilot: cards.pilot && cards.pilot.card_number, base: cards.base && cards.base.card_number }));

    browser = await chromium.launch();

    // Overlay page
    const overlay = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const pageErrors = [];
    overlay.on('pageerror', e => pageErrors.push(e.message));
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
    await overlay2.close();

    // ================= POLISH PASS =================
    // Driven straight through a driver socket so payloads can be shaped exactly
    // - including the legacy shapes a state file saved before this pass holds.
    //
    // The control page is closed first. The overlay re-emits register-overlay
    // every 5s, the server answers every one of those with io.emit
    // ('overlay-connected'), and the control answers THAT with a full
    // pushFullState of its own localStorage board - so an open control page
    // overwrites the driver's state on a 5-second heartbeat.
    await control.close();
    console.log('\n--- polish pass ---');
    await overlay.evaluate(() => { window.__drv = io(); });
    await overlay.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = async (e, d) => { await overlay.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]); await overlay.waitForTimeout(140); };
    // Turn emphasis and show/hide cross-fade; sample only once they have landed.
    const settle = (ms = 750) => overlay.waitForTimeout(ms);

    const unitCard = (over = {}) => ({
        id: 'u-zaku', name: 'Zaku II', image: '/images/card-back.png',
        ap: 3, maxHp: 4, currentHp: 4, pilot: null, ...over
    });
    const baseCard = (over = {}) => ({
        id: 'b-white', name: 'White Base', image: '/images/card-back.png',
        maxHp: 5, currentHp: 5, ...over
    });
    const player = (over = {}) => ({
        name: 'Amuro Ray', record: { wins: 5, losses: 1, ties: 0 }, gamesWon: 1,
        shields: 6, shieldsTaken: [], resources: { active: 3, total: 6, ex: true },
        units: [unitCard(), null, null, null, null, null], base: baseCard(), ...over
    });

    await emit('toggle-gundam-match', { show: true });
    await emit('gundam-match-update', {
        player1: player(),
        player2: player({ name: 'Char Aznable', units: [unitCard({ id: 'u-gelgoog', name: 'Gelgoog' }), null, null, null, null, null] }),
        currentTurn: 1, gameNumber: 2, matchFormat: 'Best of 3'
    });
    await emit('timer-set', { minutes: 27, seconds: 14 });

    // ---- Geometry freeze: this is a live OBS scene composition ----
    console.log('\nBoard geometry is unchanged');
    const geo = await overlay.evaluate(() => {
        const r = n => { const b = document.getElementById(`player${n}Board`).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const info = document.getElementById('matchInfo').getBoundingClientRect();
        return { p1: r(1), p2: r(2), infoBottom: info.bottom, infoCentre: info.x + info.width / 2 };
    });
    check('P1 board still 380x940 at x=20,y=70', geo.p1.x === 20 && geo.p1.y === 70 && geo.p1.w === 380 && geo.p1.h === 940, JSON.stringify(geo.p1));
    check('P2 board still 380x940 at x=1520,y=70', geo.p2.x === 1520 && geo.p2.y === 70 && geo.p2.w === 380 && geo.p2.h === 940, JSON.stringify(geo.p2));
    check('match bar still 50px off the bottom, centred', Math.abs(geo.infoBottom - 1030) < 1 && Math.abs(geo.infoCentre - 960) < 1, JSON.stringify(geo));

    console.log('\nLayout integrity');
    check('boards stay inside the 1080 canvas', await overlay.evaluate(() =>
        [1, 2].every(n => { const r = document.getElementById(`player${n}Board`).getBoundingClientRect(); return r.top >= -1 && r.bottom <= 1081; })));
    check('no panel overflows its board', await overlay.evaluate(() =>
        [1, 2].every(n => {
            const board = document.getElementById(`player${n}Board`);
            const r = board.getBoundingClientRect();
            return Array.from(board.querySelectorAll('.panel')).every(p => {
                const pr = p.getBoundingClientRect();
                return pr.top >= r.top - 1 && pr.bottom <= r.bottom + 1 && pr.left >= r.left - 1 && pr.right <= r.right + 1;
            });
        })));
    // Geometry lock. These boards are framed in OBS, so the shield marker box
    // and the row around it must not move when the artwork changes. Measured
    // with offsetWidth/offsetHeight rather than getBoundingClientRect: a spent
    // marker carries transform:scale(0.86), which a rect would fold in and
    // report as ~40x55.
    check('shield marker box is still 46x64', await overlay.evaluate(() => {
        const m = Array.from(document.querySelectorAll('#p1Shields .shield'));
        return m.length === 6 && m.every(s => s.offsetWidth === 46 && s.offsetHeight === 64);
    }));
    check('shield row is still one 64px line spanning 306px', await overlay.evaluate(() => {
        const row = document.getElementById('p1Shields');
        const m = Array.from(row.querySelectorAll('.shield'));
        const last = m[m.length - 1];
        // 6 markers x 46px + 5 gaps x 6px = 306. A wrap would also break this,
        // since every marker must share one offsetTop.
        const span = last.offsetLeft + last.offsetWidth - m[0].offsetLeft;
        return row.offsetHeight === 64 && span === 306 && new Set(m.map(s => s.offsetTop)).size === 1;
    }));
    check('shields panel height unchanged at 115px', await overlay.evaluate(() =>
        document.getElementById('p1Shields').closest('.panel').offsetHeight === 115));
    // scrollWidth vs clientWidth is both whole-pixel rounded, so it cannot see a
    // sub-pixel overhang. Measure each marker against the panel's real content
    // box instead.
    check('every shield sits inside the panel content box', await overlay.evaluate(() => {
        const row = document.getElementById('p1Shields');
        const panel = row.closest('.panel');
        const pr = panel.getBoundingClientRect();
        const cs = getComputedStyle(panel);
        const px = (...p) => p.reduce((n, k) => n + parseFloat(cs[k]), 0);
        const box = {
            left: pr.left + px('borderLeftWidth', 'paddingLeft'),
            right: pr.right - px('borderRightWidth', 'paddingRight'),
            top: pr.top + px('borderTopWidth', 'paddingTop'),
            bottom: pr.bottom - px('borderBottomWidth', 'paddingBottom')
        };
        return Array.from(row.querySelectorAll('.shield')).every(s => {
            const r = s.getBoundingClientRect();
            return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
        });
    }));
    check('unit grid fits its panel', await overlay.evaluate(() => {
        const g = document.getElementById('p1Units');
        return g.scrollWidth <= g.clientWidth + 1;
    }));

    // ---- Active-player emphasis ----
    console.log('\nActive-player emphasis');
    await emit('turn-switch', { currentTurn: 1 });
    await settle();
    check('active board flagged', await overlay.evaluate(() => document.getElementById('player1Board').classList.contains('active-turn')));
    check('idle board flagged', await overlay.evaluate(() => document.getElementById('player2Board').classList.contains('idle-turn')));
    check('idle board is visibly recessed', await overlay.evaluate(() => {
        const s = getComputedStyle(document.getElementById('player2Board'));
        return parseFloat(s.opacity) < 1 && s.filter !== 'none' && /saturate/.test(s.filter);
    }));
    check('active board is not dimmed or desaturated', await overlay.evaluate(() => {
        const s = getComputedStyle(document.getElementById('player1Board'));
        return parseFloat(s.opacity) === 1 && s.filter === 'none';
    }));
    // The rail is the categorical half of the signal - present or absent.
    check('turn rail lit on the active side', await overlay.evaluate(() => {
        const s = getComputedStyle(document.getElementById('player1Board'), '::after');
        return parseFloat(s.opacity) === 1 && parseFloat(s.width) > 0 && parseFloat(s.height) > 0;
    }));
    check('turn rail absent on the idle side', await overlay.evaluate(() =>
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 0));
    check('rail sits on each board\'s inner edge', await overlay.evaluate(() => {
        const l = getComputedStyle(document.getElementById('player1Board'), '::after');
        const r = getComputedStyle(document.getElementById('player2Board'), '::after');
        return l.right === '-11px' && r.left === '-11px';
    }));
    // The board is a fixed 940px but the panels only fill part of it; a rail
    // hanging into the empty remainder reads as a mistake.
    check('rail is measured to the panel stack, not the 940px board', await overlay.evaluate(() => {
        const board = document.getElementById('player1Board');
        const panels = board.querySelectorAll('.panel');
        const last = panels[panels.length - 1];
        const railH = parseFloat(getComputedStyle(board, '::after').height);
        const want = last.offsetTop + last.offsetHeight - 12;
        return Math.abs(railH - want) < 2 && railH < 900;
    }));
    check('active panels pick up an accent glow', await overlay.evaluate(() => {
        const panel = document.querySelector('#player1Board .panel:not(.soft)');
        const idle = document.querySelector('#player2Board .panel:not(.soft)');
        return getComputedStyle(panel).boxShadow !== getComputedStyle(idle).boxShadow;
    }));
    await emit('turn-switch', { currentTurn: 2 });
    await settle();
    check('emphasis follows the turn across', await overlay.evaluate(() =>
        document.getElementById('player2Board').classList.contains('active-turn') &&
        document.getElementById('player1Board').classList.contains('idle-turn') &&
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 1));
    // A hidden board must stay fully hidden: idle-turn's opacity would win on
    // source order if it were not scoped to the shown state.
    await emit('toggle-gundam-match', { show: false });
    await settle();
    check('hidden board stays fully hidden while flagged idle', await overlay.evaluate(() => {
        const b = document.getElementById('player1Board');
        return b.classList.contains('idle-turn') && parseFloat(getComputedStyle(b).opacity) === 0;
    }));
    await emit('toggle-gundam-match', { show: true });
    await emit('turn-switch', { currentTurn: 1 });
    await settle();

    // ---- Render caching ----
    console.log('\nRender caching (no image reload on a counter tick)');
    await overlay.evaluate(() => { document.querySelector('#p1Units .unit-cell.filled .unit-art').dataset.stamp = 'orig'; });
    await emit('gundam-unit-hp', { player: 1, index: 0, currentHp: 2, maxHp: 4 });
    check('unit art survives an HP change', await overlay.evaluate(() =>
        document.querySelector('#p1Units .unit-cell.filled .unit-art')?.dataset.stamp === 'orig'));
    check('unit HP text updated in place', await overlay.evaluate(() =>
        document.querySelector('#p1Units .unit-hp-text').textContent.trim() === '2/4'));
    check('unit HP bar width tracks the ratio', await overlay.evaluate(() =>
        Math.abs(parseFloat(document.querySelector('#p1Units .unit-hp-fill').style.width) - 50) < 0.5));
    // AP is a counter too - editing it must not reload the art.
    await emit('gundam-unit-update', { player: 1, index: 0, unit: unitCard({ ap: 7, currentHp: 2 }) });
    check('unit art survives an AP change', await overlay.evaluate(() =>
        document.querySelector('#p1Units .unit-cell.filled .unit-art')?.dataset.stamp === 'orig'));
    check('AP chip updated in place', await overlay.evaluate(() =>
        document.querySelector('#p1Units .ap-chip').textContent.trim() === 'AP 7'));
    // Cells are independent: touching cell 1 must not disturb cell 0.
    await emit('gundam-unit-update', { player: 1, index: 1, unit: unitCard({ id: 'u-dom', name: 'Dom' }) });
    check('a change in one cell leaves the others alone', await overlay.evaluate(() =>
        document.querySelector('#p1Units .unit-cell[data-slot="0"] .unit-art')?.dataset.stamp === 'orig'));
    check('the changed cell rendered its own card', await overlay.evaluate(() => {
        const c = document.querySelector('#p1Units .unit-cell[data-slot="1"]');
        return c.classList.contains('filled') && !!c.querySelector('.unit-art');
    }));
    // A genuinely different card must rebuild.
    await emit('gundam-unit-update', { player: 1, index: 0, unit: unitCard({ id: 'u-gouf', name: 'Gouf', image: '/images/card-back.png?v=2' }) });
    check('a different card rebuilds the cell', await overlay.evaluate(() =>
        document.querySelector('#p1Units .unit-cell[data-slot="0"] .unit-art')?.dataset.stamp === undefined));
    check('entering card plays an entrance animation', await overlay.evaluate(() =>
        getComputedStyle(document.querySelector('#p1Units .unit-cell.filled')).animationName === 'gd-card-in'));
    await emit('gundam-unit-update', { player: 1, index: 1, unit: null });
    check('clearing a cell returns it to empty', await overlay.evaluate(() =>
        document.querySelector('#p1Units .unit-cell[data-slot="1"]').classList.contains('empty')));
    check('battle-area count tracks filled cells', await overlay.evaluate(() =>
        document.getElementById('p1UnitCount').textContent.trim() === '1/6'));

    // Base caching
    await overlay.evaluate(() => { document.querySelector('#p1Base .base-art').dataset.stamp = 'orig'; });
    await emit('gundam-base-hp', { player: 1, currentHp: 3, maxHp: 5 });
    check('base art survives an HP change', await overlay.evaluate(() =>
        document.querySelector('#p1Base .base-art')?.dataset.stamp === 'orig'));
    check('base HP text updated in place', await overlay.evaluate(() =>
        document.querySelector('#p1Base .base-hp-text').textContent.trim() === '3/5 HP'));

    // ---- Damage ticker geometry ----
    console.log('\nDamage ticker is actually visible, not clipped');
    await emit('gundam-unit-hp', { player: 1, index: 0, currentHp: 1, maxHp: 4 });
    check('unit ticker shows the delta', await overlay.evaluate(() => {
        const p = document.querySelector('#p1Units .dmg-pop');
        return !!p && p.textContent === '-3' && !p.classList.contains('heal');
    }));
    // The unit cell clips its overflow to keep the art inside its radius, so a
    // pop that strays outside the cell renders zero pixels on stream.
    check('unit ticker renders pixels inside its clipping cell', await overlay.evaluate(() => {
        const pop = document.querySelector('#p1Units .dmg-pop');
        if (!pop) return false;
        const r = pop.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        let node = pop.parentElement;
        while (node && node !== document.body) {
            if (getComputedStyle(node).overflow !== 'visible') {
                const n = node.getBoundingClientRect();
                if (r.top < n.top - 1 || r.bottom > n.bottom + 1 || r.left < n.left - 1 || r.right > n.right + 1) return false;
            }
            node = node.parentElement;
        }
        return true;
    }));
    check('unit ticker clears the AP / pilot stack above it', await overlay.evaluate(() => {
        const pop = document.querySelector('#p1Units .dmg-pop').getBoundingClientRect();
        const top = document.querySelector('#p1Units .unit-cell.filled .unit-top').getBoundingClientRect();
        // 16px is the ticker's full rise; it must still clear the stack at apex.
        return pop.top - 16 >= top.bottom - 1;
    }));
    check('unit ticker clears the HP numerals below it', await overlay.evaluate(() => {
        const pop = document.querySelector('#p1Units .dmg-pop').getBoundingClientRect();
        const hp = document.querySelector('#p1Units .unit-cell.filled .unit-hp-text').getBoundingClientRect();
        return pop.bottom <= hp.top + 1;
    }));
    await overlay.waitForTimeout(1200);
    await emit('gundam-unit-hp', { player: 1, index: 0, currentHp: 4, maxHp: 4 });
    check('heal ticker distinguished from damage', await overlay.evaluate(() => {
        const p = document.querySelector('#p1Units .dmg-pop');
        return !!p && p.classList.contains('heal') && p.textContent === '+3';
    }));
    await overlay.waitForTimeout(1200);
    check('tickers clean themselves up', await overlay.evaluate(() => document.querySelectorAll('.dmg-pop').length === 0));

    await emit('gundam-base-hp', { player: 1, currentHp: 1, maxHp: 5 });
    check('base ticker shows the delta', await overlay.evaluate(() =>
        document.querySelector('#p1Base .dmg-pop')?.textContent === '-2'));
    check('base ticker renders pixels and is unclipped', await overlay.evaluate(() => {
        const pop = document.querySelector('#p1Base .dmg-pop');
        if (!pop) return false;
        const r = pop.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        let node = pop.parentElement;
        while (node && node !== document.body) {
            if (getComputedStyle(node).overflow !== 'visible') {
                const n = node.getBoundingClientRect();
                if (r.right <= n.left || r.left >= n.right || r.bottom <= n.top || r.top >= n.bottom) return false;
            }
            node = node.parentElement;
        }
        return true;
    }));
    check('base ticker does not sit on the base name', await overlay.evaluate(() => {
        const el = document.querySelector('#p1Base .dmg-pop');
        if (!el) return false;
        const pop = el.getBoundingClientRect();
        const name = document.querySelector('#p1Base .base-name').getBoundingClientRect();
        return pop.top >= name.bottom - 1;
    }));
    check('base ticker stays inside its panel', await overlay.evaluate(() => {
        const el = document.querySelector('#p1Base .dmg-pop');
        if (!el) return false;
        const pop = el.getBoundingClientRect();
        const panel = document.getElementById('p1Base').closest('.panel').getBoundingClientRect();
        return pop.left >= panel.left && pop.right <= panel.right && pop.top >= panel.top && pop.bottom <= panel.bottom;
    }));
    await overlay.waitForTimeout(1200);

    // ---- Idle-slot motion ----
    console.log('\nIdle slots stay alive');
    check('empty cells drift a reticle motif', await overlay.evaluate(() => {
        const cell = document.querySelector('#p1Units .unit-cell.empty');
        const s = getComputedStyle(cell, '::before');
        return s.animationName === 'gd-drift' && s.backgroundImage.includes('svg') && s.animationDuration === '7s';
    }));
    check('idle drift is dim, not distracting', await overlay.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('#p1Units .unit-cell.empty'));
        return cells.every(c => parseFloat(getComputedStyle(c, '::before').opacity) <= 0.2);
    }));
    check('idle drift is staggered per cell', await overlay.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('#p1Units .unit-cell'));
        const delays = cells.map(c => c.style.getPropertyValue('--drift-delay'));
        return cells.length === 6 && new Set(delays).size === 6 && delays.every(d => d.startsWith('-'));
    }));
    check('the motif is line art, never an emoji glyph', await overlay.evaluate(() => {
        const s = getComputedStyle(document.querySelector('#p1Units .unit-cell.empty'), '::before');
        return s.content === '""' && s.backgroundImage.includes('svg');
    }));
    await emit('gundam-base-update', { player: 1, base: null });
    check('the idle base box breathes rather than drifting off its edge', await overlay.evaluate(() => {
        const box = document.querySelector('#p1Base .base-empty.idle');
        if (!box) return false;
        const s = getComputedStyle(box, '::before');
        return s.animationName === 'gd-breathe' && parseFloat(s.opacity) <= 0.25;
    }));
    check('empty base still reads "No Base"', await overlay.evaluate(() =>
        document.getElementById('p1Base').textContent.includes('No Base')));
    await emit('gundam-base-update', { player: 1, base: baseCard({ currentHp: 1 }) });

    // ---- No emoji as UI icons ----
    console.log('\nIcons are inline SVG, not glyphs');
    // Two spent of six, then settle. Deliberately NOT the low state: at 2
    // remaining the row runs gd-pulse, which animates opacity, so a remaining
    // marker would never read as opacity 1. Settling also lets the 0.35s spent
    // transition finish - filter lists of different shapes interpolate
    // discretely, so mid-flight the computed filter is still the drop-shadow.
    await emit('gundam-shield-taken', { player: 1, shieldsTaken: [0, 1] });
    await waitOverlay(() => document.querySelectorAll('#p1Shields .shield.taken').length === 2);
    await settle(500);

    // The marker is the artwork itself - a shield drawn as a data-URI SVG on the
    // element's own background, in the same line-art register as the reticle the
    // empty cells drift. Not a plate with a glyph stamped on it.
    check('shield marker is a data-URI SVG on the element background', await overlay.evaluate(() => {
        const s = getComputedStyle(document.querySelector('#p1Shields .shield'));
        return s.backgroundImage.includes('svg') && s.backgroundRepeat === 'no-repeat';
    }));
    check('each side draws its own accent shield, not one shared colour', await overlay.evaluate(() => {
        const a = getComputedStyle(document.querySelector('#p1Shields .shield')).backgroundImage;
        const b = getComputedStyle(document.querySelector('#p2Shields .shield')).backgroundImage;
        return a !== b && a.includes('6366f1') && b.includes('ef4444');
    }));
    // A spent shield is removed visually. The old treatment stamped a red X over
    // it via ::after, which reads as an error state on stream - assert the
    // pseudo-elements are gone, not merely that something else is present.
    check('spent shield carries no stamped-on glyph or overlay', await overlay.evaluate(() => {
        const el = document.querySelector('#p1Shields .shield.taken');
        return ['::after', '::before'].every(p => getComputedStyle(el, p).content === 'none');
    }));
    check('spent shield is drained, not marked', await overlay.evaluate(() => {
        const s = getComputedStyle(document.querySelector('#p1Shields .shield.taken'));
        return /grayscale/.test(s.filter) && parseFloat(s.opacity) < 0.5 && s.transform !== 'none';
    }));
    check('remaining shield keeps a drop-shadow and is not drained', await overlay.evaluate(() => {
        const s = getComputedStyle(document.querySelector('#p1Shields .shield:not(.taken)'));
        return /drop-shadow/.test(s.filter) && !/grayscale/.test(s.filter) && parseFloat(s.opacity) === 1;
    }));
    check('the spent transition animates rather than snapping', await overlay.evaluate(() => {
        const s = getComputedStyle(document.querySelector('#p1Shields .shield'));
        return ['filter', 'opacity', 'transform'].every(p => s.transitionProperty.includes(p))
            && parseFloat(s.transitionDuration) > 0;
    }));
    // A remaining marker must outrank a spent one on every channel at once -
    // that is what makes the count readable at a glance rather than by squinting.
    check('remaining shields out-read spent ones on brightness and size', await overlay.evaluate(() => {
        const spent = document.querySelector('#p1Shields .shield.taken');
        const live = document.querySelector('#p1Shields .shield:not(.taken)');
        const so = parseFloat(getComputedStyle(spent).opacity);
        const lo = parseFloat(getComputedStyle(live).opacity);
        return lo - so >= 0.5
            && spent.getBoundingClientRect().width < live.getBoundingClientRect().width;
    }));

    // Restore the four-taken state the low-shield checks below expect.
    await emit('gundam-shield-taken', { player: 1, shieldsTaken: [0, 1, 2, 3] });
    check('taken shields marked', await waitOverlay(() =>
        document.querySelectorAll('#p1Shields .shield.taken').length === 4));
    check('no dingbat or emoji glyphs anywhere on the boards', await overlay.evaluate(() => {
        const text = [1, 2].map(n => document.getElementById(`player${n}Board`).textContent).join('');
        return !/[←-⯿☀-➿️\u{1F000}-\u{1FAFF}]/u.test(text);
    }));

    // ---- State legibility ----
    console.log('\nState legibility');
    check('low shields flagged on the row and the count', await overlay.evaluate(() =>
        document.getElementById('p1Shields').classList.contains('low') &&
        document.getElementById('p1ShieldCount').classList.contains('low') &&
        document.getElementById('p1ShieldCount').textContent.trim() === '2/6'));
    await emit('gundam-shield-taken', { player: 1, shieldsTaken: [] });
    check('restoring shields clears the low state', await overlay.evaluate(() =>
        !document.getElementById('p1Shields').classList.contains('low') &&
        document.getElementById('p1ShieldCount').textContent.trim() === '6/6'));
    await emit('gundam-unit-hp', { player: 1, index: 0, currentHp: 1, maxHp: 5 });
    check('critical unit HP pulses and tints its cell', await overlay.evaluate(() => {
        const fill = document.querySelector('#p1Units .unit-hp-fill');
        const cell = document.querySelector('#p1Units .unit-cell.filled');
        return fill.classList.contains('critical') && cell.classList.contains('critical') &&
            getComputedStyle(fill).animationName === 'gd-pulse';
    }));
    await emit('gundam-unit-hp', { player: 1, index: 0, currentHp: 2, maxHp: 5 });
    check('mid HP is flagged low, not critical', await overlay.evaluate(() => {
        const f = document.querySelector('#p1Units .unit-hp-fill');
        return f.classList.contains('low') && !f.classList.contains('critical');
    }));
    check('critical base HP pulses', await overlay.evaluate(() => {
        const f = document.querySelector('#p1Base .base-hp-fill');
        return f.classList.contains('critical') && getComputedStyle(f).animationName === 'gd-pulse';
    }));
    await emit('gundam-resource-update', { player: 1, resources: { active: 0, total: 6, ex: false } });
    check('tapped-out resources read as spent', await overlay.evaluate(() =>
        document.getElementById('p1Resources').classList.contains('spent')));
    await emit('gundam-resource-update', { player: 1, resources: { active: 3, total: 6, ex: true } });
    check('resources back to normal when available', await overlay.evaluate(() =>
        !document.getElementById('p1Resources').classList.contains('spent')));

    console.log('\nTimer');
    await emit('timer-set', { minutes: 0, seconds: 45 });
    await settle(500); // .timer cross-fades its colour over 0.4s
    check('final minute flagged expiring', await overlay.evaluate(() => {
        const t = document.getElementById('matchTimer');
        return t.classList.contains('expiring') && getComputedStyle(t).color === 'rgb(248, 113, 113)';
    }));
    await emit('timer-set', { minutes: 30, seconds: 0 });
    check('normal time not flagged', await overlay.evaluate(() => !document.getElementById('matchTimer').classList.contains('expiring')));
    // The server replays a placeholder gundamMatch.timer on every request-state;
    // it must not clobber a clock the producer has already set.
    await emit('request-state', 'gundam-match');
    await overlay.waitForTimeout(300);
    check('a state replay does not reset the set clock', await overlay.evaluate(() =>
        document.getElementById('matchTimer').textContent === '30:00'));

    // ---- Overflow safety ----
    console.log('\nOverflow safety');
    const longName = 'Quattro Bajeena Vagina Ghina Aznable';
    await emit('gundam-match-update', { player1: { name: longName, record: { wins: 12, losses: 11, ties: 10 } } });
    check('long player name truncates rather than overflowing', await overlay.evaluate(() => {
        const n = document.getElementById('p1Name');
        const rec = document.getElementById('p1Record');
        const s = getComputedStyle(n);
        return s.textOverflow === 'ellipsis' && n.scrollWidth > n.clientWidth &&
            n.getBoundingClientRect().right <= rec.getBoundingClientRect().left + 1;
    }));
    check('the record chip never loses a digit', await overlay.evaluate(() => {
        const rec = document.getElementById('p1Record');
        return rec.scrollWidth <= rec.clientWidth + 1 && rec.textContent.trim() === '12-11-10';
    }));
    check('header contents stay inside the panel', await overlay.evaluate(() => {
        const panel = document.getElementById('p1Name').closest('.panel').getBoundingClientRect();
        return ['p1Name', 'p1Record', 'p1GamesWon'].every(id => {
            const r = document.getElementById(id).getBoundingClientRect();
            return r.left >= panel.left - 1 && r.right <= panel.right + 1;
        });
    }));
    check('long turn-indicator name stays inside the match bar', await overlay.evaluate(() => {
        const t = document.getElementById('turnIndicator').getBoundingClientRect();
        const bar = document.getElementById('matchInfo').getBoundingClientRect();
        return t.right <= bar.right + 1 && t.left >= bar.left - 1 && bar.left >= 0 && bar.right <= 1920;
    }));
    // Numerals that silently lose a digit are worse than visible truncation:
    // a clipped "999/999" reads as "999/99".
    await emit('gundam-unit-update', { player: 1, index: 0, unit: unitCard({ ap: 999, maxHp: 999, currentHp: 999 }) });
    check('three-digit unit HP is not clipped', await overlay.evaluate(() => {
        const t = document.querySelector('#p1Units .unit-hp-text');
        return t.textContent.trim() === '999/999' && t.scrollWidth <= t.clientWidth + 1;
    }));
    check('a three-digit AP chip stays inside its cell', await overlay.evaluate(() => {
        const chip = document.querySelector('#p1Units .ap-chip').getBoundingClientRect();
        const cell = document.querySelector('#p1Units .unit-cell.filled').getBoundingClientRect();
        return chip.right <= cell.right + 1 && chip.left >= cell.left - 1;
    }));
    await emit('gundam-pilot-pair', { player: 1, index: 0, pilot: { name: 'Char Aznable (The Red Comet of Zeon)', image: '/images/card-back.png' } });
    check('long pilot name ellipses inside the cell', await overlay.evaluate(() => {
        const span = document.querySelector('#p1Units .pilot-chip span');
        const chip = document.querySelector('#p1Units .pilot-chip').getBoundingClientRect();
        const cell = document.querySelector('#p1Units .unit-cell.filled').getBoundingClientRect();
        return getComputedStyle(span).textOverflow === 'ellipsis' && span.scrollWidth > span.clientWidth &&
            chip.right <= cell.right + 1 && chip.left >= cell.left - 1;
    }));
    check('pilot chip does not cover the HP readout', await overlay.evaluate(() => {
        const chip = document.querySelector('#p1Units .pilot-chip').getBoundingClientRect();
        const hp = document.querySelector('#p1Units .unit-hp-wrap').getBoundingClientRect();
        return chip.bottom <= hp.top + 1;
    }));
    await emit('gundam-base-update', { player: 1, base: baseCard({ name: 'Asticassia School of Technology, Earth House Workshop Annex' }) });
    check('long base name ellipses inside its panel', await overlay.evaluate(() => {
        const n = document.querySelector('#p1Base .base-name');
        const panel = document.getElementById('p1Base').closest('.panel').getBoundingClientRect();
        const r = n.getBoundingClientRect();
        return getComputedStyle(n).textOverflow === 'ellipsis' && n.scrollWidth > n.clientWidth && r.right <= panel.right + 1;
    }));

    // ---- Legacy payloads ----
    // A state file written before this pass carries none of the newer fields.
    console.log('\nLegacy / partial payloads still render');
    await emit('gundam-match-update', {
        player2: { name: 'Legacy', units: [{ id: 'legacy', name: 'Old Unit', image: '/images/card-back.png' }, null, null, null, null, null], base: { name: 'Old Base', image: '/images/card-back.png' } }
    });
    check('a unit with no AP or HP fields still renders', await overlay.evaluate(() => {
        const cell = document.querySelector('#p2Units .unit-cell.filled');
        return !!cell && !!cell.querySelector('.unit-art') &&
            cell.querySelector('.ap-chip').textContent.trim() === 'AP -' &&
            /^\d+\/\d+$/.test(cell.querySelector('.unit-hp-text').textContent.trim());
    }));
    check('a base with no HP fields still renders', await overlay.evaluate(() =>
        /\d+\/\d+ HP/.test(document.querySelector('#p2Base .base-hp-text').textContent)));
    await emit('gundam-match-update', { player2: { name: 'Sparse', units: undefined, shieldsTaken: undefined, resources: undefined } });
    check('a player payload missing arrays does not break the board', await overlay.evaluate(() =>
        document.querySelectorAll('#p2Units .unit-cell').length === 6 &&
        document.querySelectorAll('#p2Shields .shield').length === 6));
    await emit('turn-switch', { currentTurn: 9 });
    check('an out-of-range turn falls back instead of throwing', await overlay.evaluate(() =>
        /'s Turn$/.test(document.getElementById('turnIndicator').textContent)));
    await emit('turn-switch', { currentTurn: 1 });

    console.log('\nScript health');
    check('no page errors during the whole run', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
