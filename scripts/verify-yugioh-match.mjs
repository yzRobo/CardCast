// Phase 2/3 verification: Yu-Gi-Oh! match overlay + control, end to end.
// Spawns the server, opens BOTH the control page and the overlay page, exercises
// every control, and asserts the overlay re-renders via the socket round-trip.
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

const server = spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    const cards = await discover();
    check('discovered Monster/Spell/Trap cards from DB', cards.monster && cards.spell && cards.trap,
        JSON.stringify({ monster: cards.monster && cards.monster.name, spell: cards.spell && cards.spell.name, trap: cards.trap && cards.trap.name }));

    browser = await chromium.launch();

    const overlay = await browser.newPage();
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
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
