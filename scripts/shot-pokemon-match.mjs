// Screenshot the Pokemon match overlay. Pushes state via a driver socket,
// drops a dark backdrop (OBS sits over a scene), and writes a PNG.
//   node scripts/shot-pokemon-match.mjs [outPath] [full|empty]
// "empty" captures the cold-start board a producer sees before placing cards.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/pokemon-overlay.png';
const SCENARIO = process.argv[3] || 'full';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

// Pull real cards so the board looks like a real game rather than placeholders.
async function card(query) {
    const res = await (await fetch(`${BASE}/api/search/pokemon?q=${encodeURIComponent(query)}`)).json();
    const hit = (res || []).find(c => c.hp) || (res || [])[0];
    if (!hit) return null;
    const full = await (await fetch(`${BASE}/api/card/pokemon/${hit.id}`)).json();
    return {
        id: full.id,
        name: full.name,
        image: full.display_image || full.image_url || full.local_image || '',
        maxHp: parseInt(full.hp) || 100,
        currentHp: parseInt(full.hp) || 100,
        stage: full.stage || null,
        abilityName: full.ability_name || null,
        attacks: [
            full.attack1_name ? { name: full.attack1_name, cost: full.attack1_cost, damage: full.attack1_damage } : null,
            full.attack2_name ? { name: full.attack2_name, cost: full.attack2_cost, damage: full.attack2_damage } : null
        ].filter(Boolean)
    };
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    const [p1Active, p1Bench1, p1Bench2, p2Active, p2Bench1, tool] = SCENARIO === 'empty'
        ? [null, null, null, null, null, null]
        : await Promise.all([
            card('Charizard ex'), card('Pidgeot ex'), card('Rotom'),
            card('Gardevoir ex'), card('Ralts'), card('Bravery Charm')
        ]);
    if (tool) delete tool.attacks;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/pokemon-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    await emit('toggle-pokemon-match', { show: true });

    const p1 = SCENARIO === 'empty' ? {
        name: 'Player 1', prizes: 6, prizesTaken: [], benchSize: 5, active: null, bench: [],
        record: { wins: 0, losses: 0, ties: 0 }, matchScore: 0,
        turnActions: { energy: false, supporter: false, retreat: false }
    } : {
        name: 'Henry Thompson', prizes: 3, prizesTaken: [0, 1, 2], benchSize: 5,
        active: p1Active ? { ...p1Active, currentHp: Math.round(p1Active.maxHp * 0.42), tools: tool ? [{ id: tool.id, name: tool.name, image: tool.image }] : [] } : null,
        bench: [p1Bench1, p1Bench2].filter(Boolean),
        record: { wins: 6, losses: 1, ties: 1 }, matchScore: 1,
        turnActions: { energy: true, supporter: true, retreat: false }
    };
    const p2 = SCENARIO === 'empty' ? {
        name: 'Player 2', prizes: 6, prizesTaken: [], benchSize: 5, active: null, bench: [],
        record: { wins: 0, losses: 0, ties: 0 }, matchScore: 0,
        turnActions: { energy: false, supporter: false, retreat: false }
    } : {
        name: 'Nathan Spry', prizes: 5, prizesTaken: [0], benchSize: 5,
        active: p2Active ? { ...p2Active, currentHp: p2Active.maxHp } : null,
        bench: [p2Bench1].filter(Boolean),
        record: { wins: 6, losses: 1, ties: 1 }, matchScore: 0,
        turnActions: { energy: false, supporter: false, retreat: false }
    };

    await emit('pokemon-match-update', { player1: p1, player2: p2, currentTurn: 1, gameNumber: 2, matchFormat: 'Best of 3' });
    await emit('active-pokemon', { player: 1, pokemon: p1.active });
    await emit('active-pokemon', { player: 2, pokemon: p2.active });
    await emit('bench-update', { player: 1, bench: p1.bench });
    await emit('bench-update', { player: 2, bench: p2.bench });
    await emit('turn-actions-update', { player: 1, actions: p1.turnActions });
    await emit('turn-switch', { currentTurn: 1 });
    await emit('timer-set', { minutes: 27, seconds: 14 });

    await page.waitForTimeout(2500);
    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
