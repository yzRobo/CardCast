// Phase 2 verification: Disney Lorcana match overlay + control, end to end.
// Spawns the server, opens BOTH the control page and the overlay page, exercises
// every control, and asserts the overlay re-renders via the socket round-trip.
// Covers the KEY difference: LORE counts UP to 20 (race), not a depleting life;
// plus ink, characters (S/W/L + damage + exert + banish) and locations.
//
//   node scripts/verify-lorcana-match.mjs
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

// Discover a real Character (with willpower), a Location and an Item from the DB.
async function discover() {
    const found = {};
    const queries = ['Elsa', 'Mickey', 'Forbidden Mountain', 'Maleficent', 'Dinglehopper', 'Magic', 'Sword', 'Lantern', 'Pawpsicle', 'Mirror', 'Beast'];
    for (const q of queries) {
        const arr = await (await fetch(`${BASE}/api/search/lorcana?q=${encodeURIComponent(q)}`)).json();
        for (const c of arr) {
            const t = (c.card_type || '').toLowerCase();
            if (!found.character && t.includes('character') && c.willpower != null && c.willpower > 0) found.character = c;
            if (!found.location && t.includes('location')) found.location = c;
            if (!found.item && t.includes('item')) found.item = c;
        }
        if (found.character && found.location && found.item) break;
    }
    return found;
}

const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };
// Reuse a dev server if one is already listening; never kill one we did not start.
const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Character/Location/Item from DB', cards.character && cards.location && cards.item,
        JSON.stringify({ character: cards.character && cards.character.name, wp: cards.character && cards.character.willpower,
            location: cards.location && cards.location.name, item: cards.item && cards.item.name }));

    browser = await chromium.launch();

    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/lorcana-match`, { waitUntil: 'networkidle' });
    const control = await browser.newPage();
    control.on('dialog', d => d.accept());
    await control.goto(`${BASE}/lorcana-match-control`, { waitUntil: 'networkidle' });

    // Control renders two boards with 6 character slots + 3 location slots each.
    const layout = await control.evaluate(() => ({
        boards: document.querySelectorAll('#playersGrid > .card').length,
        p1chars: document.querySelectorAll('#p1Chars > div').length,
        p2chars: document.querySelectorAll('#p2Chars > div').length,
        p1locs: document.querySelectorAll('#p1Locs > div').length,
        p1lore: !!document.getElementById('p1Lore'),
        p1ink: !!document.getElementById('p1InkAvail')
    }));
    check('control renders 2 player boards', layout.boards === 2, JSON.stringify(layout));
    check('control renders 6 character slots per player', layout.p1chars === 6 && layout.p2chars === 6, JSON.stringify(layout));
    check('control renders 3 location slots', layout.p1locs === 3, JSON.stringify(layout));
    check('control has Lore + Ink controls', layout.p1lore && layout.p1ink, JSON.stringify(layout));

    // Overlay headline is the LORE race to 20 (20 segments), not a life total.
    const loreSegs = await overlay.evaluate(() => document.querySelectorAll('#p1LoreBar .lore-seg').length);
    check('overlay LORE bar has 20 segments (race to 20)', loreSegs === 20, `got ${loreSegs}`);

    // Overlay reports connected on the control status badge.
    await control.waitForFunction(() => document.getElementById('overlayStatus').textContent.includes('Connected'), { timeout: 8000 });
    check('control shows Overlay Connected', true);

    const waitOverlay = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // 1) Name + record + games won
    await control.evaluate(() => { setName(1, 'Mei'); document.getElementById('p1W').value = 2; document.getElementById('p1L').value = 1; setRecord(1); adjGamesWon(1, 1); });
    check('overlay reflects P1 name', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Mei'));
    check('overlay reflects P1 record', await waitOverlay(() => document.getElementById('p1Record').textContent === '2-1-0'));
    check('overlay reflects P1 games won', await waitOverlay(() => document.getElementById('p1GamesWon').textContent.includes('1')));

    // 2) LORE counts UP - quick +3 fills 3 segments + number, P1 takes the lead badge
    await control.evaluate(() => adjLore(1, 3));
    check('overlay LORE number counts UP to 3', await waitOverlay(() => document.getElementById('p1Lore').textContent === '3'));
    check('overlay LORE bar fills 3 segments', await waitOverlay(() => document.querySelectorAll('#p1LoreBar .lore-seg.filled').length === 3));
    check('overlay marks P1 as leading', await waitOverlay(() => document.getElementById('p1LorePanel').classList.contains('leading')));

    // 3) LORE clamps at the 20 goal (never exceeds; it is a count-up to win)
    await control.evaluate(() => setLore(1, 99));
    check('overlay LORE clamps to 20', await waitOverlay(() => document.getElementById('p1Lore').textContent === '20'));
    await control.evaluate(() => setLore(1, 3));

    // 4) Ink: total 5 + available 3 -> overlay shows 3 / 5 with 3 ready pips
    await control.evaluate(() => { adjInk(1, 'total', 5); adjInk(1, 'available', 3); });
    check('overlay ink available shows 3', await waitOverlay(() => document.getElementById('p1InkAvail').textContent === '3'));
    check('overlay ink total shows /5', await waitOverlay(() => document.getElementById('p1InkTotal').textContent === '/5'));
    check('overlay ink track has 5 pips, 3 ready', await waitOverlay(() =>
        document.querySelectorAll('#p1InkTrack .ink-pip').length === 5 &&
        document.querySelectorAll('#p1InkTrack .ink-pip.ready').length === 3));

    // 5) Add a Character -> art + S/W/L stat chips (willpower prefilled from DB)
    const wp = parseInt(cards.character.willpower) || 0;
    await control.evaluate(async (id) => { openSearch(1, 'character', 0); await pickCard(id); }, cards.character.id);
    check('overlay shows character with S/W/L stats', await waitOverlay((w) => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        if (!cell) return false;
        const wil = cell.querySelector('.stat.wil');
        return cell.querySelector('.stat.str') && wil && wil.textContent.includes(String(w)) && cell.querySelector('.stat.lore');
    }, wp));

    // 6) Damage toward Willpower -> bar depletes, character banished at damage >= willpower
    await control.evaluate((w) => adjCharDamage(1, 0, w), wp);
    check('overlay character banished when damage reaches willpower', await waitOverlay(() => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        return cell && cell.classList.contains('banished');
    }));
    // back off one point -> no longer banished, damage text shows
    await control.evaluate(() => adjCharDamage(1, 0, -1));
    check('overlay un-banishes when damage < willpower', await waitOverlay((w) => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        if (!cell) return false;
        const t = cell.querySelector('.dmg-text');
        return !cell.classList.contains('banished') && t && t.textContent === `${w - 1}/${w}`;
    }, wp));

    // 7) Exert toggle -> overlay tilts the card (exerted class)
    await control.evaluate(() => toggleExert(1, 0));
    check('overlay character exerted (tilted)', await waitOverlay(() => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        return cell && cell.classList.contains('exerted');
    }));

    // 8) Add a Location -> overlay shows it with stats
    await control.evaluate(async (id) => { openSearch(1, 'location', 0); await pickCard(id); }, cards.location.id);
    check('overlay shows a Location with name', await waitOverlay(() => {
        const cell = document.querySelector('#p1Locs .loc-cell:not(.empty)');
        return cell && cell.querySelector('.loc-name') && cell.querySelector('.loc-name').textContent.length > 0;
    }));

    // 9) Add an Item -> overlay items panel appears with a chip
    await control.evaluate(async (id) => { openSearch(1, 'item', 0); await pickCard(id); }, cards.item.id);
    check('overlay items panel shows item chip', await waitOverlay(() => {
        const panel = document.getElementById('p1ItemsPanel');
        return panel && panel.style.display !== 'none' && document.querySelectorAll('#p1Items .item-chip').length >= 1;
    }));

    // 10) Switch turn
    await control.evaluate(() => switchTurn());
    check('overlay turn indicator -> P2', await waitOverlay(() => document.getElementById('turnIndicator').textContent.includes('Player 2')));

    // 11) Timer set
    await control.evaluate(() => { document.getElementById('timerMinutes').value = 12; document.getElementById('timerSeconds').value = 34; setTimer(); });
    check('overlay timer shows 12:34', await waitOverlay(() => document.getElementById('matchTimer').textContent === '12:34'));

    // 12) Hide then show overlay
    await control.evaluate(() => hideOverlay());
    check('overlay hides', await waitOverlay(() => !document.getElementById('player1Board').classList.contains('active')));
    await control.evaluate(() => showOverlay());
    check('overlay shows', await waitOverlay(() => document.getElementById('player1Board').classList.contains('active')));

    // 13) Reset clears the board (name preserved)
    await control.evaluate(() => resetMatch());
    check('overlay clears characters on reset', await waitOverlay(() => document.querySelectorAll('#p1Chars .char-cell.empty').length === 6));
    check('overlay resets LORE to 0 on reset', await waitOverlay(() => document.getElementById('p1Lore').textContent === '0'));
    check('overlay preserves name across reset', await waitOverlay(() => document.getElementById('p1Name').textContent === 'Mei'));

    // 14) Fresh overlay restores current state via request-state (reconnect)
    await control.evaluate(async (id) => { openSearch(2, 'character', 1); await pickCard(id); }, cards.character.id);
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/lorcana-match`, { waitUntil: 'networkidle' });
    check('reconnecting overlay restores existing character', await overlay2.waitForFunction(
        () => document.querySelectorAll('#p2Chars .char-cell:not(.empty)').length >= 1, { timeout: 6000 }
    ).then(() => true).catch(() => false));
    // ================================================================
    // Polish pass. Driven from a raw socket on the overlay page itself so the
    // control page's saved state cannot leak into these assertions, and so the
    // exact payloads can be shaped. Geometry is asserted, not DOM presence:
    // every trap below shipped once as an element that existed and rendered
    // nothing.
    // ================================================================
    console.log('\n--- polish pass ---');
    // Close the control page first. It re-pushes its whole local state every time
    // any overlay registers (which happens every 5s), so leaving it open would
    // race every assertion below.
    await control.close();
    await overlay.close();
    await overlay2.close();

    const poll = await browser.newPage();
    await poll.setViewportSize({ width: 1920, height: 1080 });
    const pageErrors = [];
    poll.on('pageerror', e => pageErrors.push(e.message));
    await poll.goto(`${BASE}/lorcana-match`, { waitUntil: 'domcontentloaded' });
    await poll.evaluate(() => { window.__drv = io(); });
    await poll.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = async (e, d) => { await poll.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]); await poll.waitForTimeout(140); };
    const ev = (fn, arg) => poll.evaluate(fn, arg);

    await emit('lorcana-match-reset', {});
    await emit('toggle-lorcana-match', { show: true });
    await poll.waitForTimeout(700);

    const CHAR = (over = {}) => ({
        id: 'tc1', name: 'Elsa - Snow Queen', image: '/images/card-back.png',
        strength: 4, willpower: 6, lore: 2, colors: 'Amethyst', damage: 0, exerted: false, ...over
    });
    // A board saved before this pass: no characters/locations/items/ink arrays.
    const LEGACY = { name: 'Legacy Board', record: { wins: 1, losses: 0, ties: 0 }, lore: 4 };

    console.log('\nActive-player emphasis');
    await emit('turn-switch', { currentTurn: 1 });
    check('active board flagged active-turn', await ev(() => document.getElementById('player1Board').classList.contains('active-turn')));
    check('idle board flagged idle-turn', await ev(() => document.getElementById('player2Board').classList.contains('idle-turn')));
    // The rail is the categorical half of the signal - assert it paints pixels.
    check('turn rail lit on the active side', await ev(() => {
        const s = getComputedStyle(document.getElementById('player1Board'), '::after');
        return parseFloat(s.opacity) === 1 && parseFloat(s.width) >= 3 && parseFloat(s.height) > 200;
    }));
    check('turn rail absent on the idle side', await ev(() =>
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 0));
    check('rail sits on the inner edge, facing screen centre', await ev(() => {
        const l = getComputedStyle(document.getElementById('player1Board'), '::after');
        const r = getComputedStyle(document.getElementById('player2Board'), '::after');
        // left board rails on its right; right board rails on its left
        return l.right === '-11px' && r.left === '-11px';
    }));
    // The board box is a fixed 1010px; the rail must follow the panels instead.
    check('rail is sized to the panel column, not the fixed board box', await ev(() => {
        const board = document.getElementById('player1Board');
        const panels = Array.from(board.children).filter(el => el.classList.contains('panel') && el.style.display !== 'none');
        const last = panels[panels.length - 1];
        const content = last.offsetTop + last.offsetHeight;
        const railH = parseFloat(getComputedStyle(board, '::after').height);
        return Math.abs(railH - (content - 12)) <= 2 && content < board.clientHeight - 20;
    }));
    check('idle board is visibly recessed but still visible', await ev(() => {
        const b = document.getElementById('player2Board');
        const o = parseFloat(getComputedStyle(b).opacity);
        return b.classList.contains('active') && o > 0.5 && o < 1 && getComputedStyle(b).filter.includes('saturate');
    }));
    check('idle board keeps its own accent hue (identity, not state)', await ev(() => {
        const p1 = getComputedStyle(document.querySelector('#player1Board .panel')).borderTopColor;
        const p2 = getComputedStyle(document.querySelector('#player2Board .panel')).borderTopColor;
        return p1 !== p2 && p2 === 'rgb(217, 119, 6)';
    }));
    await emit('turn-switch', { currentTurn: 2 });
    await poll.waitForTimeout(600);   // the rail cross-fades over 0.45s
    check('emphasis follows the turn across', await ev(() =>
        document.getElementById('player2Board').classList.contains('active-turn') &&
        document.getElementById('player1Board').classList.contains('idle-turn') &&
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 1 &&
        parseFloat(getComputedStyle(document.getElementById('player1Board'), '::after').opacity) === 0));
    await emit('turn-switch', { currentTurn: 1 });
    await poll.waitForTimeout(600);
    // The idle dim must not survive into the hidden state: `.active` means
    // VISIBLE on this board, so an idle-turn opacity rule at equal specificity
    // would leave a hidden board sitting at 0.8 instead of 0.
    await emit('toggle-lorcana-match', { show: false });
    await poll.waitForTimeout(1000);
    const hiddenState = await ev(() => {
        const b = document.getElementById('player2Board');
        return {
            opacity: getComputedStyle(b).opacity,
            idle: b.classList.contains('idle-turn'),
            active: b.classList.contains('active')
        };
    });
    check('the idle dim never leaks into the hidden state',
        parseFloat(hiddenState.opacity) === 0 && hiddenState.idle, JSON.stringify(hiddenState));
    await emit('toggle-lorcana-match', { show: true });
    await poll.waitForTimeout(900);

    console.log('\nRender caching');
    await emit('lorcana-character-update', { player: 1, index: 0, character: CHAR() });
    await ev(() => { document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art').dataset.stamp = 'original'; });
    await emit('lorcana-character-damage', { player: 1, index: 0, damage: 2 });
    check('damage tick does not reload the card image', await ev(() =>
        document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art')?.dataset.stamp === 'original'));
    check('damage text updated in place', await ev(() =>
        document.querySelector('#p1Chars .char-cell:not(.empty) .dmg-text').textContent === '2/6'));
    check('damage bar width tracks remaining willpower', await ev(() => {
        const w = parseFloat(document.querySelector('#p1Chars .char-cell:not(.empty) .dmg-bar').style.width);
        return Math.abs(w - 67) <= 1;
    }));
    await emit('lorcana-character-exert', { player: 1, index: 0, exerted: true });
    check('exert does not reload the card image either', await ev(() =>
        document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art')?.dataset.stamp === 'original'));
    check('exerted cell tilts', await ev(() => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        return cell.classList.contains('exerted') && getComputedStyle(cell).transform.startsWith('matrix');
    }));
    // A neighbouring slot must not be rebuilt when this one changes.
    await emit('lorcana-character-update', { player: 1, index: 1, character: CHAR({ id: 'tc2', name: 'Stitch', willpower: 3 }) });
    await ev(() => { document.querySelectorAll('#p1Chars .char-cell:not(.empty) img.char-art')[1].dataset.stamp = 'second'; });
    await emit('lorcana-character-damage', { player: 1, index: 0, damage: 3 });
    check('changing one slot leaves its neighbour untouched', await ev(() => {
        const imgs = document.querySelectorAll('#p1Chars .char-cell:not(.empty) img.char-art');
        return imgs[0].dataset.stamp === 'original' && imgs[1].dataset.stamp === 'second';
    }));
    await emit('lorcana-lore-update', { player: 1, lore: 5, loreGoal: 20 });
    await ev(() => { document.querySelector('#p1LoreBar .lore-seg').dataset.stamp = 'seg0'; });
    await emit('lorcana-lore-update', { player: 1, lore: 7, loreGoal: 20 });
    check('lore tick refills segments without rebuilding the bar', await ev(() =>
        document.querySelector('#p1LoreBar .lore-seg')?.dataset.stamp === 'seg0' &&
        document.querySelectorAll('#p1LoreBar .lore-seg.filled').length === 7));
    await emit('lorcana-ink-update', { player: 1, ink: { total: 6, available: 6 } });
    await ev(() => { document.querySelector('#p1InkTrack .ink-pip').dataset.stamp = 'pip0'; });
    await emit('lorcana-ink-update', { player: 1, ink: { total: 6, available: 2 } });
    check('spending ink recolours pips without rebuilding the track', await ev(() =>
        document.querySelector('#p1InkTrack .ink-pip')?.dataset.stamp === 'pip0' &&
        document.querySelectorAll('#p1InkTrack .ink-pip.ready').length === 2));

    // The trap: an identical copy of the same card dropped into the same slot is
    // invisible to a content-only signature, leaving the damage baseline stale.
    console.log('\nIdentical-copy replacement');
    await emit('lorcana-character-update', { player: 1, index: 0, character: CHAR({ damage: 0 }) });
    check('replacing a card with an identical copy rebuilds the slot', await ev(() =>
        document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art')?.dataset.stamp === undefined));
    check('a fresh placement does not flash as if it were damaged', await ev(() =>
        !document.querySelector('#p1Chars .char-cell:not(.empty)').classList.contains('flash')));
    check('replacing clears the old exerted/damage state', await ev(() => {
        const cell = document.querySelector('#p1Chars .char-cell:not(.empty)');
        return !cell.classList.contains('exerted') && cell.querySelector('.dmg-text').textContent === '';
    }));
    await emit('lorcana-character-damage', { player: 1, index: 0, damage: 1 });
    check('an in-place damage increase does flash', await ev(() =>
        document.querySelector('#p1Chars .char-cell:not(.empty)').classList.contains('flash')));

    console.log('\nIdle-slot motion');
    check('empty character slots drift an ink drop', await ev(() => {
        const s = getComputedStyle(document.querySelector('#p1Chars .char-cell.empty'), '::before');
        return s.animationName === 'slot-drift' && s.backgroundImage.includes('svg');
    }));
    check('empty location slots drift too', await ev(() => {
        const s = getComputedStyle(document.querySelector('#p1Locs .loc-cell.empty'), '::before');
        return s.animationName === 'slot-drift' && s.backgroundImage.includes('svg');
    }));
    check('the drift is staggered, not marching in step', await ev(() => {
        const delays = Array.from(document.querySelectorAll('#p1Chars .char-cell'))
            .map(e => e.style.getPropertyValue('--drift-delay'));
        return new Set(delays).size === delays.length && delays.every(d => d.startsWith('-'));
    }));
    check('the drift stays quiet (peak opacity well under a third)', await ev(() => {
        // styleSheets[0] is the cross-origin Google Fonts link - unreadable.
        const sheet = Array.from(document.styleSheets).find(s => !s.href);
        const rule = Array.from(sheet.cssRules)
            .find(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'slot-drift');
        const peaks = Array.from(rule.cssRules).map(k => parseFloat(k.style.opacity)).filter(v => !isNaN(v));
        return Math.max(...peaks) <= 0.2;
    }));
    check('filled slots carry no drift motif', await ev(() =>
        getComputedStyle(document.querySelector('#p1Chars .char-cell:not(.empty)'), '::before').backgroundImage === 'none'));

    console.log('\nLore ticker');
    // Re-baseline first: a full-state replay may have landed since the last
    // lore emit, and the ticker is a delta against whatever was last shown.
    await emit('lorcana-lore-update', { player: 1, lore: 7, loreGoal: 20 });
    await poll.waitForTimeout(1300);
    await emit('lorcana-lore-update', { player: 1, lore: 9, loreGoal: 20 });
    const gainPop = await ev(() => {
        const pop = document.querySelector('#p1LorePanel .lore-pop');
        return pop ? { text: pop.textContent, down: pop.classList.contains('down') } : null;
    });
    check('gaining lore pops a +N ticker', gainPop && gainPop.text === '+2' && !gainPop.down, JSON.stringify(gainPop));
    // Presence is not enough: the Pokemon ticker shipped rendering zero pixels
    // because an overflow:hidden ancestor clipped it away entirely.
    check('lore ticker actually paints pixels, unclipped', await ev(() => {
        const pop = document.querySelector('#p1LorePanel .lore-pop');
        if (!pop) return false;
        const r = pop.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
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
    check('lore ticker stays inside its panel and clear of the numeral', await ev(() => {
        const pop = document.querySelector('#p1LorePanel .lore-pop').getBoundingClientRect();
        const panel = document.getElementById('p1LorePanel').getBoundingClientRect();
        const num = document.getElementById('p1Lore').getBoundingClientRect();
        return pop.left >= panel.left && pop.right <= num.left + 1 && pop.top >= panel.top;
    }));
    await poll.waitForTimeout(1400);
    check('the ticker cleans itself up', await ev(() => !document.querySelector('#p1LorePanel .lore-pop')));
    await emit('lorcana-lore-update', { player: 1, lore: 6, loreGoal: 20 });
    check('losing lore pops a -N ticker, styled differently', await ev(() => {
        const pop = document.querySelector('#p1LorePanel .lore-pop');
        return !!pop && pop.textContent === '-3' && pop.classList.contains('down');
    }));
    await poll.waitForTimeout(1400);

    console.log('\nState legibility');
    await emit('lorcana-lore-update', { player: 1, lore: 18, loreGoal: 20 });
    check('match point pulses the lore numeral', await ev(() => {
        const el = document.getElementById('p1Lore');
        return el.classList.contains('match-point') && getComputedStyle(el).animationName === 'soft-pulse';
    }));
    await emit('lorcana-lore-update', { player: 1, lore: 20, loreGoal: 20 });
    check('reaching the goal stops pulsing and marks the win', await ev(() => {
        const el = document.getElementById('p1Lore');
        return el.classList.contains('at-goal') && !el.classList.contains('match-point') &&
            getComputedStyle(el).animationName === 'none';
    }));
    await emit('lorcana-lore-update', { player: 1, lore: 6, loreGoal: 20 });
    await emit('lorcana-character-damage', { player: 1, index: 0, damage: 5 });
    check('a character near banishment pulses its willpower bar', await ev(() => {
        const bar = document.querySelector('#p1Chars .char-cell:not(.empty) .dmg-bar');
        return bar.classList.contains('crit') && getComputedStyle(bar).animationName === 'soft-pulse';
    }));
    await emit('timer-set', { minutes: 0, seconds: 40 });
    check('final minute of the clock turns accent red', await ev(() => {
        const t = document.getElementById('matchTimer');
        return t.classList.contains('expiring') && getComputedStyle(t).color === 'rgb(248, 113, 113)';
    }));
    await emit('timer-set', { minutes: 25, seconds: 0 });
    check('normal time is not flagged', await ev(() => !document.getElementById('matchTimer').classList.contains('expiring')));
    check('a card entering a slot eases in', await ev(() =>
        getComputedStyle(document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art')).animationName === 'card-enter'));
    await emit('lorcana-character-exert', { player: 1, index: 0, exerted: true });
    check('EXERTED label has a backing so it reads over card art', await ev(() => {
        const cell = document.querySelector('#p1Chars .char-cell.exerted');
        if (!cell) return false;
        const s = getComputedStyle(cell, '::after');
        return s.content.includes('EXERTED') && s.backgroundImage.includes('gradient');
    }));
    await emit('lorcana-character-exert', { player: 1, index: 0, exerted: false });

    console.log('\nOverflow safety');
    const LONG = 'Bartholomew Fitzwilliam-Cavendish III';
    await emit('lorcana-match-update', { player1: { name: LONG }, player2: { name: LONG } });
    check('a long player name ellipsises instead of spilling', await ev(() => {
        const el = document.getElementById('p1Name');
        const row = el.parentElement.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return getComputedStyle(el).textOverflow === 'ellipsis' && r.right <= row.right + 1 && el.scrollWidth > el.clientWidth;
    }));
    check('a long name never squeezes the record chip', await ev(() => {
        const rec = document.getElementById('p1Record');
        return rec.scrollWidth <= rec.clientWidth && rec.getBoundingClientRect().width > 40;
    }));
    // The old fixed 240px cap ellipsised names with panel width still free.
    check('the name claims the width the record chip does not need', await ev(() => {
        const name = document.getElementById('p1Name').getBoundingClientRect();
        const rec = document.getElementById('p1Record').getBoundingClientRect();
        const row = document.getElementById('p1Name').parentElement.getBoundingClientRect();
        return name.width > row.width - rec.width - 14;
    }));
    check('the turn indicator ellipsises rather than stretching the bar', await ev(() => {
        const el = document.getElementById('turnIndicator');
        return getComputedStyle(el).textOverflow === 'ellipsis' &&
            document.getElementById('matchInfo').getBoundingClientRect().width <= 900;
    }));
    // A clipped "12/12" reads as 12/1 - worse than a visible truncation.
    await emit('lorcana-character-update', { player: 1, index: 2, character: CHAR({ id: 'big', name: 'Big', strength: 10, willpower: 12, lore: 4 }) });
    await emit('lorcana-character-damage', { player: 1, index: 2, damage: 11 });
    check('two-digit damage text is not clipped', await ev(() => {
        const t = document.querySelectorAll('#p1Chars .char-cell:not(.empty) .dmg-text')[2];
        return t.textContent === '11/12' && t.scrollWidth <= t.clientWidth;
    }));
    check('stat chips fit the cell at two digits', await ev(() => {
        const cell = document.querySelectorAll('#p1Chars .char-cell:not(.empty)')[2];
        const row = cell.querySelector('.char-stats');
        return row.scrollWidth <= row.clientWidth &&
            Array.from(row.children).every(s => s.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 1);
    }));
    // Ink is the one row that can wrap and push the board past its 1010px box.
    await emit('lorcana-ink-update', { player: 1, ink: { total: 20, available: 13 } });
    check('a 20-ink track stays on one row', await ev(() => {
        const t = document.getElementById('p1InkTrack');
        return t.classList.contains('dense') && t.querySelectorAll('.ink-pip').length === 20 &&
            t.clientHeight <= t.querySelector('.ink-pip').getBoundingClientRect().height + 2;
    }));
    // Items. A cap that fits more chips than the row can render legibly is not a
    // cap, it is four identical stubs - so the fixture here is real Lorcana item
    // names and the assertions are about how much of each name survives.
    const REAL_ITEMS = ['Sword in the Stone', 'Musketeer Tabard', 'Shield of Virtue', 'Fishbone Quill',
        'Dinglehopper', 'Poisoned Apple', 'Magic Golden Flower', 'Pawpsicle', 'Lantern', 'Eye of the Fates', 'Coconut Basket'];
    await emit('lorcana-item-update', { player: 1, items: REAL_ITEMS.map((name, i) => ({ id: `i${i}`, name })) });
    check('an overlong item list is capped with a +N chip', await ev(() => {
        const chips = document.querySelectorAll('#p1Items .item-chip');
        const more = document.querySelector('#p1Items .item-chip.more');
        return chips.length === 4 && more && more.textContent === '+8';
    }));
    // How many characters actually fit, measured in the font the page is really
    // using (Inter or its fallback) rather than assumed from a pixel width. With
    // four chips on this row these same names came out at 9-13 characters and
    // every one of them ellipsised; names sharing a prefix (which item cycles in
    // this game do) became literally indistinguishable, which is less information
    // than not showing the chip at all.
    const chipFit = await ev(() => {
        const chips = Array.from(document.querySelectorAll('#p1Items .item-chip:not(.more)'));
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;padding:0;border:0;visibility:hidden';
        document.body.appendChild(probe);
        const out = chips.map(c => {
            const cs = getComputedStyle(c);
            ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform']
                .forEach(k => { probe.style[k] = cs[k]; });
            // Sub-pixel on purpose. clientWidth/scrollWidth are rounded to whole
            // pixels, so a chip overflowing by a fraction reports scroll ===
            // client while Chrome paints an ellipsis and drops a character or
            // two - integer geometry says "fits" about text that visibly does
            // not. Measure the box off getBoundingClientRect instead.
            const avail = c.getBoundingClientRect().width
                - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
                - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
            const name = c.textContent;   // the full name; CSS clips it, the DOM keeps it
            let n = 0;
            for (let k = 1; k <= name.length; k++) {
                probe.textContent = name.slice(0, k);
                if (probe.getBoundingClientRect().width <= avail) n = k; else break;
            }
            return { chars: n, len: name.length, shown: name.slice(0, n) };
        });
        probe.remove();
        return out;
    });
    check('every capped item chip renders at least 13 characters of its name',
        chipFit.length === 3 && chipFit.every(f => f.chars >= 13), JSON.stringify(chipFit));
    check('the capped chips stay distinguishable from one another',
        new Set(chipFit.map(f => f.shown)).size === chipFit.length, JSON.stringify(chipFit.map(f => f.shown)));
    check('a typical-length item name is not truncated at all',
        chipFit.filter(f => f.len <= 16).length >= 2 && chipFit.filter(f => f.len <= 16).every(f => f.chars === f.len),
        JSON.stringify(chipFit));

    // Now the pathological load: names far past any chip width. These must still
    // be contained - the cap protects legibility, the CSS protects the layout.
    await emit('lorcana-item-update', { player: 1, items: Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, name: `Extremely Long Item Name ${i}` })) });
    check('a pathological item list is still capped with a +N chip', await ev(() => {
        const chips = document.querySelectorAll('#p1Items .item-chip');
        const more = document.querySelector('#p1Items .item-chip.more');
        return chips.length === 4 && more && more.textContent === '+8';
    }));
    check('item chips ellipsise instead of stretching the panel', await ev(() =>
        Array.from(document.querySelectorAll('#p1Items .item-chip')).every(c =>
            c.getBoundingClientRect().right <= document.getElementById('p1Items').getBoundingClientRect().right + 1)));
    // A wrapping list grows the last panel downward off the fixed-height board.
    check('the item row never wraps to a second line', await ev(() => {
        const row = document.getElementById('p1Items');
        const chips = Array.from(row.children);
        const top = chips[0].getBoundingClientRect().top;
        return chips.every(c => Math.abs(c.getBoundingClientRect().top - top) < 2) &&
            row.getBoundingClientRect().height <= chips[0].getBoundingClientRect().height + 2;
    }));
    check('the +N count chip never shrinks away', await ev(() => {
        const more = document.querySelector('#p1Items .item-chip.more');
        return more.scrollWidth <= more.clientWidth && more.getBoundingClientRect().width > 20;
    }));

    console.log('\nLayout integrity under the worst case');
    // Every slot full, max ink, capped items, longest names - nothing may spill.
    for (let i = 0; i < 6; i++) await emit('lorcana-character-update', { player: 1, index: i, character: CHAR({ id: `f${i}`, willpower: 12, strength: 10, lore: 4 }) });
    for (let i = 0; i < 3; i++) await emit('lorcana-location-update', { player: 1, index: i, location: { id: `l${i}`, name: 'The Forbidden Mountain - Maleficent’s Castle', image: '/images/card-back.png', willpower: 10, lore: 3 } });
    const columnFit = await ev(() => {
        const board = document.getElementById('player1Board');
        const panels = Array.from(board.children).filter(el => el.classList.contains('panel') && el.style.display !== 'none');
        const last = panels[panels.length - 1];
        return {
            content: last.offsetTop + last.offsetHeight,
            box: board.clientHeight,
            heights: panels.map(p => `${p.className.replace(/panel ?/, '') || 'header'}:${Math.round(p.offsetHeight)}`).join(' ')
        };
    });
    check('the panel column stays inside the board box',
        columnFit.content <= columnFit.box, JSON.stringify(columnFit));
    check('the board stays inside the 1080 canvas', await ev(() => [1, 2].every(n => {
        const r = document.getElementById(`player${n}Board`).getBoundingClientRect();
        return r.top >= -1 && r.bottom <= 1081;
    })));
    check('the board does not collide with the match-info bar', await ev(() => {
        const b = document.getElementById('player1Board').getBoundingClientRect();
        const m = document.getElementById('matchInfo').getBoundingClientRect();
        return b.right <= m.left;
    }));
    check('location names ellipsise inside their cell', await ev(() =>
        Array.from(document.querySelectorAll('#p1Locs .loc-name')).every(el =>
            el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')));
    check('slot counters report the filled slots', await ev(() =>
        document.getElementById('p1CharCount').textContent === '6/6' &&
        document.getElementById('p1LocCount').textContent === '3/3'));

    console.log('\nLegacy state (saved before this pass)');
    await emit('lorcana-match-reset', {});
    await emit('lorcana-match-update', { player1: LEGACY, player2: LEGACY, currentTurn: 1 });
    check('a board with no characters/locations/items array still renders', await ev(() =>
        document.querySelectorAll('#p1Chars .char-cell.empty').length === 6 &&
        document.querySelectorAll('#p1Locs .loc-cell.empty').length === 3 &&
        document.getElementById('p1ItemsPanel').style.display === 'none'));
    check('legacy board still shows its name, record and lore', await ev(() =>
        document.getElementById('p1Name').textContent === 'Legacy Board' &&
        document.getElementById('p1Record').textContent === '1-0-0' &&
        document.getElementById('p1Lore').textContent === '4'));
    check('legacy board with no ink field renders an empty track', await ev(() =>
        document.getElementById('p1InkAvail').textContent === '0' &&
        document.querySelectorAll('#p1InkTrack .ink-pip').length === 0));
    check('turn emphasis still applies to a legacy board', await ev(() =>
        document.getElementById('player1Board').classList.contains('active-turn') &&
        parseFloat(getComputedStyle(document.getElementById('player1Board'), '::after').opacity) === 1));

    // The overlay re-registers every 5s and the server answers with a FULL state
    // (and an open control page pushes its own full state on that same signal).
    // Invalidating the render caches on that path rebuilt every card twice a
    // minute for the whole broadcast - worse flicker than having no cache.
    console.log('\nPeriodic full-state replay must not churn the DOM');
    await emit('lorcana-match-reset', {});
    await emit('lorcana-character-update', { player: 1, index: 0, character: CHAR() });
    await emit('lorcana-location-update', { player: 1, index: 0, location: { id: 'lr', name: 'Forbidden Mountain', image: '/images/card-back.png', willpower: 6, lore: 1 } });
    await emit('lorcana-ink-update', { player: 1, ink: { total: 5, available: 2 } });
    await emit('lorcana-lore-update', { player: 1, lore: 6, loreGoal: 20 });
    await ev(() => {
        document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art').dataset.stamp = 'keep';
        document.querySelector('#p1Locs .loc-cell:not(.empty) img.loc-art').dataset.stamp = 'keep';
        document.querySelector('#p1InkTrack .ink-pip').dataset.stamp = 'keep';
        document.querySelector('#p1LoreBar .lore-seg').dataset.stamp = 'keep';
    });
    await poll.waitForTimeout(6500);   // spans at least one re-registration
    check('a full-state replay leaves card images in place', await ev(() =>
        document.querySelector('#p1Chars .char-cell:not(.empty) img.char-art')?.dataset.stamp === 'keep' &&
        document.querySelector('#p1Locs .loc-cell:not(.empty) img.loc-art')?.dataset.stamp === 'keep'));
    check('a full-state replay leaves ink pips and lore segments in place', await ev(() =>
        document.querySelector('#p1InkTrack .ink-pip')?.dataset.stamp === 'keep' &&
        document.querySelector('#p1LoreBar .lore-seg')?.dataset.stamp === 'keep'));
    check('a full-state replay fires no phantom lore ticker', await ev(() =>
        document.querySelectorAll('.lore-pop').length === 0));
    check('a full-state replay fires no phantom damage flash', await ev(() =>
        document.querySelectorAll('#p1Chars .char-cell.flash').length === 0));

    // The replay checks above run on a page that has been up for a while. The
    // other half of the same bug is the cold path: an OBS scene refresh mid-match
    // loads the overlay against a board that already has lore on it, and the
    // ticker is a delta against what was last shown - which on a fresh page is
    // zero. Announcing "+12" for points scored ten minutes ago is worse than
    // silence, so only the lore-update event may pop. Both halves are asserted
    // here: the cold load stays silent, and a real event on that same page still
    // speaks.
    console.log('\nA cold page load must not announce lore already on the board');
    await emit('lorcana-lore-update', { player: 1, lore: 12, loreGoal: 20 });
    const cold = await browser.newPage();
    await cold.setViewportSize({ width: 1920, height: 1080 });
    cold.on('pageerror', e => pageErrors.push('[cold load] ' + e.message));
    // Installed before any page script runs, so a ticker that appears and fades
    // during the load is still recorded - polling afterwards could miss it.
    await cold.addInitScript(() => {
        window.__pops = [];
        new MutationObserver(muts => {
            for (const m of muts) for (const nd of m.addedNodes) {
                if (nd.nodeType === 1 && nd.classList && nd.classList.contains('lore-pop')) window.__pops.push(nd.textContent);
            }
        }).observe(document, { childList: true, subtree: true });
    });
    await cold.goto(`${BASE}/lorcana-match`, { waitUntil: 'domcontentloaded' });
    // Non-vacuous: the silence only means anything if the lore really landed.
    check('a cold load renders the lore already on the board', await cold.waitForFunction(
        () => document.getElementById('p1Lore').textContent === '12', { timeout: 8000 }
    ).then(() => true).catch(() => false));
    await cold.waitForTimeout(1800);   // past request-state (500ms) + a pop's 1.2s life
    const coldPops = await cold.evaluate(() => window.__pops.slice());
    check('a cold load fires no phantom lore ticker', coldPops.length === 0, JSON.stringify(coldPops));
    // ...and the genuine event is still announced on that very same page.
    await emit('lorcana-lore-update', { player: 1, lore: 15, loreGoal: 20 });
    await cold.waitForTimeout(220);
    const coldPop = await cold.evaluate(() => {
        const pop = document.querySelector('#p1LorePanel .lore-pop');
        const r = pop && pop.getBoundingClientRect();
        return { seen: window.__pops.slice(), text: pop ? pop.textContent : null, w: r ? r.width : 0, h: r ? r.height : 0 };
    });
    check('a real lore update on that same cold page still pops, and paints pixels',
        coldPop.text === '+3' && coldPop.w > 0 && coldPop.h > 0 &&
        coldPop.seen.length === 1 && coldPop.seen[0] === '+3', JSON.stringify(coldPop));
    await cold.close();

    console.log('\nNo emoji as UI icons');
    check('no emoji glyphs anywhere in the overlay markup', await ev(() =>
        !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(document.documentElement.innerHTML)));

    console.log('\nScript health');
    check('no page errors during the polish run', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
