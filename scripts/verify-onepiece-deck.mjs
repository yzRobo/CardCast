// verify-onepiece-deck.mjs - Phase 1 verification for One Piece deck foundation.
//
// Exercises the registry (categorize/colors/rules/searchMeta) and
// parseOnePieceDeckList against the REAL cardcast.db. fetch() is shimmed to call
// the same db methods the server routes use (db.getCard / db.searchCards), so no
// server/port is needed.
//
// Run: node scripts/verify-onepiece-deck.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');

const CardDatabase = require('../src/database.js');
const db = new CardDatabase(path.join(process.cwd(), 'data', 'cardcast.db'));

// Faithful fetch shim: resolve relative API URLs against the live DB, mirroring
// the server's display_image augmentation.
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/card/onepiece/')) {
        const id = decodeURIComponent(u.split('/').pop());
        const card = db.getCard('onepiece', id);
        if (card) card.display_image = card.image_url || card.local_image;
        return { ok: !!card, json: async () => card };
    }
    if (u.includes('/api/search/onepiece')) {
        const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
        const results = db.searchCards('onepiece', q).map(c => ({ ...c, display_image: c.image_url || c.local_image }));
        return { ok: true, json: async () => results };
    }
    return { ok: false, json: async () => null };
};

const { GAME_REGISTRY, onePieceCategoryFromType, onePieceColors } = require('../public/js/game-registry.js');
const { detectGameType, parseOnePieceDeckList } = require('../public/js/deck-parser.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
};

console.log('\n=== Registry: onepiece entry ===');
const op = GAME_REGISTRY.onepiece;
check('entry exists', !!op);
check('matchControls -> /onepiece-match-control',
    op.matchControls.some(m => m.route === '/onepiece-match-control'));
check('overlays include /onepiece-match', op.overlays.some(o => o.route === '/onepiece-match'));
check('overlays include /decklist', op.overlays.some(o => o.route === '/decklist'));
check('categories order Leader,Characters,Events,Stages',
    JSON.stringify(op.deck.categories) === JSON.stringify(['Leader', 'Characters', 'Events', 'Stages']));
check('rules main 50 / leader 1 / copyLimit 4',
    op.deck.rules.main === 50 && op.deck.rules.leader === 1 && op.deck.rules.copyLimit === 4);
check('formats include Standard + Unlimited',
    op.deck.formats.includes('Standard') && op.deck.formats.includes('Unlimited'));
check('banlist has Standard banned/restricted/bannedPairs',
    op.deck.banlist.Standard &&
    Array.isArray(op.deck.banlist.Standard.banned) &&
    Array.isArray(op.deck.banlist.Standard.restricted) &&
    Array.isArray(op.deck.banlist.Standard.bannedPairs));

console.log('\n=== categorize by card_type ===');
check('Leader -> Leader', onePieceCategoryFromType('Leader') === 'Leader');
check('Character -> Characters', onePieceCategoryFromType('Character') === 'Characters');
check('Event -> Events', onePieceCategoryFromType('Event') === 'Events');
check('Stage -> Stages', onePieceCategoryFromType('Stage') === 'Stages');

console.log('\n=== onePieceColors (split on / and whitespace) ===');
check('"Green/Red" -> [Green, Red]', JSON.stringify(onePieceColors('Green/Red')) === JSON.stringify(['Green', 'Red']));
check('"Green Red" -> [Green, Red]', JSON.stringify(onePieceColors('Green Red')) === JSON.stringify(['Green', 'Red']));
check('"Red" -> [Red]', JSON.stringify(onePieceColors('Red')) === JSON.stringify(['Red']));
check('empty -> []', JSON.stringify(onePieceColors('')) === JSON.stringify([]));

console.log('\n=== searchMeta ===');
check('shows Power + Cost', op.searchMeta({ op_power: 5000, cost: 4 }) === 'Power 5000 / Cost 4');
check('power only', op.searchMeta({ op_power: 7000 }) === 'Power 7000');
check('falls back to colors', op.searchMeta({ colors: 'Red' }) === 'Red');

console.log('\n=== detectGameType ===');
check('OP token -> onepiece', detectGameType('1 Roronoa Zoro OP01-001\n4 Usopp OP01-004') === 'onepiece');
check('PRB token -> onepiece', detectGameType('4 Some Card PRB01-001') === 'onepiece');
check('OP deck w/ shared ST token still onepiece (OP wins)', detectGameType('OP01-001\n4 Usopp ST01-002') === 'onepiece');
check('pure Gundam GD token still gundam', detectGameType('4 Gundam GD01-001') === 'gundam');
check('pokemon list still pokemon', detectGameType('Pokemon: 4\n4 Pikachu SVI 50') === 'pokemon');
check('yugioh YDK still yugioh', detectGameType('#main\n46986414\n') === 'yugioh');

console.log('\n=== parseOnePieceDeckList (real DB) ===');
const list = [
    'Leader',
    '1 Roronoa Zoro OP01-001',
    'Characters',
    '4 Usopp OP01-004',
    '4 Uta OP01-005',
    'Events',
    '2 Just Shut Up and Come with Us!!!! EB01-009',
    'Stages',
    '1 Loguetown EB01-030',
    'DON!!',
    '10 DON!! card'
].join('\n');

const deck = await parseOnePieceDeckList(list.split('\n'));
const cats = deck.categories;
const qty = (cat, name) => {
    const c = (cats[cat] || []).find(x => x.name && x.name.toLowerCase().includes(name.toLowerCase()));
    return c ? c.quantity : 0;
};
console.log('  parsed:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));

check('deck tagged game onepiece', deck.game === 'onepiece');
check('Leader resolved into Leader category', qty('Leader', 'Roronoa Zoro') === 1, `got ${qty('Leader', 'Roronoa Zoro')}`);
check('deck.leader populated', !!deck.leader && /Zoro/.test(deck.leader.name), JSON.stringify(deck.leader));
check('deck.leader has life (number)', deck.leader && typeof deck.leader.life === 'number', String(deck.leader && deck.leader.life));
check('deck.leader has colors', deck.leader && deck.leader.colors && deck.leader.colors.length > 0, String(deck.leader && deck.leader.colors));
check('Usopp x4 in Characters', qty('Characters', 'Usopp') === 4, `got ${qty('Characters', 'Usopp')}`);
check('Uta x4 in Characters', qty('Characters', 'Uta') === 4);
check('Event in Events', qty('Events', 'Shut Up') === 2, `got ${qty('Events', 'Shut Up')}`);
check('Stage in Stages', qty('Stages', 'Loguetown') === 1);
check('DON!! line ignored (not a category)', !cats.DON && (cats.Leader.length + cats.Characters.length + cats.Events.length + cats.Stages.length) === 5);

// Character entries carry power/counter/colors for the match-control quick-add.
const usopp = cats.Characters.find(c => /Usopp/.test(c.name));
check('character entry has image + colors', usopp && usopp.colors && typeof usopp.image === 'string', JSON.stringify(usopp && { colors: usopp.colors }));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
