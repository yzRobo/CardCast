// Drive the Pokemon match overlay headlessly and assert the rendered DOM.
// Covers the polish pass: name banner, ability/attack rows, energy-cost
// parsing, prize Pokeballs, idle-slot animation, turn emphasis and the
// render-caching that keeps HP updates from rebuilding markup.
//   node scripts/verify-pokemon-match.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' -> ' + detail : ''}`); }
};

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/pokemon-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = async (e, d) => { await page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]); await page.waitForTimeout(120); };

    await emit('toggle-pokemon-match', { show: true });

    const charizard = {
        id: 'test_charizard', name: 'Charizard ex', image: '/images/card-back.png',
        maxHp: 330, currentHp: 330, stage: 'Basic, ex', abilityName: 'Infernal Reign',
        attacks: [
            { name: 'Burning Darkness', cost: 'FireFire', damage: '180+' },
            { name: 'Slash', cost: 'ColorlessColorlessPsychic', damage: '60' }
        ]
    };
    // A Pokemon placed before the polish pass: no stage, ability or attacks.
    const legacy = { id: 'test_legacy', name: 'Pidgeot', image: '/images/card-back.png', maxHp: 90, currentHp: 90 };

    console.log('\nActive Pokemon rendering');
    await emit('pokemon-match-update', {
        player1: { name: 'Henry Thompson', prizes: 6, prizesTaken: [], benchSize: 5, active: charizard, bench: [], record: { wins: 6, losses: 1, ties: 1 }, matchScore: 1, turnActions: { energy: false, supporter: false, retreat: false } },
        player2: { name: 'Nathan Spry', prizes: 6, prizesTaken: [], benchSize: 5, active: legacy, bench: [], record: { wins: 6, losses: 1, ties: 1 }, matchScore: 0, turnActions: { energy: false, supporter: false, retreat: false } },
        currentTurn: 1
    });

    check('name banner shows the active Pokemon', await page.textContent('#player1ActiveName') === 'Charizard ex');
    // The DB stores the whole subtypes list; only the stage token belongs here.
    check('stage chip trims the subtype list to the stage', (await page.textContent('#player1ActiveStage')).trim() === 'Basic');
    check('stage chip hidden when absent', await page.evaluate(() => document.getElementById('player2ActiveStage').style.display === 'none'));
    check('ability row rendered', (await page.textContent('#player1Active')).includes('Infernal Reign'));
    check('ability chip labelled', await page.evaluate(() => document.querySelector('#player1Active .move-chip')?.textContent.trim().toLowerCase() === 'ability'));

    const moveNames = await page.$$eval('#player1Active .move-row .move-name', els => els.map(e => e.textContent.trim()));
    check('both attacks rendered under the ability', moveNames.join('|') === 'Infernal Reign|Burning Darkness|Slash', moveNames.join('|'));

    const damages = await page.$$eval('#player1Active .move-damage', els => els.map(e => e.textContent.trim()));
    check('attack damage shown', damages.join('|') === '180+|60', damages.join('|'));

    console.log('\nEnergy cost parsing');
    const pipColors = await page.$$eval('#player1Active .move-row', rows => rows.map(r =>
        Array.from(r.querySelectorAll('.energy-pip')).map(p => p.getAttribute('title'))));
    check('ability row has no energy pips', pipColors[0].length === 0);
    check('"FireFire" parses to 2 Fire pips', pipColors[1].join(',') === 'Fire,Fire', pipColors[1].join(','));
    check('"ColorlessColorlessPsychic" parses in order', pipColors[2].join(',') === 'Colorless,Colorless,Psychic', pipColors[2].join(','));
    check('pips are coloured per type', await page.evaluate(() => {
        const pips = document.querySelectorAll('#player1Active .move-row:nth-child(2) .energy-pip');
        return pips.length === 2 && getComputedStyle(pips[0]).backgroundColor === 'rgb(249, 115, 22)';
    }));

    console.log('\nLegacy Pokemon (no ability/attack fields) still renders');
    check('legacy active shows its card', await page.evaluate(() => !!document.querySelector('#player2Active img.card-art')));
    check('legacy active has no move list', await page.evaluate(() => !document.querySelector('#player2Active .move-list')));
    check('legacy active still shows HP', (await page.textContent('#player2Active .hp-text')).trim() === '90/90');

    console.log('\nHP updates do not rebuild markup');
    await page.evaluate(() => { document.querySelector('#player1Active img.card-art').dataset.stamp = 'original'; });
    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, currentHp: 150 } });
    check('card image element survives an HP change', await page.evaluate(() => document.querySelector('#player1Active img.card-art')?.dataset.stamp === 'original'));
    check('HP text updated in place', (await page.textContent('#player1Active .hp-text')).trim() === '150/330');
    check('HP bar width tracks the ratio', await page.evaluate(() => {
        const w = document.querySelector('#player1Active .hp-fill').style.width;
        return Math.abs(parseFloat(w) - (150 / 330) * 100) < 0.5;
    }));
    check('mid HP flagged low', await page.evaluate(() => document.querySelector('#player1Active .hp-fill').classList.contains('low')));

    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, currentHp: 40 } });
    check('low HP flagged critical', await page.evaluate(() => document.querySelector('#player1Active .hp-fill').classList.contains('critical')));
    check('damage ticker appears on HP loss', await page.evaluate(() =>
        Array.from(document.querySelectorAll('#player1Active .dmg-pop')).some(p => p.textContent === '-110' && !p.classList.contains('heal'))));
    // Presence is not enough - the ticker previously rendered zero pixels
    // because its parent clipped it away entirely.
    check('damage ticker is actually visible, not clipped', await page.evaluate(() => {
        const pop = document.querySelector('#player1Active .dmg-pop');
        if (!pop) return false;
        const r = pop.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // Walk up to any clipping ancestor and confirm the pop is inside it.
        let node = pop.parentElement;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (style.overflow !== 'visible') {
                const nr = node.getBoundingClientRect();
                if (r.bottom <= nr.top || r.top >= nr.bottom || r.right <= nr.left || r.left >= nr.right) return false;
            }
            node = node.parentElement;
        }
        return true;
    }));
    check('damage ticker clears the HP numerals', await page.evaluate(() => {
        const pop = document.querySelector('#player1Active .dmg-pop').getBoundingClientRect();
        const hp = document.querySelector('#player1Active .hp-text').getBoundingClientRect();
        return pop.bottom <= hp.top + 1;
    }));

    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, currentHp: 330 } });
    check('heal ticker distinguished from damage', await page.evaluate(() => {
        const pops = Array.from(document.querySelectorAll('#player1Active .dmg-pop'));
        return pops.some(p => p.classList.contains('heal') && p.textContent === '+290');
    }));

    console.log('\nSwapping the active Pokemon rebuilds');
    await emit('active-pokemon', { player: 1, pokemon: legacy });
    check('new card replaces the old markup', await page.evaluate(() => document.querySelector('#player1Active img.card-art')?.dataset.stamp === undefined));
    check('banner follows the swap', await page.textContent('#player1ActiveName') === 'Pidgeot');

    // Promoting a second copy of the same card must count as a new Pokemon,
    // otherwise its HP is diffed against the Pokemon it replaced.
    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, uid: 'copy-a', currentHp: 60 } });
    await page.waitForTimeout(1200);
    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, uid: 'copy-b', currentHp: 330 } });
    check('swapping in an identical copy fires no phantom ticker', await page.evaluate(() =>
        document.querySelectorAll('#player1Active .dmg-pop').length === 0));
    check('identical copy still rebuilds the card', (await page.textContent('#player1Active .hp-text')).trim() === '330/330');
    await emit('active-pokemon', { player: 1, pokemon: charizard });

    console.log('\nEmpty active state');
    await emit('active-pokemon', { player: 2, pokemon: null });
    check('empty active shows placeholder', (await page.textContent('#player2Active')).includes('No Active Pokémon'));
    check('empty banner falls back to a label', await page.textContent('#player2ActiveName') === 'Active Pokémon');
    await emit('active-pokemon', { player: 2, pokemon: legacy });

    console.log('\nBench slots');
    await emit('bench-update', { player: 1, bench: [{ id: 'b1', name: 'Rotom', image: '/images/card-back.png', maxHp: 70, currentHp: 70 }] });
    check('bench count reflects filled slots', (await page.textContent('#player1BenchCount')).trim() === '1/5');
    check('five slots rendered', await page.$$eval('#player1Bench .bench-slot', els => els.length) === 5);
    check('four slots are empty', await page.$$eval('#player1Bench .bench-slot.empty', els => els.length) === 4);
    check('empty slots animate a Pokeball', await page.evaluate(() => {
        const slot = document.querySelector('#player1Bench .bench-slot.empty');
        const style = getComputedStyle(slot, '::before');
        return style.animationName === 'bench-drift' && style.backgroundImage.includes('svg');
    }));
    check('idle-slot drift is staggered', await page.$$eval('#player1Bench .bench-slot.empty',
        els => new Set(els.map(e => e.style.getPropertyValue('--drift-delay'))).size === els.length));
    check('bench HP rendered', (await page.textContent('#player1Bench .bench-hp')).trim() === '70/70');

    await page.evaluate(() => { document.querySelector('#player1Bench .bench-slot.filled img').dataset.stamp = 'original'; });
    await emit('bench-update', { player: 1, bench: [{ id: 'b1', name: 'Rotom', image: '/images/card-back.png', maxHp: 70, currentHp: 20 }] });
    check('bench HP change does not rebuild slots', await page.evaluate(() => document.querySelector('#player1Bench .bench-slot.filled img')?.dataset.stamp === 'original'));
    check('bench HP updated in place', (await page.textContent('#player1Bench .bench-hp')).trim() === '20/70');
    check('hurt bench slot flagged', await page.evaluate(() => document.querySelector('#player1Bench .bench-slot.filled').classList.contains('hurt')));

    console.log('\nSeven-slot bench');
    await emit('bench-size-update', { player: 1, size: 7 });
    check('seven slots rendered', await page.$$eval('#player1Bench .bench-slot', els => els.length) === 7);
    check('seven-bench layout class applied', await page.evaluate(() => document.getElementById('player1Bench').classList.contains('bench-7')));
    check('seven slots still fit the panel', await page.evaluate(() => {
        const row = document.getElementById('player1Bench');
        return row.scrollWidth <= row.clientWidth + 1;
    }));
    await emit('bench-size-update', { player: 1, size: 6 });
    check('six slots also fit the panel', await page.evaluate(() => {
        const row = document.getElementById('player1Bench');
        return row.scrollWidth <= row.clientWidth + 1 && row.querySelectorAll('.bench-slot').length === 6;
    }));
    await emit('bench-size-update', { player: 1, size: 5 });
    check('five slots fit the panel', await page.evaluate(() => {
        const row = document.getElementById('player1Bench');
        return row.scrollWidth <= row.clientWidth + 1;
    }));

    // A clipped HP label still parses as a number - "280/280" losing its last
    // digit reads as 280/28, which is worse than an obvious truncation.
    console.log('\nBench HP labels fit at every bench size');
    const bigBench = Array.from({ length: 7 }, (_, i) => ({ id: `big${i}`, name: 'Dondozo', image: '/images/card-back.png', maxHp: 280, currentHp: 280 }));
    for (const size of [5, 6, 7]) {
        await emit('bench-size-update', { player: 1, size });
        await emit('bench-update', { player: 1, bench: bigBench.slice(0, size) });
        // scrollWidth/clientWidth are both rounded to whole pixels, so they
        // miss a sub-pixel overflow that Chrome still paints as a lost digit.
        // Measure the rendered text itself against the content box instead.
        const worst = await page.$$eval('#player1Bench .bench-hp', els => els.map(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const ink = range.getBoundingClientRect().width;
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const inner = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return inner - ink;
        }).reduce((a, b) => Math.min(a, b), Infinity));
        check(`three-digit HP not clipped at bench size ${size}`, worst >= 0, `${worst.toFixed(2)}px slack`);
    }
    await emit('bench-size-update', { player: 1, size: 5 });
    await emit('bench-update', { player: 1, bench: [{ id: 'b1', name: 'Rotom', image: '/images/card-back.png', maxHp: 70, currentHp: 20 }] });

    console.log('\nPrize markers');
    await emit('prize-taken', { player: 1, index: 0 });
    await emit('prize-taken', { player: 1, index: 1 });
    check('taken prizes marked', await page.$$eval('#player1PrizeCards .prize-card.taken', els => els.length) === 2);
    check('headline numeral counts remaining', (await page.textContent('#player1Prizes')).trim() === '4');
    check('prize markers use the Pokeball art', await page.evaluate(() => getComputedStyle(document.querySelector('#player1PrizeCards .prize-card')).backgroundImage.includes('svg')));
    check('no leftover cross glyph on taken prizes', await page.evaluate(() => {
        const el = document.querySelector('#player1PrizeCards .prize-card.taken');
        return getComputedStyle(el, '::after').content === 'none';
    }));

    for (const i of [2, 3, 4]) await emit('prize-taken', { player: 1, index: i });
    check('last prize highlighted', await page.evaluate(() => document.getElementById('player1Prizes').classList.contains('last-prize')));
    await emit('prizes-reset', {});
    check('prizes reset clears markers', await page.$$eval('#player1PrizeCards .prize-card.taken', els => els.length) === 0);

    console.log('\nTurn emphasis');
    await emit('turn-switch', { currentTurn: 2 });
    check('active board flagged', await page.evaluate(() => document.getElementById('player2Board').classList.contains('active-turn')));
    check('idle board flagged', await page.evaluate(() => document.getElementById('player1Board').classList.contains('idle-turn')));
    check('idle board is visibly recessed', await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('player1Board')).opacity) < 1));
    await emit('turn-switch', { currentTurn: 1 });
    check('emphasis follows the turn back', await page.evaluate(() =>
        document.getElementById('player1Board').classList.contains('active-turn') &&
        document.getElementById('player2Board').classList.contains('idle-turn')));

    console.log('\nTurn actions');
    await emit('turn-actions-update', { player: 1, actions: { energy: true, supporter: false, retreat: true } });
    check('used actions lit', await page.evaluate(() => document.getElementById('player1Energy').classList.contains('active') && document.getElementById('player1Retreat').classList.contains('active')));
    check('unused action dim', await page.evaluate(() => !document.getElementById('player1Supporter').classList.contains('active')));
    check('action icons are inline SVG, not emoji', await page.$$eval('.action-icon', els => els.length === 6 && els.every(e => e.querySelector('svg'))));

    console.log('\nTimer');
    await emit('timer-set', { minutes: 0, seconds: 45 });
    check('final minute flagged expiring', await page.evaluate(() => document.getElementById('matchTimer').classList.contains('expiring')));
    await emit('timer-set', { minutes: 30, seconds: 0 });
    check('normal time not flagged', await page.evaluate(() => !document.getElementById('matchTimer').classList.contains('expiring')));

    console.log('\nLayout integrity');
    check('boards stay inside the 1080 canvas', await page.evaluate(() => {
        return [1, 2].every(n => {
            const r = document.getElementById(`player${n}Board`).getBoundingClientRect();
            return r.top >= -1 && r.bottom <= 1081;
        });
    }));
    check('no panel overflows its board', await page.evaluate(() => {
        return [1, 2].every(n => {
            const board = document.getElementById(`player${n}Board`);
            const r = board.getBoundingClientRect();
            return Array.from(board.querySelectorAll('.panel')).every(p => {
                const pr = p.getBoundingClientRect();
                return pr.bottom <= r.bottom + 1 && pr.top >= r.top - 1;
            });
        });
    }));
    check('active card art stays within its panel', await page.evaluate(() => {
        const panel = document.getElementById('player1ActivePanel').getBoundingClientRect();
        const art = document.querySelector('#player1Active img.card-art').getBoundingClientRect();
        return art.top >= panel.top - 1 && art.left >= panel.left - 1 && art.right <= panel.right + 1 && art.bottom <= panel.bottom + 1;
    }));
    // A legacy Pokemon has a short stat block; the art must not spill past it.
    check('legacy card art also stays within its panel', await page.evaluate(() => {
        const panel = document.getElementById('player2ActivePanel').getBoundingClientRect();
        const art = document.querySelector('#player2Active img.card-art').getBoundingClientRect();
        return art.bottom <= panel.bottom + 1 && art.top >= panel.top - 1;
    }));
    check('stat block sits below the art, never slicing it', await page.evaluate(() => {
        const art = document.querySelector('#player1Active img.card-art').getBoundingClientRect();
        const info = document.querySelector('#player1Active .active-info').getBoundingClientRect();
        return info.top >= art.bottom - 1;
    }));
    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, tools: [{ id: 't1', name: 'Technical Machine: Evolution', image: '/images/card-back.png' }] } });
    check('tool chips stay on the card art, not the panel background', await page.evaluate(() => {
        const art = document.querySelector('#player1Active img.card-art').getBoundingClientRect();
        const chip = document.querySelector('#player1Active .tool-chip').getBoundingClientRect();
        return chip.right <= art.right + 1 && chip.left >= art.left - 1 && chip.top >= art.top - 1;
    }));
    console.log('\nLong values do not break the banner');
    await emit('active-pokemon', { player: 1, pokemon: { ...charizard, name: "Team Rocket's Mewtwo ex", stage: 'Basic, ex, Future' } });
    check('long stage list trimmed to one token', (await page.textContent('#player1ActiveStage')).trim() === 'Basic');
    check('long Pokemon name is not crushed by the stage chip', await page.evaluate(() => {
        const name = document.getElementById('player1ActiveName');
        return name.clientWidth > 150;
    }));
    await emit('active-pokemon', { player: 1, pokemon: charizard });
    check('turn rail marks the active side', await page.evaluate(() => {
        const style = getComputedStyle(document.getElementById('player1Board'), '::after');
        return parseFloat(style.opacity) === 1 && parseFloat(style.width) > 0;
    }));
    check('turn rail absent on the idle side', await page.evaluate(() =>
        parseFloat(getComputedStyle(document.getElementById('player2Board'), '::after').opacity) === 0));
    check('stat block is opaque over the card', await page.evaluate(() => {
        const bg = getComputedStyle(document.querySelector('#player1Active .active-info')).backgroundImage;
        return bg.includes('gradient') && !bg.includes('rgba(9, 11, 22, 0)');
    }));
    check('boards hidden on toggle off', await page.evaluate(async () => {
        window.__drv.emit('toggle-pokemon-match', { show: false });
        await new Promise(r => setTimeout(r, 200));
        return !document.getElementById('player1Board').classList.contains('active');
    }));
    await emit('toggle-pokemon-match', { show: true });

    console.log('\nScript health');
    check('no page errors during the run', errors.length === 0, errors.join(' | '));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
