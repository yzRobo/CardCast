// Screenshot the Yu-Gi-Oh! match overlay. Pushes state via a driver socket,
// drops a dark backdrop (OBS sits over a scene), and writes a PNG.
//   node scripts/shot-yugioh-match.mjs [outPath] [full|empty|damage]
// "empty"  captures the cold-start board a producer sees before placing cards.
// "damage" catches the life-point ticker mid-flight.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3888';
const OUT = process.argv[2] || 'c:/tmp/yugioh-overlay.png';
const SCENARIO = process.argv[3] || 'full';
const isUp = async () => { try { return (await fetch(BASE + '/api/config')).ok; } catch { return false; } };

// Pull real cards so the board looks like a real game rather than placeholders.
async function card(query, want) {
    const res = await (await fetch(`${BASE}/api/search/yugioh?q=${encodeURIComponent(query)}`)).json();
    const list = Array.isArray(res) ? res : [];
    const typeOf = c => String(c.card_type || '').toLowerCase();
    const hit = list.find(c => {
        const t = typeOf(c);
        if (want === 'monster') return t.includes('monster') && c.attack != null;
        if (want === 'spell') return t.includes('spell');
        if (want === 'trap') return t.includes('trap');
        return true;
    }) || list[0];
    if (!hit) return null;
    const full = await (await fetch(`${BASE}/api/card/yugioh/${hit.id}`)).json();
    const atk = parseInt(full.attack), def = parseInt(full.defense);
    return {
        id: full.id,
        name: full.name,
        image: full.display_image || full.image_url || full.local_image || '',
        atk: isNaN(atk) ? 0 : atk,
        def: isNaN(def) ? 0 : def,
        position: 'atk'
    };
}

const alreadyUp = await isUp();
const server = alreadyUp ? null : spawn('node', ['server.js'], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
    const start = Date.now();
    while (!(await isUp())) { if (Date.now() - start > 20000) throw new Error('server timeout'); await new Promise(r => setTimeout(r, 300)); }

    const [darkMagician, buster, magician, blueEyes, kaijuSlumber, mirrorForce, spaceTyphoon, field] = SCENARIO === 'empty'
        ? [null, null, null, null, null, null, null, null]
        : await Promise.all([
            card('Dark Magician', 'monster'),
            card('Buster Blader', 'monster'),
            card('Magician of Black Chaos', 'monster'),
            card('Blue-Eyes White Dragon', 'monster'),
            card('Interrupted Kaiju Slumber', 'spell'),
            card('Mirror Force', 'trap'),
            card('Mystical Space Typhoon', 'spell'),
            card('Yami', 'spell')
        ]);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/yugioh-match`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__drv = io(); });
    await page.waitForFunction(() => window.__drv && window.__drv.connected, { timeout: 8000 });
    const emit = (e, d) => page.evaluate(([ev, da]) => window.__drv.emit(ev, da), [e, d]);

    await emit('toggle-yugioh-match', { show: true });

    const blank = name => ({
        name, record: { wins: 0, losses: 0, ties: 0 }, gamesWon: 0,
        lifePoints: 8000, normalSummonUsed: false,
        monsters: [null, null, null, null, null],
        spellsTraps: [null, null, null, null, null],
        fieldSpell: null,
        counts: { hand: 0, deck: 0, extra: 0, graveyard: 0, banished: 0 }
    });

    const p1 = SCENARIO === 'empty' ? blank('Player 1') : {
        name: 'Yugi Muto',
        record: { wins: 5, losses: 1, ties: 0 },
        gamesWon: 1,
        lifePoints: 3400,
        normalSummonUsed: true,
        monsters: [
            darkMagician ? { ...darkMagician, position: 'atk' } : null,
            null,
            buster ? { ...buster, position: 'def' } : null,
            magician ? { ...magician, position: 'set' } : null,
            null
        ],
        spellsTraps: [
            mirrorForce ? { id: mirrorForce.id, name: mirrorForce.name, image: mirrorForce.image, faceDown: true } : null,
            spaceTyphoon ? { id: spaceTyphoon.id, name: spaceTyphoon.name, image: spaceTyphoon.image, faceDown: false } : null,
            null, null, null
        ],
        fieldSpell: field ? { id: field.id, name: field.name, image: field.image } : null,
        counts: { hand: 4, deck: 27, extra: 12, graveyard: 9, banished: 2 }
    };

    const p2 = SCENARIO === 'empty' ? blank('Player 2') : {
        name: 'Seto Kaiba',
        record: { wins: 5, losses: 1, ties: 0 },
        gamesWon: 0,
        lifePoints: 800,
        normalSummonUsed: false,
        monsters: [
            null,
            blueEyes ? { ...blueEyes, position: 'atk' } : null,
            null, null, null
        ],
        spellsTraps: [
            null,
            kaijuSlumber ? { id: kaijuSlumber.id, name: kaijuSlumber.name, image: kaijuSlumber.image, faceDown: false } : null,
            null, null, null
        ],
        fieldSpell: null,
        counts: { hand: 2, deck: 31, extra: 15, graveyard: 6, banished: 0 }
    };

    await emit('yugioh-match-update', {
        player1: p1, player2: p2,
        currentTurn: 1, currentPhase: 'Battle',
        gameNumber: 2, matchFormat: 'Best of 3'
    });
    await emit('turn-switch', { currentTurn: 1 });
    await emit('yugioh-phase-update', { phase: 'Battle' });

    // The overlay fires its own request-state at +500ms and applies the stored
    // timer from it, so the clock has to be pushed after that window closes.
    await page.waitForTimeout(1200);
    await emit('timer-set', { minutes: 0, seconds: 48 });

    await page.waitForTimeout(2000);
    if (SCENARIO === 'damage') {
        // Fire an attack and catch the ticker part-way through its 1.1s flight.
        await emit('yugioh-life-update', { player: 1, lifePoints: p1.lifePoints - 3000 });
        await page.waitForTimeout(320);
    }
    // Dark backdrop so the transparent overlay is legible in the PNG.
    await page.evaluate(() => { document.body.style.background = 'radial-gradient(circle at 50% 40%, #1f2937 0%, #0b0f1a 100%)'; });
    await page.screenshot({ path: OUT });
    console.log('wrote', OUT);
} finally {
    if (browser) await browser.close();
    if (server) server.kill();
}
