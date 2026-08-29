// Screenshot the One Piece match overlay. Pushes state via a driver socket,
// drops a dark backdrop (OBS sits over a scene), and writes a PNG.
//   node scripts/shot-onepiece-match.mjs [outPath] [full|empty]
// "empty" captures the cold-start board a producer sees before placing cards.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/onepiece-overlay.png';
const SCENARIO = process.argv[3] || 'full';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

// Pull real cards so the board looks like a real game rather than placeholders.
async function card(query, kind) {
    const res = await (await fetch(`${BASE}/api/search/onepiece?q=${encodeURIComponent(query)}`)).json();
    const hit = (res || []).find(c => (c.card_type || '').toLowerCase().includes(kind)) || (res || [])[0];
    if (!hit) return null;
    const full = await (await fetch(`${BASE}/api/card/onepiece/${hit.id}`)).json();
    return {
        id: full.id,
        name: full.name,
        image: full.display_image || full.image_url || full.local_image || '',
        power: parseInt(full.op_power) || 0,
        counter: parseInt(full.counter) || 0,
        colors: full.colors || '',
        life: parseInt(full.life) || null,
        donAttached: 0
    };
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    const [p1Leader, p2Leader, c1, c2, c3, c4, stage] = SCENARIO === 'empty'
        ? [null, null, null, null, null, null, null]
        : await Promise.all([
            card('Monkey.D.Luffy', 'leader'),
            card('Roronoa Zoro', 'leader'),
            card('Nami', 'character'),
            card('Usopp', 'character'),
            card('Sanji', 'character'),
            card('Jinbe', 'character'),
            card('Thousand Sunny', 'stage')
        ]);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/onepiece-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    // The overlay asks the server for stored state 500ms after load, and that
    // reply carries the server's own (stale) timer. Push after it lands.
    await page.waitForTimeout(1500);
    await emit('toggle-onepiece-match', { show: true });

    const blank = (name) => ({
        name, record: { wins: 0, losses: 0, ties: 0 }, gamesWon: 0,
        leader: null, life: { total: 4, taken: [] }, don: { active: 0, rested: 0, max: 10 },
        characters: [null, null, null, null, null], stage: null
    });

    const p1Life = p1Leader && p1Leader.life ? p1Leader.life : 5;
    const p1 = SCENARIO === 'empty' ? blank('Player 1') : {
        name: 'Henry Thompson',
        record: { wins: 6, losses: 1, ties: 1 }, gamesWon: 1,
        leader: p1Leader,
        // One Life left: shows the critical pulse and the last-card emphasis.
        life: { total: p1Life, taken: Array.from({ length: Math.max(0, p1Life - 1) }, (_, i) => i) },
        don: { active: 4, rested: 3, max: 10 },
        characters: [
            c1 ? { ...c1, donAttached: 2 } : null,
            c2 ? { ...c2 } : null,
            null,
            c4 ? { ...c4, donAttached: 1 } : null,
            null
        ],
        stage
    };
    const p2 = SCENARIO === 'empty' ? blank('Player 2') : {
        name: 'Nathan Spry',
        record: { wins: 5, losses: 2, ties: 0 }, gamesWon: 0,
        leader: p2Leader,
        life: { total: p2Leader && p2Leader.life ? p2Leader.life : 5, taken: [0] },
        don: { active: 7, rested: 0, max: 10 },
        characters: [c3 ? { ...c3 } : null, null, c1 ? { ...c1, donAttached: 1 } : null, null, null],
        stage: null
    };

    await emit('onepiece-match-update', { player1: p1, player2: p2, currentTurn: 1, gameNumber: 2, matchFormat: 'Best of 3' });
    await page.waitForTimeout(2200);
    // The overlay re-registers every 5s and the server answers with its stored
    // state, which does not carry turn or clock. Set those last so the frame is
    // the same no matter where that ping lands.
    await emit('turn-switch', { currentTurn: 1 });
    await emit('timer-set', { minutes: 27, seconds: 14 });
    await page.waitForTimeout(600);
    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
