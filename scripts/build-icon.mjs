// Generate the CardCast application icon from assets/icon.svg.
//
// Renders the SVG at each Windows icon size with Chromium (via the Playwright
// already used by the verify scripts), then packs the PNGs into a single
// assets/icon.ico. Windows 10/11 read PNG-compressed ICO entries directly, so no
// BMP conversion is needed.
//
//   node scripts/build-icon.mjs
//
// The generated icon.ico and icon-256.png are committed, so a normal build never
// needs Playwright - rerun this only after editing assets/icon.svg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');

// The sizes Explorer, the taskbar, the installer and the alt-tab switcher pull
// from. 16 and 24 use the simplified artwork - the full design's second card and
// outer arc turn to noise once they are a few pixels wide.
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL_SIZES = new Set([16, 24]);

function readSvg(name) {
    const file = path.join(assets, name);
    if (!fs.existsSync(file)) {
        console.error(`Missing ${file}`);
        process.exit(1);
    }
    return fs.readFileSync(file, 'utf8');
}
const fullSvg = readSvg('icon.svg');
const smallSvg = readSvg('icon-small.svg');

const browser = await chromium.launch();
const pngs = new Map();
try {
    for (const size of SIZES) {
        const useSmall = SMALL_SIZES.has(size);
        const page = await browser.newPage({
            viewport: { width: size, height: size },
            deviceScaleFactor: 1
        });
        // Transparent page so the icon's rounded corners stay transparent.
        await page.setContent(
            `<style>html,body{margin:0;padding:0;background:transparent}
             svg{display:block;width:${size}px;height:${size}px}</style>${useSmall ? smallSvg : fullSvg}`,
            { waitUntil: 'load' }
        );
        pngs.set(size, await page.screenshot({ omitBackground: true }));
        await page.close();
        console.log(`rendered ${size}x${size}${useSmall ? ' (simplified)' : ''}`);
    }
} finally {
    await browser.close();
}

// ---- ICO container -------------------------------------------------------
// 6-byte header, then one 16-byte directory entry per image, then the PNG data.
function buildIco(images) {
    const count = images.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);      // reserved
    header.writeUInt16LE(1, 2);      // type 1 = icon
    header.writeUInt16LE(count, 4);

    const dir = Buffer.alloc(16 * count);
    let offset = header.length + dir.length;

    images.forEach(({ size, data }, i) => {
        const at = i * 16;
        // 256 is stored as 0 in the single-byte width/height fields.
        dir.writeUInt8(size >= 256 ? 0 : size, at);
        dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
        dir.writeUInt8(0, at + 2);            // palette colours (0 = truecolour)
        dir.writeUInt8(0, at + 3);            // reserved
        dir.writeUInt16LE(1, at + 4);         // colour planes
        dir.writeUInt16LE(32, at + 6);        // bits per pixel
        dir.writeUInt32LE(data.length, at + 8);
        dir.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });

    return Buffer.concat([header, dir, ...images.map(i => i.data)]);
}

const ico = buildIco(SIZES.map(size => ({ size, data: pngs.get(size) })));
fs.writeFileSync(path.join(assets, 'icon.ico'), ico);
console.log(`wrote assets/icon.ico (${SIZES.length} sizes, ${(ico.length / 1024).toFixed(1)} KB)`);

// A 256px PNG for the web favicon and for previewing the design.
fs.writeFileSync(path.join(assets, 'icon-256.png'), pngs.get(256));
console.log('wrote assets/icon-256.png');
