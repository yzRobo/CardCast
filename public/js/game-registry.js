// public/js/game-registry.js - CardCast per-game main-page configuration.
//
// SINGLE SOURCE OF TRUTH for how the main page (index.html + main.js) behaves
// per game: which match-control buttons and OBS overlay links to show, how the
// deck builder buckets cards, and what meta to show on search results/previews.
//
// To add a game's UI support, add (or fill in) its entry here. A game with no
// entry yet still selects fine - selectGame() falls back to the universal
// overlays (Main + Deck List) and a "no dedicated match controls" hint until
// the entry is backfilled.
//
// matchControls: [{ label, route, style }]  -> Match Controls panel buttons
// overlays:      [{ label, route }]         -> OBS Browser Sources list
// deck:          { categories, categorize(card), rules, formats }
// searchMeta:    (card) => string           -> extra line on result/preview tiles
//
// Loaded BEFORE main.js. Routes must match server.js (do not invent routes).

const GAME_REGISTRY = {
    pokemon: {
        name: 'Pokemon',
        matchControls: [
            { label: 'Pokemon Match Control', route: '/pokemon-match-control', style: 'btn-primary' }
        ],
        overlays: [
            { label: 'Main Display', route: '/overlay' },
            { label: 'Pokemon Match', route: '/pokemon-match' },
            { label: 'Prize Cards', route: '/prizes' },
            { label: 'Deck List', route: '/decklist' }
        ],
        deck: {
            categories: ['Pokemon', 'Trainers', 'Energy'],
            categorize: (card) => {
                const type = (card.card_type || '').toLowerCase();
                if (type.includes('trainer')) return 'Trainers';
                if (type.includes('energy')) return 'Energy';
                return 'Pokemon';
            },
            rules: { main: 60, copyLimit: 4 },
            formats: ['Standard', 'Expanded']
        },
        searchMeta: (card) => (card.hp ? `HP ${card.hp}` : '')
    },

    magic: {
        name: 'Magic: The Gathering',
        matchControls: [
            { label: 'MTG Match Control', route: '/mtg-match-control', style: 'btn-warning' }
        ],
        overlays: [
            { label: 'Main Display', route: '/overlay' },
            { label: 'MTG Match', route: '/mtg-match' },
            { label: 'Deck List', route: '/decklist' }
        ],
        deck: {
            categories: ['Creatures', 'Spells', 'Artifacts', 'Enchantments', 'Planeswalkers', 'Lands'],
            categorize: (card) => {
                const type = (card.card_type || card.type_line || '').toLowerCase();
                if (type.includes('land')) return 'Lands';
                if (type.includes('creature')) return 'Creatures';
                if (type.includes('planeswalker')) return 'Planeswalkers';
                if (type.includes('artifact')) return 'Artifacts';
                if (type.includes('enchantment')) return 'Enchantments';
                if (type.includes('instant') || type.includes('sorcery')) return 'Spells';
                return 'Spells';
            },
            rules: { main: 60, copyLimit: 4 },
            // Label-only by default (an opt-in legality filter can use banlist later).
            // Commander is intentionally dropped - CardCast Magic is MTG proper (60-card,
            // 20 life); re-add it later as its own format if needed.
            formats: ['Standard', 'Pioneer', 'Modern', 'Legacy'],
            // Per-format banned cards for the future opt-in legality filter. Seeded
            // empty; fill from the official B&R list (magic.wizards.com/en/banned-restricted-list).
            banlist: {
                Standard: [],
                Pioneer: [],
                Modern: [],
                Legacy: []
            }
        },
        searchMeta: (card) => (card.mana_cost || card.card_type || '')
    },

    gundam: {
        name: 'Gundam Card Game',
        matchControls: [
            { label: 'Gundam Match Control', route: '/gundam-match-control', style: 'btn-info' }
        ],
        overlays: [
            { label: 'Main Display', route: '/overlay' },
            { label: 'Gundam Match', route: '/gundam-match' },
            { label: 'Deck List', route: '/decklist' }
        ],
        deck: {
            categories: ['Units', 'Pilots', 'Commands', 'Bases', 'Resources'],
            categorize: (card) => gundamCategoryFromType(card.card_type),
            // Main deck = Units+Pilots+Commands+Bases (50). Resource deck = 10. Max 4 copies/number.
            rules: { main: 50, resources: 10, copyLimit: 4 },
            // Label-only by default (an opt-in legality filter can use formatSets later).
            formats: ['Unlimited', 'GD04 Standard', 'GD03', 'GD02', 'GD01'],
            // Best-effort set pools for the future opt-in legality filter.
            // TODO: verify exact set membership against egmanevents.com/gundam-gdXX-format.
            formatSets: {
                Unlimited: '*',
                'GD04 Standard': ['GD01', 'GD02', 'GD03', 'GD04', 'ST01', 'ST02', 'ST03', 'ST04', 'ST05', 'ST06', 'ST07', 'ST08', 'ST09', 'ST10', 'EB01'],
                GD03: ['GD01', 'GD02', 'GD03', 'ST01', 'ST02', 'ST03', 'ST04', 'ST05', 'ST06', 'EB01'],
                GD02: ['GD01', 'GD02', 'ST01', 'ST02', 'ST03', 'ST04', 'EB01'],
                GD01: ['GD01', 'ST01', 'ST02', 'ST03', 'ST04']
            }
        },
        searchMeta: (card) => {
            const parts = [];
            if (card.gd_ap !== undefined && card.gd_ap !== null && card.gd_ap !== '') parts.push(`AP ${card.gd_ap}`);
            if (card.gd_hp !== undefined && card.gd_hp !== null && card.gd_hp !== '') parts.push(`HP ${card.gd_hp}`);
            return parts.length ? parts.join(' / ') : (card.card_type || '');
        }
    },

    yugioh: {
        name: 'Yu-Gi-Oh!',
        matchControls: [
            { label: 'Yu-Gi-Oh! Match Control', route: '/yugioh-match-control', style: 'btn-warning' }
        ],
        overlays: [
            { label: 'Main Display', route: '/overlay' },
            { label: 'Yu-Gi-Oh! Match', route: '/yugioh-match' },
            { label: 'Deck List', route: '/decklist' }
        ],
        deck: {
            // Side is import-driven only (categorize never returns it). Extra holds
            // Fusion/Synchro/XYZ/Link monsters routed out of the Main deck.
            categories: ['Monsters', 'Spells', 'Traps', 'Extra', 'Side'],
            categorize: (card) => yugiohCategoryFromType(card.card_type),
            // Main 40-60, Extra 0-15, Side 0-15, max 3 copies per card name.
            rules: { main: [40, 60], extra: 15, side: 15, copyLimit: 3 },
            // Label-only by default; opt-in legality can use banlist[] later.
            formats: ['Advanced (TCG)', 'Traditional', 'Advanced (OCG)'],
            // Forbidden & Limited snapshot per format. Seeded empty; fill from the
            // official Konami F&L list (yugioh-card.com/en/limited).
            banlist: {
                'Advanced (TCG)': { forbidden: [], limited: [], semiLimited: [] },
                'Traditional': { forbidden: [], limited: [], semiLimited: [] },
                'Advanced (OCG)': { forbidden: [], limited: [], semiLimited: [] }
            }
        },
        searchMeta: (card) => {
            const has = (v) => v !== undefined && v !== null && v !== '';
            if (has(card.attack) || has(card.defense)) {
                const atk = has(card.attack) ? card.attack : '?';
                const def = has(card.defense) ? card.defense : '?';
                return `ATK ${atk} / DEF ${def}`;
            }
            return card.card_type || '';
        }
    },

    onepiece: {
        name: 'One Piece Card Game',
        matchControls: [
            { label: 'One Piece Match Control', route: '/onepiece-match-control', style: 'btn-error' }
        ],
        overlays: [
            { label: 'Main Display', route: '/overlay' },
            { label: 'One Piece Match', route: '/onepiece-match' },
            { label: 'Deck List', route: '/decklist' }
        ],
        deck: {
            // Leader (1) headlines the deck (sets colors + Life). Main deck =
            // Characters + Events + Stages (50). The DON!! deck (10) is uniform and
            // not built from these categories, so it is intentionally not listed.
            categories: ['Leader', 'Characters', 'Events', 'Stages'],
            categorize: (card) => onePieceCategoryFromType(card.card_type),
            rules: { main: 50, leader: 1, copyLimit: 4 },
            // Label-only by default; an opt-in legality filter can use the banlist later.
            formats: ['Standard', 'Unlimited'],
            // Official restricted list snapshot. Seeded empty; fill from the Bandai
            // B&R list (en.onepiece-cardgame.com/rules/restriction). bannedPairs is a
            // list of [cardA, cardB] that cannot share a deck (a validation warning).
            banlist: {
                Standard: { banned: [], restricted: [], bannedPairs: [] },
                Unlimited: { banned: [], restricted: [], bannedPairs: [] }
            }
        },
        searchMeta: (card) => {
            const has = (v) => v !== undefined && v !== null && v !== '';
            const parts = [];
            if (has(card.op_power)) parts.push(`Power ${card.op_power}`);
            if (has(card.cost)) parts.push(`Cost ${card.cost}`);
            if (parts.length) return parts.join(' / ');
            return card.colors || card.card_type || '';
        }
    }
};

// One Piece card_type -> deck category. Shared by the registry categorize() above
// and parseOnePieceDeckList in deck-parser.js (single source of truth). DB values
// are title-case: Leader / Character / Event / Stage.
function onePieceCategoryFromType(cardType) {
    const t = (cardType || '').toLowerCase().trim();
    if (t.includes('leader')) return 'Leader';
    if (t.includes('event')) return 'Events';
    if (t.includes('stage')) return 'Stages';
    return 'Characters'; // Character + fallback
}

// Split a One Piece color string into its component colors. optcgapi joins
// multicolor with "/" (e.g. "Green/Red"); older data used a space. Splitting on
// both keeps the leader-color identity rule correct either way.
function onePieceColors(colorString) {
    return String(colorString || '')
        .split(/[\/\s]+/)
        .map(c => c.trim())
        .filter(Boolean);
}

// Yu-Gi-Oh! card_type -> deck category. Shared by the registry categorize() above
// and parseYugiohDeckList in deck-parser.js (single source of truth). Extra-Deck
// monster types (Fusion/Synchro/XYZ/Link) route into Extra; everything else that
// is a monster (Effect/Normal/Ritual/Pendulum/Tuner/Flip) stays in Monsters. Side
// is never derived from card_type - it is import-driven via the deck-list markers.
function yugiohCategoryFromType(cardType) {
    const t = (cardType || '').toLowerCase().trim();
    if (t.includes('spell')) return 'Spells';
    if (t.includes('trap')) return 'Traps';
    if (t.includes('fusion') || t.includes('synchro') || t.includes('xyz') || t.includes('link')) return 'Extra';
    return 'Monsters';
}

// Gundam card_type -> deck category. Shared by the registry categorize() above
// and parseGundamDeckList in deck-parser.js (kept here as the single source of
// truth). card_type values are ALL CAPS in the DB; TOKEN / EX variants and the
// fullwidth "UNIT・TOKEN" all fall into the right bucket via substring match.
function gundamCategoryFromType(cardType) {
    const t = (cardType || '').toUpperCase().trim();
    if (t.includes('PILOT')) return 'Pilots';
    if (t.includes('COMMAND')) return 'Commands';
    if (t.includes('RESOURCE')) return 'Resources'; // RESOURCE, EX RESOURCE
    if (t.includes('BASE')) return 'Bases';          // BASE, EX BASE
    return 'Units';                                   // UNIT, UNIT TOKEN, UNIT・TOKEN, fallback
}

// Universal overlays for games that don't have a dedicated registry entry yet.
// Both routes are game-agnostic on the server, so they work for any game.
const DEFAULT_OVERLAYS = [
    { label: 'Main Display', route: '/overlay' },
    { label: 'Deck List', route: '/decklist' }
];

// Resolve the effective config for a game id (never throws on unknown games).
function getGameConfig(gameId) {
    const reg = GAME_REGISTRY[gameId] || {};
    return {
        name: reg.name || (gameId ? gameId.charAt(0).toUpperCase() + gameId.slice(1) : ''),
        matchControls: reg.matchControls || [],
        overlays: (reg.overlays && reg.overlays.length) ? reg.overlays : DEFAULT_OVERLAYS,
        deck: reg.deck || null,
        searchMeta: reg.searchMeta || (() => '')
    };
}

// ===================================================================
// Generic deck-shape helpers (single normalization point)
// ===================================================================
// Saved decks historically used per-game array shapes:
//   Pokemon: { pokemon: [], trainers: [], energy: [] }
//   MTG:     { cards: [], sideboard: [] }
// New games store a generic { categories: { Name: [cards] } }.
//
// getDeckCategories() flattens ALL of these to { Name: [cards] } so the deck
// library (counts, overlay push, export, deck-only search, deck view) can be
// game-agnostic. Legacy decks are returned in-place by reference (no storage
// migration) so the match-control pages that still read deck.pokemon/etc keep
// working.

// Legacy array-key -> display category. Order here drives display/section order.
const LEGACY_DECK_SHAPES = {
    magic: [['cards', 'Deck'], ['sideboard', 'Sideboard']],
    pokemon: [['pokemon', 'Pokemon'], ['trainers', 'Trainers'], ['energy', 'Energy']]
};

// Export section header per category. Defaults to the category name; Pokemon
// overrides so its text export round-trips through the Pokemon deck parser,
// which expects "Pokémon/Trainer/Energy" headers.
const DECK_EXPORT_HEADERS = {
    Pokemon: 'Pokémon', Trainers: 'Trainer', Energy: 'Energy'
};

// Normalize any saved deck to { CategoryName: [cards] } (non-empty categories only).
function getDeckCategories(deck) {
    if (!deck || typeof deck !== 'object') return {};

    // Generic shape wins when present.
    if (deck.categories && typeof deck.categories === 'object') {
        const out = {};
        Object.keys(deck.categories).forEach(name => {
            const cards = deck.categories[name];
            if (Array.isArray(cards) && cards.length) out[name] = cards;
        });
        return out;
    }

    // Legacy per-game shape (default to Pokemon's for unknown games).
    const shape = LEGACY_DECK_SHAPES[deck.game] || LEGACY_DECK_SHAPES.pokemon;
    const out = {};
    shape.forEach(([key, label]) => {
        const cards = deck[key];
        if (Array.isArray(cards) && cards.length) out[label] = cards;
    });
    return out;
}

// Resolve the storage array for a display category, creating it in the deck's
// native shape so edits land where the rest of the app (and control pages) read.
function getDeckCategoryArray(deck, name) {
    if (!deck || typeof deck !== 'object') return [];

    // Generic decks: keep everything under .categories.
    if (deck.categories && typeof deck.categories === 'object' && !LEGACY_DECK_SHAPES[deck.game]) {
        if (!deck.categories[name]) deck.categories[name] = [];
        return deck.categories[name];
    }

    // Legacy decks: map the display name back to its legacy array key.
    const shape = LEGACY_DECK_SHAPES[deck.game] || LEGACY_DECK_SHAPES.pokemon;
    const pair = shape.find(([, label]) => label === name);
    if (pair) {
        const key = pair[0];
        if (!deck[key]) deck[key] = [];
        return deck[key];
    }

    // Unknown category on a legacy deck: stash it under .categories.
    if (!deck.categories) deck.categories = {};
    if (!deck.categories[name]) deck.categories[name] = [];
    return deck.categories[name];
}

// Total card count across all categories.
function deckCardCount(deck) {
    let total = 0;
    Object.values(getDeckCategories(deck)).forEach(cards => {
        cards.forEach(c => { total += (c.quantity || 1); });
    });
    return total;
}

// Build a re-importable text export from any saved deck.
function deckToText(deck) {
    const cats = getDeckCategories(deck);
    const blocks = Object.keys(cats).map(name => {
        const cards = cats[name];
        const count = cards.reduce((s, c) => s + (c.quantity || 1), 0);
        const header = DECK_EXPORT_HEADERS[name] || name;
        const lines = cards.map(c => {
            const setCode = c.setCode || '';
            const number = c.number || c.cardNumber || '';
            return (setCode && number)
                ? `${c.quantity || 1} ${c.name} ${setCode} ${number}`
                : `${c.quantity || 1} ${c.name}`;
        }).join('\n');
        return `${header}: ${count}\n${lines}`;
    });
    return blocks.join('\n\n') + `\n\nTotal Cards: ${deckCardCount(deck)}`;
}

// Ordered list of section names to render for a deck (includes empty sections so
// the deck view + add-card picker always show a game's standard buckets).
function getDeckSectionNames(deck) {
    if (!deck || typeof deck !== 'object') return [];

    // Legacy games: their fixed buckets, in shape order.
    if (LEGACY_DECK_SHAPES[deck.game]) {
        return LEGACY_DECK_SHAPES[deck.game].map(([, label]) => label);
    }

    // Generic decks: registry category order first, then any extra present keys.
    const reg = (GAME_REGISTRY[deck.game] && GAME_REGISTRY[deck.game].deck
        && GAME_REGISTRY[deck.game].deck.categories) || [];
    const present = (deck.categories && typeof deck.categories === 'object')
        ? Object.keys(deck.categories) : [];
    const out = reg.slice();
    present.forEach(n => { if (!out.includes(n)) out.push(n); });
    return out.length ? out : present;
}

// Lowercased set of every card name in a deck (for deck-only search filtering).
function getDeckCardNameSet(deck) {
    const names = new Set();
    Object.values(getDeckCategories(deck)).forEach(cards => {
        cards.forEach(card => { if (card && card.name) names.add(card.name.toLowerCase()); });
    });
    return names;
}

// Expose as globals for the classic (no-build) scripts.
if (typeof window !== 'undefined') {
    window.GAME_REGISTRY = GAME_REGISTRY;
    window.getGameConfig = getGameConfig;
    window.getDeckCategories = getDeckCategories;
    window.getDeckCategoryArray = getDeckCategoryArray;
    window.getDeckSectionNames = getDeckSectionNames;
    window.deckCardCount = deckCardCount;
    window.deckToText = deckToText;
    window.getDeckCardNameSet = getDeckCardNameSet;
    window.gundamCategoryFromType = gundamCategoryFromType;
    window.yugiohCategoryFromType = yugiohCategoryFromType;
    window.onePieceCategoryFromType = onePieceCategoryFromType;
    window.onePieceColors = onePieceColors;
}

// Allow Node (tests/tooling) to require the registry + deck helpers.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GAME_REGISTRY, getGameConfig,
        getDeckCategories, getDeckCategoryArray, getDeckSectionNames,
        deckCardCount, deckToText, getDeckCardNameSet, gundamCategoryFromType,
        yugiohCategoryFromType, onePieceCategoryFromType, onePieceColors
    };
}
