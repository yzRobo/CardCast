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

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
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
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
