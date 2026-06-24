// Screenshot the MTG match overlay in a representative populated state.
// Pushes state via a driver socket, drops a dark backdrop (OBS sits over a
// scene), and writes a PNG.   node scripts/shot-mtg-match.mjs [outPath]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/mtg-overlay.png';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    // Grab two real card images so the featured row looks real.
    const search = await (await fetch(`${BASE}/api/search/magic?q=bolt`)).json();
    const cards = (search || []).slice(0, 2).map(c => ({ id: c.id, name: c.name, image_url: c.image_url || c.local_image || '' }));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('connection-status').textContent === 'Connected', { timeout: 8000 });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    await emit('mtg-player-name-update', { player: 1, name: 'Liliana' });
    await emit('mtg-player-record-update', { player: 1, record: '2-1-0' });
    await emit('mtg-games-won-update', { player: 1, gamesWon: 1 });
    await emit('mtg-life-update', { player: 1, life: 14 });
    await emit('mtg-lands-update', { player: 1, lands: 5 });
    await emit('mtg-turn-action', { player: 1, action: 'landPlayed', value: true });
    await emit('mtg-turn-action', { player: 1, action: 'spellCast', value: true });

    await emit('mtg-player-name-update', { player: 2, name: 'Chandra' });
    await emit('mtg-player-record-update', { player: 2, record: '2-2-0' });
    await emit('mtg-life-update', { player: 2, life: 7 });
    await emit('mtg-poison-update', { player: 2, poison: 6 });
    await emit('mtg-lands-update', { player: 2, lands: 6 });
    for (const c of cards) await emit('mtg-permanent-add', { player: 2, card: c });

    await emit('mtg-phase-update', { phase: 'combat' });
    await emit('mtg-format-update', { format: 'Standard' });
    await emit('mtg-timer-update', { seconds: 1495 });
    await emit('mtg-player-switch', { activePlayer: 1 });

    await page.waitForTimeout(700);
    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
