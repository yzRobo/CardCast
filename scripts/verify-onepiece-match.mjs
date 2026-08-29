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

// Reuse a dev server that is already listening rather than racing it for the
// port; only a server this script started is ever shut down again.
const alreadyUp = await fetch(BASE + '/api/config').then(r => r.ok).catch(() => false);
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
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

    // ================= Polish pass =================
    // Driven straight off a socket so the exact payload is under test, and
    // asserted on geometry (rects, scrollWidth, computed opacity) rather than
    // DOM presence - the traps in this pass were all things that existed in the
    // DOM and still rendered wrong.
    console.log('\n--- polish pass ---');
    // The control page re-pushes its whole local state every time any overlay
    // sends its 5-second register-overlay ping, which would overwrite the
    // payloads under test mid-check. Phase 1 is done with it, so close it (and
    // the spare overlays whose pings trigger it) before driving the socket
    // directly.
    await control.close();
    await overlay.close();
    await overlay2.close();
    await new Promise(r => setTimeout(r, 400));

    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`${BASE}/onepiece-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    // The overlay requests stored state 500ms after load; let that land first.
    await page.waitForTimeout(1200);
    // Whatever clock the server has stored - used below to prove the
    // clock-persistence check is not comparing a value against itself.
    const storedTimer = await page.textContent('#matchTimer');
    const emit = async (ev, data) => {
        await page.evaluate(([e, d]) => window.__drv.emit(e, d), [ev, data]);
        await page.waitForTimeout(120);
    };
    // Socket round-trip latency under four open pages is not fixed, so every
    // assertion that depends on an event landing polls for it rather than
    // sleeping a guessed interval.
    const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);
    const seen = async (fn, arg) => { await wait(fn, arg); return page.evaluate(fn, arg); };

    const IMG = '/images/card-back.png';
    const mkChar = (i, over = {}) => ({ id: `pc${i}`, name: `Character ${i}`, image: IMG, power: 5000, counter: 1000, colors: 'red', donAttached: 0, ...over });
    const board = (name, over = {}) => ({
        name, record: { wins: 1, losses: 0, ties: 0 }, gamesWon: 0,
        leader: { id: 'pl1', name: 'Test Leader', image: IMG, power: 5000, colors: 'red/green' },
        life: { total: 5, taken: [] },
        don: { active: 3, rested: 1, max: 10 },
        characters: [mkChar(0), mkChar(1), null, null, null],
        stage: null,
        ...over
    });

    await emit('toggle-onepiece-match', { show: true });
    await emit('onepiece-match-update', { player1: board('Alpha'), player2: board('Beta'), currentTurn: 1 });
    await wait(() => document.getElementById('p1Name').textContent === 'Alpha' &&
        document.querySelectorAll('#p1Chars .char-cell:not(.empty)').length === 2);

    // ---- Layout is untouched: this is polish, not a re-layout ----
    check('left board geometry unchanged (20,40 390x1000)', await page.evaluate(() => {
        const r = document.getElementById('player1Board').getBoundingClientRect();
        return Math.round(r.left) === 20 && Math.round(r.top) === 40 && Math.round(r.width) === 390 && Math.round(r.height) === 1000;
    }));
    check('right board geometry unchanged (right edge 1900)', await page.evaluate(() => {
        const r = document.getElementById('player2Board').getBoundingClientRect();
        return Math.round(r.right) === 1900 && Math.round(r.top) === 40 && Math.round(r.width) === 390;
    }));
    check('match info bar still 50px off the bottom', await page.evaluate(() =>
        Math.round(document.getElementById('matchInfo').getBoundingClientRect().bottom) === 1030));

    // ---- Active-player emphasis ----
    check('active board flagged, idle board flagged', await page.evaluate(() =>
        document.getElementById('player1Board').classList.contains('active-turn') &&
        document.getElementById('player2Board').classList.contains('idle-turn')));
    check('idle board is visibly recessed', await page.evaluate(() => {
        const s = getComputedStyle(document.getElementById('player2Board'));
        return parseFloat(s.opacity) < 1 && s.filter !== 'none';
    }));
    check('active board stays at full strength', await page.evaluate(() => {
        const s = getComputedStyle(document.getElementById('player1Board'));
        return parseFloat(s.opacity) === 1 && s.filter === 'none';
    }));
    check('turn rail lit on the active side', await page.evaluate(() => {
        const s = getComputedStyle(document.getElementById('player1Board'), '::after');
        return parseFloat(s.opacity) === 1 && parseFloat(s.width) > 0 && parseFloat(s.height) > 100;
    }));
    check('turn rail absent on the idle side', await page.evaluate(() =>
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 0));
    check('rail sits on the inner edge of each board', await page.evaluate(() => {
        const l = getComputedStyle(document.getElementById('player1Board'), '::after');
        const r = getComputedStyle(document.getElementById('player2Board'), '::after');
        return parseFloat(l.right) < 0 && parseFloat(r.left) < 0;
    }));
    // The board box is 1000px tall but the panel stack is shorter; a rail run to
    // the box edge would trail 200px of stray line under the last panel.
    check('rail is sized to the panel stack, not the empty box', await page.evaluate(() => {
        const b = document.getElementById('player1Board');
        const last = b.lastElementChild;
        const content = last.offsetTop + last.offsetHeight;
        const railH = parseFloat(getComputedStyle(b, '::after').height);
        return content < 950 && Math.abs(railH - (content - 8)) <= 2;
    }));
    check('turn pill carries the active player accent', await page.evaluate(() =>
        document.getElementById('matchInfo').classList.contains('turn-p1') &&
        !document.getElementById('matchInfo').classList.contains('turn-p2')));
    await emit('turn-switch', { currentTurn: 2 });
    // The rail cross-fades over 0.45s, so poll rather than sample mid-transition.
    check('emphasis follows the turn across', await seen(() => {
        const p2 = getComputedStyle(document.getElementById('player2Board'), '::after');
        const p1 = getComputedStyle(document.getElementById('player1Board'), '::after');
        return document.getElementById('player2Board').classList.contains('active-turn') &&
            document.getElementById('player1Board').classList.contains('idle-turn') &&
            parseFloat(p2.opacity) > 0.95 && parseFloat(p1.opacity) < 0.05 &&
            document.getElementById('matchInfo').classList.contains('turn-p2');
    }));
    await emit('turn-switch', { currentTurn: 1 });
    await wait(() => document.getElementById('player1Board').classList.contains('active-turn'));

    // ---- Render caching: numbers must not rebuild markup ----
    await page.evaluate(() => {
        document.querySelectorAll('#p1Chars .char-cell').forEach((c, i) => {
            const img = c.querySelector('.char-art');
            if (img) img.dataset.stamp = `cell${i}`;
        });
        const pip = document.querySelector('#p1Life .life-pip'); if (pip) pip.dataset.stamp = 'life0';
        const don = document.querySelector('#p1DonTrack .don-pip'); if (don) don.dataset.stamp = 'don0';
    });
    await emit('onepiece-don-attach', { player: 1, index: 0, donAttached: 2 });
    check('DON!! attach updates total power in place', await seen(() =>
        document.querySelectorAll('#p1Chars .char-power')[0].textContent.trim() === '7000'));
    check('DON!! attach does not reload the character art', await page.evaluate(() =>
        document.querySelector('#p1Chars .char-cell img.char-art')?.dataset.stamp === 'cell0'));
    check('boosted power is flagged', await page.evaluate(() =>
        document.querySelectorAll('#p1Chars .char-power')[0].classList.contains('boosted')));
    check('DON!! pips rendered on the character', await page.evaluate(() =>
        document.querySelectorAll('#p1Chars .char-cell')[0].querySelectorAll('.char-don').length === 2));

    // onepiece-character-power is a first-class contract event, not a stray
    // listener: server.js relays it into overlayServer.setOnePieceCharacterPower(),
    // which mutates the stored board and re-broadcasts. The emit below leaves the
    // page on a *second* socket, so a pass here is a full client -> server ->
    // overlay round trip, not the overlay talking to itself.
    await emit('onepiece-character-power', { player: 1, index: 0, power: 6000 });
    check('character-power event reaches the overlay', await seen(() =>
        document.querySelectorAll('#p1Chars .char-power')[0].textContent.trim() === '8000'));
    check('character-power update does not reload the art', await page.evaluate(() =>
        document.querySelector('#p1Chars .char-cell img.char-art')?.dataset.stamp === 'cell0'));
    // ...and the server *stores* it, which is what separates a live contract
    // path from a blind echo. request-state answers only the socket that asked,
    // so reading the board back here cannot disturb the overlay under test.
    const storedBoard = await page.evaluate(() => new Promise(res => {
        const t = setTimeout(() => res(null), 4000);
        window.__drv.once('onepiece-match-state', s => { clearTimeout(t); res(s); });
        window.__drv.emit('request-state', 'onepiece-match');
    }));
    const storedChar = storedBoard && storedBoard.player1 && Array.isArray(storedBoard.player1.characters)
        ? storedBoard.player1.characters[0] : null;
    check('character-power mutates the board stored on the server',
        !!storedChar && Number(storedChar.power) === 6000, JSON.stringify(storedChar));

    // ---- Leader: a power edit is a number change, not a new card ----
    // Folding power/colours into the render-cache signature made every hand-edit
    // rewrite the Leader markup, which re-fetched the art and replayed the 0.45s
    // entrance animation - in OBS that reads as the Leader flickering mid-match.
    const LEADER = { id: 'pl1', name: 'Test Leader', image: IMG, colors: 'red/green' };
    await wait(() => document.querySelector('#p1Leader .leader-art') !== null);
    const leaderBefore = await page.evaluate(() => {
        const img = document.querySelector('#p1Leader .leader-art');
        img.dataset.stamp = 'leader0';
        const r = img.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
    });
    await emit('onepiece-leader-update', { player: 1, leader: { ...LEADER, power: 7000 }, seedLife: false });
    check('editing Leader power updates the chip in place', await seen(() => {
        const chip = document.querySelector('#p1Leader .power-chip');
        return !!chip && chip.textContent.trim() === '7000' && getComputedStyle(chip).display !== 'none';
    }));
    check('a Leader power edit does not reload the card art', await page.evaluate(() =>
        document.querySelector('#p1Leader .leader-art')?.dataset.stamp === 'leader0'));
    // Element identity alone could survive a rebuild that happened to reuse the
    // node, so also assert the art is visually at rest: nothing animating, full
    // opacity, no transform, and the exact rect it occupied before the edit.
    check('a Leader power edit does not replay the entrance animation', await page.evaluate((b) => {
        const img = document.querySelector('#p1Leader .leader-art');
        if (!img) return false;
        const s = getComputedStyle(img);
        const r = img.getBoundingClientRect();
        return !img.getAnimations().some(a => a.playState === 'running') &&
            s.opacity === '1' && s.transform === 'none' &&
            Math.round(r.width) === b.w && Math.round(r.height) === b.h &&
            Math.round(r.left) === b.x && Math.round(r.top) === b.y;
    }, leaderBefore));
    // Colours carried the same latent problem - metadata on a card that is
    // already on screen, so they repaint without touching the art either.
    await emit('onepiece-leader-update', { player: 1, leader: { ...LEADER, power: 7000, colors: 'blue' }, seedLife: false });
    check('a Leader colour edit repaints the dots in place', await seen(() => {
        const dots = document.querySelectorAll('#p1Leader .color-dot');
        return dots.length === 1 && getComputedStyle(dots[0]).backgroundColor === 'rgb(59, 130, 246)';
    }));
    check('a Leader colour edit does not reload the card art', await page.evaluate(() => {
        const img = document.querySelector('#p1Leader .leader-art');
        return !!img && img.dataset.stamp === 'leader0' && !img.getAnimations().some(a => a.playState === 'running');
    }));
    // Guard the other edge: a genuinely different card must STILL take the
    // rebuild path, or a "never rebuild" bug would sail through everything
    // above. The animation state is sampled inside the same poll that first
    // sees the new name, so the 450ms window is never raced.
    await page.evaluate(([e, d]) => window.__drv.emit(e, d), ['onepiece-leader-update',
        { player: 1, leader: { id: 'pl2', name: 'Second Leader', image: IMG, power: 4000, colors: 'green' }, seedLife: false }]);
    const rebuilt = await page.waitForFunction(() => {
        const nameEl = document.querySelector('#p1Leader .leader-name');
        const img = document.querySelector('#p1Leader .leader-art');
        if (!nameEl || !img || nameEl.textContent !== 'Second Leader') return null;
        return {
            fresh: img.dataset.stamp === undefined,
            animating: img.getAnimations().some(a => a.playState === 'running' && a.animationName === 'card-enter')
        };
    }, null, { timeout: 6000 }).then(h => h.jsonValue()).catch(() => ({ fresh: false, animating: false }));
    check('a different Leader card does rebuild and animate in', rebuilt.fresh && rebuilt.animating, JSON.stringify(rebuilt));
    check('the rebuilt Leader carries its own power and colours', await seen(() => {
        const dot = document.querySelector('#p1Leader .color-dot');
        return document.querySelector('#p1Leader .power-chip')?.textContent.trim() === '4000' &&
            document.querySelectorAll('#p1Leader .color-dot').length === 1 &&
            getComputedStyle(dot).backgroundColor === 'rgb(34, 197, 94)';
    }));
    // A powerless Leader must leave no empty chip behind: the swatches sit flush
    // to the left of the meta row, which a bordered-but-blank chip would shove
    // ~20px right.
    await emit('onepiece-leader-update', { player: 1, leader: { id: 'pl3', name: 'Powerless Leader', image: IMG, colors: 'red' }, seedLife: false });
    check('a Leader with no printed power shows no empty chip', await seen(() => {
        const chip = document.querySelector('#p1Leader .power-chip');
        const meta = document.querySelector('#p1Leader .leader-meta');
        const dot = document.querySelector('#p1Leader .color-dot');
        if (!meta || !dot) return false;
        return (!chip || getComputedStyle(chip).display === 'none') &&
            Math.round(dot.getBoundingClientRect().left) <= Math.round(meta.getBoundingClientRect().left) + 1;
    }));
    // Back to the pl1 Leader the later overflow / reset checks expect.
    await emit('onepiece-leader-update', { player: 1, leader: { ...LEADER, power: 5000 }, seedLife: false });
    await wait(() => document.querySelector('#p1Leader .leader-name')?.textContent === 'Test Leader');

    // One slot changing must not churn the other four.
    await emit('onepiece-character-update', { player: 1, index: 2, character: mkChar(2) });
    check('character count in the section title tracks fills', await seen(() =>
        document.getElementById('p1CharCount').textContent.trim() === '3/5'));
    check('filling one slot leaves the neighbours untouched', await page.evaluate(() => {
        const cells = document.querySelectorAll('#p1Chars .char-cell');
        // Both neighbours must still be filled AND still hold the same <img>.
        return [0, 1].every(i => !cells[i].classList.contains('empty') &&
            cells[i].querySelector('img.char-art')?.dataset.stamp === `cell${i}` &&
            !!cells[i].querySelector('img.char-art').getAttribute('src'));
    }));
    check('new character animates in', await page.evaluate(() =>
        document.querySelectorAll('#p1Chars .char-cell')[2].querySelector('.char-art').classList.contains('enter')));

    // Plenty of One Piece records carry no art URL at all; a filled slot must
    // still read as a card rather than a blank hole in the row.
    await emit('onepiece-character-update', { player: 1, index: 3, character: mkChar(3, { image: '' }) });
    check('a character with no art falls back to a card back', await seen(() => {
        const cell = document.querySelectorAll('#p1Chars .char-cell')[3];
        const img = cell.querySelector('.char-art');
        const r = img.getBoundingClientRect();
        return !cell.classList.contains('empty') && getComputedStyle(img).display !== 'none' &&
            img.naturalWidth > 0 && r.width > 10 && r.height > 10;
    }));
    await emit('onepiece-character-update', { player: 1, index: 3, character: null });

    await emit('onepiece-life-taken', { player: 1, taken: [0, 1], total: 5 });
    check('taken pips flagged in place', await seen(() =>
        document.querySelectorAll('#p1Life .life-pip.taken').length === 2));
    check('taking Life does not rebuild the pip track', await page.evaluate(() =>
        document.querySelector('#p1Life .life-pip')?.dataset.stamp === 'life0'));
    await emit('onepiece-don-update', { player: 1, don: { active: 7, rested: 2, max: 10 } });
    await wait(() => document.getElementById('p1DonActive').textContent === '7');
    check('DON!! change does not rebuild the track', await page.evaluate(() =>
        document.querySelector('#p1DonTrack .don-pip')?.dataset.stamp === 'don0'));
    const donCounts = await page.evaluate(() => ({
        total: document.querySelectorAll('#p1DonTrack .don-pip').length,
        active: document.querySelectorAll('#p1DonTrack .don-pip.active').length,
        rested: document.querySelectorAll('#p1DonTrack .don-pip.rested').length,
        readout: document.getElementById('p1DonActive').textContent
    }));
    check('DON!! pips re-flagged in place', donCounts.active === 7 && donCounts.rested === 2, JSON.stringify(donCounts));

    // ---- Life ticker: present, sized, and not clipped by any ancestor ----
    await emit('onepiece-life-taken', { player: 1, taken: [0, 1, 2], total: 5 });
    await wait(() => document.getElementById('p1LifeCount').textContent.trim().startsWith('2'));
    const popText = await page.$$eval('#player1Board .life-pop', els => els.map(e => e.textContent).join(','));
    // One ticker at a time: two stacked in the same corner read as a smear.
    check('life ticker fires on a Life card being taken', popText === '-1', popText);
    check('life ticker actually renders pixels, unclipped', await page.evaluate(() => {
        const pop = document.querySelector('#player1Board .life-pop');
        if (!pop) return false;
        const r = pop.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        let node = pop.parentElement;
        while (node && node !== document.body) {
            const s = getComputedStyle(node);
            if (s.overflow !== 'visible') {
                const nr = node.getBoundingClientRect();
                if (r.bottom <= nr.top || r.top >= nr.bottom || r.right <= nr.left || r.left >= nr.right) return false;
            }
            node = node.parentElement;
        }
        return true;
    }));
    // The count element is a full-width centred block, so compare against the
    // rendered text run rather than the box - otherwise the check is vacuous.
    check('life ticker clears the Life readout text', await page.evaluate(() => {
        const pop = document.querySelector('#player1Board .life-pop').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('p1LifeCount'));
        const text = range.getBoundingClientRect();
        return text.width > 0 && (pop.left >= text.right - 1 || pop.right <= text.left + 1);
    }));
    await page.waitForTimeout(1400);
    await emit('onepiece-life-taken', { player: 1, taken: [0, 1], total: 5 });
    check('restoring a Life card ticks the other way', await seen(() => {
        const pop = document.querySelector('#player1Board .life-pop');
        return !!pop && pop.textContent === '+1' && pop.classList.contains('gain');
    }));
    await page.waitForTimeout(1400);
    // Reseeding the track length is setup, not a life swing. Measure the panel
    // first: the Life track is variable-length, and growing it must not resize
    // the box the producer framed in OBS.
    const lifePanelH5 = await page.evaluate(() =>
        document.getElementById('p1Life').closest('.panel').getBoundingClientRect().height);
    await emit('onepiece-life-total', { player: 1, total: 8 });
    await wait(() => document.querySelectorAll('#p1Life .life-pip').length === 8);
    check('resizing the Life track fires no phantom ticker', await page.evaluate(() =>
        document.querySelectorAll('#player1Board .life-pop').length === 0));
    check('eight Life pips stay inside the panel', await page.evaluate(() => {
        const row = document.getElementById('p1Life');
        const panel = row.closest('.panel').getBoundingClientRect();
        return row.scrollWidth <= row.clientWidth + 1 &&
            Array.from(row.children).every(p => {
                const r = p.getBoundingClientRect();
                return r.left >= panel.left - 1 && r.right <= panel.right + 1 && r.bottom <= panel.bottom + 1;
            });
    }));

    // ---- Marker geometry is pinned, not merely "fits" ----
    // This board is framed in an OBS source, so the Life marker box and the row
    // around it are fixed numbers. Measure offsetWidth/offsetHeight, which read
    // the layout box: a spent marker carries transform: scale(0.86), so a
    // getBoundingClientRect check would quietly measure the scaled box instead
    // and pass while the real box had changed.
    check('every Life marker keeps a 30x44 layout box', await page.evaluate(() => {
        const pips = Array.from(document.querySelectorAll('#p1Life .life-pip'));
        return pips.length === 8 && pips.every(p => p.offsetWidth === 30 && p.offsetHeight === 44);
    }));
    check('a spent marker keeps that box despite being scaled down', await page.evaluate(() => {
        const p = document.querySelector('#p1Life .life-pip.taken');
        return !!p && p.offsetWidth === 30 && p.offsetHeight === 44 &&
            getComputedStyle(p).transform !== 'none';
    }));
    check('eight markers stay one 44px-tall row, no wrap', await page.evaluate(() => {
        const row = document.getElementById('p1Life');
        const pips = Array.from(row.children);
        return row.getBoundingClientRect().height === 44 &&
            new Set(pips.map(p => p.offsetTop)).size === 1;
    }));
    check('a longer Life track does not grow the panel', await page.evaluate((before) =>
        document.getElementById('p1Life').closest('.panel').getBoundingClientRect().height === before,
        lifePanelH5), `was ${lifePanelH5}`);

    // ---- Critical-state legibility ----
    await emit('onepiece-life-total', { player: 1, total: 5 });
    await wait(() => document.querySelectorAll('#p1Life .life-pip').length === 5);
    await emit('onepiece-life-taken', { player: 1, taken: [0, 1, 2, 3], total: 5 });
    check('one Life left flags the readout critical', await seen(() =>
        document.getElementById('p1LifeCount').classList.contains('critical')));
    check('the surviving Life pip is emphasised', await page.evaluate(() =>
        document.querySelectorAll('#p1Life .life-pip.last').length === 1));
    // The emphasis is a static glow. It used to be an infinite pulse, which is
    // exactly what a browser source running for hours must not do.
    check('the last Life marker glows without moving', await page.evaluate(() => {
        const p = document.querySelector('#p1Life .life-pip.last');
        const s = p && getComputedStyle(p);
        return !!s && s.animationName === 'none' && s.filter.includes('drop-shadow');
    }));
    check('critical pulse is a real animation', await page.evaluate(() =>
        getComputedStyle(document.getElementById('p1LifeCount')).animationName === 'soft-pulse'));
    await emit('onepiece-life-taken', { player: 1, taken: [], total: 5 });
    check('restored Life clears the critical flag', await seen(() =>
        !document.getElementById('p1LifeCount').classList.contains('critical') &&
        document.querySelectorAll('#p1Life .life-pip.last').length === 0));

    await emit('timer-set', { minutes: 0, seconds: 45 });
    check('final minute flagged expiring', await seen(() =>
        document.getElementById('matchTimer').classList.contains('expiring')));
    await emit('timer-set', { minutes: 30, seconds: 0 });
    check('normal time not flagged', await seen(() =>
        document.getElementById('matchTimer').textContent === '30:00' &&
        !document.getElementById('matchTimer').classList.contains('expiring')));

    // ---- Idle-slot motion ----
    check('empty character slots drift a motif', await page.evaluate(() => {
        const slot = document.querySelector('#p1Chars .char-cell.empty');
        const s = getComputedStyle(slot, '::before');
        return s.animationName === 'op-drift' && s.backgroundImage.includes('svg') && parseFloat(s.animationDuration) >= 5;
    }));
    check('idle-slot drift is staggered per slot', await page.$$eval('#p1Chars .char-cell',
        els => new Set(els.map(e => e.style.getPropertyValue('--drift-delay'))).size === els.length));
    check('empty Stage box drifts the same motif', await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('#p1Stage .stage-empty'), '::before');
        return s.animationName === 'op-drift' && s.backgroundImage.includes('svg');
    }));
    check('idle motif stays inside its slot', await page.evaluate(() =>
        Array.from(document.querySelectorAll('#p1Chars .char-cell.empty')).every(c => getComputedStyle(c).overflow === 'hidden')));

    // ---- Life markers: face-down card backs, spent by removal ----
    // These replaced a flat rounded rectangle that stamped a red X over spent
    // markers. Both are gone: the marker is vector card-back art, and a spent
    // one is drained away rather than marked over. Asserting the pseudo-elements
    // are absent is not enough on its own - `content` reads 'none' for a pseudo
    // that was never declared - so pair it with what the marker positively is.
    check('a Life marker is SVG card-back art, not text or a glyph', await page.evaluate(() => {
        const pip = document.querySelector('#p1Life .life-pip');
        return getComputedStyle(pip).backgroundImage.includes('svg') &&
            pip.textContent === '' &&
            getComputedStyle(pip, '::before').content === 'none' &&
            getComputedStyle(pip, '::after').content === 'none';
    }));
    check('a remaining marker lifts off the panel on a drop-shadow', await page.evaluate(() => {
        const pip = document.querySelector('#p1Life .life-pip:not(.taken)');
        return !!pip && getComputedStyle(pip).filter.includes('drop-shadow');
    }));
    await emit('onepiece-life-taken', { player: 1, taken: [0], total: 5 });
    check('a spent marker is drained away, not marked over', await seen(() => {
        const spent = document.querySelector('#p1Life .life-pip.taken');
        const left = document.querySelector('#p1Life .life-pip:not(.taken)');
        if (!spent || !left) return false;
        const s = getComputedStyle(spent);
        return s.backgroundImage === getComputedStyle(left).backgroundImage && // same art
            s.filter.includes('grayscale') &&
            parseFloat(s.opacity) < 0.5 &&
            getComputedStyle(spent, '::after').content === 'none';            // nothing stamped on top
    }));
    check('spent and remaining markers are told apart by more than colour', await page.evaluate(() => {
        const spent = getComputedStyle(document.querySelector('#p1Life .life-pip.taken'));
        const left = getComputedStyle(document.querySelector('#p1Life .life-pip:not(.taken)'));
        return parseFloat(left.opacity) - parseFloat(spent.opacity) > 0.3 &&
            spent.transform !== left.transform;
    }));
    // An OBS source runs unattended for hours: these markers hold still, and
    // only the spent/remaining swap is allowed to move.
    check('Life markers never animate, they only transition', await page.evaluate(() =>
        Array.from(document.querySelectorAll('#p1Life .life-pip')).every(p => {
            const s = getComputedStyle(p);
            return s.animationName === 'none' && parseFloat(s.transitionDuration) > 0;
        })));
    check('no emoji anywhere in the rendered board text', await page.evaluate(() => {
        const text = document.getElementById('player1Board').innerText || '';
        return !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(text);
    }));

    // ---- Overflow safety, verified on geometry ----
    // Pushed as one explicit board so every rect below is measured against a
    // known slot layout rather than whatever the previous checks left behind.
    await emit('onepiece-match-update', {
        player1: board('Alpha', {
            characters: [mkChar(0, { power: 12000, counter: 2000, donAttached: 8 }), mkChar(1, { counter: 0 }), null, null, null]
        }),
        currentTurn: 1
    });
    // scrollWidth/clientWidth are whole-pixel, so `scrollWidth <= clientWidth`
    // still reads true while Chrome paints a clipped glyph on a sub-pixel
    // overhang. Measure the text itself with a Range against the element's
    // content box instead - that comparison is sub-pixel on both sides.
    check('five-digit total power is not clipped', await seen(() => {
        const el = document.querySelectorAll('#p1Chars .char-power')[0];
        if (!el || el.textContent.trim() !== '20000') return false;
        const cs = getComputedStyle(el);
        const contentW = el.getBoundingClientRect().width
            - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
            - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width <= contentW;
    }));
    check('counter chip never overlaps the power readout', await page.evaluate(() => {
        const cell = document.querySelectorAll('#p1Chars .char-cell')[0];
        const chip = cell.querySelector('.counter-chip').getBoundingClientRect();
        const pow = cell.querySelector('.char-power').getBoundingClientRect();
        return chip.bottom <= pow.top && chip.width > 0 && pow.width > 0;
    }));
    check('counter chip stays inside its cell', await page.evaluate(() => {
        const cell = document.querySelectorAll('#p1Chars .char-cell')[0];
        const c = cell.getBoundingClientRect();
        const chip = cell.querySelector('.counter-chip').getBoundingClientRect();
        return chip.left >= c.left - 1 && chip.right <= c.right + 1 && chip.top >= c.top - 1;
    }));
    const donFit = await page.evaluate(() => {
        const cell = document.querySelectorAll('#p1Chars .char-cell')[0];
        const c = cell.getBoundingClientRect();
        const row = cell.querySelector('.char-don-row');
        return {
            scroll: row.scrollWidth, client: row.clientWidth,
            inside: Array.from(row.children).every(p => {
                const r = p.getBoundingClientRect();
                return r.left >= c.left - 1 && r.right <= c.right + 1;
            }),
            tally: row.querySelector('.char-don-more')?.textContent || '',
            pips: row.querySelectorAll('.char-don').length
        };
    });
    check('a big DON!! stack stays inside the cell', donFit.scroll <= donFit.client + 1 && donFit.inside && donFit.tally === '+4', JSON.stringify(donFit));
    // Five is the largest count that fits as pure pips; six must fall back.
    await emit('onepiece-don-attach', { player: 1, index: 0, donAttached: 5 });
    check('five attached DON!! still render as five pips', await seen(() => {
        const row = document.querySelectorAll('#p1Chars .char-cell')[0].querySelector('.char-don-row');
        return row.querySelectorAll('.char-don').length === 5 && !row.querySelector('.char-don-more') &&
            row.scrollWidth <= row.clientWidth + 1;
    }));
    check('a counter-less card shows no counter chip, but is still filled', await page.evaluate(() => {
        const cell = document.querySelectorAll('#p1Chars .char-cell')[1];
        return !cell.classList.contains('empty') &&
            getComputedStyle(cell.querySelector('.counter-chip')).display === 'none' &&
            getComputedStyle(cell.querySelector('.char-power')).display !== 'none';
    }));

    const longName = 'Bartholomew Kuma Van Augur Longshanks';
    await emit('onepiece-match-update', {
        player1: board(longName, { characters: [mkChar(0, { name: 'Monkey D. Luffy, Fifth Gear Nika Form' }), null, null, null, null] }),
        currentTurn: 1
    });
    await wait((n) => document.getElementById('p1Name').textContent === n, longName);
    check('a long player name ellipses instead of pushing the record out', await page.evaluate(() => {
        const nameEl = document.getElementById('p1Name');
        const rec = document.getElementById('p1Record').getBoundingClientRect();
        const panel = nameEl.closest('.panel').getBoundingClientRect();
        return nameEl.scrollWidth > nameEl.clientWidth &&
            getComputedStyle(nameEl).textOverflow === 'ellipsis' &&
            rec.right <= panel.right - 10 && rec.left >= panel.left;
    }));
    check('a long name does not overflow the turn pill', await page.evaluate(() => {
        const pill = document.getElementById('turnIndicator').getBoundingClientRect();
        const bar = document.getElementById('matchInfo').getBoundingClientRect();
        return pill.right <= bar.right + 1 && pill.left >= bar.left - 1;
    }));
    check('a long Leader name ellipses inside its panel', await page.evaluate(() => {
        const el = document.querySelector('#p1Leader .leader-name');
        const panel = el.closest('.panel').getBoundingClientRect();
        return el.getBoundingClientRect().right <= panel.right + 1;
    }));
    check('no panel overflows its board', await page.evaluate(() => [1, 2].every(n => {
        const b = document.getElementById(`player${n}Board`);
        const r = b.getBoundingClientRect();
        return Array.from(b.querySelectorAll('.panel')).every(p => {
            const pr = p.getBoundingClientRect();
            return pr.top >= r.top - 1 && pr.bottom <= r.bottom + 1 && pr.left >= r.left - 1 && pr.right <= r.right + 1;
        });
    })));

    // ---- Legacy / partial state must not throw ----
    await emit('onepiece-match-update', { player1: { name: 'Legacy Save' }, currentTurn: 1 });
    check('a payload with only a name still renders the board', await seen(() =>
        document.getElementById('p1Name').textContent === 'Legacy Save' &&
        document.querySelectorAll('#p1Chars .char-cell').length === 5));
    // A corrupt/partial save can carry the keys with nothing in them.
    await emit('onepiece-match-update', { player1: { name: 'Old Save', leader: null, life: null, don: null, characters: null, stage: null }, currentTurn: 1 });
    check('a payload with null life/don/characters renders empty, not broken', await seen(() =>
        document.querySelectorAll('#p1Chars .char-cell.empty').length === 5 &&
        document.getElementById('p1LifeCount').textContent.replace(/\s+/g, ' ').trim() === '4 / 4 Life' &&
        document.getElementById('p1DonActive').textContent === '0' &&
        document.querySelectorAll('#p1DonTrack .don-pip').length === 10));
    // The full-state path a reconnecting overlay takes: a state object written
    // before Life / DON!! / Characters existed at all.
    await page.evaluate(() => {
        applyFullState({ player1: { name: 'Ancient' }, player2: { name: 'Ancient Two' }, currentTurn: 1 });
        updateDisplay();
    });
    check('a legacy full state with none of the newer fields still renders', await page.evaluate(() =>
        document.getElementById('p1Name').textContent === 'Ancient' &&
        document.querySelectorAll('#p1Chars .char-cell.empty').length === 5 &&
        document.querySelector('#p1Leader .leader-none') !== null &&
        document.querySelector('#p1Stage .stage-none') !== null &&
        document.getElementById('p1Record').textContent === '0-0-0'));
    await emit('onepiece-character-power', { player: 1, index: 0, power: 9000 });
    await emit('onepiece-don-attach', { player: 9, index: 0, donAttached: 3 });
    await emit('onepiece-leader-update', { player: 9, leader: null });
    check('events for absent players/slots are ignored quietly', pageErrors.length === 0, pageErrors.join(' | '));

    // ---- Reset leaves no stale tracker behind ----
    await emit('onepiece-match-update', { player1: board('Alpha', { life: { total: 5, taken: [0, 1] } }), currentTurn: 1 });
    await wait(() => document.getElementById('p1LifeCount').textContent.trim().startsWith('3'));
    await page.waitForTimeout(1400);
    await emit('onepiece-match-reset', {});
    check('reset clears the character row', await seen(() =>
        document.querySelectorAll('#p1Chars .char-cell.empty').length === 5 &&
        document.querySelector('#p1Leader .leader-none') !== null));
    await emit('onepiece-match-update', { player1: board('Alpha', { life: { total: 5, taken: [0, 1, 2, 3] } }), currentTurn: 1 });
    await wait(() => document.getElementById('p1LifeCount').textContent.trim().startsWith('1'));
    check('no phantom ticker on the first update after a reset', await page.evaluate(() =>
        document.querySelectorAll('#player1Board .life-pop').length === 0));

    // ---- The clock survives the 5-second state re-push ----
    // Every register-overlay ping is answered with the server's whole stored
    // board, whose `timer` field nothing ever writes to. Taking it on each push
    // snapped a running match clock back to its stored value every 5 seconds -
    // which also meant the final-minute styling could never be reached.
    check('a fresh overlay adopts the stored clock on first sync', /^\d\d:\d\d$/.test((storedTimer || '').trim()), storedTimer);
    await emit('timer-set', { minutes: 3, seconds: 7 });
    await wait(() => document.getElementById('matchTimer').textContent === '03:07');
    // Replays the re-push directly rather than waiting out a 5s ping: timer-set
    // is an io.emit broadcast, so a real wait is at the mercy of any other
    // client on the same dev server.
    const heldTimer = await page.evaluate(() => {
        applyFullState({ timer: { minutes: 50, seconds: 0 } });
        updateMatchInfo();
        return document.getElementById('matchTimer').textContent;
    });
    check('a state re-push cannot overwrite the set clock', heldTimer === '03:07', heldTimer);

    check('no page errors across the polish pass', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
