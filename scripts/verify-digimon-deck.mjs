// verify-digimon-deck.mjs - Phase 1 verification for Digimon deck foundation.
//
// Exercises the registry (categorize/rules/searchMeta) and parseDigimonDeckList
// against the REAL cardcast.db. fetch() is shimmed to call the same db methods the
// server routes use (db.getCard / db.searchCards), so no server/port is needed.
//
// Run: node scripts/verify-digimon-deck.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');

const CardDatabase = require('../src/database.js');
const db = new CardDatabase(path.join(process.cwd(), 'data', 'cardcast.db'));

// Faithful fetch shim: resolve relative API URLs against the live DB, mirroring
// the server's display_image augmentation.
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/card/digimon/')) {
        const id = decodeURIComponent(u.split('/').pop());
        const card = db.getCard('digimon', id);
        if (card) card.display_image = card.image_url || card.local_image;
        return { ok: !!card, json: async () => card };
    }
    if (u.includes('/api/search/digimon')) {
        const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
        const results = db.searchCards('digimon', q).map(c => ({ ...c, display_image: c.image_url || c.local_image }));
        return { ok: true, json: async () => results };
    }
    return { ok: false, json: async () => null };
};

const { GAME_REGISTRY, digimonCategoryFromType } = require('../public/js/game-registry.js');
const { detectGameType, parseDigimonDeckList } = require('../public/js/deck-parser.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
};

console.log('\n=== Registry: digimon entry ===');
const dg = GAME_REGISTRY.digimon;
check('entry exists', !!dg);
check('matchControls -> /digimon-match-control',
    dg.matchControls.some(m => m.route === '/digimon-match-control'));
check('overlays include /digimon-match', dg.overlays.some(o => o.route === '/digimon-match'));
check('overlays include /decklist', dg.overlays.some(o => o.route === '/decklist'));
check('categories order Digimon,Tamers,Options,Digi-Egg',
    JSON.stringify(dg.deck.categories) === JSON.stringify(['Digimon', 'Tamers', 'Options', 'Digi-Egg']));
check('rules main 50 / egg 5 / copyLimit 4',
    dg.deck.rules.main === 50 && dg.deck.rules.egg === 5 && dg.deck.rules.copyLimit === 4);
check('formats include Standard + Unlimited',
    dg.deck.formats.includes('Standard') && dg.deck.formats.includes('Unlimited'));
check('banlist has Standard banned/restricted',
    dg.deck.banlist.Standard && Array.isArray(dg.deck.banlist.Standard.banned) && Array.isArray(dg.deck.banlist.Standard.restricted));

console.log('\n=== categorize by card_type ===');
check('Digimon -> Digimon', digimonCategoryFromType('Digimon') === 'Digimon');
check('Dual -> Digimon (played as Digimon)', digimonCategoryFromType('Dual') === 'Digimon');
check('Tamer -> Tamers', digimonCategoryFromType('Tamer') === 'Tamers');
check('Option -> Options', digimonCategoryFromType('Option') === 'Options');
check('Digi-Egg -> Digi-Egg (egg deck)', digimonCategoryFromType('Digi-Egg') === 'Digi-Egg');
check('unknown -> Digimon fallback', digimonCategoryFromType('') === 'Digimon');

console.log('\n=== searchMeta ===');
check('shows Cost + DP + Lv', dg.searchMeta({ play_cost: 3, dp: 2000, digimon_level: 3 }) === 'Cost 3 / DP 2000 / Lv.3');
check('cost only', dg.searchMeta({ play_cost: 5 }) === 'Cost 5');
check('falls back to colors', dg.searchMeta({ colors: 'Red/Blue' }) === 'Red/Blue');

console.log('\n=== detectGameType ===');
check('BT token -> digimon', detectGameType('4 Agumon BT1-010\n4 Greymon BT1-016') === 'digimon');
check('BT19 (two-digit set) -> digimon', detectGameType('4 Hornet Eraser BT19-096') === 'digimon');
check('mixed BT + ST -> digimon (BT wins over Gundam)', detectGameType('1 Gabumon ST1-02\n4 Agumon BT1-010') === 'digimon');
check('onepiece OP token still onepiece (no BT)', detectGameType('1 Roronoa Zoro OP01-001\n4 Usopp OP01-004') === 'onepiece');
check('gundam GD token still gundam (no BT)', detectGameType('4 Gundam GD01-001\n4 Char GD01-002') === 'gundam');
check('pokemon list still pokemon', detectGameType('Pokemon: 4\n4 Pikachu SVI 50') === 'pokemon');
check('mtg arena export still magic', detectGameType('Deck\n4 Lightning Bolt (JMP) 342\n4 Llanowar Elves (DOM) 168') === 'magic');

console.log('\n=== parseDigimonDeckList (real DB) ===');
const list = [
    'Digimon',
    '4 BT1-009',            // Monodramon, number-only line
    '4 Agumon BT1-010',     // name + number
    'Tamers',
    '2 Tai Kamiya',         // name-only line (Tamer)
    'Options',
    '3 Gravity Crush',      // name-only line (Option)
    'Digi-Egg',
    '2 BT1-001'             // Yokomon (Digi-Egg) -> egg deck
].join('\n');

const deck = await parseDigimonDeckList(list.split('\n'));
const cats = deck.categories;
const qty = (cat, name) => {
    const c = (cats[cat] || []).find(x => x.name && x.name.toLowerCase().includes(name.toLowerCase()));
    return c ? c.quantity : 0;
};
console.log('  parsed:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));

check('deck tagged game digimon', deck.game === 'digimon');
check('Monodramon (number-only) into Digimon x4', qty('Digimon', 'Monodramon') === 4, `got ${qty('Digimon', 'Monodramon')}`);
check('Agumon (name+number) into Digimon x4', qty('Digimon', 'Agumon') === 4, `got ${qty('Digimon', 'Agumon')}`);
check('Tamer routed to Tamers (not Digimon)', qty('Tamers', 'Tai Kamiya') === 2, `got ${qty('Tamers', 'Tai Kamiya')}`);
check('Option routed to Options', qty('Options', 'Gravity Crush') === 3, `got ${qty('Options', 'Gravity Crush')}`);
check('Digi-Egg routed to Digi-Egg deck (not Digimon)', qty('Digi-Egg', 'Yokomon') === 2, `got ${qty('Digi-Egg', 'Yokomon')}`);

// Main deck = Digimon + Tamers + Options; egg deck is separate.
const mainCount = ['Digimon', 'Tamers', 'Options'].reduce((s, c) => s + (cats[c] || []).reduce((n, x) => n + x.quantity, 0), 0);
const eggCount = (cats['Digi-Egg'] || []).reduce((n, x) => n + x.quantity, 0);
check('main count = 13 (4+4+2+3)', mainCount === 13, `got ${mainCount}`);
check('egg count = 2 (separate from main)', eggCount === 2, `got ${eggCount}`);

// Card entries carry colors + image for the match-control quick-add.
const mono = cats.Digimon.find(c => /Monodramon/.test(c.name));
check('digimon entry has colors + image string', mono && mono.colors && typeof mono.image === 'string', JSON.stringify(mono && { colors: mono.colors }));

console.log('\n=== search projection exposes Digimon stats ===');
const probe = db.searchCards('digimon', 'BT1-010')[0];
check('search row carries play_cost/dp/digimon_level',
    probe && probe.play_cost != null && probe.dp != null && probe.digimon_level != null,
    JSON.stringify(probe && { cost: probe.play_cost, dp: probe.dp, lvl: probe.digimon_level }));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
