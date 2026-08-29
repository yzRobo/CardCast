// Screenshot the Disney Lorcana match overlay. Pushes state via a driver
// socket, drops a dark backdrop (OBS sits over a scene), and writes a PNG.
//   node scripts/shot-lorcana-match.mjs [outPath] [full|empty|stress]
// "empty"  captures the cold-start board a producer sees before placing cards.
// "stress" fills every slot with the longest plausible values, which is where
//          the fixed 1010px board height and the narrow cells actually bite.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/lorcana-overlay.png';
const SCENARIO = process.argv[3] || 'full';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

// Pull real cards so the board looks like a real game rather than placeholders.
async function find(query, type) {
    const res = await (await fetch(`${BASE}/api/search/lorcana?q=${encodeURIComponent(query)}`)).json();
    const hits = (res || []).filter(c => (c.card_type || '').toLowerCase().includes(type));
    return hits;
}
const toChar = (c) => ({
    id: c.id, name: c.name, image: c.display_image || c.image_url || c.local_image || '',
    strength: c.strength || 0, willpower: c.willpower || 0, lore: c.lore_value || 0,
    colors: c.colors || '', damage: 0, exerted: false
});
const toLoc = (c) => ({
    id: c.id, name: c.name, image: c.display_image || c.image_url || c.local_image || '',
    willpower: c.willpower || 0, lore: c.lore_value || 0
});

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    let chars = [], locs = [], items = [];
    if (SCENARIO !== 'empty') {
        for (const q of ['Elsa', 'Mickey Mouse', 'Maleficent', 'Stitch', 'Belle']) {
            chars = chars.concat((await find(q, 'character')).slice(0, 2));
            if (chars.length >= 8) break;
        }
        for (const q of ['Forbidden Mountain', 'Castle', 'Tundra']) {
            locs = locs.concat((await find(q, 'location')).slice(0, 2));
            if (locs.length >= 4) break;
        }
        for (const q of ['Dinglehopper', 'Pawpsicle', 'Lantern']) {
            items = items.concat((await find(q, 'item')).slice(0, 1));
            if (items.length >= 3) break;
        }
    }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/lorcana-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    await emit('toggle-lorcana-match', { show: true });
    await emit('lorcana-match-reset', {});

    const blank = (name) => ({
        name, record: { wins: 0, losses: 0, ties: 0 }, gamesWon: 0,
        lore: 0, loreGoal: 20, ink: { available: 0, total: 0 },
        characters: [null, null, null, null, null, null], locations: [null, null, null], items: []
    });

    let p1, p2;
    if (SCENARIO === 'empty') {
        p1 = blank('Player 1');
        p2 = blank('Player 2');
    } else if (SCENARIO === 'stress') {
        const c = chars.map(toChar);
        const six = (seed) => Array.from({ length: 6 }, (_, i) => {
            const base = c[(i + seed) % Math.max(1, c.length)];
            if (!base) return null;
            return { ...base, strength: 10, willpower: 12, lore: 4, damage: i % 2 ? 11 : 3, exerted: i % 3 === 0 };
        });
        const bigLoc = (i) => (locs[i % Math.max(1, locs.length)]
            ? { ...toLoc(locs[i % locs.length]), name: 'The Forbidden Mountain - Maleficent’s Dread Castle', willpower: 10, lore: 3 }
            : null);
        p1 = {
            ...blank('Bartholomew Fitzwilliam-Cavendish III'),
            record: { wins: 12, losses: 11, ties: 3 }, gamesWon: 2,
            lore: 19, ink: { available: 13, total: 20 },
            characters: six(0), locations: [bigLoc(0), bigLoc(1), bigLoc(2)],
            items: Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, name: `Extremely Long Item Name ${i}` }))
        };
        p2 = {
            ...blank('Wilhelmina Ravensbourne-Thackeray'),
            record: { wins: 10, losses: 12, ties: 4 }, gamesWon: 2,
            lore: 19, ink: { available: 0, total: 17 },
            characters: six(3), locations: [bigLoc(1), bigLoc(2), bigLoc(0)],
            items: Array.from({ length: 3 }, (_, i) => ({ id: `j${i}`, name: `Item ${i}` }))
        };
    } else {
        const c = chars.map(toChar);
        // A believable mid-game board: some exerted, some damaged, one nearly banished.
        const p1Chars = [c[0] || null, c[1] || null, c[2] || null, null, null, null];
        if (p1Chars[0]) { p1Chars[0].exerted = true; p1Chars[0].damage = 1; }
        if (p1Chars[2]) { p1Chars[2].damage = Math.max(0, (p1Chars[2].willpower || 3) - 1); }
        const p2Chars = [c[3] || null, c[4] || null, null, c[5] || null, null, null];
        if (p2Chars[1]) { p2Chars[1].damage = Math.floor((p2Chars[1].willpower || 4) / 2); }

        p1 = {
            ...blank('Charlotte Wetherington'),
            record: { wins: 5, losses: 1, ties: 0 }, gamesWon: 1,
            lore: 18, ink: { available: 3, total: 7 },
            characters: p1Chars,
            locations: [locs[0] ? toLoc(locs[0]) : null, null, null],
            items: items.slice(0, 2).map(i => ({ id: i.id, name: i.name }))
        };
        p2 = {
            ...blank('Reginald Ashworth-Pemberton'),
            record: { wins: 4, losses: 2, ties: 0 }, gamesWon: 1,
            lore: 11, ink: { available: 6, total: 9 },
            characters: p2Chars,
            locations: [locs[1] ? toLoc(locs[1]) : null, locs[2] ? toLoc(locs[2]) : null, null],
            items: []
        };
    }

    await emit('lorcana-match-update', { player1: p1, player2: p2, currentTurn: 1, gameNumber: 3, matchFormat: 'Best of 3' });

    // The overlay asks the server for current state 500ms after load, and that
    // reply carries the server's stored 50:00 clock - so the timer has to be set
    // after that lands or it is silently overwritten.
    await page.waitForTimeout(1200);
    await emit('turn-switch', { currentTurn: 1 });
    await emit('timer-set', { minutes: 21, seconds: 47 });
    await page.waitForFunction(() => document.getElementById('matchTimer').textContent === '21:47', { timeout: 5000 });

    await page.waitForTimeout(2000);
    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
