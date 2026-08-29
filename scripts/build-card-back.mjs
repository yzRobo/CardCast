// Render public/images/card-back.png, the fallback art every overlay and
// control page points at when a card image fails to load.
//
// It has to actually exist: the fallback is wired as `onerror="this.src=..."`,
// so if the fallback itself 404s the error handler re-fires against the same
// URL forever - measured at ~6000 requests in 5 seconds on a browser source
// meant to run unattended for hours.
//
//   node scripts/build-card-back.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const OUT_DIR = path.join(process.cwd(), 'public', 'images');
const OUT = path.join(OUT_DIR, 'card-back.png');

// Standard trading-card ratio (5:7), sized for the largest slot any overlay
// renders so it never scales up.
const W = 420;
const H = 588;

const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .card {
    width: ${W}px; height: ${H}px;
    box-sizing: border-box;
    border-radius: 26px;
    background:
      radial-gradient(ellipse at 50% 34%, rgba(99,102,241,0.30) 0%, transparent 62%),
      linear-gradient(150deg, #1b2140 0%, #12162c 46%, #0a0d1c 100%);
    border: 10px solid #0b0f1e;
    box-shadow: inset 0 0 0 2px rgba(148,163,184,0.22);
    display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
  }
  /* Quiet diagonal weave so the back does not read as a flat colour block. */
  .card::before {
    content: ''; position: absolute; inset: 0;
    background:
      repeating-linear-gradient(45deg, rgba(255,255,255,0.030) 0 2px, transparent 2px 15px),
      repeating-linear-gradient(-45deg, rgba(255,255,255,0.030) 0 2px, transparent 2px 15px);
  }
  .frame {
    position: absolute; inset: 26px;
    border: 2px solid rgba(148,163,184,0.24);
    border-radius: 16px;
  }
  .mark { position: relative; width: 190px; height: 190px; opacity: 0.92; }
</style>
<div class="card">
  <div class="frame"></div>
  <svg class="mark" viewBox="0 0 100 100" fill="none">
    <!-- Three fanned cards: reads as "a card" at any size, and stays neutral
         across all seven games rather than favouring one. -->
    <g stroke="#94a3b8" stroke-width="3.2" stroke-linejoin="round">
      <rect x="22" y="26" width="38" height="52" rx="5"
            fill="rgba(99,102,241,0.16)" transform="rotate(-16 41 52)"/>
      <rect x="31" y="24" width="38" height="52" rx="5"
            fill="rgba(99,102,241,0.22)" transform="rotate(-2 50 50)"/>
      <rect x="40" y="26" width="38" height="52" rx="5"
            fill="rgba(99,102,241,0.28)" transform="rotate(14 59 52)"/>
    </g>
    <circle cx="59" cy="52" r="7.5" fill="none" stroke="#c7d2fe" stroke-width="3.2"/>
  </svg>
</div>`;

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.locator('.card').screenshot({ path: OUT, omitBackground: true });
    console.log('wrote', OUT, `(${W}x${H})`);
} finally {
    await browser.close();
}
