// Cross-game server-side checks for the overlay layer. These cover behaviour
// that is shared by every game, so a per-game verify script cannot see it.
//   node scripts/verify-overlay-server.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? ' -> ' + detail : ''}`); }
};

// The turn replayed to a re-registering overlay, for one game.
const replayedTurn = (page, game) => page.evaluate(gameName => new Promise(resolve => {
    const socket = window.__drv;
    const handler = data => { socket.off(`${gameName}-match-update`, handler); resolve(data && data.currentTurn); };
    socket.on(`${gameName}-match-update`, handler);
    socket.emit('register-overlay', `${gameName}-match`);
    setTimeout(() => resolve('no-reply'), 4000);
}), game);

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    console.log('\nFallback card art');
    // Every overlay and control page wires this as an onerror target. If it
    // 404s, the handler re-fires against the same URL in a tight loop.
    const res = await fetch(`${BASE}/images/card-back.png`);
    check('/images/card-back.png is served', res.ok, `status ${res.status}`);
    check('fallback art is a real PNG', (res.headers.get('content-type') || '').includes('image/png'));
    const bytes = (await res.arrayBuffer()).byteLength;
    check('fallback art is non-empty', bytes > 1000, `${bytes} bytes`);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/pokemon-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });

    console.log('\nA broken card image does not loop the fallback');
    const requests = [];
    page.on('request', r => { if (r.url().includes('card-back.png')) requests.push(r.url()); });
    await page.evaluate(() => {
        const img = document.createElement('img');
        img.onerror = function () { this.src = '/images/card-back.png'; };
        img.src = '/images/definitely-missing-card.png';
        img.style.display = 'none';
        document.body.appendChild(img);
    });
    await page.waitForTimeout(3000);
    check('fallback requested a bounded number of times', requests.length <= 3, `${requests.length} requests in 3s`);

    console.log('\nturn-switch is persisted, not just relayed');
    // Without persistence the stored turn stays at its default and the 5s
    // re-registration replay silently reverts the active-player emphasis.
    const games = ['yugioh', 'onepiece', 'lorcana', 'digimon', 'gundam'];
    for (const turn of [2, 1]) {
        await page.evaluate(t => window.__drv.emit('turn-switch', { currentTurn: t }), turn);
        await page.waitForTimeout(300);
        for (const game of games) {
            const got = await replayedTurn(page, game);
            check(`${game} replays currentTurn ${turn} after a switch`, got === turn, String(got));
        }
    }

    console.log('\nA malformed turn-switch is ignored rather than stored');
    await page.evaluate(() => window.__drv.emit('turn-switch', { currentTurn: 1 }));
    await page.waitForTimeout(250);
    for (const bad of [undefined, null, 0, 3, 'two', {}]) {
        await page.evaluate(v => window.__drv.emit('turn-switch', { currentTurn: v }), bad);
    }
    await page.waitForTimeout(300);
    check('bad currentTurn values leave the stored turn intact', await replayedTurn(page, 'lorcana') === 1);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
