/**
 * CardCast Deck Parser
 * Handles deck list parsing for multiple TCGs
 * Supports: Pokemon TCG, Magic: The Gathering
 */

/**
 * Main entry point - detects game type and parses accordingly
 * @param {string} text - Raw deck list text
 * @returns {Object} Parsed deck object with game-specific structure
 */
function parseDeckList(text) {
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

// Export functions for use in other files
if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment
    module.exports = {
        parseDeckList,
        detectGameType,
        parseMTGDeckList,
        parsePokemonDeckList
    };
}