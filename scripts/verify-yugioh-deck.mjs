// verify-yugioh-deck.mjs - Phase 1 verification for Yu-Gi-Oh deck foundation.
//
// Exercises the registry (categorize/rules/searchMeta) and parseYugiohDeckList
// against the REAL cardcast.db. fetch() is shimmed to call the same db methods
// the server routes use (db.getCard / db.searchCards), so no server/port needed.
//
// Run: node scripts/verify-yugioh-deck.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');

const CardDatabase = require('../src/database.js');
const db = new CardDatabase(path.join(process.cwd(), 'data', 'cardcast.db'));

// Faithful fetch shim: resolve relative API URLs against the live DB.
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/card/yugioh/')) {
        const id = decodeURIComponent(u.split('/').pop());
        const card = db.getCard('yugioh', id);
        return { ok: !!card, json: async () => card };
    }
    if (u.includes('/api/search/yugioh')) {
        const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
        const results = db.searchCards('yugioh', q);
        return { ok: true, json: async () => results };
    }
    return { ok: false, json: async () => null };
};

const { GAME_REGISTRY, yugiohCategoryFromType } = require('../public/js/game-registry.js');
const { detectGameType, parseYugiohDeckList } = require('../public/js/deck-parser.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
};

console.log('\n=== Registry: yugioh entry ===');
const yg = GAME_REGISTRY.yugioh;
check('entry exists', !!yg);
check('matchControls -> /yugioh-match-control',
    yg.matchControls.some(m => m.route === '/yugioh-match-control'));
check('overlays include /yugioh-match', yg.overlays.some(o => o.route === '/yugioh-match'));
check('overlays include /decklist', yg.overlays.some(o => o.route === '/decklist'));
check('categories order Monsters,Spells,Traps,Extra,Side',
    JSON.stringify(yg.deck.categories) === JSON.stringify(['Monsters', 'Spells', 'Traps', 'Extra', 'Side']));
check('rules.main range [40,60]', JSON.stringify(yg.deck.rules.main) === '[40,60]');
check('rules.extra 15 / side 15 / copyLimit 3',
    yg.deck.rules.extra === 15 && yg.deck.rules.side === 15 && yg.deck.rules.copyLimit === 3);
check('formats include Advanced (TCG)', yg.deck.formats.includes('Advanced (TCG)'));
check('banlist has Advanced (TCG) forbidden/limited/semiLimited',
    yg.deck.banlist['Advanced (TCG)'] &&
    Array.isArray(yg.deck.banlist['Advanced (TCG)'].forbidden) &&
    Array.isArray(yg.deck.banlist['Advanced (TCG)'].limited) &&
    Array.isArray(yg.deck.banlist['Advanced (TCG)'].semiLimited));

console.log('\n=== categorize by card_type ===');
check('Effect Monster -> Monsters', yugiohCategoryFromType('Effect Monster') === 'Monsters');
check('Pendulum Effect Monster -> Monsters', yugiohCategoryFromType('Pendulum Effect Monster') === 'Monsters');
check('Ritual Effect Monster -> Monsters', yugiohCategoryFromType('Ritual Effect Monster') === 'Monsters');
check('Spell Card -> Spells', yugiohCategoryFromType('Spell Card') === 'Spells');
check('Trap Card -> Traps', yugiohCategoryFromType('Trap Card') === 'Traps');
check('Fusion Monster -> Extra', yugiohCategoryFromType('Fusion Monster') === 'Extra');
check('XYZ Monster -> Extra', yugiohCategoryFromType('XYZ Monster') === 'Extra');
check('Synchro Monster -> Extra', yugiohCategoryFromType('Synchro Monster') === 'Extra');
check('Link Monster -> Extra', yugiohCategoryFromType('Link Monster') === 'Extra');
check('Pendulum Effect Fusion Monster -> Extra', yugiohCategoryFromType('Pendulum Effect Fusion Monster') === 'Extra');

console.log('\n=== searchMeta ===');
check('monster shows ATK/DEF', yg.searchMeta({ attack: 2500, defense: 2100 }) === 'ATK 2500 / DEF 2100');
check('def-less monster shows ? ', yg.searchMeta({ attack: 3000, defense: null }) === 'ATK 3000 / DEF ?');
check('spell falls back to card_type', yg.searchMeta({ card_type: 'Spell Card' }) === 'Spell Card');

console.log('\n=== detectGameType ===');
check('YDK #main marker -> yugioh', detectGameType('#created by Tester\n#main\n46986414\n!side\n') === 'yugioh');
check('#extra marker -> yugioh', detectGameType('#extra\n22061412\n') === 'yugioh');
check('pokemon list still pokemon', detectGameType('Pokemon: 4\n4 Pikachu SVI 50') === 'pokemon');
check('gundam token still gundam', detectGameType('4 Gundam GD01-001') === 'gundam');

console.log('\n=== parseYugiohDeckList (real DB) ===');
const ydk = [
    '#created by CardCast Verify',
    '#main',
    '83819309',  // Cooling Embers - Effect Monster
    '83819309',  // (2nd copy)
    '15308295',  // Abyss Actor - Comic Relief - Pendulum Effect Monster
    '17888577',  // Sonic Tracker - Spell Card
    '75719089',  // Glory of the Noble Knights - Spell Card
    '5577649',   // Scrap Crash - Trap Card
    '7811875',   // Gravity Collapse - Trap Card
    '3 Dark Magician', // name + quantity resolution
    '#extra',
    '22061412',  // Elemental HERO The Shining - Fusion
    '73347079',  // Raidraptor - Force Strix - XYZ
    '!side',
    '5577649'    // Scrap Crash placed in Side via marker
].join('\n');

const deck = await parseYugiohDeckList(ydk.split('\n'));
const cats = deck.categories;
const qty = (cat, name) => {
    const c = (cats[cat] || []).find(x => x.name && x.name.toLowerCase().includes(name.toLowerCase()));
    return c ? c.quantity : 0;
};
console.log('  parsed:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));

check('deck tagged game yugioh', deck.game === 'yugioh');
check('Cooling Embers x2 in Monsters', qty('Monsters', 'Cooling Embers') === 2, `got ${qty('Monsters', 'Cooling Embers')}`);
check('Abyss Actor (Pendulum) in Monsters', qty('Monsters', 'Abyss Actor') === 1);
check('Dark Magician x3 by name in Monsters', qty('Monsters', 'Dark Magician') === 3, `got ${qty('Monsters', 'Dark Magician')}`);
check('Sonic Tracker in Spells', qty('Spells', 'Sonic Tracker') === 1);
check('Scrap Crash in Traps (main)', qty('Traps', 'Scrap Crash') === 1);
check('Fusion routed to Extra', qty('Extra', 'Shining') === 1, `got ${qty('Extra', 'Shining')}`);
check('XYZ routed to Extra', qty('Extra', 'Force Strix') === 1);
check('Side marker -> Side category', qty('Side', 'Scrap Crash') === 1, `got ${qty('Side', 'Scrap Crash')}`);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
