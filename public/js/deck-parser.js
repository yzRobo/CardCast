/**
 * CardCast Deck Parser
 * Handles deck list parsing for multiple TCGs
 * Supports: Pokemon TCG, Magic: The Gathering, Gundam Card Game, Yu-Gi-Oh!,
 * One Piece Card Game
 */

/**
 * Main entry point - detects game type and parses accordingly.
 * Async because Gundam resolves card numbers against the local DB.
 * @param {string} text - Raw deck list text
 * @returns {Promise<Object>} Parsed deck object with game-specific structure
 */
async function parseDeckList(text) {
    const lines = text.split('\n');

    // Detect game type by looking at patterns
    const gameType = detectGameType(text);
    console.log('Detected game type:', gameType);
    console.log('First 3 lines:', lines.slice(0, 3));

    if (gameType === 'magic') {
        const result = parseMTGDeckList(lines);
        console.log('MTG Parse result:', result);
        console.log('Total cards:', result.cards.length, 'Sideboard:', result.sideboard.length);
        return result;
    } else if (gameType === 'gundam') {
        const result = await parseGundamDeckList(lines);
        const cats = result.categories || {};
        console.log('Gundam Parse result:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));
        return result;
    } else if (gameType === 'yugioh') {
        const result = await parseYugiohDeckList(lines);
        const cats = result.categories || {};
        console.log('Yugioh Parse result:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));
        return result;
    } else if (gameType === 'onepiece') {
        const result = await parseOnePieceDeckList(lines);
        const cats = result.categories || {};
        console.log('One Piece Parse result:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));
        return result;
    } else if (gameType === 'lorcana') {
        const result = await parseLorcanaDeckList(lines);
        const cats = result.categories || {};
        console.log('Lorcana Parse result:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));
        return result;
    } else if (gameType === 'digimon') {
        const result = await parseDigimonDeckList(lines);
        const cats = result.categories || {};
        console.log('Digimon Parse result:', Object.keys(cats).map(k => `${k}:${cats[k].length}`).join(', '));
        return result;
    } else {
        return parsePokemonDeckList(lines);
    }
}

/**
 * Detect which game a deck list is for
 * @param {string} text - Raw deck list text
 * @returns {string} 'magic' or 'pokemon'
 */
function detectGameType(text) {
    // One Piece: card-number tokens. OP / PRB prefixes are unique to One Piece;
    // ST / EB / EX are SHARED with Gundam, so One Piece is checked first on its
    // unambiguous OP/PRB token. A real OP export always carries the OP-prefixed
    // Leader, so this routes correctly; a pure Gundam deck has no OP/PRB token and
    // falls through to the Gundam branch below.
    if (/\b(?:OP|PRB)\d{2}-\d{3}/i.test(text)) {
        return 'onepiece';
    }

    // Digimon: the BT (Booster) prefix is unique to Digimon - no other game uses it
    // (Gundam/One Piece use GD/OP/PRB; ST/EB/EX are SHARED). A real Digimon deck is
    // dominated by BTxx-NNN cards, so detecting on the BT token routes correctly and
    // is checked before Gundam (whose ST/EX checks would otherwise swallow a Digimon
    // deck's shared-prefix cards). Digimon numbers run 1-2 digits before the dash and
    // 2-3 after (BT7-112, BT19-096, ST3-06). KNOWN LIMIT: a pure starter deck with no
    // BT card (all ST/EX) can fall through to Gundam - same edge case as One Piece.
    if (/\bBT\d{1,2}-\d{2,3}\b/i.test(text)) {
        return 'digimon';
    }

    // Gundam: card-number tokens like GD01-001 / ST01-012 / EB01-003 / EX01-001,
    // or a "Resource Deck" section header (builder exports). Checked first because
    // the GDxx-NNN token is unambiguous.
    if (/\b(?:GD|ST|EB|EX)\d{2}-\d{3}/i.test(text) || /^\s*resource deck\s*$/mi.test(text)) {
        return 'gundam';
    }

    // Yu-Gi-Oh: YDK exports use #main / #extra / !side section markers (and a
    // "#created by" comment). Checked before Pokemon/MTG; these markers are unique
    // to YDK and never appear in the other games' exports.
    if (/^\s*#(main|extra|created)\b/mi.test(text) || /^\s*!side\b/mi.test(text)) {
        return 'yugioh';
    }

    // Strong Pokemon indicators - check first
    if (text.match(/Pokemon:\s*\d+/i) ||
        text.match(/Trainer:\s*\d+/i) ||
        text.match(/Energy:\s*\d+/i)) {
        return 'pokemon';
    }
    
    // MTG set code format: (ABC) 123 - this is unique to MTG
    if (text.match(/\([A-Z0-9]{3,5}\)\s+\d+/)) {
        return 'magic';
    }
    
    // MTG Arena "Deck" header (from Arena export or Moxfield Arena format)
    if (text.match(/^Deck\s*$/m)) {
        return 'magic';
    }
    
    // MTG Sideboard indicator
    if (text.match(/^Sideboard\s*$/mi)) {
        return 'magic';
    }

    // Disney Lorcana: exports are "quantity name" lines, and Lorcana card names
    // carry a " - " version subtitle (e.g. "4 Elsa - Snow Queen"). Two or more
    // such lines is a strong Lorcana signal the other games' exports never
    // produce. Checked after the explicit Pokemon/MTG markers above (so a tagged
    // MTG/Pokemon export still wins) and before the generic Pokemon fallback.
    const lorcanaVersionLines = (text.match(/^\s*\d+\s*x?\s+.+\s+-\s+.+$/gmi) || []).length;
    if (lorcanaVersionLines >= 2) {
        return 'lorcana';
    }

    // Check for Pokemon-specific set code pattern (letters + numbers)
    // Pokemon uses codes like SV01, PAL, SCR, etc.
    if (text.match(/\d+\s+.+?\s+[A-Z]{2,4}[0-9]+\s+\d+/)) {
        return 'pokemon';
    }
    
    // Default to pokemon for backward compatibility
    return 'pokemon';
}

/**
 * Parse MTG deck lists (Arena, Moxfield, Archidekt formats)
 * @param {Array} lines - Array of deck list lines
 * @returns {Object} MTG deck structure with cards and sideboard
 */
function parseMTGDeckList(lines) {
    const deck = {
        cards: [],      // Mainboard cards
        sideboard: []   // Sideboard cards (for competitive formats)
    };
    
    let currentSection = 'cards'; // 'cards' or 'sideboard'
    
    for (let line of lines) {
        const trimmed = line.trim();
        
        // Skip empty lines, comments, and metadata lines
        if (!trimmed || 
            trimmed.startsWith('//') || 
            trimmed.startsWith('#') ||
            trimmed.toLowerCase().startsWith('about') ||
            trimmed.toLowerCase().startsWith('name ')) {
            continue;
        }
        
        // Section headers
        if (trimmed.toLowerCase() === 'deck' || 
            trimmed.toLowerCase() === 'mainboard' ||
            trimmed.toLowerCase() === 'main deck') {
            currentSection = 'cards';
            continue;
        }
        
        if (trimmed.toLowerCase() === 'sideboard' || 
            trimmed.toLowerCase() === 'side board') {
            currentSection = 'sideboard';
            continue;
        }
        
        // Commander/Companion special lines (skip them for now)
        if (trimmed.toLowerCase().startsWith('commander:') || 
            trimmed.toLowerCase().startsWith('companion:')) {
            continue;
        }
        
        let cardData = null;
        
        // MTG Arena/Moxfield format with set: "4 Lightning Bolt (JMP) 342" or "3 Quantum Riddler (PEOE) 72p"
        // Handle promo suffixes like 72p, 123s, etc.
        let arenaMatch = trimmed.match(/^(\d+)\s+(.+?)\s+\(([A-Z0-9]+)\)\s+(\d+[a-z]?)$/);
        if (arenaMatch) {
            const [_, quantity, name, setCode, number] = arenaMatch;
            cardData = {
                quantity: parseInt(quantity),
                name: name.trim(),
                setCode: setCode,
                number: number,
                fullName: `${name.trim()} (${setCode}) ${number}`
            };
        }
        
        // Moxfield/Arena simple format: "4 Lightning Bolt" or "4x Lightning Bolt"
        if (!cardData) {
            let moxfieldMatch = trimmed.match(/^(\d+)x?\s+(.+)$/);
            if (moxfieldMatch) {
                const [_, quantity, name] = moxfieldMatch;
                cardData = {
                    quantity: parseInt(quantity),
                    name: name.trim(),
                    setCode: '',
                    number: '',
                    fullName: name.trim()
                };
            }
        }
        
        // TCGPlayer format with set in brackets: "1 Sol Ring [Commander Legends]"
        if (!cardData) {
            let tcgMatch = trimmed.match(/^(\d+)x?\s+(.+?)\s+\[([^\]]+)\]$/);
            if (tcgMatch) {
                const [_, quantity, name, setName] = tcgMatch;
                cardData = {
                    quantity: parseInt(quantity),
                    name: name.trim(),
                    setCode: '', // We have set name but not code
                    setName: setName.trim(),
                    number: '',
                    fullName: `${name.trim()} [${setName.trim()}]`
                };
            }
        }
        
        // Store the card in the appropriate section
        if (cardData) {
            deck[currentSection].push(cardData);
        }
    }
    
    return deck;
}

/**
 * Parse Pokemon deck lists (PTCGL, Limitless formats)
 * @param {Array} lines - Array of deck list lines
 * @returns {Object} Pokemon deck structure with pokemon, trainers, energy
 */
function parsePokemonDeckList(lines) {
    const deck = {
        pokemon: [],
        trainers: [],
        energy: []
    };
    
    let currentSection = null;
    
    for (let line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Section headers
        if (trimmed.match(/^Pokemon:\s*\d*$/i)) {
            currentSection = 'pokemon';
            continue;
        } else if (trimmed.match(/^Trainer:\s*\d*$/i)) {
            currentSection = 'trainers';
            continue;
        } else if (trimmed.match(/^Energy:\s*\d*$/i)) {
            currentSection = 'energy';
            continue;
        }
        
        // Auto-detect section if not set
        if (!currentSection) {
            if (trimmed.toLowerCase().includes('energy')) {
                currentSection = 'energy';
            } else if (isTrainerCard(trimmed)) {
                currentSection = 'trainers';
            } else if (trimmed.match(/\d+\s+.+\s+[A-Z]{2,4}\s+\d+/)) {
                currentSection = 'pokemon';
            }
        }
        
        if (!currentSection) continue;
        
        // Parse card lines
        let cardData = null;
        
        // Special handling for PTCGL energy format: "3 Basic {D} Energy SVE 15"
        if (trimmed.includes('{') && trimmed.includes('Energy')) {
            const energyMatch = trimmed.match(/^(\d+)\s+Basic\s+\{([A-Z])\}\s+Energy\s+([A-Z]{2,4})\s+(\d+)$/);
            if (energyMatch) {
                const [_, quantity, type, setCode, number] = energyMatch;
                
                // Convert type letter to full name
                const types = {
                    'P': 'Psychic',
                    'D': 'Darkness', 
                    'F': 'Fighting',
                    'R': 'Fire',
                    'W': 'Water',
                    'L': 'Lightning',
                    'G': 'Grass',
                    'M': 'Metal',
                    'C': 'Colorless',
                    'N': 'Dragon',
                    'Y': 'Fairy'
                };
                
                const energyName = `${types[type] || type} Energy`;
                
                cardData = {
                    quantity: parseInt(quantity),
                    name: energyName,
                    setCode: setCode.toUpperCase(),
                    number: number,
                    fullName: `${energyName} ${setCode} ${number}`
                };
                
                currentSection = 'energy'; // Force to energy section
            }
        }
        
        // If not matched as PTCGL energy, try standard patterns
        if (!cardData) {
            // Pattern 1: "4 Hoothoot SCR 114" - standard format with set and number
            let match = trimmed.match(/^(\d+)\s+(.+?)\s+([A-Z]{2,}[A-Z0-9]*)\s+(\d+)$/);
            if (match) {
                const [_, quantity, name, setCode, number] = match;
                const cleanName = name.replace(/\{.\}/g, '').replace(/Basic\s+Energy/g, 'Energy').trim();
                
                cardData = {
                    quantity: parseInt(quantity),
                    name: cleanName,
                    setCode: setCode,
                    number: number,
                    fullName: `${cleanName} ${setCode} ${number}`
                };
            }
        }
        
        // Pattern 2: "4 Professor's Research" - just name and quantity
        if (!cardData) {
            let simpleMatch = trimmed.match(/^(\d+)x?\s+(.+)$/);
            if (simpleMatch) {
                const [_, quantity, name] = simpleMatch;
                cardData = {
                    quantity: parseInt(quantity),
                    name: name.trim(),
                    setCode: '',
                    number: '',
                    fullName: name.trim()
                };
            }
        }
        
        if (cardData) {
            if (currentSection === 'pokemon') {
                deck.pokemon.push(cardData);
            } else if (currentSection === 'trainers') {
                deck.trainers.push(cardData);
            } else if (currentSection === 'energy') {
                deck.energy.push(cardData);
            }
        }
    }
    
    return deck;
}

/**
 * Helper function to detect if a card is a Trainer card
 * @param {string} cardLine - Single line from deck list
 * @returns {boolean} True if likely a trainer card
 */
function isTrainerCard(cardLine) {
    const trainerKeywords = [
        'Professor', 'Boss', 'Iono', 'Arven', 'Nest Ball', 'Ultra Ball',
        'Rare Candy', 'Switch', 'Town Store', 'Technical Machine',
        'Pokégear', 'Poké Ball', 'Super Rod', 'Counter Catcher'
    ];
    
    return trainerKeywords.some(keyword =>
        cardLine.toLowerCase().includes(keyword.toLowerCase())
    );
}

/**
 * Gundam card_type -> deck category. Prefers the shared registry function
 * (single source of truth); inlined fallback keeps the parser self-contained.
 */
function gundamCategory(cardType) {
    if (typeof window !== 'undefined' && typeof window.gundamCategoryFromType === 'function') {
        return window.gundamCategoryFromType(cardType);
    }
    const t = (cardType || '').toUpperCase().trim();
    if (t.includes('PILOT')) return 'Pilots';
    if (t.includes('COMMAND')) return 'Commands';
    if (t.includes('RESOURCE')) return 'Resources';
    if (t.includes('BASE')) return 'Bases';
    return 'Units';
}

/**
 * Resolve a Gundam deck-list token to a DB card via the local search endpoint.
 * No new external calls - uses /api/search/gundam (search_text includes the
 * card_number, so a number lookup like "GD01-001" resolves exactly).
 * @param {{number?: string, name?: string}} token
 * @returns {Promise<Object|null>} the matched card row, or null
 */
async function resolveGundamCard(token) {
    const q = token.number || token.name;
    if (!q) return null;
    try {
        const res = await fetch(`/api/search/gundam?q=${encodeURIComponent(q)}`);
        if (!res.ok) return null;
        const results = await res.json();
        if (!Array.isArray(results) || results.length === 0) return null;

        if (token.number) {
            const want = token.number.toUpperCase();
            const exact = results.find(c => (c.card_number || '').toUpperCase() === want);
            if (exact) return exact;
        }
        if (token.name) {
            const want = token.name.toLowerCase();
            const exact = results.find(c => (c.name || '').toLowerCase() === want);
            if (exact) return exact;
        }
        return results[0];
    } catch (e) {
        console.error('Gundam resolve error for', q, e);
        return null;
    }
}

/**
 * Parse a Gundam deck list (ExBurst / EGMAN / official builder exports).
 * Card-number-keyed and tolerant: each non-header line is matched for a leading
 * quantity and a GDxx-NNN style number token, resolved against the DB, and
 * bucketed by its card_type. Lines with no number fall back to a name lookup.
 * @param {Array<string>} lines
 * @returns {Promise<Object>} { categories: { Units, Pilots, Commands, Bases, Resources } }
 */
async function parseGundamDeckList(lines) {
    const deck = { categories: { Units: [], Pilots: [], Commands: [], Bases: [], Resources: [] } };

    const QTY = /^(\d+)\s*x?\s+/i;
    const NUM = /([A-Z]{2,4}\d{2}-\d{3}[A-Za-z0-9_]*)/;
    const HEADER = /^(resource deck|main deck|deck|sideboard|total cards|total|cards)\b/i;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('//') || line.startsWith('#')) continue;
        if (HEADER.test(line)) continue;

        const qtyM = line.match(QTY);
        const quantity = qtyM ? parseInt(qtyM[1], 10) : 1;

        const numM = line.match(NUM);
        let resolved = null;
        if (numM) {
            resolved = await resolveGundamCard({ number: numM[1] });
        }
        if (!resolved) {
            const name = line.replace(QTY, '').replace(NUM, '').replace(/\s+/g, ' ').trim();
            if (name) resolved = await resolveGundamCard({ name });
        }
        if (!resolved) continue;

        const category = gundamCategory(resolved.card_type);
        if (!deck.categories[category]) deck.categories[category] = [];
        const bucket = deck.categories[category];

        const number = resolved.card_number || (numM ? numM[1] : '');
        const existing = bucket.find(c => (number && c.number === number) || c.name === resolved.name);
        if (existing) {
            existing.quantity += quantity;
        } else {
            bucket.push({
                quantity,
                name: resolved.name,
                setCode: resolved.set_abbreviation || resolved.set_code || '',
                number,
                cardType: resolved.card_type || '',
                fullName: `${quantity} ${resolved.name} ${number}`.trim()
            });
        }
    }

    return deck;
}

/**
 * Yu-Gi-Oh! card_type -> deck category. Prefers the shared registry function
 * (single source of truth); inlined fallback keeps the parser self-contained.
 */
function yugiohCategory(cardType) {
    if (typeof window !== 'undefined' && typeof window.yugiohCategoryFromType === 'function') {
        return window.yugiohCategoryFromType(cardType);
    }
    const t = (cardType || '').toLowerCase().trim();
    if (t.includes('spell')) return 'Spells';
    if (t.includes('trap')) return 'Traps';
    if (t.includes('fusion') || t.includes('synchro') || t.includes('xyz') || t.includes('link')) return 'Extra';
    return 'Monsters';
}

/**
 * Resolve a Yu-Gi-Oh! deck-list token to a DB card. A YDK passcode is the card's
 * product_id, so it resolves directly via /api/card/yugioh/yugioh_<passcode>
 * (search_text does NOT contain the passcode). Names fall back to /api/search.
 * @param {{passcode?: string, name?: string}} token
 * @returns {Promise<Object|null>} the matched card row, or null
 */
async function resolveYugiohCard(token) {
    if (token.passcode) {
        try {
            const res = await fetch(`/api/card/yugioh/yugioh_${token.passcode}`);
            if (res.ok) return await res.json();
        } catch (e) {
            console.error('Yugioh passcode resolve error for', token.passcode, e);
        }
        return null;
    }
    if (token.name) {
        try {
            const res = await fetch(`/api/search/yugioh?q=${encodeURIComponent(token.name)}`);
            if (!res.ok) return null;
            const results = await res.json();
            if (!Array.isArray(results) || results.length === 0) return null;
            const want = token.name.toLowerCase();
            return results.find(c => (c.name || '').toLowerCase() === want) || results[0];
        } catch (e) {
            console.error('Yugioh name resolve error for', token.name, e);
            return null;
        }
    }
    return null;
}

/**
 * Parse a Yu-Gi-Oh! deck list. Honors YDK section markers (#main / #extra /
 * !side) and a "#created by" comment. Each entry is resolved by passcode (a bare
 * 8-digit product_id, one line per copy in YDK) or by name (text exports like
 * "3 Dark Magician"). Bucketing: !side -> Side, #extra -> Extra, #main / no
 * marker -> by card_type (Fusion/Synchro/XYZ/Link route to Extra automatically).
 * @param {Array<string>} lines
 * @returns {Promise<Object>} { game:'yugioh', categories: { Monsters, Spells, Traps, Extra, Side } }
 */
async function parseYugiohDeckList(lines) {
    const deck = { game: 'yugioh', categories: { Monsters: [], Spells: [], Traps: [], Extra: [], Side: [] } };

    const QTY = /^(\d+)\s*x?\s+/i;
    const PASSCODE = /^\d{4,9}$/;

    let section = 'main'; // main | extra | side

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // Section markers (YDK). "#created by" is a comment - skip without resetting.
        const lower = line.toLowerCase();
        if (/^#main\b/.test(lower)) { section = 'main'; continue; }
        if (/^#extra\b/.test(lower)) { section = 'extra'; continue; }
        if (/^!side\b/.test(lower)) { section = 'side'; continue; }
        if (line.startsWith('#') || line.startsWith('//')) continue; // comments (e.g. #created by)

        // Quantity prefix is optional (YDK repeats a passcode per copy; text uses "3 Name").
        const qtyM = line.match(QTY);
        const quantity = qtyM ? parseInt(qtyM[1], 10) : 1;
        const rest = qtyM ? line.slice(qtyM[0].length).trim() : line;
        if (!rest) continue;

        const token = PASSCODE.test(rest) ? { passcode: rest } : { name: rest };
        const resolved = await resolveYugiohCard(token);
        if (!resolved) continue;

        // Marker wins; otherwise derive from card_type (auto-routes Extra-Deck types).
        let category;
        if (section === 'side') category = 'Side';
        else if (section === 'extra') category = 'Extra';
        else category = yugiohCategory(resolved.card_type);

        if (!deck.categories[category]) deck.categories[category] = [];
        const bucket = deck.categories[category];

        const number = resolved.card_number || '';
        const existing = bucket.find(c => c.name === resolved.name);
        if (existing) {
            existing.quantity += quantity;
        } else {
            bucket.push({
                quantity,
                name: resolved.name,
                setCode: resolved.set_abbreviation || resolved.set_code || '',
                number,
                cardType: resolved.card_type || '',
                fullName: `${quantity} ${resolved.name}`.trim()
            });
        }
    }

    return deck;
}

/**
 * One Piece card_type -> deck category. Prefers the shared registry function
 * (single source of truth); inlined fallback keeps the parser self-contained.
 */
function onePieceCategory(cardType) {
    if (typeof window !== 'undefined' && typeof window.onePieceCategoryFromType === 'function') {
        return window.onePieceCategoryFromType(cardType);
    }
    const t = (cardType || '').toLowerCase().trim();
    if (t.includes('leader')) return 'Leader';
    if (t.includes('event')) return 'Events';
    if (t.includes('stage')) return 'Stages';
    return 'Characters';
}

/**
 * Resolve a One Piece deck-list token to a DB card via the local search endpoint
 * (no new external calls). search_text includes the card_number, so a number
 * lookup like "OP01-001" resolves exactly; names fall back to a name match.
 * @param {{number?: string, name?: string}} token
 * @returns {Promise<Object|null>} the matched card row, or null
 */
async function resolveOnePieceCard(token) {
    const q = token.number || token.name;
    if (!q) return null;
    try {
        const res = await fetch(`/api/search/onepiece?q=${encodeURIComponent(q)}`);
        if (!res.ok) return null;
        const results = await res.json();
        if (!Array.isArray(results) || results.length === 0) return null;

        if (token.number) {
            const want = token.number.toUpperCase();
            const exact = results.find(c => (c.card_number || '').toUpperCase() === want);
            if (exact) return exact;
        }
        if (token.name) {
            const want = token.name.toLowerCase();
            const exact = results.find(c => (c.name || '').toLowerCase() === want);
            if (exact) return exact;
        }
        return results[0];
    } catch (e) {
        console.error('One Piece resolve error for', q, e);
        return null;
    }
}

/**
 * Parse a One Piece deck list (ExBurst / EGMAN / onepiece.gg / official sim
 * exports). Card-number-keyed and tolerant: each non-header line is matched for a
 * leading quantity and an OP/ST/EB/EX/PRB-style number token, resolved against the
 * DB, and bucketed by its card_type. The single Leader becomes deck.leader (it
 * sets the deck colors + starting Life). Lines with no number fall back to a name
 * lookup. The uniform 10-card DON!! deck is not represented in the categories.
 * @param {Array<string>} lines
 * @returns {Promise<Object>} { game:'onepiece', leader, categories: { Leader, Characters, Events, Stages } }
 */
async function parseOnePieceDeckList(lines) {
    const deck = { game: 'onepiece', leader: null, categories: { Leader: [], Characters: [], Events: [], Stages: [] } };

    const QTY = /^(\d+)\s*x?\s+/i;
    const NUM = /([A-Z]{2,4}\d{2}-\d{3}[A-Za-z0-9_]*)/;
    const HEADER = /^(leader|character|characters|event|events|stage|stages|don|don deck|main deck|deck|total cards|total|cards)\s*:?\s*\d*\s*$/i;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('//') || line.startsWith('#')) continue;
        if (HEADER.test(line)) continue;

        const qtyM = line.match(QTY);
        const quantity = qtyM ? parseInt(qtyM[1], 10) : 1;

        const numM = line.match(NUM);

        // The uniform 10-card DON!! deck is not part of the main-deck categories.
        // Real cards always carry an OP/ST/EB-style number; a numberless "DON!!"
        // line (e.g. "10 DON!! card" or "DON!! x10") is the DON deck - skip it so a
        // loose name match can't smuggle it into Characters.
        if (!numM && /\bdon!!/i.test(line)) continue;

        let resolved = null;
        if (numM) {
            resolved = await resolveOnePieceCard({ number: numM[1] });
        }
        if (!resolved) {
            const name = line.replace(QTY, '').replace(NUM, '').replace(/\s+/g, ' ').trim();
            if (name) resolved = await resolveOnePieceCard({ name });
        }
        if (!resolved) continue;

        const category = onePieceCategory(resolved.card_type);
        if (!deck.categories[category]) deck.categories[category] = [];
        const bucket = deck.categories[category];

        const number = resolved.card_number || (numM ? numM[1] : '');
        const image = resolved.display_image || resolved.image_url || resolved.local_image || '';
        const entry = {
            quantity,
            name: resolved.name,
            setCode: resolved.set_abbreviation || resolved.set_code || '',
            number,
            cardType: resolved.card_type || '',
            colors: resolved.colors || '',
            image,
            fullName: `${quantity} ${resolved.name} ${number}`.trim()
        };

        const existing = bucket.find(c => (number && c.number === number) || c.name === resolved.name);
        if (existing) {
            existing.quantity += quantity;
        } else {
            bucket.push(entry);
        }

        // First Leader seen headlines the deck (sets colors + starting Life).
        if (category === 'Leader' && !deck.leader) {
            deck.leader = {
                id: resolved.id,
                name: resolved.name,
                number,
                image,
                power: resolved.op_power != null ? resolved.op_power : null,
                life: resolved.life != null ? resolved.life : 4,
                colors: resolved.colors || ''
            };
        }
    }

    return deck;
}

/**
 * Lorcana card_type -> deck category. Prefers the shared registry function
 * (single source of truth); inlined fallback keeps the parser self-contained.
 */
function lorcanaCategory(cardType) {
    if (typeof window !== 'undefined' && typeof window.lorcanaCategoryFromType === 'function') {
        return window.lorcanaCategoryFromType(cardType);
    }
    const t = (cardType || '').toLowerCase().trim();
    if (t.includes('location')) return 'Locations';
    if (t.includes('item')) return 'Items';
    if (t.includes('action') || t.includes('song')) return 'Actions';
    return 'Characters';
}

/**
 * Resolve a Lorcana deck-list token to a DB card via the local search endpoint
 * (no new external calls). Lorcana exports are name-keyed (no universal card-number
 * token), so this resolves by exact name (case-insensitive) and falls back to the
 * first result. A number is accepted but rarely present.
 * @param {{name?: string, number?: string}} token
 * @returns {Promise<Object|null>} the matched card row, or null
 */
async function resolveLorcanaCard(token) {
    const q = token.number || token.name;
    if (!q || q.length < 2) return null;
    try {
        const res = await fetch(`/api/search/lorcana?q=${encodeURIComponent(q)}`);
        if (!res.ok) return null;
        const results = await res.json();
        if (!Array.isArray(results) || results.length === 0) return null;

        if (token.number) {
            const want = token.number.toUpperCase();
            const exact = results.find(c => (c.card_number || '').toUpperCase() === want);
            if (exact) return exact;
        }
        if (token.name) {
            const want = token.name.toLowerCase();
            const exact = results.find(c => (c.name || '').toLowerCase() === want);
            if (exact) return exact;
        }
        return results[0];
    } catch (e) {
        console.error('Lorcana resolve error for', q, e);
        return null;
    }
}

/**
 * Parse a Disney Lorcana deck list (Dreamborn / Pixelborn / inkdecks /
 * Ravensburger app exports). These are "quantity name" lines, where Lorcana card
 * names usually carry a " - " version subtitle. Strategy: strip the leading
 * quantity, resolve the remaining name against the DB; if that misses, strip a
 * trailing set/number token (Dreamborn sometimes appends one) and retry. Cards are
 * bucketed by card_type into Characters / Actions / Items / Locations.
 * @param {Array<string>} lines
 * @returns {Promise<Object>} { game:'lorcana', categories: { Characters, Actions, Items, Locations } }
 */
async function parseLorcanaDeckList(lines) {
    const deck = { game: 'lorcana', categories: { Characters: [], Actions: [], Items: [], Locations: [] } };

    const QTY = /^(\d+)\s*x?\s+/i;
    // Section headers some exports emit (grouped by type or ink). Skipped.
    const HEADER = /^(deck|mainboard|main deck|sideboard|characters?|actions?|songs?|items?|locations?|total cards?|total|cards|ink(?:able)?|amber|amethyst|emerald|ruby|sapphire|steel)\s*:?\s*\d*\s*$/i;
    // Trailing set/number tokens to strip on a failed name lookup. "(TFC) 42" or "TFC 42".
    const TRAIL_PARENS = /\s*\([A-Z0-9]{1,4}\)\s*\d+[a-z]?$/i;
    const TRAIL_PLAIN = /\s+[A-Z0-9]{1,4}\s+\d+[a-z]?$/i;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('//') || line.startsWith('#')) continue;
        if (HEADER.test(line)) continue;

        const qtyM = line.match(QTY);
        const quantity = qtyM ? parseInt(qtyM[1], 10) : 1;
        const name = (qtyM ? line.slice(qtyM[0].length) : line).trim();
        if (!name) continue;

        let resolved = await resolveLorcanaCard({ name });
        if (!resolved) {
            // Strip a trailing set/number token and retry by name.
            let stripped = name.replace(TRAIL_PARENS, '').trim();
            if (stripped === name) stripped = name.replace(TRAIL_PLAIN, '').trim();
            if (stripped && stripped !== name) resolved = await resolveLorcanaCard({ name: stripped });
        }
        if (!resolved) continue;

        const category = lorcanaCategory(resolved.card_type);
        if (!deck.categories[category]) deck.categories[category] = [];
        const bucket = deck.categories[category];

        const number = resolved.card_number || '';
        const image = resolved.display_image || resolved.image_url || resolved.local_image || '';
        const existing = bucket.find(c => c.name === resolved.name);
        if (existing) {
            existing.quantity += quantity;
        } else {
            bucket.push({
                quantity,
                name: resolved.name,
                setCode: resolved.set_abbreviation || resolved.set_code || '',
                number,
                cardType: resolved.card_type || '',
                colors: resolved.colors || '',
                image,
                fullName: `${quantity} ${resolved.name}`.trim()
            });
        }
    }

    return deck;
}

/**
 * Digimon card_type -> deck category. Prefers the shared registry function
 * (single source of truth); inlined fallback keeps the parser self-contained.
 */
function digimonCategory(cardType) {
    if (typeof window !== 'undefined' && typeof window.digimonCategoryFromType === 'function') {
        return window.digimonCategoryFromType(cardType);
    }
    const t = (cardType || '').toLowerCase().trim();
    if (t.includes('egg')) return 'Digi-Egg';
    if (t.includes('tamer')) return 'Tamers';
    if (t.includes('option')) return 'Options';
    return 'Digimon';
}

/**
 * Resolve a Digimon deck-list token to a DB card via the local search endpoint
 * (no new external calls). search_text includes the card_number, so a number
 * lookup like "BT7-112" resolves exactly; names fall back to a name match.
 * @param {{number?: string, name?: string}} token
 * @returns {Promise<Object|null>} the matched card row, or null
 */
async function resolveDigimonCard(token) {
    const q = token.number || token.name;
    if (!q) return null;
    try {
        const res = await fetch(`/api/search/digimon?q=${encodeURIComponent(q)}`);
        if (!res.ok) return null;
        const results = await res.json();
        if (!Array.isArray(results) || results.length === 0) return null;

        if (token.number) {
            const want = token.number.toUpperCase();
            const exact = results.find(c => (c.card_number || '').toUpperCase() === want);
            if (exact) return exact;
        }
        if (token.name) {
            const want = token.name.toLowerCase();
            const exact = results.find(c => (c.name || '').toLowerCase() === want);
            if (exact) return exact;
        }
        return results[0];
    } catch (e) {
        console.error('Digimon resolve error for', q, e);
        return null;
    }
}

/**
 * Parse a Digimon deck list (digimoncard.io / digimonmeta / untap / official sim
 * exports). Card-number-keyed and tolerant: each non-header line is matched for a
 * leading quantity and a Digimon-style number token (BT/EX/ST/P/LM/AD/RB; 1-2 digits
 * before the dash and 2-3 after, e.g. BT7-112 / ST3-06 / P-050), resolved against the
 * DB, and bucketed by its card_type. Digi-Egg cards route to the separate egg deck;
 * the main deck is Digimon + Tamers + Options. Lines with no number fall back to a
 * name lookup.
 * @param {Array<string>} lines
 * @returns {Promise<Object>} { game:'digimon', categories: { Digimon, Tamers, Options, 'Digi-Egg' } }
 */
async function parseDigimonDeckList(lines) {
    const deck = { game: 'digimon', categories: { Digimon: [], Tamers: [], Options: [], 'Digi-Egg': [] } };

    const QTY = /^(\d+)\s*x?\s+/i;
    // Digimon numbers: optional 1-2 digit set index before the dash, 2-3 digit number
    // after (BT7-112, BT19-096, EX3-062, ST3-06, P-050, LM-064, AD1-..., RB1-...).
    const NUM = /\b([A-Z]{1,3}\d{0,2}-\d{2,3}[A-Za-z]?)\b/;
    const HEADER = /^(digimon|tamers?|options?|digi-?egg(?:\s*deck)?|egg deck|main deck|deck|total cards|total|cards)\s*:?\s*\d*\s*$/i;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('//') || line.startsWith('#')) continue;
        if (HEADER.test(line)) continue;

        const qtyM = line.match(QTY);
        const quantity = qtyM ? parseInt(qtyM[1], 10) : 1;

        const numM = line.match(NUM);
        let resolved = null;
        if (numM) {
            resolved = await resolveDigimonCard({ number: numM[1] });
        }
        if (!resolved) {
            const name = line.replace(QTY, '').replace(NUM, '').replace(/\s+/g, ' ').trim();
            if (name) resolved = await resolveDigimonCard({ name });
        }
        if (!resolved) continue;

        const category = digimonCategory(resolved.card_type);
        if (!deck.categories[category]) deck.categories[category] = [];
        const bucket = deck.categories[category];

        const number = resolved.card_number || (numM ? numM[1] : '');
        const image = resolved.display_image || resolved.image_url || resolved.local_image || '';
        const existing = bucket.find(c => (number && c.number === number) || c.name === resolved.name);
        if (existing) {
            existing.quantity += quantity;
        } else {
            bucket.push({
                quantity,
                name: resolved.name,
                setCode: resolved.set_abbreviation || resolved.set_code || '',
                number,
                cardType: resolved.card_type || '',
                colors: resolved.colors || '',
                image,
                fullName: `${quantity} ${resolved.name} ${number}`.trim()
            });
        }
    }

    return deck;
}

// Export functions for use in other files
if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment
    module.exports = {
        parseDeckList,
        detectGameType,
        parseMTGDeckList,
        parsePokemonDeckList,
        parseGundamDeckList,
        parseYugiohDeckList,
        parseOnePieceDeckList,
        parseLorcanaDeckList,
        parseDigimonDeckList
    };
}