// verify-lorcana-deck.mjs - Phase 1 verification for Disney Lorcana deck foundation.
//
// Exercises the registry (categorize/inks/rules/searchMeta) and
// parseLorcanaDeckList against the REAL cardcast.db. fetch() is shimmed to call
// the same db methods the server routes use (db.getCard / db.searchCards), so no
// server/port is needed.
//
// Run: node scripts/verify-lorcana-deck.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');

const CardDatabase = require('../src/database.js');
const db = new CardDatabase(path.join(process.cwd(), 'data', 'cardcast.db'));

// Faithful fetch shim: resolve relative API URLs against the live DB, mirroring
// the server's display_image augmentation.
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/card/lorcana/')) {
        const id = decodeURIComponent(u.split('/').pop());
        const card = db.getCard('lorcana', id);
        if (card) card.display_image = card.image_url || card.local_image;
        return { ok: !!card, json: async () => card };
    }
    if (u.includes('/api/search/lorcana')) {
        const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
        const results = db.searchCards('lorcana', q).map(c => ({ ...c, display_image: c.image_url || c.local_image }));
        return { ok: true, json: async () => results };
    }
    return { ok: false, json: async () => null };
};

const { GAME_REGISTRY, lorcanaCategoryFromType, lorcanaInks } = require('../public/js/game-registry.js');
const { detectGameType, parseLorcanaDeckList } = require('../public/js/deck-parser.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
};

console.log('\n=== Registry: lorcana entry ===');
const lc = GAME_REGISTRY.lorcana;
check('entry exists', !!lc);
check('matchControls -> /lorcana-match-control',
    lc.matchControls.some(m => m.route === '/lorcana-match-control'));
check('overlays include /lorcana-match', lc.overlays.some(o => o.route === '/lorcana-match'));
check('overlays include /decklist', lc.overlays.some(o => o.route === '/decklist'));
check('categories order Characters,Actions,Items,Locations',
    JSON.stringify(lc.deck.categories) === JSON.stringify(['Characters', 'Actions', 'Items', 'Locations']));
check('rules main 60 / copyLimit 4 / maxInks 2',
    lc.deck.rules.main === 60 && lc.deck.rules.copyLimit === 4 && lc.deck.rules.maxInks === 2);
check('formats include Core + Infinity',
    lc.deck.formats.includes('Core') && lc.deck.formats.includes('Infinity'));
check('banlist has Core banned/restricted',
    lc.deck.banlist.Core && Array.isArray(lc.deck.banlist.Core.banned) && Array.isArray(lc.deck.banlist.Core.restricted));

console.log('\n=== categorize by card_type ===');
check('Character -> Characters', lorcanaCategoryFromType('Character') === 'Characters');
check('Action -> Actions', lorcanaCategoryFromType('Action') === 'Actions');
check('Action / Song -> Actions', lorcanaCategoryFromType('Action / Song') === 'Actions');
check('Item -> Items', lorcanaCategoryFromType('Item') === 'Items');
check('Location -> Locations', lorcanaCategoryFromType('Location') === 'Locations');

console.log('\n=== lorcanaInks (split on / and whitespace) ===');
check('"Amethyst/Sapphire" -> [Amethyst, Sapphire]', JSON.stringify(lorcanaInks('Amethyst/Sapphire')) === JSON.stringify(['Amethyst', 'Sapphire']));
check('"Amber Steel" -> [Amber, Steel]', JSON.stringify(lorcanaInks('Amber Steel')) === JSON.stringify(['Amber', 'Steel']));
check('"Ruby" -> [Ruby]', JSON.stringify(lorcanaInks('Ruby')) === JSON.stringify(['Ruby']));
check('empty -> []', JSON.stringify(lorcanaInks('')) === JSON.stringify([]));

console.log('\n=== searchMeta ===');
check('shows Ink + S/W + Lore', lc.searchMeta({ ink_cost: 3, strength: 2, willpower: 2, lore_value: 2 }) === 'Ink 3 / 2/2 / Lore 2');
check('ink only', lc.searchMeta({ ink_cost: 5 }) === 'Ink 5');
check('falls back to colors', lc.searchMeta({ colors: 'Ruby' }) === 'Ruby');

console.log('\n=== detectGameType ===');
check('two subtitle lines -> lorcana', detectGameType('4 Elsa - Snow Queen\n4 Mickey Mouse - Brave Little Tailor') === 'lorcana');
check('lorcana w/ a plain action line still lorcana', detectGameType('4 Elsa - Snow Queen\n4 Anna - Heir to Arendelle\n4 Dragon Fire') === 'lorcana');
check('single subtitle line is NOT enough (-> pokemon default)', detectGameType('4 Elsa - Snow Queen') === 'pokemon');
check('pokemon list still pokemon', detectGameType('Pokemon: 4\n4 Pikachu SVI 50') === 'pokemon');
check('mtg arena export still magic', detectGameType('Deck\n4 Lightning Bolt (JMP) 342\n4 Llanowar Elves (DOM) 168') === 'magic');
check('onepiece OP token still onepiece', detectGameType('1 Roronoa Zoro OP01-001\n4 Usopp OP01-004') === 'onepiece');
check('gundam GD token still gundam', detectGameType('4 Gundam GD01-001\n4 Char GD01-002') === 'gundam');

console.log('\n=== parseLorcanaDeckList (real DB) ===');
const list = [
    'Characters',
    '4 Elsa - Concerned Sister',
    '2 Forbidden Mountain - Maleficent\'s Castle',
    'Actions',
    '3 Friends on the Other Side',
    '2 Dragon Fire'
].join('\n');

const deck = await parseLorcanaDeckList(list.split('\n'));
const cats = deck.categories;
const qty = (cat, name) => {
    const c = (cats[cat] || []).find(x => x.name && x.name.toLowerCase().includes(name.toLowerCase()));
    return c ? c.quantity : 0;
};
console.log('  parsed:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));

check('deck tagged game lorcana', deck.game === 'lorcana');
check('Character resolved into Characters', qty('Characters', 'Elsa') === 4, `got ${qty('Characters', 'Elsa')}`);
check('Location routed to Locations (not Characters)', qty('Locations', 'Forbidden Mountain') === 2, `got ${qty('Locations', 'Forbidden Mountain')}`);
check('Action routed to Actions', qty('Actions', 'Friends on the Other Side') === 3, `got ${qty('Actions', 'Friends on the Other Side')}`);
check('Action / Song bucketed as Action (Friends... is a Song)', (cats.Actions || []).some(c => /Friends on the Other Side/i.test(c.name)));
check('Dragon Fire x2 in Actions', qty('Actions', 'Dragon Fire') === 2, `got ${qty('Actions', 'Dragon Fire')}`);

// Character entries carry colors (ink) + image for the match-control quick-add.
const elsa = cats.Characters.find(c => /Elsa/.test(c.name));
check('character entry has colors (ink) + image string', elsa && elsa.colors && typeof elsa.image === 'string', JSON.stringify(elsa && { colors: elsa.colors }));

console.log('\n=== search projection exposes Lorcana stats ===');
const probe = db.searchCards('lorcana', 'Elsa - Concerned Sister')[0];
check('search row carries ink_cost/strength/willpower/lore_value',
    probe && probe.ink_cost != null && probe.strength != null && probe.willpower != null && probe.lore_value != null,
    JSON.stringify(probe && { ink: probe.ink_cost, s: probe.strength, w: probe.willpower, lore: probe.lore_value }));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
