// Screenshot the Digimon match overlay. Pushes state via a driver socket,
// drops a dark backdrop (OBS sits over a scene), and writes a PNG.
//   node scripts/shot-digimon-match.mjs [outPath] [full|empty]
// "empty" captures the cold-start board a producer sees before placing cards.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/digimon-overlay.png';
const SCENARIO = process.argv[3] || 'full';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

// Pull real cards so the board looks like a real game rather than placeholders.
// `want` filters by card_type so a Tamer query cannot come back as a Digimon.
async function card(query, want = 'digimon') {
    const res = await (await fetch(`${BASE}/api/search/digimon?q=${encodeURIComponent(query)}`)).json();
    const list = res || [];
    const hit = list.find(c => (c.card_type || '').toLowerCase().includes(want)) || list[0];
    if (!hit) return null;
    const full = await (await fetch(`${BASE}/api/card/digimon/${hit.id}`)).json();
    return {
        id: full.id,
        name: full.name,
        image: full.display_image || full.image_url || full.local_image || '',
        dp: full.dp || 0,
        level: full.digimon_level || 0,
        colors: full.colors || '',
        stack: 1
    };
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    const empty = SCENARIO === 'empty';
    const [wg, gg, bg, egg, tamer, mg, gm, tamer2] = empty
        ? [null, null, null, null, null, null, null, null]
        : await Promise.all([
            card('WarGreymon'), card('Greymon'), card('BlackWarGreymon'),
            card('Koromon', 'egg'), card('Tai Kamiya', 'tamer'),
            card('MetalGarurumon'), card('Garurumon'), card('Matt Ishida', 'tamer')
        ]);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/digimon-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    // The overlay fires its own `request-state` 500ms after load; pushing our
    // scenario before that lands would let the server's stored state overwrite it.
    await page.waitForTimeout(1400);

    await emit('toggle-digimon-match', { show: true });
    await emit('digimon-match-reset', {});

    const p1 = empty
        ? { name: 'Player 1', record: { wins: 0, losses: 0, ties: 0 }, gamesWon: 0, security: 5, securityTaken: [], battle: [null, null, null, null, null, null], breeding: null, tamers: [], counts: { hand: 0, deck: 0, trash: 0, eggDeck: 0 } }
        : {
            name: 'Takeru Aizawa', record: { wins: 5, losses: 1, ties: 0 }, gamesWon: 1,
            security: 2, securityTaken: [0, 1, 2],
            battle: [wg ? { ...wg, stack: 3 } : null, gg, null, bg, null, null],
            breeding: egg,
            tamers: tamer ? [{ id: tamer.id, name: tamer.name, image: tamer.image }] : [],
            counts: { hand: 4, deck: 31, trash: 12, eggDeck: 3 }
        };
    const p2 = empty
        ? { name: 'Player 2', record: { wins: 0, losses: 0, ties: 0 }, gamesWon: 0, security: 5, securityTaken: [], battle: [null, null, null, null, null, null], breeding: null, tamers: [], counts: { hand: 0, deck: 0, trash: 0, eggDeck: 0 } }
        : {
            name: 'Yamato Ishikawa', record: { wins: 5, losses: 1, ties: 0 }, gamesWon: 0,
            security: 4, securityTaken: [0],
            battle: [mg, null, gm, null, null, null],
            breeding: null,
            tamers: tamer2 ? [{ id: tamer2.id, name: tamer2.name, image: tamer2.image }] : [],
            counts: { hand: 6, deck: 28, trash: 9, eggDeck: 4 }
        };

    await emit('digimon-match-update', {
        memory: empty ? 0 : -4, player1: p1, player2: p2,
        currentTurn: 1, gameNumber: 2, matchFormat: 'Best of 3'
    });
    // Push through the granular events too, so the per-slot render paths run.
    for (let i = 0; i < 6; i++) {
        await emit('digimon-battle-update', { player: 1, index: i, unit: p1.battle[i] });
        await emit('digimon-battle-update', { player: 2, index: i, unit: p2.battle[i] });
    }
    await emit('digimon-breeding-update', { player: 1, breeding: p1.breeding });
    await emit('digimon-tamer-update', { player: 1, tamers: p1.tamers });
    await emit('digimon-tamer-update', { player: 2, tamers: p2.tamers });
    await emit('digimon-counts-update', { player: 1, counts: p1.counts });
    await emit('digimon-counts-update', { player: 2, counts: p2.counts });
    await emit('digimon-security-taken', { player: 1, securityTaken: p1.securityTaken });
    await emit('digimon-security-taken', { player: 2, securityTaken: p2.securityTaken });
    await emit('digimon-memory-update', { memory: empty ? 0 : -4 });
    await emit('turn-switch', { currentTurn: 1 });
    await emit('timer-set', { minutes: 0, seconds: 47 });

    // Card art goes through the lazy image cache - the first request downloads
    // from source, so a fixed wait would screenshot half-loaded art.
    await page.waitForFunction(
        () => Array.from(document.images).every(i => i.complete && (i.naturalWidth > 0 || !i.getAttribute('src'))),
        null, { timeout: 45000 }
    ).catch(() => console.warn('warning: some card art never finished loading'));
    await page.waitForTimeout(1800);

    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
