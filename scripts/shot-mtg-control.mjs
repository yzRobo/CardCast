// Screenshot the MTG match control in a representative state.
//   node scripts/shot-mtg-control.mjs [outPath]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/mtg-control.png';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    browser = await chromium.launch();
    // Open an overlay so the control's status badge reads Connected.
    const overlay = await browser.newPage();
    await overlay.goto(`${BASE}/mtg-match`, { waitUntil: 'domcontentloaded' });

    const page = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
    await page.goto(`${BASE}/mtg-match-control`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('overlayStatus').textContent.includes('Overlay Connected'), { timeout: 8000 });

    await page.fill('#p1-name', 'Liliana');
    await page.dispatchEvent('#p1-name', 'change');
    await page.fill('#p1-record', '2-1-0');
    await page.dispatchEvent('#p1-record', 'change');
    await page.click('button[onclick="adjustLife(1, -5)"]');
    await page.click('button[onclick="adjustLife(1, -5)"]');
    for (let i = 0; i < 5; i++) await page.click('button[onclick="adjustLands(1, 1)"]');
    await page.check('#p1-land-played');
    await page.click('.phase-btn[data-phase="combat"]');
    await page.click('#set-active-p1');

    await page.fill('#p2-name', 'Chandra');
    await page.dispatchEvent('#p2-name', 'change');
    await page.click('button[onclick="adjustLife(2, -5)"]');
    for (let i = 0; i < 6; i++) await page.click('button[onclick="adjustPoison(2, 1)"]');

    await page.waitForTimeout(400);
    await page.screenshot({ path: OUT, fullPage: true });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
