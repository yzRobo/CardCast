// Phase 1 verification: MTG match overlay (overlays/mtg-match.html), render-only.
// Drives the real mtg-* socket events through the server (as a control would) and
// asserts the rebuilt overlay re-renders. Also checks the de-Commander refactor
// and the two wiring-bug fixes (record event name, player-switch passthrough).
//
//   node scripts/verify-mtg-match.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const results = [];
// Uncaught errors raised inside the page. socket.io does not catch exceptions
// thrown by an event handler, so anything a handler throws lands here.
const pageErrors = [];
const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`);
};
async function isUp() {
    try { const r = await fetch(BASE + '/api/config'); return r.ok; } catch { return false; }
}
async function waitForServer(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isUp()) return true;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('server did not start in time');
}

// Reuse a running server if present; otherwise spawn one (and kill it at the end).
const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    await waitForServer();
    browser = await chromium.launch();

    const overlay = await browser.newPage();
    overlay.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGE ERROR:', e.message); });
    // domcontentloaded (not networkidle): the overlay holds a persistent socket.io
    // connection, so the network never goes fully idle. We gate on DOM state instead.
    await overlay.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    await overlay.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });
    check('overlay connects to server', true);

    // Dedicated driver socket on the overlay page (separate from the overlay's
    // own render-only socket). socket.io buffers emits until connected.
    await overlay.evaluate(() => { window.__drv = io(); });
    await overlay.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (event, data) => overlay.evaluate(([e, d]) => window.__drv.emit(e, d), [event, data]);
    const wait = (fn, arg) => overlay.waitForFunction(fn, arg, { timeout: 6000 }).then(() => true).catch(() => false);

    // Clean slate. The server may already be running with state left over from a
    // previous run (the harness reuses a live server), and the default-render
    // checks below only mean something from a known-empty board.
    await emit('mtg-match-reset', {});
    await emit('mtg-format-update', { format: 'Standard' });
    await emit('mtg-player-name-update', { player: 1, name: 'Player 1' });
    await emit('mtg-player-name-update', { player: 2, name: 'Player 2' });
    await emit('mtg-player-record-update', { player: 1, record: '0-0-0' });
    await emit('mtg-player-record-update', { player: 2, record: '0-0-0' });
    await emit('mtg-games-won-update', { player: 1, gamesWon: 0 });
    await emit('mtg-timer-update', { seconds: 0 });
    await emit('mtg-player-switch', { activePlayer: 1 });
    await overlay.waitForTimeout(400);

    // De-Commander: overlay has zero Commander DOM / text.
    const commanderDom = await overlay.evaluate(() =>
        document.querySelectorAll('[class*="commander"],[id*="commander"]').length +
        (/commander/i.test(document.body.innerHTML) ? 1 : 0));
    check('overlay has no Commander UI', commanderDom === 0, `found ${commanderDom}`);

    // Default render: 20 life, healthy, poison hidden, Standard label.
    check('P1 starts at 20 life (healthy)', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '20' && el.classList.contains('life-healthy');
    }));
    check('poison hidden at 0', await overlay.evaluate(() => getComputedStyle(document.getElementById('p1-poison')).display === 'none'));
    check('format label defaults to Standard', await overlay.evaluate(() => document.getElementById('format-label').textContent === 'Standard'));

    // Life thresholds
    await emit('mtg-life-update', { player: 1, life: 9 });
    check('life 9 -> warning', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '9' && el.classList.contains('life-warning');
    }));
    await emit('mtg-life-update', { player: 1, life: 3 });
    check('life 3 -> critical', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.textContent === '3' && el.classList.contains('life-critical');
    }));

    // Poison (alt loss condition): appears > 0, lethal at 10
    await emit('mtg-poison-update', { player: 1, poison: 4 });
    check('poison 4 shows', await wait(() => {
        const el = document.getElementById('p1-poison');
        return getComputedStyle(el).display !== 'none' && document.getElementById('p1-poison-val').textContent === '4';
    }));
    await emit('mtg-poison-update', { player: 1, poison: 10 });
    check('poison 10 -> lethal', await wait(() => document.getElementById('p1-poison').classList.contains('lethal')));

    // Lands
    await emit('mtg-lands-update', { player: 1, lands: 5 });
    check('lands 5', await wait(() => document.getElementById('p1-lands').textContent === '5'));

    // Turn flags (control emits mtg-turn-action; server re-emits mtg-turn-actions-update)
    await emit('mtg-turn-action', { player: 1, action: 'landPlayed', value: true });
    await emit('mtg-turn-action', { player: 1, action: 'spellCast', value: true });
    check('Land flag active', await wait(() => document.getElementById('p1-land-flag').classList.contains('active')));
    check('Spell flag active', await wait(() => document.getElementById('p1-spell-flag').classList.contains('active')));

    // Featured permanents (art + name only)
    await emit('mtg-permanent-add', { player: 1, card: { id: 't1', name: 'Lightning Bolt', image_url: '' } });
    check('featured permanent added (count + card)', await wait(() => {
        const cards = document.querySelectorAll('#p1-featured .perm-card');
        return cards.length === 1 && document.getElementById('p1-perm-count').textContent === '1' &&
            /Lightning Bolt/.test(document.querySelector('#p1-featured .perm-name').textContent);
    }));

    // Phase
    await emit('mtg-phase-update', { phase: 'combat' });
    check('phase -> Combat', await wait(() => document.getElementById('phase-text').textContent === 'Combat'));

    // Name / record / games-won. Record exercises bug #1 (server emits mtg-record-update).
    await emit('mtg-player-name-update', { player: 2, name: 'Jace' });
    check('P2 name', await wait(() => document.getElementById('p2-name').textContent === 'Jace'));
    await emit('mtg-player-record-update', { player: 1, record: '2-1-0' });
    check('P1 record reaches overlay (record-event fix)', await wait(() => document.getElementById('p1-record').textContent === '2-1-0'));
    await emit('mtg-games-won-update', { player: 1, gamesWon: 1 });
    check('P1 games won', await wait(() => document.getElementById('p1-games').textContent === '1'));

    // Active player passthrough (bug #2): set active directly to P2.
    await emit('mtg-player-switch', { activePlayer: 2 });
    check('active player -> P2 (set, not toggle)', await wait(() =>
        document.getElementById('p2-board').classList.contains('active') &&
        !document.getElementById('p1-board').classList.contains('active')));
    check('turn label shows P2 name', await wait(() => document.getElementById('turn-text').textContent === "Jace's Turn"));

    // Format is label-only: changing it must NOT change life (still 3 / critical).
    await emit('mtg-format-update', { format: 'Modern' });
    check('format label -> Modern', await wait(() => document.getElementById('format-label').textContent === 'Modern'));
    check('format change does NOT alter life', await overlay.evaluate(() => document.getElementById('p1-life').textContent === '3'));

    // Timer
    await emit('mtg-timer-update', { seconds: 754 });
    check('timer shows 12:34', await wait(() => document.getElementById('timer-text').textContent === '12:34'));

    // Reconnecting overlay hydrates current server state via request-state.
    const overlay2 = await browser.newPage();
    await overlay2.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    check('fresh overlay restores life 3', await overlay2.waitForFunction(
        () => document.getElementById('p1-life').textContent === '3', { timeout: 6000 }).then(() => true).catch(() => false));
    check('fresh overlay restores P2 name Jace', await overlay2.evaluate(() => document.getElementById('p2-name').textContent === 'Jace'));

    // Reset returns life to 20, preserves names, hides poison (overlay reloads).
    await emit('mtg-match-reset', {});
    await overlay.waitForTimeout(800); // let location.reload() begin before we re-bind
    await overlay.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });
    check('reset -> life back to 20', await wait(() => document.getElementById('p1-life').textContent === '20'));
    check('reset -> poison hidden', await overlay.evaluate(() => getComputedStyle(document.getElementById('p1-poison')).display === 'none'));
    check('reset preserves P2 name', await overlay.evaluate(() => document.getElementById('p2-name').textContent === 'Jace'));

    // ==================================================================
    // Polish pass. Geometry and computed style, not DOM presence: an
    // element can exist, hold the right text and still render zero pixels.
    // ==================================================================

    // Bounding rect of the first match, rounded.
    const rect = (sel) => overlay.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    }, sel);

    // Is the element actually painted, or swallowed by an overflow:hidden
    // ancestor / a zero-opacity ancestor / a zero-sized box?
    const visibility = (sel) => overlay.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return { ok: false, why: 'element missing' };
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { ok: false, why: `zero size ${r.width}x${r.height}` };
        let node = el.parentElement;
        while (node && node !== document.documentElement) {
            const cs = getComputedStyle(node);
            if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
                const p = node.getBoundingClientRect();
                if (r.left < p.left - 0.5 || r.right > p.right + 0.5 || r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5) {
                    return { ok: false, why: `clipped by .${node.className || node.tagName}` };
                }
            }
            if (parseFloat(cs.opacity) === 0 || cs.display === 'none' || cs.visibility === 'hidden') {
                return { ok: false, why: `invisible ancestor .${node.className || node.tagName}` };
            }
            node = node.parentElement;
        }
        return { ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    }, sel);

    const sameRect = (a, b, keys = ['x', 'y', 'w', 'h'], tol = 1) =>
        !!a && !!b && keys.every(k => Math.abs(a[k] - b[k]) <= tol);

    // Height of a board with an EMPTY permanent shelf (scripts/geom-mtg-match.mjs).
    // The caster frames these panels in OBS, so the resting height is part of the
    // contract: the shelf may grow when permanents are featured, but an idle
    // board must always come back to exactly this.
    const RESTING_BOARD_H = 463;

    await emit('mtg-player-switch', { activePlayer: 1 });
    await overlay.waitForTimeout(250);

    // ---- 1. Active-player emphasis -------------------------------------
    check('active board keeps legacy .active AND gains .active-turn', await wait(() => {
        const p1 = document.getElementById('p1-board'), p2 = document.getElementById('p2-board');
        return p1.classList.contains('active') && p1.classList.contains('active-turn') &&
            !p1.classList.contains('idle-turn') &&
            p2.classList.contains('idle-turn') && !p2.classList.contains('active-turn');
    }));

    const railStyles = await overlay.evaluate(() => {
        const a = getComputedStyle(document.getElementById('p1-board'), '::after');
        const b = getComputedStyle(document.getElementById('p2-board'), '::after');
        return {
            activeOpacity: a.opacity, idleOpacity: b.opacity,
            width: a.width, activeRight: a.right, idleLeft: b.left,
            activeBg: a.backgroundImage
        };
    });
    check('active rail is lit, idle rail is off (categorical, not a dim %)',
        railStyles.activeOpacity === '1' && railStyles.idleOpacity === '0',
        JSON.stringify(railStyles));
    check('rail is a 4px bar with an accent gradient',
        railStyles.width === '4px' && /gradient/.test(railStyles.activeBg), JSON.stringify(railStyles));
    // Inner edge = the side facing screen centre: right of the left board,
    // left of the right board.
    check('rail sits on each board\'s INNER edge',
        railStyles.activeRight === '-14px' && railStyles.idleLeft === '-14px', JSON.stringify(railStyles));

    const boardStyles = await overlay.evaluate(() => {
        const a = getComputedStyle(document.getElementById('p1-board'));
        const b = getComputedStyle(document.getElementById('p2-board'));
        return { aOpacity: a.opacity, aFilter: a.filter, bOpacity: b.opacity, bFilter: b.filter, aShadow: a.boxShadow };
    });
    check('idle board settles back (opacity ~0.8 + desaturate)',
        Math.abs(parseFloat(boardStyles.bOpacity) - 0.8) < 0.05 && /saturate\(0\.7\)/.test(boardStyles.bFilter),
        JSON.stringify(boardStyles));
    check('active board stays fully lit (opacity 1, no filter)',
        parseFloat(boardStyles.aOpacity) === 1 && boardStyles.aFilter === 'none', JSON.stringify(boardStyles));
    check('active board carries the accent glow', /99, 102, 241/.test(boardStyles.aShadow), boardStyles.aShadow);

    // Switching sides must move the rail, not light both.
    await emit('mtg-player-switch', { activePlayer: 2 });
    check('turn switch moves the rail to the other board', await wait(() =>
        getComputedStyle(document.getElementById('p2-board'), '::after').opacity === '1' &&
        getComputedStyle(document.getElementById('p1-board'), '::after').opacity === '0'));
    await emit('mtg-player-switch', { activePlayer: 1 });
    await overlay.waitForTimeout(250);

    // ---- 2. Permanent shelf: resting height, then idle slots ------------
    // An EMPTY shelf renders no cells at all, on purpose: the board's resting
    // height is framed in the caster's OBS scene, and padding an empty shelf out
    // to a row of idle slots grows the panel by ~180px. (An earlier revision of
    // this harness asserted the opposite; the overlay is what is correct.)
    const emptyShelf = await overlay.evaluate(() => {
        const row = document.getElementById('p1-featured');
        return {
            cells: row.children.length,
            rowH: Math.round(row.getBoundingClientRect().height),
            boardH: Math.round(document.getElementById('p1-board').getBoundingClientRect().height),
            otherBoardH: Math.round(document.getElementById('p2-board').getBoundingClientRect().height)
        };
    });
    check('an empty shelf renders no cells (no dead gap, no padded stub)',
        emptyShelf.cells === 0 && emptyShelf.rowH <= 4, JSON.stringify(emptyShelf));
    check('an empty board keeps the framed resting height (463px)',
        emptyShelf.boardH === RESTING_BOARD_H && emptyShelf.otherBoardH === RESTING_BOARD_H,
        JSON.stringify(emptyShelf));

    // Idle slots exist only to pad a PARTIAL row, so they have to be measured on
    // one. Measured on an empty shelf every .every() below is a vacuous truth
    // over an empty list.
    await emit('mtg-permanent-add', { player: 1, card: { id: 'c1', name: 'Llanowar Elves', image_url: '' } });
    await wait(() => document.querySelectorAll('#p1-featured .perm-slot').length === 2);
    check('a partial row is padded out with idle slots',
        await overlay.evaluate(() => document.querySelectorAll('#p1-featured .perm-slot').length === 2));

    const slotGeom = await overlay.evaluate(() => {
        const row = document.getElementById('p1-featured').getBoundingClientRect();
        const slots = [...document.querySelectorAll('#p1-featured .perm-slot')].map(s => {
            const b = s.getBoundingClientRect();
            const cs = getComputedStyle(s, '::before');
            return {
                w: b.width, h: b.height, right: b.right, left: b.left,
                ratio: b.height / b.width,
                anim: cs.animationName, delay: cs.animationDelay, bg: cs.backgroundImage
            };
        });
        return { row: { left: row.left, right: row.right, w: row.width, h: row.height }, slots };
    });
    check('idle slots keep card proportions (63:88)',
        slotGeom.slots.every(s => Math.abs(s.ratio - 88 / 63) < 0.04),
        JSON.stringify(slotGeom.slots.map(s => `${Math.round(s.w)}x${Math.round(s.h)}`)));
    check('idle slots never overflow the shelf',
        slotGeom.slots.every(s => s.left >= slotGeom.row.left - 0.5 && s.right <= slotGeom.row.right + 0.5),
        JSON.stringify(slotGeom.row));
    check('idle slots carry the drifting mana motif',
        slotGeom.slots.every(s => s.anim === 'perm-drift' && s.bg.startsWith('url("data:image/svg+xml')),
        JSON.stringify(slotGeom.slots.map(s => s.anim)));
    check('idle slots are staggered (no lockstep march)',
        new Set(slotGeom.slots.map(s => s.delay)).size === slotGeom.slots.length,
        JSON.stringify(slotGeom.slots.map(s => s.delay)));
    const driftPeak = await overlay.evaluate(() => {
        // Read the keyframe opacity out of the stylesheet: the computed value is
        // a moving target mid-animation.
        for (const sheet of document.styleSheets) {
            let rules;
            // The Google Fonts sheet is cross-origin; reading its rules throws.
            try { rules = sheet.cssRules; } catch { continue; }
            for (const r of rules) {
                if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'perm-drift') {
                    return [...r.cssRules].map(k => k.style.opacity).filter(Boolean);
                }
            }
        }
        return [];
    });
    check('drift stays quiet (peak opacity <= 0.2)',
        driftPeak.length > 0 && driftPeak.every(o => parseFloat(o) <= 0.2), JSON.stringify(driftPeak));

    // ---- 3. Render caching ---------------------------------------------
    check('one permanent still fills the row to 3 slots (stable shelf height)',
        await overlay.evaluate(() => {
            const row = document.getElementById('p1-featured');
            return row.children.length === 3 &&
                row.children[0].classList.contains('perm-card') &&
                row.children[1].classList.contains('perm-slot');
        }));
    check('a card entering a slot animates in',
        await overlay.evaluate(() => getComputedStyle(document.querySelector('#p1-featured .perm-card')).animationName === 'card-swap'));

    await overlay.evaluate(() => { document.querySelector('#p1-featured .perm-card').dataset.keep = 'yes'; });
    await emit('mtg-permanent-add', { player: 1, card: { id: 'c2', name: 'Birds of Paradise', image_url: '' } });
    await wait(() => document.querySelectorAll('#p1-featured .perm-card').length === 2);
    check('adding a permanent does NOT rebuild the existing slot (no image reload)',
        await overlay.evaluate(() => document.querySelector('#p1-featured .perm-card').dataset.keep === 'yes'));

    await emit('mtg-life-update', { player: 1, life: 17 });
    await overlay.waitForTimeout(200);
    check('a life tick does NOT touch the permanent markup',
        await overlay.evaluate(() => document.querySelector('#p1-featured .perm-card').dataset.keep === 'yes'));

    // Removing a permanent from the MIDDLE. Every card behind it shifts down a
    // slot, so an index-keyed cache sees "slot 1 changed, slot 2 changed" and
    // rebuilds both - re-requesting their art and replaying their entrance,
    // which is the exact flicker the cache exists to prevent. The cache is keyed
    // by card identity instead, so the survivors keep their nodes.
    await emit('mtg-permanent-add', { player: 1, card: { id: 'c3', name: 'Grizzly Bears', image_url: '' } });
    await wait(() => document.querySelectorAll('#p1-featured .perm-card').length === 3);
    // Control for the entrance probes below: a card that really IS new has a
    // running card-swap, so "nothing running" downstream is a fact about reuse
    // and not about how getAnimations() reports a finished animation.
    const freshEntrance = await overlay.evaluate(() =>
        [...document.getElementById('p1-featured').children]
            .map(c => c.getAnimations().map(a => `${a.animationName}:${a.playState}`).join(',')));
    check('a genuinely new card animates in (control for the reuse probes)',
        freshEntrance.some(a => a.startsWith('card-swap:running')), JSON.stringify(freshEntrance));

    await overlay.waitForTimeout(700); // entrances finish, so nothing is running
    await overlay.evaluate(() => {
        window.__perm = [...document.getElementById('p1-featured').children];
        window.__permImg = window.__perm.map(n => n.querySelector('img'));
        window.__perm.forEach((n, i) => { n.dataset.tag = `t${i}`; });
    });
    await emit('mtg-permanent-remove', { player: 1, index: 1 });
    await wait(() => document.querySelectorAll('#p1-featured .perm-card').length === 2);
    const identity = await overlay.evaluate(() => {
        const kids = [...document.getElementById('p1-featured').children];
        const img = kids[1] && kids[1].querySelector('img');
        return {
            cells: kids.length,
            names: kids.map(k => (k.querySelector('.perm-name') || {}).textContent || 'idle'),
            // Same ELEMENTS, not merely same markup: a rebuild produces new nodes.
            headSame: kids[0] === window.__perm[0],
            tailSame: kids[1] === window.__perm[2],
            tailTag: kids[1] && kids[1].dataset.tag,
            // Same <img> element with an unchanged src = nothing was re-requested.
            imgSame: img === window.__permImg[2],
            imgLoaded: !!img && img.complete && img.naturalWidth > 0,
            removedGone: !window.__perm[1].isConnected,
            // Sampled immediately: a rebuilt card would be 450ms into a fresh
            // card-swap right now, and a reused one has nothing running at all.
            running: kids.map(k => k.getAnimations().map(a => `${a.animationName}:${a.playState}`).join(',')),
            keptDataset: kids[0] && kids[0].dataset.keep === 'yes'
        };
    });
    check('removing a permanent keeps the surviving slot intact', identity.keptDataset, JSON.stringify(identity));
    check('a middle removal reuses the trailing card\'s node (no image reload)',
        identity.cells === 3 && identity.headSame && identity.tailSame && identity.tailTag === 't2' &&
        identity.imgSame && identity.imgLoaded && identity.removedGone, JSON.stringify(identity));
    check('a middle removal replays no entrance animation at all',
        identity.running.every(r => r === ''), JSON.stringify(identity.running));
    check('the removed permanent is the one that disappeared',
        identity.names[0] === 'Llanowar Elves' && identity.names[1] === 'Grizzly Bears' &&
        identity.names[2] === 'idle', JSON.stringify(identity));

    // Order changes. The control only appends and removes today, so this is
    // driven through the renderer itself - it is the case an index-keyed cache
    // gets most wrong, and the case where moving a node matters: re-inserting an
    // element restarts its CSS animations, so a survivor would replay its
    // entrance unless the one-shot is spent first.
    const reorder = await overlay.evaluate(() => {
        const el = document.getElementById('p1-featured');
        const before = [...el.children];
        renderFeatured(1, ((mtg.player1 || {}).featuredPermanents || []).slice().reverse());
        const after = [...el.children];
        return {
            reused: after.map(n => before.indexOf(n)), // -1 would mean "rebuilt"
            names: after.map(n => (n.querySelector('.perm-name') || {}).textContent || 'idle'),
            running: after.map(n => n.getAnimations().map(a => `${a.animationName}:${a.playState}`).join(','))
        };
    });
    check('re-ordering the shelf moves the existing nodes instead of rebuilding them',
        reorder.reused.length === 3 && reorder.reused.every(i => i >= 0) &&
        new Set(reorder.reused).size === 3 && reorder.names[0] === 'Grizzly Bears',
        JSON.stringify(reorder));
    check('a card that only changed slot does not replay its entrance',
        reorder.running.every(r => r === ''), JSON.stringify(reorder));

    // ...and that is not free: the identical move without the guard restarts the
    // animation, which is what makes the guard worth having.
    const unguarded = await overlay.evaluate(() => {
        const el = document.getElementById('p1-featured');
        const node = [...el.children].find(n => n.classList.contains('perm-card') && n.classList.contains('settled'));
        if (!node) return { found: false };
        node.classList.remove('settled');
        el.appendChild(node);  // the same kind of move the reconciler makes
        const anims = node.getAnimations().map(a => `${a.animationName}:${a.playState}`);
        node.classList.add('settled');
        renderFeatured(1, ((mtg.player1 || {}).featuredPermanents || [])); // back to wire order
        return {
            found: true, anims,
            order: [...el.children].map(n => (n.querySelector('.perm-name') || {}).textContent || 'idle')
        };
    });
    check('the entrance guard is load-bearing (the same move without it replays)',
        unguarded.found && unguarded.anims.some(a => a.startsWith('card-swap:running')), JSON.stringify(unguarded));
    check('the shelf comes back to wire order after the reorder probe',
        unguarded.order && unguarded.order.join('|') === 'Llanowar Elves|Grizzly Bears|idle',
        JSON.stringify(unguarded));

    // A second copy of the same card is a different placement: identity keying
    // must hand it its OWN node, not reuse the first copy's node twice.
    await emit('mtg-permanent-add', { player: 1, card: { id: 'c1', name: 'Llanowar Elves', image_url: '' } });
    await wait(() => document.querySelectorAll('#p1-featured .perm-card').length === 3);
    check('duplicate copy renders in its own slot', await overlay.evaluate(() => {
        const cards = [...document.querySelectorAll('#p1-featured .perm-card')];
        const names = cards.map(c => c.querySelector('.perm-name').textContent);
        return cards.length === 3 &&
            names.filter(n => n === 'Llanowar Elves').length === 2 &&
            cards[0] !== cards[2] &&
            // and the original copy still holds the node it always had
            cards[0] === window.__perm[0];
    }));

    // Second row: 5 cards -> 6 cells (two full rows), and the taller board must
    // still clear the bottom match bar.
    for (const n of [4, 5]) {
        await emit('mtg-permanent-add', { player: 1, card: { id: `x${n}`, name: `Filler ${n}`, image_url: '' } });
    }
    const twoRows = await wait(() => document.getElementById('p1-featured').children.length === 6);
    // Let the entrance animation finish: it scales the card, and a transform is
    // baked into getBoundingClientRect, so measuring mid-flight compares a
    // shrunken card against a settled slot.
    await overlay.waitForTimeout(700);
    check('5 permanents pad out to two full rows of three', twoRows && await overlay.evaluate(() => {
        const kids = [...document.getElementById('p1-featured').children];
        return kids.length === 6 &&
            kids.filter(k => k.classList.contains('perm-card')).length === 5 &&
            kids[5].classList.contains('perm-slot');
    }));
    const tallBoard = await rect('#p1-board');
    const bar = await rect('.match-bar');
    check('tallest board still clears the match bar', tallBoard.y + tallBoard.h < bar.y - 20,
        `board bottom ${tallBoard.y + tallBoard.h} vs bar top ${bar.y}`);
    const rowsEqual = await overlay.evaluate(() => {
        const kids = [...document.getElementById('p1-featured').children].map(c => c.getBoundingClientRect());
        const top = kids.slice(0, 3), bottom = kids.slice(3);
        const eq = (arr) => arr.every(r => Math.abs(r.height - arr[0].height) < 2 && Math.abs(r.top - arr[0].top) < 2);
        return eq(top) && eq(bottom);
    });
    check('filled and idle slots line up within each row', rowsEqual);

    // ---- 4. Overflow safety --------------------------------------------
    const LONG = 'Bartholomew Vandergrift III';
    await emit('mtg-player-name-update', { player: 1, name: LONG });
    await emit('mtg-player-record-update', { player: 1, record: '12-10-3' });
    await overlay.waitForTimeout(250);
    const nameFit = await overlay.evaluate(() => {
        const name = document.getElementById('p1-name');
        const rec = document.getElementById('p1-record');
        const board = document.getElementById('p1-board');
        const n = name.getBoundingClientRect(), r = rec.getBoundingClientRect(), b = board.getBoundingClientRect();
        const cs = getComputedStyle(name);
        return {
            truncating: name.scrollWidth > name.clientWidth,
            ellipsis: cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden',
            overlaps: n.right > r.left + 0.5,
            recordInside: r.right <= b.right - 22 + 0.5 && r.left >= b.left,
            recordFull: rec.scrollWidth <= rec.clientWidth + 1
        };
    });
    check('over-long player name truncates with an ellipsis',
        nameFit.truncating && nameFit.ellipsis, JSON.stringify(nameFit));
    check('long name never overlaps or displaces the record chip',
        !nameFit.overlaps && nameFit.recordInside && nameFit.recordFull, JSON.stringify(nameFit));

    const turnFit = await overlay.evaluate(() => {
        const t = document.getElementById('turn-text').getBoundingClientRect();
        const barR = document.querySelector('.match-bar').getBoundingClientRect();
        const p1 = document.getElementById('p1-board').getBoundingClientRect();
        const p2 = document.getElementById('p2-board').getBoundingClientRect();
        return {
            turnW: Math.round(t.width),
            centred: Math.abs((barR.left + barR.right) / 2 - 960) < 1.5,
            clearsBoards: barR.left > p1.right && barR.right < p2.left
        };
    });
    check('whose-turn chip is capped so the bar cannot stretch into the boards',
        turnFit.turnW <= 321 && turnFit.centred && turnFit.clearsBoards, JSON.stringify(turnFit));

    await emit('mtg-permanent-add', { player: 2, card: { id: 'long1', name: 'Kroxa, Titan of Death’s Hunger', image_url: '' } });
    await wait(() => document.querySelectorAll('#p2-featured .perm-card').length === 1);
    const permNameFit = await overlay.evaluate(() => {
        const label = document.querySelector('#p2-featured .perm-name');
        const slot = label.closest('.perm-card').getBoundingClientRect();
        const l = label.getBoundingClientRect();
        return {
            inside: l.left >= slot.left - 0.5 && l.right <= slot.right + 0.5,
            truncating: label.scrollWidth > label.clientWidth,
            ellipsis: getComputedStyle(label).textOverflow === 'ellipsis',
            text: label.textContent
        };
    });
    check('long card name stays inside its slot and ellipses',
        permNameFit.inside && permNameFit.truncating && permNameFit.ellipsis, JSON.stringify(permNameFit));
    check('card names are HTML-escaped, not injected', permNameFit.text === 'Kroxa, Titan of Death’s Hunger', permNameFit.text);

    // A permanent whose art 404s must not spin a request loop. The overlay used
    // to re-assign the same (also missing) fallback URL from an inline onerror,
    // which measured at ~1200 requests a second, forever.
    let backHits = 0;
    const countBack = (r) => { if (r.url().includes('card-back') || r.url().includes('no-such-art')) backHits++; };
    overlay.on('request', countBack);
    await emit('mtg-permanent-add', { player: 2, card: { id: 'broken', name: 'Broken Art', image_url: '/no-such-art/x.png' } });
    await wait(() => document.querySelectorAll('#p2-featured .perm-card').length === 2);
    await overlay.waitForTimeout(2500);
    overlay.off('request', countBack);
    check('broken card art does not spin a request loop', backHits <= 3, `${backHits} image requests in 2.5s`);
    // The fallback art now ships (public/images/card-back.png), so a card whose
    // own art 404s lands on a real card back rather than the degraded
    // placeholder. Assert the fallback actually PAINTED - naturalWidth proves
    // the swap resolved rather than leaving a second broken image.
    const brokenSlot = await overlay.evaluate(() => {
        const cards = [...document.querySelectorAll('#p2-featured .perm-card')];
        const broken = cards.find(c => c.querySelector('.perm-name').textContent === 'Broken Art');
        const good = cards.find(c => c !== broken);
        if (!broken || !good) return null;
        const img = broken.querySelector('img');
        const b = broken.getBoundingClientRect(), g = good.getBoundingClientRect();
        const i = img.getBoundingClientRect();
        return {
            src: img.getAttribute('src'),
            tried: img.dataset.triedFallback === '1',
            loaded: img.complete && img.naturalWidth > 0,
            painted: i.width > 4 && i.height > 4,
            nameVisible: broken.querySelector('.perm-name').getBoundingClientRect().height > 4,
            heightMatch: Math.abs(b.height - g.height) < 2,
            notDegradedYet: !broken.classList.contains('art-missing')
        };
    });
    check('missing art falls back exactly once, to the shipped card back',
        brokenSlot && brokenSlot.tried && brokenSlot.src === '/images/card-back.png' &&
        brokenSlot.loaded && brokenSlot.painted && brokenSlot.notDegradedYet, JSON.stringify(brokenSlot));
    check('a permanent whose art failed still holds its cell and shows its name',
        brokenSlot && brokenSlot.heightMatch && brokenSlot.nameVisible, JSON.stringify(brokenSlot));

    // Second failure on the same image: the fallback itself not resolving (a
    // stripped install). Fired synthetically because the shipped asset does
    // load - the point is that the handler stops here instead of looping.
    const degraded = await overlay.evaluate(() => {
        const cards = [...document.querySelectorAll('#p2-featured .perm-card')];
        const broken = cards.find(c => c.querySelector('.perm-name').textContent === 'Broken Art');
        const good = cards.find(c => c !== broken);
        const img = broken.querySelector('img');
        img.dispatchEvent(new Event('error'));
        const b = broken.getBoundingClientRect(), g = good.getBoundingClientRect();
        return {
            degraded: broken.classList.contains('art-missing'),
            imgHidden: getComputedStyle(broken.querySelector('img')).display === 'none',
            srcUnchanged: img.getAttribute('src') === '/images/card-back.png',
            motif: getComputedStyle(broken, '::before').backgroundImage.startsWith('url("data:image/svg+xml'),
            heightMatch: Math.abs(b.height - g.height) < 2,
            nameVisible: broken.querySelector('.perm-name').getBoundingClientRect().height > 4
        };
    });
    check('a failing fallback degrades to a placeholder that holds its cell',
        degraded.degraded && degraded.imgHidden && degraded.motif && degraded.heightMatch,
        JSON.stringify(degraded));
    check('the degraded card keeps its name and asks for nothing further',
        degraded.nameVisible && degraded.srcUnchanged, JSON.stringify(degraded));

    // Three-digit life must not spill out of the panel. Measure the INK, not the
    // box: #p2-life is a full-width block, so its own rect IS the panel's
    // content box and can never report an overflow - the old form of this check
    // could not fail. A Range over the text node gives the numeral's real
    // extents, and the negative control below proves the measurement bites.
    await emit('mtg-life-update', { player: 2, life: 137 });
    await overlay.waitForTimeout(200);
    const inkFit = () => overlay.evaluate(() => {
        const el = document.getElementById('p2-life');
        const board = document.getElementById('p2-board');
        const cs = getComputedStyle(board);
        const b = board.getBoundingClientRect();
        // Inner edge of the panel: inside the border AND the padding.
        const inner = {
            left: b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
            right: b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)
        };
        const range = document.createRange();
        range.selectNodeContents(el);
        const ink = range.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return {
            text: el.textContent,
            inkW: Math.round(ink.width),
            slack: Math.round(Math.min(ink.left - inner.left, inner.right - ink.right)),
            contained: ink.left >= inner.left - 0.5 && ink.right <= inner.right + 0.5,
            clipped: el.scrollWidth > el.clientWidth + 1,
            oneLine: ink.height <= lh * 1.5
        };
    });
    const lifeFit = await inkFit();
    check('three-digit life total still fits the panel',
        lifeFit.text === '137' && lifeFit.contained && !lifeFit.clipped && lifeFit.oneLine &&
        lifeFit.inkW > 100, JSON.stringify(lifeFit));
    // Negative control: the same measurement, on a numeral that genuinely cannot
    // fit. If this reports "contained" the check above is decoration.
    await overlay.evaluate(() => { document.getElementById('p2-life').textContent = '888888888'; });
    const lifeOverflow = await inkFit();
    check('the fit measurement actually detects an overflowing numeral',
        !lifeOverflow.contained && lifeOverflow.slack < 0 && lifeOverflow.inkW > lifeFit.inkW,
        JSON.stringify(lifeOverflow));
    await emit('mtg-life-update', { player: 2, life: 137 });
    await overlay.waitForTimeout(200);
    check('the panel recovers after the overflow probe',
        (await inkFit()).text === '137');

    // ---- 5. State legibility -------------------------------------------
    await emit('mtg-life-update', { player: 1, life: 12 });
    const popped = await overlay.waitForSelector('#p1-board .life-pop', { timeout: 3000 }).then(() => true).catch(() => false);
    check('life change fires a swing ticker', popped);
    const popVis = await visibility('#p1-board .life-pop');
    // The trap: an absolutely-positioned pop appended into an overflow:hidden
    // parent renders zero pixels and still passes a DOM-presence test.
    check('swing ticker actually renders (not clipped away)', popVis.ok, popVis.why || '');
    const popText = await overlay.evaluate(() => {
        const els = [...document.querySelectorAll('#p1-board .life-pop')];
        const el = els[els.length - 1];
        return el ? { text: el.textContent, cls: el.className, count: els.length } : null;
    });
    check('swing ticker shows a signed delta', popText && /^-5$/.test(popText.text), JSON.stringify(popText));
    // Only ever one ticker per board, so nothing can pile up over a long stream.
    check('tickers do not stack', popText && popText.count === 1, JSON.stringify(popText));
    await emit('mtg-life-update', { player: 1, life: 19 });
    await overlay.waitForTimeout(120);
    const gainCls = await overlay.evaluate(() => {
        const els = [...document.querySelectorAll('#p1-board .life-pop')];
        return els.map(e => `${e.className}|${e.textContent}`);
    });
    check('life gain reads as a gain (+7, gain colour)',
        gainCls.some(s => /gain\|\+7/.test(s)), JSON.stringify(gainCls));
    check('swing ticker cleans itself up',
        await overlay.waitForSelector('#p1-board .life-pop', { state: 'detached', timeout: 4000 }).then(() => true).catch(() => false));

    // A hydrate is not a life change: no ticker on a freshly opened overlay.
    const overlay3 = await browser.newPage();
    await overlay3.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    await overlay3.waitForFunction(() => document.getElementById('p1-life').textContent !== '20', { timeout: 6000 }).catch(() => {});
    await overlay3.waitForTimeout(300);
    check('hydrating a fresh overlay does not fire a phantom ticker',
        await overlay3.evaluate(() => document.querySelectorAll('.life-pop').length === 0));
    await overlay3.close();

    await emit('mtg-life-update', { player: 1, life: 4 });
    check('critical life pulses', await wait(() => {
        const el = document.getElementById('p1-life');
        return el.classList.contains('life-critical') && getComputedStyle(el).animationName === 'pulse';
    }));

    // Walk the tail of a real countdown. The control decrements FIRST and then
    // emits (mtg-match-control.html: `if (timerSeconds > 0) timerSeconds--; else
    // { pauseTimer(); return; }` then emit), so the overlay genuinely receives a
    // final `{ seconds: 0 }` - the red pulse has to switch itself off there and
    // not sit flashing for the rest of the stream. 500ms per step because the
    // colour is a 0.4s transition and reading it early samples mid-fade.
    const clock = [];
    for (const seconds of [300, 61, 60, 1, 0]) {
        await emit('mtg-timer-update', { seconds });
        await overlay.waitForTimeout(500);
        clock.push(await overlay.evaluate(() => {
            const el = document.getElementById('timer-text');
            const cs = getComputedStyle(el);
            return {
                text: el.textContent, flagged: el.classList.contains('expiring'),
                anim: cs.animationName, color: cs.color
            };
        }));
    }
    const [t300, t61, t60, t1, t0] = clock;
    check('above the final minute the clock is plain cyan',
        t300.text === '05:00' && !t300.flagged && t300.anim === 'none' &&
        t61.text === '01:01' && !t61.flagged && t61.anim === 'none', JSON.stringify([t300, t61]));
    check('the final minute turns the clock red and pulses',
        t60.text === '01:00' && t60.flagged && t60.anim === 'pulse' && t60.color === 'rgb(248, 113, 113)' &&
        t1.text === '00:01' && t1.flagged && t1.anim === 'pulse', JSON.stringify([t60, t1]));
    check('the pulse stops the moment the clock reaches 00:00',
        t0.text === '00:00' && !t0.flagged && t0.anim === 'none' && t0.color === 'rgb(0, 212, 255)',
        JSON.stringify(t0));

    // ...and a fresh browser source, before any duration is pushed, must not
    // come up with a red 00:00 either.
    const clockPage = await browser.newPage();
    await clockPage.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    await clockPage.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });
    await clockPage.waitForTimeout(700);
    check('a freshly loaded overlay shows 00:00 without the alarm', await clockPage.evaluate(() => {
        const el = document.getElementById('timer-text');
        const cs = getComputedStyle(el);
        return el.textContent === '00:00' && !el.classList.contains('expiring') &&
            cs.animationName === 'none' && cs.color === 'rgb(0, 212, 255)';
    }));
    await clockPage.close();

    // ---- 6. No emoji as UI icons ---------------------------------------
    const emoji = await overlay.evaluate(() => {
        const re = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
        return (document.body.innerHTML.match(re) || []).join(' ');
    });
    check('no emoji glyphs anywhere in the overlay', emoji === '', emoji);
    check('turn flags use inline SVG icons', await overlay.evaluate(() =>
        [...document.querySelectorAll('.flag-icon')].length === 4 &&
        [...document.querySelectorAll('.flag-icon')].every(el => el.querySelector('svg'))));
    const iconVis = await visibility('#p1-land-flag .flag-icon svg');
    check('flag icon renders at a real size', iconVis.ok && iconVis.rect.w >= 12, iconVis.why || JSON.stringify(iconVis.rect));

    // ---- 7. Legacy state -----------------------------------------------
    // State persisted by an older build carries only the fields that existed
    // then. Feed the renderer a deliberately threadbare payload.
    const legacy = await overlay.evaluate(() => {
        try {
            const popsBefore = document.querySelectorAll('.life-pop').length;
            renderAll({ player1: { name: 'Legacy', life: 12 }, player2: {} });
            return {
                ok: true,
                popsAdded: document.querySelectorAll('.life-pop').length - popsBefore,
                stale: [...document.querySelectorAll('.life-pop')].map(p =>
                    `${p.closest('.player-board').id}:${p.textContent}:${getComputedStyle(p).animationName}`),
                life1: document.getElementById('p1-life').textContent,
                life2: document.getElementById('p2-life').textContent,
                record: document.getElementById('p1-record').textContent,
                games: document.getElementById('p1-games').textContent,
                lands: document.getElementById('p1-lands').textContent,
                slots: document.getElementById('p1-featured').children.length,
                poison: getComputedStyle(document.getElementById('p1-poison')).display,
                format: document.getElementById('format-label').textContent,
                phase: document.getElementById('phase-text').textContent,
                flagOn: document.getElementById('p1-land-flag').classList.contains('active'),
                boardH: Math.round(document.getElementById('p1-board').getBoundingClientRect().height),
                pops: document.querySelectorAll('.life-pop').length
            };
        } catch (e) { return { ok: false, err: e.message }; }
    });
    check('state from an older build renders without throwing', legacy.ok, legacy.err || '');
    check('missing fields fall back cleanly (nothing reads "undefined")',
        legacy.life1 === '12' && legacy.life2 === '20' && legacy.record === '0-0-0' &&
        legacy.games === '0' && legacy.lands === '0' && legacy.slots === 0 &&
        legacy.poison === 'none' && legacy.format === 'Standard' && legacy.phase === 'Main 1' &&
        legacy.flagOn === false, JSON.stringify(legacy));
    check('legacy state leaves the board at its framed resting height',
        legacy.boardH === RESTING_BOARD_H, JSON.stringify(legacy));
    check('hydrating legacy state fires no swing ticker', legacy.popsAdded === 0, JSON.stringify(legacy));

    // The GRANULAR handlers, not just renderAll(). Each is fed straight off the
    // wire and each used to index blind into the cached state.
    //
    // Part A, the real wire: state persisted by an older build has no `player2`
    // key at all, and a perfectly well-formed event for player 2 then ran
    // `mtg['player2'].life = ...` and threw. Sent from one page task so the 5s
    // state replay cannot re-hydrate `mtg` underneath the test.
    pageErrors.length = 0;
    await overlay.evaluate(() => {
        mtg = { player1: { name: 'Legacy', life: 12 }, activePlayer: 1, matchFormat: 'Standard' };
        const d = window.__drv;
        d.emit('mtg-life-update', { player: 2, life: 5 });
        d.emit('mtg-lands-update', { player: 2, lands: 3 });
        d.emit('mtg-poison-update', { player: 2, poison: 2 });
        d.emit('mtg-player-name-update', { player: 2, name: 'Wire' });
        d.emit('mtg-player-record-update', { player: 2, record: '1-1-0' });
        d.emit('mtg-games-won-update', { player: 2, gamesWon: 1 });
        d.emit('mtg-turn-action', { player: 2, action: 'landPlayed', value: true });
    });
    const wired = await wait(() =>
        document.getElementById('p2-life').textContent === '5' &&
        document.getElementById('p2-lands').textContent === '3' &&
        document.getElementById('p2-name').textContent === 'Wire' &&
        document.getElementById('p2-record').textContent === '1-1-0' &&
        document.getElementById('p2-games').textContent === '1' &&
        document.getElementById('p2-land-flag').classList.contains('active'));
    check('granular events for a player missing from saved state do not throw',
        pageErrors.length === 0, pageErrors.join(' | '));
    check('...and every one of them still lands on the board', wired);
    check('the absent player slice is created rather than written through',
        await overlay.evaluate(() => !!mtg && !!mtg.player2 &&
            mtg.player2.life === 5 && mtg.player2.lands === 3 && mtg.player2.name === 'Wire'));

    // Part B, short payloads. Deliberately NOT emitted through the server: the
    // server's own handlers index the payload too (`mtgMatch['player' +
    // data.player]`), so a malformed emit would take down a process this harness
    // may be sharing. Dispatch the overlay's own registered listeners instead -
    // the exact functions the wire calls - from a timer, so anything they throw
    // escapes as an uncaught page error rather than being swallowed by this
    // evaluate's own frame.
    // ('toggle-mtg-match' is excluded on purpose: an empty payload there
    //  legitimately means "hide", which would blank the board for every check
    //  after this one.)
    const GRANULAR = [
        'mtg-life-update', 'mtg-poison-update', 'mtg-lands-update',
        'mtg-permanent-added', 'mtg-permanent-removed', 'mtg-phase-update',
        'mtg-player-name-update', 'mtg-record-update', 'mtg-games-won-update',
        'mtg-turn-actions-update', 'mtg-player-switch', 'mtg-format-update',
        'mtg-timer-update'
    ];
    pageErrors.length = 0;
    const fuzz = await overlay.evaluate((events) => {
        mtg = { player1: { name: 'Legacy', life: 12 } }; // no player2, no fields
        const shapes = [undefined, null, {}, { player: 1 }, { player: 2 },
                        { player: 9, life: 1 }, { player: null }, { player: '2' }];
        let dispatched = 0;
        const missing = [];
        for (const ev of events) {
            const listeners = socket.listeners(ev);
            if (!listeners.length) { missing.push(ev); continue; }
            for (const shape of shapes) {
                for (const fn of listeners) { setTimeout(() => fn(shape), 0); dispatched++; }
            }
        }
        return { dispatched, missing };
    }, GRANULAR);
    await overlay.waitForTimeout(600);
    check('every granular event still has a handler registered',
        fuzz.missing.length === 0 && fuzz.dispatched === GRANULAR.length * 8, JSON.stringify(fuzz));
    check('empty and short payloads never throw in a granular handler',
        pageErrors.length === 0, `${pageErrors.length} page error(s): ${pageErrors.join(' | ')}`);
    const survived = await overlay.evaluate(() => ({
        life1: document.getElementById('p1-life').textContent,
        life2: document.getElementById('p2-life').textContent,
        lands2: document.getElementById('p2-lands').textContent,
        format: document.getElementById('format-label').textContent,
        phase: document.getElementById('phase-text').textContent,
        turn: document.getElementById('turn-text').textContent,
        visible: !document.getElementById('p1-board').classList.contains('ov-hidden'),
        undefinedOnScreen: /undefined/i.test(document.body.innerText)
    }));
    check('a payload with nothing in it renders nothing, rather than blanking a live board',
        survived.life1 === '12' && survived.life2 === '5' && survived.lands2 === '3' &&
        survived.format === 'Standard' && survived.phase === 'Main 1' &&
        survived.visible && !survived.undefinedOnScreen, JSON.stringify(survived));

    // ---- 8. Nothing moved ----------------------------------------------
    // Captured from the overlay before the polish pass (scripts/geom-mtg-match.mjs).
    const BEFORE = {
        p1board: { x: 40, y: 60, w: 420 },
        p1life: { x: 65, y: 191, w: 370, h: 109 },
        p1lands: { x: 72, y: 349, w: 165, h: 36 },
        p1landFlag: { x: 65, y: 410, w: 179, h: 40 },
        p1title: { x: 65, y: 464, w: 370, h: 16 },
        p1name: { x: 65, y: 85 },
        p1record: { x: 364, y: 87, w: 71, h: 28 },
        matchBar: { x: 640, y: 962, w: 640, h: 70 },
        timer: { x: 819, y: 978, w: 102, h: 38 }
    };
    await emit('mtg-match-reset', {});
    await emit('mtg-player-name-update', { player: 1, name: 'Player 1' });
    await emit('mtg-format-update', { format: 'Standard' });
    await emit('mtg-phase-update', { phase: 'main1' });
    await emit('mtg-player-switch', { activePlayer: 1 });
    await overlay.waitForTimeout(500);

    check('board position and width unchanged', sameRect(await rect('#p1-board'), BEFORE.p1board, ['x', 'y', 'w']));
    check('life headline unchanged', sameRect(await rect('#p1-life'), BEFORE.p1life));
    check('stat strip unchanged', sameRect(await rect('#p1-lands'), BEFORE.p1lands));
    check('turn flags keep their box (icons did not grow them)', sameRect(await rect('#p1-land-flag'), BEFORE.p1landFlag));
    check('section title unchanged', sameRect(await rect('#p1-board .section-title'), BEFORE.p1title));
    check('player name still starts in the same place', sameRect(await rect('#p1-name'), BEFORE.p1name, ['x', 'y']));
    check('record chip unchanged', sameRect(await rect('#p1-record'), BEFORE.p1record));
    check('match bar unchanged', sameRect(await rect('.match-bar'), BEFORE.matchBar));
    check('timer unchanged', sameRect(await rect('#timer-text'), BEFORE.timer));
    const restingBoards = await overlay.evaluate(() => {
        const a = document.getElementById('p1-board').getBoundingClientRect();
        const b = document.getElementById('p2-board').getBoundingClientRect();
        return { ah: Math.round(a.height), bh: Math.round(b.height), sameTop: a.top === b.top };
    });
    check('both boards rest at the same framed height',
        restingBoards.ah === restingBoards.bh && restingBoards.sameTop &&
        restingBoards.ah === RESTING_BOARD_H, JSON.stringify(restingBoards));
} catch (err) {
    check('harness ran without throwing', false, err.stack || err.message);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
