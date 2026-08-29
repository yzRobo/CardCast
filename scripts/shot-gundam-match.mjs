// Screenshot the Gundam match overlay. Pushes state via a driver socket,
// drops a dark backdrop (OBS sits over a scene), and writes a PNG.
//   node scripts/shot-gundam-match.mjs [outPath] [full|empty]
// "empty" captures the cold-start board a producer sees before placing cards.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/gundam-overlay.png';
const SCENARIO = process.argv[3] || 'full';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

// Pull real cards so the board looks like a real game rather than placeholders.
// The Gundam DB has no free-text type filter, so scan a few set codes and bucket
// the results by card_type the same way the control page does.
async function discover() {
    const found = { units: [], pilots: [], bases: [] };
    for (const q of ['GD01', 'ST01', 'ST02', 'EB01', 'GD02']) {
        let arr = [];
        try { arr = await (await fetch(`${BASE}/api/search/gundam?q=${q}`)).json(); } catch { arr = []; }
        for (const c of arr) {
            const t = (c.card_type || '').toUpperCase();
            const img = c.display_image || c.image_url || c.local_image || '';
            if (!img) continue;
            if (t.includes('UNIT') && c.gd_ap != null && c.gd_hp != null && found.units.length < 8) {
                found.units.push({ id: c.id, name: c.name, image: img, ap: parseInt(c.gd_ap) || 0, maxHp: parseInt(c.gd_hp) || 1 });
            } else if (t.includes('PILOT') && found.pilots.length < 4) {
                found.pilots.push({ name: c.name, image: img });
            } else if (t.includes('BASE') && found.bases.length < 3) {
                found.bases.push({ id: c.id, name: c.name, image: img, maxHp: parseInt(c.gd_hp) || 5 });
            }
        }
        if (found.units.length >= 6 && found.pilots.length >= 2 && found.bases.length >= 2) break;
    }
    return found;
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    const cards = SCENARIO === 'empty' ? { units: [], pilots: [], bases: [] } : await discover();
    const unit = i => cards.units[i % Math.max(1, cards.units.length)] || null;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/gundam-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    await emit('toggle-gundam-match', { show: true });
    // The overlay asks the server for state 500ms after load; let that land
    // first so the capture never races the reply.
    await page.waitForTimeout(900);

    const fresh = (name) => ({
        name, record: { wins: 0, losses: 0, ties: 0 }, gamesWon: 0,
        shields: 6, shieldsTaken: [], resources: { active: 0, total: 0, ex: false },
        units: [null, null, null, null, null, null], base: null
    });

    let p1, p2;
    if (SCENARIO === 'empty') {
        p1 = fresh('Player 1');
        p2 = fresh('Player 2');
    } else {
        const u = i => {
            const c = unit(i);
            return c ? { ...c, currentHp: c.maxHp } : null;
        };
        p1 = {
            name: 'Amuro Ray', record: { wins: 5, losses: 1, ties: 0 }, gamesWon: 1,
            shields: 4, shieldsTaken: [0, 1], resources: { active: 3, total: 6, ex: true },
            units: [
                u(0) ? { ...u(0), currentHp: Math.max(1, Math.round(u(0).maxHp * 0.4)), pilot: cards.pilots[0] || null } : null,
                u(1),
                null,
                u(2) ? { ...u(2), currentHp: Math.max(1, u(2).maxHp - 1) } : null,
                null,
                null
            ],
            base: cards.bases[0] ? { ...cards.bases[0], currentHp: Math.max(1, cards.bases[0].maxHp - 2) } : null
        };
        p2 = {
            name: 'Char Aznable', record: { wins: 5, losses: 1, ties: 0 }, gamesWon: 0,
            shields: 5, shieldsTaken: [0], resources: { active: 5, total: 5, ex: false },
            units: [
                u(3) ? { ...u(3), pilot: cards.pilots[1] || cards.pilots[0] || null } : null,
                null,
                u(4),
                null,
                u(5) ? { ...u(5), currentHp: 1 } : null,
                null
            ],
            base: cards.bases[1] || cards.bases[0] || null
        };
    }

    await emit('gundam-match-update', { player1: p1, player2: p2, currentTurn: 1, gameNumber: 2, matchFormat: 'Best of 3' });
    await emit('turn-switch', { currentTurn: 1 });
    await emit('timer-set', { minutes: 27, seconds: 14 });

    await page.waitForTimeout(2600);
    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
